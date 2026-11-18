import { useCallback, useReducer } from 'react'

export const HISTORY_LIMIT = 200

export interface History<T> {
  past: T[]
  present: T
  future: T[]
}

export type HistoryAction<T> =
  | { type: 'set'; value: T }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T }

export function historyReducer<T>(state: History<T>, action: HistoryAction<T>): History<T> {
  switch (action.type) {
    case 'set': {
      if (action.value === state.present) return state
      const past = [...state.past, state.present].slice(-HISTORY_LIMIT)
      return { past, present: action.value, future: [] }
    }
    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: state.future.slice(1),
      }
    }
    case 'reset':
      return { past: [], present: action.value, future: [] }
  }
}

export function useEditHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(
    historyReducer<T>,
    initial,
    (v): History<T> => ({ past: [], present: v, future: [] }),
  )

  const set = useCallback((value: T) => dispatch({ type: 'set', value }), [])
  const undo = useCallback((): T | undefined => {
    if (state.past.length === 0) return undefined
    const previous = state.past[state.past.length - 1]
    dispatch({ type: 'undo' })
    return previous
  }, [state.past])
  const redo = useCallback((): T | undefined => {
    if (state.future.length === 0) return undefined
    const next = state.future[0]
    dispatch({ type: 'redo' })
    return next
  }, [state.future])
  const reset = useCallback((value: T) => dispatch({ type: 'reset', value }), [])

  return {
    value: state.present,
    set,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}
