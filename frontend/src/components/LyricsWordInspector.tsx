import { Crosshair, Minus, Play, Plus, SlidersHorizontal } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import {
  FINE_NUDGE_STEP,
  NUDGE_STEP,
  formatTimestamp,
  nudgeWord,
  setWordTime,
  type WordEdge,
  type WordRef,
} from '../lib/lyricsEdit'
import type { LyricsLine } from '../types'

interface LyricsWordInspectorProps {
  lines: LyricsLine[]
  selected: WordRef | null
  currentTime: number
  onChange: (next: LyricsLine[]) => void
  onSeek: (seconds: number, autoplay?: boolean) => void
}

function stepFor(e: MouseEvent) {
  return e.shiftKey ? FINE_NUDGE_STEP : NUDGE_STEP
}

function TimeInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}) {
  const external = value.toFixed(3)
  const [draft, setDraft] = useState<{ source: string; text: string } | null>(null)
  const text = draft && draft.source === external ? draft.text : external

  const commit = () => {
    const parsed = Number.parseFloat(text)
    setDraft(null)
    if (Number.isFinite(parsed) && parsed !== value) {
      onCommit(parsed)
    }
  }

  return (
    <input
      type="number"
      step="0.01"
      min="0"
      aria-label={label}
      value={text}
      onChange={(e) => setDraft({ source: external, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setDraft(null)
        }
      }}
    />
  )
}

export default function LyricsWordInspector({
  lines,
  selected,
  currentTime,
  onChange,
  onSeek,
}: LyricsWordInspectorProps) {
  const [showExact, setShowExact] = useState(false)
  const selectedWord = selected ? lines[selected.lineIdx]?.words[selected.wordIdx] : undefined

  if (!selected || !selectedWord) {
    return (
      <div className="studio-inspector studio-inspector-empty">
        <span>Select any word above or on the timeline to adjust its start and end times.</span>
      </div>
    )
  }

  const nudge = (edge: WordEdge, direction: 1 | -1) => (e: MouseEvent) => {
    onChange(nudgeWord(lines, selected, edge, direction * stepFor(e)))
  }

  const setTime = (edge: 'start' | 'end', value: number) => {
    onChange(setWordTime(lines, selected, edge, value))
  }

  return (
    <div
      className={`studio-inspector${showExact ? ' show-exact' : ''}`}
      aria-label="Selected word inspector"
    >
      <div className="studio-inspector-word">
        <strong>“{selectedWord.word}”</strong>
        <span>
          {formatTimestamp(selectedWord.start)} – {formatTimestamp(selectedWord.end)}
        </span>
      </div>

      <div className="studio-inspector-controls">
        <div className="lyrics-editor-tool-group" role="group" aria-label="Word start">
          <span>Start</span>
          <button type="button" aria-label="Nudge start earlier" onClick={nudge('start', -1)}>
            <Minus aria-hidden="true" />
          </button>
          <span className="studio-exact-input">
            <TimeInput
              label="Word start (seconds)"
              value={selectedWord.start}
              onCommit={(v) => setTime('start', v)}
            />
          </span>
          <button type="button" aria-label="Nudge start later" onClick={nudge('start', 1)}>
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="studio-stamp-btn"
            aria-label="Set start to playhead"
            title="Set start to playhead ([)"
            onClick={() => setTime('start', currentTime)}
          >
            <Crosshair aria-hidden="true" />
            <span className="studio-mobile-label">Start</span>
          </button>
        </div>

        <div className="lyrics-editor-tool-group" role="group" aria-label="Word end">
          <span>End</span>
          <button type="button" aria-label="Nudge end earlier" onClick={nudge('end', -1)}>
            <Minus aria-hidden="true" />
          </button>
          <span className="studio-exact-input">
            <TimeInput
              label="Word end (seconds)"
              value={selectedWord.end}
              onCommit={(v) => setTime('end', v)}
            />
          </span>
          <button type="button" aria-label="Nudge end later" onClick={nudge('end', 1)}>
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="studio-stamp-btn"
            aria-label="Set end to playhead"
            title="Set end to playhead (])"
            onClick={() => setTime('end', currentTime)}
          >
            <Crosshair aria-hidden="true" />
            <span className="studio-mobile-label">End</span>
          </button>
        </div>

        <div className="lyrics-editor-tool-group studio-shift-group" role="group" aria-label="Shift word">
          <span>Shift</span>
          <button type="button" aria-label="Shift word earlier" onClick={nudge('both', -1)}>
            <Minus aria-hidden="true" />
          </button>
          <button type="button" aria-label="Shift word later" onClick={nudge('both', 1)}>
            <Plus aria-hidden="true" />
          </button>
        </div>

        <div className="studio-inspector-actions">
          <button
            type="button"
            className="lyrics-editor-play"
            aria-label="Play from word"
            onClick={() => onSeek(selectedWord.start, true)}
          >
            <Play aria-hidden="true" /> Play
          </button>
          <button
            type="button"
            className={`lyrics-editor-icon-button studio-exact-toggle${showExact ? ' active' : ''}`}
            aria-label="Exact ms"
            aria-pressed={showExact}
            onClick={() => setShowExact((prev) => !prev)}
          >
            <SlidersHorizontal aria-hidden="true" /> Exact ms
          </button>
        </div>
      </div>
    </div>
  )
}
