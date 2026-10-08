import { DateTime } from 'luxon'
import { formatDuration } from './formatTime'
import { getWindowOccurrence } from './convertWindow'
import type { TradingWindow } from './tradingWindow'

export type WindowStatus =
  | { kind: 'active'; start: DateTime; end: DateTime; endsInMs: number }
  | { kind: 'upcoming'; start: DateTime; end: DateTime; opensInMs: number }
  /** Already ended today (times given), or does not run today (times null). */
  | { kind: 'closed'; start: DateTime | null; end: DateTime | null }

/**
 * Works out where `window` stands at `now`, with all times in `displayZone`.
 *
 * "Today" is the calendar day of `now` in `displayZone`:
 * - active:   an occurrence is open right now, including an overnight one that
 *             started yesterday (start <= now < end);
 * - upcoming: an occurrence opens later today;
 * - closed:   otherwise. If an occurrence already ended today its times are
 *             included, otherwise they are null.
 */
export function getWindowStatus(window: TradingWindow, now: Date, displayZone: string): WindowStatus {
  const nowLocal = DateTime.fromJSDate(now, { zone: displayZone })
  const dayStart = nowLocal.startOf('day')
  const dayEnd = nowLocal.endOf('day')

  // Occurrences are keyed by their start date in the home zone. Home and display
  // zones can differ by more than a day, so look two days either side.
  const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })
  const occurrences = [-2, -1, 0, 1, 2].flatMap((offset) => {
    const date = nowHome.plus({ days: offset }).toISODate()!
    const occ = getWindowOccurrence(window, date, displayZone)
    return occ ? [occ] : []
  })

  const nowMs = now.getTime()
  const active = occurrences.find((o) => o.start.toMillis() <= nowMs && nowMs < o.end.toMillis())
  if (active) return { kind: 'active', ...active, endsInMs: active.end.toMillis() - nowMs }

  const upcoming = occurrences
    .filter((o) => o.start.toMillis() > nowMs && o.start <= dayEnd)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0]
  if (upcoming) return { kind: 'upcoming', ...upcoming, opensInMs: upcoming.start.toMillis() - nowMs }

  const endedToday = occurrences
    .filter((o) => o.end.toMillis() <= nowMs && o.end > dayStart)
    .sort((a, b) => b.end.toMillis() - a.end.toMillis())[0]
  return { kind: 'closed', start: endedToday?.start ?? null, end: endedToday?.end ?? null }
}

export function statusLabel(status: WindowStatus): string {
  switch (status.kind) {
    case 'active':
      return `Active - ends in ${formatDuration(status.endsInMs)}`
    case 'upcoming':
      return `Opens in ${formatDuration(status.opensInMs)}`
    case 'closed':
      return 'Closed today'
  }
}
