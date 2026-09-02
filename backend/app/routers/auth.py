import logging
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select

from app.dependencies import CurrentSession, CurrentUser, DbSession
from app.models import Session, User
from app.schemas import AuthOut, ChangePasswordIn, LoginIn
from app.security import (
    DUMMY_PASSWORD_HASH,
    generate_session_token,
    hash_password,
    normalize_username,
    session_expiry,
    token_digest,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger(__name__)


def auth_response(user: User) -> AuthOut:
    return AuthOut(user=user, show_password_reminder=not user.password_reminder_seen)


@router.post("/login", response_model=AuthOut)
async def login(body: LoginIn, request: Request, response: Response, db: DbSession) -> AuthOut:
    try:
        username = normalize_username(body.username)
    except ValueError:
        username = body.username.strip().casefold()[:64]
    ip_address = request.client.host if request.client else "unknown"
    throttle_key = f"{ip_address}:{username}"
    request.app.state.login_throttle.check(throttle_key)
    user = await db.scalar(select(User).where(User.username == username))
    candidate_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    password_valid = verify_password(body.password, candidate_hash)
    if user is None or not password_valid or not user.active:
        request.app.state.login_throttle.fail(throttle_key)
        logger.warning("Login rejected username=%s ip=%s", username, ip_address)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password"
        )

    request.app.state.login_throttle.clear(throttle_key)
    token = generate_session_token()
    expiry = session_expiry(request.app.state.settings.session_days)
    auth_session = Session(
        token_hash=token_digest(token),
        user_id=user.id,
        expires_at=expiry,
        ip_address=ip_address,
        user_agent=request.headers.get("user-agent", "")[:512] or None,
    )
    user.last_login_at = datetime.now(UTC)
    db.add(auth_session)
    await db.commit()
    await db.refresh(user)
    logger.info("Login succeeded username=%s ip=%s", user.username, ip_address)
    response.set_cookie(
        key=request.app.state.settings.session_cookie_name,
        value=token,
        max_age=request.app.state.settings.session_days * 86400,
        expires=expiry,
        path="/",
        secure=request.app.state.settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return auth_response(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request, response: Response, auth_session: CurrentSession, db: DbSession
) -> None:
    await db.delete(auth_session)
    await db.commit()
    response.delete_cookie(
        request.app.state.settings.session_cookie_name,
        path="/",
        secure=request.app.state.settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


@router.get("/me", response_model=AuthOut)
async def me(user: CurrentUser) -> AuthOut:
    return auth_response(user)


@router.post("/change-password", response_model=AuthOut)
async def change_password(
    body: ChangePasswordIn,
    user: CurrentUser,
    auth_session: CurrentSession,
    db: DbSession,
) -> AuthOut:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(body.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different")
    user.password_hash = hash_password(body.new_password)
    await db.execute(
        delete(Session).where(Session.user_id == user.id, Session.id != auth_session.id)
    )
    await db.commit()
    await db.refresh(user)
    return auth_response(user)


@router.post("/password-reminder/ack", response_model=AuthOut)
async def acknowledge_password_reminder(user: CurrentUser, db: DbSession) -> AuthOut:
    user.password_reminder_seen = True
    await db.commit()
    await db.refresh(user)
    return auth_response(user)
