import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Maximize2, Minimize2, Mic2, Pencil, Save, Volume2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  FINE_NUDGE_STEP,
  NUDGE_STEP,
  isDirty,
  nextWordRef,
  nudgeWord,
  setWordTime,
  toSavePayload,
  validateLines,
  type WordRef,
} from '../lib/lyricsEdit'
import type { Job, LyricsLine, LyricsWord, Stem } from '../types'
import LyricsEditor from './LyricsEditor'
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Skeleton,
  formatStemLabel,
  useToast,
} from './ui'

interface KaraokePlayerProps {
  job: Job
  lyricsId: string
  version?: string | null
  canEdit?: boolean
}

function stemMediaUrl(jobId: string, stem: Stem) {
  return (
    stem.media_url ||
    `/api/jobs/${encodeURIComponent(jobId)}/stems/${encodeURIComponent(stem.name)}?download=0`
  )
}

function pickDefaultStem(stems: Stem[]): Stem | undefined {
  const priority = ['no_vocals', 'original', 'vocals']
  for (const name of priority) {
    const match = stems.find((s) => s.name === name)
    if (match) return match
  }
  return stems[0]
}

function wordProgressPct(word: LyricsWord, currentTime: number): number {
  if (currentTime <= word.start) return 0
  if (currentTime >= word.end) return 100
  const span = Math.max(0.02, word.end - word.start)
  return Math.min(100, Math.max(0, ((currentTime - word.start) / span) * 100))
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function findActiveLineIndex(lines: LyricsLine[], currentTime: number): number {
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

export default function KaraokePlayer({
  job,
  lyricsId,
  version = null,
  canEdit = true,
}: KaraokePlayerProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const docQuery = useQuery({
    queryKey: ['lyrics-doc', job.id, lyricsId, version ?? ''],
    queryFn: () => api.lyricsDocument(job.id, lyricsId, version),
  })

  const playableStems = useMemo(() => {
    const order = ['no_vocals', 'original', 'vocals']
    return [...job.stems].sort((a, b) => {
      const ia = order.indexOf(a.name)
      const ib = order.indexOf(b.name)
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      }
      return a.name.localeCompare(b.name)
    })
  }, [job.stems])

  const defaultStem = useMemo(() => pickDefaultStem(playableStems), [playableStems])
  const [selectedStemName, setSelectedStemName] = useState<string>(
    defaultStem?.name || '',
  )
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const shellRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])
  const pendingSeekRef = useRef<{ time: number; autoplay: boolean } | null>(null)

  const activeStem =
    playableStems.find((s) => s.name === selectedStemName) || defaultStem

  useEffect(() => {
    if (!isPlaying) return undefined
    let frameId = 0
    const tick = () => {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime)
      }
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [isPlaying])

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const lines = useMemo(() => docQuery.data?.lines ?? [], [docQuery.data])
  const activeLineIndex = findActiveLineIndex(lines, currentTime)

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<LyricsLine[] | null>(null)
  const [selected, setSelected] = useState<WordRef | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const dirty = draft ? isDirty(lines, draft) : false
  const issues = useMemo(() => (draft ? validateLines(draft) : []), [draft])

  const exitEditing = () => {
    setIsEditing(false)
    setDraft(null)
    setSelected(null)
    setConfirmDiscard(false)
  }

  const save = useMutation({
    mutationFn: (next: LyricsLine[]) =>
      api.saveLyricsDocument(job.id, lyricsId, toSavePayload(next)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lyrics', job.id] })
      void queryClient.invalidateQueries({ queryKey: ['lyrics-doc', job.id, lyricsId] })
      exitEditing()
      toast.show('Lyrics saved.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const canSave = Boolean(draft) && dirty && issues.length === 0 && !save.isPending

  const startEditing = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
    }
    setDraft(structuredClone(lines))
    setSelected(null)
    setIsEditing(true)
  }

  const requestCancel = () => {
    if (dirty) {
      setConfirmDiscard(true)
    } else {
      exitEditing()
    }
  }

  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!isEditing || !draft) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (confirmDiscard) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (canSave) save.mutate(draft)
        return
      }
      if (isEditableTarget(e.target)) return

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
          setDraft(setWordTime(draft, selected, 'start', playhead))
        } else {
          const next = setWordTime(draft, selected, 'end', playhead)
          setDraft(next)
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
          setDraft(nudgeWord(draft, selected, 'both', dir * step))
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
        const audio = audioRef.current
        if (!audio) return
        audio.currentTime = Math.max(0, selectedWord.start)
        setCurrentTime(audio.currentTime)
        if (audio.paused) {
          void audio.play().catch(() => {})
        }
        return
      }

      if (e.key === 'Escape' && !mod && !e.altKey && selected) {
        e.preventDefault()
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isEditing, draft, selected, canSave, confirmDiscard, save])

  useEffect(() => {
    if (activeLineIndex < 0) return
    const container = stageRef.current
    const el = lineRefs.current[activeLineIndex]
    if (!container || !el) return
    const targetTop =
      el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo?.({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    })
  }, [activeLineIndex])

  const seekTo = (seconds: number, autoplay = true) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, seconds)
    setCurrentTime(audio.currentTime)
    if (autoplay && audio.paused) {
      void audio.play().catch(() => {})
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

  const toggleFullscreen = async () => {
    const target = shellRef.current
    if (!target) return
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (target.requestFullscreen) {
      await target.requestFullscreen()
    }
  }

  if (docQuery.isLoading) {
    return <Skeleton className="score-canvas-skeleton" />
  }
  if (docQuery.isError || !docQuery.data) {
    return (
      <ErrorState
        message={docQuery.error?.message || 'Could not load timed lyrics JSON.'}
        retry={() => void docQuery.refetch()}
      />
    )
  }

  return (
    <div
      ref={shellRef}
      className={`karaoke-player-shell${isFullscreen ? ' fullscreen' : ''}`}
    >
      <div className="karaoke-toolbar">
        <div className="karaoke-track-pills" role="group" aria-label="Karaoke audio track">
          <span className="karaoke-track-label">
            <Volume2 /> Track
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
        <div className="karaoke-toolbar-actions">
          {isEditing ? (
            <>
              <Button variant="ghost" icon={X} onClick={requestCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={Save}
                loading={save.isPending}
                disabled={!canSave}
                onClick={() => draft && save.mutate(draft)}
              >
                Save changes
              </Button>
            </>
          ) : (
            <>
              {canEdit && lines.length > 0 && (
                <Button variant="ghost" icon={Pencil} onClick={() => void startEditing()}>
                  Edit lyrics
                </Button>
              )}
              <Button
                variant="ghost"
                icon={isFullscreen ? Minimize2 : Maximize2}
                onClick={() => void toggleFullscreen()}
              >
                {isFullscreen ? 'Exit stage' : 'Stage mode'}
              </Button>
            </>
          )}
        </div>
      </div>

      {activeStem && (
        <audio
          ref={audioRef}
          className="karaoke-audio"
          controls
          preload="metadata"
          src={stemMediaUrl(job.id, activeStem)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
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
        >
          Audio playback is not supported by this browser.
        </audio>
      )}

      {isEditing && draft ? (
        <LyricsEditor
          lines={draft}
          onChange={setDraft}
          currentTime={currentTime}
          onSeek={seekTo}
          issues={issues}
          selected={selected}
          onSelect={setSelected}
        />
      ) : lines.length === 0 ? (
        <div className="karaoke-empty">
          <Mic2 />
          <p>No sung lyrics were detected in this audio track.</p>
        </div>
      ) : (
        <div ref={stageRef} className="karaoke-stage" aria-label="Synchronized lyrics">
          {lines.map((line, lineIdx) => {
            const isActive = lineIdx === activeLineIndex
            const isPast = activeLineIndex !== -1 && lineIdx < activeLineIndex
            return (
              <div
                key={line.index}
                ref={(el) => {
                  lineRefs.current[lineIdx] = el
                }}
                className={`karaoke-line${isActive ? ' active' : ''}${isPast ? ' past' : ''}`}
              >
                {line.words.length > 0 ? (
                  line.words.map((word, wordIdx) => {
                    const fillPct = wordProgressPct(word, currentTime)
                    const isWordActive =
                      currentTime >= word.start && currentTime <= word.end
                    return (
                      <button
                        key={`${line.index}-${wordIdx}`}
                        type="button"
                        className={`karaoke-word${isWordActive ? ' current' : ''}${fillPct >= 100 ? ' sung' : ''}`}
                        style={{ '--karaoke-fill': `${fillPct.toFixed(1)}%` } as React.CSSProperties}
                        onClick={() => seekTo(word.start)}
                        title={`Seek to ${word.start.toFixed(2)}s`}
                      >
                        {word.word}
                      </button>
                    )
                  })
                ) : (
                  <button
                    type="button"
                    className="karaoke-word"
                    onClick={() => seekTo(line.start)}
                  >
                    {line.text}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={exitEditing}
        title="Discard unsaved lyric edits?"
        description="Your timestamp and text changes since the last save will be lost."
        confirmLabel="Discard"
        destructive
      />
    </div>
  )
}
