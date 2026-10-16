import { describe, expect, it } from 'vitest'
import { getPushWorkerUrl } from './config'

const from = (value: unknown) => getPushWorkerUrl({ VITE_PUSH_WORKER_URL: value })

describe('getPushWorkerUrl', () => {
  it('returns an https address as its origin, with no trailing slash', () => {
    expect(from('https://session-clock-push.example.workers.dev')).toBe('https://session-clock-push.example.workers.dev')
    expect(from('https://session-clock-push.example.workers.dev/')).toBe('https://session-clock-push.example.workers.dev')
  })

  it('trims whitespace and lets a custom port through', () => {
    expect(from('  https://push.example.com:8443 \n')).toBe('https://push.example.com:8443')
  })

  it('allows plain http only for localhost, for development', () => {
    expect(from('http://localhost:8787')).toBe('http://localhost:8787')
    expect(from('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787')
    expect(from('http://push.example.com')).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not text', 42],
    ['not a URL', 'push worker'],
    ['no scheme', 'push.example.com'],
    ['a different scheme', 'ftp://push.example.com'],
    ['with a path', 'https://push.example.com/api'],
    ['with a query', 'https://push.example.com/?x=1'],
    ['with a fragment', 'https://push.example.com/#x'],
    ['with credentials', 'https://user:pass@push.example.com'],
  ])('returns null when it is %s, which hides the feature', (_name, value) => {
    expect(from(value)).toBeNull()
  })

  it('reads import.meta.env by default (unset in tests)', () => {
    expect(getPushWorkerUrl()).toBeNull()
  })
})
