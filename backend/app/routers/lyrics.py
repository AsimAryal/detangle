import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.responses import FileResponse

from app.archiver import ACTIVE_STATUSES
from app.demucster import DemucsterError, RemoteLyricsJob
from app.dependencies import CurrentUser, DbSession
from app.lyrics_archiver import ARTIFACT_SPECS
from app.models import JobStatus, LyricsExtraction, LyricsFile, Stem
from app.routers.jobs import scoped_job
from app.schemas import LyricsExtractionListOut, LyricsExtractionOut, LyricsOptionsIn

router = APIRouter(prefix="/api/jobs/{job_id}/lyrics", tags=["lyrics"])

SAFE_TITLE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _local_status(remote: RemoteLyricsJob) -> JobStatus:
    value = remote.status.upper()
    if value in {"QUEUED", "PENDING", "CREATED"}:
        return JobStatus.QUEUED
    if value in {"FAILED", "ERROR", "CANCELLED", "CANCELED"}:
        return JobStatus.FAILED
    return JobStatus.PROCESSING


def _lyrics_http_error(exc: DemucsterError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


def _download_filename(title: str | None, default_name: str) -> str:
    base = SAFE_TITLE_RE.sub("-", (title or "").strip()).strip("-._")
    if not base:
        return default_name
    return f"{base[:80]}-{default_name}"


@router.post("", response_model=LyricsExtractionOut, status_code=status.HTTP_201_CREATED)
async def create_lyrics_extraction(
    job_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    body: LyricsOptionsIn | None = None,
) -> LyricsExtractionOut:
    if not request.app.state.settings.lyrics_enabled:
        raise HTTPException(status_code=404, detail="Lyrics extraction is disabled")

    job = await scoped_job(job_id, user, db)
    if job.status != JobStatus.READY:
        raise HTTPException(
            status_code=409,
            detail="Job must be READY before extracting timestamped lyrics",
        )

    options = body or LyricsOptionsIn()
    stem = await db.scalar(
        select(Stem).where(Stem.job_id == job.id, Stem.name == options.stem)
    )
    if stem is None:
        raise HTTPException(
            status_code=404,
            detail=f"Run a separation that includes the {options.stem} stem",
        )

    existing_active = await db.scalar(
        select(LyricsExtraction.id).where(
            LyricsExtraction.job_id == job.id,
            LyricsExtraction.status.in_(ACTIVE_STATUSES),
        )
    )
    if existing_active is not None:
        raise HTTPException(
            status_code=409,
            detail="A lyrics extraction is already in progress for this job",
        )

    stem_path = (request.app.state.settings.data_dir / stem.relative_path).resolve()
    root = request.app.state.settings.jobs_dir.resolve()
    if not stem_path.is_relative_to(root) or not stem_path.is_file():
        raise HTTPException(
            status_code=410,
            detail=f"Archived {options.stem} stem is unavailable",
        )

    submit_opts = {
        "model": options.model,
        "language": options.language,
        "reference_lyrics": options.reference_lyrics,
        "use_llm_cleanup": options.use_llm_cleanup,
        "title": job.title or (Path(job.filename).stem if job.filename else "Lyrics"),
    }
    try:
        with stem_path.open("rb") as handle:
            remote = await request.app.state.lyrics_client.submit_lyrics_upload(
                file=handle,
                filename=stem.filename,
                content_type=stem.media_type,
                options=submit_opts,
            )
    except DemucsterError as exc:
        raise _lyrics_http_error(exc) from exc

    status_value = _local_status(remote)
    item = LyricsExtraction(
        job_id=job.id,
        stem_name=options.stem,
        remote_id=remote.id,
        model=options.model,
        options_json=json.dumps(options.model_dump()),
        status=status_value,
        progress=remote.progress,
        error=remote.error if status_value == JobStatus.FAILED else None,
        completed_at=datetime.now(UTC) if status_value == JobStatus.FAILED else None,
    )
    db.add(item)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Remote lyrics job is already tracked"
        ) from exc
    await db.refresh(item)
    return LyricsExtractionOut.model_validate(item)


@router.get("", response_model=LyricsExtractionListOut)
async def list_lyrics_extractions(
    job_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> LyricsExtractionListOut:
    job = await scoped_job(job_id, user, db)
    rows = list(
        (
            await db.scalars(
                select(LyricsExtraction)
                .where(LyricsExtraction.job_id == job.id)
                .order_by(LyricsExtraction.created_at.desc())
            )
        ).all()
    )
    return LyricsExtractionListOut(
        items=[LyricsExtractionOut.model_validate(row) for row in rows]
    )


async def _scoped_lyrics(
    job_id: uuid.UUID,
    lid: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> tuple[str | None, LyricsExtraction]:
    job = await scoped_job(job_id, user, db)
    item = await db.get(LyricsExtraction, lid)
    if item is None or item.job_id != job.id:
        raise HTTPException(status_code=404, detail="Lyrics extraction not found")
    return job.title or job.filename, item


@router.get("/{lid}", response_model=LyricsExtractionOut)
async def get_lyrics_extraction(
    job_id: uuid.UUID,
    lid: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> LyricsExtractionOut:
    _, item = await _scoped_lyrics(job_id, lid, user, db)
    return LyricsExtractionOut.model_validate(item)


@router.get("/{lid}/files/{kind}")
async def get_lyrics_file(
    job_id: uuid.UUID,
    lid: uuid.UUID,
    kind: str,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    download: bool = False,
) -> FileResponse:
    if kind not in ARTIFACT_SPECS:
        raise HTTPException(status_code=404, detail="Unknown lyrics file kind")

    title, item = await _scoped_lyrics(job_id, lid, user, db)
    lfile = await db.scalar(
        select(LyricsFile).where(
            LyricsFile.lyrics_id == item.id,
            LyricsFile.kind == kind,
        )
    )
    if lfile is None:
        raise HTTPException(status_code=404, detail="Lyrics file not found")

    path = (request.app.state.settings.data_dir / lfile.relative_path).resolve()
    root = request.app.state.settings.jobs_dir.resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(
            status_code=410, detail="Archived lyrics file is unavailable"
        )

    return FileResponse(
        path,
        media_type=lfile.media_type,
        filename=_download_filename(title, lfile.filename),
        content_disposition_type="attachment" if download else "inline",
    )


@router.delete("/{lid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_lyrics_extraction(
    job_id: uuid.UUID,
    lid: uuid.UUID,
    request: Request,
    user: CurrentUser,
    db: DbSession,
) -> None:
    _, item = await _scoped_lyrics(job_id, lid, user, db)
    if item.remote_id and not item.remote_deleted:
        try:
            await request.app.state.lyrics_client.delete_lyrics_job(item.remote_id)
        except DemucsterError as exc:
            if exc.status_code not in {404, 410}:
                raise _lyrics_http_error(exc) from exc
    await request.app.state.lyrics_archiver.delete_lyrics_files(
        item.job_id, item.id
    )
    await db.delete(item)
    await db.commit()

