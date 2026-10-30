from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, BinaryIO
from urllib.parse import quote

import httpx


class DrumsterError(Exception):
    def __init__(self, detail: str, status_code: int = 502) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class RemoteTranscription:
    id: str
    status: str
    progress: float
    error: str | None
    artifacts: list[str]
    summary: dict[str, Any] | None = None
    filename: str | None = None


ERROR_MAP = {
    400: (400, "Drumster rejected the request"),
    404: (404, "Remote transcription was not found"),
    409: (409, "Remote transcription is in the wrong state"),
    410: (410, "Remote transcription is no longer available"),
    413: (413, "Stem file is too large for Drumster"),
    422: (422, "Drumster could not process these options"),
    503: (503, "Drumster is temporarily unavailable"),
}


class DrumsterClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        timeout = httpx.Timeout(connect=10, read=None, write=1800, pool=10)
        self.client = client or httpx.AsyncClient(
            base_url=base_url, timeout=timeout, follow_redirects=False
        )
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self.client.request(method, path, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise DrumsterError("Drumster is unavailable", 503) from exc
        if response.is_error:
            api_status, detail = ERROR_MAP.get(
                response.status_code, (502, "Unexpected response from Drumster")
            )
            raise DrumsterError(detail, api_status)
        return response

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, UnicodeDecodeError) as exc:
            raise DrumsterError("Drumster returned malformed data") from exc

    async def health(self) -> tuple[bool, str | None, dict[str, Any]]:
        try:
            response = await self._request("GET", "/api/v1/health")
            payload = self._json(response)
            if isinstance(payload, dict):
                raw_status = str(payload.get("status", "")).casefold()
                healthy = payload.get("healthy", raw_status in {"ok", "healthy"})
                return (
                    bool(healthy),
                    None if healthy else "Drumster reported unhealthy",
                    payload,
                )
            return False, "Drumster returned malformed health data", {}
        except DrumsterError as exc:
            return False, exc.detail, {}

    async def submit(
        self,
        *,
        file: BinaryIO,
        filename: str,
        content_type: str | None,
        options: dict[str, Any],
    ) -> RemoteTranscription:
        data: dict[str, str] = {}
        for key in ("model", "time_signature", "grid", "sensitivity", "tempo_bpm", "title"):
            val = options.get(key)
            if val is not None:
                data[key] = str(val)
        response = await self._request(
            "POST",
            "/api/v1/transcriptions/upload",
            data=data,
            files={"file": (filename, file, content_type or "application/octet-stream")},
        )
        return self._parse_transcription(self._json(response))

    async def get(self, remote_id: str) -> RemoteTranscription:
        encoded_id = quote(remote_id, safe="")
        return self._parse_transcription(
            self._json(await self._request("GET", f"/api/v1/transcriptions/{encoded_id}"))
        )

    async def delete(self, remote_id: str) -> None:
        await self._request("DELETE", f"/api/v1/transcriptions/{quote(remote_id, safe='')}")

    @asynccontextmanager
    async def stream_artifact(
        self, remote_id: str, artifact_name: str
    ) -> AsyncIterator[httpx.Response]:
        encoded_id = quote(remote_id, safe="")
        encoded_name = quote(artifact_name, safe="")
        request = self.client.build_request(
            "GET", f"/api/v1/transcriptions/{encoded_id}/artifacts/{encoded_name}"
        )
        try:
            response = await self.client.send(request, stream=True)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise DrumsterError("Drumster is unavailable", 503) from exc
        if response.is_error:
            await response.aclose()
            api_status, detail = ERROR_MAP.get(
                response.status_code, (502, "Unexpected response from Drumster")
            )
            raise DrumsterError(detail, api_status)
        try:
            yield response
        finally:
            await response.aclose()

    @staticmethod
    def _parse_transcription(payload: Any) -> RemoteTranscription:
        if not isinstance(payload, dict):
            raise DrumsterError("Drumster returned malformed transcription data")
        remote_id = payload.get("id", payload.get("job_id"))
        status = payload.get("status")
        if not isinstance(remote_id, (str, int)) or not isinstance(status, str):
            raise DrumsterError("Drumster returned incomplete transcription data")
        raw_progress = payload.get("progress_pct", payload.get("progress", 0))
        try:
            progress = max(0.0, min(100.0, float(raw_progress)))
        except (TypeError, ValueError):
            progress = 0.0
        raw_artifacts = payload.get("artifacts", {})
        artifacts: list[str] = []
        if isinstance(raw_artifacts, dict):
            artifacts = [str(k) for k in raw_artifacts]
        elif isinstance(raw_artifacts, list):
            artifacts = [str(k) for k in raw_artifacts if isinstance(k, str)]
        summary = payload.get("summary")
        if not isinstance(summary, dict):
            summary = None
        error = payload.get("error_message", payload.get("error", payload.get("detail")))
        return RemoteTranscription(
            id=str(remote_id),
            status=status.upper(),
            progress=progress,
            error=str(error)[:2000] if error else None,
            artifacts=artifacts,
            summary=summary,
            filename=(
                str(payload["filename"])[:255]
                if isinstance(payload.get("filename"), str)
                else None
            ),
        )

