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
from app.dependencies import CurrentUser, DbSession
from app.drumster import DrumsterError, RemoteTranscription
from app.models import JobStatus, Stem, Transcription, TranscriptionFile
from app.routers.jobs import scoped_job
from app.schemas import TranscriptionListOut, TranscriptionOptionsIn, TranscriptionOut
from app.transcription_archiver import ARTIFACT_SPECS

router = APIRouter(prefix="/api/jobs/{job_id}/transcriptions", tags=["transcriptions"])

SAFE_TITLE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _local_status(remote: RemoteTranscription) -> JobStatus:
    value = remote.status.upper()
    if value in {"QUEUED", "PENDING", "CREATED"}:
        return JobStatus.QUEUED
    if value in {"FAILED", "ERROR", "CANCELLED", "CANCELED"}:
        return JobStatus.FAILED
    return JobStatus.PROCESSING


def _drumster_http_error(exc: DrumsterError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


def _download_filename(title: str | None, default_name: str) -> str:
    base = SAFE_TITLE_RE.sub("-", (title or "").strip()).strip("-._")
    if not base:
        return default_name
    return f"{base[:80]}-{default_name}"


@router.post("", response_model=TranscriptionOut, status_code=status.HTTP_201_CREATED)
async def create_transcription(
    job_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    body: TranscriptionOptionsIn | None = None,
) -> TranscriptionOut:
    if not request.app.state.settings.transcription_enabled:
        raise HTTPException(status_code=404, detail="Drum transcription is disabled")

    job = await scoped_job(job_id, user, db)
    if job.status != JobStatus.READY:
        raise HTTPException(
            status_code=409,
            detail="Job must be READY before generating drum notation",
        )

    options = body or TranscriptionOptionsIn()
    stem = await db.scalar(
        select(Stem).where(Stem.job_id == job.id, Stem.name == options.stem)
    )
    if stem is None:
        raise HTTPException(
            status_code=404,
            detail="Run a separation that includes the drums stem",
        )

    existing_active = await db.scalar(
        select(Transcription.id).where(
            Transcription.job_id == job.id,
            Transcription.status.in_(ACTIVE_STATUSES),
        )
    )
    if existing_active is not None:
        raise HTTPException(
            status_code=409,
            detail="A transcription is already in progress for this job",
        )

    stem_path = (request.app.state.settings.data_dir / stem.relative_path).resolve()
    root = request.app.state.settings.jobs_dir.resolve()
    if not stem_path.is_relative_to(root) or not stem_path.is_file():
        raise HTTPException(status_code=410, detail="Archived drums stem is unavailable")

    submit_opts = {
        "model": "adtof",
        "time_signature": options.time_signature,
        "grid": options.grid,
        "sensitivity": options.sensitivity,
        "tempo_bpm": options.tempo_bpm,
        "title": job.title or (Path(job.filename).stem if job.filename else "Drums"),
    }
    try:
        with stem_path.open("rb") as handle:
            remote = await request.app.state.drumster.submit(
                file=handle,
                filename=stem.filename,
                content_type=stem.media_type,
                options=submit_opts,
            )
    except DrumsterError as exc:
        raise _drumster_http_error(exc) from exc

    status_value = _local_status(remote)
    item = Transcription(
        job_id=job.id,
        stem_name=options.stem,
        remote_id=remote.id,
        model="adtof",
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
            status_code=409, detail="Remote transcription is already tracked"
        ) from exc
    await db.refresh(item)
    return TranscriptionOut.model_validate(item)


@router.get("", response_model=TranscriptionListOut)
async def list_transcriptions(
    job_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> TranscriptionListOut:
    job = await scoped_job(job_id, user, db)
    rows = list(
        (
            await db.scalars(
                select(Transcription)
                .where(Transcription.job_id == job.id)
                .order_by(Transcription.created_at.desc())
            )
        ).all()
    )
    return TranscriptionListOut(
        items=[TranscriptionOut.model_validate(row) for row in rows]
    )


async def _scoped_transcription(
    job_id: uuid.UUID,
    tid: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> tuple[str | None, Transcription]:
    job = await scoped_job(job_id, user, db)
    item = await db.get(Transcription, tid)
    if item is None or item.job_id != job.id:
        raise HTTPException(status_code=404, detail="Transcription not found")
    return job.title or job.filename, item


@router.get("/{tid}", response_model=TranscriptionOut)
async def get_transcription(
    job_id: uuid.UUID,
    tid: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> TranscriptionOut:
    _, item = await _scoped_transcription(job_id, tid, user, db)
    return TranscriptionOut.model_validate(item)


@router.get("/{tid}/files/{kind}")
async def get_transcription_file(
    job_id: uuid.UUID,
    tid: uuid.UUID,
    kind: str,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    download: bool = False,
) -> FileResponse:
    if kind not in ARTIFACT_SPECS:
        raise HTTPException(status_code=404, detail="Unknown transcription file kind")

    title, item = await _scoped_transcription(job_id, tid, user, db)
    tfile = await db.scalar(
        select(TranscriptionFile).where(
            TranscriptionFile.transcription_id == item.id,
            TranscriptionFile.kind == kind,
        )
    )
    if tfile is None:
        raise HTTPException(status_code=404, detail="Transcription file not found")

    path = (request.app.state.settings.data_dir / tfile.relative_path).resolve()
    root = request.app.state.settings.jobs_dir.resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(
            status_code=410, detail="Archived transcription file is unavailable"
        )

    return FileResponse(
        path,
        media_type=tfile.media_type,
        filename=_download_filename(title, tfile.filename),
        content_disposition_type="attachment" if download else "inline",
    )


@router.delete("/{tid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_transcription(
    job_id: uuid.UUID,
    tid: uuid.UUID,
    request: Request,
    user: CurrentUser,
    db: DbSession,
) -> None:
    _, item = await _scoped_transcription(job_id, tid, user, db)
    if item.remote_id and not item.remote_deleted:
        try:
            await request.app.state.drumster.delete(item.remote_id)
        except DrumsterError as exc:
            if exc.status_code not in {404, 410}:
                raise _drumster_http_error(exc) from exc
    await request.app.state.transcription_archiver.delete_transcription_files(
        item.job_id, item.id
    )
    await db.delete(item)
    await db.commit()

