import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  isDirty,
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
