import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Database,
  HardDrive,
  Save,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AdminSubnav } from '../components/AdminSubnav'
import {
  Badge,
  Button,
  ErrorState,
  Field,
  PageHeader,
  Skeleton,
  formatBytes,
  getErrorMessage,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'

export function AdminSettingsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [retention, setRetention] = useState<number | null>(null)
  const [deleteRemote, setDeleteRemote] = useState<boolean | null>(null)
  const [error, setError] = useState('')

  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: api.settings,
  })
  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: api.overview,
    refetchInterval: 20_000,
  })

  const effectiveRetention = retention ?? settings.data?.retention_days ?? 30
  const effectiveDeleteRemote =
    deleteRemote ?? settings.data?.delete_remote_after_archive ?? false

  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        ...(settings.data || {}),
        retention_days: effectiveRetention,
        delete_remote_after_archive: effectiveDeleteRemote,
      }),
    onSuccess: () => {
      toast.show('System settings saved.', { tone: 'success' })
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
    },
    onError: (nextError) => setError(getErrorMessage(nextError)),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (
      !Number.isInteger(effectiveRetention) ||
      effectiveRetention < 1 ||
      effectiveRetention > 3650
    ) {
      setError('Retention must be between 1 and 3650 days.')
      return
    }
    save.mutate()
  }

  const archive = overview.data?.archive
  const used = archive?.used_bytes || 0
  const total = archive?.total_bytes || 0
  const storagePercent = total ? Math.round((used / total) * 100) : 0

  return (
    <div className="page settings-page">
      <AdminSubnav />
      <PageHeader
        eyebrow="God mode · system"
        title="Storage, health & policy"
        description="The operational controls behind every finished separation."
      />

      {overview.isError ? (
        <ErrorState message={overview.error.message} retry={() => void overview.refetch()} />
      ) : (
        <section className="system-health">
          <div className="section-heading">
            <div><span className="eyebrow">Live infrastructure</span><h2>System health</h2></div>
            <Badge tone="teal"><i className="pulse-dot" /> {overview.data?.health || 'Operational'}</Badge>
          </div>
          {overview.isLoading ? (
            <div className="health-strip"><Skeleton className="metric-skeleton" /><Skeleton className="metric-skeleton" /><Skeleton className="metric-skeleton" /></div>
          ) : (
            <div className="admin-health-grid">
              <div><Server /><span><small>DGX node</small><strong>{overview.data?.dgx?.status || 'Online'}</strong><p>{overview.data?.gpu?.name || 'GPU processor'}</p></span></div>
              <div><ShieldCheck /><span><small>CUDA</small><strong>{overview.data?.gpu?.cuda_available ? 'Ready' : 'Unavailable'}</strong><p>{overview.data?.queue?.processing || 0} jobs processing</p></span></div>
              <div><Database /><span><small>Queue depth</small><strong>{overview.data?.queue?.queued || 0}</strong><p>Jobs waiting for capacity</p></span></div>
            </div>
          )}
          <div className="storage-meter">
            <span><HardDrive /></span>
            <div>
              <span><strong>Archive storage</strong><small>{formatBytes(used)} of {formatBytes(total)} used</small></span>
              <div><i style={{ width: `${storagePercent}%` }} /></div>
            </div>
            <strong>{storagePercent}%</strong>
          </div>
        </section>
      )}

      <section className="settings-layout">
        <div className="policy-intro">
          <span><Archive /></span>
          <span className="eyebrow">Archive policy</span>
          <h2>Decide what stays,<br />and for how long.</h2>
          <p>
            Retention changes update existing and future archived work. Shorter
            windows reduce storage pressure but give users less time to download stems.
          </p>
        </div>
        {settings.isLoading ? (
          <Skeleton className="settings-skeleton" />
        ) : settings.isError ? (
          <ErrorState message={settings.error.message} retry={() => void settings.refetch()} />
        ) : (
          <form className="settings-form" onSubmit={submit}>
            <Field
              label="Archive retention (days)"
              type="number"
              min={1}
              max={3650}
              value={effectiveRetention}
              onChange={(event) => setRetention(Number(event.target.value))}
              hint="Between 1 day and 10 years"
            />
            <label className="switch-row danger-switch">
              <span>
                <strong><Trash2 /> Delete remote source after archive</strong>
                <small>Remove the original remote object once stems are safely archived.</small>
              </span>
              <input
                type="checkbox"
                checked={effectiveDeleteRemote}
                onChange={(event) => setDeleteRemote(event.target.checked)}
              />
              <i />
            </label>
            <div className="settings-note">
              <ShieldCheck />
              <p>Detangle always confirms archive integrity before applying remote deletion.</p>
            </div>
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button type="submit" icon={Save} loading={save.isPending}>Save policy</Button>
          </form>
        )}
      </section>
    </div>
  )
}
