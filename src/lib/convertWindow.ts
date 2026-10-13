import { DateTime } from 'luxon'
import { getHoliday } from './holidays'
import type { TradingWindow } from './tradingWindow'

export interface WindowOccurrence {
  /** When the window opens, expressed in the display time zone. */
  start: DateTime
  /** When the window closes, expressed in the display time zone. */
  end: DateTime
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/

function parseTime(value: string): { hour: number; minute: number } {
  const match = HH_MM.exec(value)
  if (!match) throw new Error(`Invalid time "${value}", expected "HH:mm"`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/**
 * Returns the occurrence of `window` that STARTS on `date`, with its start and
 * end converted to `displayZone`. Returns null if the window does not start on
 * that weekday, or if its holiday calendar says that day is a full closure.
 * On an early-close day a same-day window ends at the calendar's early-close time
 * instead (overnight windows are not shortened).
 *
 * `date` is a calendar date ("yyyy-MM-dd") in the window's home time zone.
 * A window whose end is earlier than or equal to its start ends on the next
 * calendar day. Start and end are each resolved as wall-clock times in the
 * home zone, so a daylight-saving change in between is handled correctly. A wall-clock
 * time that falls in a spring-forward gap moves forward by the gap (02:30 becomes 03:30).
 */
export function getWindowOccurrence(
  window: TradingWindow,
  date: string,
  displayZone: string,
): WindowOccurrence | null {
  // Parsed in UTC so the weekday is that of the calendar date itself.
  const day = DateTime.fromISO(date, { zone: 'utc' })
  if (!day.isValid) throw new Error(`Invalid date "${date}", expected "yyyy-MM-dd"`)
  if (!window.days.includes(day.weekday as TradingWindow['days'][number])) return null

  const start = parseTime(window.start)
  let end = parseTime(window.end)
  const minutes = (t: { hour: number; minute: number }) => t.hour * 60 + t.minute
  const overnight = minutes(end) <= minutes(start)

  const holiday = window.holidays ? getHoliday(window.holidays, day.toISODate()!) : undefined
  if (holiday?.type === 'closed') return null
  if (holiday?.type === 'early-close' && !overnight) {
    const early = parseTime(window.holidays!.earlyCloseTime)
    if (minutes(early) < minutes(end)) {
      // Closing at or before the open leaves no session at all.
      if (minutes(early) <= minutes(start)) return null
      end = early
    }
  }
  const endDay = overnight ? day.plus({ days: 1 }) : day

  const at = (d: DateTime, t: { hour: number; minute: number }) =>
    DateTime.fromObject(
      { year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute },
      { zone: window.timeZone },
    ).setZone(displayZone)

  const result = { start: at(day, start), end: at(endDay, end) }
  if (!result.start.isValid || !result.end.isValid) {
    throw new Error(`Invalid time zone "${window.timeZone}" or "${displayZone}"`)
  }
  // A time inside a daylight-saving gap (e.g. 02:30 on a spring-forward night) does not
  // exist; Luxon moves it forward by the length of the gap (02:30 -> 03:30). That can push
  // the start past an end that sits inside the gap, so never let a window end before it starts.
  if (result.end < result.start) result.end = result.start
  return result
}
