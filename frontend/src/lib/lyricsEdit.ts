import type { LyricsDocumentEdit, LyricsLine, LyricsWord } from '../types'

export const MIN_WORD_DURATION = 0.02
export const NUDGE_STEP = 0.05
export const FINE_NUDGE_STEP = 0.01
export const LOOP_PRE_ROLL = 0.25
export const LOOP_POST_ROLL = 0.15
export const PLAYBACK_RATES = [0.5, 0.75, 1] as const
export const ZOOM_WINDOWS = [3, 6, 12] as const
export const COUNTDOWN_SECONDS = 3
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

function cascadeWordBounds(words: LyricsWord[], anchorIdx: number): LyricsWord[] {
  const result = words.map((w) => ({ ...w }))
  for (let i = anchorIdx - 1; i >= 0; i -= 1) {
    const nextStart = result[i + 1].start
    if (result[i].end > nextStart) {
      const end = round3(nextStart)
      const start = round3(Math.min(result[i].start, end - MIN_WORD_DURATION))
      result[i] = { ...result[i], start, end }
    } else {
      break
    }
  }
  for (let i = anchorIdx + 1; i < result.length; i += 1) {
    const prevEnd = result[i - 1].end
    if (result[i].start < prevEnd) {
      const start = round3(prevEnd)
      const end = round3(Math.max(result[i].end, start + MIN_WORD_DURATION))
      result[i] = { ...result[i], start, end }
    } else {
      break
    }
  }
  return result
}

export function setWordTime(
  lines: LyricsLine[],
  ref: WordRef,
  edge: 'start' | 'end',
  value: number,
): LyricsLine[] {
  const line = lines[ref.lineIdx]
  const word = line?.words[ref.wordIdx]
  if (!line || !word) return lines

  const minStart = round3(ref.wordIdx * MIN_WORD_DURATION)
  const words = line.words.map((w) => ({ ...w }))
  if (edge === 'start') {
    const start = round3(Math.max(minStart, value))
    const end = round3(Math.max(word.end, start + MIN_WORD_DURATION))
    words[ref.wordIdx] = { ...word, start, end }
  } else {
    const end = round3(Math.max(value, word.start + MIN_WORD_DURATION))
    words[ref.wordIdx] = { ...word, end }
  }

  const cascaded = cascadeWordBounds(words, ref.wordIdx)
  return lines.map((l, i) =>
    i === ref.lineIdx ? recomputeLineBounds({ ...l, words: cascaded }) : l,
  )
}

export function moveWord(
  lines: LyricsLine[],
  ref: WordRef,
  newStart: number,
): LyricsLine[] {
  const line = lines[ref.lineIdx]
  const word = line?.words[ref.wordIdx]
  if (!line || !word) return lines

  const minStart = round3(ref.wordIdx * MIN_WORD_DURATION)
  const span = round3(Math.max(MIN_WORD_DURATION, word.end - word.start))
  const start = round3(Math.max(minStart, newStart))
  const end = round3(start + span)
  const words = line.words.map((w, i) =>
    i === ref.wordIdx ? { ...w, start, end } : { ...w },
  )
  const cascaded = cascadeWordBounds(words, ref.wordIdx)
  return lines.map((l, i) =>
    i === ref.lineIdx ? recomputeLineBounds({ ...l, words: cascaded }) : l,
  )
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
    return moveWord(lines, ref, word.start + delta)
  }
  return setWordTime(lines, ref, edge, word[edge] + delta)
}

export function wordProgressPct(word: LyricsWord, currentTime: number): number {
  if (currentTime <= word.start) return 0
  if (currentTime >= word.end) return 100
  const span = Math.max(MIN_WORD_DURATION, word.end - word.start)
  return Math.min(100, Math.max(0, ((currentTime - word.start) / span) * 100))
}

export function findActiveLineIndex(lines: LyricsLine[], currentTime: number): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (currentTime >= line.start && currentTime <= line.end) {
      return i
    }
    if (currentTime < line.start) {
      return i > 0 && currentTime - lines[i - 1].end < 1.0 ? i - 1 : i
    }
  }
  return lines.length > 0 ? lines.length - 1 : -1
}

export function getPreRollDelay(lines: LyricsLine[], enabled: boolean): number {
  if (!enabled || lines.length === 0) return 0
  const firstStart = lines[0].start
  if (firstStart >= COUNTDOWN_SECONDS) return 0
  return round3(Math.max(0, COUNTDOWN_SECONDS - firstStart))
}

export function getCountdownBeat(
  lines: LyricsLine[],
  currentTime: number,
  isPlaying: boolean,
  preRollLeft: number | null,
  enabled: boolean,
): 3 | 2 | 1 | null {
  if (!enabled || lines.length === 0) return null
  const firstStart = lines[0].start
  if (preRollLeft !== null) {
    const remaining = firstStart + Math.max(0, preRollLeft)
    if (remaining <= 0) return null
    return Math.min(COUNTDOWN_SECONDS, Math.max(1, Math.ceil(remaining))) as 3 | 2 | 1
  }
  if (!isPlaying) return null
  const remaining = firstStart - currentTime
  if (remaining <= 0 || remaining > COUNTDOWN_SECONDS) return null
  return Math.min(COUNTDOWN_SECONDS, Math.max(1, Math.ceil(remaining))) as 3 | 2 | 1
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
