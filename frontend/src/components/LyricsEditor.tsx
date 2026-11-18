import { Crosshair, Minus, Play, Plus } from 'lucide-react'
import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  FINE_NUDGE_STEP,
  NUDGE_STEP,
  formatTimestamp,
  nudgeWord,
  retimeLineText,
  setWordTime,
  type LyricsIssue,
  type WordEdge,
  type WordRef,
} from '../lib/lyricsEdit'
import type { LyricsLine } from '../types'

export interface LyricsEditorProps {
  lines: LyricsLine[]
  onChange: (next: LyricsLine[]) => void
  currentTime: number
  onSeek: (seconds: number, autoplay?: boolean) => void
  issues: LyricsIssue[]
  selected: WordRef | null
  onSelect: (ref: WordRef | null) => void
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

function LineTextInput({
  line,
  number,
  onCommit,
}: {
  line: LyricsLine
  number: number
  onCommit: (text: string) => void
}) {
  const [draft, setDraft] = useState<{ source: string; text: string } | null>(null)
  const text = draft && draft.source === line.text ? draft.text : line.text

  const commit = () => {
    if (text !== line.text) {
      onCommit(text)
    }
    setDraft(null)
  }

  return (
    <input
      type="text"
      className="lyrics-editor-text"
      aria-label={`Line ${number} text`}
      value={text}
      onChange={(e) => setDraft({ source: line.text, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
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

export default function LyricsEditor({
  lines,
  onChange,
  currentTime,
  onSeek,
  issues,
  selected,
  onSelect,
}: LyricsEditorProps) {
  const selectedWord = selected ? lines[selected.lineIdx]?.words[selected.wordIdx] : undefined

  const nudge = (edge: WordEdge, direction: 1 | -1) => (e: MouseEvent) => {
    if (!selected) return
    onChange(nudgeWord(lines, selected, edge, direction * stepFor(e)))
  }

  const setTime = (edge: 'start' | 'end', value: number) => {
    if (!selected) return
    onChange(setWordTime(lines, selected, edge, value))
  }

  return (
    <div className="lyrics-editor" aria-label="Lyrics editor">
      {selected && selectedWord && (
        <div className="lyrics-editor-word-tools">
          <div className="lyrics-editor-word-label">
            <strong>“{selectedWord.word}”</strong>
            <span>
              {formatTimestamp(selectedWord.start)} – {formatTimestamp(selectedWord.end)}
            </span>
          </div>

          <div className="lyrics-editor-tool-group" role="group" aria-label="Word start">
            <span>Start</span>
            <button type="button" aria-label="Nudge start earlier" onClick={nudge('start', -1)}>
              <Minus aria-hidden="true" />
            </button>
            <TimeInput
              label="Word start (seconds)"
              value={selectedWord.start}
              onCommit={(v) => setTime('start', v)}
            />
            <button type="button" aria-label="Nudge start later" onClick={nudge('start', 1)}>
              <Plus aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Set start to playhead"
              title="Set start to playhead"
              onClick={() => setTime('start', currentTime)}
            >
              <Crosshair aria-hidden="true" />
            </button>
          </div>

          <div className="lyrics-editor-tool-group" role="group" aria-label="Word end">
            <span>End</span>
            <button type="button" aria-label="Nudge end earlier" onClick={nudge('end', -1)}>
              <Minus aria-hidden="true" />
            </button>
            <TimeInput
              label="Word end (seconds)"
              value={selectedWord.end}
              onCommit={(v) => setTime('end', v)}
            />
            <button type="button" aria-label="Nudge end later" onClick={nudge('end', 1)}>
              <Plus aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Set end to playhead"
              title="Set end to playhead"
              onClick={() => setTime('end', currentTime)}
            >
              <Crosshair aria-hidden="true" />
            </button>
          </div>

          <div className="lyrics-editor-tool-group" role="group" aria-label="Shift word">
            <span>Shift</span>
            <button type="button" aria-label="Shift word earlier" onClick={nudge('both', -1)}>
              <Minus aria-hidden="true" />
            </button>
            <button type="button" aria-label="Shift word later" onClick={nudge('both', 1)}>
              <Plus aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            className="lyrics-editor-play"
            aria-label="Play from word"
            onClick={() => onSeek(selectedWord.start, true)}
          >
            <Play aria-hidden="true" /> Play from word
          </button>
          <p className="lyrics-editor-hint">Hold Shift while nudging for 10 ms steps.</p>
        </div>
      )}

      <details className="lyrics-editor-help">
        <summary>Keyboard shortcuts</summary>
        <table>
          <tbody>
            <tr>
              <th>Space</th>
              <td>Play / pause</td>
            </tr>
            <tr>
              <th>[</th>
              <td>Set selected word start to playhead</td>
            </tr>
            <tr>
              <th>]</th>
              <td>Set selected word end to playhead and advance</td>
            </tr>
            <tr>
              <th>← / →</th>
              <td>Select previous / next word</td>
            </tr>
            <tr>
              <th>Alt+← / Alt+→</th>
              <td>Shift selected word ±50 ms (+Shift for ±10 ms)</td>
            </tr>
            <tr>
              <th>Enter</th>
              <td>Play from selected word</td>
            </tr>
            <tr>
              <th>Ctrl/Cmd+S</th>
              <td>Save changes</td>
            </tr>
            <tr>
              <th>Esc</th>
              <td>Clear word selection</td>
            </tr>
          </tbody>
        </table>
      </details>

      {lines.map((line, lineIdx) => {
        const number = lineIdx + 1
        const lineIssues = issues.filter((i) => i.lineIdx === lineIdx)
        const isActive = currentTime >= line.start && currentTime <= line.end
        return (
          <div
            key={`${line.index}-${lineIdx}`}
            className={`lyrics-editor-line${isActive ? ' active' : ''}${lineIssues.length ? ' has-issue' : ''}`}
          >
            <div className="lyrics-editor-line-head">
              <span className="lyrics-editor-line-number">{number}</span>
              <button
                type="button"
                className="lyrics-editor-line-time"
                onClick={() => onSeek(line.start, false)}
                title="Seek to line start"
              >
                {formatTimestamp(line.start)}–{formatTimestamp(line.end)}
              </button>
              <LineTextInput
                line={line}
                number={number}
                onCommit={(text) =>
                  onChange(lines.map((l, i) => (i === lineIdx ? retimeLineText(l, text) : l)))
                }
              />
            </div>
            {line.words.length > 0 && (
              <div className="lyrics-editor-words">
                {line.words.map((word, wordIdx) => {
                  const isSelected =
                    selected?.lineIdx === lineIdx && selected?.wordIdx === wordIdx
                  const isCurrent = currentTime >= word.start && currentTime <= word.end
                  return (
                    <button
                      key={`${lineIdx}-${wordIdx}`}
                      type="button"
                      className={`lyrics-editor-word${isSelected ? ' selected' : ''}${isCurrent ? ' current' : ''}`}
                      title={`${formatTimestamp(word.start)} – ${formatTimestamp(word.end)}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        onSelect({ lineIdx, wordIdx })
                        onSeek(word.start, false)
                      }}
                    >
                      {word.word}
                    </button>
                  )
                })}
              </div>
            )}
            {lineIssues.map((issue, i) => (
              <p key={i} className="lyrics-editor-issue" role="alert">
                {issue.message}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}
