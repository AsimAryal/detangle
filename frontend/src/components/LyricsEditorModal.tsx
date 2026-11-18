import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Keyboard,
  Pause,
  Play,
  Redo2,
  Save,
  Undo2,
  Volume2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useEditHistory } from '../lib/editHistory'
import {
  FINE_NUDGE_STEP,
  LOOP_POST_ROLL,
  LOOP_PRE_ROLL,
  NUDGE_STEP,
  PLAYBACK_RATES,
  findActiveLineIndex,
  isDirty,
  nextWordRef,
  nudgeWord,
  setWordTime,
  toSavePayload,
  validateLines,
  wordProgressPct,
  type WordRef,
} from '../lib/lyricsEdit'
import { getCachedWaveform, loadWaveform, type WaveformData } from '../lib/waveform'
import type { Job, LyricsLine, Stem } from '../types'
import LyricsEditor from './LyricsEditor'
import LyricsTimeline from './LyricsTimeline'
import LyricsWordInspector from './LyricsWordInspector'
import {
  Badge,
  Button,
  ConfirmDialog,
  Modal,
  formatStemLabel,
  useToast,
} from './ui'

export interface LyricsEditorModalProps {
  job: Job
  lyricsId: string
  initialLines: LyricsLine[]
  docDuration: number
  playableStems: Stem[]
  stemMediaUrl: (jobId: string, stem: Stem) => string
  onClose: () => void
}

function pickEditorStem(stems: Stem[]): Stem | undefined {
  const priority = ['vocals', 'original', 'no_vocals']
  for (const name of priority) {
    const match = stems.find((s) => s.name === name)
    if (match) return match
  }
  return stems[0]
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function wrapLoopPlayback(
  audio: HTMLAudioElement,
  sourceLines: LyricsLine[],
  idx: number | null,
) {
  if (idx === null) return
  const target = sourceLines[idx]
  if (!target) return
  if (audio.currentTime >= target.end + LOOP_POST_ROLL) {
    audio.currentTime = Math.max(0, target.start - LOOP_PRE_ROLL)
  }
}

function seekAudio(
  audio: HTMLAudioElement | null,
  onTime: (time: number) => void,
  seconds: number,
  autoplay = false,
) {
  if (!audio) return
  audio.currentTime = Math.max(0, seconds)
  onTime(audio.currentTime)
  if (autoplay && audio.paused) {
    void audio.play().catch(() => {})
  }
}

export default function LyricsEditorModal({
  job,
  lyricsId,
  initialLines,
  docDuration,
  playableStems,
  stemMediaUrl,
  onClose,
}: LyricsEditorModalProps) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const defaultStem = useMemo(() => pickEditorStem(playableStems), [playableStems])
  const [selectedStemName, setSelectedStemName] = useState<string>(
    defaultStem?.name || '',
  )
  const activeStem =
    playableStems.find((s) => s.name === selectedStemName) || defaultStem

  const waveformStem = useMemo(
    () =>
      playableStems.find((s) => s.name === 'vocals') ??
      playableStems.find((s) => s.name === 'original') ??
      defaultStem,
    [defaultStem, playableStems],
  )
  const waveformUrl = waveformStem ? stemMediaUrl(job.id, waveformStem) : null

  const [waveformState, setWaveformState] = useState<{
    url: string | null
    data: WaveformData | null
  }>(() => ({
    url: waveformUrl,
    data: waveformUrl ? getCachedWaveform(waveformUrl) : null,
  }))
  const [waveformLoading, setWaveformLoading] = useState(false)

  useEffect(() => {
    if (!waveformUrl || getCachedWaveform(waveformUrl)) return undefined
    const controller = new AbortController()
    let active = true
    Promise.resolve()
      .then(() => {
        if (active) setWaveformLoading(true)
        return loadWaveform(waveformUrl, controller.signal)
      })
      .then((data) => {
        if (active) setWaveformState({ url: waveformUrl, data })
      })
      .catch(() => {})
      .finally(() => {
        if (active) setWaveformLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [waveformUrl])

  const waveform =
    waveformState.url === waveformUrl
      ? waveformState.data
      : waveformUrl
        ? getCachedWaveform(waveformUrl)
        : null

  const [baseline, setBaseline] = useState<LyricsLine[]>(() =>
    structuredClone(initialLines),
  )
  const {
    value: committedDraft,
    set: setCommittedDraft,
    undo: undoDraft,
    redo: redoDraft,
    canUndo,
    canRedo,
  } = useEditHistory<LyricsLine[]>(initialLines)
  const [dragPreview, setDragPreview] = useState<LyricsLine[] | null>(null)
  const draft = dragPreview ?? committedDraft

  const [selected, setSelected] = useState<WordRef | null>(null)
  const [loopLineIdx, setLoopLineIdx] = useState<number | null>(null)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

  const audioRef = useRef<HTMLAudioElement>(null)
  const pendingSeekRef = useRef<{ time: number; autoplay: boolean } | null>(null)

  const activeLoopLineIdx =
    loopLineIdx !== null && loopLineIdx < draft.length ? loopLineIdx : null

  const dirty = useMemo(() => isDirty(baseline, draft), [baseline, draft])
  const issues = useMemo(() => validateLines(draft), [draft])
  const lastLineEnd = draft.length > 0 ? draft[draft.length - 1].end : 0
  const effectiveDuration = Math.max(
    audioDuration,
    waveform?.duration ?? 0,
    docDuration,
    lastLineEnd,
    1,
  )

  useEffect(() => {
    if (!isPlaying) return undefined
    let frameId = 0
    const tick = () => {
      const audio = audioRef.current
      if (audio) {
        wrapLoopPlayback(audio, draft, activeLoopLineIdx)
        setCurrentTime(audio.currentTime)
      }
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [isPlaying, draft, activeLoopLineIdx])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate
    }
  }, [playbackRate, activeStem?.name])

  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const save = useMutation({
    mutationFn: (next: LyricsLine[]) =>
      api.saveLyricsDocument(job.id, lyricsId, toSavePayload(next)),
    onSuccess: (_data, savedLines) => {
      setBaseline(structuredClone(savedLines))
      void queryClient.invalidateQueries({ queryKey: ['lyrics', job.id] })
      void queryClient.invalidateQueries({ queryKey: ['lyrics-doc', job.id, lyricsId] })
      toast.show('Lyrics saved.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const canSave = dirty && issues.length === 0 && !save.isPending

  const seekTo = (seconds: number, autoplay = false) => {
    seekAudio(audioRef.current, setCurrentTime, seconds, autoplay)
  }

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      void audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  const switchTrack = (nextStemName: string) => {
    if (nextStemName === activeStem?.name) return
    const audio = audioRef.current
    if (audio) {
      pendingSeekRef.current = {
        time: audio.currentTime || currentTime,
        autoplay: !audio.paused,
      }
    }
    setSelectedStemName(nextStemName)
  }

  const handleUndo = () => {
    const next = undoDraft()
    if (next && selected && !next[selected.lineIdx]?.words[selected.wordIdx]) {
      setSelected(null)
    }
  }

  const handleRedo = () => {
    const next = redoDraft()
    if (next && selected && !next[selected.lineIdx]?.words[selected.wordIdx]) {
      setSelected(null)
    }
  }

  const toggleLoop = (lineIdx: number) => {
    if (activeLoopLineIdx === lineIdx) {
      setLoopLineIdx(null)
      return
    }
    const target = draft[lineIdx]
    setLoopLineIdx(lineIdx)
    if (target) {
      seekAudio(
        audioRef.current,
        setCurrentTime,
        Math.max(0, target.start - LOOP_PRE_ROLL),
        true,
      )
    }
  }

  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true)
    } else {
      onClose()
    }
  }

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (confirmDiscard) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (canSave) save.mutate(draft)
        return
      }
      if (isEditableTarget(e.target)) return

      if (mod && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          const next = undoDraft()
          if (next && selected && !next[selected.lineIdx]?.words[selected.wordIdx]) {
            setSelected(null)
          }
          return
        }
        if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) {
          e.preventDefault()
          const next = redoDraft()
          if (next && selected && !next[selected.lineIdx]?.words[selected.wordIdx]) {
            setSelected(null)
          }
          return
        }
      }

      const playhead = audioRef.current?.currentTime ?? 0
      const selectedWord = selected
        ? draft[selected.lineIdx]?.words[selected.wordIdx]
        : undefined

      if (e.key === ' ' && !mod && !e.altKey) {
        e.preventDefault()
        const audio = audioRef.current
        if (!audio) return
        if (audio.paused) {
          void audio.play().catch(() => {})
        } else {
          audio.pause()
        }
        return
      }

      if ((e.key === '[' || e.key === ']') && !mod && !e.altKey) {
        e.preventDefault()
        if (!selected || !selectedWord) {
          const first = nextWordRef(draft, null, 1)
          if (first) setSelected(first)
          return
        }
        if (e.key === '[') {
          setCommittedDraft(setWordTime(draft, selected, 'start', playhead))
        } else {
          const next = setWordTime(draft, selected, 'end', playhead)
          setCommittedDraft(next)
          setSelected(nextWordRef(next, selected, 1))
        }
        return
      }

      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod) {
        const dir: 1 | -1 = e.key === 'ArrowRight' ? 1 : -1
        if (e.altKey) {
          e.preventDefault()
          if (!selected || !selectedWord) return
          const step = e.shiftKey ? FINE_NUDGE_STEP : NUDGE_STEP
          setCommittedDraft(nudgeWord(draft, selected, 'both', dir * step))
          return
        }
        if (!e.shiftKey) {
          e.preventDefault()
          if (!selected) {
            const first = nextWordRef(draft, null, 1)
            if (first) setSelected(first)
          } else {
            setSelected(nextWordRef(draft, selected, dir))
          }
        }
        return
      }

      if (e.key.toLowerCase() === 'l' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        const idx = selected ? selected.lineIdx : findActiveLineIndex(draft, playhead)
        if (idx >= 0 && idx < draft.length) {
          if (activeLoopLineIdx === idx) {
            setLoopLineIdx(null)
          } else {
            const target = draft[idx]
            setLoopLineIdx(idx)
            if (target) {
              seekAudio(
                audioRef.current,
                setCurrentTime,
                Math.max(0, target.start - LOOP_PRE_ROLL),
                true,
              )
            }
          }
        }
        return
      }

      if (!mod && !e.altKey && (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+')) {
        e.preventDefault()
        const curIdx = PLAYBACK_RATES.indexOf(
          playbackRate as (typeof PLAYBACK_RATES)[number],
        )
        const baseIdx = curIdx === -1 ? PLAYBACK_RATES.length - 1 : curIdx
        const nextIdx =
          e.key === '-' || e.key === '_'
            ? Math.max(0, baseIdx - 1)
            : Math.min(PLAYBACK_RATES.length - 1, baseIdx + 1)
        setPlaybackRate(PLAYBACK_RATES[nextIdx])
        return
      }

      if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
        if (
          e.target instanceof HTMLElement &&
          (e.target.tagName === 'SUMMARY' ||
            (e.target.tagName === 'BUTTON' &&
              !e.target.classList.contains('lyrics-editor-word')))
        ) {
          return
        }
        if (!selectedWord) return
        e.preventDefault()
        seekAudio(audioRef.current, setCurrentTime, selectedWord.start, true)
        return
      }

      if (e.key === 'Escape' && !mod && !e.altKey) {
        if (showShortcuts) {
          e.preventDefault()
          setShowShortcuts(false)
        } else if (selected) {
          e.preventDefault()
          setSelected(null)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    draft,
    selected,
    canSave,
    confirmDiscard,
    showShortcuts,
    save,
    setCommittedDraft,
    undoDraft,
    redoDraft,
    activeLoopLineIdx,
    playbackRate,
  ])

  const activeLineIdx = findActiveLineIndex(draft, currentTime)
  const previewLine = activeLineIdx >= 0 ? draft[activeLineIdx] : undefined
  const nextPreviewLine =
    activeLineIdx >= 0 ? draft[activeLineIdx + 1] : undefined

  return (
    <>
      <Modal
        open
        size="studio"
        onClose={requestClose}
        closeOnEscape={!selected && !confirmDiscard && !showShortcuts}
        title="Lyrics & timestamp studio"
        headerActions={
          <div className="studio-header-actions">
            {activeLoopLineIdx !== null && (
              <Badge tone="teal">
                Looping line {activeLoopLineIdx + 1}
                <button
                  type="button"
                  className="lyrics-loop-stop"
                  aria-label="Stop loop"
                  onClick={() => setLoopLineIdx(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </Badge>
            )}
            {dirty && <Badge tone="amber">Unsaved</Badge>}
            <Button
              variant="ghost"
              icon={Undo2}
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={!canUndo}
              onClick={handleUndo}
            >
              Undo
            </Button>
            <Button
              variant="ghost"
              icon={Redo2}
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={handleRedo}
            >
              Redo
            </Button>
            <Button
              variant="ghost"
              icon={Keyboard}
              className="studio-shortcuts-btn"
              aria-expanded={showShortcuts}
              onClick={() => setShowShortcuts((prev) => !prev)}
            >
              Shortcuts
            </Button>
            <Button
              variant="primary"
              icon={Save}
              loading={save.isPending}
              disabled={!canSave}
              onClick={() => save.mutate(draft)}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={requestClose}>
              Done
            </Button>
          </div>
        }
      >
        <div className="studio-workspace">
          {activeStem && (
            <audio
              ref={audioRef}
              className="studio-audio"
              aria-label="Lyrics editor audio"
              preload="metadata"
              src={stemMediaUrl(job.id, activeStem)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onDurationChange={(e) => {
                if (Number.isFinite(e.currentTarget.duration)) {
                  setAudioDuration(e.currentTarget.duration)
                }
              }}
              onEnded={(e) => {
                const target =
                  activeLoopLineIdx !== null ? draft[activeLoopLineIdx] : undefined
                if (target) {
                  const start = Math.max(0, target.start - LOOP_PRE_ROLL)
                  e.currentTarget.currentTime = start
                  setCurrentTime(start)
                  void e.currentTarget.play().catch(() => {})
                } else {
                  setIsPlaying(false)
                }
              }}
              onTimeUpdate={(e) => {
                wrapLoopPlayback(e.currentTarget, draft, activeLoopLineIdx)
                setCurrentTime(e.currentTarget.currentTime)
              }}
              onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                e.currentTarget.playbackRate = playbackRate
                if (Number.isFinite(e.currentTarget.duration)) {
                  setAudioDuration(e.currentTarget.duration)
                }
                const pending = pendingSeekRef.current
                if (pending) {
                  pendingSeekRef.current = null
                  e.currentTarget.currentTime = pending.time
                  setCurrentTime(pending.time)
                  if (pending.autoplay) {
                    void e.currentTarget.play().catch(() => {})
                  }
                }
              }}
            />
          )}

          {showShortcuts && (
            <div className="studio-shortcuts-drawer" role="region" aria-label="Keyboard shortcuts">
              <table>
                <tbody>
                  <tr>
                    <th>Space</th>
                    <td>Play / pause</td>
                    <th>[ / ]</th>
                    <td>Stamp word start / end &amp; advance</td>
                  </tr>
                  <tr>
                    <th>← / →</th>
                    <td>Previous / next word</td>
                    <th>Alt+← / →</th>
                    <td>Shift word ±50 ms (+Shift ±10 ms)</td>
                  </tr>
                  <tr>
                    <th>L</th>
                    <td>Loop selected / active line</td>
                    <th>- / =</th>
                    <td>Slower / faster speed</td>
                  </tr>
                  <tr>
                    <th>Enter</th>
                    <td>Play from selected word</td>
                    <th>Ctrl+Z / Y</th>
                    <td>Undo / Redo</td>
                  </tr>
                  <tr>
                    <th>Ctrl+S</th>
                    <td>Save changes</td>
                    <th>Esc</th>
                    <td>Clear selection / close</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="studio-top-deck">
            <div className="studio-glow-preview" aria-label="Live karaoke preview">
              {previewLine ? (
                <>
                  <div className="karaoke-line active studio-preview-line">
                    {previewLine.words.length > 0 ? (
                      previewLine.words.map((word, wordIdx) => {
                        const fillPct = wordProgressPct(word, currentTime)
                        const isWordActive =
                          currentTime >= word.start && currentTime <= word.end
                        const isWordSelected =
                          selected?.lineIdx === activeLineIdx &&
                          selected?.wordIdx === wordIdx
                        return (
                          <span
                            key={`${activeLineIdx}-${wordIdx}`}
                            data-preview-word={word.word}
                            className={`karaoke-word${isWordActive ? ' current' : ''}${fillPct >= 100 ? ' sung' : ''}${isWordSelected ? ' preview-selected' : ''}`}
                            style={
                              {
                                '--karaoke-fill': `${fillPct.toFixed(1)}%`,
                              } as React.CSSProperties
                            }
                          >
                            {word.word}
                          </span>
                        )
                      })
                    ) : (
                      <span className="karaoke-word">{previewLine.text}</span>
                    )}
                  </div>
                  {nextPreviewLine && (
                    <div className="studio-preview-next">{nextPreviewLine.text}</div>
                  )}
                </>
              ) : (
                <div className="studio-preview-next">No lines to preview</div>
              )}
            </div>

            <div className="studio-transport">
              <Button
                variant="secondary"
                icon={isPlaying ? Pause : Play}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                onClick={togglePlay}
              >
                {isPlaying ? 'Pause' : 'Play'}
              </Button>

              <div className="karaoke-track-pills" role="group" aria-label="Editor audio track">
                <span className="karaoke-track-label">
                  <Volume2 aria-hidden="true" /> Track
                </span>
                {playableStems.map((stem) => (
                  <button
                    key={stem.name}
                    type="button"
                    className={`karaoke-track-pill${stem.name === activeStem?.name ? ' active' : ''}`}
                    onClick={() => switchTrack(stem.name)}
                  >
                    {stem.display_name || formatStemLabel(stem.name)}
                  </button>
                ))}
              </div>

              <div className="karaoke-track-pills" role="group" aria-label="Playback speed">
                {PLAYBACK_RATES.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={`karaoke-track-pill${playbackRate === rate ? ' active' : ''}`}
                    aria-pressed={playbackRate === rate}
                    onClick={() => setPlaybackRate(rate)}
                  >
                    {rate}×
                  </button>
                ))}
              </div>
            </div>

            <LyricsTimeline
              lines={draft}
              duration={effectiveDuration}
              currentTime={currentTime}
              selected={selected}
              loopLineIdx={activeLoopLineIdx}
              waveform={waveform}
              waveformLoading={waveformLoading}
              onSeek={seekTo}
              onSelectWord={setSelected}
              onPreviewDraft={setDragPreview}
              onCommitDraft={(before, next) => {
                setDragPreview(null)
                if (next !== before) setCommittedDraft(next)
              }}
            />
          </div>

          <LyricsEditor
            lines={draft}
            onChange={setCommittedDraft}
            currentTime={currentTime}
            onSeek={seekTo}
            issues={issues}
            selected={selected}
            onSelect={setSelected}
            loopLineIdx={activeLoopLineIdx}
            onToggleLoop={toggleLoop}
          />

          <LyricsWordInspector
            lines={draft}
            selected={selected}
            currentTime={currentTime}
            onChange={setCommittedDraft}
            onSeek={seekTo}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onClose}
        title="Discard unsaved lyric edits?"
        description="Your timestamp and text changes since the last save will be lost."
        confirmLabel="Discard"
        destructive
      />
    </>
  )
}
