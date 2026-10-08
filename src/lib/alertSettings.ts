import { PRESET_GROUPS } from '../config/presets'
import { getStorage, type StorageLike } from './windowSettings'

/** Minutes before a window opens at which to alert. A window with no entry has alerts off. */
export const ALERT_LEADS = [5, 15, 30] as const
export type AlertLead = (typeof ALERT_LEADS)[number]

export interface AlertSettings {
  /** Window id -> lead time. Windows not listed have alerts off. */
  lead: Readonly<Record<string, AlertLead>>
  soundOn: boolean
  /** Send a system notification when an alert fires while the page is hidden. Needs browser permission. */
  notificationsOn: boolean
}

export const ALERTS_STORAGE_KEY = 'session-clock:alerts'

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { lead: {}, soundOn: true, notificationsOn: false }

const PRESET_IDS = PRESET_GROUPS.flatMap((g) => g.windows.map((w) => w.id))

export const isAlertLead = (value: unknown): value is AlertLead => ALERT_LEADS.some((l) => l === value)

export function getAlertLead(settings: AlertSettings, id: string): AlertLead | null {
  return settings.lead[id] ?? null
}

/** Sets a window's alert lead time, or turns its alert off with `null`. */
export function setAlertLead(settings: AlertSettings, id: string, lead: AlertLead | null): AlertSettings {
  const next = { ...settings.lead }
  if (lead === null) delete next[id]
  else next[id] = lead
  return { ...settings, lead: next }
}

/** Forgets a window's alert setting (used when a custom window is deleted). */
export function removeAlert(settings: AlertSettings, id: string): AlertSettings {
  return setAlertLead(settings, id, null)
}

export function setSoundOn(settings: AlertSettings, soundOn: boolean): AlertSettings {
  return { ...settings, soundOn }
}

export function setNotificationsOn(settings: AlertSettings, notificationsOn: boolean): AlertSettings {
  return { ...settings, notificationsOn }
}

/**
 * Reads saved alert settings. Falls back to the defaults (all alerts off, sound on, notifications off) if storage
 * is unavailable, throws, or holds anything unexpected. Entries with an unknown window id or an
 * unsupported lead time are dropped.
 */
export function loadAlertSettings(
  storage: StorageLike | null = getStorage(),
  knownIds: Iterable<string> = PRESET_IDS,
): AlertSettings {
  try {
    const raw = storage?.getItem(ALERTS_STORAGE_KEY)
    if (!raw) return DEFAULT_ALERT_SETTINGS
    const parsed = JSON.parse(raw) as { lead?: unknown; sound?: unknown; notify?: unknown } | null
    const known = new Set(knownIds)
    const lead: Record<string, AlertLead> = {}
    if (parsed && typeof parsed.lead === 'object' && parsed.lead !== null && !Array.isArray(parsed.lead)) {
      for (const [id, value] of Object.entries(parsed.lead)) {
        if (known.has(id) && isAlertLead(value)) lead[id] = value
      }
    }
    return {
      lead,
      soundOn: typeof parsed?.sound === 'boolean' ? parsed.sound : true,
      notificationsOn: parsed?.notify === true,
    }
  } catch {
    return DEFAULT_ALERT_SETTINGS
  }
}

/** Saves alert settings. Returns false (and does nothing else) if storage isn't available or fails. */
export function saveAlertSettings(settings: AlertSettings, storage: StorageLike | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(ALERTS_STORAGE_KEY, JSON.stringify({ lead: settings.lead, sound: settings.soundOn, notify: settings.notificationsOn }))
    return true
  } catch {
    return false
  }
}
