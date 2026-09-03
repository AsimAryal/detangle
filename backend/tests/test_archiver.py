import io
import uuid
import zipfile
from datetime import UTC, datetime, timedelta

from conftest import TestContext, login

from app.demucster import RemoteJob, RemoteStem
from app.models import Job


async def test_archiving_downloads_stems_and_retention_purges(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    submitted = await ctx.client.post(
        "/api/jobs/upload",
        data={
            "model": "htdemucs",
            "output_format": "mp3",
            "mp3_bitrate": "320",
        },
        files={"file": ("song.mp3", b"source-data", "audio/mpeg")},
    )
    assert submitted.status_code == 201, submitted.text
    payload = submitted.json()
    job_id = payload["id"]
    remote_id = payload["remote_job_id"]
    ctx.demucster.jobs[remote_id] = RemoteJob(
        id=remote_id,
        status="COMPLETED",
        progress=100,
        error=None,
        stems=[
            RemoteStem(name="vocals", filename="vocals.mp3"),
            RemoteStem(name="drums", filename="drums.mp3"),
        ],
    )

    await ctx.app.state.archiver.poll_once()
    detail = await ctx.client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    archived = detail.json()
    assert archived["status"] == "READY"
    assert archived["archive_attempts"] == 1
    assert len(archived["stems"]) == 2

    stem = archived["stems"][0]
    assert stem["size"] == len(ctx.demucster.stem_content)
    assert "size_bytes" not in stem
    download = await ctx.client.get(
        f"/api/jobs/{job_id}/stems/{stem['name']}?download=false"
    )
    assert download.status_code == 200
    assert download.content == ctx.demucster.stem_content
    assert download.headers["accept-ranges"] == "bytes"
    partial = await ctx.client.get(
            f"/api/jobs/{job_id}/stems/{stem['name']}",
        headers={"Range": "bytes=0-2"},
    )
    assert partial.status_code == 206
    assert partial.content == ctx.demucster.stem_content[:3]

    archive_response = await ctx.client.get(f"/api/jobs/{job_id}/stems.zip")
    assert archive_response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive_response.content)) as archive:
        assert set(archive.namelist()) == {"vocals.mp3", "drums.mp3"}
    assert not list((ctx.data_dir / ".tmp").glob("*.zip"))

    async with ctx.app.state.database.sessions() as session:
        job = await session.get(Job, uuid.UUID(job_id))
        job.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    assert await ctx.app.state.archiver.retention_once() == 1
    assert (await ctx.client.get(f"/api/jobs/{job_id}")).status_code == 404
    assert not (ctx.app.state.settings.jobs_dir / job_id).exists()
    assert remote_id in ctx.demucster.deleted


async def test_url_title_edit_and_optional_original_mix(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    submitted = await ctx.client.post(
        "/api/jobs/url",
        json={
            "url": "https://example.com/watch?v=track",
            "options": {
                "model": "htdemucs",
                "output_format": "mp3",
                "mp3_bitrate": 320,
                "stems": ["vocals"],
                "include_original": True,
            },
        },
    )
    assert submitted.status_code == 201, submitted.text
    payload = submitted.json()
    ctx.demucster.jobs[payload["remote_job_id"]] = RemoteJob(
        id=payload["remote_job_id"],
        status="COMPLETED",
        progress=100,
        error=None,
        stems=[RemoteStem(name="vocals", filename="vocals")],
        filename="A Great Song.wav",
    )

    await ctx.app.state.archiver.poll_once()
    detail = (await ctx.client.get(f"/api/jobs/{payload['id']}")).json()
    assert detail["title"] == "A Great Song"
    assert detail["include_original"] is True
    assert {stem["name"] for stem in detail["stems"]} == {"vocals", "original"}

    original = await ctx.client.get(
        f"/api/jobs/{payload['id']}/stems/original?download=true"
    )
    assert original.status_code == 200
    assert original.content == ctx.demucster.source_content

    renamed = await ctx.client.patch(
        f"/api/jobs/{payload['id']}",
        json={"title": "My custom title"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "My custom title"


async def test_archiving_stemless_tracks_and_metadata(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    submitted = await ctx.client.post(
        "/api/jobs/upload",
        data={
            "model": "htdemucs",
            "output_format": "mp3",
            "mp3_bitrate": "320",
            "stems": "drums,vocals,no_drums,no_vocals",
        },
        files={"file": ("song.mp3", b"source-data", "audio/mpeg")},
    )
    assert submitted.status_code == 201, submitted.text
    payload = submitted.json()
    job_id = payload["id"]
    remote_id = payload["remote_job_id"]
    assert ctx.demucster.submissions[-1] == {
        "stems": ["drums", "vocals"],
        "exclude_stems": ["drums", "vocals"],
    }

    ctx.demucster.jobs[remote_id] = RemoteJob(
        id=remote_id,
        status="COMPLETED",
        progress=100,
        error=None,
        stems=[
            RemoteStem(name="drums", filename="drums.mp3"),
            RemoteStem(name="vocals", filename="vocals.mp3"),
            RemoteStem(name="no_drums", filename="no_drums.mp3"),
            RemoteStem(name="no_vocals", filename="no_vocals.mp3"),
        ],
    )

    await ctx.app.state.archiver.poll_once()
    detail = await ctx.client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    archived = detail.json()
    assert archived["status"] == "READY"
    assert len(archived["stems"]) == 4

    stems_by_name = {stem["name"]: stem for stem in archived["stems"]}
    assert stems_by_name["drums"]["stem_type"] == "isolated"
    assert stems_by_name["drums"]["display_name"] == "Drums"

    assert stems_by_name["vocals"]["stem_type"] == "isolated"
    assert stems_by_name["vocals"]["display_name"] == "Vocals"

    assert stems_by_name["no_drums"]["stem_type"] == "stemless"
    assert stems_by_name["no_drums"]["display_name"] == "No Drums (Drumless)"

    assert stems_by_name["no_vocals"]["stem_type"] == "stemless"
    assert stems_by_name["no_vocals"]["display_name"] == "No Vocals (Karaoke)"

    # Test downloading an individual stemless track
    drumless_dl = await ctx.client.get(f"/api/jobs/{job_id}/stems/no_drums?download=true")
    assert drumless_dl.status_code == 200
    assert drumless_dl.content == ctx.demucster.stem_content

    # Test all-stems ZIP download includes both isolated and stemless tracks
    archive_response = await ctx.client.get(f"/api/jobs/{job_id}/download-zip")
    assert archive_response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive_response.content)) as archive:
        assert set(archive.namelist()) == {
            "drums.mp3",
            "vocals.mp3",
            "no_drums.mp3",
            "no_vocals.mp3",
        }


async def test_backing_only_job_archives_just_the_stemless_mix(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    submitted = await ctx.client.post(
        "/api/jobs/upload",
        data={
            "model": "htdemucs",
            "output_format": "mp3",
            "mp3_bitrate": "320",
            "stems": "no_vocals",
        },
        files={"file": ("song.mp3", b"source-data", "audio/mpeg")},
    )
    assert submitted.status_code == 201, submitted.text
    payload = submitted.json()
    remote_id = payload["remote_job_id"]
    assert ctx.demucster.submissions[-1] == {"stems": None, "exclude_stems": ["vocals"]}

    # Naming no stems to extract makes Demucster return all of them alongside
    # the stemless mix.
    ctx.demucster.jobs[remote_id] = RemoteJob(
        id=remote_id,
        status="COMPLETED",
        progress=100,
        error=None,
        stems=[
            RemoteStem(name="drums", filename="drums.mp3"),
            RemoteStem(name="bass", filename="bass.mp3"),
            RemoteStem(name="other", filename="other.mp3"),
            RemoteStem(name="vocals", filename="vocals.mp3"),
            RemoteStem(name="no_vocals", filename="no_vocals.mp3"),
        ],
    )

    await ctx.app.state.archiver.poll_once()
    detail = await ctx.client.get(f"/api/jobs/{payload['id']}")
    assert detail.status_code == 200
    archived = detail.json()
    assert archived["status"] == "READY"
    assert [stem["name"] for stem in archived["stems"]] == ["no_vocals"]
    assert archived["stems"][0]["display_name"] == "No Vocals (Karaoke)"

