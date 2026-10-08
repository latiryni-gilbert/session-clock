import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import {
  ALERT_LOOKBACK_MS,
  BANNER_LINGER_MS,
  FIRED_STORAGE_KEY,
  SOUND_MAX_AGE_MS,
  alertKey,
  bannerMessage,
  getDueAlerts,
  isBannerExpired,
  isFreshAlert,
  loadFired,
  pruneFired,
  saveFired,
  stampOpenSeen,
  windowLabels,
  type DueAlert,
} from './alerts'
import type { AlertLead } from './alertSettings'
import type { PresetGroup, TradingWindow } from './tradingWindow'
import type { StorageLike } from './windowSettings'

type Leads = Record<string, AlertLead>
/**
 * Alerts due at `iso`, as an ordinary once-a-second check would see them: the previous check was
 * one second earlier unless `since` says otherwise.
 */
const due = (
  leads: Leads,
  iso: string,
  fired = new Map<string, number>(),
  groups: PresetGroup[] = PRESET_GROUPS,
  since?: string,
) => {
  const now = new Date(iso)
  return getDueAlerts(groups, leads, now, fired, since ? new Date(since) : new Date(now.getTime() - 1000))
}
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

  it('is due once: each alert time falls in exactly one check interval', () => {
    // since is exclusive, now is inclusive.
    expect(due(london, '2026-01-14T07:45:00Z', undefined, undefined, '2026-01-14T07:44:00Z')).toHaveLength(1)
    expect(due(london, '2026-01-14T07:46:00Z', undefined, undefined, '2026-01-14T07:45:00Z')).toEqual([])
  })

  it('does not alert a page opened well after the alert time, or after the open', () => {
    expect(due(london, '2026-01-14T07:55:00Z')).toEqual([])
    expect(due(london, '2026-01-14T08:00:00Z')).toEqual([])
  })

  it('on first load, still catches an alert from the last couple of minutes', () => {
    const now = '2026-01-14T07:46:30Z'
    const since = new Date(Date.parse(now) - ALERT_LOOKBACK_MS).toISOString()
    expect(due(london, now, undefined, undefined, since)).toHaveLength(1)
    const later = '2026-01-14T07:48:00Z'
    expect(due(london, later, undefined, undefined, new Date(Date.parse(later) - ALERT_LOOKBACK_MS).toISOString())).toEqual([])
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
    // Even if a check interval covers the alert time again (e.g. after a refresh), it is not repeated.
    expect(due(leads, '2026-01-14T07:45:30Z', fired, undefined, '2026-01-14T07:00:00Z')).toEqual([])
    expect(due(leads, '2026-01-14T07:46:30Z', fired, undefined, '2026-01-14T07:00:00Z')).toEqual([])
  })

  it('gives the same key for the same occurrence at different moments, and a new one the next day', () => {
    const a = due(leads, '2026-01-14T07:45:00Z')[0]
    const b = due(leads, '2026-01-14T07:46:10Z', undefined, undefined, '2026-01-14T07:00:00Z')[0]
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
    alertAtMs: ms('2026-01-14T07:45:00Z'),
    openAtMs: ms('2026-01-14T08:00:00Z'),
    endAtMs: ms('2026-01-14T17:00:00Z'),
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
  it('says "is now open", then how long ago it opened, then that it has closed', () => {
    expect(bannerMessage(alert, new Date('2026-01-14T08:00:00Z'))).toBe('London is now open')
    expect(bannerMessage(alert, new Date('2026-01-14T08:00:59Z'))).toBe('London is now open')
    expect(bannerMessage(alert, new Date('2026-01-14T08:01:00Z'))).toBe('London opened 1 minute ago')
    expect(bannerMessage(alert, new Date('2026-01-14T08:04:30Z'))).toBe('London opened 4 minutes ago')
    expect(bannerMessage(alert, new Date('2026-01-14T10:05:00Z'))).toBe('London opened 2h 05m ago')
    expect(bannerMessage(alert, new Date('2026-01-14T17:00:00Z'))).toBe('London has closed')
  })
  it('is worked out from the current time on every call, never fixed when the alert fired', () => {
    const texts = ['07:45', '07:50', '07:58', '08:00', '08:09'].map((t) => bannerMessage(alert, new Date(`2026-01-14T${t}:00Z`)))
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts).toEqual([
      'London opens in 15 minutes',
      'London opens in 10 minutes',
      'London opens in 2 minutes',
      'London is now open',
      'London opened 9 minutes ago',
    ])
  })
})

describe('banner lifetime', () => {
  const base: DueAlert = {
    key: 'k',
    windowId: 'forex-london',
    label: 'London',
    color: '#fff',
    alertAtMs: ms('2026-01-14T07:45:00Z'),
    openAtMs: ms('2026-01-14T08:00:00Z'),
    endAtMs: ms('2026-01-14T17:00:00Z'),
    leadMinutes: 15,
  }

  it('does not start the linger clock before the window opens, or while the page is hidden', () => {
    const banners = [base]
    expect(stampOpenSeen(banners, new Date('2026-01-14T07:59:59Z'), true)).toBe(banners)
    expect(stampOpenSeen(banners, new Date('2026-01-14T08:04:00Z'), false)).toBe(banners)
  })

  it('stamps once, the first time the open window is seen, and never restamps', () => {
    const [stamped] = stampOpenSeen([base], new Date('2026-01-14T08:04:00Z'), true)
    expect(stamped.openSeenAtMs).toBe(ms('2026-01-14T08:04:00Z'))
    const again = stampOpenSeen([stamped], new Date('2026-01-14T08:04:30Z'), true)
    expect(again[0].openSeenAtMs).toBe(ms('2026-01-14T08:04:00Z'))
  })

  it('lingers for a minute after being seen open, and always goes when the window ends', () => {
    const seen = { ...base, openSeenAtMs: ms('2026-01-14T08:00:00Z') }
    expect(isBannerExpired(seen, new Date('2026-01-14T08:00:59Z'))).toBe(false)
    expect(isBannerExpired(seen, new Date(seen.openSeenAtMs + BANNER_LINGER_MS))).toBe(true)
    expect(isBannerExpired(base, new Date('2026-01-14T16:59:59Z'))).toBe(false)
    expect(isBannerExpired(base, new Date('2026-01-14T17:00:00Z'))).toBe(true)
  })

  it('a banner slept through is still there on return, saying how long ago it opened', () => {
    // Shown at 07:45, phone locked until 08:04, window opened at 08:00 meanwhile.
    const back = new Date('2026-01-14T08:04:00Z')
    expect(isBannerExpired(base, back)).toBe(false)
    const [stamped] = stampOpenSeen([base], back, true)
    expect(bannerMessage(stamped, back)).toBe('London opened 4 minutes ago')
    expect(isBannerExpired(stamped, new Date('2026-01-14T08:04:59Z'))).toBe(false)
    expect(isBannerExpired(stamped, new Date('2026-01-14T08:05:00Z'))).toBe(true)
  })
})

describe('catch-up after a pause', () => {
  // Forex London opens 08:00Z and closes 17:00Z; a 15-minute alert is at 07:45Z.
  const leads: Leads = { 'forex-london': 15 }
  const catchUp = (since: string, now: string, fired = new Map<string, number>()) => due(leads, now, fired, undefined, since)
  const textAt = (alerts: DueAlert[], iso: string) => alerts.map((a) => bannerMessage(a, new Date(iso)))

  it('shows an alert that came due during the pause, with the remaining time, not the original text', () => {
    const alerts = catchUp('2026-01-14T07:40:00Z', '2026-01-14T07:58:00Z')
    expect(alerts).toHaveLength(1)
    expect(textAt(alerts, '2026-01-14T07:58:00Z')).toEqual(['Forex London opens in 2 minutes'])
  })

  it('shows "opened N minutes ago" if the window opened during the pause and is still running', () => {
    const alerts = catchUp('2026-01-14T07:40:00Z', '2026-01-14T08:04:00Z')
    expect(alerts).toHaveLength(1)
    expect(textAt(alerts, '2026-01-14T08:04:00Z')).toEqual(['Forex London opened 4 minutes ago'])
  })

  it('skips a window that opened and ended during a long pause', () => {
    expect(catchUp('2026-01-14T07:40:00Z', '2026-01-14T17:30:00Z')).toEqual([])
    expect(catchUp('2026-01-14T07:40:00Z', '2026-01-14T17:00:00Z')).toEqual([]) // exactly at the close
    expect(catchUp('2026-01-14T07:40:00Z', '2026-01-14T16:59:59Z')).toHaveLength(1) // a second before it
  })

  it('after a multi-day pause, only the occurrence that has not ended is shown, once', () => {
    // Paused Wed 07:40 -> Fri 07:50. Wednesday's and Thursday's sessions are over; Friday's alert came due.
    const alerts = catchUp('2026-01-14T07:40:00Z', '2026-01-16T07:50:00Z')
    expect(alerts.map((a) => a.openAtMs)).toEqual([ms('2026-01-16T08:00:00Z')])
    expect(textAt(alerts, '2026-01-16T07:50:00Z')).toEqual(['Forex London opens in 10 minutes'])
  })

  it('after a pause that ends at the weekend, nothing is due', () => {
    expect(catchUp('2026-01-14T07:40:00Z', '2026-01-17T12:00:00Z')).toEqual([])
  })

  it('shows the alert only once even if the check runs again', () => {
    const first = catchUp('2026-01-14T07:40:00Z', '2026-01-14T07:58:00Z')
    const fired = new Map(first.map((a) => [a.key, a.openAtMs]))
    expect(catchUp('2026-01-14T07:40:00Z', '2026-01-14T07:58:00Z', fired)).toEqual([])
    // ...and the next ordinary check, which starts where the catch-up ended, doesn't see it either.
    expect(catchUp('2026-01-14T07:58:00Z', '2026-01-14T07:58:01Z')).toEqual([])
  })

  it('a pause that spans an alert time catches it, a pause that ended before it does not', () => {
    expect(catchUp('2026-01-14T07:30:00Z', '2026-01-14T07:44:00Z')).toEqual([])
    expect(catchUp('2026-01-14T07:44:00Z', '2026-01-14T07:46:00Z')).toHaveLength(1)
  })

  it('catches several windows at once, soonest open first', () => {
    const l: Leads = { 'forex-london': 15, 'forex-new-york': 30 } // London alert 07:45Z, New York (13:00Z) alert 12:30Z
    const alerts = getDueAlerts(PRESET_GROUPS, l, new Date('2026-01-14T12:45:00Z'), new Map(), new Date('2026-01-14T07:40:00Z'))
    expect(alerts.map((a) => a.windowId)).toEqual(['forex-london', 'forex-new-york'])
    expect(textAt(alerts, '2026-01-14T12:45:00Z')).toEqual(['Forex London opened 4h 45m ago', 'New York opens in 15 minutes'])
  })

  it('catches an overnight window that is still running (CME opened Sunday evening, now Monday 03:00Z)', () => {
    // CME opens Sun 23:00Z, closes Mon 22:00Z; a 30-min alert is at 22:30Z Sunday.
    const alerts = getDueAlerts(PRESET_GROUPS, { 'cme-equity-futures': 30 }, new Date('2026-01-19T03:00:00Z'), new Map(), new Date('2026-01-18T22:00:00Z'))
    expect(alerts).toHaveLength(1)
    expect(textAt(alerts, '2026-01-19T03:00:00Z')).toEqual(['CME equity futures opened 4h 00m ago'])
  })

  it('skips an overnight window that opened and ended during the pause (ICT Asian, 01:00Z-05:00Z)', () => {
    const l: Leads = { 'ict-asian': 30 } // alert 00:30Z on Thu 15 Jan
    const asian = (now: string) => getDueAlerts(PRESET_GROUPS, l, new Date(now), new Map(), new Date('2026-01-15T00:00:00Z'))
    expect(asian('2026-01-15T00:40:00Z')).toHaveLength(1)
    expect(textAt(asian('2026-01-15T03:00:00Z'), '2026-01-15T03:00:00Z')).toEqual(['Asian opened 2h 00m ago'])
    expect(asian('2026-01-15T05:00:00Z')).toEqual([])
    expect(asian('2026-01-15T09:00:00Z')).toEqual([])
  })

  it('catches an alert whose time was before local midnight, with the open after it', () => {
    const w = custom({ start: '00:10', end: '01:00' }) // opens 00:10 New York
    // Paused from 23:30 Wed to 00:20 Thu (New York): alert time 23:40 passed, window opened 10 min ago.
    const since = new Date('2026-01-15T04:30:00Z')
    const now = new Date('2026-01-15T05:20:00Z')
    const alerts = getDueAlerts(solo(w), { [w.id]: 30 }, now, new Map(), since)
    expect(textAt(alerts, now.toISOString())).toEqual(['Test opened 10 minutes ago'])
  })
})

describe('sound for catch-up alerts', () => {
  const alert: DueAlert = {
    key: 'k',
    windowId: 'forex-london',
    label: 'London',
    color: '#fff',
    alertAtMs: ms('2026-01-14T07:45:00Z'),
    openAtMs: ms('2026-01-14T08:00:00Z'),
    endAtMs: ms('2026-01-14T17:00:00Z'),
    leadMinutes: 15,
  }
  it('plays for an alert that is on time or up to a minute late', () => {
    expect(isFreshAlert(alert, new Date('2026-01-14T07:45:00Z'))).toBe(true)
    expect(isFreshAlert(alert, new Date(alert.alertAtMs + SOUND_MAX_AGE_MS))).toBe(true)
  })
  it('stays silent for a catch-up alert older than a minute', () => {
    expect(isFreshAlert(alert, new Date(alert.alertAtMs + SOUND_MAX_AGE_MS + 1))).toBe(false)
    expect(isFreshAlert(alert, new Date('2026-01-14T07:58:00Z'))).toBe(false)
    expect(isFreshAlert(alert, new Date('2026-01-14T08:04:00Z'))).toBe(false)
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
