import { Repeat } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import {
  formatTimestamp,
  retimeLineText,
  type LyricsIssue,
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
  loopLineIdx: number | null
  onToggleLoop: (lineIdx: number) => void
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
  loopLineIdx,
  onToggleLoop,
}: LyricsEditorProps) {
  return (
    <div className="lyrics-editor" aria-label="Lyrics lines">

      {lines.map((line, lineIdx) => {
        const number = lineIdx + 1
        const lineIssues = issues.filter((i) => i.lineIdx === lineIdx)
        const isActive = currentTime >= line.start && currentTime <= line.end
        const isLooping = loopLineIdx === lineIdx
        return (
          <div
            key={`${line.index}-${lineIdx}`}
            className={`lyrics-editor-line${isActive ? ' active' : ''}${isLooping ? ' looping' : ''}${lineIssues.length ? ' has-issue' : ''}`}
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
              <button
                type="button"
                className={`lyrics-editor-icon-button${isLooping ? ' active' : ''}`}
                aria-label={`Loop line ${number}`}
                aria-pressed={isLooping}
                title={isLooping ? `Stop looping line ${number}` : `Loop line ${number}`}
                onClick={() => onToggleLoop(lineIdx)}
              >
                <Repeat aria-hidden="true" />
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
