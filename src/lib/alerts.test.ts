import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import {
  ALERT_GRACE_MS,
  FIRED_STORAGE_KEY,
  alertKey,
  bannerMessage,
  getDueAlerts,
  isBannerExpired,
  loadFired,
  pruneFired,
  saveFired,
  windowLabels,
  type DueAlert,
} from './alerts'
import type { AlertLead } from './alertSettings'
import type { PresetGroup, TradingWindow } from './tradingWindow'
import type { StorageLike } from './windowSettings'

type Leads = Record<string, AlertLead>
const due = (leads: Leads, iso: string, fired = new Map<string, number>(), groups: PresetGroup[] = PRESET_GROUPS) =>
  getDueAlerts(groups, leads, new Date(iso), fired)
const ms = (iso: string) => Date.parse(iso)

const custom = (patch: Partial<TradingWindow>): TradingWindow => ({
  id: 'custom-test-0000',
  name: 'Test',
  shortName: 'TST',
  start: '00:10',
  end: '01:00',
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5, 6, 7],
  color: '#eab308',
  ...patch,
})
const solo = (w: TradingWindow): PresetGroup[] => [{ name: 'Mine', shortName: 'Mine', windows: [w] }]

// 2026: Wed 14 Jan, Fri 16, Sun 18, Mon 19 Jan. London winter time is UTC+0, New York winter is UTC-5.

describe('getDueAlerts: timing', () => {
  const london: Leads = { 'forex-london': 15 } // opens 08:00Z, alert at 07:45Z

  it('is due exactly at the alert time', () => {
    const [a] = due(london, '2026-01-14T07:45:00Z')
    expect(a).toMatchObject({
      windowId: 'forex-london',
      label: 'Forex London',
      leadMinutes: 15,
      openAtMs: ms('2026-01-14T08:00:00Z'),
    })
  })

  it('is not due before the alert time', () => {
    expect(due(london, '2026-01-14T07:44:59.999Z')).toEqual([])
    expect(due(london, '2026-01-14T06:00:00Z')).toEqual([])
  })

  it('stays due for the grace period, then stops', () => {
    expect(due(london, '2026-01-14T07:46:59Z')).toHaveLength(1)
    expect(due(london, new Date(ms('2026-01-14T07:45:00Z') + ALERT_GRACE_MS).toISOString())).toEqual([])
  })

  it('does not alert a page opened well after the alert time, or after the open', () => {
    expect(due(london, '2026-01-14T07:55:00Z')).toEqual([])
    expect(due(london, '2026-01-14T08:00:00Z')).toEqual([])
  })

  it('does nothing for windows with alerts off', () => {
    expect(due({}, '2026-01-14T07:45:00Z')).toEqual([])
    expect(due({ 'forex-tokyo': 15 }, '2026-01-14T07:45:00Z')).toEqual([])
  })

  it('uses each window\'s own lead time', () => {
    expect(due({ 'forex-london': 30 }, '2026-01-14T07:30:00Z')).toHaveLength(1)
    expect(due({ 'forex-london': 30 }, '2026-01-14T07:45:00Z')).toEqual([]) // 30-min alert already past its grace
    expect(due({ 'forex-london': 5 }, '2026-01-14T07:55:00Z')).toHaveLength(1)
  })

  it('returns several windows that are due together, soonest open first', () => {
    const a = custom({ id: 'custom-a-1111', name: 'Beta', start: '08:00', timeZone: 'UTC' })
    const b = custom({ id: 'custom-b-2222', name: 'Alpha', start: '08:00', timeZone: 'UTC' })
    const groups: PresetGroup[] = [{ name: 'Mine', shortName: 'Mine', windows: [a, b] }]
    const result = due({ [a.id]: 15, [b.id]: 15 }, '2026-01-14T07:45:00Z', undefined, groups)
    expect(result.map((r) => r.label)).toEqual(['Alpha', 'Beta'])
  })
})

describe('getDueAlerts: only once per occurrence', () => {
  const leads: Leads = { 'forex-london': 15 }

  it('skips an occurrence already in the fired set', () => {
    const [first] = due(leads, '2026-01-14T07:45:00Z')
    const fired = new Map([[first.key, first.openAtMs]])
    expect(due(leads, '2026-01-14T07:45:30Z', fired)).toEqual([])
    expect(due(leads, '2026-01-14T07:46:30Z', fired)).toEqual([])
  })

  it('gives the same key for the same occurrence at different moments, and a new one the next day', () => {
    const a = due(leads, '2026-01-14T07:45:00Z')[0]
    const b = due(leads, '2026-01-14T07:46:10Z')[0]
    expect(a.key).toBe(b.key)
    expect(a.key).toBe(alertKey('forex-london', ms('2026-01-14T08:00:00Z')))
    const next = due(leads, '2026-01-15T07:45:00Z', new Map([[a.key, a.openAtMs]]))
    expect(next).toHaveLength(1)
    expect(next[0].key).not.toBe(a.key)
  })
})

describe('getDueAlerts: overnight windows', () => {
  it('CME Globex (opens Sunday 18:00 New York) alerts 30 minutes before', () => {
    const [a] = due({ 'cme-equity-futures': 30 }, '2026-01-18T22:30:00Z') // Sun 17:30 NY
    expect(a.openAtMs).toBe(ms('2026-01-18T23:00:00Z'))
  })

  it('CME Globex alerts before its daily reopening after the break', () => {
    const [a] = due({ 'cme-equity-futures': 15 }, '2026-01-14T22:45:00Z') // Wed 17:45 NY
    expect(a.openAtMs).toBe(ms('2026-01-14T23:00:00Z'))
  })

  it('CME Globex does not alert for a Friday evening open that does not exist (start-day rule)', () => {
    expect(due({ 'cme-equity-futures': 30 }, '2026-01-16T22:30:00Z')).toEqual([]) // Fri 17:30 NY
  })

  it('ICT Asian (20:00 New York, ends at midnight) alerts at 19:30 on a start day only', () => {
    const [a] = due({ 'ict-asian': 30 }, '2026-01-15T00:30:00Z') // Wed 19:30 NY
    expect(a.openAtMs).toBe(ms('2026-01-15T01:00:00Z'))
    expect(due({ 'ict-asian': 30 }, '2026-01-17T00:30:00Z')).toEqual([]) // Fri 19:30 NY
    expect(due({ 'ict-asian': 30 }, '2026-01-19T00:30:00Z')).toHaveLength(1) // Sun 19:30 NY
  })

  it('an overnight custom window alerts before its start even when the alert crosses midnight', () => {
    const w = custom({ start: '23:50', end: '02:00', days: [7] }) // Sunday 23:50 -> Monday 02:00
    // Alert 15 min before: Sunday 23:35 New York = Monday 04:35Z.
    const [a] = due({ [w.id]: 15 }, '2026-01-19T04:35:00Z', undefined, solo(w))
    expect(a.openAtMs).toBe(ms('2026-01-19T04:50:00Z'))
  })
})

describe('getDueAlerts: alert time before local midnight, open after it', () => {
  const w = custom({ start: '00:10', end: '01:00' }) // opens 00:10 New York every day

  it('alerts the evening before', () => {
    // Wed 23:40 NY = Thu 04:40Z; opens Thu 00:10 NY = 05:10Z.
    const [a] = due({ [w.id]: 30 }, '2026-01-15T04:40:00Z', undefined, solo(w))
    expect(a.openAtMs).toBe(ms('2026-01-15T05:10:00Z'))
  })

  it('finds a Monday-only open from Sunday evening, though Sunday is not a start day', () => {
    const monday = custom({ start: '00:10', end: '01:00', days: [1] })
    // Sun 23:40 NY = Mon 04:40Z.
    const [a] = due({ [monday.id]: 30 }, '2026-01-19T04:40:00Z', undefined, solo(monday))
    expect(a.openAtMs).toBe(ms('2026-01-19T05:10:00Z'))
  })

  it('does not alert the evening before a day the window does not run', () => {
    const monday = custom({ start: '00:10', end: '01:00', days: [1] })
    // Mon 23:40 NY: Tuesday is not a start day.
    expect(due({ [monday.id]: 30 }, '2026-01-20T04:40:00Z', undefined, solo(monday))).toEqual([])
  })

  it('works when the alert is before midnight in the home zone but the opener is far away in UTC terms', () => {
    // Tokyo forex opens 09:00 JST. Alert 30 min before: 08:30 JST = 23:30Z the day before.
    const [a] = due({ 'forex-tokyo': 30 }, '2026-01-14T23:30:00Z')
    expect(a.openAtMs).toBe(ms('2026-01-15T00:00:00Z'))
  })
})

describe('getDueAlerts: daylight-saving changes', () => {
  const leads: Leads = { 'forex-london': 15 }
  it('follows London across the UK clock change (29 March 2026)', () => {
    // Friday 27th: GMT, opens 08:00Z. Monday 30th: BST, opens 07:00Z.
    expect(due(leads, '2026-03-27T07:45:00Z')).toHaveLength(1)
    expect(due(leads, '2026-03-30T06:45:00Z')).toHaveLength(1)
    expect(due(leads, '2026-03-30T07:45:00Z')).toEqual([])
  })

  it('uses the shifted open time for a window starting inside a spring-forward gap', () => {
    const w = custom({ start: '02:30', end: '04:00', timeZone: 'America/New_York' })
    // 2026-03-08: 02:30 does not exist, so it opens at 03:30 EDT = 07:30Z; a 15-min alert is at 07:15Z.
    const [a] = due({ [w.id]: 15 }, '2026-03-08T07:15:00Z', undefined, solo(w))
    expect(a.openAtMs).toBe(ms('2026-03-08T07:30:00Z'))
  })
})

describe('windowLabels', () => {
  const labels = windowLabels(PRESET_GROUPS)
  it('qualifies names shared by two groups and leaves unique ones alone', () => {
    expect(labels.get('forex-london')).toBe('Forex London')
    expect(labels.get('ict-london')).toBe('ICT London')
    expect(labels.get('forex-new-york')).toBe('New York')
    expect(labels.get('nyse-regular')).toBe('NYSE regular hours')
  })
})

describe('banner text and expiry', () => {
  const alert: DueAlert = {
    key: 'k',
    windowId: 'forex-london',
    label: 'London',
    color: '#fff',
    openAtMs: ms('2026-01-14T08:00:00Z'),
    leadMinutes: 15,
  }
  it('reads "opens in 15 minutes" at the alert time and counts down', () => {
    expect(bannerMessage(alert, new Date('2026-01-14T07:45:00Z'))).toBe('London opens in 15 minutes')
    expect(bannerMessage(alert, new Date('2026-01-14T07:46:00Z'))).toBe('London opens in 14 minutes')
    expect(bannerMessage(alert, new Date('2026-01-14T07:46:10Z'))).toBe('London opens in 14 minutes')
  })
  it('uses the singular for one minute, including the last seconds', () => {
    expect(bannerMessage(alert, new Date('2026-01-14T07:59:00Z'))).toBe('London opens in 1 minute')
    expect(bannerMessage(alert, new Date('2026-01-14T07:59:45Z'))).toBe('London opens in 1 minute')
  })
  it('switches to "is now open" and expires a minute after the open', () => {
    expect(bannerMessage(alert, new Date('2026-01-14T08:00:00Z'))).toBe('London is now open')
    expect(isBannerExpired(alert, new Date('2026-01-14T08:00:59Z'))).toBe(false)
    expect(isBannerExpired(alert, new Date('2026-01-14T08:01:00Z'))).toBe(true)
    expect(isBannerExpired(alert, new Date('2026-01-14T07:50:00Z'))).toBe(false)
  })
})

describe('fired alerts storage', () => {
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

  it('round-trips', () => {
    const s = fakeStorage()
    const fired = new Map([['forex-london@100', 100]])
    expect(saveFired(fired, s)).toBe(true)
    expect(loadFired(s)).toEqual(fired)
  })
  it('falls back to empty on missing, throwing or corrupt storage, and reports failed saves', () => {
    expect(loadFired(null).size).toBe(0)
    expect(loadFired(broken).size).toBe(0)
    for (const bad of ['{nope', 'null', '[]', '{"fired":[]}', '{"fired":null}']) {
      expect(loadFired(fakeStorage({ [FIRED_STORAGE_KEY]: bad })).size).toBe(0)
    }
    expect(saveFired(new Map(), null)).toBe(false)
    expect(saveFired(new Map(), broken)).toBe(false)
  })
  it('ignores non-numeric entries', () => {
    const s = fakeStorage({ [FIRED_STORAGE_KEY]: JSON.stringify({ fired: { a: 1, b: 'x', c: null } }) })
    expect([...loadFired(s)]).toEqual([['a', 1]])
  })
  it('prunes occurrences that opened more than two hours ago', () => {
    const now = ms('2026-01-14T12:00:00Z')
    const fired = new Map([
      ['old', now - 3 * 3_600_000],
      ['recent', now - 3_600_000],
      ['future', now + 600_000],
    ])
    expect([...pruneFired(fired, now).keys()]).toEqual(['recent', 'future'])
  })
})
