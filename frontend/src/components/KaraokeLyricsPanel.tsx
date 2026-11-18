import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Captions,
  FileJson,
  FileText,
  LoaderCircle,
  Mic2,
  Pencil,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Suspense, lazy, useState, type FormEvent } from 'react'
import { api, lyricsFileUrl } from '../lib/api'
import type { Job, LyricsExtraction, LyricsOptions } from '../types'
import { Badge, Button, ConfirmDialog, Skeleton, StatusBadge, useToast } from './ui'

const KaraokePlayer = lazy(() => import('./KaraokePlayer'))

const ACTIVE_STATUSES = ['QUEUED', 'PROCESSING', 'ARCHIVING']

interface KaraokeLyricsPanelProps {
  job: Job
}

export function KaraokeLyricsPanel({ job }: KaraokeLyricsPanelProps) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const hasVocalsStem = job.stems.some((s) => s.name === 'vocals')
  const hasOriginalStem = job.stems.some((s) => s.name === 'original')
  const defaultStem: 'vocals' | 'original' = hasVocalsStem ? 'vocals' : 'original'
  const canExtract = hasVocalsStem || hasOriginalStem

  const [showOptions, setShowOptions] = useState(false)
  const [model, setModel] = useState<LyricsOptions['model']>('large-v3-turbo')
  const [language, setLanguage] = useState<string>('auto')
  const [useLlmCleanup, setUseLlmCleanup] = useState<boolean>(true)
  const [referenceLyrics, setReferenceLyrics] = useState<string>('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)

  const query = useQuery({
    queryKey: ['lyrics', job.id],
    queryFn: () => api.lyrics(job.id),
    enabled: job.status === 'READY' && canExtract,
    refetchInterval: (state) => {
      const latest = state.state.data?.[0]
      return latest && ACTIVE_STATUSES.includes(latest.status) ? 3_000 : false
    },
  })

  const create = useMutation({
    mutationFn: (opts: Partial<LyricsOptions>) => api.createLyrics(job.id, opts),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lyrics', job.id] })
      setShowOptions(false)
      toast.show('Timestamped lyrics extraction started.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const remove = useMutation({
    mutationFn: (lid: string) => api.deleteLyrics(job.id, lid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lyrics', job.id] })
      setConfirmDelete(false)
      toast.show('Karaoke lyrics deleted.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const revert = useMutation({
    mutationFn: (lid: string) => api.revertLyrics(job.id, lid),
    onSuccess: (_data, lid) => {
      void queryClient.invalidateQueries({ queryKey: ['lyrics', job.id] })
      void queryClient.invalidateQueries({ queryKey: ['lyrics-doc', job.id, lid] })
      setConfirmRevert(false)
      toast.show('Reverted to AI lyrics.', { tone: 'success' })
    },
    onError: (err) => toast.show(err.message, { tone: 'error' }),
  })

  const runExtract = () => {
    setConfirmRegenerate(false)
    create.mutate({
      stem: defaultStem,
      model,
      language: language === 'auto' ? null : language,
      reference_lyrics: referenceLyrics.trim() || null,
      use_llm_cleanup: useLlmCleanup,
    })
  }

  const latest: LyricsExtraction | undefined = query.data?.[0]
  const isActive = latest && ACTIVE_STATUSES.includes(latest.status)
  const version =
    latest?.edited_at ?? latest?.completed_at ?? latest?.updated_at ?? null

  const submitExtract = (e?: FormEvent) => {
    e?.preventDefault()
    if (latest?.edited_at) {
      setConfirmRegenerate(true)
      return
    }
    runExtract()
  }

  if (!canExtract) {
    return (
      <section className="stems-section notation-section" aria-label="Karaoke lyrics">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Karaoke</span>
            <h2>Timestamped lyrics</h2>
          </div>
          <Badge tone="neutral">Vocals stem required</Badge>
        </div>
        <div className="stem-group">
          <div className="stem-group-header">
            <div>
              <h3>Isolated vocals stem not found</h3>
              <p>
                Karaoke lyrics extraction needs the isolated <strong>Vocals</strong> stem
                (or retained Original mix). Start a new separation that includes Vocals
                to build synced karaoke lyrics.
              </p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="stems-section notation-section" aria-label="Karaoke lyrics">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Karaoke</span>
          <h2>Timestamped lyrics</h2>
        </div>
        {latest ? (
          <StatusBadge status={latest.status} />
        ) : (
          <Badge tone="teal">Whisper + Qwen3</Badge>
        )}
      </div>

      <div className="stem-group">
        <div className="stem-group-header">
          <div>
            <h3>Word-synced karaoke lyrics</h3>
            <p>
              Extracts word-level timestamps from the{' '}
              <strong>{hasVocalsStem ? 'isolated vocals' : 'original mix'}</strong>,
              groups singable lines with Qwen3, and exports <code>.ass</code>,{' '}
              <code>.lrc</code>, <code>.srt</code>, and JSON.
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
                  onClick={() => submitExtract()}
                >
                  {latest ? 'Regenerate lyrics' : 'Extract karaoke lyrics'}
                </Button>
              </>
            )}
            {latest && latest.status === 'READY' && latest.edited_at && (
              <Button
                variant="ghost"
                icon={RotateCcw}
                onClick={() => setConfirmRevert(true)}
              >
                Revert to AI version
              </Button>
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
          <form className="notation-options-form lyrics-options-form" onSubmit={submitExtract}>
            <label>
              <span>Whisper model</span>
              <select
                aria-label="Whisper model"
                value={model}
                onChange={(e) => setModel(e.target.value as LyricsOptions['model'])}
              >
                <option value="large-v3-turbo">large-v3-turbo (Fast & accurate)</option>
                <option value="large-v3">large-v3 (Maximum accuracy)</option>
                <option value="medium">medium (Lighter)</option>
              </select>
            </label>

            <label>
              <span>Language</span>
              <select
                aria-label="Language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="auto">Auto-detect</option>
                <option value="en">English (en)</option>
                <option value="es">Spanish (es)</option>
                <option value="fr">French (fr)</option>
                <option value="de">German (de)</option>
                <option value="ja">Japanese (ja)</option>
                <option value="ko">Korean (ko)</option>
                <option value="hi">Hindi (hi)</option>
                <option value="ne">Nepali (ne)</option>
              </select>
            </label>

            <label className="lyrics-checkbox-field">
              <span>Line phrasing cleanup</span>
              <div className="lyrics-checkbox-row">
                <input
                  type="checkbox"
                  checked={useLlmCleanup}
                  onChange={(e) => setUseLlmCleanup(e.target.checked)}
                />
                <span>Refine karaoke lines with Qwen3 (Ollama)</span>
              </div>
            </label>

            <label className="lyrics-reference-field">
              <span>Known lyrics (optional, enables forced alignment)</span>
              <textarea
                rows={4}
                placeholder="Paste known lyrics here to snap exact words to vocal timestamps..."
                value={referenceLyrics}
                onChange={(e) => setReferenceLyrics(e.target.value)}
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
                  ? 'Waiting for DGX Spark lyrics worker'
                  : latest.status === 'ARCHIVING'
                    ? 'Saving ASS, LRC, SRT, and JSON files'
                    : 'Aligning vocal timestamps and formatting karaoke lines'}
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
              <span className="eyebrow">Lyrics extraction stopped</span>
              <h4>Timestamped lyrics could not be generated.</h4>
              <p>
                {latest.error_message ||
                  'The lyrics processor returned an error. Try again or paste known lyrics.'}
              </p>
            </div>
          </div>
        )}

        {latest && latest.status === 'READY' && (
          <div className="notation-ready-body">
            {latest.summary && (
              <div className="notation-summary-strip">
                {latest.summary.language && (
                  <Badge tone="teal">
                    <Mic2 /> {latest.summary.language.toUpperCase()}
                  </Badge>
                )}
                <Badge tone="neutral">{latest.summary.line_count} lines</Badge>
                <Badge tone="neutral">{latest.summary.word_count} words</Badge>
                {latest.summary.aligned_with_reference && (
                  <Badge tone="teal">Forced aligned</Badge>
                )}
                {latest.summary.llm_refined && (
                  <Badge tone="amber">
                    Refined · {latest.summary.llm_model || 'Qwen3'}
                  </Badge>
                )}
                {latest.edited_at && (
                  <Badge tone="amber">
                    <Pencil /> Edited
                  </Badge>
                )}
              </div>
            )}

            <div className="notation-download-bar">
              <a
                className="button button-secondary"
                href={lyricsFileUrl(job.id, latest.id, 'ass', true, version)}
              >
                <Captions /> Download .ASS (Karaoke Video)
              </a>
              <a
                className="button button-secondary"
                href={lyricsFileUrl(job.id, latest.id, 'lrc', true, version)}
              >
                <FileText /> Download Enhanced .LRC
              </a>
              <a
                className="button button-ghost"
                href={lyricsFileUrl(job.id, latest.id, 'srt', true, version)}
              >
                <FileText /> Download .SRT
              </a>
              <a
                className="button button-ghost"
                href={lyricsFileUrl(job.id, latest.id, 'json', true, version)}
              >
                <FileJson /> Timed JSON
              </a>
            </div>

            <Suspense fallback={<Skeleton className="score-canvas-skeleton" />}>
              <KaraokePlayer job={job} lyricsId={latest.id} version={version} />
            </Suspense>
          </div>
        )}
      </div>

      {latest && (
        <>
          <ConfirmDialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => remove.mutate(latest.id)}
            title="Delete timestamped lyrics?"
            description="The generated ASS, LRC, SRT, and JSON lyrics files for this job, including any manual edits, will be removed."
            confirmLabel="Delete lyrics"
            destructive
            loading={remove.isPending}
          />
          <ConfirmDialog
            open={confirmRevert}
            onClose={() => setConfirmRevert(false)}
            onConfirm={() => revert.mutate(latest.id)}
            title="Revert to the AI-generated lyrics?"
            description="Your manual timestamp and text edits will be discarded."
            confirmLabel="Revert to AI"
            destructive
            loading={revert.isPending}
          />
          <ConfirmDialog
            open={confirmRegenerate}
            onClose={() => setConfirmRegenerate(false)}
            onConfirm={runExtract}
            title="Regenerate lyrics?"
            description="A new AI extraction will replace the edited version shown here. Your edits stay saved on the previous extraction but won't be displayed."
            confirmLabel="Regenerate"
            loading={create.isPending}
          />
        </>
      )}
    </section>
  )
}

