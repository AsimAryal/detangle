import httpx
from conftest import TestContext, login


async def test_admin_user_lifecycle_and_safeguards(ctx: TestContext) -> None:
    admin = await login(ctx.client, "admin", "Initial-Admin-Password1!")
    admin_id = admin["user"]["id"]

    demote = await ctx.client.patch(
        f"/api/admin/users/{admin_id}", json={"role": "user"}
    )
    assert demote.status_code == 409
    disable = await ctx.client.patch(
        f"/api/admin/users/{admin_id}", json={"active": False}
    )
    assert disable.status_code == 409
    assert (await ctx.client.delete(f"/api/admin/users/{admin_id}")).status_code == 409

    created = await ctx.client.post(
        "/api/admin/users",
        json={"username": "  Listener  ", "display_name": "Listener"},
    )
    assert created.status_code == 201
    issued = created.json()
    user_id = issued["user"]["id"]
    generated_password = issued["generated_password"]
    assert generated_password
    assert issued["user"]["username"] == "listener"
    assert issued["user"]["is_active"] is True
    assert "active" not in issued["user"]

    duplicate = await ctx.client.post(
        "/api/admin/users",
        json={
            "username": "LISTENER",
            "display_name": "Duplicate",
            "password": "Another-Strong-Password2!",
        },
    )
    assert duplicate.status_code == 409

    users = await ctx.client.get("/api/admin/users")
    assert users.status_code == 200
    assert users.json()["total"] == 2
    assert all("generated_password" not in item for item in users.json()["items"])

    transport = httpx.ASGITransport(app=ctx.app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    ) as user_client:
        first_login = await login(user_client, "listener", generated_password)
        assert first_login["show_password_reminder"] is True
        acknowledged = await user_client.post("/api/auth/password-reminder/ack")
        assert acknowledged.json()["show_password_reminder"] is False

        sessions = await ctx.client.get(f"/api/admin/users/{user_id}/sessions")
        assert sessions.status_code == 200
        assert len(sessions.json()["items"]) == 1
        session_id = sessions.json()["items"][0]["id"]
        revoked = await ctx.client.delete(
            f"/api/admin/users/{user_id}/sessions/{session_id}"
        )
        assert revoked.status_code == 204
        assert (await user_client.get("/api/auth/me")).status_code == 401

        await login(user_client, "listener", generated_password)

        reset = await ctx.client.post(
            f"/api/admin/users/{user_id}/reset-password", json={}
        )
        assert reset.status_code == 200
        reset_password = reset.json()["generated_password"]
        assert reset_password
        assert (await user_client.get("/api/auth/me")).status_code == 401
        after_reset = await login(user_client, "listener", reset_password)
        assert after_reset["show_password_reminder"] is False

    assert (await ctx.client.delete(f"/api/admin/users/{user_id}")).status_code == 204
    assert (await ctx.client.get("/api/admin/users")).json()["total"] == 1


async def test_global_settings(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    response = await ctx.client.patch(
        "/api/admin/settings",
        json={"retention_days": 7, "delete_remote_after_archive": True},
    )
    assert response.status_code == 200
    assert response.json()["retention_days"] == 7
    assert response.json()["delete_remote_after_archive"] is True
