import json

from tests.conftest import TestContext, login
from tests.test_lyrics import _create_ready_job

ORIGINAL_LRC = b"[00:00.20] <00:00.20>Hello <00:00.70>world\n"


async def _ready_lyrics(ctx: TestContext) -> tuple[str, str]:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    job = await _create_ready_job(ctx)
    created = await ctx.client.post(f"/api/jobs/{job['id']}/lyrics", json={})
    assert created.status_code == 201, created.text
    lid = created.json()["id"]
    remote = ctx.demucster.lyrics_jobs[f"lyrics-{ctx.demucster.lyrics_counter}"]
    remote.status = "COMPLETED"
    remote.progress = 100.0
    remote.summary = {
        "language": "en",
        "line_count": 1,
        "word_count": 2,
        "duration_seconds": 1.5,
        "llm_refined": True,
        "llm_model": "qwen3:27b",
        "aligned_with_reference": False,
    }
    await ctx.app.state.lyrics_archiver.poll_once()
    ready = await ctx.client.get(f"/api/jobs/{job['id']}/lyrics/{lid}")
    assert ready.json()["status"] == "READY"
    return job["id"], lid


def _doc_url(job_id: str, lid: str) -> str:
    return f"/api/jobs/{job_id}/lyrics/{lid}/document"


def _file_url(job_id: str, lid: str, kind: str) -> str:
    return f"/api/jobs/{job_id}/lyrics/{lid}/files/{kind}"


EDIT_BODY = {
    "lines": [
        {
            "text": "Hello there",
            "words": [
                {"word": "Hello", "start": 0.25, "end": 0.6},
                {"word": "there", "start": 0.7, "end": 1.3},
            ],
        }
    ]
}


async def test_save_rewrites_all_files(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)

    saved = await ctx.client.put(_doc_url(job_id, lid), json=EDIT_BODY)
    assert saved.status_code == 200, saved.text
    data = saved.json()
    assert data["edited_at"] is not None
    assert data["summary"]["word_count"] == 2
    assert data["summary"]["llm_model"] == "qwen3:27b"

    doc = (await ctx.client.get(_file_url(job_id, lid, "json"))).json()
    assert doc["lines"][0]["text"] == "Hello there"
    assert doc["lines"][0]["start"] == 0.25
    assert doc["title"] == "Test"

    lrc = await ctx.client.get(_file_url(job_id, lid, "lrc"))
    assert "<00:00.25>Hello" in lrc.text
    # API middleware marks responses no-store, so edited files are never stale
    assert lrc.headers["cache-control"] == "no-store"
    srt = await ctx.client.get(_file_url(job_id, lid, "srt"))
    assert "Hello there" in srt.text
    ass = await ctx.client.get(_file_url(job_id, lid, "ass"))
    assert "\\kf" in ass.text

    sizes = {f["kind"]: f["size"] for f in data["files"]}
    assert sizes["lrc"] == len(lrc.content)


async def test_backup_created_once_and_revert(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)

    first = await ctx.client.put(_doc_url(job_id, lid), json=EDIT_BODY)
    assert first.status_code == 200
    second_body = json.loads(json.dumps(EDIT_BODY))
    second_body["lines"][0]["words"][1]["word"] = "again"
    second = await ctx.client.put(_doc_url(job_id, lid), json=second_body)
    assert second.status_code == 200

    reverted = await ctx.client.post(f"/api/jobs/{job_id}/lyrics/{lid}/revert")
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["edited_at"] is None

    doc = (await ctx.client.get(_file_url(job_id, lid, "json"))).json()
    assert doc["lines"][0]["text"] == "Hello world"
    lrc = await ctx.client.get(_file_url(job_id, lid, "lrc"))
    assert lrc.content == ORIGINAL_LRC

    backup = ctx.app.state.settings.jobs_dir / job_id / "lyrics" / lid / "original"
    assert not backup.exists()


async def test_revert_without_edits_conflicts(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)
    res = await ctx.client.post(f"/api/jobs/{job_id}/lyrics/{lid}/revert")
    assert res.status_code == 409


async def test_validation_errors(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)
    bad_bodies = [
        {"lines": [{"words": [{"word": "a", "start": 1.0, "end": 1.0}]}]},
        {
            "lines": [
                {
                    "words": [
                        {"word": "a", "start": 1.0, "end": 1.5},
                        {"word": "b", "start": 1.2, "end": 1.8},
                    ]
                }
            ]
        },
        {
            "lines": [
                {"words": [{"word": "a", "start": 2.0, "end": 2.5}]},
                {"words": [{"word": "b", "start": 1.0, "end": 1.5}]},
            ]
        },
    ]
    for body in bad_bodies:
        res = await ctx.client.put(_doc_url(job_id, lid), json=body)
        assert res.status_code == 422, res.text
        assert "Line" in res.json()["detail"]

    # Nothing was written or backed up on failure
    backup = ctx.app.state.settings.jobs_dir / job_id / "lyrics" / lid / "original"
    assert not backup.exists()


async def test_empty_text_line_dropped(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)
    body = {"lines": [EDIT_BODY["lines"][0], {"text": "  ", "words": []}]}
    res = await ctx.client.put(_doc_url(job_id, lid), json=body)
    assert res.status_code == 200, res.text
    assert res.json()["summary"]["line_count"] == 1
    doc = (await ctx.client.get(_file_url(job_id, lid, "json"))).json()
    assert len(doc["lines"]) == 1


async def test_edit_requires_ready(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    job = await _create_ready_job(ctx)
    created = await ctx.client.post(f"/api/jobs/{job['id']}/lyrics", json={})
    lid = created.json()["id"]
    res = await ctx.client.put(_doc_url(job["id"], lid), json=EDIT_BODY)
    assert res.status_code == 409


async def test_delete_after_edit_removes_directory(ctx: TestContext) -> None:
    job_id, lid = await _ready_lyrics(ctx)
    saved = await ctx.client.put(_doc_url(job_id, lid), json=EDIT_BODY)
    assert saved.status_code == 200
    directory = ctx.app.state.settings.jobs_dir / job_id / "lyrics" / lid
    assert (directory / "original" / "lyrics.json").is_file()

    res = await ctx.client.delete(f"/api/jobs/{job_id}/lyrics/{lid}")
    assert res.status_code == 204
    assert not directory.exists()
