import { describe, expect, it } from 'vitest'
import { applicationServerKeyBytes, detectIos, getPushSupport } from './browser'
import { makeEnv, PUBLIC_KEY } from '../../test/pushEnv'

describe('detectIos', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 'iPhone', 5],
    ['iPad (old user agent)', 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)', 'iPad', 5],
    ['iPad pretending to be a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5],
  ])('recognises %s', (_name, ua, platform, touch) => {
    expect(detectIos(ua, platform, touch)).toBe(true)
  })

  it.each([
    ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 'Linux armv8l', 5],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 'Win32', 0],
  ])('does not mistake %s for an iPhone or iPad', (_name, ua, platform, touch) => {
    expect(detectIos(ua, platform, touch)).toBe(false)
  })
})

describe('getPushSupport', () => {
  it('is supported where service workers, push and notifications exist', () => {
    expect(getPushSupport(makeEnv().env)).toBe('supported')
  })

  it('on iPhone in a browser tab says to add it to the Home Screen first, even if the APIs looked present', () => {
    expect(getPushSupport(makeEnv({ isIos: true, isStandalone: false }).env)).toBe('needs-home-screen')
    expect(getPushSupport(makeEnv({ isIos: true, isStandalone: false, noPushManager: true, noNotification: true }).env)).toBe('needs-home-screen')
  })

  it('on iPhone from the Home Screen app is supported (when the APIs exist), and unsupported on an iOS too old for them', () => {
    expect(getPushSupport(makeEnv({ isIos: true, isStandalone: true }).env)).toBe('supported')
    expect(getPushSupport(makeEnv({ isIos: true, isStandalone: true, noPushManager: true, noNotification: true }).env)).toBe('unsupported')
  })

  it('a desktop browser running as an installed app is supported too', () => {
    expect(getPushSupport(makeEnv({ isStandalone: true }).env)).toBe('supported')
  })

  it.each([
    ['no service worker', { noServiceWorker: true }],
    ['no PushManager', { noPushManager: true }],
    ['no Notification API', { noNotification: true }],
    ['an insecure page', { insecure: true }],
  ])('is unsupported with %s', (_name, options) => {
    expect(getPushSupport(makeEnv(options).env)).toBe('unsupported')
  })
})

describe('applicationServerKeyBytes', () => {
  it('turns the Worker’s base64url key into its 65 bytes', () => {
    const bytes = applicationServerKeyBytes(PUBLIC_KEY)!
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(4) // an uncompressed P-256 point
  })

  it('handles the URL-safe characters - and _', () => {
    expect(applicationServerKeyBytes('-_-_')).toEqual(Uint8Array.from([0xfb, 0xff, 0xbf]))
  })

  it('returns null for text that is not base64', () => {
    expect(applicationServerKeyBytes('not base64 !!!')).toBeNull()
  })
})
