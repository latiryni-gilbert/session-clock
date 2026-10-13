import { DateTime } from 'luxon'
import { NEWS_CALENDAR } from '../config/newsEvents'
import { getWindowOccurrence } from './convertWindow'
import { getEventsOnLocalDate, type NewsEvent } from './newsEvents'
import type { Holiday, TradingWindow } from './tradingWindow'

/** A stretch of the local day, as fractions of it: 0 = midnight, 1 = the next midnight. */
export interface TimelineSegment {
  start: number
  end: number
  /** Set when this segment ends where it does because of an early close (so the end can be marked). */
  earlyClose?: Holiday
}

export interface HourTick {
  /** Hour of the day as "00", "03", ... */
  label: string
  fraction: number
}

/** The local calendar day of `now` in `zone`, as [midnight, next midnight) in epoch ms. */
function localDay(now: Date, zone: string): { startMs: number; lengthMs: number } {
  const start = DateTime.fromJSDate(now, { zone }).startOf('day')
  const startMs = start.toMillis()
  return { startMs, lengthMs: start.plus({ days: 1 }).toMillis() - startMs }
}

/**
 * Where `window` falls on the local day of `now`, as fractions of that day.
 *
 * Occurrences are clipped to the day, so an overnight window is split: the part
 * after midnight is a segment starting at 0, the part before midnight one ending
 * at 1. A window can therefore have two segments (e.g. CME Globex around its
 * 17:00-18:00 break). Fractions are of the day's real length, so a daylight-saving
 * day (23 or 25 hours) still lines up with `getHourTicks`.
 */
export function getTimelineSegments(window: TradingWindow, now: Date, displayZone: string): TimelineSegment[] {
  const { startMs, lengthMs } = localDay(now, displayZone)
  const endMs = startMs + lengthMs
  const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })

  const segments: TimelineSegment[] = []
  for (const offset of [-2, -1, 0, 1, 2]) {
    const occ = getWindowOccurrence(window, nowHome.plus({ days: offset }).toISODate()!, displayZone)
    if (!occ) continue
    const from = Math.max(occ.start.toMillis(), startMs)
    const to = Math.min(occ.end.toMillis(), endMs)
    if (to > from) {
      // Only mark the end if it is the real end of the session, not just where the day is cut at midnight.
      const earlyClose = occ.shortenedBy && to === occ.end.toMillis() ? occ.shortenedBy : undefined
      segments.push({ start: (from - startMs) / lengthMs, end: (to - startMs) / lengthMs, ...(earlyClose && { earlyClose }) })
    }
  }
  return segments.sort((a, b) => a.start - b.start)
}

/** How far through the local day `now` is, from 0 (midnight) to 1. */
export function getNowFraction(now: Date, zone: string): number {
  const { startMs, lengthMs } = localDay(now, zone)
  return (now.getTime() - startMs) / lengthMs
}

/** Hour labels for the local day every `stepHours` hours, positioned at the real wall-clock hour. */
export function getHourTicks(now: Date, zone: string, stepHours = 3): HourTick[] {
  const { startMs, lengthMs } = localDay(now, zone)
  const day = DateTime.fromJSDate(now, { zone })
  const ticks: HourTick[] = []
  for (let hour = 0; hour < 24; hour += stepHours) {
    const at = day.set({ hour, minute: 0, second: 0, millisecond: 0 })
    ticks.push({ label: String(hour).padStart(2, '0'), fraction: (at.toMillis() - startMs) / lengthMs })
  }
  return ticks
}

/** A news event placed on the viewer's local day. */
export interface NewsMarker {
  event: NewsEvent
  /** When it happens, in the viewer's zone. */
  at: DateTime
  /** Position along the day, 0 (midnight) to 1. */
  fraction: number
  /** How to hang the label from the marker: centred, or pushed inward near either edge so it isn't cut off. */
  align: 'start' | 'center' | 'end'
  /** Labels of events close together alternate between two rows so they don't overlap. */
  row: 0 | 1
}

/** Labels closer than this share-of-the-day apart go on different rows. */
const LABEL_CROWDING = 0.08

/** Today's news events (today in `zone`, at `now`) as markers along the timeline. */
export function getNewsMarkers(now: Date, zone: string, events: readonly NewsEvent[] = NEWS_CALENDAR.events): NewsMarker[] {
  const { startMs, lengthMs } = localDay(now, zone)
  const localDate = DateTime.fromMillis(startMs, { zone }).toISODate()!
  const markers: NewsMarker[] = []
  for (const { event, at } of getEventsOnLocalDate(localDate, zone, events)) {
    const fraction = (at.toMillis() - startMs) / lengthMs
    const previous = markers.at(-1)
    markers.push({
      event,
      at,
      fraction,
      align: fraction < 0.04 ? 'start' : fraction > 0.96 ? 'end' : 'center',
      row: previous && fraction - previous.fraction < LABEL_CROWDING ? (previous.row === 0 ? 1 : 0) : 0,
    })
  }
  return markers
}
