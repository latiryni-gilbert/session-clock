import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Vitest globals are off, so Testing Library can't register its own cleanup: unmount between tests here.
afterEach(() => {
  cleanup()
  // Each test starts with empty saved settings, and with the real clock restored.
  window.localStorage.clear()
  vi.useRealTimers()
})

// jsdom has no layout, so it doesn't implement scrolling; the app scrolls the settings panel after adding a window.
Element.prototype.scrollTo = () => {}

// Testing Library waits for a zero-delay timer after each async step (e.g. a user-event click). With the clock
// frozen that timer never fires on its own, and the library only knows how to nudge it when a global `jest`
// exists, so give it a tiny stand-in that advances Vitest's fake timers by that 0 ms (the clock does not move).
;(globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) }
