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
