import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import {
  ZOOM_WINDOWS,
  formatTimestamp,
  moveWord,
  round3,
  setWordTime,
  wordProgressPct,
  type WordRef,
} from '../lib/lyricsEdit'
import type { WaveformData } from '../lib/waveform'
import type { LyricsLine } from '../types'

export interface LyricsTimelineProps {
  lines: LyricsLine[]
  duration: number
  currentTime: number
  selected: WordRef | null
  loopLineIdx: number | null
  waveform: WaveformData | null
  waveformLoading: boolean
  onSeek: (seconds: number, autoplay?: boolean) => void
  onSelectWord: (ref: WordRef) => void
  onPreviewDraft: (next: LyricsLine[]) => void
  onCommitDraft: (before: LyricsLine[], next: LyricsLine[]) => void
}

interface DragState {
  mode: 'start' | 'end' | 'move' | 'scrub'
  ref?: WordRef
  startX: number
  rectLeft: number
  rectWidth: number
  winStart: number
  windowSpan: number
  origStart: number
  origEnd: number
  startLines: LyricsLine[]
  latestLines: LyricsLine[]
  moved: boolean
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

export default function LyricsTimeline({
  lines,
  duration,
  currentTime,
  selected,
  loopLineIdx,
  waveform,
  waveformLoading,
  onSeek,
  onSelectWord,
  onPreviewDraft,
  onCommitDraft,
}: LyricsTimelineProps) {
  const [zoomSeconds, setZoomSeconds] = useState<number>(6)
  const [frozenWinStart, setFrozenWinStart] = useState<number | null>(null)
  const [canvasWidth, setCanvasWidth] = useState(640)

  const overviewRef = useRef<HTMLDivElement>(null)
  const zoomedRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const overviewDraggingRef = useRef(false)

  const safeDuration = Math.max(duration, 1)
  const computedWinStart = clamp(
    currentTime - zoomSeconds * 0.35,
    0,
    Math.max(0, safeDuration - zoomSeconds),
  )
  const winStart = frozenWinStart ?? computedWinStart
  const winEnd = winStart + zoomSeconds

  useEffect(() => {
    const el = zoomedRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width && width > 0) setCanvasWidth(Math.round(width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof canvas.getContext !== 'function') return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const height = 84
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    canvas.width = Math.max(1, Math.floor(canvasWidth * dpr))
    canvas.height = Math.floor(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvasWidth, height)

    // Second & sub-second grid
    const minorStep = zoomSeconds <= 6 ? 0.25 : 0.5
    const firstTick = Math.ceil(winStart / minorStep) * minorStep
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'top'

    for (let t = firstTick; t <= winEnd + 0.0001; t += minorStep) {
      const x = ((t - winStart) / zoomSeconds) * canvasWidth
      const isWholeSec = Math.abs(t - Math.round(t)) < 0.001
      ctx.strokeStyle = isWholeSec
        ? 'rgba(148, 163, 184, 0.25)'
        : 'rgba(148, 163, 184, 0.08)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, height)
      ctx.stroke()
      if (isWholeSec && x < canvasWidth - 36) {
        ctx.fillStyle = 'rgba(175, 194, 200, 0.65)'
        ctx.fillText(formatTimestamp(t), x + 4, 3)
      }
    }

    // Vocal waveform bars
    if (waveform && waveform.peaks.length > 0) {
      const midY = height * 0.58
      const maxBar = height * 0.36
      const barStep = 3
      ctx.fillStyle = 'rgba(73, 214, 194, 0.35)'

      for (let x = 0; x < canvasWidth; x += barStep) {
        const t0 = winStart + (x / canvasWidth) * zoomSeconds
        const t1 = winStart + ((x + barStep) / canvasWidth) * zoomSeconds
        const i0 = clamp(Math.floor(t0 * waveform.peaksPerSec), 0, waveform.peaks.length - 1)
        const i1 = clamp(Math.ceil(t1 * waveform.peaksPerSec), i0 + 1, waveform.peaks.length)
        let peak = 0
        for (let i = i0; i < i1; i += 1) {
          if (waveform.peaks[i] > peak) peak = waveform.peaks[i]
        }
        const barH = Math.max(2, peak * maxBar * 2)
        ctx.fillRect(x, midY - barH / 2, 2, barH)
      }
    }
  }, [canvasWidth, waveform, winEnd, winStart, zoomSeconds])

  const visibleWords = useMemo(() => {
    const items: Array<{
      ref: WordRef
      word: string
      start: number
      end: number
      leftPct: number
      widthPct: number
      fillPct: number
      isCurrent: boolean
      isSelected: boolean
    }> = []

    lines.forEach((line, lineIdx) => {
      if (line.end < winStart || line.start > winEnd) return
      line.words.forEach((w, wordIdx) => {
        if (w.end < winStart || w.start > winEnd) return
        const leftPct = ((w.start - winStart) / zoomSeconds) * 100
        const widthPct = ((w.end - w.start) / zoomSeconds) * 100
        items.push({
          ref: { lineIdx, wordIdx },
          word: w.word,
          start: w.start,
          end: w.end,
          leftPct,
          widthPct,
          fillPct: wordProgressPct(w, currentTime),
          isCurrent: currentTime >= w.start && currentTime <= w.end,
          isSelected:
            selected?.lineIdx === lineIdx && selected?.wordIdx === wordIdx,
        })
      })
    })
    return items
  }, [currentTime, lines, selected, winEnd, winStart, zoomSeconds])

  const seekFromOverviewClientX = (clientX: number) => {
    const el = overviewRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const frac = clamp((clientX - rect.left) / width, 0, 1)
    onSeek(round3(frac * safeDuration), false)
  }

  const onOverviewPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    overviewDraggingRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    seekFromOverviewClientX(e.clientX)
  }

  const onOverviewPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!overviewDraggingRef.current) return
    seekFromOverviewClientX(e.clientX)
  }

  const onOverviewPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!overviewDraggingRef.current) return
    overviewDraggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const startZoomDrag = (
    e: PointerEvent<HTMLElement>,
    mode: DragState['mode'],
    ref?: WordRef,
    origStart = 0,
    origEnd = 0,
  ) => {
    e.stopPropagation()
    const viewport = zoomedRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const rectWidth = Math.max(1, rect.width)

    setFrozenWinStart(winStart)
    dragRef.current = {
      mode,
      ref,
      startX: e.clientX,
      rectLeft: rect.left,
      rectWidth,
      winStart,
      windowSpan: zoomSeconds,
      origStart,
      origEnd,
      startLines: lines,
      latestLines: lines,
      moved: false,
    }
    viewport.setPointerCapture?.(e.pointerId)

    if (mode === 'scrub') {
      const frac = clamp((e.clientX - rect.left) / rectWidth, 0, 1)
      onSeek(round3(clamp(winStart + frac * zoomSeconds, 0, safeDuration)), false)
    } else if (ref) {
      onSelectWord(ref)
    }
  }

  const onZoomPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return

    const dx = e.clientX - drag.startX
    if (Math.abs(dx) > 3) drag.moved = true

    if (drag.mode === 'scrub') {
      const frac = clamp((e.clientX - drag.rectLeft) / drag.rectWidth, 0, 1)
      onSeek(round3(clamp(drag.winStart + frac * drag.windowSpan, 0, safeDuration)), false)
      return
    }

    if (!drag.ref) return
    const deltaSec = (dx / drag.rectWidth) * drag.windowSpan
    let next: LyricsLine[]
    if (drag.mode === 'start') {
      next = setWordTime(drag.startLines, drag.ref, 'start', drag.origStart + deltaSec)
    } else if (drag.mode === 'end') {
      next = setWordTime(drag.startLines, drag.ref, 'end', drag.origEnd + deltaSec)
    } else {
      next = moveWord(drag.startLines, drag.ref, drag.origStart + deltaSec)
    }
    drag.latestLines = next
    onPreviewDraft(next)
  }

  const finishZoomDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setFrozenWinStart(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)

    if (drag.mode !== 'scrub' && drag.latestLines !== drag.startLines) {
      onCommitDraft(drag.startLines, drag.latestLines)
    }
  }

  const playheadPct = clamp(((currentTime - winStart) / zoomSeconds) * 100, -5, 105)
  const overviewPct = clamp((currentTime / safeDuration) * 100, 0, 100)

  return (
    <div className="studio-timeline" aria-label="Audio timeline">
      <div className="timeline-overview">
        <span className="timeline-clock">{formatTimestamp(currentTime)}</span>
        <div
          ref={overviewRef}
          className="timeline-overview-track"
          role="slider"
          tabIndex={0}
          aria-label="Song seekbar"
          aria-valuemin={0}
          aria-valuemax={round3(safeDuration)}
          aria-valuenow={round3(currentTime)}
          onPointerDown={onOverviewPointerDown}
          onPointerMove={onOverviewPointerMove}
          onPointerUp={onOverviewPointerUp}
          onPointerCancel={onOverviewPointerUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault()
              const step = e.shiftKey ? 5 : 1
              const dir = e.key === 'ArrowRight' ? 1 : -1
              onSeek(clamp(currentTime + dir * step, 0, safeDuration), false)
            }
          }}
        >
          <div className="timeline-overview-rail">
            {lines.map((line, i) => {
              const left = clamp((line.start / safeDuration) * 100, 0, 100)
              const width = clamp(((line.end - line.start) / safeDuration) * 100, 0.4, 100 - left)
              return (
                <span
                  key={`${line.index}-${i}`}
                  className={`timeline-overview-line${i === loopLineIdx ? ' looping' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              )
            })}
            <span
              className="timeline-overview-fill"
              style={{ width: `${overviewPct}%` }}
            />
          </div>
          <span
            className="timeline-overview-thumb"
            style={{ left: `${overviewPct}%` }}
          />
        </div>
        <span className="timeline-clock">{formatTimestamp(safeDuration)}</span>
      </div>

      <div className="timeline-zoomed">
        <div className="timeline-zoomed-bar">
          <div className="timeline-zoom-pills" role="group" aria-label="Timeline zoom">
            <span>Zoom</span>
            {ZOOM_WINDOWS.map((sec) => (
              <button
                key={sec}
                type="button"
                className={`karaoke-track-pill${zoomSeconds === sec ? ' active' : ''}`}
                aria-pressed={zoomSeconds === sec}
                onClick={() => setZoomSeconds(sec)}
              >
                {sec}s
              </button>
            ))}
          </div>

          <div className="timeline-step-group" role="group" aria-label="Fine seek">
            {([-1, -0.1, 0.1, 1] as const).map((delta) => (
              <button
                key={delta}
                type="button"
                onClick={() => onSeek(clamp(currentTime + delta, 0, safeDuration), false)}
              >
                {delta > 0 ? `+${delta}s` : `${delta}s`}
              </button>
            ))}
          </div>

          <span className="timeline-window-status">
            {waveformLoading
              ? 'Decoding vocal waveform…'
              : `${formatTimestamp(winStart)} – ${formatTimestamp(winEnd)}`}
          </span>
        </div>

        <div
          ref={zoomedRef}
          className="timeline-zoomed-viewport"
          aria-label="Zoomed waveform timeline"
          onPointerDown={(e) => startZoomDrag(e, 'scrub')}
          onPointerMove={onZoomPointerMove}
          onPointerUp={finishZoomDrag}
          onPointerCancel={finishZoomDrag}
        >
          <canvas ref={canvasRef} className="timeline-canvas" aria-hidden="true" />

          <div className="timeline-words-layer">
            {visibleWords.map((item) => (
              <div
                key={`${item.ref.lineIdx}-${item.ref.wordIdx}`}
                data-word-ref={`${item.ref.lineIdx}:${item.ref.wordIdx}`}
                className={`timeline-word-block${item.isSelected ? ' selected' : ''}${item.isCurrent ? ' current' : ''}`}
                style={
                  {
                    left: `${item.leftPct}%`,
                    width: `${Math.max(1.2, item.widthPct)}%`,
                    '--karaoke-fill': `${item.fillPct.toFixed(1)}%`,
                  } as React.CSSProperties
                }
                title={`${item.word} (${formatTimestamp(item.start)} – ${formatTimestamp(item.end)})`}
                onPointerDown={(e) =>
                  startZoomDrag(e, 'move', item.ref, item.start, item.end)
                }
              >
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Resize ${item.word} start`}
                  className="timeline-handle timeline-handle-start"
                  onPointerDown={(e) =>
                    startZoomDrag(e, 'start', item.ref, item.start, item.end)
                  }
                />
                <span className="timeline-word-label">{item.word}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Resize ${item.word} end`}
                  className="timeline-handle timeline-handle-end"
                  onPointerDown={(e) =>
                    startZoomDrag(e, 'end', item.ref, item.start, item.end)
                  }
                />
              </div>
            ))}
          </div>

          {playheadPct >= 0 && playheadPct <= 100 && (
            <div
              className="timeline-playhead"
              style={{ left: `${playheadPct}%` }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </div>
  )
}
