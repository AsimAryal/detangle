import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, historyReducer, type History } from '../lib/editHistory'

function init<T>(value: T): History<T> {
  return { past: [], present: value, future: [] }
}

describe('historyReducer', () => {
  it('supports set, undo, and redo round-trip', () => {
    let state = init('a')
    state = historyReducer(state, { type: 'set', value: 'b' })
    state = historyReducer(state, { type: 'set', value: 'c' })
    expect(state).toEqual({ past: ['a', 'b'], present: 'c', future: [] })

    state = historyReducer(state, { type: 'undo' })
    expect(state).toEqual({ past: ['a'], present: 'b', future: ['c'] })

    state = historyReducer(state, { type: 'redo' })
    expect(state).toEqual({ past: ['a', 'b'], present: 'c', future: [] })
  })

  it('clears future when setting after undo', () => {
    let state = init(1)
    state = historyReducer(state, { type: 'set', value: 2 })
    state = historyReducer(state, { type: 'set', value: 3 })
    state = historyReducer(state, { type: 'undo' })
    state = historyReducer(state, { type: 'set', value: 4 })
    expect(state).toEqual({ past: [1, 2], present: 4, future: [] })
  })

  it('treats undo on empty past and redo on empty future as no-ops', () => {
    const start = init('x')
    expect(historyReducer(start, { type: 'undo' })).toBe(start)
    expect(historyReducer(start, { type: 'redo' })).toBe(start)
  })

  it('trims past to HISTORY_LIMIT', () => {
    let state = init(0)
    for (let i = 1; i <= HISTORY_LIMIT + 15; i += 1) {
      state = historyReducer(state, { type: 'set', value: i })
    }
    expect(state.past).toHaveLength(HISTORY_LIMIT)
    expect(state.past[0]).toBe(15)
    expect(state.present).toBe(HISTORY_LIMIT + 15)
  })

  it('clears past and future on reset', () => {
    let state = init('a')
    state = historyReducer(state, { type: 'set', value: 'b' })
    state = historyReducer(state, { type: 'undo' })
    state = historyReducer(state, { type: 'reset', value: 'fresh' })
    expect(state).toEqual({ past: [], present: 'fresh', future: [] })
  })

  it('ignores set when value is reference-equal to present', () => {
    const obj = { count: 1 }
    const state = init(obj)
    expect(historyReducer(state, { type: 'set', value: obj })).toBe(state)
  })
})
