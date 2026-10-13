import { formatDuration } from './formatTime'
import { zoneAbbreviation } from './holidayText'
import type { LocalizedEvent, NewsEvent } from './newsEvents'

const DAY_MS = 24 * 60 * 60 * 1000

export const FOREX_FACTORY_CALENDAR_URL = 'https://www.forexfactory.com/calendar'

/**
 * The "Next event" line, with times in the viewer's zone:
 * "Next: CPI in 2h 15m (07:30)" within 24 hours, otherwise the day and time, "Next: FOMC Wed 13:00".
 * FOMC meetings that publish projections get " + projections" on the end.
 */
export function formatNextEvent(next: LocalizedEvent & { msUntil: number }): string {
  const at = next.at.setLocale('en-US')
  const projections = next.event.includesProjections ? ' + projections' : ''
  if (next.msUntil > DAY_MS) return `Next: ${next.event.shortName} ${at.toFormat('ccc HH:mm')}${projections}`
  return `Next: ${next.event.shortName} in ${formatDuration(next.msUntil)} (${at.toFormat('HH:mm')})${projections}`
}

/** A tooltip for a timeline marker: "Consumer Price Index, 07:30 CT" (time in the viewer's zone). */
export function newsMarkerTitle(item: LocalizedEvent): string {
  const at = item.at.setLocale('en-US')
  const projections = item.event.includesProjections ? ', with projections' : ''
  return `${item.event.name}${projections}, ${at.toFormat('HH:mm')} ${zoneAbbreviation(at)}`
}

/** What an alert banner calls an event: "CPI", "FOMC decision" or "FOMC decision (with projections)". */
export function newsAlertLabel(event: NewsEvent): string {
  if (event.shortName !== 'FOMC') return event.shortName
  return event.includesProjections ? 'FOMC decision (with projections)' : 'FOMC decision'
}
