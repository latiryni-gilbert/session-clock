import { useCallback, useEffect, useState } from 'react'
import {
  deleteCustomWindow,
  restoreCustomWindow,
  UNDO_WINDOW_MS,
  updateCustomWindow,
  type DeletedWindow,
} from './customWindowActions'
import {
  loadAlertSettings,
  removeAlert,
  saveAlertSettings,
  setAlertLead,
  setSoundOn,
  type AlertLead,
  type AlertSettings,
} from './alertSettings'
import { allWindowIds, createCustomWindow, loadCustomWindows, saveCustomWindows, validateDraft, type WindowDraft } from './customWindows'
import type { TradingWindow } from './tradingWindow'
import { loadDisabledIds, saveDisabledIds, type DisabledIds } from './windowSettings'

interface State {
  custom: TradingWindow[]
  disabled: DisabledIds
  /** True once a save to localStorage has failed (storage blocked or full). */
  saveFailed: boolean
  /** The most recently deleted custom window (with its alert setting), kept briefly so it can be undone. */
  lastDeleted: (DeletedWindow & { alertLead: AlertLead | null }) | null
  alerts: AlertSettings
}

function init(): State {
  const custom = loadCustomWindows()
  // Known ids include custom windows, so a switched-off custom window stays off after a reload.
  const ids = allWindowIds(custom)
  return {
    custom,
    disabled: loadDisabledIds(undefined, ids),
    alerts: loadAlertSettings(undefined, ids),
    saveFailed: false,
    lastDeleted: null,
  }
}

// Side effects (saving) happen in the callbacks below, not inside state updaters: updaters can
// run twice (StrictMode), which would e.g. save one random id and keep another.
/** The user's custom windows and which windows are switched off, persisted when localStorage is available. */
export function useWindows() {
  const [state, setState] = useState(init)

  // The Undo offer lasts a few seconds, then the deleted window is gone for good.
  const { lastDeleted } = state
  useEffect(() => {
    if (!lastDeleted) return
    const timer = setTimeout(() => setState((s) => (s.lastDeleted === lastDeleted ? { ...s, lastDeleted: null } : s)), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [lastDeleted])

  const setDisabled = useCallback((next: DisabledIds) => {
    const ok = saveDisabledIds(next)
    setState((s) => ({ ...s, disabled: next, saveFailed: s.saveFailed || !ok }))
  }, [])

  /** Adds a custom window from a valid draft. Returns false (and adds nothing) if the draft is invalid. */
  const addCustomWindow = useCallback(
    (draft: WindowDraft): boolean => {
      if (Object.keys(validateDraft(draft)).length > 0) return false
      const custom = [...state.custom, createCustomWindow(draft, allWindowIds(state.custom))]
      const ok = saveCustomWindows(custom)
      setState((s) => ({ ...s, custom, saveFailed: s.saveFailed || !ok }))
      return true
    },
    [state.custom],
  )

  /** Saves changes to a custom window, keeping its id. Returns false if the draft is invalid or the id unknown. */
  const editCustomWindow = useCallback(
    (id: string, draft: WindowDraft): boolean => {
      let custom: TradingWindow[]
      try {
        custom = updateCustomWindow(state.custom, id, draft)
      } catch {
        return false
      }
      const ok = saveCustomWindows(custom)
      setState((s) => ({ ...s, custom, saveFailed: s.saveFailed || !ok }))
      return true
    },
    [state.custom],
  )

  /** Deletes a custom window with its saved on/off state and alert setting, and offers Undo for a few seconds. */
  const deleteWindow = useCallback(
    (id: string) => {
      const result = deleteCustomWindow(state.custom, state.disabled, id)
      if (!result.deleted) return
      const alertLead = state.alerts.lead[id] ?? null
      const alerts = removeAlert(state.alerts, id)
      const ok = saveCustomWindows(result.custom) && saveDisabledIds(result.disabled) && saveAlertSettings(alerts)
      setState((s) => ({
        ...s,
        custom: result.custom,
        disabled: result.disabled,
        alerts,
        lastDeleted: { ...result.deleted!, alertLead },
        saveFailed: s.saveFailed || !ok,
      }))
    },
    [state.custom, state.disabled, state.alerts],
  )

  /** Puts the last deleted window back, with its position, on/off state and alert setting. */
  const undoDelete = useCallback(() => {
    if (!state.lastDeleted) return
    const result = restoreCustomWindow(state.custom, state.disabled, state.lastDeleted)
    const { alertLead, window } = state.lastDeleted
    const alerts = alertLead ? setAlertLead(state.alerts, window.id, alertLead) : state.alerts
    const ok = saveCustomWindows(result.custom) && saveDisabledIds(result.disabled) && saveAlertSettings(alerts)
    setState((s) => ({
      ...s,
      custom: result.custom,
      disabled: result.disabled,
      alerts,
      lastDeleted: null,
      saveFailed: s.saveFailed || !ok,
    }))
  }, [state.custom, state.disabled, state.alerts, state.lastDeleted])

  /** Sets (or, with null, turns off) a window's alert lead time. */
  const changeAlertLead = useCallback(
    (id: string, lead: AlertLead | null) => {
      const alerts = setAlertLead(state.alerts, id, lead)
      const ok = saveAlertSettings(alerts)
      setState((s) => ({ ...s, alerts, saveFailed: s.saveFailed || !ok }))
    },
    [state.alerts],
  )

  const changeSoundOn = useCallback(
    (soundOn: boolean) => {
      const alerts = setSoundOn(state.alerts, soundOn)
      const ok = saveAlertSettings(alerts)
      setState((s) => ({ ...s, alerts, saveFailed: s.saveFailed || !ok }))
    },
    [state.alerts],
  )

  return {
    custom: state.custom,
    disabled: state.disabled,
    saveFailed: state.saveFailed,
    lastDeleted: state.lastDeleted,
    alerts: state.alerts,
    changeAlertLead,
    changeSoundOn,
    setDisabled,
    addCustomWindow,
    editCustomWindow,
    deleteWindow,
    undoDelete,
  }
}
