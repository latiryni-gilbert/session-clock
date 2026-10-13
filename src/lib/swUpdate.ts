import { useSyncExternalStore } from 'react'

/**
 * Whether a newer version of the app has been downloaded and is waiting. The service worker
 * registration (src/main.tsx) calls `markUpdateAvailable`; the UpdatePrompt component reads it.
 * Kept as a tiny store so nothing else needs to know about service workers.
 */
type Listener = () => void

interface Snapshot {
  available: boolean
}

let snapshot: Snapshot = { available: false }
let apply: (() => void) | null = null
const listeners = new Set<Listener>()

function set(next: Snapshot) {
  snapshot = next
  listeners.forEach((l) => l())
}

/** A new version is ready; `applyUpdate` will run `applyFn` (which activates it and reloads the page). */
export function markUpdateAvailable(applyFn: () => void): void {
  apply = applyFn
  set({ available: true })
}

/** Hide the prompt for now (the new version stays waiting and installs the next time the app is reloaded). */
export function dismissUpdate(): void {
  set({ available: false })
}

/** Switch to the new version. Never throws. */
export function applyUpdate(): void {
  try {
    apply?.()
  } catch {
    // If activation fails the old version simply keeps running.
  }
}

/** Back to "no update"; for tests. */
export function resetUpdateState(): void {
  apply = null
  set({ available: false })
}

const subscribe = (listener: Listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = () => snapshot

export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot).available
}
