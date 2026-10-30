import asyncio
import hashlib
import json
import logging
import os
import shutil
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.archiver import (
    ACTIVE_STATUSES,
    REMOTE_COMPLETE,
    REMOTE_FAILED,
    REMOTE_PROCESSING,
    REMOTE_QUEUED,
)
from app.config import Settings
from app.drumster import DrumsterClient, DrumsterError, RemoteTranscription
from app.models import JobStatus, Transcription, TranscriptionFile

ARTIFACT_SPECS: dict[str, tuple[str, str]] = {
    "musicxml": ("drums.musicxml", "application/vnd.recordare.musicxml+xml"),
    "midi": ("drums.mid", "audio/midi"),
    "raw_midi": ("drums_raw.mid", "audio/midi"),
    "analysis": ("analysis.json", "application/json"),
}
ALLOWED_ARTIFACT_MEDIA = {
    "application/json",
    "application/octet-stream",
    "application/vnd.recordare.musicxml+xml",
    "application/xml",
    "audio/midi",
    "audio/sp-midi",
    "audio/x-midi",
    "text/xml",
}
logger = logging.getLogger(__name__)


class TranscriptionArchiver:
    def __init__(
        self,
        sessions: async_sessionmaker,
        drumster: DrumsterClient,
        settings: Settings,
    ) -> None:
        self.sessions = sessions
        self.drumster = drumster
        self.settings = settings
        self.semaphore = asyncio.Semaphore(settings.archive_concurrency)

    async def poll_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected transcription archiver polling failure")
            await asyncio.sleep(self.settings.poll_interval_seconds)

    async def poll_once(self) -> None:
        async with self.sessions() as session:
            ids = list(
                (
                    await session.scalars(
                        select(Transcription.id)
                        .where(Transcription.status.in_(ACTIVE_STATUSES))
                        .order_by(Transcription.updated_at)
                    )
                ).all()
            )
        await asyncio.gather(*(self._bounded_process(tid) for tid in ids))

    async def _bounded_process(self, tid: uuid.UUID) -> None:
        async with self.semaphore:
            await self.process_transcription(tid)

    async def process_transcription(self, tid: uuid.UUID) -> None:
        async with self.sessions() as session:
            item = await session.get(Transcription, tid)
            if item is None or item.status not in ACTIVE_STATUSES or not item.remote_id:
                return
            try:
                remote = await self.drumster.get(item.remote_id)
            except DrumsterError as exc:
                if exc.status_code in {404, 410}:
                    await self._mark_terminal(
                        item, JobStatus.UNAVAILABLE, exc.detail, session
                    )
                else:
                    item.error = exc.detail
                    await session.commit()
                return

            if remote.status in REMOTE_QUEUED:
                item.status = JobStatus.QUEUED
                item.progress = remote.progress
                item.error = None
                await session.commit()
            elif remote.status in REMOTE_PROCESSING:
                item.status = JobStatus.PROCESSING
                item.progress = remote.progress
                item.error = None
                await session.commit()
            elif remote.status in REMOTE_FAILED:
                await self._mark_terminal(
                    item,
                    JobStatus.FAILED,
                    remote.error or "Transcription failed",
                    session,
                )
            elif remote.status in REMOTE_COMPLETE:
                await self._archive(item, remote, session)
            else:
                item.error = "Drumster returned an unknown transcription status"
                await session.commit()

    async def _mark_terminal(
        self,
        item: Transcription,
        status: JobStatus,
        error: str,
        session: AsyncSession,
    ) -> None:
        now = datetime.now(UTC)
        item.status = status
        item.error = error[:2000]
        item.completed_at = now
        await session.commit()

    async def _archive(
        self,
        item: Transcription,
        remote: RemoteTranscription,
        session: AsyncSession,
    ) -> None:
        item.status = JobStatus.ARCHIVING
        item.archive_attempts += 1
        item.error = None
        await session.commit()

        target_dir = (
            self.settings.jobs_dir
            / str(item.job_id)
            / "transcriptions"
            / str(item.id)
        )
        await asyncio.to_thread(target_dir.mkdir, parents=True, exist_ok=True)
        for partial in target_dir.glob("*.part"):
            partial.unlink(missing_ok=True)

        records: list[TranscriptionFile] = []
        try:
            for kind, (filename, default_media) in ARTIFACT_SPECS.items():
                final_path = target_dir / filename
                part_path = final_path.with_name(final_path.name + ".part")
                digest = hashlib.sha256()
                size = 0
                assert item.remote_id is not None
                async with self.drumster.stream_artifact(
                    item.remote_id, kind
                ) as response:
                    media_type = (
                        response.headers.get("content-type", "")
                        .split(";", 1)[0]
                        .lower()
                        or default_media
                    )
                    if media_type not in ALLOWED_ARTIFACT_MEDIA:
                        raise ValueError("Unexpected transcription artifact content type")
                    with part_path.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if chunk:
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                if size == 0:
                    raise ValueError("Drumster returned an empty transcription artifact")
                os.replace(part_path, final_path)
                records.append(
                    TranscriptionFile(
                        transcription_id=item.id,
                        kind=kind,
                        filename=filename,
                        relative_path=str(final_path.relative_to(self.settings.data_dir)),
                        media_type=default_media,
                        size_bytes=size,
                        sha256=digest.hexdigest(),
                    )
                )
        except (DrumsterError, OSError, ValueError) as exc:
            for partial in target_dir.glob("*.part"):
                partial.unlink(missing_ok=True)
            item.error = str(exc)[:2000]
            await session.commit()
            return

        await session.execute(
            delete(TranscriptionFile).where(
                TranscriptionFile.transcription_id == item.id
            )
        )
        session.add_all(records)
        now = datetime.now(UTC)
        item.status = JobStatus.READY
        item.progress = 100.0
        item.completed_at = now
        if remote.summary is not None:
            item.summary_json = json.dumps(remote.summary)
        item.error = None
        await session.commit()

        if item.remote_id:
            try:
                await self.drumster.delete(item.remote_id)
            except DrumsterError:
                return
            item.remote_deleted = True
            await session.commit()

    async def delete_transcription_files(
        self, job_id: uuid.UUID, tid: uuid.UUID
    ) -> None:
        path = self.settings.jobs_dir / str(job_id) / "transcriptions" / str(tid)
        if path.exists():
            await asyncio.to_thread(shutil.rmtree, path, True)

