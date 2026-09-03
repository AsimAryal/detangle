import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AudioWaveform,
  Check,
  FileAudio,
  Gauge,
  Link2,
  RotateCcw,
  Sparkles,
  UploadCloud,
  X,
  Zap,
} from 'lucide-react'
import {
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  ErrorState,
  PageHeader,
  Select,
  cn,
  formatBytes,
  formatStemLabel,
  getErrorMessage,
  useToast,
} from '../components/ui'
import { api, uploadJob } from '../lib/api'
import type { Model, SeparationOptions } from '../types'

const acceptedExtensions = ['mp3', 'wav', 'flac', 'ogg', 'm4a']
const acceptedTypes = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
])

export function isAcceptedAudio(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return acceptedTypes.has(file.type) || Boolean(extension && acceptedExtensions.includes(extension))
}

export function validateSourceUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function ModelOption({
  model,
  selected,
  onSelect,
}: {
  model: Model
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn('model-option', selected && 'selected')}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="model-radio">{selected && <Check />}</span>
      <span className="model-copy">
        <span>
          <strong>{model.name}</strong>
          {model.is_default && <small>Recommended</small>}
        </span>
        <p>{model.description}</p>
        <span className="model-meta">
          <i><AudioWaveform /> {model.stems.length} stems</i>
          <i><Sparkles /> {String(model.quality || 'Balanced')} quality</i>
          <i><Zap /> {String(model.speed || 'Standard')} speed</i>
        </span>
      </span>
    </button>
  )
}

export function NewSeparationPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const [tab, setTab] = useState<'upload' | 'url'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [dragging, setDragging] = useState(false)
  const [modelName, setModelName] = useState('')
  const [stems, setStems] = useState<string[] | null>(null)
  const [outputFormat, setOutputFormat] = useState<'mp3' | 'wav'>('mp3')
  const [bitrate, setBitrate] = useState(320)
  const [includeOriginal, setIncludeOriginal] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const models = useQuery({
    queryKey: ['system', 'models'],
    queryFn: api.models,
    staleTime: 5 * 60_000,
  })

  const initialModel =
    models.data?.find((model) => model.is_default) || models.data?.[0]
  const effectiveModelName = modelName || initialModel?.id || ''
  const selectedModel = models.data?.find(
    (model) => model.id === effectiveModelName,
  )
  const baseStems = selectedModel?.stems ?? []
  const backingStems = baseStems.map((stem) => `no_${stem}`)
  const effectiveStems = stems ?? baseStems

  const urlMutation = useMutation({
    mutationFn: ({ source, options }: { source: string; options: SeparationOptions }) =>
      api.submitUrl(source, options),
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.show('Separation added to the queue.', { tone: 'success' })
      navigate(`/workspace/${job.id}`)
    },
  })

  const chooseFile = (nextFile?: File) => {
    setError('')
    if (!nextFile) return
    if (!isAcceptedAudio(nextFile)) {
      setFile(null)
      setError('Choose an MP3, WAV, FLAC, OGG, or M4A audio file.')
      return
    }
    setFile(nextFile)
  }

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    chooseFile(event.dataTransfer.files[0])
  }

  const options: SeparationOptions = {
    model: effectiveModelName,
    output_format: outputFormat,
    mp3_bitrate: bitrate,
    stems: effectiveStems,
    include_original: tab === 'url' && includeOriginal,
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!effectiveModelName || !effectiveStems.length) {
      setError('Choose a model and at least one stem.')
      return
    }
    if (tab === 'url') {
      if (!validateSourceUrl(url)) {
        setError('Enter a complete HTTP or HTTPS source URL.')
        return
      }
      try {
        await urlMutation.mutateAsync({ source: url, options })
      } catch (nextError) {
        setError(getErrorMessage(nextError))
      }
      return
    }
    if (!file) {
      setError('Choose an audio file to continue.')
      return
    }

    setUploading(true)
    setUploadProgress(0)
    const upload = uploadJob(file, options, setUploadProgress)
    cancelRef.current = upload.cancel
    try {
      const job = await upload.promise
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.show('Upload complete. Separation queued.', { tone: 'success' })
      navigate(`/workspace/${job.id}`)
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === 'AbortError')) {
        setError(getErrorMessage(nextError))
      }
    } finally {
      setUploading(false)
      setUploadProgress(null)
      cancelRef.current = null
    }
  }

  return (
    <div className="page new-page">
      <PageHeader
        eyebrow="New separation"
        title="Find the parts inside the whole."
        description="Bring a track, choose how to listen, then let Detangle split the layers."
      />

      <form className="separation-form" onSubmit={submit}>
        <section className="form-section source-section">
          <div className="numbered-heading">
            <span>01</span>
            <div><h2>Choose a source</h2><p>Upload audio or point to a public URL.</p></div>
          </div>
          <div className="tab-list" role="tablist" aria-label="Source type">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'upload'}
              className={tab === 'upload' ? 'active' : ''}
              onClick={() => setTab('upload')}
            >
              <UploadCloud /> Local file
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'url'}
              className={tab === 'url' ? 'active' : ''}
              onClick={() => setTab('url')}
            >
              <Link2 /> Source URL
            </button>
          </div>

          {tab === 'upload' ? (
            <div
              className={cn('drop-zone', dragging && 'dragging', file && 'has-file')}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={drop}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
              }}
              role="button"
              tabIndex={0}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".mp3,.wav,.flac,.ogg,.m4a,audio/*"
                hidden
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
              {file ? (
                <>
                  <span className="source-icon"><FileAudio /></span>
                  <div><strong>{file.name}</strong><p>{formatBytes(file.size)} · Ready to upload</p></div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove file"
                    onClick={(event) => {
                      event.stopPropagation()
                      setFile(null)
                    }}
                  >
                    <X />
                  </button>
                </>
              ) : (
                <>
                  <span className="source-icon"><UploadCloud /></span>
                  <div>
                    <strong>Drop your audio here</strong>
                    <p>or click to browse · MP3, WAV, FLAC, OGG, M4A</p>
                  </div>
                </>
              )}
            </div>
          ) : (
            <label className="url-input">
              <span className="source-icon"><Link2 /></span>
              <span>
                <small>Audio source URL</small>
                <input
                  type="url"
                  value={url}
                  placeholder="https://example.com/audio"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </span>
            </label>
          )}
        </section>

        <section className="form-section">
          <div className="numbered-heading">
            <span>02</span>
            <div><h2>Select a separation model</h2><p>Trade precision for speed, depending on the track.</p></div>
          </div>
          {models.isLoading ? (
            <div className="model-loading" aria-label="Loading models">
              {Array.from({ length: 6 }, (_, index) => <i key={index} />)}
            </div>
          ) : models.isError ? (
            <ErrorState message={models.error.message} retry={() => void models.refetch()} />
          ) : (
            <div className="model-list">
              {models.data?.map((model) => (
                <ModelOption
                  key={model.id}
                  model={model}
                  selected={model.id === effectiveModelName}
                  onSelect={() => {
                    setModelName(model.id)
                    setStems(model.stems)
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section className="form-section options-section">
          <div className="numbered-heading">
            <span>03</span>
            <div><h2>Shape the output</h2><p>Choose which layers to keep and how they’re encoded.</p></div>
          </div>
          <div className="options-grid">
            <div className="stem-selection-panel">
              <div className="stem-section-header">
                <span className="eyebrow">Requested Layers</span>
                <div className="stem-quick-actions">
                  <button
                    type="button"
                    className="text-link-button"
                    onClick={() => setStems([...baseStems])}
                  >
                    Isolated only
                  </button>
                  <span className="sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="text-link-button"
                    onClick={() => setStems([...backingStems])}
                  >
                    Backing only
                  </button>
                  <span className="sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="text-link-button"
                    onClick={() => setStems([...baseStems, ...backingStems])}
                  >
                    All layers
                  </button>
                </div>
              </div>

              <fieldset className="stem-picker">
                <legend>Isolated stems</legend>
                <div>
                  {baseStems.map((stem) => (
                    <label key={stem}>
                      <input
                        type="checkbox"
                        checked={effectiveStems.includes(stem)}
                        onChange={(event) =>
                          setStems((current) =>
                            event.target.checked
                              ? [...(current ?? effectiveStems), stem]
                              : (current ?? effectiveStems).filter((item) => item !== stem),
                          )
                        }
                      />
                      <span><Check /></span>
                      {formatStemLabel(stem)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="stem-picker">
                <legend>Stem-less backing tracks (Minus-one)</legend>
                <div>
                  {backingStems.map((stem) => (
                    <label key={stem} title={`Backing track without ${stem.slice(3)}`}>
                      <input
                        type="checkbox"
                        checked={effectiveStems.includes(stem)}
                        onChange={(event) =>
                          setStems((current) =>
                            event.target.checked
                              ? [...(current ?? effectiveStems), stem]
                              : (current ?? effectiveStems).filter((item) => item !== stem),
                          )
                        }
                      />
                      <span><Check /></span>
                      {formatStemLabel(stem)}
                    </label>
                  ))}
                </div>
              </fieldset>

              {tab === 'url' && (
                <fieldset className="stem-picker">
                  <legend>Source retention</legend>
                  <div>
                    <label title="Keep the complete downloaded song alongside its stems">
                      <input
                        type="checkbox"
                        checked={includeOriginal}
                        onChange={(event) => setIncludeOriginal(event.target.checked)}
                      />
                      <span><Check /></span>
                      Original mix (WAV)
                    </label>
                  </div>
                </fieldset>
              )}
            </div>
            <div className="encoding-options">
              <fieldset className="segmented">
                <legend>Output format</legend>
                <label>
                  <input type="radio" name="format" checked={outputFormat === 'mp3'} onChange={() => setOutputFormat('mp3')} />
                  <span>MP3 <small>Compact</small></span>
                </label>
                <label>
                  <input type="radio" name="format" checked={outputFormat === 'wav'} onChange={() => setOutputFormat('wav')} />
                  <span>WAV <small>Lossless</small></span>
                </label>
              </fieldset>
              <Select
                label="MP3 bitrate"
                value={bitrate}
                disabled={outputFormat === 'wav'}
                onChange={(event) => setBitrate(Number(event.target.value))}
              >
                <option value={128}>128 kbps</option>
                <option value={192}>192 kbps</option>
                <option value={256}>256 kbps</option>
                <option value={320}>320 kbps</option>
              </Select>
            </div>
          </div>
        </section>

        <div className="submit-dock">
          <div>
            <Gauge />
            <span>
              <strong>{selectedModel?.name || 'Choose a model'}</strong>
              <small>
                {effectiveStems.length} stems
                {tab === 'url' && includeOriginal ? ' + original mix' : ''}
                {' · '}{outputFormat.toUpperCase()}
                {outputFormat === 'mp3' ? ` ${bitrate} kbps` : ''}
              </small>
            </span>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {uploading && (
            <div className="upload-progress">
              <span><i style={{ width: `${uploadProgress || 0}%` }} /></span>
              <strong>{uploadProgress || 0}%</strong>
            </div>
          )}
          {uploading ? (
            <Button type="button" variant="danger" icon={X} onClick={() => cancelRef.current?.()}>
              Cancel upload
            </Button>
          ) : (
            <Button
              type="submit"
              icon={tab === 'upload' ? UploadCloud : RotateCcw}
              loading={urlMutation.isPending}
              disabled={models.isLoading || models.isError}
            >
              {tab === 'upload' ? 'Upload & separate' : 'Queue separation'}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
