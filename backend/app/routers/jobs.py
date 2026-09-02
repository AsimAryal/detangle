import asyncio
import os
import re
import tempfile
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from app.catalog import available_models
from app.demucster import DemucsterError, RemoteJob
from app.dependencies import CurrentUser, DbSession
from app.models import AppSetting, Job, JobSource, JobStatus, Stem, User, UserRole
from app.schemas import JobListOut, JobOut, JobPatch, UrlJobIn
from app.security import safe_upload_filename

router = APIRouter(prefix="/api/jobs", tags=["jobs"])
OUTPUT_FORMATS = {"mp3", "wav"}
STEM_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def parse_stems(value: str | None) -> list[str] | None:
    if not value:
        return None
    stems = list(
        dict.fromkeys(
            part.strip().casefold() for part in value.split(",") if part.strip()
        )
    )
    if not stems or len(stems) > 16 or any(not STEM_RE.fullmatch(stem) for stem in stems):
        raise HTTPException(status_code=422, detail="Invalid stems")
    return stems


def validate_options(output_format: str, bitrate: int | None) -> tuple[str, int | None]:
    normalized = output_format.casefold()
    if normalized not in OUTPUT_FORMATS:
        raise HTTPException(status_code=422, detail="Unsupported output format")
    if normalized == "mp3":
        if bitrate is None or not 128 <= bitrate <= 320:
            raise HTTPException(
                status_code=422,
                detail="MP3 bitrate must be between 128 and 320 kbps",
            )
    else:
        bitrate = None
    return normalized, bitrate


async def validate_model(request: Request, model: str) -> str:
    normalized = model.strip()
    if not normalized or len(normalized) > 100:
        raise HTTPException(status_code=422, detail="Invalid model")
    models, live = await available_models(request.app.state.demucster)
    if normalized not in {item.id for item in models}:
        detail = (
            "Unknown model"
            if live
            else "Model cannot be verified while Demucster is unavailable"
        )
        raise HTTPException(status_code=422 if live else 503, detail=detail)
    return normalized


def local_status(remote: RemoteJob) -> JobStatus:
    value = remote.status.upper()
    if value in {"QUEUED", "PENDING", "CREATED"}:
        return JobStatus.QUEUED
    if value in {"FAILED", "ERROR", "CANCELLED", "CANCELED"}:
        return JobStatus.FAILED
    return JobStatus.PROCESSING


async def set_initial_terminal_expiry(
    job: Job, request: Request, db: DbSession
) -> None:
    if job.status != JobStatus.FAILED:
        return
    setting = await db.get(AppSetting, 1)
    retention_days = (
        setting.retention_days
        if setting is not None
        else request.app.state.settings.default_retention_days
    )
    now = datetime.now(UTC)
    job.completed_at = now
    job.expires_at = now + timedelta(days=retention_days)


def job_output(job: Job, include_owner: bool) -> JobOut:
    result = JobOut.model_validate(job)
    if not include_owner:
        result.owner = None
    return result


def demucster_http_error(exc: DemucsterError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/upload", response_model=JobOut, status_code=status.HTTP_201_CREATED)
async def submit_upload(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    model: str = Form(...),
    output_format: str = Form("mp3"),
    mp3_bitrate: int | None = Form(320),
    stems: str | None = Form(None),
) -> JobOut:
    try:
        filename = safe_upload_filename(file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    size = file.size
    if size is None:
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
    await file.seek(0)
    if size > request.app.state.settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Upload exceeds configured size limit")
    output_format, mp3_bitrate = validate_options(output_format, mp3_bitrate)
    selected_stems = parse_stems(stems)
    model = await validate_model(request, model)
    try:
        remote = await request.app.state.demucster.submit_upload(
            file=file.file,
            filename=filename,
            content_type=file.content_type,
            model=model,
            output_format=output_format,
            mp3_bitrate=mp3_bitrate,
            stems=selected_stems,
        )
    except DemucsterError as exc:
        raise demucster_http_error(exc) from exc
    status_value = local_status(remote)
    job = Job(
        remote_job_id=remote.id,
        owner_id=user.id,
        source=JobSource.UPLOAD,
        filename=filename,
        title=Path(filename).stem,
        include_original=False,
        model=model,
        output_format=output_format,
        mp3_bitrate=mp3_bitrate,
        requested_stems=",".join(selected_stems) if selected_stems else None,
        status=status_value,
        progress=remote.progress,
        error=remote.error if status_value == JobStatus.FAILED else None,
    )
    await set_initial_terminal_expiry(job, request, db)
    db.add(job)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Remote job is already tracked") from exc
    await db.refresh(job)
    return job_output(job, user.role == UserRole.ADMIN)


@router.post("/url", response_model=JobOut, status_code=status.HTTP_201_CREATED)
async def submit_url(
    body: UrlJobIn, request: Request, user: CurrentUser, db: DbSession
) -> JobOut:
    options = body.options
    output_format, bitrate = validate_options(options.output_format, options.mp3_bitrate)
    stems = parse_stems(",".join(options.stems) if options.stems else None)
    model = await validate_model(request, options.model)
    try:
        remote = await request.app.state.demucster.submit_url(
            url=body.url,
            model=model,
            output_format=output_format,
            mp3_bitrate=bitrate,
            stems=stems,
        )
    except DemucsterError as exc:
        raise demucster_http_error(exc) from exc
    status_value = local_status(remote)
    job = Job(
        remote_job_id=remote.id,
        owner_id=user.id,
        source=JobSource.URL,
        source_url=body.url,
        include_original=options.include_original,
        model=model,
        output_format=output_format,
        mp3_bitrate=bitrate,
        requested_stems=",".join(stems) if stems else None,
        status=status_value,
        progress=remote.progress,
        error=remote.error if status_value == JobStatus.FAILED else None,
    )
    await set_initial_terminal_expiry(job, request, db)
    db.add(job)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Remote job is already tracked") from exc
    await db.refresh(job)
    return job_output(job, user.role == UserRole.ADMIN)


@router.get("", response_model=JobListOut)
async def list_jobs(
    user: CurrentUser,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    job_status: JobStatus | None = Query(None, alias="status"),
    source: JobSource | None = None,
    search: str | None = Query(None, max_length=200),
) -> JobListOut:
    filters = [Job.owner_id == user.id]
    if job_status:
        filters.append(Job.status == job_status)
    if source:
        filters.append(Job.source == source)
    if search:
        term = f"%{search.strip()}%"
        filters.append(
            or_(
                Job.title.ilike(term),
                Job.filename.ilike(term),
                Job.model.ilike(term),
                Job.remote_job_id.ilike(term),
            )
        )
    total = int(
        await db.scalar(select(func.count()).select_from(Job).where(*filters)) or 0
    )
    jobs = list(
        (
            await db.scalars(
                select(Job)
                .where(*filters)
                .order_by(Job.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
        ).all()
    )
    return JobListOut(
        items=[job_output(job, user.role == UserRole.ADMIN) for job in jobs],
        total=total,
        limit=limit,
        offset=offset,
    )


async def scoped_job(job_id: uuid.UUID, user: User, db: DbSession) -> Job:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if user.role != UserRole.ADMIN and job.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/{job_id}", response_model=JobOut)
async def get_job(job_id: uuid.UUID, user: CurrentUser, db: DbSession) -> JobOut:
    job = await scoped_job(job_id, user, db)
    return job_output(job, user.role == UserRole.ADMIN)


@router.patch("/{job_id}", response_model=JobOut)
async def update_job(
    job_id: uuid.UUID,
    body: JobPatch,
    user: CurrentUser,
    db: DbSession,
) -> JobOut:
    job = await scoped_job(job_id, user, db)
    job.title = body.title
    await db.commit()
    await db.refresh(job)
    return job_output(job, user.role == UserRole.ADMIN)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_job(
    job_id: uuid.UUID, request: Request, user: CurrentUser, db: DbSession
) -> None:
    job = await scoped_job(job_id, user, db)
    if job.remote_job_id and not job.remote_deleted:
        try:
            await request.app.state.demucster.delete_job(job.remote_job_id)
        except DemucsterError as exc:
            if exc.status_code not in {404, 410}:
                raise demucster_http_error(exc) from exc
    await request.app.state.archiver.delete_job_files(job.id)
    await db.delete(job)
    await db.commit()


@router.get("/{job_id}/stems/{stem_name}")
async def get_stem(
    job_id: uuid.UUID,
    stem_name: str,
    user: CurrentUser,
    db: DbSession,
    request: Request,
    download: bool = False,
) -> FileResponse:
    job = await scoped_job(job_id, user, db)
    stem = await db.scalar(
        select(Stem).where(Stem.job_id == job.id, Stem.name == stem_name)
    )
    if stem is None:
        raise HTTPException(status_code=404, detail="Stem not found")
    path = (request.app.state.settings.data_dir / stem.relative_path).resolve()
    root = request.app.state.settings.jobs_dir.resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=410, detail="Archived stem is unavailable")
    return FileResponse(
        path,
        media_type=stem.media_type,
        filename=stem.filename,
        content_disposition_type="attachment" if download else "inline",
    )


def create_zip(path: Path, stems: list[tuple[Path, str]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for stem_path, filename in stems:
            archive.write(stem_path, arcname=filename)


@router.get("/{job_id}/download-zip")
@router.get("/{job_id}/stems.zip", include_in_schema=False)
@router.get("/{job_id}/all-stems", include_in_schema=False)
async def get_all_stems(
    job_id: uuid.UUID, request: Request, user: CurrentUser, db: DbSession
) -> FileResponse:
    job = await scoped_job(job_id, user, db)
    if job.status != JobStatus.READY or not job.stems:
        raise HTTPException(status_code=409, detail="Stems are not ready")
    root = request.app.state.settings.jobs_dir.resolve()
    paths: list[tuple[Path, str]] = []
    for stem in job.stems:
        path = (request.app.state.settings.data_dir / stem.relative_path).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(status_code=410, detail="An archived stem is unavailable")
        paths.append((path, stem.filename))
    temp_dir = request.app.state.settings.data_dir / ".tmp"
    await asyncio.to_thread(temp_dir.mkdir, parents=True, exist_ok=True)
    descriptor, raw_path = tempfile.mkstemp(prefix=f"{job.id}-", suffix=".zip", dir=temp_dir)
    os.close(descriptor)
    temp_path = Path(raw_path)
    try:
        await asyncio.to_thread(create_zip, temp_path, paths)
    except Exception:
        await asyncio.to_thread(temp_path.unlink, missing_ok=True)
        raise
    return FileResponse(
        temp_path,
        media_type="application/zip",
        filename=f"detangle-{job.id}.zip",
        background=BackgroundTask(temp_path.unlink, missing_ok=True),
    )
