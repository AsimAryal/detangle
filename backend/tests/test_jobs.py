import httpx
from conftest import TestContext, login


async def create_user(ctx: TestContext, username: str) -> tuple[str, str]:
    response = await ctx.client.post(
        "/api/admin/users",
        json={"username": username, "display_name": username.title()},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    return payload["user"]["id"], payload["generated_password"]


async def test_job_submission_owner_scope_and_admin_listing(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    user1_id, user1_password = await create_user(ctx, "owner-one")
    _, user2_password = await create_user(ctx, "owner-two")

    transport = httpx.ASGITransport(app=ctx.app)
    async with (
        httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Origin": "http://testserver"},
        ) as owner,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Origin": "http://testserver"},
        ) as stranger,
    ):
        await login(owner, "owner-one", user1_password)
        await login(stranger, "owner-two", user2_password)

        upload = await owner.post(
            "/api/jobs/upload",
            data={
                "model": "htdemucs",
                "output_format": "mp3",
                "mp3_bitrate": "320",
                "stems": "vocals,drums",
            },
            files={"file": ("track.mp3", b"input-audio", "audio/mpeg")},
        )
        assert upload.status_code == 201, upload.text
        upload_payload = upload.json()
        job_id = upload_payload["id"]
        assert upload_payload["owner"] is None
        assert upload_payload["source_type"] == "upload"
        assert upload_payload["requested_stems"] == ["vocals", "drums"]
        assert upload_payload["progress_pct"] == 0
        assert "progress" not in upload_payload
        assert ctx.demucster.uploads == [b"input-audio"]
        assert not any(ctx.app.state.settings.jobs_dir.iterdir())

        assert (await stranger.get(f"/api/jobs/{job_id}")).status_code == 404
        assert (await stranger.delete(f"/api/jobs/{job_id}")).status_code == 404
        assert (
            await stranger.patch(
                f"/api/jobs/{job_id}",
                json={"title": "Not mine"},
            )
        ).status_code == 404
        assert (await owner.get(f"/api/jobs/{job_id}")).status_code == 200

        submitted_url = await owner.post(
            "/api/jobs/url",
            json={
                "url": "https://example.com/audio.mp3",
                "options": {
                    "model": "htdemucs",
                    "output_format": "wav",
                    "mp3_bitrate": 320,
                },
            },
        )
        assert submitted_url.status_code == 201, submitted_url.text
        assert ctx.demucster.urls == ["https://example.com/audio.mp3"]
        assert submitted_url.json()["source_url"] == "https://example.com/audio.mp3"

        private_url = await owner.post(
            "/api/jobs/url",
            json={
                "url": "http://127.0.0.1/private.mp3",
                "options": {"model": "htdemucs"},
            },
        )
        assert private_url.status_code == 422

        listing = await owner.get("/api/jobs?limit=1")
        assert listing.status_code == 200
        assert listing.json()["total"] == 2
        assert listing.json()["limit"] == 1

    admin_jobs = await ctx.client.get(f"/api/admin/jobs?owner_id={user1_id}")
    assert admin_jobs.status_code == 200
    assert admin_jobs.json()["total"] == 2
    assert admin_jobs.json()["items"][0]["owner"]["username"] == "owner-one"


async def test_system_endpoints(ctx: TestContext) -> None:
    assert (await ctx.client.get("/api/healthz")).status_code == 200
    assert (await ctx.client.get("/api/system/models")).status_code == 401
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    models = await ctx.client.get("/api/system/models")
    assert models.status_code == 200
    assert models.json()["live"] is True
    assert models.json()["items"][0]["id"] == "htdemucs"
    overview = await ctx.client.get("/api/system/overview")
    assert overview.status_code == 200
    assert overview.json()["demucster_healthy"] is True
    assert overview.json()["jobs_by_status"]["READY"] == 0
    assert overview.json()["gpu"]["cuda_available"] is True
    assert overview.json()["queue"] == {"queued": 0, "processing": 0}
    assert overview.json()["counts"]["READY"] == 0
