export interface WaveformData {
  duration: number
  peaksPerSec: number
  peaks: Float32Array
}

const DEFAULT_PEAKS_PER_SEC = 100
const waveformCache = new Map<string, WaveformData>()

export function extractPeaksFromChannels(
  channels: Float32Array[],
  sampleRate: number,
  duration: number,
  peaksPerSec = DEFAULT_PEAKS_PER_SEC,
): WaveformData {
  const totalBins = Math.max(1, Math.ceil(duration * peaksPerSec))
  const peaks = new Float32Array(totalBins)
  if (channels.length === 0 || sampleRate <= 0 || duration <= 0) {
    return { duration: Math.max(0, duration), peaksPerSec, peaks }
  }

  const samplesPerBin = Math.max(1, Math.floor(sampleRate / peaksPerSec))
  const length = channels[0].length
  let maxPeak = 0

  for (let bin = 0; bin < totalBins; bin += 1) {
    const start = Math.floor((bin / peaksPerSec) * sampleRate)
    const end = Math.min(length, start + samplesPerBin)
    let peak = 0
    for (let ch = 0; ch < channels.length; ch += 1) {
      const data = channels[ch]
      for (let i = start; i < end; i += 1) {
        const v = Math.abs(data[i])
        if (v > peak) peak = v
      }
    }
    peaks[bin] = peak
    if (peak > maxPeak) maxPeak = peak
  }

  if (maxPeak > 0) {
    for (let i = 0; i < peaks.length; i += 1) {
      peaks[i] /= maxPeak
    }
  }

  return { duration, peaksPerSec, peaks }
}

type AudioContextCtor = typeof AudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return win.AudioContext ?? win.webkitAudioContext ?? null
}

export function getCachedWaveform(url: string): WaveformData | null {
  return waveformCache.get(url) ?? null
}

export async function loadWaveform(
  url: string,
  signal?: AbortSignal,
): Promise<WaveformData | null> {
  const cached = waveformCache.get(url)
  if (cached) return cached

  const Ctor = getAudioContextCtor()
  if (!Ctor || typeof fetch !== 'function') return null

  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) return null
  const arrayBuffer = await response.arrayBuffer()
  if (signal?.aborted) return null

  const ctx = new Ctor()
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    if (signal?.aborted) return null
    const channels: Float32Array[] = []
    for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
      channels.push(decoded.getChannelData(ch))
    }
    const result = extractPeaksFromChannels(
      channels,
      decoded.sampleRate,
      decoded.duration,
    )
    waveformCache.set(url, result)
    return result
  } finally {
    await ctx.close().catch(() => {})
  }
}
