import { DateTime } from 'luxon'
import type { AlertLead } from './alertSettings'
import { getWindowOccurrence } from './convertWindow'
import { formatDuration } from './formatTime'
import type { PresetGroup } from './tradingWindow'
import { getStorage, type StorageLike } from './windowSettings'

/**
 * When the page first loads, alerts whose time passed up to this long ago still count as due, so
 * opening the page a moment late doesn't miss one. (A refresh during the alert minute is kept
 * from repeating an alert by the fired record.)
 */
export const ALERT_LOOKBACK_MS = 2 * 60_000
/** A catch-up alert older than this plays no sound. */
export const SOUND_MAX_AGE_MS = 60_000
/** A banner disappears this long (visible time) after its window opens. */
export const BANNER_LINGER_MS = 60_000
export const FIRED_STORAGE_KEY = 'session-clock:alerts-fired'

export interface DueAlert {
  /** Identifies one occurrence of one window: the same occurrence always has the same key. */
  key: string
  windowId: string
  /** Readable name, qualified by group when two windows share a name ("Forex London"). */
  label: string
  color: string
  /** When the alert time arrived (open minus the lead time). */
  alertAtMs: number
  openAtMs: number
  endAtMs: number
  leadMinutes: number
  /** When the banner was first seen after its window opened; it lingers for BANNER_LINGER_MS from then. */
  openSeenAtMs?: number
}

export const alertKey = (windowId: string, openAtMs: number) => `${windowId}@${openAtMs}`

/** Display names per window id; names used in more than one group get the group's short name in front. */
export function windowLabels(groups: readonly PresetGroup[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const g of groups) for (const w of g.windows) counts.set(w.name, (counts.get(w.name) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const g of groups) {
    for (const w of g.windows) labels.set(w.id, (counts.get(w.name) ?? 0) > 1 ? `${g.shortName} ${w.name}` : w.name)
  }
  return labels
}

/**
 * Which alerts should be shown now.
 *
 * `since` is when alerts were last checked (when the page first loads, a little before now, see
 * `ALERT_LOOKBACK_MS`). An occurrence is due if its alert time (open minus the lead time) fell in
 * `(since, now]` and it hasn't ended yet, and it is not in `fired`. Each alert time falls in exactly
 * one check interval, so ordinary once-a-second checks alert right on time, and a check after a
 * long pause (phone locked, tab in the background) catches up on everything that came due in between:
 * - not yet open: still shown, and its text counts down from now;
 * - open and still running: shown as "opened N minutes ago";
 * - already ended: skipped.
 *
 * Looks at occurrences that started up to two days ago (overnight windows still running) through
 * tomorrow, in each window's home zone. Works on instants, so it doesn't depend on the display zone.
 */
export function getDueAlerts(
  groups: readonly PresetGroup[],
  leads: Readonly<Record<string, AlertLead>>,
  now: Date,
  fired: ReadonlyMap<string, number>,
  since: Date,
): DueAlert[] {
  const nowMs = now.getTime()
  const sinceMs = since.getTime()
  const labels = windowLabels(groups)
  const due: DueAlert[] = []

  for (const group of groups) {
    for (const window of group.windows) {
      const lead = leads[window.id]
      if (!lead) continue
      const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })
      for (const offset of [-2, -1, 0, 1]) {
        const occ = getWindowOccurrence(window, nowHome.plus({ days: offset }).toISODate()!, 'UTC')
        if (!occ) continue
        const openAtMs = occ.start.toMillis()
        const endAtMs = occ.end.toMillis()
        const alertAtMs = openAtMs - lead * 60_000
        if (alertAtMs <= sinceMs || alertAtMs > nowMs || nowMs >= endAtMs) continue
        const key = alertKey(window.id, openAtMs)
        if (fired.has(key)) continue
        due.push({
          key,
          windowId: window.id,
          label: labels.get(window.id) ?? window.name,
          color: window.color,
          alertAtMs,
          openAtMs,
          endAtMs,
          leadMinutes: lead,
        })
      }
    }
  }
  return due.sort((a, b) => a.openAtMs - b.openAtMs || a.label.localeCompare(b.label))
}

/** Whether an alert is recent enough to play a sound (a late catch-up alert stays silent). */
export function isFreshAlert(alert: DueAlert, now: Date): boolean {
  return now.getTime() - alert.alertAtMs <= SOUND_MAX_AGE_MS
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/**
 * Always worked out from `now`, never from when the alert fired:
 * "London opens in 2 minutes", then "London is now open", then "London opened 4 minutes ago"
 * (or "opened 2h 05m ago" past an hour), and "London has closed" once it has ended.
 */
export function bannerMessage(alert: DueAlert, now: Date): string {
  const nowMs = now.getTime()
  if (nowMs < alert.openAtMs) return `${alert.label} opens in ${plural(Math.ceil((alert.openAtMs - nowMs) / 60_000), 'minute')}`
  if (nowMs >= alert.endAtMs) return `${alert.label} has closed`
  const minutes = Math.floor((nowMs - alert.openAtMs) / 60_000)
  if (minutes < 1) return `${alert.label} is now open`
  if (minutes < 60) return `${alert.label} opened ${plural(minutes, 'minute')} ago`
  return `${alert.label} opened ${formatDuration(nowMs - alert.openAtMs)} ago`
}

/**
 * A banner goes away when its window ends, or BANNER_LINGER_MS after it was first seen open.
 * Counting from when it was seen (not from the open time) means a banner you slept through is
 * still there, saying "opened 4 minutes ago", when you come back.
 */
export function isBannerExpired(alert: DueAlert, now: Date): boolean {
  const nowMs = now.getTime()
  if (nowMs >= alert.endAtMs) return true
  return alert.openSeenAtMs !== undefined && nowMs >= alert.openSeenAtMs + BANNER_LINGER_MS
}

/**
 * Starts the linger clock for banners whose window has opened. Only while the page is visible, so
 * a background tab that happens to run a timer can't use up the time before anyone sees it.
 * Returns the same array when nothing changed.
 */
export function stampOpenSeen(banners: DueAlert[], now: Date, pageVisible: boolean): DueAlert[] {
  if (!pageVisible) return banners
  const nowMs = now.getTime()
  if (!banners.some((b) => b.openSeenAtMs === undefined && nowMs >= b.openAtMs)) return banners
  return banners.map((b) => (b.openSeenAtMs === undefined && nowMs >= b.openAtMs ? { ...b, openSeenAtMs: nowMs } : b))
}

/** Keys of alerts already shown, with each one's open time, so a refresh doesn't repeat them. */
export type FiredAlerts = Map<string, number>

/** Drops entries for occurrences that opened more than two hours ago; they can no longer come due. */
export function pruneFired(fired: ReadonlyMap<string, number>, nowMs: number): FiredAlerts {
  return new Map([...fired].filter(([, openAtMs]) => openAtMs > nowMs - 2 * 60 * 60_000))
}

export function loadFired(storage: StorageLike | null = getStorage()): FiredAlerts {
  try {
    const raw = storage?.getItem(FIRED_STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = (JSON.parse(raw) as { fired?: unknown } | null)?.fired
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
    return new Map(Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])))
  } catch {
    return new Map()
  }
}

/** Returns false (and does nothing else) if storage isn't available or fails. */
export function saveFired(fired: ReadonlyMap<string, number>, storage: StorageLike | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(FIRED_STORAGE_KEY, JSON.stringify({ fired: Object.fromEntries(fired) }))
    return true
  } catch {
    return false
  }
}
