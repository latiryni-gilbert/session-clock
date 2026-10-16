import { DateTime } from 'luxon'

/**
 * The last day whose alerts are all scheduled, as a short local date like "Mon, Oct 26". `throughMs` is the instant before
 * which everything is scheduled, so the day it falls in may be only partly covered: the day before is the last full one.
 */
export function formatScheduledThrough(throughMs: number, zone?: string): string {
  const lastFullDay = DateTime.fromMillis(throughMs, zone ? { zone } : {}).startOf('day').minus({ milliseconds: 1 })
  return lastFullDay.setLocale('en-US').toFormat('ccc, LLL d')
}
