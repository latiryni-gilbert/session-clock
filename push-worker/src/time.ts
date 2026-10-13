import { DAY_MS } from './constants'

/** The UTC day a moment falls in, as a number (days since 1970-01-01). */
export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS)

/** Whole seconds from `ms` until the next 00:00 UTC (at least 1). Daily counters reset then. */
export const secondsUntilUtcMidnight = (ms: number): number => Math.max(1, Math.ceil(((utcDay(ms) + 1) * DAY_MS - ms) / 1000))
