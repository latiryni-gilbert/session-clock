import { describe, expect, it } from 'vitest'
import { formatScheduledThrough } from './scheduleText'

describe('formatScheduledThrough', () => {
  it('names the last day that is fully covered: the day before the one the horizon falls in', () => {
    // Horizon at 15:00 on Mon 7 Dec (New York): Sunday 6 Dec is the last whole day.
    expect(formatScheduledThrough(Date.parse('2026-12-07T20:00:00Z'), 'America/New_York')).toBe('Sun, Dec 6')
  })
  it('counts a horizon exactly at midnight as covering the whole day before', () => {
    expect(formatScheduledThrough(Date.parse('2026-12-07T05:00:00Z'), 'America/New_York')).toBe('Sun, Dec 6')
  })
  it('uses the viewer’s own day, not UTC', () => {
    // 02:00Z on 7 Dec is still the evening of 6 Dec in New York, so the last whole day is the 5th there.
    expect(formatScheduledThrough(Date.parse('2026-12-07T02:00:00Z'), 'America/New_York')).toBe('Sat, Dec 5')
    expect(formatScheduledThrough(Date.parse('2026-12-07T02:00:00Z'), 'UTC')).toBe('Sun, Dec 6')
  })
  it('works across a year end', () => {
    expect(formatScheduledThrough(Date.parse('2027-01-02T12:00:00Z'), 'UTC')).toBe('Fri, Jan 1')
  })
})
