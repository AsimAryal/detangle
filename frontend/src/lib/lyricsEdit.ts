import type { LyricsDocumentEdit, LyricsLine, LyricsWord } from '../types'

export const MIN_WORD_DURATION = 0.02
export const NUDGE_STEP = 0.05
export const FINE_NUDGE_STEP = 0.01
export const LOOP_PRE_ROLL = 0.25
export const LOOP_POST_ROLL = 0.15
export const PLAYBACK_RATES = [0.5, 0.75, 1] as const
const TIME_TOLERANCE = 0.001

export type WordEdge = 'start' | 'end' | 'both'

export interface WordRef {
  lineIdx: number
  wordIdx: number
}

export interface LyricsIssue {
  lineIdx: number
  wordIdx?: number
  message: string
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Format seconds as `m:ss.cc` (e.g. 72.345 -> "1:12.35"). */
export function formatTimestamp(sec: number): string {
  const totalCs = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 100))
  const minutes = Math.floor(totalCs / 6000)
  const secs = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function recomputeLineBounds(line: LyricsLine): LyricsLine {
  if (line.words.length === 0) return line
  return {
    ...line,
    start: line.words[0].start,
    end: line.words[line.words.length - 1].end,
    text: line.words.map((w) => w.word).join(' '),
  }
}

export function retimeLineText(line: LyricsLine, newText: string): LyricsLine {
  const tokens = newText.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return { ...line, text: '', words: [] }
  }
  if (line.words.length === 0) {
    return { ...line, text: tokens.join(' ') }
  }
  if (tokens.length === line.words.length) {
    return recomputeLineBounds({
      ...line,
      words: line.words.map((w, i) => ({ ...w, word: tokens[i] })),
    })
  }

  const span = Math.max(line.end - line.start, tokens.length * MIN_WORD_DURATION)
  const totalChars = tokens.reduce((sum, t) => sum + t.length, 0)
  const lineEnd = round3(line.start + span)
  const words: LyricsWord[] = []
  let cursor = line.start
  tokens.forEach((token, i) => {
    const remaining = tokens.length - i - 1
    let end =
      i === tokens.length - 1
        ? lineEnd
        : cursor + Math.max(MIN_WORD_DURATION, (span * token.length) / totalChars)
    // keep room for the remaining words
    end = Math.min(end, lineEnd - remaining * MIN_WORD_DURATION)
    end = Math.max(end, cursor + MIN_WORD_DURATION)
    words.push({ word: token, start: round3(cursor), end: round3(end) })
    cursor = end
  })
  return recomputeLineBounds({ ...line, words })
}

function updateWord(
  lines: LyricsLine[],
  ref: WordRef,
  fn: (word: LyricsWord) => LyricsWord,
): LyricsLine[] {
  const line = lines[ref.lineIdx]
  if (!line || !line.words[ref.wordIdx]) return lines
  const words = line.words.map((w, i) => (i === ref.wordIdx ? fn(w) : w))
  return lines.map((l, i) => (i === ref.lineIdx ? recomputeLineBounds({ ...l, words }) : l))
}

export function setWordTime(
  lines: LyricsLine[],
  ref: WordRef,
  edge: 'start' | 'end',
  value: number,
): LyricsLine[] {
  const v = round3(Math.max(0, value))
  return updateWord(lines, ref, (w) => {
    if (edge === 'start') {
      return { ...w, start: v, end: round3(Math.max(w.end, v + MIN_WORD_DURATION)) }
    }
    return { ...w, end: round3(Math.max(v, w.start + MIN_WORD_DURATION)) }
  })
}

export function nudgeWord(
  lines: LyricsLine[],
  ref: WordRef,
  edge: WordEdge,
  delta: number,
): LyricsLine[] {
  const word = lines[ref.lineIdx]?.words[ref.wordIdx]
  if (!word) return lines
  if (edge === 'both') {
    const shift = Math.max(delta, -word.start)
    return updateWord(lines, ref, (w) => ({
      ...w,
      start: round3(w.start + shift),
      end: round3(w.end + shift),
    }))
  }
  return setWordTime(lines, ref, edge, word[edge] + delta)
}

export function nextWordRef(
  lines: LyricsLine[],
  ref: WordRef | null,
  dir: 1 | -1,
): WordRef | null {
  const flat: WordRef[] = []
  lines.forEach((line, lineIdx) =>
    line.words.forEach((_, wordIdx) => flat.push({ lineIdx, wordIdx })),
  )
  if (flat.length === 0) return null
  if (!ref) return dir === 1 ? flat[0] : flat[flat.length - 1]
  const pos = flat.findIndex((r) => r.lineIdx === ref.lineIdx && r.wordIdx === ref.wordIdx)
  if (pos === -1) return flat[0]
  const next = Math.min(flat.length - 1, Math.max(0, pos + dir))
  return flat[next]
}

export function validateLines(lines: LyricsLine[]): LyricsIssue[] {
  const issues: LyricsIssue[] = []
  let prevLineStart: number | null = null
  let prevLineNumber = 0
  lines.forEach((line, lineIdx) => {
    const li = lineIdx + 1
    let prevEnd: number | null = null
    let lineStart: number | null = null
    line.words.forEach((word, wordIdx) => {
      const wi = wordIdx + 1
      if (!word.word.trim()) return
      if (lineStart === null) lineStart = word.start
      if (word.end <= word.start) {
        issues.push({ lineIdx, wordIdx, message: `Line ${li}, word ${wi}: end must be after start` })
      }
      if (prevEnd !== null && word.start < prevEnd - TIME_TOLERANCE) {
        issues.push({ lineIdx, wordIdx, message: `Line ${li}, word ${wi} overlaps the previous word` })
      }
      prevEnd = word.end
    })
    if (lineStart === null) {
      if (!line.text.trim()) return
      lineStart = line.start
      if (line.end <= line.start) {
        issues.push({ lineIdx, message: `Line ${li}: end must be after start` })
      }
    }
    if (prevLineStart !== null && lineStart < prevLineStart - TIME_TOLERANCE) {
      issues.push({ lineIdx, message: `Line ${li} starts before line ${prevLineNumber}` })
    }
    prevLineStart = lineStart
    prevLineNumber = li
  })
  return issues
}

export function toSavePayload(lines: LyricsLine[]): LyricsDocumentEdit {
  return {
    lines: lines.map((line) => ({
      text: line.text,
      start: line.start,
      end: line.end,
      words: line.words.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        score: w.score ?? null,
      })),
    })),
  }
}

export function isDirty(a: LyricsLine[], b: LyricsLine[]): boolean {
  return JSON.stringify(toSavePayload(a)) !== JSON.stringify(toSavePayload(b))
}
