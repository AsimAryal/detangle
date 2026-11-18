import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KaraokeLyricsPanel } from '../components/KaraokeLyricsPanel'
import KaraokePlayer from '../components/KaraokePlayer'
import { ToastProvider } from '../components/ui'
import { api } from '../lib/api'
import type { Job, LyricsDocument, LyricsExtraction } from '../types'

function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  )
}

const baseJob: Job = {
  id: 'job-karaoke-1',
  source_type: 'upload',
  filename: 'song.mp3',
  title: 'Karaoke Song',
  include_original: false,
  model: 'htdemucs_ft',
  output_format: 'mp3',
  mp3_bitrate: 320,
  requested_stems: ['vocals', 'no_vocals'],
  status: 'READY',
  progress_pct: 100,
  stems: [
    { name: 'vocals', size: 1024 },
    { name: 'no_vocals', size: 2048 },
  ],
  created_at: '2026-11-15T18:00:00Z',
}

describe('KaraokeLyricsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows notice when job has neither vocals nor original stem', () => {
    renderWithProviders(
      <KaraokeLyricsPanel
        job={{
          ...baseJob,
          stems: [{ name: 'drums', size: 1024 }],
        }}
      />,
    )
    expect(screen.getByText(/Vocals stem required/i)).toBeInTheDocument()
  })

  it('triggers createLyrics with selected options', async () => {
    vi.spyOn(api, 'lyrics').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'createLyrics').mockResolvedValue({
      id: 'l-1',
      job_id: 'job-karaoke-1',
      stem_name: 'vocals',
      model: 'large-v3-turbo',
      status: 'QUEUED',
      progress_pct: 0,
      options: { model: 'large-v3-turbo', use_llm_cleanup: true },
      files: [],
      created_at: '2026-11-15T18:01:00Z',
      updated_at: '2026-11-15T18:01:00Z',
    })

    renderWithProviders(<KaraokeLyricsPanel job={baseJob} />)
    await userEvent.click(screen.getByRole('button', { name: /Options/i }))
    await userEvent.type(
      screen.getByPlaceholderText(/Paste known lyrics/i),
      'Hello karaoke world',
    )
    await userEvent.click(
      screen.getByRole('button', { name: /Extract karaoke lyrics/i }),
    )

    expect(createSpy).toHaveBeenCalledWith(
      'job-karaoke-1',
      expect.objectContaining({
        stem: 'vocals',
        model: 'large-v3-turbo',
        reference_lyrics: 'Hello karaoke world',
        use_llm_cleanup: true,
      }),
    )
  })

  it('renders summary, download links, and KaraokePlayer when READY', async () => {
    const readyItem: LyricsExtraction = {
      id: 'l-ready',
      job_id: 'job-karaoke-1',
      stem_name: 'vocals',
      model: 'large-v3-turbo',
      status: 'READY',
      progress_pct: 100,
      options: { model: 'large-v3-turbo', use_llm_cleanup: true },
      summary: {
        language: 'en',
        line_count: 1,
        word_count: 2,
        duration_seconds: 1.5,
        llm_refined: true,
        llm_model: 'qwen3:27b',
        aligned_with_reference: false,
      },
      files: [],
      created_at: '2026-11-15T18:01:00Z',
      updated_at: '2026-11-15T18:02:00Z',
    }
    const sampleDoc: LyricsDocument = {
      version: 1,
      title: 'Karaoke Song',
      model: 'large-v3-turbo',
      summary: readyItem.summary!,
      lines: [
        {
          index: 0,
          start: 0.2,
          end: 1.2,
          text: 'Hello world',
          words: [
            { word: 'Hello', start: 0.2, end: 0.6, score: 0.95 },
            { word: 'world', start: 0.7, end: 1.2, score: 0.98 },
          ],
        },
      ],
    }

    vi.spyOn(api, 'lyrics').mockResolvedValue([readyItem])
    vi.spyOn(api, 'lyricsDocument').mockResolvedValue(sampleDoc)

    renderWithProviders(<KaraokeLyricsPanel job={baseJob} />)

    await waitFor(() => {
      expect(screen.getByText(/1 lines/i)).toBeInTheDocument()
      expect(screen.getByText(/2 words/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /\.ASS/i })).toHaveAttribute(
      'href',
      '/api/jobs/job-karaoke-1/lyrics/l-ready/files/ass?download=1',
    )
    expect(screen.getByRole('link', { name: /\.LRC/i })).toHaveAttribute(
      'href',
      '/api/jobs/job-karaoke-1/lyrics/l-ready/files/lrc?download=1',
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument()
    })
  })
})

describe('KaraokePlayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('seeks audio when clicking a timed word', async () => {
    const doc: LyricsDocument = {
      version: 1,
      title: 'Karaoke Song',
      model: 'large-v3-turbo',
      summary: {
        language: 'en',
        line_count: 1,
        word_count: 2,
        duration_seconds: 2.0,
        llm_refined: false,
        aligned_with_reference: false,
      },
      lines: [
        {
          index: 0,
          start: 0.5,
          end: 1.5,
          text: 'Sing along',
          words: [
            { word: 'Sing', start: 0.5, end: 0.9 },
            { word: 'along', start: 1.0, end: 1.5 },
          ],
        },
      ],
    }
    vi.spyOn(api, 'lyricsDocument').mockResolvedValue(doc)
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)

    const { container } = renderWithProviders(
      <KaraokePlayer job={baseJob} lyricsId="l-1" />,
    )

    const wordBtn = await screen.findByRole('button', { name: 'along' })
    const audio = container.querySelector('audio') as HTMLAudioElement
    expect(audio).toBeTruthy()
    expect(audio.getAttribute('src')).toContain('/stems/no_vocals')

    fireEvent.click(wordBtn)
    expect(audio.currentTime).toBe(1.0)
  })
})

function editDoc(): LyricsDocument {
  return {
    version: 1,
    title: 'Karaoke Song',
    model: 'large-v3-turbo',
    summary: {
      language: 'en',
      line_count: 1,
      word_count: 2,
      duration_seconds: 2.0,
      llm_refined: false,
      aligned_with_reference: false,
    },
    lines: [
      {
        index: 0,
        start: 0.5,
        end: 1.5,
        text: 'Sing along',
        words: [
          { word: 'Sing', start: 0.5, end: 0.9 },
          { word: 'along', start: 1.0, end: 1.5 },
        ],
      },
    ],
  }
}

const savedExtraction: LyricsExtraction = {
  id: 'l-1',
  job_id: 'job-karaoke-1',
  stem_name: 'vocals',
  model: 'large-v3-turbo',
  status: 'READY',
  progress_pct: 100,
  options: { model: 'large-v3-turbo', use_llm_cleanup: true },
  files: [],
  created_at: '2026-11-15T18:01:00Z',
  updated_at: '2026-11-15T18:02:00Z',
  edited_at: '2026-11-15T18:03:00Z',
}

async function openEditor() {
  vi.spyOn(api, 'lyricsDocument').mockResolvedValue(editDoc())
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  HTMLMediaElement.prototype.pause = vi.fn()
  const utils = renderWithProviders(<KaraokePlayer job={baseJob} lyricsId="l-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Edit lyrics/i }))
  return utils
}

describe('KaraokePlayer edit mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the editor with save disabled until changes are made', async () => {
    await openEditor()
    expect(screen.getByLabelText('Line 1 text')).toHaveValue('Sing along')
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled()
  })

  it('saves edited line text', async () => {
    const saveSpy = vi.spyOn(api, 'saveLyricsDocument').mockResolvedValue(savedExtraction)
    await openEditor()
    const input = screen.getByLabelText('Line 1 text')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sing loud')
    fireEvent.blur(input)
    const saveBtn = screen.getByRole('button', { name: /Save changes/i })
    expect(saveBtn).toBeEnabled()
    await userEvent.click(saveBtn)
    expect(saveSpy).toHaveBeenCalledWith('job-karaoke-1', 'l-1', {
      lines: [expect.objectContaining({ text: 'Sing loud' })],
    })
  })

  it('nudges the selected word start', async () => {
    await openEditor()
    await userEvent.click(screen.getByRole('button', { name: 'along' }))
    expect(screen.getByLabelText('Word start (seconds)')).toHaveValue(1)
    await userEvent.click(screen.getByRole('button', { name: 'Nudge start later' }))
    expect(screen.getByLabelText('Word start (seconds)')).toHaveValue(1.05)
  })

  it('asks before discarding unsaved changes', async () => {
    await openEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Sing' }))
    await userEvent.click(screen.getByRole('button', { name: 'Shift word later' }))
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    expect(await screen.findByText(/Discard unsaved lyric edits\?/i)).toBeInTheDocument()
  })
})

