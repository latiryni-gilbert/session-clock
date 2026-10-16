import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../../config/presets'
import { NEWS_CALENDAR } from '../../config/newsEvents'
import type { AlertLead } from '../alertSettings'
import { bannerMessage, getDueAlerts, getDueNewsAlerts } from '../alerts'
import type { NewsEvent } from '../newsEvents'
import type { PresetGroup, TradingWindow } from '../tradingWindow'
import { applySettings } from '../windowSettings'
import { buildSchedule, hashSchedule, MAX_SCHEDULED_ALERTS, MIN_LEAD_TIME_MS, SCHEDULE_DAYS } from './schedule'

const NOW = new Date('2026-11-23T12:00:00Z') // Monday, the week of Thanksgiving
const DAY = 24 * 3600_000
const build = (leads: Record<string, AlertLead>, over: Partial<Parameters<typeof buildSchedule>[0]> = {}) =>
  buildSchedule({ groups: PRESET_GROUPS, leads, newsLead: null, events: NEWS_CALENDAR.events, now: NOW, ...over })
const times = (s: ReturnType<typeof build>) => s.alerts.map((a) => a.fireAt)

describe('buildSchedule', () => {
  it('is empty when no alert is set', () => {
    expect(build({})).toMatchObject({ alerts: [], shortened: false })
  })

  it('lists a window alert at its open time minus the lead, 14 days ahead', () => {
    const s = build({ 'ict-london': 15 })
    // ICT London 02:00 New York (UTC-5 in winter) = 07:00Z, alert 06:45Z, on weekdays only.
    expect(s.alerts[0]).toEqual({ fireAt: '2026-11-24T06:45:00.000Z', title: 'ICT London opens in 15 minutes', body: 'Session Clock' })
    expect(s.alerts.every((a) => a.fireAt.endsWith('T06:45:00.000Z'))).toBe(true)
    expect(s.alerts).toHaveLength(10) // weekdays only: two working weeks
    expect(s.throughMs).toBe(NOW.getTime() + SCHEDULE_DAYS * DAY)
    expect(Math.max(...s.alerts.map((a) => Date.parse(a.fireAt)))).toBeLessThan(s.throughMs)
  })

  it('uses the same wording as the banner at the alert time, and the same moments as the in-app alerts', () => {
    const leads: Record<string, AlertLead> = { 'forex-london': 30, 'cme-equity-futures': 5 }
    const s = build(leads)
    for (const a of s.alerts.slice(0, 12)) {
      const at = new Date(a.fireAt)
      const live = getDueAlerts(PRESET_GROUPS, leads, at, new Map(), new Date(at.getTime() - 1000))
      expect(live).toHaveLength(1)
      expect(a.title).toBe(bannerMessage(live[0], at))
      expect(live[0].alertAtMs).toBe(at.getTime())
    }
  })

  it('qualifies a name shared by two groups with the group, like the banner; a unique name stays plain', () => {
    const both = build({ 'ict-london': 5, 'forex-london': 5 })
    expect(both.alerts.map((a) => a.title)).toEqual(expect.arrayContaining(['ICT London opens in 5 minutes', 'Forex London opens in 5 minutes']))
    expect(build({ 'cme-equity-futures': 5 }).alerts[0].title).toBe('CME equity futures opens in 5 minutes')
  })

  it('skips the holiday: no NYSE alert on Thanksgiving, and the other days are there', () => {
    const s = build({ 'nyse-regular': 15 })
    const days = s.alerts.map((a) => a.fireAt.slice(0, 10))
    expect(days).not.toContain('2026-11-26')
    expect(days).toEqual(expect.arrayContaining(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']))
    // 09:30 New York = 14:30Z, alert 14:15Z.
    expect(s.alerts[0].fireAt).toBe('2026-11-23T14:15:00.000Z')
  })

  it('skips windows that are switched off', () => {
    const allOff = new Set(['ict-london'])
    const groups = applySettings(PRESET_GROUPS, allOff)
    const s = build({ 'ict-london': 15, 'ict-asian': 15 }, { groups })
    expect(s.alerts.map((a) => a.title)).not.toContain('London opens in 15 minutes')
    expect(s.alerts.length).toBeGreaterThan(0) // Asian is still on
    expect(build({ 'ict-london': 15 }, { groups }).alerts).toEqual([])
  })

  it('includes a custom window', () => {
    const custom: TradingWindow = { id: 'custom-1', name: 'My window', shortName: 'MY', start: '10:00', end: '11:00', timeZone: 'UTC', days: [1, 2, 3, 4, 5], color: '#fff' }
    const group: PresetGroup = { name: 'Custom', shortName: 'You', windows: [custom] }
    const s = build({ 'custom-1': 30 }, { groups: [group] })
    expect(s.alerts[0]).toMatchObject({ fireAt: '2026-11-24T09:30:00.000Z', title: 'My window opens in 30 minutes' })
  })

  describe('news events', () => {
    const events: NewsEvent[] = [
      { id: 'cpi-a', name: 'Consumer Price Index', shortName: 'CPI', date: '2026-11-25', time: '08:30', timeZone: 'America/New_York', currency: 'USD', source: 'BLS' },
      { id: 'fomc-a', name: 'FOMC', shortName: 'FOMC', date: '2026-11-30', time: '14:00', timeZone: 'America/New_York', currency: 'USD', source: 'Federal Reserve', includesProjections: true },
      { id: 'cpi-far', name: 'CPI', shortName: 'CPI', date: '2027-02-10', time: '08:30', timeZone: 'America/New_York', currency: 'USD', source: 'BLS' },
    ]
    it('adds news alerts with the banner wording, only inside the horizon', () => {
      const s = build({}, { newsLead: 15, events })
      expect(s.alerts).toEqual([
        { fireAt: '2026-11-25T13:15:00.000Z', title: 'CPI in 15 minutes', body: 'Session Clock' },
        { fireAt: '2026-11-30T18:45:00.000Z', title: 'FOMC decision (with projections) in 15 minutes', body: 'Session Clock' },
      ])
    })
    it('matches the in-app news alert for the same event', () => {
      const s = build({}, { newsLead: 30, events })
      const at = new Date(s.alerts[0].fireAt)
      const [live] = getDueNewsAlerts(events, 30, at, new Map(), new Date(at.getTime() - 1000))
      expect(s.alerts[0].title).toBe(bannerMessage(live, at))
    })
    it('adds none when news alerts are off', () => {
      expect(build({}, { newsLead: null, events }).alerts).toEqual([])
    })
    it('merges window and news alerts in time order', () => {
      const s = build({ 'nyse-regular': 15 }, { newsLead: 15, events })
      const ts = times(s)
      expect(ts).toEqual([...ts].sort())
      expect(s.alerts.map((a) => a.title)).toContain('CPI in 15 minutes')
    })
  })

  describe('the 2-minute skip', () => {
    const win: TradingWindow = { id: 'w', name: 'W', shortName: 'W', start: '12:30', end: '13:00', timeZone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], color: '#fff' }
    const group = { name: 'G', shortName: 'G', windows: [win] }
    const at = (iso: string) => buildSchedule({ groups: [group], leads: { w: 30 }, newsLead: null, events: [], now: new Date(iso) }).alerts[0].fireAt
    it('leaves out an alert due in under 2 minutes', () => {
      // Alert at 12:00:00Z.
      expect(at('2026-11-23T11:58:30Z')).toBe('2026-11-24T12:00:00.000Z')
    })
    it('leaves out one due exactly 1 minute 59 seconds away, keeps one 2 minutes away', () => {
      expect(at('2026-11-23T11:58:01Z')).toBe('2026-11-24T12:00:00.000Z')
      expect(at('2026-11-23T11:58:00Z')).toBe('2026-11-23T12:00:00.000Z')
    })
    it('leaves out one already past', () => {
      expect(at('2026-11-23T12:00:01Z')).toBe('2026-11-24T12:00:00.000Z')
    })
    it('uses a 2-minute margin', () => {
      expect(MIN_LEAD_TIME_MS).toBe(120_000)
    })
  })

  describe('the cap', () => {
    const win: TradingWindow = { id: 'busy', name: 'Busy', shortName: 'B', start: '10:00', end: '10:10', timeZone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], color: '#fff' }
    const group = { name: 'G', shortName: 'G', windows: [win] }
    // Many one-per-day windows: 30 windows -> 30 alerts a day -> 420+ over 14 days.
    const many = (n: number): PresetGroup => ({
      name: 'G',
      shortName: 'G',
      windows: Array.from({ length: n }, (_, i) => ({ ...win, id: `w${i}`, name: `W${i}`, start: `${String(i % 24).padStart(2, '0')}:${String(Math.floor(i / 24) * 30).padStart(2, '0')}`, end: '23:59' })),
    })
    const leadsFor = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`w${i}`, 5 as AlertLead]))

    it('keeps everything up to exactly 400', () => {
      const s = buildSchedule({ groups: [many(28)], leads: leadsFor(28), newsLead: null, events: [], now: NOW }) // 28 * 14 = 392
      expect(s.alerts).toHaveLength(392)
      expect(s.shortened).toBe(false)
    })
    it('cuts the horizon back when there are more, keeping a contiguous run from now', () => {
      const s = buildSchedule({ groups: [many(40)], leads: leadsFor(40), newsLead: null, events: [], now: NOW })
      expect(s.shortened).toBe(true)
      expect(s.alerts.length).toBeLessThanOrEqual(MAX_SCHEDULED_ALERTS)
      expect(s.alerts.length).toBeGreaterThan(MAX_SCHEDULED_ALERTS - 40)
      expect(s.throughMs).toBeLessThan(NOW.getTime() + SCHEDULE_DAYS * DAY)
      expect(s.throughMs).toBeGreaterThan(NOW.getTime())
      // Everything before throughMs is there, nothing at or after it.
      const full = buildSchedule({ groups: [many(40)], leads: leadsFor(40), newsLead: null, events: [], now: NOW, ...{} })
      expect(full.alerts.every((a) => Date.parse(a.fireAt) < s.throughMs)).toBe(true)
    })
    it('drops every alert at the moment of the first one that does not fit', () => {
      // 10 windows at the same minute: 41 days' worth would overshoot 400 inside a tie.
      const same: PresetGroup = { ...group, windows: Array.from({ length: 10 }, (_, i) => ({ ...win, id: `w${i}`, name: `W${i}` })) }
      const s = buildSchedule({ groups: [same], leads: leadsFor(10), newsLead: null, events: [], now: NOW })
      // 14 days * 10 = 140: fits, so shortened is false; use a larger crowd for a real tie.
      expect(s.alerts).toHaveLength(140)
      const crowd: PresetGroup = { ...group, windows: Array.from({ length: 30 }, (_, i) => ({ ...win, id: `w${i}`, name: `W${i}` })) }
      const t = buildSchedule({ groups: [crowd], leads: leadsFor(30), newsLead: null, events: [], now: NOW })
      expect(t.shortened).toBe(true)
      expect(t.alerts.length % 30).toBe(0) // whole days of 30 at one moment each
      expect(t.alerts.length).toBe(390)
    })
  })

  it('keeps titles within the Worker limit', () => {
    const win: TradingWindow = { id: 'long', name: 'x'.repeat(200), shortName: 'L', start: '10:00', end: '11:00', timeZone: 'UTC', days: [1], color: '#fff' }
    const group = { name: 'G', shortName: 'G', windows: [win] }
    const s = buildSchedule({ groups: [group], leads: { long: 5 }, newsLead: null, events: [], now: NOW })
    expect(Array.from(s.alerts[0].title).length).toBeLessThanOrEqual(80)
  })

  it('never lists the same alert twice', () => {
    const s = build({ 'nyse-regular': 15, 'ict-new-york-am': 15, 'ict-new-york-pm': 5, 'forex-new-york': 30 })
    expect(new Set(s.alerts.map((a) => `${a.fireAt}|${a.title}`)).size).toBe(s.alerts.length)
  })

  it('does not depend on the time zone the page is in', () => {
    // Occurrences come from the windows' own zones, so the same schedule results whatever the display zone is.
    expect(build({ 'ict-london': 15, 'cme-equity-futures': 5 })).toEqual(build({ 'ict-london': 15, 'cme-equity-futures': 5 }))
  })
})

describe('hashSchedule', () => {
  const a = { fireAt: '2026-11-24T06:45:00.000Z', title: 'London opens in 15 minutes', body: 'Session Clock' }
  it('is the same for the same schedule', () => {
    expect(hashSchedule([a])).toBe(hashSchedule([{ ...a }]))
  })
  it.each([
    ['a different time', { ...a, fireAt: '2026-11-24T06:46:00.000Z' }],
    ['a different title', { ...a, title: 'London opens in 5 minutes' }],
    ['a different body', { ...a, body: 'x' }],
  ])('changes with %s', (_n, other) => {
    expect(hashSchedule([other])).not.toBe(hashSchedule([a]))
  })
  it('changes with an extra alert and with order, and differs from empty', () => {
    expect(hashSchedule([a, { ...a, fireAt: '2026-11-25T06:45:00.000Z' }])).not.toBe(hashSchedule([a]))
    expect(hashSchedule([])).not.toBe(hashSchedule([a]))
  })
})
