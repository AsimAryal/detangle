from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Session, User, UserRole
from app.security import token_digest


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.database.sessions() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db)]


def _is_expired(value: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value <= datetime.now(UTC)


async def get_current_session(request: Request, db: DbSession) -> Session:
    cookie_name = request.app.state.settings.session_cookie_name
    token = request.cookies.get(cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    auth_session = await db.scalar(
        select(Session).where(Session.token_hash == token_digest(token))
    )
    if auth_session is None or _is_expired(auth_session.expires_at):
        if auth_session is not None:
            await db.delete(auth_session)
            await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    if not auth_session.user.active:
        await db.delete(auth_session)
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account disabled")
    now = datetime.now(UTC)
    last_seen = auth_session.last_seen_at
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=UTC)
    if now - last_seen >= timedelta(minutes=5):
        auth_session.last_seen_at = now
        await db.commit()
    return auth_session


CurrentSession = Annotated[Session, Depends(get_current_session)]


async def get_current_user(auth_session: CurrentSession) -> User:
    return auth_session.user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_admin_user(user: CurrentUser) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator required")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
