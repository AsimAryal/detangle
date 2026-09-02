import json

import httpx
import pytest

from app.demucster import DemucsterClient, DemucsterError


async def test_demucster_parses_jobs_and_translates_errors() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/jobs/good":
            return httpx.Response(
                200,
                json={
                    "job_id": "good",
                    "status": "completed",
                    "progress_pct": 100,
                    "filename": "Song title.wav",
                    "stems": {
                        "vocals": "/api/v1/jobs/good/stems/vocals",
                    },
                },
            )
        if request.url.path == "/api/v1/jobs/missing":
            return httpx.Response(404, json={"detail": "sensitive upstream text"})
        return httpx.Response(503)

    http_client = httpx.AsyncClient(
        base_url="http://demucster.test",
        transport=httpx.MockTransport(handler),
    )
    client = DemucsterClient("http://ignored.test", http_client)
    job = await client.get_job("good")
    assert job.id == "good"
    assert job.status == "COMPLETED"
    assert job.progress == 100
    assert job.filename == "Song title.wav"
    assert job.stems[0].name == "vocals"
    assert job.stems[0].filename == "vocals"

    with pytest.raises(DemucsterError) as caught:
        await client.get_job("missing")
    assert caught.value.status_code == 404
    assert caught.value.detail == "Remote job was not found"
    await http_client.aclose()


async def test_demucster_rejects_malformed_payload() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"not-json")
    )
    http_client = httpx.AsyncClient(
        base_url="http://demucster.test", transport=transport
    )
    client = DemucsterClient("http://ignored.test", http_client)
    with pytest.raises(DemucsterError, match="malformed"):
        await client.models()
    await http_client.aclose()


async def test_url_submission_matches_demucster_contract() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            202,
            json={
                "job_id": "url-job",
                "status": "QUEUED",
                "progress_pct": 0,
                "stems": None,
            },
        )

    http_client = httpx.AsyncClient(
        base_url="http://demucster.test",
        transport=httpx.MockTransport(handler),
    )
    client = DemucsterClient("http://ignored.test", http_client)
    await client.submit_url(
        url="https://example.com/song",
        model="htdemucs_ft",
        output_format="mp3",
        mp3_bitrate=320,
        stems=["vocals"],
    )
    assert captured == {
        "path": "/api/v1/jobs/url",
        "body": {
            "url": "https://example.com/song",
            "options": {
                "model": "htdemucs_ft",
                "output_format": "mp3",
                "mp3_bitrate": 320,
                "stems": ["vocals"],
            },
        },
    }
    await http_client.aclose()


async def test_source_stream_uses_demucster_source_endpoint() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/jobs/job-id/source"
        return httpx.Response(
            200,
            headers={"content-type": "audio/wav"},
            content=b"full mix",
        )

    http_client = httpx.AsyncClient(
        base_url="http://demucster.test",
        transport=httpx.MockTransport(handler),
    )
    client = DemucsterClient("http://ignored.test", http_client)
    async with client.stream_source("job-id") as response:
        assert await response.aread() == b"full mix"
    await http_client.aclose()
