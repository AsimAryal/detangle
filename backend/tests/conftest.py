from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import httpx
import pytest

from app.config import Settings
from app.demucster import DemucsterError, RemoteJob
from app.main import create_app


class FakeDemucster:
    def __init__(self) -> None:
        self.jobs: dict[str, RemoteJob] = {}
        self.deleted: list[str] = []
        self.uploads: list[bytes] = []
        self.urls: list[str] = []
        self.stem_content = b"ID3-detangle-test-audio"
        self.source_content = b"RIFF-detangle-test-source"
        self.counter = 0

    async def close(self) -> None:
        pass

    async def health(self) -> tuple[bool, str | None, dict[str, object]]:
        return (
            True,
            None,
            {
                "status": "healthy",
                "cuda_available": True,
                "device_name": "Test GPU",
                "active_jobs": 0,
                "queued_jobs": 0,
            },
        )

    async def models(self) -> list[dict[str, object]]:
        return [
            {
                "name": "htdemucs",
                "description": "Balanced test model",
                "stems": ["drums", "bass", "other", "vocals"],
                "is_default": True,
            }
        ]

    def _new_job(self) -> RemoteJob:
        self.counter += 1
        job = RemoteJob(
            id=f"remote-{self.counter}",
            status="QUEUED",
            progress=0,
            error=None,
            stems=[],
        )
        self.jobs[job.id] = job
        return job

    async def submit_upload(
        self,
        *,
        file: BinaryIO,
        filename: str,
        content_type: str | None,
        model: str,
        output_format: str,
        mp3_bitrate: int | None,
        stems: list[str] | None,
    ) -> RemoteJob:
        self.uploads.append(file.read())
        return self._new_job()

    async def submit_url(
        self,
        *,
        url: str,
        model: str,
        output_format: str,
        mp3_bitrate: int | None,
        stems: list[str] | None,
    ) -> RemoteJob:
        self.urls.append(url)
        return self._new_job()

    async def get_job(self, remote_id: str) -> RemoteJob:
        try:
            return self.jobs[remote_id]
        except KeyError as exc:
            raise DemucsterError("Remote job was not found", 404) from exc

    async def delete_job(self, remote_id: str) -> None:
        self.deleted.append(remote_id)
        self.jobs.pop(remote_id, None)

    @asynccontextmanager
    async def stream_stem(
        self, remote_id: str, filename: str
    ) -> AsyncIterator[httpx.Response]:
        yield httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            content=self.stem_content,
        )

    @asynccontextmanager
    async def stream_source(self, remote_id: str) -> AsyncIterator[httpx.Response]:
        yield httpx.Response(
            200,
            headers={"content-type": "audio/wav"},
            content=self.source_content,
        )


@dataclass
class TestContext:
    __test__ = False

    client: httpx.AsyncClient
    app: object
    demucster: FakeDemucster
    data_dir: Path


@pytest.fixture
async def ctx(tmp_path: Path) -> AsyncIterator[TestContext]:
    data_dir = tmp_path / "data"
    database_path = tmp_path / "detangle.db"
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{database_path.as_posix()}",
        data_dir=data_dir,
        frontend_dir=tmp_path / "frontend",
        initial_admin_password="Initial-Admin-Password1!",
        disable_background_tasks=True,
        cookie_secure=False,
    )
    fake = FakeDemucster()
    app = create_app(settings, fake)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Origin": "http://testserver"},
        ) as client:
            yield TestContext(client=client, app=app, demucster=fake, data_dir=data_dir)


async def login(client: httpx.AsyncClient, username: str, password: str) -> dict:
    response = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    return response.json()
