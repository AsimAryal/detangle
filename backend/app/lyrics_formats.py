"""Render karaoke lyrics documents into synchronized artifact formats.

Ported from Demucster's ``lyrics_formats`` so locally edited lyrics produce the
same output as remotely generated ones. All functions operate on plain ``dict``
documents shaped like ``lyrics.json``::

    {"version": 1, "title": str | None, "model": str, "summary": {...},
     "lines": [{"index", "start", "end", "text", "words": [{"word", "start",
     "end", "score"}]}]}

Formats:
* ``lyrics.json`` — canonical structured document
* ``lyrics.lrc``  — Enhanced LRC with inline ``<mm:ss.xx>`` word timestamps
* ``lyrics.ass``  — Advanced SubStation Alpha with ``\\kf`` sweep tags
* ``lyrics.srt``  — line-level SubRip subtitles
"""

from __future__ import annotations

import json
from typing import Any

LyricsDoc = dict[str, Any]


def _format_lrc_timestamp(seconds: float) -> str:
    """Format *seconds* as ``MM:SS.xx`` with proper centisecond carry."""
    total_cs = max(0, round(seconds * 100))
    minutes, rem_cs = divmod(total_cs, 6000)
    secs, cs = divmod(rem_cs, 100)
    return f"{minutes:02d}:{secs:02d}.{cs:02d}"


def _format_ass_timestamp(seconds: float) -> str:
    """Format *seconds* as ``H:MM:SS.cc`` for ASS dialogue events."""
    total_cs = max(0, round(seconds * 100))
    hours, rem_cs = divmod(total_cs, 360_000)
    minutes, rem_cs = divmod(rem_cs, 6000)
    secs, cs = divmod(rem_cs, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _format_srt_timestamp(seconds: float) -> str:
    """Format *seconds* as ``HH:MM:SS,mmm`` for SubRip subtitles."""
    total_ms = max(0, round(seconds * 1000))
    hours, rem_ms = divmod(total_ms, 3_600_000)
    minutes, rem_ms = divmod(rem_ms, 60_000)
    secs, ms = divmod(rem_ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _escape_ass_text(text: str) -> str:
    """Escape characters that carry special meaning in ASS override blocks."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _lines(document: LyricsDoc) -> list[dict[str, Any]]:
    return list(document.get("lines") or [])


def _words(line: dict[str, Any]) -> list[dict[str, Any]]:
    return list(line.get("words") or [])


def format_lrc(document: LyricsDoc) -> str:
    """Render *document* as Enhanced LRC with inline word timestamps."""
    rows: list[str] = []
    title = document.get("title")
    language = (document.get("summary") or {}).get("language")
    if title:
        rows.append(f"[ti:{title}]")
    if language:
        rows.append(f"[la:{language}]")
    rows.append("[re:Demucster]")

    for line in _lines(document):
        line_tag = f"[{_format_lrc_timestamp(float(line['start']))}]"
        words = _words(line)
        if words:
            parts = [
                f"<{_format_lrc_timestamp(float(w['start']))}>{w['word']}" for w in words
            ]
            rows.append(f"{line_tag} {' '.join(parts)}")
        else:
            rows.append(f"{line_tag} {line.get('text', '')}")

    return "\n".join(rows) + ("\n" if rows else "")


def format_ass(document: LyricsDoc) -> str:
    """Render *document* as ASS subtitles with ``\\kf`` progressive karaoke sweep."""
    title = (document.get("title") or "Demucster Karaoke").replace("\n", " ").strip()
    header = [
        "[Script Info]",
        f"Title: {title}",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            "Style: Karaoke,Arial,64,&H005BE4D6,&H00FFFFFF,&H00121826,&H80000000,"
            "-1,0,0,0,100,100,0,0,1,3,2,2,80,80,90,1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    events: list[str] = []
    for line in _lines(document):
        line_start = float(line["start"])
        line_end = float(line["end"])
        start_str = _format_ass_timestamp(line_start)
        end_str = _format_ass_timestamp(max(line_end, line_start + 0.1))
        words = _words(line)
        if not words:
            text_payload = _escape_ass_text(str(line.get("text", "")))
        else:
            cursor_cs = round(line_start * 100)
            chunks: list[str] = []
            for idx, word in enumerate(words):
                word_start_cs = round(float(word["start"]) * 100)
                word_end_cs = max(word_start_cs + 2, round(float(word["end"]) * 100))
                gap_cs = word_start_cs - cursor_cs
                if gap_cs > 0:
                    chunks.append(f"{{\\k{gap_cs}}}")
                dur_cs = word_end_cs - word_start_cs
                suffix = " " if idx < len(words) - 1 else ""
                chunks.append(
                    f"{{\\kf{dur_cs}}}{_escape_ass_text(str(word['word']))}{suffix}"
                )
                cursor_cs = word_end_cs
            text_payload = "".join(chunks)

        events.append(
            f"Dialogue: 0,{start_str},{end_str},Karaoke,,0,0,0,karaoke,{text_payload}"
        )

    return "\n".join([*header, *events]) + "\n"


def format_srt(document: LyricsDoc) -> str:
    """Render *document* as line-level SubRip (``.srt``) subtitles."""
    blocks: list[str] = []
    for idx, line in enumerate(_lines(document), start=1):
        line_start = float(line["start"])
        start_str = _format_srt_timestamp(line_start)
        end_str = _format_srt_timestamp(max(float(line["end"]), line_start + 0.1))
        blocks.append(f"{idx}\n{start_str} --> {end_str}\n{line.get('text', '')}\n")
    return "\n".join(blocks)


def format_json(document: LyricsDoc) -> str:
    """Render *document* as pretty-printed UTF-8 JSON."""
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def render_all(document: LyricsDoc) -> dict[str, str]:
    """Render every artifact kind; keys match ``ARTIFACT_SPECS``."""
    return {
        "json": format_json(document),
        "lrc": format_lrc(document),
        "ass": format_ass(document),
        "srt": format_srt(document),
    }
