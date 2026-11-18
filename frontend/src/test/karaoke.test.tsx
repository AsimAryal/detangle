import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      '/api/jobs/job-karaoke-1/lyrics/l-ready/files/ass?download=1&v=2026-11-15T18%3A02%3A00Z',
    )
    expect(screen.getByRole('link', { name: /\.LRC/i })).toHaveAttribute(
      'href',
      '/api/jobs/job-karaoke-1/lyrics/l-ready/files/lrc?download=1&v=2026-11-15T18%3A02%3A00Z',
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument()
    })
  })

  it('shows Edited badge, revert flow, and regenerate warning when edited_at is set', async () => {
    const editedItem: LyricsExtraction = {
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
        llm_refined: false,
        aligned_with_reference: false,
      },
      files: [],
      created_at: '2026-11-15T18:01:00Z',
      updated_at: '2026-11-15T18:02:00Z',
      edited_at: '2026-11-15T18:05:00Z',
    }
    const sampleDoc: LyricsDocument = {
      version: 1,
      title: 'Karaoke Song',
      model: 'large-v3-turbo',
      summary: editedItem.summary!,
      lines: [
        {
          index: 0,
          start: 0.2,
          end: 1.2,
          text: 'Hello world',
          words: [
            { word: 'Hello', start: 0.2, end: 0.6 },
            { word: 'world', start: 0.7, end: 1.2 },
          ],
        },
      ],
    }

    vi.spyOn(api, 'lyrics').mockResolvedValue([editedItem])
    vi.spyOn(api, 'lyricsDocument').mockResolvedValue(sampleDoc)
    const revertSpy = vi.spyOn(api, 'revertLyrics').mockResolvedValue({
      ...editedItem,
      edited_at: null,
    })
    const createSpy = vi.spyOn(api, 'createLyrics').mockResolvedValue({
      ...editedItem,
      status: 'QUEUED',
      edited_at: null,
    })

    renderWithProviders(<KaraokeLyricsPanel job={baseJob} />)

    expect(await screen.findByText('Edited')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /\.ASS/i })).toHaveAttribute(
      'href',
      expect.stringContaining('&v=2026-11-15T18%3A05%3A00Z'),
    )

    // Regenerate warns first
    await userEvent.click(screen.getByRole('button', { name: /Regenerate lyrics/i }))
    expect(await screen.findByText(/Regenerate lyrics\?/i)).toBeInTheDocument()
    expect(createSpy).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /^Regenerate$/i }))
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1)
    })

    // Revert asks confirmation then calls revertLyrics
    await userEvent.click(screen.getByRole('button', { name: /Revert to AI version/i }))
    expect(
      await screen.findByText(/Revert to the AI-generated lyrics\?/i),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Revert to AI$/i }))
    await waitFor(() => {
      expect(revertSpy).toHaveBeenCalledWith('job-karaoke-1', 'l-ready')
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

  it('shows 3-2-1 countdown during instrumental intro and hides when toggled off', async () => {
    const doc: LyricsDocument = {
      version: 1,
      title: 'Intro Song',
      model: 'large-v3-turbo',
      summary: {
        language: 'en',
        line_count: 1,
        word_count: 2,
        duration_seconds: 8.0,
        llm_refined: false,
        aligned_with_reference: false,
      },
      lines: [
        {
          index: 0,
          start: 5.0,
          end: 6.0,
          text: 'Sing along',
          words: [
            { word: 'Sing', start: 5.0, end: 5.4 },
            { word: 'along', start: 5.5, end: 6.0 },
          ],
        },
      ],
    }
    vi.spyOn(api, 'lyricsDocument').mockResolvedValue(doc)

    const { container } = renderWithProviders(
      <KaraokePlayer job={baseJob} lyricsId="l-1" />,
    )

    await screen.findByRole('button', { name: 'Sing' })
    const audio = container.querySelector('audio') as HTMLAudioElement

    fireEvent.play(audio)
    audio.currentTime = 2.5
    fireEvent.timeUpdate(audio)
    expect(screen.getByLabelText('Countdown 3')).toBeInTheDocument()

    audio.currentTime = 4.2
    fireEvent.timeUpdate(audio)
    expect(screen.getByLabelText('Countdown 1')).toBeInTheDocument()

    audio.currentTime = 5.0
    fireEvent.timeUpdate(audio)
    expect(screen.queryByLabelText(/Countdown/i)).not.toBeInTheDocument()

    audio.currentTime = 2.5
    fireEvent.timeUpdate(audio)
    expect(screen.getByLabelText('Countdown 3')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /3·2·1 Countdown/i }))
    expect(screen.queryByLabelText(/Countdown/i)).not.toBeInTheDocument()
  })

  it('delays song playback at t=0 when lyrics begin before 3s and supports skipping', async () => {
    const doc: LyricsDocument = {
      version: 1,
      title: 'Immediate Song',
      model: 'large-v3-turbo',
      summary: {
        language: 'en',
        line_count: 1,
        word_count: 1,
        duration_seconds: 2.0,
        llm_refined: false,
        aligned_with_reference: false,
      },
      lines: [
        {
          index: 0,
          start: 0,
          end: 1.0,
          text: 'Now',
          words: [{ word: 'Now', start: 0, end: 1.0 }],
        },
      ],
    }
    vi.spyOn(api, 'lyricsDocument').mockResolvedValue(doc)
    const playMock = vi.fn().mockResolvedValue(undefined)
    const pauseMock = vi.fn()
    HTMLMediaElement.prototype.play = playMock
    HTMLMediaElement.prototype.pause = pauseMock

    const { container } = renderWithProviders(
      <KaraokePlayer job={baseJob} lyricsId="l-1" />,
    )

    await screen.findByRole('button', { name: 'Now' })
    const audio = container.querySelector('audio') as HTMLAudioElement

    fireEvent.play(audio)
    expect(pauseMock).toHaveBeenCalled()
    expect(screen.getByLabelText('Countdown 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(playMock).toHaveBeenCalled()
    expect(screen.queryByLabelText(/Countdown/i)).not.toBeInTheDocument()
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
  const dialog = screen.getByRole('dialog')
  const modal = within(dialog)
  const editorAudio = modal.getByLabelText('Lyrics editor audio') as HTMLAudioElement
  return { ...utils, dialog, modal, editorAudio }
}

describe('KaraokePlayer edit mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('opens studio modal defaulted to vocals with save disabled until changes are made', async () => {
    const { dialog, modal, editorAudio } = await openEditor()
    expect(dialog).toBeInTheDocument()
    expect(editorAudio.getAttribute('src')).toContain('/stems/vocals')
    expect(modal.getByLabelText('Line 1 text')).toHaveValue('Sing along')
    expect(modal.getByRole('button', { name: /^Save$/i })).toBeDisabled()
  })

  it('saves edited line text and keeps modal open with dirty state cleared', async () => {
    const saveSpy = vi.spyOn(api, 'saveLyricsDocument').mockResolvedValue(savedExtraction)
    const { modal } = await openEditor()
    const input = modal.getByLabelText('Line 1 text')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sing loud')
    fireEvent.blur(input)

    const saveBtn = modal.getByRole('button', { name: /^Save$/i })
    expect(saveBtn).toBeEnabled()
    await userEvent.click(saveBtn)
    expect(saveSpy).toHaveBeenCalledWith('job-karaoke-1', 'l-1', {
      lines: [expect.objectContaining({ text: 'Sing loud' })],
    })

    // Stays open, clears dirty indicator, Done closes without prompt
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(modal.getByRole('button', { name: /^Save$/i })).toBeDisabled()
    await userEvent.click(modal.getByRole('button', { name: /^Done$/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('nudges the selected word start', async () => {
    const { modal } = await openEditor()
    await userEvent.click(modal.getByRole('button', { name: 'along' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1)
    await userEvent.click(modal.getByRole('button', { name: 'Nudge start later' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1.05)
  })

  it('updates live karaoke glow immediately when increasing word end and pushes neighbor', async () => {
    const { modal, editorAudio } = await openEditor()
    await userEvent.click(modal.getByRole('button', { name: 'Sing' }))

    editorAudio.currentTime = 0.85
    fireEvent.timeUpdate(editorAudio)
    const previewSing = modal.getByText('Sing', { selector: '[data-preview-word]' })
    expect(previewSing).toHaveStyle({ '--karaoke-fill': '87.5%' })

    const endInput = modal.getByLabelText('Word end (seconds)')
    await userEvent.clear(endInput)
    await userEvent.type(endInput, '1.200')
    fireEvent.blur(endInput)

    // (0.85 - 0.50) / (1.20 - 0.50) = 50.0% without saving first
    expect(previewSing).toHaveStyle({ '--karaoke-fill': '50.0%' })
    // Neighbor 'along' pushed to start at 1.200
    await userEvent.click(modal.getByRole('button', { name: 'along' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1.2)
  })

  it('seeks via full-song seekbar and drags word edge in zoomed timeline as one undo step', async () => {
    const { modal, editorAudio } = await openEditor()

    // Overview seekbar step via keyboard
    const seekbar = modal.getByRole('slider', { name: 'Song seekbar' })
    fireEvent.keyDown(seekbar, { key: 'ArrowRight' })
    expect(editorAudio.currentTime).toBe(1)
    fireEvent.keyDown(seekbar, { key: 'ArrowLeft' })
    expect(editorAudio.currentTime).toBe(0)

    // Drag Sing's end handle in 6s zoomed window (600px wide => 100px/sec)
    const viewport = modal.getByLabelText('Zoomed waveform timeline')
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 600,
      bottom: 84,
      width: 600,
      height: 84,
      toJSON: () => ({}),
    })

    const endHandle = modal.getByRole('button', { name: 'Resize Sing end' })
    fireEvent.pointerDown(endHandle, { clientX: 90, pointerId: 1 })
    fireEvent.pointerMove(viewport, { clientX: 120, pointerId: 1 })
    fireEvent.pointerUp(viewport, { clientX: 120, pointerId: 1 })

    expect(modal.getByLabelText('Word end (seconds)')).toHaveValue(1.2)
    await userEvent.click(modal.getByRole('button', { name: 'Undo' }))
    expect(modal.getByLabelText('Word end (seconds)')).toHaveValue(0.9)
  })

  it('asks before discarding unsaved changes when closing', async () => {
    const { modal } = await openEditor()
    await userEvent.click(modal.getByRole('button', { name: 'Sing' }))
    await userEvent.click(modal.getByRole('button', { name: 'Shift word later' }))
    await userEvent.click(modal.getByRole('button', { name: /^Done$/i }))
    expect(await screen.findByText(/Discard unsaved lyric edits\?/i)).toBeInTheDocument()
  })

  it('stamps word end with ] and advances selection, then shifts with Alt+ArrowRight', async () => {
    const { modal, editorAudio } = await openEditor()

    await userEvent.click(modal.getByRole('button', { name: 'Sing' }))
    editorAudio.currentTime = 0.95
    fireEvent.keyDown(window, { key: ']' })

    // Selection moved to 'along' (start 1.000) and 'Sing' end became 0.95
    expect(modal.getByRole('button', { name: 'along' })).toHaveAttribute('aria-pressed', 'true')
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1)

    // Verify Sing end was updated to 0.950 by selecting it back
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(modal.getByRole('button', { name: 'Sing' })).toHaveAttribute('aria-pressed', 'true')
    expect(modal.getByLabelText('Word end (seconds)')).toHaveValue(0.95)

    // Alt+ArrowRight shifts selected word ('Sing') by +0.05
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(0.55)
    expect(modal.getByLabelText('Word end (seconds)')).toHaveValue(1)
  })

  it('supports [, Space, Esc, and Ctrl+S shortcuts and ignores editing keys inside inputs', async () => {
    const saveSpy = vi.spyOn(api, 'saveLyricsDocument').mockResolvedValue(savedExtraction)
    const { modal, editorAudio } = await openEditor()

    // Space toggles play/pause
    Object.defineProperty(editorAudio, 'paused', { value: true, configurable: true })
    fireEvent.keyDown(window, { key: ' ' })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()

    // Pressing [ when nothing is selected selects the first word without mutating it
    fireEvent.keyDown(window, { key: '[' })
    expect(modal.getByRole('button', { name: 'Sing' })).toHaveAttribute('aria-pressed', 'true')
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(0.5)

    // Pressing ] inside an input is ignored
    const lineInput = modal.getByLabelText('Line 1 text')
    editorAudio.currentTime = 0.8
    fireEvent.keyDown(lineInput, { key: ']' })
    expect(modal.getByRole('button', { name: 'Sing' })).toHaveAttribute('aria-pressed', 'true')

    // Pressing [ outside inputs sets selected word start to playhead
    fireEvent.keyDown(window, { key: '[' })
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(0.8)

    // Ctrl+S saves even when triggered from inside an input
    fireEvent.keyDown(lineInput, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('supports undo and redo via buttons and Ctrl+Z', async () => {
    const { modal } = await openEditor()
    expect(modal.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(modal.getByRole('button', { name: 'Redo' })).toBeDisabled()

    await userEvent.click(modal.getByRole('button', { name: 'along' }))
    await userEvent.click(modal.getByRole('button', { name: 'Nudge start later' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1.05)

    await userEvent.click(modal.getByRole('button', { name: 'Undo' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1)

    await userEvent.click(modal.getByRole('button', { name: 'Redo' }))
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1.05)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(modal.getByLabelText('Word start (seconds)')).toHaveValue(1.05)
  })

  it('switches playback speed via pills and keyboard shortcuts', async () => {
    const { modal, editorAudio } = await openEditor()

    await userEvent.click(modal.getByRole('button', { name: '0.5×' }))
    expect(editorAudio.playbackRate).toBe(0.5)

    fireEvent.keyDown(window, { key: '=' })
    expect(editorAudio.playbackRate).toBe(0.75)
  })

  it('loops the selected line with pre-roll and post-roll boundaries', async () => {
    const { modal, editorAudio } = await openEditor()
    const loopBtn = modal.getByRole('button', { name: 'Loop line 1' })

    await userEvent.click(loopBtn)
    expect(loopBtn).toHaveAttribute('aria-pressed', 'true')
    expect(modal.getByText(/Looping line 1/i)).toBeInTheDocument()

    editorAudio.currentTime = 1.7
    fireEvent.timeUpdate(editorAudio)
    expect(editorAudio.currentTime).toBe(0.25)

    await userEvent.click(modal.getByRole('button', { name: 'Stop loop' }))
    expect(loopBtn).toHaveAttribute('aria-pressed', 'false')
  })
})

