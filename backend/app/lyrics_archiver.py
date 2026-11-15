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
from app.demucster import DemucsterClient, DemucsterError, RemoteLyricsJob
from app.models import JobStatus, LyricsExtraction, LyricsFile

ARTIFACT_SPECS: dict[str, tuple[str, str]] = {
    "json": ("lyrics.json", "application/json"),
    "lrc": ("lyrics.lrc", "text/plain; charset=utf-8"),
    "ass": ("lyrics.ass", "text/plain; charset=utf-8"),
    "srt": ("lyrics.srt", "text/plain; charset=utf-8"),
}
ALLOWED_ARTIFACT_MEDIA = {
    "application/json",
    "application/octet-stream",
    "text/plain",
}
logger = logging.getLogger(__name__)


class LyricsArchiver:
    def __init__(
        self,
        sessions: async_sessionmaker,
        lyrics_client: DemucsterClient,
        settings: Settings,
    ) -> None:
        self.sessions = sessions
        self.lyrics_client = lyrics_client
        self.settings = settings
        self.semaphore = asyncio.Semaphore(settings.archive_concurrency)

    async def poll_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected lyrics archiver polling failure")
            await asyncio.sleep(self.settings.poll_interval_seconds)

    async def poll_once(self) -> None:
        async with self.sessions() as session:
            ids = list(
                (
                    await session.scalars(
                        select(LyricsExtraction.id)
                        .where(LyricsExtraction.status.in_(ACTIVE_STATUSES))
                        .order_by(LyricsExtraction.updated_at)
                    )
                ).all()
            )
        await asyncio.gather(*(self._bounded_process(lid) for lid in ids))

    async def _bounded_process(self, lid: uuid.UUID) -> None:
        async with self.semaphore:
            await self.process_extraction(lid)

    async def process_extraction(self, lid: uuid.UUID) -> None:
        async with self.sessions() as session:
            item = await session.get(LyricsExtraction, lid)
            if item is None or item.status not in ACTIVE_STATUSES or not item.remote_id:
                return
            try:
                remote = await self.lyrics_client.get_lyrics_job(item.remote_id)
            except DemucsterError as exc:
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
                    remote.error or "Lyrics extraction failed",
                    session,
                )
            elif remote.status in REMOTE_COMPLETE:
                await self._archive(item, remote, session)
            else:
                item.error = "Demucster returned an unknown lyrics job status"
                await session.commit()

    async def _mark_terminal(
        self,
        item: LyricsExtraction,
        status: JobStatus,
        error: str,
        session: AsyncSession,
    ) -> None:
        item.status = status
        item.error = error[:2000]
        item.completed_at = datetime.now(UTC)
        await session.commit()

    async def _archive(
        self,
        item: LyricsExtraction,
        remote: RemoteLyricsJob,
        session: AsyncSession,
    ) -> None:
        item.status = JobStatus.ARCHIVING
        item.archive_attempts += 1
        item.error = None
        await session.commit()

        target_dir = (
            self.settings.jobs_dir
            / str(item.job_id)
            / "lyrics"
            / str(item.id)
        )
        await asyncio.to_thread(target_dir.mkdir, parents=True, exist_ok=True)
        for partial in target_dir.glob("*.part"):
            partial.unlink(missing_ok=True)

        records: list[LyricsFile] = []
        try:
            for kind, (filename, default_media) in ARTIFACT_SPECS.items():
                final_path = target_dir / filename
                part_path = final_path.with_name(final_path.name + ".part")
                digest = hashlib.sha256()
                size = 0
                assert item.remote_id is not None
                async with self.lyrics_client.stream_lyrics_artifact(
                    item.remote_id, kind
                ) as response:
                    media_type = (
                        response.headers.get("content-type", "")
                        .split(";", 1)[0]
                        .lower()
                        or default_media.split(";", 1)[0]
                    )
                    if media_type not in ALLOWED_ARTIFACT_MEDIA:
                        raise ValueError("Unexpected lyrics artifact content type")
                    with part_path.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if chunk:
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                if size == 0:
                    raise ValueError("Demucster returned an empty lyrics artifact")
                os.replace(part_path, final_path)
                records.append(
                    LyricsFile(
                        lyrics_id=item.id,
                        kind=kind,
                        filename=filename,
                        relative_path=str(final_path.relative_to(self.settings.data_dir)),
                        media_type=default_media,
                        size_bytes=size,
                        sha256=digest.hexdigest(),
                    )
                )
        except (DemucsterError, OSError, ValueError) as exc:
            for partial in target_dir.glob("*.part"):
                partial.unlink(missing_ok=True)
            item.error = str(exc)[:2000]
            await session.commit()
            return

        await session.execute(
            delete(LyricsFile).where(LyricsFile.lyrics_id == item.id)
        )
        session.add_all(records)
        item.status = JobStatus.READY
        item.progress = 100.0
        item.completed_at = datetime.now(UTC)
        if remote.summary is not None:
            item.summary_json = json.dumps(remote.summary)
        item.error = None
        await session.commit()

        if item.remote_id:
            try:
                await self.lyrics_client.delete_lyrics_job(item.remote_id)
            except DemucsterError:
                return
            item.remote_deleted = True
            await session.commit()

    async def delete_lyrics_files(
        self, job_id: uuid.UUID, lid: uuid.UUID
    ) -> None:
        path = self.settings.jobs_dir / str(job_id) / "lyrics" / str(lid)
        if path.exists():
            await asyncio.to_thread(shutil.rmtree, path, True)

