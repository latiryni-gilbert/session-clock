import { DateTime } from 'luxon'
import type { AlertLead } from './alertSettings'
import { getWindowOccurrence } from './convertWindow'
import type { PresetGroup } from './tradingWindow'
import { getStorage, type StorageLike } from './windowSettings'

/**
 * An alert is due from its alert time until this long after it (or until the window opens, if
 * sooner). The slack lets a throttled background tab still catch it, while a page opened long
 * after the alert time stays quiet.
 */
export const ALERT_GRACE_MS = 2 * 60_000
/** A banner disappears on its own this long after its window opens. */
export const BANNER_LINGER_MS = 60_000
export const FIRED_STORAGE_KEY = 'session-clock:alerts-fired'

export interface DueAlert {
  /** Identifies one occurrence of one window: the same occurrence always has the same key. */
  key: string
  windowId: string
  /** Readable name, qualified by group when two windows share a name ("Forex London"). */
  label: string
  color: string
  openAtMs: number
  leadMinutes: number
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
 * Which alerts should fire right now.
 *
 * For every window with an alert lead time, looks at its occurrences that open today or
 * tomorrow in its home zone (so an alert time before midnight for an open just after it is
 * found, and so is an overnight window's next start). An occurrence is due when
 * `open - lead <= now < min(open - lead + grace, open)` and it is not in `fired`.
 * Works on instants, so it doesn't depend on the display zone.
 */
export function getDueAlerts(
  groups: readonly PresetGroup[],
  leads: Readonly<Record<string, AlertLead>>,
  now: Date,
  fired: ReadonlyMap<string, number>,
): DueAlert[] {
  const nowMs = now.getTime()
  const labels = windowLabels(groups)
  const due: DueAlert[] = []

  for (const group of groups) {
    for (const window of group.windows) {
      const lead = leads[window.id]
      if (!lead) continue
      const nowHome = DateTime.fromJSDate(now, { zone: window.timeZone })
      for (const offset of [0, 1]) {
        const occ = getWindowOccurrence(window, nowHome.plus({ days: offset }).toISODate()!, 'UTC')
        if (!occ) continue
        const openAtMs = occ.start.toMillis()
        const alertAt = openAtMs - lead * 60_000
        if (nowMs < alertAt || nowMs >= Math.min(alertAt + ALERT_GRACE_MS, openAtMs)) continue
        const key = alertKey(window.id, openAtMs)
        if (fired.has(key)) continue
        due.push({ key, windowId: window.id, label: labels.get(window.id) ?? window.name, color: window.color, openAtMs, leadMinutes: lead })
      }
    }
  }
  return due.sort((a, b) => a.openAtMs - b.openAtMs || a.label.localeCompare(b.label))
}

/** "London opens in 15 minutes", counting down as time passes, then "London is now open". */
export function bannerMessage(alert: DueAlert, now: Date): string {
  const msLeft = alert.openAtMs - now.getTime()
  if (msLeft <= 0) return `${alert.label} is now open`
  const minutes = Math.ceil(msLeft / 60_000)
  return `${alert.label} opens in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

export function isBannerExpired(alert: DueAlert, now: Date): boolean {
  return now.getTime() >= alert.openAtMs + BANNER_LINGER_MS
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
