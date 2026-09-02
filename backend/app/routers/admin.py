import uuid
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError

from app.demucster import DemucsterError
from app.dependencies import AdminUser, DbSession
from app.models import AppSetting, Job, JobStatus, Session, Stem, User, UserRole
from app.schemas import (
    AdminUserOut,
    AppSettingsOut,
    AppSettingsPatch,
    JobListOut,
    JobOut,
    PasswordIssuedOut,
    PasswordResetIn,
    SessionListOut,
    SessionOut,
    UserCreate,
    UserListOut,
    UserPatch,
)
from app.security import generate_password, hash_password

router = APIRouter(prefix="/api/admin", tags=["admin"])


async def active_admin_count(db: DbSession) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(User).where(
                User.role == UserRole.ADMIN, User.active.is_(True)
            )
        )
        or 0
    )


async def require_mutable_admin(
    target: User,
    actor: User,
    db: DbSession,
    *,
    deleting: bool = False,
    patch: UserPatch | None = None,
) -> None:
    if target.id == actor.id:
        if deleting or (patch and (patch.active is False or patch.role == UserRole.USER)):
            raise HTTPException(status_code=409, detail="You cannot lock out your own account")
    removes_active_admin = (
        target.active
        and target.role == UserRole.ADMIN
        and (
            deleting
            or (patch is not None and patch.active is False)
            or (patch is not None and patch.role == UserRole.USER)
        )
    )
    if removes_active_admin and await active_admin_count(db) <= 1:
        raise HTTPException(status_code=409, detail="At least one active administrator is required")


@router.get("/users", response_model=UserListOut)
async def list_users(
    _admin: AdminUser,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: str | None = Query(None, max_length=100),
) -> UserListOut:
    filters = []
    if search:
        term = f"%{search.strip()}%"
        filters.append(or_(User.username.ilike(term), User.display_name.ilike(term)))
    total = int(
        await db.scalar(select(func.count()).select_from(User).where(*filters)) or 0
    )
    statement = (
        select(
            User,
            func.count(func.distinct(Job.id)).label("job_count"),
            func.coalesce(func.sum(Stem.size_bytes), 0).label("storage_bytes"),
        )
        .outerjoin(Job, Job.owner_id == User.id)
        .outerjoin(Stem, Stem.job_id == Job.id)
        .where(*filters)
        .group_by(User.id)
        .order_by(User.username)
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(statement)).all()
    items = [
        AdminUserOut.model_validate(row[0]).model_copy(
            update={
                "job_count": int(row.job_count),
                "storage_bytes": int(row.storage_bytes),
            }
        )
        for row in rows
    ]
    return UserListOut(items=items, total=total, limit=limit, offset=offset)


@router.post("/users", response_model=PasswordIssuedOut, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserCreate, _admin: AdminUser, db: DbSession) -> PasswordIssuedOut:
    generated = body.password is None
    plain_password = body.password or generate_password()
    user = User(
        username=body.username,
        display_name=body.display_name,
        role=body.role,
        active=body.active,
        password_hash=hash_password(plain_password),
        password_reminder_seen=False,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from exc
    await db.refresh(user)
    return PasswordIssuedOut(
        user=user, generated_password=plain_password if generated else None
    )


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def patch_user(
    user_id: uuid.UUID, body: UserPatch, admin: AdminUser, db: DbSession
) -> AdminUserOut:
    admin_id = admin.id
    await db.rollback()
    await db.execute(text("BEGIN IMMEDIATE"))
    admin = await db.get(User, admin_id)
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    await require_mutable_admin(user, admin, db, patch=body)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    if body.active is False:
        await db.execute(delete(Session).where(Session.user_id == user.id))
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from exc
    await db.refresh(user)
    job_count = int(
        await db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id))
        or 0
    )
    storage = int(
        await db.scalar(
            select(func.coalesce(func.sum(Stem.size_bytes), 0))
            .select_from(Stem)
            .join(Job)
            .where(Job.owner_id == user.id)
        )
        or 0
    )
    return AdminUserOut.model_validate(user).model_copy(
        update={"job_count": job_count, "storage_bytes": storage}
    )


@router.post("/users/{user_id}/reset-password", response_model=PasswordIssuedOut)
async def reset_password(
    user_id: uuid.UUID,
    body: PasswordResetIn,
    _admin: AdminUser,
    db: DbSession,
) -> PasswordIssuedOut:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    generated = body.password is None
    plain_password = body.password or generate_password()
    user.password_hash = hash_password(plain_password)
    await db.execute(delete(Session).where(Session.user_id == user.id))
    await db.commit()
    await db.refresh(user)
    return PasswordIssuedOut(
        user=user, generated_password=plain_password if generated else None
    )


@router.post("/users/{user_id}/revoke-sessions", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_sessions(
    user_id: uuid.UUID, _admin: AdminUser, db: DbSession
) -> None:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    await db.execute(delete(Session).where(Session.user_id == user.id))
    await db.commit()


@router.get("/users/{user_id}/sessions", response_model=SessionListOut)
async def list_sessions(
    user_id: uuid.UUID, _admin: AdminUser, db: DbSession
) -> SessionListOut:
    if await db.get(User, user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    sessions = list(
        (
            await db.scalars(
                select(Session)
                .where(Session.user_id == user_id)
                .order_by(Session.last_seen_at.desc())
            )
        ).all()
    )
    return SessionListOut(items=[SessionOut.model_validate(item) for item in sessions])


@router.delete(
    "/users/{user_id}/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_session(
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    _admin: AdminUser,
    db: DbSession,
) -> None:
    auth_session = await db.get(Session, session_id)
    if auth_session is None or auth_session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    await db.delete(auth_session)
    await db.commit()


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    request: Request,
    admin: AdminUser,
    db: DbSession,
) -> None:
    admin_id = admin.id
    await db.rollback()
    await db.execute(text("BEGIN IMMEDIATE"))
    admin = await db.get(User, admin_id)
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    await require_mutable_admin(user, admin, db, deleting=True)
    jobs = list((await db.scalars(select(Job).where(Job.owner_id == user.id))).all())
    for job in jobs:
        if job.remote_job_id and not job.remote_deleted:
            try:
                await request.app.state.demucster.delete_job(job.remote_job_id)
            except DemucsterError as exc:
                if exc.status_code not in {404, 410}:
                    raise HTTPException(
                        status_code=exc.status_code, detail=exc.detail
                    ) from exc
        await request.app.state.archiver.delete_job_files(job.id)
    await db.delete(user)
    await db.commit()


@router.get("/jobs", response_model=JobListOut)
async def list_all_jobs(
    _admin: AdminUser,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    owner_id: uuid.UUID | None = None,
    job_status: JobStatus | None = Query(None, alias="status"),
    search: str | None = Query(None, max_length=200),
) -> JobListOut:
    filters = []
    if owner_id:
        filters.append(Job.owner_id == owner_id)
    if job_status:
        filters.append(Job.status == job_status)
    if search:
        term = f"%{search.strip()}%"
        filters.append(
            or_(
                Job.title.ilike(term),
                Job.filename.ilike(term),
                Job.model.ilike(term),
                Job.remote_job_id.ilike(term),
                User.username.ilike(term),
            )
        )
    base = select(Job).join(User).where(*filters)
    total = int(
        await db.scalar(
            select(func.count()).select_from(Job).join(User).where(*filters)
        )
        or 0
    )
    jobs = list(
        (await db.scalars(base.order_by(Job.created_at.desc()).limit(limit).offset(offset))).all()
    )
    return JobListOut(
        items=[JobOut.model_validate(job) for job in jobs],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/jobs/{job_id}/retry-archive", response_model=JobOut)
async def retry_archive(
    job_id: uuid.UUID, _admin: AdminUser, db: DbSession
) -> JobOut:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.remote_job_id or job.remote_deleted:
        raise HTTPException(status_code=409, detail="Remote job is unavailable")
    if job.status not in {JobStatus.FAILED, JobStatus.UNAVAILABLE, JobStatus.ARCHIVING}:
        raise HTTPException(status_code=409, detail="This job cannot be retried")
    job.status = JobStatus.PROCESSING
    job.error = None
    job.expires_at = None
    await db.commit()
    await db.refresh(job)
    return JobOut.model_validate(job)


@router.get("/settings", response_model=AppSettingsOut)
async def get_settings(_admin: AdminUser, db: DbSession) -> AppSettingsOut:
    setting = await db.get(AppSetting, 1)
    if setting is None:
        raise HTTPException(status_code=500, detail="Application settings are unavailable")
    return AppSettingsOut.model_validate(setting, from_attributes=True)


@router.patch("/settings", response_model=AppSettingsOut)
async def patch_settings(
    body: AppSettingsPatch, _admin: AdminUser, db: DbSession
) -> AppSettingsOut:
    setting = await db.get(AppSetting, 1)
    if setting is None:
        raise HTTPException(status_code=500, detail="Application settings are unavailable")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(setting, field, value)
    if body.retention_days is not None:
        terminal_jobs = list(
            (
                await db.scalars(
                    select(Job).where(
                        Job.status.in_(
                            {
                                JobStatus.READY,
                                JobStatus.FAILED,
                                JobStatus.UNAVAILABLE,
                            }
                        ),
                        Job.completed_at.is_not(None),
                    )
                )
            ).all()
        )
        for job in terminal_jobs:
            job.expires_at = job.completed_at + timedelta(days=body.retention_days)
    await db.commit()
    await db.refresh(setting)
    return AppSettingsOut.model_validate(setting, from_attributes=True)
