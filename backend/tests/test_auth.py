import httpx
from conftest import TestContext, login

from app.cli import reset_account_password


async def test_auth_reminder_csrf_and_password_session_revocation(
    ctx: TestContext,
) -> None:
    body = await login(ctx.client, "ADMIN", "Initial-Admin-Password1!")
    assert body["user"]["username"] == "admin"
    assert body["show_password_reminder"] is True

    me = await ctx.client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.headers["cache-control"] == "no-store"
    assert me.headers["x-content-type-options"] == "nosniff"

    rejected = await ctx.client.post(
        "/api/auth/password-reminder/ack",
        headers={"Origin": "https://attacker.example"},
    )
    assert rejected.status_code == 403

    acknowledged = await ctx.client.post("/api/auth/password-reminder/ack")
    assert acknowledged.status_code == 200
    assert acknowledged.json()["show_password_reminder"] is False

    transport = httpx.ASGITransport(app=ctx.app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    ) as other:
        await login(other, "admin", "Initial-Admin-Password1!")
        changed = await ctx.client.post(
            "/api/auth/change-password",
            json={
                "current_password": "Initial-Admin-Password1!",
                "new_password": "Changed-Admin-Password2!",
            },
        )
        assert changed.status_code == 200
        assert changed.json()["show_password_reminder"] is False
        assert (await other.get("/api/auth/me")).status_code == 401

    logout = await ctx.client.post("/api/auth/logout")
    assert logout.status_code == 204
    assert (await ctx.client.get("/api/auth/me")).status_code == 401


async def test_login_throttling(ctx: TestContext) -> None:
    for _ in range(5):
        response = await ctx.client.post(
            "/api/auth/login",
            json={"username": "missing", "password": "not-the-password"},
        )
        assert response.status_code == 401
    blocked = await ctx.client.post(
        "/api/auth/login",
        json={"username": "missing", "password": "not-the-password"},
    )
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "Too many login attempts; try again later"}


async def test_cli_password_reset_updates_existing_account(ctx: TestContext) -> None:
    await login(ctx.client, "admin", "Initial-Admin-Password1!")
    await reset_account_password(
        ctx.app.state.settings,
        "admin",
        "Reset-Admin-Password3!",
    )

    assert (await ctx.client.get("/api/auth/me")).status_code == 401
    reset_login = await login(ctx.client, "admin", "Reset-Admin-Password3!")
    assert reset_login["user"]["username"] == "admin"
