import { DateTime } from 'luxon'

/** Formats an instant as a 24-hour "HH:mm:ss" wall-clock time in `zone`. */
export function formatClock(instant: Date, zone: string): string {
  const formatted = DateTime.fromJSDate(instant, { zone }).toFormat('HH:mm:ss')
  if (formatted === 'Invalid DateTime') throw new Error(`Invalid time zone "${zone}"`)
  return formatted
}

/** The browser's IANA time zone name, e.g. "America/New_York". Falls back to "UTC". */
export function getLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Formats a duration as "1h 12m", "3h 05m" or "12m"; under a minute is "<1m". Minutes are rounded down. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMinutes < 1) return '<1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

/**
 * Formats a start/end pair as "09:30 - 16:00". A time that falls on a different
 * calendar day than `reference` (in the times' own zone) gets a "(+1d)" / "(-1d)" tag.
 */
export function formatTimeRange(start: DateTime, end: DateTime, reference: DateTime): string {
  const refDay = reference.setZone(start.zone).startOf('day')
  const tag = (t: DateTime) => {
    const offset = Math.round(t.startOf('day').diff(refDay, 'days').days)
    return offset === 0 ? '' : ` (${offset > 0 ? '+' : '-'}${Math.abs(offset)}d)`
  }
  return `${start.toFormat('HH:mm')}${tag(start)} - ${end.toFormat('HH:mm')}${tag(end)}`
}
