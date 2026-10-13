import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * Freezes the clock at an instant: `Date.now()`, `new Date()` and the timers the app uses all stand
 * still until a test moves them with `advance`. Call it BEFORE rendering. Restored after each test
 * (see setup.ts).
 */
export function freezeClock(isoInstant: string): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(isoInstant))
}

/** Moves the frozen clock forward, running whatever the app scheduled in that time (wrapped in act so React updates). */
export function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
