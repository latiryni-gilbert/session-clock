import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'

// Smoke test: proves Vitest runs and Luxon can do time zone math.
describe('toolchain', () => {
  it('converts between time zones with Luxon', () => {
    const utc = DateTime.fromISO('2026-01-15T12:00:00', { zone: 'utc' })
    expect(utc.setZone('America/New_York').hour).toBe(7)
  })
})
