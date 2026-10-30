from app.demucster import RemoteStem
from tests.conftest import TestContext, login


async def _create_ready_job(
    ctx: TestContext,
    *,
    stems: list[str] | None = None,
) -> dict:
    stem_names = stems if stems is not None else ["drums", "vocals"]
    upload = await ctx.client.post(
        "/api/jobs/upload",
        data={"model": "htdemucs", "output_format": "mp3", "mp3_bitrate": "320"},
        files={"file": ("groove.mp3", b"ID3-source", "audio/mpeg")},
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


async def test_transcription_lifecycle_archive_and_download(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    job = await _create_ready_job(ctx)

    created = await ctx.client.post(
        f"/api/jobs/{job['id']}/transcriptions",
        json={"time_signature": "4/4", "grid": "16th", "sensitivity": 0.6},
    )
    assert created.status_code == 201, created.text
    t_data = created.json()
    tid = t_data["id"]
    assert t_data["status"] == "QUEUED"
    assert t_data["options"]["grid"] == "16th"

    # A second concurrent active transcription on the same job is rejected
    dup = await ctx.client.post(f"/api/jobs/{job['id']}/transcriptions", json={})
    assert dup.status_code == 409

    # Simulate Drumster finishing the job and run TranscriptionArchiver
    remote_id = ctx.drumster.transcriptions[f"drumster-{ctx.drumster.counter}"].id
    remote = ctx.drumster.transcriptions[remote_id]
    remote.status = "COMPLETED"
    remote.progress = 100.0
    remote.artifacts = ["musicxml", "midi", "raw_midi", "analysis"]
    remote.summary = {
        "tempo_bpm": 120.0,
        "time_signature": "4/4",
        "measure_count": 4,
        "note_count": 32,
        "counts": {"kick": 8, "snare": 8, "hihat": 16},
        "duration_seconds": 8.0,
    }
    await ctx.app.state.transcription_archiver.poll_once()

    fetched = await ctx.client.get(f"/api/jobs/{job['id']}/transcriptions/{tid}")
    assert fetched.status_code == 200
    ready = fetched.json()
    assert ready["status"] == "READY"
    assert ready["summary"]["tempo_bpm"] == 120.0
    assert {f["kind"] for f in ready["files"]} == {
        "musicxml",
        "midi",
        "raw_midi",
        "analysis",
    }
    # Remote job is deleted from Drumster after archiving
    assert remote_id in ctx.drumster.deleted

    # Download each file kind
    for kind in ("musicxml", "midi", "raw_midi", "analysis"):
        dl = await ctx.client.get(
            f"/api/jobs/{job['id']}/transcriptions/{tid}/files/{kind}?download=true"
        )
        assert dl.status_code == 200
        assert len(dl.content) > 0

    # Delete transcription cleans up folder and DB row
    del_res = await ctx.client.delete(f"/api/jobs/{job['id']}/transcriptions/{tid}")
    assert del_res.status_code == 204
    listing = await ctx.client.get(f"/api/jobs/{job['id']}/transcriptions")
    assert listing.json()["items"] == []


async def test_transcription_validation_and_error_states(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")

    # Job not ready yet -> 409
    queued_upload = await ctx.client.post(
        "/api/jobs/upload",
        data={"model": "htdemucs", "output_format": "mp3", "mp3_bitrate": "320"},
        files={"file": ("pending.mp3", b"ID3-source", "audio/mpeg")},
    )
    queued_job = queued_upload.json()
    not_ready = await ctx.client.post(
        f"/api/jobs/{queued_job['id']}/transcriptions", json={}
    )
    assert not_ready.status_code == 409

    # Job ready but without a drums stem -> 404
    vocals_only = await _create_ready_job(ctx, stems=["vocals"])
    no_drums = await ctx.client.post(
        f"/api/jobs/{vocals_only['id']}/transcriptions", json={}
    )
    assert no_drums.status_code == 404

    # Remote failure -> FAILED
    job = await _create_ready_job(ctx)
    created = await ctx.client.post(f"/api/jobs/{job['id']}/transcriptions", json={})
    assert created.status_code == 201
    tid = created.json()["id"]
    remote = ctx.drumster.transcriptions[f"drumster-{ctx.drumster.counter}"]
    remote.status = "FAILED"
    remote.error = "Synthetic Drumster error"
    await ctx.app.state.transcription_archiver.poll_once()

    failed = await ctx.client.get(f"/api/jobs/{job['id']}/transcriptions/{tid}")
    assert failed.json()["status"] == "FAILED"
    assert "Synthetic Drumster error" in failed.json()["error_message"]

