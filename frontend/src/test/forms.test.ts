import { describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '../components/ui'
import { isAcceptedAudio, validateSourceUrl } from '../pages/NewSeparationPage'
import { validatePasswordForm } from '../pages/ProfilePage'

describe('separation source validation', () => {
  it('accepts the supported audio extensions', () => {
    for (const extension of ['mp3', 'wav', 'flac', 'ogg', 'm4a']) {
      expect(isAcceptedAudio(new File(['audio'], `track.${extension}`))).toBe(true)
    }
  })

  it('rejects unsupported files and unsafe URL protocols', () => {
    expect(isAcceptedAudio(new File(['notes'], 'notes.txt', { type: 'text/plain' }))).toBe(false)
    expect(validateSourceUrl('file:///private/audio.mp3')).toBe(false)
    expect(validateSourceUrl('not a url')).toBe(false)
    expect(validateSourceUrl('https://media.example/track.flac')).toBe(true)
  })
})

describe('password form validation', () => {
  it('requires a distinct, confirmed password of sufficient length', () => {
    expect(validatePasswordForm('old-password', 'short', 'short')).toMatch(/12 characters/)
    expect(validatePasswordForm('same-password', 'same-password', 'same-password')).toMatch(/differs/)
    expect(validatePasswordForm('old-password', 'A-new-password1', 'another-password')).toMatch(/does not match/)
    expect(validatePasswordForm('old-password', 'A-new-password1', 'A-new-password1')).toBe('')
  })
})

describe('clipboard fallback', () => {
  it('copies credentials on non-secure LAN origins', async () => {
    const copy = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: copy,
    })

    await expect(copyToClipboard('listener\nsecure-password')).resolves.toBe(true)
    expect(copy).toHaveBeenCalledWith('copy')
  })
})
