import { DateTime } from 'luxon'
import { NEWS_CALENDAR } from '../config/newsEvents'

export type NewsEventType = 'CPI' | 'NFP' | 'PPI' | 'FOMC'

/** A scheduled, high-impact data release or announcement. */
export interface NewsEvent {
  /** Unique and readable, e.g. "cpi-2026-11-10". */
  id: string
  name: string
  /** Compact label: "CPI", "NFP", "PPI" or "FOMC". */
  shortName: NewsEventType
  /** Calendar date "yyyy-MM-dd" in `timeZone`. */
  date: string
  /** Release time "HH:mm" in `timeZone`. */
  time: string
  /** IANA zone the date and time are in. */
  timeZone: string
  currency: 'USD'
  /** Who publishes the schedule. */
  source: 'BLS' | 'Federal Reserve'
  /** FOMC only: this meeting also publishes the Summary of Economic Projections. */
  includesProjections?: boolean
}

export interface NewsCalendar {
  timeZone: string
  /** The last date the data covers ("yyyy-MM-dd"). Beyond it the calendar knows of no events. */
  coversThrough: string
  /** In date order. */
  events: NewsEvent[]
}

/** An event placed on the timeline of a viewer's time zone. */
export interface LocalizedEvent {
  event: NewsEvent
  /** When it happens, in the viewer's time zone. */
  at: DateTime
}

/** The moment an event happens, in the viewer's zone. */
export function localizeEvent(event: NewsEvent, displayZone: string): LocalizedEvent {
  const at = DateTime.fromISO(`${event.date}T${event.time}`, { zone: event.timeZone }).setZone(displayZone)
  if (!at.isValid) throw new Error(`Cannot place ${event.id} in ${displayZone}: ${at.invalidExplanation}`)
  return { event, at }
}

/**
 * The events that fall on a calendar day of the viewer's own time zone, earliest first.
 * `localDate` is "yyyy-MM-dd" in `displayZone`. The day is the viewer's, so an event can land on
 * a different date than its home date (a 14:00 New York decision is 04:00 the next day in Tokyo)
 * and a day can be 23 or 25 hours long.
 */
export function getEventsOnLocalDate(
  localDate: string,
  displayZone: string,
  events: readonly NewsEvent[] = NEWS_CALENDAR.events,
): LocalizedEvent[] {
  const start = DateTime.fromISO(localDate, { zone: displayZone }).startOf('day')
  if (!start.isValid) throw new Error(`Invalid date "${localDate}" or time zone "${displayZone}"`)
  const end = start.plus({ days: 1 })
  return events
    .map((e) => localizeEvent(e, displayZone))
    .filter(({ at }) => at >= start && at < end)
    .sort((a, b) => a.at.toMillis() - b.at.toMillis())
}

/** The events on the viewer's current day (today in `displayZone` at `now`). */
export function getEventsToday(now: Date, displayZone: string, events: readonly NewsEvent[] = NEWS_CALENDAR.events): LocalizedEvent[] {
  return getEventsOnLocalDate(DateTime.fromJSDate(now, { zone: displayZone }).toISODate()!, displayZone, events)
}

/**
 * The next event strictly after `now`, in the viewer's zone, with the time left until it.
 * Weekends and gaps between releases don't matter: it is simply the earliest later event.
 * Null if the data has no later event.
 */
export function getNextEvent(
  now: Date,
  displayZone: string,
  events: readonly NewsEvent[] = NEWS_CALENDAR.events,
): (LocalizedEvent & { msUntil: number }) | null {
  const nowMs = now.getTime()
  let best: LocalizedEvent | null = null
  for (const event of events) {
    const localized = localizeEvent(event, displayZone)
    if (localized.at.toMillis() > nowMs && (!best || localized.at < best.at)) best = localized
  }
  return best && { ...best, msUntil: best.at.toMillis() - nowMs }
}
