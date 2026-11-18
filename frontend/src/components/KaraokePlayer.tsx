import { useQuery } from '@tanstack/react-query'
import { Maximize2, Minimize2, Mic2, Pencil, Timer, Volume2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  findActiveLineIndex,
  getCountdownBeat,
  getPreRollDelay,
  wordProgressPct,
} from '../lib/lyricsEdit'
import type { Job, Stem } from '../types'
import LyricsEditorModal from './LyricsEditorModal'
import { Button, ErrorState, Skeleton, formatStemLabel } from './ui'

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

export default function KaraokePlayer({
  job,
  lyricsId,
  version = null,
  canEdit = true,
}: KaraokePlayerProps) {
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
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [countdownEnabled, setCountdownEnabled] = useState(true)
  const [preRoll, setPreRoll] = useState<{ total: number } | null>(null)
  const [preRollElapsed, setPreRollElapsed] = useState(0)

  const shellRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])
  const pendingSeekRef = useRef<{ time: number; autoplay: boolean } | null>(null)
  const preRollArmedRef = useRef(true)

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
    if (!preRoll) return undefined
    const startedAt = performance.now()
    let frameId = 0
    const step = () => {
      const elapsed = (performance.now() - startedAt) / 1000
      if (elapsed >= preRoll.total) {
        setPreRoll(null)
        setPreRollElapsed(0)
        const audio = audioRef.current
        if (audio) {
          void audio.play().catch(() => {})
        }
        return
      }
      setPreRollElapsed(elapsed)
      frameId = window.requestAnimationFrame(step)
    }
    frameId = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frameId)
  }, [preRoll])

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const lines = useMemo(() => docQuery.data?.lines ?? [], [docQuery.data])
  const activeLineIndex = findActiveLineIndex(lines, currentTime)
  const preRollLeft = preRoll ? Math.max(0, preRoll.total - preRollElapsed) : null
  const countdownBeat = getCountdownBeat(
    lines,
    currentTime,
    isPlaying,
    preRollLeft,
    countdownEnabled,
  )

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
    preRollArmedRef.current = false
    setPreRoll(null)
    setPreRollElapsed(0)
    audio.currentTime = Math.max(0, seconds)
    setCurrentTime(audio.currentTime)
    if (autoplay && audio.paused) {
      void audio.play().catch(() => {})
    }
  }

  const switchTrack = (nextStemName: string) => {
    if (nextStemName === activeStem?.name) return
    const audio = audioRef.current
    setPreRoll(null)
    setPreRollElapsed(0)
    if (audio) {
      const time = audio.currentTime || currentTime
      preRollArmedRef.current = time <= 0.05
      pendingSeekRef.current = {
        time,
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

  const openEditor = async () => {
    setPreRoll(null)
    setPreRollElapsed(0)
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause()
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
    }
    setIsEditorOpen(true)
  }

  const toggleCountdown = () => {
    setCountdownEnabled((prev) => {
      const next = !prev
      if (!next && preRoll) {
        setPreRoll(null)
        setPreRollElapsed(0)
        preRollArmedRef.current = false
        void audioRef.current?.play().catch(() => {})
      }
      return next
    })
  }

  const skipPreRoll = () => {
    setPreRoll(null)
    setPreRollElapsed(0)
    preRollArmedRef.current = false
    void audioRef.current?.play().catch(() => {})
  }

  const cancelPreRoll = () => {
    setPreRoll(null)
    setPreRollElapsed(0)
    preRollArmedRef.current = true
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
          <button
            type="button"
            className={`karaoke-track-pill karaoke-countdown-toggle${countdownEnabled ? ' active' : ''}`}
            aria-pressed={countdownEnabled}
            onClick={toggleCountdown}
            title="Show 3-2-1 countdown before lyrics start"
          >
            <Timer aria-hidden="true" /> 3·2·1 Countdown
          </button>
          {canEdit && lines.length > 0 && (
            <Button variant="ghost" icon={Pencil} onClick={() => void openEditor()}>
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
        </div>
      </div>

      {activeStem && (
        <audio
          ref={audioRef}
          className="karaoke-audio"
          controls
          preload="metadata"
          src={stemMediaUrl(job.id, activeStem)}
          onPlay={(e) => {
            const audio = e.currentTarget
            const delay = getPreRollDelay(lines, countdownEnabled)
            if (delay > 0 && audio.currentTime <= 0.05 && preRollArmedRef.current) {
              preRollArmedRef.current = false
              audio.pause()
              if (audio.currentTime > 0) audio.currentTime = 0
              setCurrentTime(0)
              setPreRollElapsed(0)
              setPreRoll({ total: delay })
              return
            }
            setIsPlaying(true)
          }}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false)
            preRollArmedRef.current = true
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onSeeked={(e) => {
            setCurrentTime(e.currentTarget.currentTime)
            if (!preRoll && e.currentTarget.paused) {
              preRollArmedRef.current = e.currentTarget.currentTime <= 0.05
            }
          }}
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

      {lines.length === 0 ? (
        <div className="karaoke-empty">
          <Mic2 />
          <p>No sung lyrics were detected in this audio track.</p>
        </div>
      ) : (
        <div ref={stageRef} className="karaoke-stage" aria-label="Synchronized lyrics">
          {countdownBeat !== null && (
            <div className="karaoke-countdown" role="status" aria-live="polite">
              <span className="karaoke-countdown-label">Lyrics starting</span>
              <div
                className="karaoke-countdown-beats"
                aria-label={`Countdown ${countdownBeat}`}
              >
                {([3, 2, 1] as const).map((beat) => (
                  <span
                    key={beat}
                    className={`karaoke-countdown-beat${countdownBeat === beat ? ' active' : ''}${countdownBeat < beat ? ' done' : ''}`}
                  >
                    {beat}
                  </span>
                ))}
              </div>
              {preRoll && (
                <div className="karaoke-countdown-actions">
                  <button type="button" onClick={skipPreRoll}>
                    Skip
                  </button>
                  <button type="button" onClick={cancelPreRoll}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
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

      {isEditorOpen && (
        <LyricsEditorModal
          job={job}
          lyricsId={lyricsId}
          initialLines={lines}
          docDuration={docQuery.data.summary?.duration_seconds ?? 0}
          playableStems={playableStems}
          stemMediaUrl={stemMediaUrl}
          onClose={() => setIsEditorOpen(false)}
        />
      )}
    </div>
  )
}
