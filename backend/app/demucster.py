from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, BinaryIO
from urllib.parse import quote

import httpx


class DemucsterError(Exception):
    def __init__(self, detail: str, status_code: int = 502) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class RemoteStem:
    name: str
    filename: str


@dataclass(slots=True)
class RemoteJob:
    id: str
    status: str
    progress: float
    error: str | None
    stems: list[RemoteStem]
    filename: str | None = None


ERROR_MAP = {
    400: (400, "Demucster rejected the request"),
    404: (404, "Remote job was not found"),
    409: (409, "Remote job is in the wrong state"),
    410: (410, "Remote job is no longer available"),
    413: (413, "Upload is too large for Demucster"),
    422: (422, "Demucster could not process these options"),
    503: (503, "Demucster is temporarily unavailable"),
}


class DemucsterClient:
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
            raise DemucsterError("Demucster is unavailable", 503) from exc
        if response.is_error:
            api_status, detail = ERROR_MAP.get(
                response.status_code, (502, "Unexpected response from Demucster")
            )
            raise DemucsterError(detail, api_status)
        return response

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, UnicodeDecodeError) as exc:
            raise DemucsterError("Demucster returned malformed data") from exc

    async def health(self) -> tuple[bool, str | None, dict[str, Any]]:
        try:
            response = await self._request("GET", "/api/v1/health")
            payload = self._json(response)
            if isinstance(payload, dict):
                raw_status = str(payload.get("status", "")).casefold()
                healthy = payload.get("healthy", raw_status in {"ok", "healthy"})
                return (
                    bool(healthy),
                    None if healthy else "Demucster reported unhealthy",
                    payload,
                )
            return False, "Demucster returned malformed health data", {}
        except DemucsterError as exc:
            return False, exc.detail, {}

    async def models(self) -> list[dict[str, Any]]:
        payload = self._json(await self._request("GET", "/api/v1/models"))
        if isinstance(payload, dict):
            payload = payload.get("items", payload.get("models"))
        if not isinstance(payload, list):
            raise DemucsterError("Demucster returned malformed model data")
        return [item for item in payload if isinstance(item, (dict, str))]

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
        exclude_stems: list[str] | None = None,
    ) -> RemoteJob:
        data: dict[str, str] = {"model": model, "output_format": output_format}
        if mp3_bitrate is not None:
            data["mp3_bitrate"] = str(mp3_bitrate)
        if stems:
            data["stems"] = ",".join(stems)
        if exclude_stems:
            data["exclude_stems"] = ",".join(exclude_stems)
        response = await self._request(
            "POST",
            "/api/v1/jobs/upload",
            data=data,
            files={"file": (filename, file, content_type or "application/octet-stream")},
        )
        return self._parse_job(self._json(response))

    async def submit_url(
        self,
        *,
        url: str,
        model: str,
        output_format: str,
        mp3_bitrate: int | None,
        stems: list[str] | None,
        exclude_stems: list[str] | None = None,
    ) -> RemoteJob:
        options: dict[str, Any] = {"model": model, "output_format": output_format}
        if mp3_bitrate is not None:
            options["mp3_bitrate"] = mp3_bitrate
        if stems:
            options["stems"] = stems
        if exclude_stems:
            options["exclude_stems"] = exclude_stems
        response = await self._request(
            "POST", "/api/v1/jobs/url", json={"url": url, "options": options}
        )
        return self._parse_job(self._json(response))

    async def get_job(self, remote_id: str) -> RemoteJob:
        encoded_id = quote(remote_id, safe="")
        return self._parse_job(
            self._json(await self._request("GET", f"/api/v1/jobs/{encoded_id}"))
        )

    async def list_jobs(self) -> list[RemoteJob]:
        payload = self._json(await self._request("GET", "/api/v1/jobs"))
        if isinstance(payload, dict):
            payload = payload.get("items", payload.get("jobs"))
        if not isinstance(payload, list):
            raise DemucsterError("Demucster returned malformed job data")
        return [self._parse_job(item) for item in payload]

    async def delete_job(self, remote_id: str) -> None:
        await self._request("DELETE", f"/api/v1/jobs/{quote(remote_id, safe='')}")

    @asynccontextmanager
    async def stream_stem(
        self, remote_id: str, stem_name: str
    ) -> AsyncIterator[httpx.Response]:
        encoded_id = quote(remote_id, safe="")
        encoded_stem = quote(stem_name, safe="")
        request = self.client.build_request(
            "GET", f"/api/v1/jobs/{encoded_id}/stems/{encoded_stem}"
        )
        try:
            response = await self.client.send(request, stream=True)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise DemucsterError("Demucster is unavailable", 503) from exc
        if response.is_error:
            await response.aclose()
            api_status, detail = ERROR_MAP.get(
                response.status_code, (502, "Unexpected response from Demucster")
            )
            raise DemucsterError(detail, api_status)
        try:
            yield response
        finally:
            await response.aclose()

    @asynccontextmanager
    async def stream_source(self, remote_id: str) -> AsyncIterator[httpx.Response]:
        encoded_id = quote(remote_id, safe="")
        request = self.client.build_request(
            "GET", f"/api/v1/jobs/{encoded_id}/source"
        )
        try:
            response = await self.client.send(request, stream=True)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise DemucsterError("Demucster is unavailable", 503) from exc
        if response.is_error:
            await response.aclose()
            api_status, detail = ERROR_MAP.get(
                response.status_code, (502, "Unexpected response from Demucster")
            )
            raise DemucsterError(detail, api_status)
        try:
            yield response
        finally:
            await response.aclose()

    @staticmethod
    def _parse_job(payload: Any) -> RemoteJob:
        if not isinstance(payload, dict):
            raise DemucsterError("Demucster returned malformed job data")
        remote_id = payload.get("id", payload.get("job_id"))
        status = payload.get("status")
        if not isinstance(remote_id, (str, int)) or not isinstance(status, str):
            raise DemucsterError("Demucster returned incomplete job data")
        raw_progress = payload.get("progress_pct", payload.get("progress", 0))
        try:
            progress = max(0.0, min(100.0, float(raw_progress)))
        except (TypeError, ValueError):
            progress = 0.0
        raw_stems = payload.get("stems", payload.get("outputs", payload.get("files", [])))
        stems: list[RemoteStem] = []
        if isinstance(raw_stems, dict):
            raw_stems = [
                {"name": key, "filename": key} for key in raw_stems
            ]
        if isinstance(raw_stems, list):
            for stem in raw_stems:
                if isinstance(stem, str):
                    stems.append(RemoteStem(name=stem.rsplit(".", 1)[0], filename=stem))
                elif isinstance(stem, dict):
                    filename = stem.get("filename", stem.get("file", stem.get("name")))
                    name = stem.get("name", stem.get("stem", filename))
                    if isinstance(filename, str) and isinstance(name, str):
                        stems.append(RemoteStem(name=name.rsplit(".", 1)[0], filename=filename))
        error = payload.get("error_message", payload.get("error", payload.get("detail")))
        return RemoteJob(
            id=str(remote_id),
            status=status.upper(),
            progress=progress,
            error=str(error)[:2000] if error else None,
            stems=stems,
            filename=(
                str(payload["filename"])[:255]
                if isinstance(payload.get("filename"), str)
                else None
            ),
        )
