import { DateTime } from 'luxon'
import type { Holiday, HolidayCalendar } from './tradingWindow'

const indexes = new WeakMap<HolidayCalendar, Map<string, Holiday>>()

/** The holiday on `date` ("yyyy-MM-dd", in the calendar's time zone), if there is one. */
export function getHoliday(calendar: HolidayCalendar, date: string): Holiday | undefined {
  let index = indexes.get(calendar)
  if (!index) {
    index = new Map(calendar.holidays.map((h) => [h.date, h]))
    indexes.set(calendar, index)
  }
  return index.get(date)
}

/** Whole days from `now` (in the calendar's time zone) until the last date the calendar covers. Negative once it has passed. */
export function daysUntilCoverageEnds(calendar: HolidayCalendar, now: DateTime = DateTime.now()): number {
  const end = DateTime.fromISO(calendar.coversThrough, { zone: calendar.timeZone }).startOf('day')
  return Math.round(end.diff(now.setZone(calendar.timeZone).startOf('day'), 'days').days)
}
