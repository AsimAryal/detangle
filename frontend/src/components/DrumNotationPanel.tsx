import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Download,
  Drum,
  FileCode2,
  LoaderCircle,
  Music,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Suspense, lazy, useState, type FormEvent } from 'react'
import { api, transcriptionFileUrl } from '../lib/api'
import type { Job, Transcription, TranscriptionOptions } from '../types'
import { Badge, Button, ConfirmDialog, Skeleton, StatusBadge, useToast } from './ui'

const DrumScoreViewer = lazy(() => import('./DrumScoreViewer'))

const ACTIVE_STATUSES = ['QUEUED', 'PROCESSING', 'ARCHIVING']

interface DrumNotationPanelProps {
  job: Job
}

export function DrumNotationPanel({ job }: DrumNotationPanelProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const hasDrumsStem = job.stems.some((s) => s.name === 'drums')

  const [showOptions, setShowOptions] = useState(false)
  const [timeSignature, setTimeSignature] =
    useState<TranscriptionOptions['time_signature']>('auto')
  const [grid, setGrid] = useState<TranscriptionOptions['grid']>('auto')
  const [sensitivity, setSensitivity] = useState<number>(0.5)
  const [tempoInput, setTempoInput] = useState<string>('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const query = useQuery({
    queryKey: ['transcriptions', job.id],
    queryFn: () => api.transcriptions(job.id),
    enabled: job.status === 'READY' && hasDrumsStem,
    refetchInterval: (state) => {
      const latest = state.state.data?.[0]
      return latest && ACTIVE_STATUSES.includes(latest.status) ? 3_000 : false
    },
  })

  const create = useMutation({
    mutationFn: (opts: Partial<TranscriptionOptions>) =>
      api.createTranscription(job.id, opts),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transcriptions', job.id] })
      setShowOptions(false)
      toast.show('Drum transcription started.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const remove = useMutation({
    mutationFn: (tid: string) => api.deleteTranscription(job.id, tid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transcriptions', job.id] })
      setConfirmDelete(false)
      toast.show('Drum notation deleted.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const submitGenerate = (e?: FormEvent) => {
    e?.preventDefault()
    const parsedTempo = tempoInput.trim() ? Number(tempoInput.trim()) : null
    create.mutate({
      stem: 'drums',
      time_signature: timeSignature,
      grid,
      sensitivity,
      tempo_bpm: parsedTempo && !Number.isNaN(parsedTempo) ? parsedTempo : null,
    })
  }

  const latest: Transcription | undefined = query.data?.[0]
  const isActive = latest && ACTIVE_STATUSES.includes(latest.status)

  if (!hasDrumsStem) {
    return (
      <section className="stems-section notation-section" aria-label="Drum notation">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Sheet Music</span>
            <h2>Drum notation</h2>
          </div>
          <Badge tone="neutral">Drums stem required</Badge>
        </div>
        <div className="stem-group">
          <div className="stem-group-header">
            <div>
              <h3>Isolated drums stem not found</h3>
              <p>
                Drum notation needs the isolated <strong>Drums</strong> stem. Start a new
                separation that includes Drums to transcribe sheet music.
              </p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="stems-section notation-section" aria-label="Drum notation">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Sheet Music</span>
          <h2>Drum notation</h2>
        </div>
        {latest ? (
          <StatusBadge status={latest.status} />
        ) : (
          <Badge tone="teal">ADTOF + beat_this</Badge>
        )}
      </div>

      <div className="stem-group">
        <div className="stem-group-header">
          <div>
            <h3>Automatic drum transcription</h3>
            <p>
              Generates a draft percussion score (kick, snare, hi-hat, toms, cymbals) and
              MIDI files from the isolated drums track. Check fills, ghost notes, and
              cymbals by ear.
            </p>
          </div>
          <div className="detail-actions">
            {!isActive && (
              <>
                <Button
                  variant="ghost"
                  icon={SlidersHorizontal}
                  onClick={() => setShowOptions((prev) => !prev)}
                >
                  Options
                </Button>
                <Button
                  variant="primary"
                  icon={latest ? RefreshCw : Sparkles}
                  loading={create.isPending}
                  onClick={() => submitGenerate()}
                >
                  {latest ? 'Regenerate notation' : 'Generate drum notation'}
                </Button>
              </>
            )}
            {latest && !isActive && (
              <Button
                variant="ghost"
                icon={Trash2}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
        </div>

        {showOptions && !isActive && (
          <form className="notation-options-form" onSubmit={submitGenerate}>
            <label>
              <span>Time signature</span>
              <select
                aria-label="Time signature"
                value={timeSignature}
                onChange={(e) =>
                  setTimeSignature(
                    e.target.value as TranscriptionOptions['time_signature'],
                  )
                }
              >
                <option value="auto">Auto-detect</option>
                <option value="4/4">4/4</option>
                <option value="3/4">3/4</option>
                <option value="2/4">2/4</option>
                <option value="5/4">5/4</option>
                <option value="6/4">6/4</option>
                <option value="7/4">7/4</option>
              </select>
            </label>

            <label>
              <span>Subdivision grid</span>
              <select
                aria-label="Subdivision grid"
                value={grid}
                onChange={(e) =>
                  setGrid(e.target.value as TranscriptionOptions['grid'])
                }
              >
                <option value="auto">Auto (16ths + triplets)</option>
                <option value="16th">Straight 16th notes</option>
                <option value="8th_triplet">8th-note triplets (shuffle)</option>
              </select>
            </label>

            <label>
              <span>Detection sensitivity</span>
              <select
                aria-label="Detection sensitivity"
                value={String(sensitivity)}
                onChange={(e) => setSensitivity(Number(e.target.value))}
              >
                <option value="0.25">Low (fewer ghost notes)</option>
                <option value="0.5">Normal (recommended)</option>
                <option value="0.75">High (more subtle hits)</option>
              </select>
            </label>

            <label>
              <span>Tempo override (BPM, optional)</span>
              <input
                type="number"
                min={40}
                max={300}
                step="0.5"
                placeholder="Auto"
                value={tempoInput}
                onChange={(e) => setTempoInput(e.target.value)}
              />
            </label>
          </form>
        )}

        {query.isLoading && <Skeleton className="detail-hero-skeleton" />}

        {isActive && latest && (
          <div className="job-progress-panel notation-progress" aria-live="polite">
            <div className="progress-orbit">
              <LoaderCircle />
            </div>
            <div>
              <span className="eyebrow">{latest.status.toLowerCase()}</span>
              <h4>
                {latest.status === 'QUEUED'
                  ? 'Waiting for Drumster GPU worker'
                  : latest.status === 'ARCHIVING'
                    ? 'Saving MusicXML and MIDI files'
                    : 'Detecting drum hits and tracking beats'}
              </h4>
              <div className="detail-progress">
                <span>
                  <i
                    style={{
                      width: `${Math.max(Number(latest.progress_pct) || 0, 4)}%`,
                    }}
                  />
                </span>
                <strong>{(Number(latest.progress_pct) || 0).toFixed(0)}%</strong>
              </div>
            </div>
          </div>
        )}

        {latest && ['FAILED', 'UNAVAILABLE'].includes(latest.status) && (
          <div className="failure-panel" role="alert">
            <span>
              <AlertTriangle />
            </span>
            <div>
              <span className="eyebrow">Transcription stopped</span>
              <h4>Drum notation could not be completed.</h4>
              <p>
                {latest.error_message ||
                  'The transcription service returned an error. Try regenerating with different options.'}
              </p>
            </div>
          </div>
        )}

        {latest && latest.status === 'READY' && (
          <div className="notation-ready-body">
            {latest.summary && (
              <div className="notation-summary-strip">
                <Badge tone="teal">
                  <Drum /> {latest.summary.tempo_bpm} BPM
                </Badge>
                <Badge tone="neutral">{latest.summary.time_signature}</Badge>
                <Badge tone="neutral">{latest.summary.measure_count} bars</Badge>
                <Badge tone="neutral">{latest.summary.note_count} hits</Badge>
              </div>
            )}

            <div className="notation-download-bar">
              <a
                className="button button-secondary"
                href={transcriptionFileUrl(job.id, latest.id, 'musicxml', true)}
              >
                <FileCode2 /> Download MusicXML
              </a>
              <a
                className="button button-secondary"
                href={transcriptionFileUrl(job.id, latest.id, 'midi', true)}
              >
                <Music /> Download Quantized MIDI
              </a>
              <a
                className="button button-ghost"
                href={transcriptionFileUrl(job.id, latest.id, 'raw_midi', true)}
              >
                <Download /> Raw MIDI (unquantized)
              </a>
            </div>

            <Suspense fallback={<Skeleton className="score-canvas-skeleton" />}>
              <DrumScoreViewer
                title={job.title || job.filename || 'Drums'}
                musicXmlUrl={transcriptionFileUrl(
                  job.id,
                  latest.id,
                  'musicxml',
                  false,
                )}
              />
            </Suspense>
          </div>
        )}
      </div>

      {latest && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate(latest.id)}
          title="Delete this drum notation?"
          description="The generated MusicXML and MIDI files for this transcription will be removed."
          confirmLabel="Delete notation"
          destructive
          loading={remove.isPending}
        />
      )}
    </section>
  )
}

