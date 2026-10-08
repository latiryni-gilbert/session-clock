import { DateTime } from 'luxon'
import { getWindowOccurrence } from './convertWindow'
import { formatDuration } from './formatTime'
import type { TradingWindow } from './tradingWindow'

export type WindowStatus =
  | { kind: 'active'; start: DateTime; end: DateTime; endsInMs: number }
  | { kind: 'upcoming'; start: DateTime; end: DateTime; opensInMs: number }

const DAY_MS = 24 * 60 * 60 * 1000
/** Home-date window searched for occurrences: covers a past overnight start through a full week ahead. */
const SEARCH_OFFSETS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8]

/**
 * Works out where `window` stands at `now`, with all times in `displayZone`.
 *
 * - active:   an occurrence is open right now, including an overnight one that
 *             started yesterday (start <= now < end);
 * - upcoming: otherwise, its next occurrence, however far away.
 */
export function getWindowStatus(window: TradingWindow, now: Date, displayZone: string): WindowStatus {
  const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })
  const occurrences = SEARCH_OFFSETS.flatMap((offset) => {
    const occ = getWindowOccurrence(window, nowHome.plus({ days: offset }).toISODate()!, displayZone)
    return occ ? [occ] : []
  })

  const nowMs = now.getTime()
  const active = occurrences.find((o) => o.start.toMillis() <= nowMs && nowMs < o.end.toMillis())
  if (active) return { kind: 'active', ...active, endsInMs: active.end.toMillis() - nowMs }

  const next = occurrences
    .filter((o) => o.start.toMillis() > nowMs)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0]
  if (!next) throw new Error(`Window "${window.id}" has no upcoming occurrence (does it have any days?)`)
  return { kind: 'upcoming', ...next, opensInMs: next.start.toMillis() - nowMs }
}

/**
 * "Active - ends in 1h 12m", "Opens in 3h 05m", or, when the next open is more
 * than 24 hours away, the day and time in the display zone: "Opens Sun 18:00".
 */
export function statusLabel(status: WindowStatus): string {
  if (status.kind === 'active') return `Active - ends in ${formatDuration(status.endsInMs)}`
  if (status.opensInMs > DAY_MS) return `Opens ${status.start.setLocale('en').toFormat('ccc HH:mm')}`
  return `Opens in ${formatDuration(status.opensInMs)}`
}

/** Active windows first (in their original order), then upcoming ones by soonest open. */
export function sortWindowsByStatus(
  windows: TradingWindow[],
  now: Date,
  displayZone: string,
): { window: TradingWindow; status: WindowStatus }[] {
  const rank = (s: WindowStatus) => (s.kind === 'active' ? -Infinity : s.opensInMs)
  return windows
    .map((window) => ({ window, status: getWindowStatus(window, now, displayZone) }))
    .sort((a, b) => rank(a.status) - rank(b.status))
}
