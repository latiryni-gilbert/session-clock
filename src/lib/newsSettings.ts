import { isAlertLead, type AlertLead } from './alertSettings'
import { getStorage, type StorageLike } from './windowSettings'

export interface NewsSettings {
  /** Show news events (timeline markers, the "Next event" line) and allow their alerts. */
  enabled: boolean
  /** Minutes before a news event to raise an alert, or null for no alert. */
  alertLead: AlertLead | null
}

export const NEWS_STORAGE_KEY = 'session-clock:news'

export const DEFAULT_NEWS_SETTINGS: NewsSettings = { enabled: true, alertLead: null }

/**
 * Reads the saved news settings. Falls back to the defaults (on, no alert) if storage is
 * unavailable, throws, or holds anything unexpected; each field is checked on its own.
 */
export function loadNewsSettings(storage: StorageLike | null = getStorage()): NewsSettings {
  try {
    const raw = storage?.getItem(NEWS_STORAGE_KEY)
    if (!raw) return DEFAULT_NEWS_SETTINGS
    const parsed = JSON.parse(raw) as { enabled?: unknown; alert?: unknown } | null
    return {
      enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : true,
      alertLead: isAlertLead(parsed?.alert) ? parsed.alert : null,
    }
  } catch {
    return DEFAULT_NEWS_SETTINGS
  }
}

/** Saves the news settings. Returns false (and does nothing else) if storage isn't available or fails. */
export function saveNewsSettings(settings: NewsSettings, storage: StorageLike | null = getStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(NEWS_STORAGE_KEY, JSON.stringify({ enabled: settings.enabled, alert: settings.alertLead }))
    return true
  } catch {
    return false
  }
}
