import asyncio
import shutil

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.catalog import available_models
from app.dependencies import CurrentUser, DbSession
from app.models import Job, JobStatus, Stem, User, UserRole
from app.schemas import ModelsOut, OverviewOut

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/system/models", response_model=ModelsOut)
async def models(request: Request, _user: CurrentUser) -> ModelsOut:
    items, live = await available_models(request.app.state.demucster)
    return ModelsOut(items=items, live=live)


@router.get("/system/overview", response_model=OverviewOut)
async def overview(
    request: Request, user: CurrentUser, db: DbSession
) -> OverviewOut:
    healthy, detail, demucster = await request.app.state.demucster.health()
    usage = await asyncio.to_thread(shutil.disk_usage, request.app.state.settings.data_dir)
    status_statement = select(Job.status, func.count()).group_by(Job.status)
    if user.role != UserRole.ADMIN:
        status_statement = status_statement.where(Job.owner_id == user.id)
    status_rows = (await db.execute(status_statement)).all()
    status_counts = {status.value: 0 for status in JobStatus}
    status_counts.update({row[0].value: int(row[1]) for row in status_rows})
    archive_bytes = int(
        await db.scalar(select(func.coalesce(func.sum(Stem.size_bytes), 0))) or 0
    )
    user_count = (
        int(await db.scalar(select(func.count()).select_from(User)) or 0)
        if user.role == UserRole.ADMIN
        else 1
    )
    queued_jobs = int(demucster.get("queued_jobs") or 0)
    active_jobs = int(demucster.get("active_jobs") or 0)
    device_name = str(demucster.get("device_name") or "GPU unavailable")
    return OverviewOut(
        health="Operational" if healthy else "Degraded",
        demucster_healthy=healthy,
        demucster_detail=detail,
        demucster=demucster,
        queue={"queued": queued_jobs, "processing": active_jobs},
        gpu={
            "status": "Online" if healthy else "Offline",
            "name": device_name,
            "cuda_available": bool(demucster.get("cuda_available", False)),
            "vram_allocated_mb": demucster.get("vram_allocated_mb"),
            "vram_total_mb": demucster.get("vram_total_mb"),
        },
        dgx={"status": "Online" if healthy else "Offline"},
        archive={
            "used_bytes": archive_bytes,
            "total_bytes": usage.total,
            "free_bytes": usage.free,
            "disk_used_bytes": usage.used,
            "status": "healthy" if usage.free > usage.total * 0.1 else "low",
        },
        counts=status_counts,
        disk_total_bytes=usage.total,
        disk_free_bytes=usage.free,
        disk_used_bytes=usage.used,
        archive_bytes=archive_bytes,
        jobs_by_status=status_counts,
        user_count=user_count,
    )
