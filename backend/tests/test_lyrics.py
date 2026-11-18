from app.demucster import RemoteStem
from tests.conftest import TestContext, login


async def _create_ready_job(
    ctx: TestContext,
    *,
    stems: list[str] | None = None,
) -> dict:
    stem_names = stems if stems is not None else ["vocals", "no_vocals"]
    upload = await ctx.client.post(
        "/api/jobs/upload",
        data={"model": "htdemucs", "output_format": "mp3", "mp3_bitrate": "320"},
        files={"file": ("karaoke.mp3", b"ID3-source", "audio/mpeg")},
    )
    assert upload.status_code == 201, upload.text
    job = upload.json()
    remote = ctx.demucster.jobs[job["remote_job_id"]]
    remote.status = "COMPLETED"
    remote.progress = 100.0
    remote.stems = [RemoteStem(name=s, filename=f"{s}.mp3") for s in stem_names]
    await ctx.app.state.archiver.poll_once()
    ready = await ctx.client.get(f"/api/jobs/{job['id']}")
    assert ready.status_code == 200
    assert ready.json()["status"] == "READY"
    return ready.json()


async def test_lyrics_lifecycle_archive_and_download(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    job = await _create_ready_job(ctx)

    created = await ctx.client.post(
        f"/api/jobs/{job['id']}/lyrics",
        json={
            "model": "large-v3-turbo",
            "language": "en",
            "reference_lyrics": "Hello world",
            "use_llm_cleanup": True,
        },
    )
    assert created.status_code == 201, created.text
    l_data = created.json()
    lid = l_data["id"]
    assert l_data["status"] == "QUEUED"
    assert l_data["stem_name"] == "vocals"
    assert l_data["options"]["language"] == "en"

    # Concurrent active lyrics extraction on the same job is rejected
    dup = await ctx.client.post(f"/api/jobs/{job['id']}/lyrics", json={})
    assert dup.status_code == 409

    # Simulate Demucster finishing the lyrics job and run LyricsArchiver
    remote_id = f"lyrics-{ctx.demucster.lyrics_counter}"
    remote = ctx.demucster.lyrics_jobs[remote_id]
    remote.status = "COMPLETED"
    remote.progress = 100.0
    remote.artifacts = ["json", "lrc", "ass", "srt"]
    remote.summary = {
        "language": "en",
        "line_count": 1,
        "word_count": 2,
        "duration_seconds": 1.5,
        "llm_refined": True,
        "llm_model": "qwen3:27b",
        "aligned_with_reference": True,
    }
    await ctx.app.state.lyrics_archiver.poll_once()

    fetched = await ctx.client.get(f"/api/jobs/{job['id']}/lyrics/{lid}")
    assert fetched.status_code == 200
    ready = fetched.json()
    assert ready["status"] == "READY"
    assert ready["edited_at"] is None
    assert ready["summary"]["word_count"] == 2
    assert ready["summary"]["llm_refined"] is True
    assert {f["kind"] for f in ready["files"]} == {"json", "lrc", "ass", "srt"}
    assert remote_id in ctx.demucster.lyrics_deleted

    for kind in ("json", "lrc", "ass", "srt"):
        dl = await ctx.client.get(
            f"/api/jobs/{job['id']}/lyrics/{lid}/files/{kind}?download=true"
        )
        assert dl.status_code == 200
        assert len(dl.content) > 0

    del_res = await ctx.client.delete(f"/api/jobs/{job['id']}/lyrics/{lid}")
    assert del_res.status_code == 204
    listing = await ctx.client.get(f"/api/jobs/{job['id']}/lyrics")
    assert listing.json()["items"] == []


async def test_lyrics_validation_and_error_states(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")

    # Job not ready yet -> 409
    queued_upload = await ctx.client.post(
        "/api/jobs/upload",
        data={"model": "htdemucs", "output_format": "mp3", "mp3_bitrate": "320"},
        files={"file": ("pending.mp3", b"ID3-source", "audio/mpeg")},
    )
    queued_job = queued_upload.json()
    not_ready = await ctx.client.post(
        f"/api/jobs/{queued_job['id']}/lyrics", json={}
    )
    assert not_ready.status_code == 409

    # Job ready without a vocals stem -> 404
    drums_only = await _create_ready_job(ctx, stems=["drums"])
    no_vocals = await ctx.client.post(
        f"/api/jobs/{drums_only['id']}/lyrics", json={}
    )
    assert no_vocals.status_code == 404

    # Remote failure -> FAILED
    job = await _create_ready_job(ctx)
    created = await ctx.client.post(f"/api/jobs/{job['id']}/lyrics", json={})
    assert created.status_code == 201
    lid = created.json()["id"]
    remote = ctx.demucster.lyrics_jobs[f"lyrics-{ctx.demucster.lyrics_counter}"]
    remote.status = "FAILED"
    remote.error = "Whisper decode failed"
    await ctx.app.state.lyrics_archiver.poll_once()

    failed = await ctx.client.get(f"/api/jobs/{job['id']}/lyrics/{lid}")
    assert failed.status_code == 200
    assert failed.json()["status"] == "FAILED"
    assert "Whisper decode failed" in (failed.json()["error_message"] or "")

