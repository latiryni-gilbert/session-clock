import { useCallback, useState } from 'react'
import type { AlertLead } from './alertSettings'
import { loadNewsSettings, saveNewsSettings, type NewsSettings } from './newsSettings'

/** The news events on/off switch and alert lead time, persisted when localStorage is available. */
export function useNewsSettings() {
  const [state, setState] = useState(() => ({ news: loadNewsSettings(), saveFailed: false }))

  const update = useCallback((patch: Partial<NewsSettings>) => {
    setState((s) => ({ ...s, news: { ...s.news, ...patch } }))
  }, [])

  // Saving happens here, not in a state updater (updaters can run twice in StrictMode).
  const setEnabled = useCallback(
    (enabled: boolean) => {
      const next = { ...state.news, enabled }
      const ok = saveNewsSettings(next)
      update({ enabled })
      if (!ok) setState((s) => ({ ...s, saveFailed: true }))
    },
    [state.news, update],
  )

  const setAlertLead = useCallback(
    (alertLead: AlertLead | null) => {
      const next = { ...state.news, alertLead }
      const ok = saveNewsSettings(next)
      update({ alertLead })
      if (!ok) setState((s) => ({ ...s, saveFailed: true }))
    },
    [state.news, update],
  )

  return { news: state.news, saveFailed: state.saveFailed, setEnabled, setAlertLead }
}
