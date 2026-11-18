"""Apply user edits to an archived lyrics extraction and regenerate artifacts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.lyrics_archiver import ARTIFACT_SPECS
from app.lyrics_formats import render_all
from app.models import LyricsExtraction, LyricsFile
from app.schemas import LyricsDocumentIn, LyricsLineIn

ORIGINAL_DIRNAME = "original"
TIME_TOLERANCE = 0.001  # seconds


class LyricsEditError(ValueError):
    """Raised for invalid edits; mapped to HTTP 422."""


class NothingToRevertError(LyricsEditError):
    """Raised when reverting an extraction that has no saved edits; mapped to 409."""


def lyrics_dir(settings: Settings, item: LyricsExtraction) -> Path:
    return settings.jobs_dir / str(item.job_id) / "lyrics" / str(item.id)


def has_original_backup(settings: Settings, item: LyricsExtraction) -> bool:
    return (lyrics_dir(settings, item) / ORIGINAL_DIRNAME / "lyrics.json").is_file()


def _round3(value: float) -> float:
    return round(float(value), 3)


def normalize_lines(lines: list[LyricsLineIn]) -> list[dict[str, Any]]:
    """Validate and canonicalize edited lines. Messages use 1-based numbers."""
    result: list[dict[str, Any]] = []
    prev_line_start: float | None = None
    prev_line_number = 0

    for li, line in enumerate(lines, start=1):
        words: list[dict[str, Any]] = []
        prev_end: float | None = None
        for wi, word in enumerate(line.words, start=1):
            token = " ".join(word.word.split())
            if not token:
                continue
            start = _round3(word.start)
            end = _round3(word.end)
            if end <= start:
                raise LyricsEditError(f"Line {li}, word {wi}: end must be after start")
            if prev_end is not None and start < prev_end - TIME_TOLERANCE:
                raise LyricsEditError(f"Line {li}, word {wi} overlaps the previous word")
            prev_end = end
            words.append(
                {
                    "word": token,
                    "start": start,
                    "end": end,
                    "score": word.score,
                }
            )

        if words:
            text = " ".join(w["word"] for w in words)
            line_start = words[0]["start"]
            line_end = words[-1]["end"]
        else:
            text = " ".join(line.text.split())
            if not text:
                continue
            if line.start is None or line.end is None:
                raise LyricsEditError(f"Line {li}: start and end are required")
            line_start = _round3(line.start)
            line_end = _round3(line.end)
            if line_end <= line_start:
                raise LyricsEditError(f"Line {li}: end must be after start")

        if prev_line_start is not None and line_start < prev_line_start - TIME_TOLERANCE:
            raise LyricsEditError(f"Line {li} starts before line {prev_line_number}")
        prev_line_start = line_start
        prev_line_number = li

        result.append(
            {
                "index": len(result),
                "start": line_start,
                "end": line_end,
                "text": text,
                "words": words,
            }
        )
    return result


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    part = path.with_name(path.name + ".part")
    with part.open("wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.replace(part, path)


def _backup_originals(directory: Path) -> None:
    backup = directory / ORIGINAL_DIRNAME
    if (backup / "lyrics.json").is_file():
        return
    backup.mkdir(parents=True, exist_ok=True)
    for filename, _media in ARTIFACT_SPECS.values():
        source = directory / filename
        if source.is_file():
            shutil.copy2(source, backup / filename)


async def _sync_file_records(
    settings: Settings,
    session: AsyncSession,
    item: LyricsExtraction,
    contents: dict[str, bytes],
) -> None:
    rows = {
        row.kind: row
        for row in (
            await session.scalars(select(LyricsFile).where(LyricsFile.lyrics_id == item.id))
        ).all()
    }
    directory = lyrics_dir(settings, item)
    for kind, data in contents.items():
        filename, media_type = ARTIFACT_SPECS[kind]
        digest = hashlib.sha256(data).hexdigest()
        row = rows.get(kind)
        if row is None:
            session.add(
                LyricsFile(
                    lyrics_id=item.id,
                    kind=kind,
                    filename=filename,
                    relative_path=str((directory / filename).relative_to(settings.data_dir)),
                    media_type=media_type,
                    size_bytes=len(data),
                    sha256=digest,
                )
            )
        else:
            row.size_bytes = len(data)
            row.sha256 = digest


async def save_edited_document(
    settings: Settings,
    session: AsyncSession,
    item: LyricsExtraction,
    body: LyricsDocumentIn,
) -> None:
    directory = lyrics_dir(settings, item)
    json_path = directory / "lyrics.json"
    if not json_path.is_file():
        raise FileNotFoundError(json_path)

    lines = normalize_lines(body.lines)

    await asyncio.to_thread(_backup_originals, directory)

    current = json.loads(await asyncio.to_thread(json_path.read_text, encoding="utf-8"))
    old_summary = dict(current.get("summary") or {})
    last_end = lines[-1]["end"] if lines else 0.0
    summary = {
        **old_summary,
        "line_count": len(lines),
        "word_count": sum(len(line["words"]) for line in lines),
        "duration_seconds": round(
            max(float(old_summary.get("duration_seconds") or 0.0), last_end), 3
        ),
    }
    document = {
        "version": current.get("version", 1),
        "title": current.get("title"),
        "model": current.get("model", item.model),
        "summary": summary,
        "lines": lines,
    }

    contents = {kind: text.encode("utf-8") for kind, text in render_all(document).items()}

    def _write_all() -> None:
        for kind, data in contents.items():
            _atomic_write_bytes(directory / ARTIFACT_SPECS[kind][0], data)

    await asyncio.to_thread(_write_all)
    await _sync_file_records(settings, session, item, contents)
    item.summary_json = json.dumps(summary)
    item.edited_at = datetime.now(UTC)
    await session.commit()


async def revert_to_original(
    settings: Settings,
    session: AsyncSession,
    item: LyricsExtraction,
) -> None:
    directory = lyrics_dir(settings, item)
    backup = directory / ORIGINAL_DIRNAME
    if not (backup / "lyrics.json").is_file():
        raise NothingToRevertError("No edits to revert")

    def _restore() -> dict[str, bytes]:
        restored: dict[str, bytes] = {}
        for kind, (filename, _media) in ARTIFACT_SPECS.items():
            source = backup / filename
            if not source.is_file():
                continue
            data = source.read_bytes()
            _atomic_write_bytes(directory / filename, data)
            restored[kind] = data
        return restored

    contents = await asyncio.to_thread(_restore)
    await _sync_file_records(settings, session, item, contents)
    original = json.loads(contents["json"].decode("utf-8"))
    summary = original.get("summary")
    item.summary_json = json.dumps(summary) if summary is not None else None
    item.edited_at = None
    await session.commit()
    await asyncio.to_thread(shutil.rmtree, backup, True)
