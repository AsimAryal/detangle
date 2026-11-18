import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  getCountdownBeat,
  getPreRollDelay,
  isDirty,
  moveWord,
  nextWordRef,
  nudgeWord,
  retimeLineText,
  setWordTime,
  toSavePayload,
  validateLines,
} from '../lib/lyricsEdit'
import type { LyricsLine } from '../types'

function sampleLines(): LyricsLine[] {
  return [
    {
      index: 0,
      start: 0.5,
      end: 1.5,
      text: 'Sing along',
      words: [
        { word: 'Sing', start: 0.5, end: 0.9, score: 0.9 },
        { word: 'along', start: 1.0, end: 1.5 },
      ],
    },
    { index: 1, start: 2.0, end: 2.5, text: 'Instrumental', words: [] },
    {
      index: 2,
      start: 3.0,
      end: 4.0,
      text: 'Next line',
      words: [
        { word: 'Next', start: 3.0, end: 3.4 },
        { word: 'line', start: 3.5, end: 4.0 },
      ],
    },
  ]
}

describe('formatTimestamp', () => {
  it('formats minutes, seconds, centiseconds', () => {
    expect(formatTimestamp(72.345)).toBe('1:12.35')
    expect(formatTimestamp(0)).toBe('0:00.00')
    expect(formatTimestamp(-3)).toBe('0:00.00')
  })
})

describe('retimeLineText', () => {
  it('keeps timings when word count is unchanged', () => {
    const line = retimeLineText(sampleLines()[0], 'Sing loud')
    expect(line.text).toBe('Sing loud')
    expect(line.words[1]).toMatchObject({ word: 'loud', start: 1.0, end: 1.5 })
    expect(line.words[0].score).toBe(0.9)
  })

  it('spreads words across the line span when count changes', () => {
    const line = retimeLineText(sampleLines()[0], 'Sing along with me')
    expect(line.words).toHaveLength(4)
    expect(line.start).toBe(0.5)
    expect(line.end).toBe(1.5)
    for (let i = 1; i < line.words.length; i += 1) {
      expect(line.words[i].start).toBeGreaterThanOrEqual(line.words[i - 1].end)
      expect(line.words[i].end).toBeGreaterThan(line.words[i].start)
    }
    expect(line.words[0].score).toBeUndefined()
  })

  it('clears words for empty text', () => {
    const line = retimeLineText(sampleLines()[0], '   ')
    expect(line.text).toBe('')
    expect(line.words).toEqual([])
  })

  it('updates text-only lines', () => {
    expect(retimeLineText(sampleLines()[1], '  Solo  break ').text).toBe('Solo break')
  })
})

describe('setWordTime / nudgeWord', () => {
  it('enforces min duration and recomputes line bounds', () => {
    const lines = sampleLines()
    const next = setWordTime(lines, { lineIdx: 0, wordIdx: 0 }, 'start', 0.95)
    expect(next[0].words[0]).toMatchObject({ start: 0.95, end: 0.97 })
    expect(next[0].start).toBe(0.95)
    const ended = setWordTime(lines, { lineIdx: 0, wordIdx: 1 }, 'end', 0.2)
    expect(ended[0].words[1].end).toBe(1.02)
    expect(ended[0].end).toBe(1.02)
    // input untouched
    expect(lines[0].words[0].start).toBe(0.5)
  })

  it('shifts whole word and clamps at zero', () => {
    const lines = sampleLines()
    const shifted = nudgeWord(lines, { lineIdx: 0, wordIdx: 0 }, 'both', -1)
    expect(shifted[0].words[0]).toMatchObject({ start: 0, end: 0.4 })
    const later = nudgeWord(lines, { lineIdx: 0, wordIdx: 1 }, 'start', 0.05)
    expect(later[0].words[1].start).toBe(1.05)
  })

  it('magnetically pushes neighboring words to prevent overlaps', () => {
    const line: LyricsLine = {
      index: 0,
      start: 0.5,
      end: 2.0,
      text: 'One two three',
      words: [
        { word: 'One', start: 0.5, end: 0.9 },
        { word: 'two', start: 1.0, end: 1.3 },
        { word: 'three', start: 1.35, end: 2.0 },
      ],
    }

    // Extending One past two and three cascades smoothly down to 20ms min width
    const pushedRight = setWordTime([line], { lineIdx: 0, wordIdx: 0 }, 'end', 1.4)
    expect(pushedRight[0].words[0]).toMatchObject({ start: 0.5, end: 1.4 })
    expect(pushedRight[0].words[1]).toMatchObject({ start: 1.4, end: 1.42 })
    expect(pushedRight[0].words[2]).toMatchObject({ start: 1.42, end: 2.0 })
    expect(validateLines(pushedRight)).toEqual([])

    // Pulling three left pushes two's end earlier
    const pulledLeft = setWordTime([line], { lineIdx: 0, wordIdx: 2 }, 'start', 1.1)
    expect(pulledLeft[0].words[1]).toMatchObject({ start: 1.0, end: 1.1 })
    expect(pulledLeft[0].words[2]).toMatchObject({ start: 1.1, end: 2.0 })
    expect(validateLines(pulledLeft)).toEqual([])

    // Moving a word body pushes neighbors without shrinking the moved word
    const moved = moveWord([line], { lineIdx: 0, wordIdx: 1 }, 0.7)
    expect(moved[0].words[0]).toMatchObject({ start: 0.5, end: 0.7 })
    expect(moved[0].words[1]).toMatchObject({ start: 0.7, end: 1.0 })
    expect(validateLines(moved)).toEqual([])
  })
})

describe('nextWordRef', () => {
  it('crosses lines and skips lines without words', () => {
    const lines = sampleLines()
    expect(nextWordRef(lines, null, 1)).toEqual({ lineIdx: 0, wordIdx: 0 })
    expect(nextWordRef(lines, { lineIdx: 0, wordIdx: 1 }, 1)).toEqual({ lineIdx: 2, wordIdx: 0 })
    expect(nextWordRef(lines, { lineIdx: 2, wordIdx: 0 }, -1)).toEqual({ lineIdx: 0, wordIdx: 1 })
    expect(nextWordRef(lines, { lineIdx: 2, wordIdx: 1 }, 1)).toEqual({ lineIdx: 2, wordIdx: 1 })
    expect(nextWordRef([], null, 1)).toBeNull()
  })
})

describe('validateLines', () => {
  it('accepts valid lines', () => {
    expect(validateLines(sampleLines())).toEqual([])
  })

  it('flags overlap and ordering', () => {
    const lines = sampleLines()
    lines[0].words[1] = { word: 'along', start: 0.8, end: 1.5 }
    lines[2].words[0] = { word: 'Next', start: 1.0, end: 3.4 }
    const issues = validateLines(lines)
    expect(issues.map((i) => i.message)).toEqual([
      'Line 1, word 2 overlaps the previous word',
      'Line 3 starts before line 2',
    ])
  })
})

describe('isDirty / toSavePayload', () => {
  it('detects changes', () => {
    const lines = sampleLines()
    expect(isDirty(lines, structuredClone(lines))).toBe(false)
    expect(isDirty(lines, nudgeWord(lines, { lineIdx: 0, wordIdx: 0 }, 'both', 0.05))).toBe(true)
  })

  it('builds the API payload', () => {
    const payload = toSavePayload(sampleLines())
    expect(payload.lines[0]).toEqual({
      text: 'Sing along',
      start: 0.5,
      end: 1.5,
      words: [
        { word: 'Sing', start: 0.5, end: 0.9, score: 0.9 },
        { word: 'along', start: 1.0, end: 1.5, score: null },
      ],
    })
  })
})

describe('countdown helpers', () => {
  it('computes pre-roll delay only when lyrics begin before 3 seconds', () => {
    const atZero: LyricsLine[] = [{ index: 0, start: 0, end: 1, text: 'Go', words: [] }]
    const atHalf: LyricsLine[] = [{ index: 0, start: 0.5, end: 1.5, text: 'Go', words: [] }]
    const intro: LyricsLine[] = [{ index: 0, start: 5.0, end: 6.0, text: 'Go', words: [] }]

    expect(getPreRollDelay(atZero, true)).toBe(3)
    expect(getPreRollDelay(atHalf, true)).toBe(2.5)
    expect(getPreRollDelay(intro, true)).toBe(0)
    expect(getPreRollDelay(atZero, false)).toBe(0)
  })

  it('returns 3 -> 2 -> 1 beats across pre-roll and instrumental intros', () => {
    const atHalf: LyricsLine[] = [{ index: 0, start: 0.5, end: 1.5, text: 'Go', words: [] }]
    expect(getCountdownBeat(atHalf, 0, false, 2.5, true)).toBe(3)
    expect(getCountdownBeat(atHalf, 0, false, 1.4, true)).toBe(2)
    expect(getCountdownBeat(atHalf, 0, false, 0.4, true)).toBe(1)
    expect(getCountdownBeat(atHalf, 0.1, true, null, true)).toBe(1)
    expect(getCountdownBeat(atHalf, 0.5, true, null, true)).toBeNull()

    const intro: LyricsLine[] = [{ index: 0, start: 6.0, end: 7.0, text: 'Go', words: [] }]
    expect(getCountdownBeat(intro, 2.5, true, null, true)).toBeNull()
    expect(getCountdownBeat(intro, 3.0, true, null, true)).toBe(3)
    expect(getCountdownBeat(intro, 4.5, true, null, true)).toBe(2)
    expect(getCountdownBeat(intro, 5.2, true, null, true)).toBe(1)
    expect(getCountdownBeat(intro, 6.0, true, null, true)).toBeNull()
    expect(getCountdownBeat(intro, 4.5, true, null, false)).toBeNull()
  })
})
