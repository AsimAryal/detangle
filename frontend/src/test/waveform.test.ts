import { describe, expect, it } from 'vitest'
import { extractPeaksFromChannels } from '../lib/waveform'

describe('extractPeaksFromChannels', () => {
  it('downsamples and normalizes multi-channel peaks', () => {
    // 1 second at 1000 Hz -> 100 bins of 10 samples each
    const left = new Float32Array(1000)
    const right = new Float32Array(1000)
    left[5] = 0.25
    right[505] = -0.5 // max peak = 0.5 across both channels

    const res = extractPeaksFromChannels([left, right], 1000, 1.0, 100)
    expect(res.peaksPerSec).toBe(100)
    expect(res.peaks).toHaveLength(100)
    expect(res.peaks[0]).toBeCloseTo(0.5, 4)
    expect(res.peaks[50]).toBeCloseTo(1.0, 4)
    expect(res.peaks[10]).toBe(0)
  })

  it('handles empty channels gracefully', () => {
    const res = extractPeaksFromChannels([], 44100, 0, 100)
    expect(res.peaks).toHaveLength(1)
    expect(res.peaks[0]).toBe(0)
  })
})
