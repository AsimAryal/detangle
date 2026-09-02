import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveRestore,
  ArrowRight,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminSubnav } from '../components/AdminSubnav'
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
  cn,
  formatDate,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'
import type { JobStatus } from '../types'

const statuses: Array<JobStatus | ''> = [
  '',
  'QUEUED',
  'PROCESSING',
  'ARCHIVING',
  'READY',
  'FAILED',
  'UNAVAILABLE',
]
const limit = 12

export function JobsPage({ admin = false }: { admin?: boolean }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState<JobStatus | ''>('')
  const [page, setPage] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(0)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const query = useQuery({
    queryKey: [admin ? 'admin-jobs' : 'jobs', status, debouncedSearch, page],
    queryFn: () =>
      (admin ? api.adminJobs : api.jobs)({
        status,
        search: debouncedSearch,
        limit,
        offset: page * limit,
      }),
    placeholderData: (previous) => previous,
    refetchInterval: (state) =>
      state.state.data?.items.some((job) =>
        ['QUEUED', 'PROCESSING', 'ARCHIVING'].includes(job.status),
      )
        ? 5_000
        : false,
  })

  const retry = useMutation({
    mutationFn: api.retryArchive,
    onSuccess: () => {
      toast.show('Archive retry queued.', { tone: 'success' })
      void queryClient.invalidateQueries({ queryKey: ['admin-jobs'] })
    },
    onError: (error) => toast.show(error.message, { tone: 'error' }),
  })

  const pages = Math.max(1, Math.ceil((query.data?.total || 0) / limit))

  return (
    <div className="page jobs-page">
      {admin && <AdminSubnav />}
      <PageHeader
        eyebrow={admin ? 'God mode · all workspaces' : 'Your workspace'}
        title={admin ? 'Every separation, one view.' : 'Work in every stage.'}
        description={
          admin
            ? 'Inspect queue activity and archive failures across every user.'
            : 'Search, monitor, download, or revisit your separated audio.'
        }
        action={!admin && <Link className="button button-primary" to="/new">New separation</Link>}
      />

      <section className="list-toolbar">
        <label className="search-control">
          <Search />
          <span className="sr-only">Search jobs</span>
          <input
            type="search"
            placeholder={admin ? 'Search files, URLs, or owners' : 'Search files or URLs'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="mobile-filter">
          <SlidersHorizontal />
          <span className="sr-only">Filter status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as JobStatus | '')
              setPage(0)
            }}
          >
            {statuses.map((item) => <option key={item || 'all'} value={item}>{item || 'All statuses'}</option>)}
          </select>
        </label>
        <div className="filter-pills" aria-label="Filter by status">
          {statuses.map((item) => (
            <button
              key={item || 'all'}
              className={cn(item === status && 'active')}
              onClick={() => {
                setStatus(item)
                setPage(0)
              }}
            >
              {item ? item[0] + item.slice(1).toLowerCase() : 'All'}
            </button>
          ))}
        </div>
      </section>

      <div className="list-summary">
        <span>{query.data?.total || 0} separation{query.data?.total === 1 ? '' : 's'}</span>
        {query.isFetching && !query.isLoading && <small>Refreshing…</small>}
      </div>

      {query.isLoading ? (
        <div className="list-skeleton">{Array.from({ length: 7 }, (_, index) => <Skeleton key={index} />)}</div>
      ) : query.isError ? (
        <ErrorState message={query.error.message} retry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState
          icon={AudioLines}
          title={search || status ? 'No matches in this layer' : 'No separations yet'}
          description={
            search || status
              ? 'Try a broader search or clear the status filter.'
              : 'Your completed and active separations will collect here.'
          }
          action={
            search || status ? (
              <Button variant="secondary" onClick={() => { setSearch(''); setStatus(''); setPage(0) }}>
                Clear filters
              </Button>
            ) : !admin ? (
              <Link className="button button-primary" to="/new">Start a separation</Link>
            ) : undefined
          }
        />
      ) : (
        <div className="job-list">
          <div className={cn('job-list-head', admin && 'with-owner')}>
            <span>Source</span>
            {admin && <span>Owner</span>}
            <span>Created</span>
            <span>Output</span>
            <span>Status</span>
            <span />
          </div>
          {query.data.items.map((job) => (
            <div className={cn('job-row', admin && 'with-owner')} key={job.id}>
              <Link className="row-link" to={`/workspace/${job.id}`} aria-label={`Open ${job.title || job.filename || job.source_url}`}>
                <span className="file-icon"><AudioLines /></span>
                <span className="job-primary">
                  <strong>{job.title || job.filename || job.source_url || 'Untitled source'}</strong>
                  <small>
                    {job.model} · {job.requested_stems.length} stems
                    {job.include_original ? ' + original mix' : ''}
                  </small>
                  {['QUEUED', 'PROCESSING', 'ARCHIVING'].includes(job.status) && (
                    <span className="row-progress"><i style={{ width: `${job.progress_pct || 2}%` }} /></span>
                  )}
                </span>
                {admin && (
                  <span className="job-owner">
                    <strong>{job.owner?.display_name || job.owner?.username || 'Unknown'}</strong>
                    <small>@{job.owner?.username || '—'}</small>
                  </span>
                )}
                <span className="job-date">{formatDate(job.created_at)}</span>
                <span className="job-format">{job.output_format.toUpperCase()}</span>
                <StatusBadge status={job.status} />
                <ArrowRight className="row-arrow" />
              </Link>
              {admin && ['FAILED', 'UNAVAILABLE'].includes(job.status) && (
                <button
                  className="row-action"
                  aria-label={`Retry archive for ${job.title || job.filename || 'job'}`}
                  title="Retry archive"
                  onClick={() => retry.mutate(job.id)}
                >
                  <ArchiveRestore />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Jobs pagination">
          <Button
            variant="ghost"
            icon={ChevronLeft}
            disabled={page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </Button>
          <span>Page <strong>{page + 1}</strong> of {pages}</span>
          <Button
            variant="ghost"
            disabled={page + 1 >= pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next <ChevronRight />
          </Button>
        </nav>
      )}
    </div>
  )
}

export function AdminJobsPage() {
  return <JobsPage admin />
}
