import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { formatClock, formatDuration, formatTimeRange, getLocalTimeZone } from './formatTime'

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

describe('formatDuration', () => {
  const min = 60_000
  it('formats hours and zero-padded minutes', () => {
    expect(formatDuration(72 * min)).toBe('1h 12m')
    expect(formatDuration(185 * min)).toBe('3h 05m')
    expect(formatDuration(120 * min)).toBe('2h 00m')
    expect(formatDuration(25 * 60 * min)).toBe('25h 00m')
  })
  it('formats under an hour without hours', () => {
    expect(formatDuration(12 * min)).toBe('12m')
    expect(formatDuration(59 * min + 59_999)).toBe('59m')
  })
  it('shows <1m below one minute and never goes negative', () => {
    expect(formatDuration(59_999)).toBe('<1m')
    expect(formatDuration(0)).toBe('<1m')
    expect(formatDuration(-5000)).toBe('<1m')
  })
})

describe('formatTimeRange', () => {
  const ref = DateTime.fromISO('2026-01-14T12:00', { zone: 'America/New_York' })
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'America/New_York' })
  it('has no tags when both times are today', () => {
    expect(formatTimeRange(at('2026-01-14T09:30'), at('2026-01-14T16:00'), ref)).toBe('09:30 - 16:00')
  })
  it('tags an end on the next day', () => {
    expect(formatTimeRange(at('2026-01-14T18:00'), at('2026-01-15T17:00'), ref)).toBe('18:00 - 17:00 (+1d)')
  })
  it('tags a start on the previous day', () => {
    expect(formatTimeRange(at('2026-01-13T18:00'), at('2026-01-14T17:00'), ref)).toBe('18:00 (-1d) - 17:00')
  })
})
