import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { NEWS_CALENDAR } from '../config/newsEvents'
import { localizeEvent } from './newsEvents'
import { FOREX_FACTORY_CALENDAR_URL, formatNextEvent, newsAlertLabel, newsMarkerTitle } from './newsText'

const event = (id: string) => NEWS_CALENDAR.events.find((e) => e.id === id)!
const next = (id: string, zone: string, nowIso: string) => {
  const localized = localizeEvent(event(id), zone)
  return { ...localized, msUntil: localized.at.toMillis() - DateTime.fromISO(nowIso, { zone }).toMillis() }
}

describe('formatNextEvent', () => {
  it('within a day: the countdown and the local time', () => {
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/New_York', '2026-11-10T06:15'))).toBe('Next: CPI in 2h 15m (08:30)')
  })

  it('shows the time in the viewer\'s zone (07:30 for a Chicago user)', () => {
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/Chicago', '2026-11-10T05:15'))).toBe('Next: CPI in 2h 15m (07:30)')
  })

  it('under an hour has no hours, and under a minute reads <1m', () => {
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/New_York', '2026-11-10T08:00'))).toBe('Next: CPI in 30m (08:30)')
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/New_York', '2026-11-10T08:29:30'))).toBe('Next: CPI in <1m (08:30)')
  })

  it('beyond 24 hours: the day and time instead', () => {
    expect(formatNextEvent(next('fomc-2027-01-27', 'America/New_York', '2027-01-25T10:00'))).toBe('Next: FOMC Wed 14:00')
    expect(formatNextEvent(next('nfp-2026-12-04', 'America/New_York', '2026-12-01T10:00'))).toBe('Next: NFP Fri 08:30')
  })

  it('exactly 24 hours away still counts down; just beyond switches to the day', () => {
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/New_York', '2026-11-09T08:30'))).toBe('Next: CPI in 24h 00m (08:30)')
    expect(formatNextEvent(next('cpi-2026-11-10', 'America/New_York', '2026-11-09T08:29'))).toBe('Next: CPI Tue 08:30')
  })

  it('adds "+ projections" for FOMC meetings with projections, in both forms', () => {
    expect(formatNextEvent(next('fomc-2026-12-09', 'America/New_York', '2026-12-09T09:00'))).toBe('Next: FOMC in 5h 00m (14:00) + projections')
    expect(formatNextEvent(next('fomc-2026-12-09', 'America/New_York', '2026-12-05T12:00'))).toBe('Next: FOMC Wed 14:00 + projections')
    expect(formatNextEvent(next('fomc-2027-01-27', 'America/New_York', '2027-01-27T08:00'))).toBe('Next: FOMC in 6h 00m (14:00)')
  })

  it('uses the viewer\'s day, so an event can read as the next calendar day in Tokyo', () => {
    expect(formatNextEvent(next('fomc-2027-01-27', 'Asia/Tokyo', '2027-01-25T10:00'))).toBe('Next: FOMC Thu 04:00')
  })
})

describe('other news text', () => {
  it('describes a marker with the event name and its time in the viewer\'s zone', () => {
    expect(newsMarkerTitle(localizeEvent(event('cpi-2026-11-10'), 'America/Chicago'))).toBe('Consumer Price Index, 07:30 CT')
    expect(newsMarkerTitle(localizeEvent(event('fomc-2026-12-09'), 'America/New_York'))).toBe('FOMC Rate Decision, with projections, 14:00 ET')
    expect(newsMarkerTitle(localizeEvent(event('fomc-2027-01-27'), 'Europe/London'))).toBe('FOMC Rate Decision, 19:00 GMT')
  })

  it('names events for alert banners', () => {
    expect(newsAlertLabel(event('cpi-2026-11-10'))).toBe('CPI')
    expect(newsAlertLabel(event('nfp-2026-11-06'))).toBe('NFP')
    expect(newsAlertLabel(event('fomc-2027-01-27'))).toBe('FOMC decision')
    expect(newsAlertLabel(event('fomc-2026-12-09'))).toBe('FOMC decision (with projections)')
  })

  it('links to the ForexFactory calendar page only', () => {
    expect(FOREX_FACTORY_CALENDAR_URL).toBe('https://www.forexfactory.com/calendar')
  })
})
