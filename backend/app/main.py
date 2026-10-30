import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import func, select

from app.archiver import Archiver
from app.config import Settings, get_settings
from app.db import Database
from app.demucster import DemucsterClient
from app.drumster import DrumsterClient
from app.migrations import migrate
from app.models import AppSetting, User, UserRole
from app.routers import admin, auth, jobs, system, transcriptions
from app.security import (
    LoginThrottle,
    hash_password,
    normalize_username,
    validate_display_name,
)
from app.transcription_archiver import TranscriptionArchiver

logger = logging.getLogger(__name__)


async def bootstrap(app: FastAPI) -> None:
    settings: Settings = app.state.settings
    async with app.state.database.sessions() as session:
        app_setting = await session.get(AppSetting, 1)
        if app_setting is None:
            session.add(
                AppSetting(
                    id=1,
                    retention_days=settings.default_retention_days,
                    delete_remote_after_archive=settings.delete_remote_after_archive,
                )
            )
        user_count = int(await session.scalar(select(func.count()).select_from(User)) or 0)
        if user_count == 0:
            if settings.initial_admin_password is None:
                raise RuntimeError(
                    "INITIAL_ADMIN_PASSWORD is required when bootstrapping an empty database"
                )
            password = settings.initial_admin_password.get_secret_value()
            if password.startswith("CHANGE_ME"):
                raise RuntimeError(
                    "INITIAL_ADMIN_PASSWORD still contains the deployment placeholder"
                )
            session.add(
                User(
                    username=normalize_username(settings.initial_admin_username),
                    display_name=validate_display_name(settings.initial_admin_display_name),
                    password_hash=await asyncio.to_thread(hash_password, password),
                    role=UserRole.ADMIN,
                    active=True,
                    password_reminder_seen=False,
                )
            )
            logger.info(
                "Created initial administrator username=%s",
                normalize_username(settings.initial_admin_username),
            )
        elif settings.initial_admin_password is not None:
            logger.info(
                "Database already contains users; INITIAL_ADMIN_PASSWORD is not reapplied"
            )
        await session.commit()


def same_origin(request: Request) -> bool:
    supplied = request.headers.get("origin") or request.headers.get("referer")
    if supplied:
        parsed = urlparse(supplied)
        return parsed.scheme == request.url.scheme and parsed.netloc == request.headers.get("host")
    return request.headers.get("x-detangle-csrf") == "1"


def create_app(
    settings: Settings | None = None,
    demucster: DemucsterClient | None = None,
    drumster: DrumsterClient | None = None,
) -> FastAPI:
    configured = settings or get_settings()
    logging.basicConfig(
        level=getattr(logging, configured.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configured.data_dir.mkdir(parents=True, exist_ok=True)
        configured.jobs_dir.mkdir(parents=True, exist_ok=True)
        (configured.data_dir / ".tmp").mkdir(parents=True, exist_ok=True)
        for archive in (configured.data_dir / ".tmp").glob("*.zip"):
            archive.unlink(missing_ok=True)
        await asyncio.to_thread(migrate, configured)
        await app.state.database.initialize()
        try:
            await bootstrap(app)
        except Exception:
            await app.state.database.close()
            await app.state.demucster.close()
            await app.state.drumster.close()
            raise
        tasks: list[asyncio.Task] = []
        if not configured.disable_background_tasks:
            tasks = [
                asyncio.create_task(app.state.archiver.poll_loop(), name="job-archiver"),
                asyncio.create_task(app.state.archiver.retention_loop(), name="job-retention"),
                asyncio.create_task(
                    app.state.transcription_archiver.poll_loop(),
                    name="transcription-archiver",
                ),
            ]
        app.state.background_tasks = tasks
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await app.state.demucster.close()
            await app.state.drumster.close()
            await app.state.database.close()

    app = FastAPI(
        title="Detangle API",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = configured
    app.state.database = Database(configured.database_url)
    app.state.demucster = demucster or DemucsterClient(configured.demucster_url)
    app.state.drumster = drumster or DrumsterClient(configured.drumster_url)
    app.state.archiver = Archiver(
        app.state.database.sessions, app.state.demucster, configured
    )
    app.state.transcription_archiver = TranscriptionArchiver(
        app.state.database.sessions, app.state.drumster, configured
    )
    app.state.login_throttle = LoginThrottle()

    if configured.trusted_host_list:
        app.add_middleware(
            TrustedHostMiddleware, allowed_hosts=configured.trusted_host_list
        )

    @app.middleware("http")
    async def security_middleware(request: Request, call_next):
        is_unsafe = request.method not in {"GET", "HEAD", "OPTIONS", "TRACE"}
        has_session = configured.session_cookie_name in request.cookies
        login_path = request.url.path == "/api/auth/login"
        if is_unsafe and has_session and not login_path and not same_origin(request):
            response = JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "Cross-site request rejected"},
            )
        else:
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
            "font-src 'self' data:; worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'"
        )
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    app.include_router(auth.router)
    app.include_router(jobs.router)
    app.include_router(transcriptions.router)
    app.include_router(admin.router)
    app.include_router(system.router)

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        root = configured.frontend_dir.resolve()
        if not root.is_dir():
            raise HTTPException(status_code=404, detail="Frontend is not installed")
        candidate = (root / path).resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(status_code=404, detail="Frontend is not installed")

    return app


app = create_app()
