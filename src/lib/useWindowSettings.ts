import { useCallback, useState } from 'react'
import { loadDisabledIds, saveDisabledIds, type DisabledIds } from './windowSettings'

/** Which windows are switched off, persisted to localStorage when it is available. */
export function useWindowSettings() {
  const [disabled, setDisabled] = useState<DisabledIds>(() => loadDisabledIds())
  const [saveFailed, setSaveFailed] = useState(false)

  const update = useCallback((next: DisabledIds) => {
    setDisabled(next)
    setSaveFailed(!saveDisabledIds(next))
  }, [])

  return { disabled, update, saveFailed }
}
