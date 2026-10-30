import * as alphaTab from '@coderline/alphatab'
import { FileDown, Pause, Play, Printer, Square, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { exportAlphaTabScoreToPdf } from '../lib/pdfExport'
import { Button, ErrorState, Skeleton, useToast } from './ui'

interface DrumScoreViewerProps {
  musicXmlUrl: string
  title?: string
}

export default function DrumScoreViewer({ musicXmlUrl, title }: DrumScoreViewerProps) {
  const toast = useToast()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null)
  const [loading, setLoading] = useState(true)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1.0)
  const [scale, setScale] = useState(0.95)
  const [metronome, setMetronome] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let cancelled = false
    let api: alphaTab.AlphaTabApi | null = null

    const initAndLoad = async () => {
      const settings = new alphaTab.Settings()
      settings.core.fontDirectory = '/font/'
      settings.core.enableLazyLoading = false
      settings.player.enablePlayer = true
      settings.player.soundFont = '/soundfont/sonivox.sf2'
      if (viewportRef.current) {
        settings.player.scrollElement = viewportRef.current
      }
      settings.display.layoutMode = alphaTab.LayoutMode.Page
      settings.display.scale = 0.95

      api = new alphaTab.AlphaTabApi(el, settings)
      apiRef.current = api

      api.renderFinished.on(() => {
        if (!cancelled) setLoading(false)
      })
      api.error.on((err) => {
        if (!cancelled) {
          setError(err?.message || 'Could not render the MusicXML score.')
          setLoading(false)
        }
      })
      api.playerStateChanged.on((args) => {
        if (!cancelled) {
          setPlaying(args.state === alphaTab.synth.PlayerState.Playing)
        }
      })

      const res = await fetch(musicXmlUrl, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to fetch score (${res.status})`)
      const buf = await res.arrayBuffer()
      if (!cancelled && apiRef.current) {
        apiRef.current.load(new Uint8Array(buf))
      }
    }

    initAndLoad().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Could not load MusicXML file.')
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      try {
        api?.destroy()
      } catch {
        // Ignore teardown errors in headless/test environments
      }
      apiRef.current = null
    }
  }, [musicXmlUrl])

  const togglePlay = () => {
    apiRef.current?.playPause()
  }

  const stopPlayback = () => {
    apiRef.current?.stop()
    setPlaying(false)
  }

  const changeSpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed)
    if (apiRef.current) {
      apiRef.current.playbackSpeed = nextSpeed
    }
  }

  const changeZoom = (delta: number) => {
    const next = Math.min(1.5, Math.max(0.6, Number((scale + delta).toFixed(2))))
    setScale(next)
    const api = apiRef.current
    if (api) {
      api.settings.display.scale = next
      api.updateSettings()
      api.render()
    }
  }

  const toggleMetronome = () => {
    const next = !metronome
    setMetronome(next)
    if (apiRef.current) {
      apiRef.current.metronomeVolume = next ? 1 : 0
    }
  }

  const handlePrint = () => {
    apiRef.current?.print()
  }

  const handleDownloadPdf = async () => {
    const api = apiRef.current
    if (!api) return
    setExportingPdf(true)
    try {
      const safeBase = (title || 'drums-score')
        .replace(/[<>:"/\\|?*]+/g, '')
        .trim()
      await exportAlphaTabScoreToPdf(api, `${safeBase || 'drums-score'} - Drums.pdf`)
      toast.show('PDF downloaded.', { tone: 'success' })
    } catch (err) {
      toast.show(
        err instanceof Error ? err.message : 'Could not generate PDF.',
        { tone: 'error' },
      )
    } finally {
      setExportingPdf(false)
    }
  }

  if (error) {
    return <ErrorState message={error} />
  }

  return (
    <div className="score-viewer-shell">
      <div className="score-toolbar" role="toolbar" aria-label="Sheet music controls">
        <div className="score-toolbar-group">
          <Button
            variant="secondary"
            icon={playing ? Pause : Play}
            onClick={togglePlay}
          >
            {playing ? 'Pause' : 'Play score'}
          </Button>
          <Button variant="ghost" icon={Square} onClick={stopPlayback}>
            Stop
          </Button>
          <label className="score-speed-select">
            <span>Speed</span>
            <select
              aria-label="Playback speed"
              value={String(speed)}
              onChange={(e) => changeSpeed(Number(e.target.value))}
            >
              <option value="0.5">50%</option>
              <option value="0.75">75%</option>
              <option value="1">100%</option>
              <option value="1.25">125%</option>
            </select>
          </label>
          <button
            type="button"
            className={`button button-ghost ${metronome ? 'active' : ''}`}
            onClick={toggleMetronome}
          >
            Metronome {metronome ? 'On' : 'Off'}
          </button>
        </div>

        <div className="score-toolbar-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => changeZoom(-0.1)}
          >
            <ZoomOut />
          </button>
          <span className="score-zoom-label">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => changeZoom(0.1)}
          >
            <ZoomIn />
          </button>
          <Button variant="ghost" icon={Printer} onClick={handlePrint}>
            Print
          </Button>
          <Button
            variant="primary"
            icon={FileDown}
            loading={exportingPdf}
            disabled={loading}
            onClick={() => void handleDownloadPdf()}
          >
            Download PDF
          </Button>
        </div>
      </div>

      {loading && <Skeleton className="score-canvas-skeleton" />}
      <div ref={viewportRef} className="score-viewport">
        <div
          ref={containerRef}
          className="score-canvas-surface"
          aria-label="Drum sheet music"
        />
      </div>
    </div>
  )
}
