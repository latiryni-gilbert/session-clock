import { DateTime } from 'luxon'
import { getWindowOccurrence } from './convertWindow'
import { getHoliday } from './holidays'
import type { Holiday, TradingWindow } from './tradingWindow'

const GENERIC_US_ZONE_NAMES: Record<string, string> = {
  EST: 'ET', EDT: 'ET', CST: 'CT', CDT: 'CT', MST: 'MT', MDT: 'MT', PST: 'PT', PDT: 'PT',
}

/** A short zone name for a time: "ET", "CT", "GMT", or "GMT+9" where there is no common abbreviation. */
export function zoneAbbreviation(time: DateTime): string {
  const short = time.setLocale('en-US').offsetNameShort ?? ''
  return GENERIC_US_ZONE_NAMES[short] ?? short
}

/** "13:00 ET": a clock time in the time's own zone, with that zone's short name. */
export function formatTimeWithZone(time: DateTime): string {
  const t = time.setLocale('en-US')
  return `${t.toFormat('HH:mm')} ${zoneAbbreviation(t)}`
}

/** The tag shown next to an early-close day's times, with the close in the user's own zone: "Early close 13:00 ET". */
export function formatEarlyCloseTag(end: DateTime): string {
  return `Early close ${formatTimeWithZone(end)}`
}

/** The holiday on `isoDate` (a date in the window's home zone), if the window would normally have run that day. */
function holidayOn(window: TradingWindow, isoDate: string): Holiday | undefined {
  if (!window.holidays) return undefined
  const weekday = DateTime.fromISO(isoDate, { zone: 'utc' }).weekday
  if (!window.days.includes(weekday as TradingWindow['days'][number])) return undefined
  return getHoliday(window.holidays, isoDate)
}

const homeDate = (window: TradingWindow, now: Date, plusDays = 0) =>
  DateTime.fromJSDate(now, { zone: window.timeZone }).plus({ days: plusDays }).toISODate()!

/** "Closed - Thanksgiving Day" if today (the market's date, in the window's home zone) is a full closure, else null. */
export function closedTodayNote(window: TradingWindow, now: Date): string | null {
  const holiday = holidayOn(window, homeDate(window, now))
  return holiday?.type === 'closed' ? `Closed - ${holiday.name}` : null
}

/**
 * A heads-up about the market's next calendar day: "Tomorrow: closed (Thanksgiving Day)" or
 * "Tomorrow: early close 13:00 ET (Christmas Eve)", the close shown in `displayZone`. Null otherwise,
 * including when tomorrow is a weekend, even if Monday is a holiday.
 */
export function tomorrowNote(window: TradingWindow, now: Date, displayZone: string): string | null {
  const date = homeDate(window, now, 1)
  const holiday = holidayOn(window, date)
  if (!holiday) return null
  if (holiday.type === 'closed') return `Tomorrow: closed (${holiday.name})`
  const occurrence = getWindowOccurrence(window, date, displayZone)
  return occurrence?.shortenedBy ? `Tomorrow: early close ${formatTimeWithZone(occurrence.end)} (${holiday.name})` : null
}
