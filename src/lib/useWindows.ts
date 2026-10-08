import { useCallback, useState } from 'react'
import { allWindowIds, createCustomWindow, loadCustomWindows, saveCustomWindows, validateDraft, type WindowDraft } from './customWindows'
import type { TradingWindow } from './tradingWindow'
import { loadDisabledIds, saveDisabledIds, type DisabledIds } from './windowSettings'

interface State {
  custom: TradingWindow[]
  disabled: DisabledIds
  /** True once a save to localStorage has failed (storage blocked or full). */
  saveFailed: boolean
}

function init(): State {
  const custom = loadCustomWindows()
  // Known ids include custom windows, so a switched-off custom window stays off after a reload.
  return { custom, disabled: loadDisabledIds(undefined, allWindowIds(custom)), saveFailed: false }
}

/** The user's custom windows and which windows are switched off, persisted when localStorage is available. */
export function useWindows() {
  const [state, setState] = useState(init)

  const setDisabled = useCallback((next: DisabledIds) => {
    const ok = saveDisabledIds(next)
    setState((s) => ({ ...s, disabled: next, saveFailed: s.saveFailed || !ok }))
  }, [])

  /** Adds a custom window from a valid draft. Returns false (and adds nothing) if the draft is invalid. */
  const addCustomWindow = useCallback(
    (draft: WindowDraft): boolean => {
      if (Object.keys(validateDraft(draft)).length > 0) return false
      // Created and saved here, not inside a state updater: updaters can run twice (StrictMode),
      // which would save one random id and keep another.
      const custom = [...state.custom, createCustomWindow(draft, allWindowIds(state.custom))]
      const ok = saveCustomWindows(custom)
      setState((s) => ({ ...s, custom, saveFailed: s.saveFailed || !ok }))
      return true
    },
    [state.custom],
  )

  return { custom: state.custom, disabled: state.disabled, saveFailed: state.saveFailed, setDisabled, addCustomWindow }
}
