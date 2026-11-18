import json

from app.lyrics_archiver import ARTIFACT_SPECS
from app.lyrics_formats import (
    _escape_ass_text,
    _format_ass_timestamp,
    _format_lrc_timestamp,
    format_ass,
    format_lrc,
    format_srt,
    render_all,
)


def _sample_doc() -> dict:
    return {
        "version": 1,
        "title": "Title",
        "model": "large-v3-turbo",
        "summary": {
            "language": "en",
            "line_count": 2,
            "word_count": 3,
            "duration_seconds": 3.0,
            "llm_refined": False,
            "llm_model": None,
            "aligned_with_reference": False,
        },
        "lines": [
            {
                "index": 0,
                "start": 0.2,
                "end": 1.2,
                "text": "Hello world",
                "words": [
                    {"word": "Hello", "start": 0.2, "end": 0.6, "score": 0.9},
                    {"word": "world", "start": 0.7, "end": 1.2, "score": None},
                ],
            },
            {
                "index": 1,
                "start": 2.0,
                "end": 3.0,
                "text": "Plain line",
                "words": [],
            },
        ],
    }


def test_timestamp_helpers_carry_and_escape() -> None:
    assert _format_lrc_timestamp(59.999) == "01:00.00"
    assert _format_lrc_timestamp(59.996) == "01:00.00"
    assert _format_lrc_timestamp(0.0) == "00:00.00"
    assert _format_ass_timestamp(65.5) == "0:01:05.50"
    assert _escape_ass_text("a{b}") == "a\\{b\\}"


def test_format_lrc_word_tags_and_fallback() -> None:
    lrc = format_lrc(_sample_doc())
    assert "[ti:Title]" in lrc
    assert "[la:en]" in lrc
    assert "[00:00.20] <00:00.20>Hello <00:00.70>world" in lrc
    assert "[00:02.00] Plain line" in lrc


def test_format_ass_karaoke_sweep_and_fallback() -> None:
    ass = format_ass(_sample_doc())
    assert "[V4+ Styles]" in ass
    assert "Dialogue: 0,0:00:00.20,0:00:01.20,Karaoke" in ass
    assert "{\\kf40}Hello {\\k10}{\\kf50}world" in ass
    assert ass.rstrip().endswith("karaoke,Plain line")


def test_format_ass_escapes_braces() -> None:
    doc = _sample_doc()
    doc["lines"] = [
        {
            "index": 0,
            "start": 1.0,
            "end": 2.1,
            "text": "Sing {loud}",
            "words": [
                {"word": "Sing", "start": 1.0, "end": 1.4},
                {"word": "{loud}", "start": 1.6, "end": 2.1},
            ],
        }
    ]
    assert "{\\kf40}Sing {\\k20}{\\kf50}\\{loud\\}" in format_ass(doc)


def test_format_srt_lines() -> None:
    srt = format_srt(_sample_doc())
    assert srt.startswith("1\n00:00:00,200 --> 00:00:01,200\nHello world\n")
    assert "2\n00:00:02,000 --> 00:00:03,000\nPlain line\n" in srt


def test_render_all_matches_artifact_specs() -> None:
    rendered = render_all(_sample_doc())
    assert set(rendered) == set(ARTIFACT_SPECS)
    parsed = json.loads(rendered["json"])
    assert parsed["lines"][0]["text"] == "Hello world"
