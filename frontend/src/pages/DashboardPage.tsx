import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  AudioLines,
  Database,
  Gauge,
  HardDrive,
  Plus,
  Server,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
  formatBytes,
  formatDate,
} from '../components/ui'
import { api } from '../lib/api'
import type { Job } from '../types'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'normal',
}: {
  icon: typeof Gauge
  label: string
  value: string
  detail: string
  tone?: 'normal' | 'good' | 'warn'
}) {
  return (
    <div className={`health-metric health-${tone}`}>
      <span><Icon /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  )
}

function RecentJobs({ jobs }: { jobs: Job[] }) {
  if (!jobs.length) {
    return (
      <EmptyState
        icon={AudioLines}
        title="Your workspace is quiet"
        description="Start a separation and its progress will appear here."
        action={<Link className="button button-primary" to="/new"><Plus /> New separation</Link>}
      />
    )
  }
  return (
    <div className="job-list compact">
      {jobs.map((job) => (
        <Link to={`/workspace/${job.id}`} className="job-row" key={job.id}>
          <span className="file-icon"><AudioLines /></span>
          <span className="job-primary">
            <strong>{job.title || job.filename || job.source_url || 'Untitled source'}</strong>
            <small>{job.model} · {formatDate(job.created_at)}</small>
          </span>
          <span className="job-format">{job.output_format.toUpperCase()}</span>
          <StatusBadge status={job.status} />
          <ArrowRight className="row-arrow" />
        </Link>
      ))}
    </div>
  )
}

export function DashboardPage() {
  const { user } = useAuth()
  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: api.overview,
    refetchInterval: 30_000,
  })
  const recent = useQuery({
    queryKey: ['jobs', 'recent'],
    queryFn: () => api.jobs({ limit: 5, offset: 0 }),
  })

  if (overview.isError) {
    return (
      <div className="page">
        <ErrorState
          message={overview.error.message}
          retry={() => void overview.refetch()}
        />
      </div>
    )
  }

  const data = overview.data
  const archive = data?.archive
  const used = archive?.used_bytes || 0
  const total = archive?.total_bytes || 0
  const storagePct = total ? Math.round((used / total) * 100) : 0
  const active =
    (data?.queue?.queued || 0) + (data?.queue?.processing || 0)
  const ready = data?.counts?.READY || 0

  return (
    <div className="page dashboard">
      <PageHeader
        eyebrow="Workspace overview"
        title={`${greeting()}, ${user?.display_name || user?.username}.`}
        description="Your separation desk and system pulse, at a glance."
        action={<Link className="button button-primary" to="/new"><Plus /> New separation</Link>}
      />

      <section className="dashboard-lead">
        <div className="lead-copy">
          <span className="signal-chip"><i /> Ready for audio</span>
          <h2>Pull the signal apart.<br /><em>Keep the feeling intact.</em></h2>
          <p>Choose a local file or paste a source URL. Detangle handles the rest.</p>
          <Link to="/new" className="text-link">
            Start separating <ArrowRight />
          </Link>
        </div>
        <div className="lead-visual" aria-hidden="true">
          {Array.from({ length: 48 }, (_, index) => (
            <i
              key={index}
              style={{
                height: `${10 + ((index * 17) % 82)}%`,
                animationDelay: `${index * -35}ms`,
              }}
            />
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live infrastructure</span>
            <h2>System pulse</h2>
          </div>
          <span className="last-updated">Updates every 30 seconds</span>
        </div>
        {overview.isLoading ? (
          <div className="health-strip">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="metric-skeleton" />)}
          </div>
        ) : (
          <div className="health-strip">
            <Metric
              icon={Gauge}
              label="Queue"
              value={`${active} active`}
              detail={`${data?.queue?.queued || 0} waiting`}
              tone={active > 8 ? 'warn' : 'good'}
            />
            <Metric
              icon={Server}
              label="GPU / DGX"
              value={data?.gpu?.status || data?.dgx?.status || 'Online'}
              detail={data?.gpu?.name || `${data?.gpu?.utilization_pct || 0}% utilization`}
              tone="good"
            />
            <Metric
              icon={HardDrive}
              label="Archive"
              value={`${storagePct}% used`}
              detail={`${formatBytes(used)} of ${formatBytes(total)}`}
              tone={storagePct > 85 ? 'warn' : 'normal'}
            />
            <Metric
              icon={Database}
              label="Ready files"
              value={String(ready)}
              detail={`${data?.counts?.FAILED || 0} need attention`}
            />
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest activity</span>
            <h2>Recent separations</h2>
          </div>
          <Link className="text-link" to="/workspace">View workspace <ArrowRight /></Link>
        </div>
        {recent.isLoading ? (
          <div className="list-skeleton">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} />)}</div>
        ) : recent.isError ? (
          <ErrorState message={recent.error.message} retry={() => void recent.refetch()} />
        ) : (
          <RecentJobs jobs={data?.recent_jobs || recent.data?.items || []} />
        )}
      </section>
    </div>
  )
}
