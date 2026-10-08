import { createCustomWindow, validateDraft, type WindowDraft } from './customWindows'
import type { TradingWindow } from './tradingWindow'
import type { DisabledIds } from './windowSettings'

/** How long the "Deleted" note keeps its Undo button, in milliseconds. */
export const UNDO_WINDOW_MS = 5000

/** Everything needed to put a deleted custom window back exactly as it was. */
export interface DeletedWindow {
  window: TradingWindow
  /** Position in the "My windows" list. */
  index: number
  /** Whether the window was switched off when it was deleted. */
  wasDisabled: boolean
}

/** The form values for an existing window, for pre-filling the edit form. */
export function draftFromWindow(window: TradingWindow): WindowDraft {
  return {
    name: window.name,
    shortName: window.shortName,
    start: window.start,
    end: window.end,
    timeZone: window.timeZone,
    days: [...window.days],
    color: window.color,
  }
}

/**
 * Replaces the fields of window `id` with a valid draft. The window keeps its id (so its
 * on/off state carries over) and its position. Throws if the draft is invalid or `id` is unknown.
 */
export function updateCustomWindow(custom: readonly TradingWindow[], id: string, draft: WindowDraft): TradingWindow[] {
  if (!custom.some((w) => w.id === id)) throw new Error(`No custom window with id "${id}"`)
  if (Object.keys(validateDraft(draft)).length > 0) throw new Error('Cannot save an invalid draft')
  // createCustomWindow trims, sorts days and normalizes the color; its throwaway id is replaced.
  const updated = { ...createCustomWindow(draft, new Set()), id }
  return custom.map((w) => (w.id === id ? updated : w))
}

/**
 * Removes window `id` and forgets its on/off state. Returns what was removed so it can be
 * restored, or `deleted: null` (everything unchanged) if `id` isn't a custom window here.
 */
export function deleteCustomWindow(
  custom: readonly TradingWindow[],
  disabled: DisabledIds,
  id: string,
): { custom: TradingWindow[]; disabled: Set<string>; deleted: DeletedWindow | null } {
  const index = custom.findIndex((w) => w.id === id)
  if (index === -1) return { custom: [...custom], disabled: new Set(disabled), deleted: null }
  const nextDisabled = new Set(disabled)
  nextDisabled.delete(id)
  return {
    custom: custom.filter((w) => w.id !== id),
    disabled: nextDisabled,
    deleted: { window: custom[index], index, wasDisabled: disabled.has(id) },
  }
}

/** Puts a deleted window back at its old position with its old on/off state. Does nothing if its id is back in use. */
export function restoreCustomWindow(
  custom: readonly TradingWindow[],
  disabled: DisabledIds,
  deleted: DeletedWindow,
): { custom: TradingWindow[]; disabled: Set<string> } {
  if (custom.some((w) => w.id === deleted.window.id)) return { custom: [...custom], disabled: new Set(disabled) }
  const next = [...custom]
  next.splice(Math.min(deleted.index, next.length), 0, deleted.window)
  const nextDisabled = new Set(disabled)
  if (deleted.wasDisabled) nextDisabled.add(deleted.window.id)
  return { custom: next, disabled: nextDisabled }
}
