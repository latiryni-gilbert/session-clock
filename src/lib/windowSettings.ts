import { PRESET_GROUPS } from '../config/presets'
import type { PresetGroup } from './tradingWindow'

/** The slice of the Web Storage API this module uses. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const STORAGE_KEY = 'session-clock:settings'

/** Ids of windows the user switched off. Storing the "off" set means new presets default to on. */
export type DisabledIds = ReadonlySet<string>

export type GroupState = 'on' | 'off' | 'mixed'

const ALL_IDS = PRESET_GROUPS.flatMap((g) => g.windows.map((w) => w.id))

/** The browser's localStorage, or null where it is missing or blocked (it can throw on access). */
export function getStorage(): StorageLike | null {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * Reads the switched-off window ids. Falls back to "everything on" (an empty set)
 * if storage is unavailable, throws, or holds anything unexpected. Unknown ids,
 * e.g. from a preset that has since been removed, are dropped.
 */
export function loadDisabledIds(
  storage: StorageLike | null = getStorage(),
  knownIds: Iterable<string> = ALL_IDS,
): Set<string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    const list = (parsed as { disabled?: unknown } | null)?.disabled
    if (!Array.isArray(list)) return new Set()
    const known = new Set(knownIds)
    return new Set(list.filter((id): id is string => typeof id === 'string' && known.has(id)))
  } catch {
    return new Set()
  }
}

/** Saves the switched-off ids. Returns false (and does nothing else) if storage isn't available or fails. */
export function saveDisabledIds(disabled: DisabledIds, storage: StorageLike | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(STORAGE_KEY, JSON.stringify({ disabled: [...disabled].sort() }))
    return true
  } catch {
    return false
  }
}

export function isWindowEnabled(disabled: DisabledIds, id: string): boolean {
  return !disabled.has(id)
}

export function setWindowEnabled(disabled: DisabledIds, id: string, enabled: boolean): Set<string> {
  const next = new Set(disabled)
  if (enabled) next.delete(id)
  else next.add(id)
  return next
}

/** "on" if every window in the group is on, "off" if none is, otherwise "mixed". */
export function getGroupState(disabled: DisabledIds, group: PresetGroup): GroupState {
  const on = group.windows.filter((w) => !disabled.has(w.id)).length
  if (on === group.windows.length) return 'on'
  return on === 0 ? 'off' : 'mixed'
}

export function setGroupEnabled(disabled: DisabledIds, group: PresetGroup, enabled: boolean): Set<string> {
  const next = new Set(disabled)
  for (const w of group.windows) {
    if (enabled) next.delete(w.id)
    else next.add(w.id)
  }
  return next
}

/** The groups with switched-off windows removed; a group left with no windows is dropped entirely. */
export function applySettings(groups: PresetGroup[], disabled: DisabledIds): PresetGroup[] {
  return groups
    .map((g) => ({ ...g, windows: g.windows.filter((w) => !disabled.has(w.id)) }))
    .filter((g) => g.windows.length > 0)
}
