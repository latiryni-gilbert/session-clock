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
