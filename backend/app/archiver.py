import asyncio
import hashlib
import logging
import os
import shutil
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.demucster import DemucsterClient, DemucsterError, RemoteJob
from app.models import AppSetting, Job, JobStatus, Session, Stem
from app.security import safe_stem_filename, safe_upload_filename

ACTIVE_STATUSES = {JobStatus.QUEUED, JobStatus.PROCESSING, JobStatus.ARCHIVING}
TERMINAL_STATUSES = {JobStatus.READY, JobStatus.FAILED, JobStatus.UNAVAILABLE}
REMOTE_QUEUED = {"QUEUED", "PENDING", "CREATED"}
REMOTE_PROCESSING = {"PROCESSING", "RUNNING", "STARTED"}
REMOTE_COMPLETE = {"READY", "COMPLETED", "COMPLETE", "SUCCEEDED", "SUCCESS"}
REMOTE_FAILED = {"FAILED", "ERROR", "CANCELLED", "CANCELED"}
ALLOWED_STEM_MEDIA = {
    "application/octet-stream",
    "audio/flac",
    "audio/m4a",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
}
logger = logging.getLogger(__name__)


def aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class Archiver:
    def __init__(
        self,
        sessions: async_sessionmaker,
        demucster: DemucsterClient,
        settings: Settings,
    ) -> None:
        self.sessions = sessions
        self.demucster = demucster
        self.settings = settings
        self.semaphore = asyncio.Semaphore(settings.archive_concurrency)

    async def poll_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected archiver polling failure")
            await asyncio.sleep(self.settings.poll_interval_seconds)

    async def retention_loop(self) -> None:
        while True:
            try:
                await self.retention_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected retention failure")
            await asyncio.sleep(self.settings.retention_sweep_minutes * 60)

    async def poll_once(self) -> None:
        async with self.sessions() as session:
            ids = list(
                (
                    await session.scalars(
                        select(Job.id)
                        .where(Job.status.in_(ACTIVE_STATUSES))
                        .order_by(Job.updated_at)
                    )
                ).all()
            )
        await asyncio.gather(*(self._bounded_process(job_id) for job_id in ids))

    async def _bounded_process(self, job_id: uuid.UUID) -> None:
        async with self.semaphore:
            await self.process_job(job_id)

    async def process_job(self, job_id: uuid.UUID) -> None:
        async with self.sessions() as session:
            job = await session.get(Job, job_id)
            if job is None or job.status not in ACTIVE_STATUSES or not job.remote_job_id:
                return
            try:
                remote = await self.demucster.get_job(job.remote_job_id)
            except DemucsterError as exc:
                if exc.status_code in {404, 410}:
                    await self._mark_terminal(job, JobStatus.UNAVAILABLE, exc.detail, session)
                else:
                    job.error = exc.detail
                    await session.commit()
                return

            if remote.filename:
                job.filename = remote.filename
                if not job.title:
                    job.title = Path(remote.filename).stem

            if remote.status in REMOTE_QUEUED:
                job.status = JobStatus.QUEUED
                job.progress = remote.progress
                job.error = None
                await session.commit()
            elif remote.status in REMOTE_PROCESSING:
                job.status = JobStatus.PROCESSING
                job.progress = remote.progress
                job.error = None
                await session.commit()
            elif remote.status in REMOTE_FAILED:
                await self._mark_terminal(
                    job, JobStatus.FAILED, remote.error or "Separation failed", session
                )
            elif remote.status in REMOTE_COMPLETE:
                await self._archive(job, remote, session)
            else:
                job.error = "Demucster returned an unknown job status"
                await session.commit()

    async def _mark_terminal(
        self, job: Job, status: JobStatus, error: str, session: AsyncSession
    ) -> None:
        setting = await session.get(AppSetting, 1)
        days = setting.retention_days if setting else self.settings.default_retention_days
        now = datetime.now(UTC)
        job.status = status
        job.error = error[:2000]
        job.completed_at = now
        job.expires_at = now + timedelta(days=days)
        await session.commit()

    async def _archive(
        self, job: Job, remote: RemoteJob, session: AsyncSession
    ) -> None:
        job.status = JobStatus.ARCHIVING
        job.archive_attempts += 1
        job.error = None
        await session.commit()
        if not remote.stems:
            job.error = "Completed remote job has no stems"
            await session.commit()
            return

        target_dir = self.settings.jobs_dir / str(job.id)
        await asyncio.to_thread(target_dir.mkdir, parents=True, exist_ok=True)
        for partial in target_dir.glob("*.part"):
            partial.unlink(missing_ok=True)

        records: list[Stem] = []
        filenames: set[str] = set()
        try:
            for remote_stem in remote.stems:
                filename = safe_stem_filename(remote_stem.filename, job.output_format)
                if filename.casefold() in filenames:
                    raise ValueError("Duplicate stem filename")
                filenames.add(filename.casefold())
                final_path = target_dir / filename
                part_path = final_path.with_name(final_path.name + ".part")
                digest = hashlib.sha256()
                size = 0
                async with self.demucster.stream_stem(
                    job.remote_job_id, remote_stem.filename
                ) as response:
                    media_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    if media_type not in ALLOWED_STEM_MEDIA:
                        raise ValueError("Unexpected stem content type")
                    with part_path.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if chunk:
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                if size == 0:
                    raise ValueError("Demucster returned an empty stem")
                os.replace(part_path, final_path)
                records.append(
                    Stem(
                        job_id=job.id,
                        name=Path(filename).stem,
                        filename=filename,
                        relative_path=str(final_path.relative_to(self.settings.data_dir)),
                        media_type=media_type,
                        size_bytes=size,
                        sha256=digest.hexdigest(),
                    )
                )
            if job.include_original:
                source_name = safe_upload_filename(remote.filename or "original.wav")
                source_path = Path(source_name)
                filename = f"{source_path.stem}-original{source_path.suffix.lower()}"
                if filename.casefold() in filenames:
                    raise ValueError("Original mix filename conflicts with a stem")
                final_path = target_dir / filename
                part_path = final_path.with_name(final_path.name + ".part")
                digest = hashlib.sha256()
                size = 0
                async with self.demucster.stream_source(job.remote_job_id) as response:
                    media_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    if media_type not in ALLOWED_STEM_MEDIA:
                        raise ValueError("Unexpected original mix content type")
                    with part_path.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if chunk:
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                if size == 0:
                    raise ValueError("Demucster returned an empty original mix")
                os.replace(part_path, final_path)
                records.append(
                    Stem(
                        job_id=job.id,
                        name="original",
                        filename=filename,
                        relative_path=str(final_path.relative_to(self.settings.data_dir)),
                        media_type=media_type,
                        size_bytes=size,
                        sha256=digest.hexdigest(),
                    )
                )
        except (DemucsterError, OSError, ValueError) as exc:
            for partial in target_dir.glob("*.part"):
                partial.unlink(missing_ok=True)
            job.error = str(exc)[:2000]
            await session.commit()
            return

        await session.execute(delete(Stem).where(Stem.job_id == job.id))
        session.add_all(records)
        setting = await session.get(AppSetting, 1)
        days = setting.retention_days if setting else self.settings.default_retention_days
        now = datetime.now(UTC)
        job.status = JobStatus.READY
        job.progress = 100.0
        job.completed_at = now
        job.expires_at = now + timedelta(days=days)
        job.error = None
        await session.commit()

        delete_remote = (
            setting.delete_remote_after_archive
            if setting
            else self.settings.delete_remote_after_archive
        )
        if delete_remote:
            try:
                await self.demucster.delete_job(job.remote_job_id)
            except DemucsterError:
                return
            job.remote_deleted = True
            await session.commit()

    async def retention_once(self) -> int:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            await session.execute(delete(Session).where(Session.expires_at <= now))
            jobs = list(
                (
                    await session.scalars(
                        select(Job).where(
                            Job.status.in_(TERMINAL_STATUSES),
                            Job.expires_at.is_not(None),
                            Job.expires_at <= now,
                        )
                    )
                ).all()
            )
            purged = 0
            for job in jobs:
                await self.delete_job_files(job.id)
                remote_cleaned = True
                if job.remote_job_id and not job.remote_deleted:
                    try:
                        await self.demucster.delete_job(job.remote_job_id)
                    except DemucsterError as exc:
                        if exc.status_code not in {404, 410}:
                            remote_cleaned = False
                            job.error = "Local archive expired; remote cleanup will retry"
                if remote_cleaned:
                    await session.delete(job)
                    purged += 1
            await session.commit()
            return purged

    async def delete_job_files(self, job_id: uuid.UUID) -> None:
        path = self.settings.jobs_dir / str(job_id)
        if path.exists():
            await asyncio.to_thread(shutil.rmtree, path, True)
