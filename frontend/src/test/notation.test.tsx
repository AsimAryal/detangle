import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DrumNotationPanel } from '../components/DrumNotationPanel'
import { ToastProvider } from '../components/ui'
import { api } from '../lib/api'
import type { Job, Transcription } from '../types'

vi.mock('../components/DrumScoreViewer', () => ({
  default: ({ musicXmlUrl }: { musicXmlUrl: string }) => (
    <div data-testid="mock-score-viewer">{musicXmlUrl}</div>
  ),
}))

function renderPanel(job: Job) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DrumNotationPanel job={job} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

const baseJob: Job = {
  id: 'job-123',
  source_type: 'upload',
  filename: 'song.mp3',
  title: 'Test Song',
  include_original: false,
  model: 'htdemucs_ft',
  output_format: 'mp3',
  mp3_bitrate: 320,
  requested_stems: ['drums', 'vocals'],
  status: 'READY',
  progress_pct: 100,
  stems: [
    { name: 'drums', size: 1024 },
    { name: 'vocals', size: 1024 },
  ],
  created_at: '2026-10-30T20:00:00Z',
}

describe('DrumNotationPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows notice when the job has no drums stem', () => {
    renderPanel({
      ...baseJob,
      stems: [{ name: 'vocals', size: 1024 }],
    })
    expect(screen.getByText(/Drums stem required/i)).toBeInTheDocument()
    expect(
      screen.getByText(/Start a new separation that includes Drums/i),
    ).toBeInTheDocument()
  })

  it('triggers createTranscription when Generate button is clicked', async () => {
    vi.spyOn(api, 'transcriptions').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'createTranscription').mockResolvedValue({
      id: 't-1',
      job_id: 'job-123',
      stem_name: 'drums',
      model: 'adtof',
      status: 'QUEUED',
      progress_pct: 0,
      options: { time_signature: 'auto', grid: 'auto', sensitivity: 0.5 },
      files: [],
      created_at: '2026-10-30T20:01:00Z',
      updated_at: '2026-10-30T20:01:00Z',
    })

    renderPanel(baseJob)
    const btn = await screen.findByRole('button', {
      name: /Generate drum notation/i,
    })
    await userEvent.click(btn)
    expect(createSpy).toHaveBeenCalledWith(
      'job-123',
      expect.objectContaining({ stem: 'drums', grid: 'auto' }),
    )
  })

  it('renders summary, download links, and score viewer when READY', async () => {
    const readyItem: Transcription = {
      id: 't-ready',
      job_id: 'job-123',
      stem_name: 'drums',
      model: 'adtof',
      status: 'READY',
      progress_pct: 100,
      options: { time_signature: '4/4', grid: '16th', sensitivity: 0.5 },
      summary: {
        tempo_bpm: 120,
        time_signature: '4/4',
        measure_count: 16,
        note_count: 140,
        counts: { kick: 40, snare: 40, hihat: 60 },
        duration_seconds: 32,
      },
      files: [
        {
          id: 'f1',
          kind: 'musicxml',
          filename: 'drums.musicxml',
          media_type: 'application/vnd.recordare.musicxml+xml',
          size: 4096,
          created_at: '2026-10-30T20:02:00Z',
        },
      ],
      created_at: '2026-10-30T20:01:00Z',
      updated_at: '2026-10-30T20:02:00Z',
    }
    vi.spyOn(api, 'transcriptions').mockResolvedValue([readyItem])

    renderPanel(baseJob)
    await waitFor(() => {
      expect(screen.getByText(/120 BPM/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/16 bars/i)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Download MusicXML/i }),
    ).toBeInTheDocument()
    expect(await screen.findByTestId('mock-score-viewer')).toBeInTheDocument()
  })
})

