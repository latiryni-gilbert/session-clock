import { describe, expect, it } from 'vitest'
import {
  ALERTS_STORAGE_KEY,
  ALERT_LEADS,
  DEFAULT_ALERT_SETTINGS,
  getAlertLead,
  loadAlertSettings,
  removeAlert,
  saveAlertSettings,
  setAlertLead,
  setSoundOn,
} from './alertSettings'
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
const stored = (value: unknown) => fakeStorage({ [ALERTS_STORAGE_KEY]: JSON.stringify(value) })

describe('defaults', () => {
  it('offers Off plus 5, 15 and 30 minutes, with every alert off and sound on by default', () => {
    expect([...ALERT_LEADS]).toEqual([5, 15, 30])
    expect(DEFAULT_ALERT_SETTINGS).toEqual({ lead: {}, soundOn: true })
    expect(loadAlertSettings(fakeStorage())).toEqual(DEFAULT_ALERT_SETTINGS)
  })
})

describe('changing settings', () => {
  it('sets, changes and clears a window\'s lead time without mutating the old settings', () => {
    const a = setAlertLead(DEFAULT_ALERT_SETTINGS, 'forex-london', 15)
    expect(getAlertLead(a, 'forex-london')).toBe(15)
    expect(getAlertLead(DEFAULT_ALERT_SETTINGS, 'forex-london')).toBeNull()
    const b = setAlertLead(a, 'forex-london', 30)
    expect(getAlertLead(b, 'forex-london')).toBe(30)
    expect(getAlertLead(a, 'forex-london')).toBe(15)
    expect(getAlertLead(setAlertLead(b, 'forex-london', null), 'forex-london')).toBeNull()
  })

  it('removeAlert forgets only that window\'s setting', () => {
    const s = setAlertLead(setAlertLead(DEFAULT_ALERT_SETTINGS, 'forex-london', 15), 'forex-tokyo', 5)
    const r = removeAlert(s, 'forex-london')
    expect(r.lead).toEqual({ 'forex-tokyo': 5 })
    expect(removeAlert(DEFAULT_ALERT_SETTINGS, 'nope')).toEqual(DEFAULT_ALERT_SETTINGS)
  })

  it('toggles sound without touching the leads', () => {
    const s = setAlertLead(DEFAULT_ALERT_SETTINGS, 'forex-london', 15)
    expect(setSoundOn(s, false)).toEqual({ lead: { 'forex-london': 15 }, soundOn: false })
  })
})

describe('loading', () => {
  it('reads saved settings', () => {
    expect(loadAlertSettings(stored({ lead: { 'forex-london': 15, 'ict-asian': 5 }, sound: false }))).toEqual({
      lead: { 'forex-london': 15, 'ict-asian': 5 },
      soundOn: false,
    })
  })

  it('drops unknown ids and unsupported lead times, keeping the rest', () => {
    const s = stored({ lead: { 'forex-london': 15, removed: 15, 'forex-tokyo': 10, 'ict-asian': '5', 'nyse-regular': 0 } })
    expect(loadAlertSettings(s).lead).toEqual({ 'forex-london': 15 })
  })

  it('accepts custom ids when they are passed as known', () => {
    const s = stored({ lead: { 'custom-x-1': 30 } })
    expect(loadAlertSettings(s).lead).toEqual({})
    expect(loadAlertSettings(s, ['custom-x-1']).lead).toEqual({ 'custom-x-1': 30 })
  })

  it('defaults sound to on unless a boolean is saved', () => {
    expect(loadAlertSettings(stored({ lead: {} })).soundOn).toBe(true)
    expect(loadAlertSettings(stored({ lead: {}, sound: 'no' })).soundOn).toBe(true)
  })

  it('falls back to the defaults for corrupt data or unavailable storage', () => {
    for (const bad of ['{nope', 'null', '5', '[]', '{"lead":"x"}', '{"lead":[]}']) {
      expect(loadAlertSettings(fakeStorage({ [ALERTS_STORAGE_KEY]: bad }))).toMatchObject({ lead: {} })
    }
    expect(loadAlertSettings(null)).toEqual(DEFAULT_ALERT_SETTINGS)
    expect(loadAlertSettings(broken)).toEqual(DEFAULT_ALERT_SETTINGS)
  })
})

describe('saving', () => {
  it('round-trips', () => {
    const s = fakeStorage()
    const settings = setSoundOn(setAlertLead(DEFAULT_ALERT_SETTINGS, 'forex-london', 30), false)
    expect(saveAlertSettings(settings, s)).toBe(true)
    expect(loadAlertSettings(s)).toEqual(settings)
  })
  it('reports failure instead of throwing', () => {
    expect(saveAlertSettings(DEFAULT_ALERT_SETTINGS, null)).toBe(false)
    expect(saveAlertSettings(DEFAULT_ALERT_SETTINGS, broken)).toBe(false)
  })
  it('leaves no trace of a removed window', () => {
    const s = fakeStorage()
    saveAlertSettings(removeAlert(setAlertLead(DEFAULT_ALERT_SETTINGS, 'custom-x-1', 15), 'custom-x-1'), s)
    expect(s.data[ALERTS_STORAGE_KEY]).not.toContain('custom-x-1')
  })
})
