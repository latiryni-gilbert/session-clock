import { IANAZone } from 'luxon'
import { PRESET_GROUPS } from '../config/presets'
import type { PresetGroup, TradingWindow, Weekday } from './tradingWindow'
import { getStorage, type StorageLike } from './windowSettings'

export const CUSTOM_GROUP: Pick<PresetGroup, 'name' | 'shortName'> = { name: 'My windows', shortName: 'Mine' }
export const CUSTOM_ID_PREFIX = 'custom-'
export const STORAGE_KEY = 'session-clock:custom-windows'
export const LIMITS = { name: 30, shortName: 4 } as const

/** Preset colors for the form (distinct from the built-in presets' palette). */
export const COLOR_SWATCHES = [
  '#eab308', '#84cc16', '#2dd4bf', '#06b6d4', '#6366f1', '#d946ef', '#f43f5e', '#94a3b8',
] as const

/** What the form edits: a window without an id, with fields as typed. */
export interface WindowDraft {
  name: string
  shortName: string
  start: string
  end: string
  timeZone: string
  days: Weekday[]
  color: string
}

export type DraftField = 'name' | 'shortName' | 'start' | 'end' | 'timeZone' | 'days' | 'color'
export type DraftErrors = Partial<Record<DraftField, string>>

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7]

const length = (s: string) => Array.from(s).length // counts characters, not UTF-16 units

export function emptyDraft(timeZone: string): WindowDraft {
  return { name: '', shortName: '', start: '', end: '', timeZone, days: [1, 2, 3, 4, 5], color: COLOR_SWATCHES[0] }
}

/** Checks a draft and returns an error message per bad field; an empty object means it can be saved. */
export function validateDraft(draft: WindowDraft): DraftErrors {
  const errors: DraftErrors = {}

  const name = draft.name.trim()
  if (!name) errors.name = 'Enter a name.'
  else if (length(name) > LIMITS.name) errors.name = `Use ${LIMITS.name} characters or fewer.`

  const shortName = draft.shortName.trim()
  if (!shortName) errors.shortName = 'Enter a short label.'
  else if (length(shortName) > LIMITS.shortName) errors.shortName = `Use ${LIMITS.shortName} characters or fewer.`

  if (!draft.start) errors.start = 'Enter a start time.'
  else if (!TIME_OF_DAY.test(draft.start)) errors.start = 'Use a 24-hour time like 09:30.'

  if (!draft.end) errors.end = 'Enter an end time.'
  else if (!TIME_OF_DAY.test(draft.end)) errors.end = 'Use a 24-hour time like 17:00.'
  else if (!errors.start && draft.start === draft.end) errors.end = 'The end time must be different from the start time.'

  const zone = draft.timeZone.trim()
  if (!zone) errors.timeZone = 'Choose a time zone.'
  else if (!IANAZone.isValidZone(zone)) errors.timeZone = 'Pick a time zone from the list, like America/New_York.'

  if (draft.days.length === 0) errors.days = 'Pick at least one day.'

  if (!HEX_COLOR.test(draft.color)) errors.color = 'Pick a color.'

  return errors
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')

/** "custom-<name>-<4 random chars>", re-rolled until it isn't in `taken`. */
export function generateCustomId(name: string, taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const base = `${CUSTOM_ID_PREFIX}${slug(name) || 'window'}`
  for (;;) {
    const id = `${base}-${random().toString(36).slice(2, 6).padEnd(4, '0')}`
    if (!taken.has(id)) return id
  }
}

/** Turns a valid draft into a window with a fresh unique id. Throws if the draft is invalid. */
export function createCustomWindow(
  draft: WindowDraft,
  takenIds: ReadonlySet<string>,
  random: () => number = Math.random,
): TradingWindow {
  if (Object.keys(validateDraft(draft)).length > 0) throw new Error('Cannot create a window from an invalid draft')
  const name = draft.name.trim()
  return {
    id: generateCustomId(name, takenIds, random),
    name,
    shortName: draft.shortName.trim(),
    start: draft.start,
    end: draft.end,
    timeZone: draft.timeZone.trim(),
    days: WEEKDAYS.filter((d) => draft.days.includes(d)),
    color: draft.color.toLowerCase(),
  }
}

/** Every window id currently in use: presets plus the given custom windows. */
export function allWindowIds(custom: readonly TradingWindow[]): Set<string> {
  return new Set([...PRESET_GROUPS.flatMap((g) => g.windows.map((w) => w.id)), ...custom.map((w) => w.id)])
}

/** The built-in groups, plus a "My windows" group at the bottom when there are custom windows. */
export function buildGroups(custom: readonly TradingWindow[]): PresetGroup[] {
  return custom.length > 0 ? [...PRESET_GROUPS, { ...CUSTOM_GROUP, windows: [...custom] }] : PRESET_GROUPS
}

function asValidWindow(value: unknown, taken: ReadonlySet<string>): TradingWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const strings = ['id', 'name', 'shortName', 'start', 'end', 'timeZone', 'color'] as const
  if (!strings.every((k) => typeof v[k] === 'string')) return null
  if (!Array.isArray(v.days) || !v.days.every((d) => WEEKDAYS.includes(d as Weekday))) return null
  const id = v.id as string
  if (!id.startsWith(CUSTOM_ID_PREFIX) || taken.has(id)) return null
  const draft: WindowDraft = {
    name: v.name as string,
    shortName: v.shortName as string,
    start: v.start as string,
    end: v.end as string,
    timeZone: v.timeZone as string,
    days: v.days as Weekday[],
    color: v.color as string,
  }
  if (Object.keys(validateDraft(draft)).length > 0) return null
  return { ...createCustomWindow(draft, new Set(), () => 0), id }
}

/**
 * Reads saved custom windows. Falls back to none if storage is unavailable, throws,
 * or holds anything unexpected; individual bad entries are skipped. Entries whose id is
 * already used (by a preset or an earlier entry) are skipped too.
 */
export function loadCustomWindows(storage: StorageLike | null = getStorage()): TradingWindow[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = (JSON.parse(raw) as { windows?: unknown } | null)?.windows
    if (!Array.isArray(list)) return []
    const taken = allWindowIds([])
    const result: TradingWindow[] = []
    for (const item of list) {
      const w = asValidWindow(item, taken)
      if (!w) continue
      taken.add(w.id)
      result.push(w)
    }
    return result
  } catch {
    return []
  }
}

/** Saves custom windows. Returns false (and does nothing else) if storage isn't available or fails. */
export function saveCustomWindows(windows: readonly TradingWindow[], storage: StorageLike | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(STORAGE_KEY, JSON.stringify({ windows }))
    return true
  } catch {
    return false
  }
}
