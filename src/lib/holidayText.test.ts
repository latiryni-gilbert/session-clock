import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import {
  closedTodayNote,
  formatEarlyCloseTag,
  formatTimeWithZone,
  tomorrowNote,
  zoneAbbreviation,
} from './holidayText'
import type { TradingWindow } from './tradingWindow'

const NY = 'America/New_York'
const find = (id: string) => PRESET_GROUPS.flatMap((g) => g.windows).find((w) => w.id === id)!
const nyse = find('nyse-regular')
const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate()
const t = (iso: string, zone: string) => DateTime.fromISO(iso, { zone })

describe('zone names', () => {
  it('uses ET for New York in winter and summer, and the other US zones likewise', () => {
    expect(zoneAbbreviation(t('2026-01-14T12:00', NY))).toBe('ET')
    expect(zoneAbbreviation(t('2026-07-14T12:00', NY))).toBe('ET')
    expect(zoneAbbreviation(t('2026-01-14T12:00', 'America/Chicago'))).toBe('CT')
    expect(zoneAbbreviation(t('2026-07-14T12:00', 'America/Denver'))).toBe('MT')
    expect(zoneAbbreviation(t('2026-07-14T12:00', 'America/Los_Angeles'))).toBe('PT')
  })
  it('falls back to the browser short name elsewhere', () => {
    expect(zoneAbbreviation(t('2026-01-14T12:00', 'Europe/London'))).toBe('GMT')
    expect(zoneAbbreviation(t('2026-01-14T12:00', 'Asia/Tokyo'))).toBe('GMT+9')
  })
  it('formats a time with its zone', () => {
    expect(formatTimeWithZone(t('2026-11-27T13:00', NY))).toBe('13:00 ET')
  })
})

describe('formatEarlyCloseTag', () => {
  const closeNy = t('2026-11-27T13:00', NY) // 13:00 in New York
  it('shows the close in the user\'s own zone', () => {
    expect(formatEarlyCloseTag(closeNy)).toBe('Early close 13:00 ET')
    expect(formatEarlyCloseTag(closeNy.setZone('Europe/London'))).toBe('Early close 18:00 GMT')
    expect(formatEarlyCloseTag(closeNy.setZone('Asia/Tokyo'))).toBe('Early close 03:00 GMT+9')
  })
})

describe('closedTodayNote', () => {
  it('names the holiday on a full closure', () => {
    expect(closedTodayNote(nyse, at('2026-11-26T10:00'))).toBe('Closed - Thanksgiving Day')
    expect(closedTodayNote(nyse, at('2026-04-03T10:00'))).toBe('Closed - Good Friday')
    expect(closedTodayNote(nyse, at('2026-07-03T10:00'))).toBe('Closed - Independence Day (observed)')
  })
  it('stays for the whole of the holiday, evening included', () => {
    expect(closedTodayNote(nyse, at('2026-11-26T23:30'))).toBe('Closed - Thanksgiving Day')
    expect(closedTodayNote(nyse, at('2026-11-26T00:00'))).toBe('Closed - Thanksgiving Day')
    expect(closedTodayNote(nyse, at('2026-11-27T00:00'))).toBeNull()
  })
  it('goes by the market\'s date, not the viewer\'s: Friday morning in Tokyo is still Thanksgiving in New York', () => {
    expect(closedTodayNote(nyse, at('2026-11-27T08:00', 'Asia/Tokyo'))).toBe('Closed - Thanksgiving Day')
  })
  it('is null on ordinary days, early-close days and for windows without a calendar', () => {
    expect(closedTodayNote(nyse, at('2026-11-25T10:00'))).toBeNull()
    expect(closedTodayNote(nyse, at('2026-11-27T10:00'))).toBeNull() // early close, not closed
    expect(closedTodayNote(find('forex-london'), at('2026-11-26T10:00'))).toBeNull()
  })
  it('is null if the window would not have run that weekday anyway', () => {
    const mondaysOnly: TradingWindow = { ...nyse, days: [1] }
    expect(closedTodayNote(mondaysOnly, at('2026-11-26T10:00'))).toBeNull() // Thursday
    expect(closedTodayNote(mondaysOnly, at('2026-01-19T10:00'))).toBe('Closed - Martin Luther King Jr. Day') // a Monday
  })
})

describe('tomorrowNote', () => {
  it('warns the day before a closure', () => {
    expect(tomorrowNote(nyse, at('2026-11-25T10:00'), NY)).toBe('Tomorrow: closed (Thanksgiving Day)')
    expect(tomorrowNote(nyse, at('2026-04-02T20:00'), NY)).toBe('Tomorrow: closed (Good Friday)')
    expect(tomorrowNote(nyse, at('2027-03-25T10:00'), NY)).toBe('Tomorrow: closed (Good Friday)')
  })
  it('warns the day before an early close, with the close in the user\'s zone', () => {
    expect(tomorrowNote(nyse, at('2026-11-26T10:00'), NY)).toBe('Tomorrow: early close 13:00 ET (Day after Thanksgiving)')
    expect(tomorrowNote(nyse, at('2026-12-23T10:00'), NY)).toBe('Tomorrow: early close 13:00 ET (Christmas Eve)')
    expect(tomorrowNote(nyse, at('2026-11-26T10:00'), 'Europe/London')).toBe('Tomorrow: early close 18:00 GMT (Day after Thanksgiving)')
  })
  it('says nothing when tomorrow is an ordinary day, or a weekend before a Monday holiday', () => {
    expect(tomorrowNote(nyse, at('2026-11-24T10:00'), NY)).toBeNull()
    expect(tomorrowNote(nyse, at('2026-01-16T10:00'), NY)).toBeNull() // Friday; Saturday is tomorrow, Monday is the holiday
    expect(tomorrowNote(nyse, at('2026-01-18T10:00'), NY)).toBe('Tomorrow: closed (Martin Luther King Jr. Day)') // Sunday before it
  })
  it('goes by the market\'s calendar day (New York), wherever the viewer is', () => {
    // Wednesday 25 Nov 20:00 New York is already Thursday 10:00 in Tokyo; the market's "tomorrow" is Thanksgiving.
    expect(tomorrowNote(nyse, at('2026-11-25T20:00'), 'Asia/Tokyo')).toBe('Tomorrow: closed (Thanksgiving Day)')
  })
  it('is null for windows without a calendar', () => {
    expect(tomorrowNote(find('forex-london'), at('2026-11-25T10:00'), NY)).toBeNull()
    expect(tomorrowNote(find('cme-equity-futures'), at('2026-11-25T10:00'), NY)).toBeNull()
  })
  it('does not warn about an early close that would not shorten this window', () => {
    const overnight: TradingWindow = { ...nyse, start: '22:00', end: '02:00' }
    expect(tomorrowNote(overnight, at('2026-11-26T10:00'), NY)).toBeNull()
  })
})
