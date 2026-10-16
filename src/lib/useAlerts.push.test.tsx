import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { DEFAULT_ALERT_SETTINGS } from './alertSettings'
import { useAlerts } from './useAlerts'

// ICT London opens 07:00Z (02:00 New York, winter); a 15-minute alert is due at 06:45Z.
const settings = { ...DEFAULT_ALERT_SETTINGS, lead: { 'ict-london': 15 as const }, notificationsOn: true, soundOn: false }
const before = new Date('2026-11-24T06:44:59Z')
const alertTime = new Date('2026-11-24T06:45:00Z')
const created: Array<{ title: string; options?: { tag?: string } }> = []

beforeEach(() => {
  created.length = 0
  class FakeNotification {
    static permission = 'granted'
    static requestPermission = () => Promise.resolve('granted')
    onclick: unknown = null
    constructor(title: string, options?: { tag?: string }) {
      created.push({ title, options })
    }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification)
  // The page is hidden, which is when the in-app system notification is used.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete (document as { visibilityState?: string }).visibilityState
})

const run = (pushCoversAlerts: boolean) => {
  const hook = renderHook(({ now }) => useAlerts(PRESET_GROUPS, settings, now, null, pushCoversAlerts), { initialProps: { now: before } })
  hook.rerender({ now: alertTime })
  return hook
}

describe('in-app notifications and background alerts', () => {
  it('are shown when background alerts are off', () => {
    run(false)
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe('ICT London opens in 15 minutes')
  })

  it('are not shown while background alerts are on and their schedule is uploaded (the push shows it)', () => {
    run(true)
    expect(created).toEqual([])
  })

  it('still raise the banner while background alerts are on', () => {
    const { result } = run(true)
    expect(result.current.banners.map((b) => b.label)).toEqual(['ICT London'])
  })

  it('still play the sound while background alerts are on', async () => {
    const { alertSound } = await import('./alertSound')
    const play = vi.spyOn(alertSound, 'play').mockResolvedValue(true)
    const sound = { ...settings, soundOn: true }
    const hook = renderHook(({ now }) => useAlerts(PRESET_GROUPS, sound, now, null, true), { initialProps: { now: before } })
    hook.rerender({ now: alertTime })
    expect(play).toHaveBeenCalledTimes(1)
    play.mockRestore()
  })
})
