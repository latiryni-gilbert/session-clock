import { describe, expect, it } from 'vitest'
import { formatClock, getLocalTimeZone } from './formatTime'

describe('formatClock', () => {
  const instant = new Date('2026-01-14T14:30:05Z')

  it('formats in the given zone as 24-hour HH:mm:ss', () => {
    expect(formatClock(instant, 'UTC')).toBe('14:30:05')
    expect(formatClock(instant, 'America/New_York')).toBe('09:30:05')
    expect(formatClock(instant, 'Asia/Tokyo')).toBe('23:30:05')
  })

  it('zero-pads and shows midnight as 00', () => {
    expect(formatClock(new Date('2026-01-14T00:00:00Z'), 'UTC')).toBe('00:00:00')
    expect(formatClock(new Date('2026-01-14T03:04:05Z'), 'UTC')).toBe('03:04:05')
  })

  it('follows daylight saving time', () => {
    const summer = new Date('2026-07-14T14:30:05Z')
    expect(formatClock(summer, 'America/New_York')).toBe('10:30:05')
  })

  it('throws on an unknown zone', () => {
    expect(() => formatClock(instant, 'Mars/Base')).toThrow()
  })
})

describe('getLocalTimeZone', () => {
  it('returns a non-empty zone name Luxon accepts', () => {
    expect(formatClock(new Date(), getLocalTimeZone())).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})
