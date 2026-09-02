import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  AudioLines,
  CalendarClock,
  Clock3,
  Download,
  ExternalLink,
  FileArchive,
  FileAudio,
  Gauge,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Skeleton,
  StatusBadge,
  formatBytes,
  formatDate,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'
import type { Job, Stem } from '../types'

function stemPath(jobId: string, stem: Stem, download: boolean) {
  if (download && stem.download_url) return stem.download_url
  if (!download && stem.media_url) return stem.media_url
  return `/api/jobs/${encodeURIComponent(jobId)}/stems/${encodeURIComponent(stem.name)}?download=${download ? 1 : 0}`
}

function stemLabel(stem: Stem) {
  return stem.name === 'original' ? 'Original mix' : stem.name
}

function AuthenticatedAudio({ jobId, stem }: { jobId: string; stem: Stem }) {
  const [error, setError] = useState('')

  if (error) return <p className="audio-error">Preview unavailable: {error}</p>
  return (
    <audio
      controls
      preload="metadata"
      src={stemPath(jobId, stem, false)}
      onError={() => setError('The archived audio could not be loaded.')}
    >
      Audio playback is not supported by this browser.
    </audio>
  )
}

function ProgressStage({ job }: { job: Job }) {
  const stage = job.status === 'QUEUED' ? 'Waiting for a worker' : job.status === 'PROCESSING' ? 'Separating audio layers' : 'Securing your archive'
  const progress = Math.min(100, Math.max(0, Number(job.progress_pct) || 0))
  return (
    <section className="job-progress-panel" aria-live="polite">
      <div className="progress-orbit"><LoaderCircle /></div>
      <div>
        <span className="eyebrow">{job.status.toLowerCase()}</span>
        <h2>{stage}</h2>
        <p>
          {job.status === 'QUEUED'
            ? 'This job will start as soon as processing capacity is available.'
            : job.status === 'ARCHIVING'
              ? 'Separation is complete. The final files are being prepared.'
              : 'Each selected stem is being resolved from the source signal.'}
        </p>
        <div className="detail-progress">
          <span><i style={{ width: `${Math.max(progress, 2)}%` }} /></span>
          <strong>{progress.toFixed(2)}%</strong>
        </div>
      </div>
    </section>
  )
}

export function JobDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')

  const query = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.job(id),
    enabled: Boolean(id),
    refetchInterval: (state) =>
      state.state.data &&
      ['QUEUED', 'PROCESSING', 'ARCHIVING'].includes(state.state.data.status)
        ? 3_000
        : false,
  })

  const remove = useMutation({
    mutationFn: () => api.deleteJob(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['job', id] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.show('Separation deleted.', { tone: 'success' })
      navigate('/workspace', { replace: true })
    },
    onError: (error) => toast.show(error.message, { tone: 'error' }),
  })
  const rename = useMutation({
    mutationFn: (title: string) => api.updateJob(id, title),
    onSuccess: (updated) => {
      queryClient.setQueryData(['job', id], updated)
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['admin-jobs'] })
      setEditingTitle(false)
      toast.show('Title updated.', { tone: 'success' })
    },
    onError: (error) => toast.show(error.message, { tone: 'error' }),
  })

  if (query.isLoading) {
    return (
      <div className="page detail-page">
        <Skeleton className="detail-title-skeleton" />
        <Skeleton className="detail-hero-skeleton" />
        <div className="list-skeleton"><Skeleton /><Skeleton /><Skeleton /></div>
      </div>
    )
  }
  if (query.isError || !query.data) {
    return (
      <div className="page detail-page">
        <Link className="back-link" to="/workspace"><ArrowLeft /> Workspace</Link>
        <ErrorState
          message={query.error?.message || 'This job could not be found.'}
          retry={() => void query.refetch()}
        />
      </div>
    )
  }

  const job = query.data
  const active = ['QUEUED', 'PROCESSING', 'ARCHIVING'].includes(job.status)
  const title = job.title || job.filename || 'Untitled source'
  const submitTitle = (event: FormEvent) => {
    event.preventDefault()
    const nextTitle = draftTitle.trim()
    if (nextTitle && nextTitle !== title) rename.mutate(nextTitle)
    else setEditingTitle(false)
  }

  return (
    <div className="page detail-page">
      <Link className="back-link" to="/workspace"><ArrowLeft /> Workspace</Link>
      <header className="detail-header">
        <div className="detail-title">
          <span className="file-icon large">{job.source_type === 'url' ? <Link2 /> : <FileAudio />}</span>
          <div>
            <span className="eyebrow">Separation {job.id.slice(0, 8)}</span>
            {editingTitle ? (
              <form className="title-editor" onSubmit={submitTitle}>
                <input
                  aria-label="Song title"
                  autoFocus
                  maxLength={255}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                />
                <button className="icon-button" type="submit" aria-label="Save title">
                  <Save />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Cancel title editing"
                  onClick={() => setEditingTitle(false)}
                >
                  <X />
                </button>
              </form>
            ) : (
              <span className="editable-title">
                <h1>{title}</h1>
                <button
                  className="icon-button"
                  aria-label="Edit song title"
                  onClick={() => {
                    setDraftTitle(title)
                    setEditingTitle(true)
                  }}
                >
                  <Pencil />
                </button>
              </span>
            )}
            <p>Created {formatDate(job.created_at)}</p>
            {job.source_url && (
              <a
                className="source-url"
                href={job.source_url}
                target="_blank"
                rel="noreferrer"
              >
                <Link2 /> {job.source_url} <ExternalLink />
              </a>
            )}
          </div>
        </div>
        <div className="detail-actions">
          <StatusBadge status={job.status} />
          {job.status === 'READY' && (
            <a className="button button-primary" href={`/api/jobs/${encodeURIComponent(job.id)}/download-zip`}>
              <FileArchive /> Download ZIP
            </a>
          )}
          <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </header>

      {active && <ProgressStage job={job} />}

      {job.status === 'FAILED' && (
        <section className="failure-panel" role="alert">
          <span><AlertTriangle /></span>
          <div>
            <span className="eyebrow">Processing stopped</span>
            <h2>This separation couldn’t finish.</h2>
            <p>{job.error_message || 'The processor returned an unknown error. Try a new separation or contact an administrator.'}</p>
            <Link className="button button-primary" to="/new"><RefreshCw /> Try another source</Link>
          </div>
        </section>
      )}

      {job.status === 'UNAVAILABLE' && (
        <section className="failure-panel unavailable" role="alert">
          <span><Archive /></span>
          <div>
            <span className="eyebrow">Archive unavailable</span>
            <h2>The separated files can’t be reached.</h2>
            <p>{job.error_message || 'The archive may have expired or moved. Ask an administrator to retry archival.'}</p>
          </div>
        </section>
      )}

      <section className="metadata-strip" aria-label="Job details">
        <div><Gauge /><span><small>Model</small><strong>{job.model}</strong></span></div>
        <div><AudioLines /><span><small>Output</small><strong>{job.output_format.toUpperCase()}{job.output_format === 'mp3' && job.mp3_bitrate ? ` · ${job.mp3_bitrate} kbps` : ''}</strong></span></div>
        <div><Clock3 /><span><small>Completed</small><strong>{formatDate(job.completed_at)}</strong></span></div>
        <div><CalendarClock /><span><small>Available until</small><strong>{formatDate(job.expires_at)}</strong></span></div>
      </section>

      {job.status === 'READY' && (
        <section className="stems-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Separated layers</span>
              <h2>Listen in isolation</h2>
            </div>
            <Badge tone="teal">
              {job.stems.filter((stem) => stem.name !== 'original').length} stems
              {job.stems.some((stem) => stem.name === 'original') ? ' + original mix' : ''}
            </Badge>
          </div>
          {job.stems.length ? (
            <div className="stem-list">
              {job.stems.map((stem, index) => (
                <article className="stem-row" key={stem.name}>
                  <span className="stem-number">{String(index + 1).padStart(2, '0')}</span>
                  <div className="stem-name">
                    <strong>{stemLabel(stem)}</strong>
                    <small>{formatBytes(stem.size)}</small>
                  </div>
                  <AuthenticatedAudio key={`${job.id}-${stem.name}`} jobId={job.id} stem={stem} />
                  <a
                    className="icon-button"
                    href={stemPath(job.id, stem, true)}
                    aria-label={`Download ${stemLabel(stem)}`}
                    title={`Download ${stemLabel(stem)}`}
                  >
                    <Download />
                  </a>
                </article>
              ))}
            </div>
          ) : (
            <ErrorState message="The job is ready but no stem files were returned." />
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this separation?"
        description="Its archived stems and workspace history will be removed. This cannot be undone."
        confirmLabel="Delete separation"
        destructive
        loading={remove.isPending}
      />
    </div>
  )
}
