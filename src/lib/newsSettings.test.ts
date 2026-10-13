import { describe, expect, it } from 'vitest'
import { DEFAULT_NEWS_SETTINGS, NEWS_STORAGE_KEY, loadNewsSettings, saveNewsSettings } from './newsSettings'
import type { StorageLike } from './windowSettings'

const fakeStorage = (initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...initial }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}
const broken: StorageLike = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('quota')
  },
}
const stored = (value: unknown) => fakeStorage({ [NEWS_STORAGE_KEY]: JSON.stringify(value) })

describe('news settings', () => {
  it('defaults to on, with no alert', () => {
    expect(DEFAULT_NEWS_SETTINGS).toEqual({ enabled: true, alertLead: null })
    expect(loadNewsSettings(fakeStorage())).toEqual(DEFAULT_NEWS_SETTINGS)
  })

  it('reads saved settings', () => {
    expect(loadNewsSettings(stored({ enabled: false, alert: 15 }))).toEqual({ enabled: false, alertLead: 15 })
    expect(loadNewsSettings(stored({ enabled: true, alert: 5 }))).toEqual({ enabled: true, alertLead: 5 })
  })

  it('checks each field on its own: bad values fall back to the default for that field only', () => {
    expect(loadNewsSettings(stored({ enabled: 'no', alert: 30 }))).toEqual({ enabled: true, alertLead: 30 })
    expect(loadNewsSettings(stored({ enabled: false, alert: 10 }))).toEqual({ enabled: false, alertLead: null })
    expect(loadNewsSettings(stored({ enabled: false, alert: null }))).toEqual({ enabled: false, alertLead: null })
    expect(loadNewsSettings(stored({ enabled: false }))).toEqual({ enabled: false, alertLead: null })
  })

  it('falls back to the defaults for corrupt data or unavailable storage', () => {
    for (const bad of ['{nope', 'null', '5', '[]']) {
      expect(loadNewsSettings(fakeStorage({ [NEWS_STORAGE_KEY]: bad }))).toEqual(DEFAULT_NEWS_SETTINGS)
    }
    expect(loadNewsSettings(null)).toEqual(DEFAULT_NEWS_SETTINGS)
    expect(loadNewsSettings(broken)).toEqual(DEFAULT_NEWS_SETTINGS)
  })

  it('saves and round-trips, and reports failure instead of throwing', () => {
    const s = fakeStorage()
    expect(saveNewsSettings({ enabled: false, alertLead: 30 }, s)).toBe(true)
    expect(loadNewsSettings(s)).toEqual({ enabled: false, alertLead: 30 })
    expect(saveNewsSettings(DEFAULT_NEWS_SETTINGS, null)).toBe(false)
    expect(saveNewsSettings(DEFAULT_NEWS_SETTINGS, broken)).toBe(false)
  })
})
