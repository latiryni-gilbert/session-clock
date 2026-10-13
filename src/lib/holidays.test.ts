import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { NYSE_HOLIDAYS } from '../config/holidays'
import { PRESET_GROUPS } from '../config/presets'
import { getDueAlerts } from './alerts'
import { getWindowOccurrence } from './convertWindow'
import { getHoliday } from './holidays'
import { getTimelineSegments } from './timeline'
import type { HolidayCalendar, TradingWindow } from './tradingWindow'
import { getWindowStatus, statusLabel } from './windowStatus'

const NY = 'America/New_York'
const find = (id: string) => PRESET_GROUPS.flatMap((g) => g.windows).find((w) => w.id === id)!
const nyse = find('nyse-regular')
const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate()
const label = (iso: string, w: TradingWindow = nyse, zone = NY) => statusLabel(getWindowStatus(w, at(iso, zone), zone))
const times = (date: string, w: TradingWindow = nyse, zone = NY) => {
  const o = getWindowOccurrence(w, date, zone)
  return o && [o.start.toFormat('yyyy-MM-dd HH:mm'), o.end.toFormat('yyyy-MM-dd HH:mm')]
}

// 2026 calendar: Wed 25 Nov, Thu 26 (Thanksgiving), Fri 27 (early close), Mon 30. Fri 3 Apr (Good Friday), Fri 3 Jul (Independence Day observed).

describe('getHoliday', () => {
  it('finds a holiday by date and returns nothing for an ordinary day', () => {
    expect(getHoliday(NYSE_HOLIDAYS, '2026-11-26')).toMatchObject({ name: 'Thanksgiving Day', type: 'closed' })
    expect(getHoliday(NYSE_HOLIDAYS, '2026-11-27')).toMatchObject({ type: 'early-close' })
    expect(getHoliday(NYSE_HOLIDAYS, '2026-11-25')).toBeUndefined()
  })
})

describe('full closure', () => {
  it('Thanksgiving 2026 has no NYSE session', () => {
    expect(getWindowOccurrence(nyse, '2026-11-26', NY)).toBeNull()
  })

  it('every closure in the data removes the session, and nothing else does', () => {
    for (const h of NYSE_HOLIDAYS.holidays) {
      const occ = getWindowOccurrence(nyse, h.date, NY)
      if (h.type === 'closed') expect(occ, `${h.date} ${h.name}`).toBeNull()
      else expect(occ, `${h.date} ${h.name}`).not.toBeNull()
    }
  })

  it('on the holiday the next open skips to the next trading day', () => {
    expect(label('2026-11-26T10:00')).toBe('Opens in 23h 30m') // Thanksgiving morning -> Friday 09:30
    expect(label('2026-11-25T17:00')).toBe('Opens Fri 09:30') // Wednesday after the close skips Thursday
  })

  it('other windows are not affected by NYSE holidays', () => {
    expect(times('2026-11-26', find('forex-london'))).toEqual(['2026-11-26 03:00', '2026-11-26 12:00'])
    expect(times('2026-11-26', find('cme-equity-futures'))).not.toBeNull()
    expect(label('2026-11-26T10:00', find('forex-london'))).toMatch(/^Active/)
  })

  it('a window with no holiday calendar ignores the dates', () => {
    const plain: TradingWindow = { ...nyse, holidays: undefined }
    expect(times('2026-11-26', plain)).toEqual(['2026-11-26 09:30', '2026-11-26 16:00'])
  })
})

describe('early close', () => {
  it('the day after Thanksgiving ends at 13:00 instead of 16:00', () => {
    expect(times('2026-11-27')).toEqual(['2026-11-27 09:30', '2026-11-27 13:00'])
    expect(times('2026-12-24')).toEqual(['2026-12-24 09:30', '2026-12-24 13:00'])
    expect(times('2027-11-26')).toEqual(['2027-11-26 09:30', '2027-11-26 13:00'])
  })

  it('a normal day still ends at 16:00', () => {
    expect(times('2026-11-25')).toEqual(['2026-11-25 09:30', '2026-11-25 16:00'])
  })

  it('the status counts down to 13:00, then the session is over until the next trading day', () => {
    expect(label('2026-11-27T12:00')).toBe('Active - ends in 1h 00m')
    expect(label('2026-11-25T12:00')).toBe('Active - ends in 4h 00m') // same time on a normal day: 16:00 close
    expect(label('2026-11-27T13:00')).toBe('Opens Mon 09:30')
    expect(label('2026-11-27T14:30')).toBe('Opens Mon 09:30')
  })

  it('shows the shortened session in another display zone (Tokyo)', () => {
    expect(times('2026-11-27', nyse, 'Asia/Tokyo')).toEqual(['2026-11-27 23:30', '2026-11-28 03:00'])
  })

  it('the timeline bar stops at 13:00, and a closed day has no bar', () => {
    const seg = getTimelineSegments(nyse, at('2026-11-27T12:00'), NY)
    expect(seg).toHaveLength(1)
    expect(seg[0].start).toBeCloseTo(9.5 / 24, 10)
    expect(seg[0].end).toBeCloseTo(13 / 24, 10)
    expect(getTimelineSegments(nyse, at('2026-11-26T12:00'), NY)).toEqual([])
  })
})

describe('holidays pushing the next open to the next trading day', () => {
  it('a Friday holiday (Independence Day observed, 3 July 2026) pushes the open to Monday', () => {
    expect(times('2026-07-03')).toBeNull()
    expect(label('2026-07-02T17:00')).toBe('Opens Mon 09:30') // Thursday evening
    expect(label('2026-07-03T10:00')).toBe('Opens Mon 09:30') // on the Friday itself
    const status = getWindowStatus(nyse, at('2026-07-02T17:00'), NY)
    expect(status.start.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-06 09:30')
  })

  it('Christmas on a Friday (2026) pushes the open to Monday, after the Thursday early close', () => {
    expect(label('2026-12-24T13:00')).toBe('Opens Mon 09:30')
    expect(getWindowStatus(nyse, at('2026-12-24T13:00'), NY).start.toFormat('yyyy-MM-dd')).toBe('2026-12-28')
  })

  it('a Monday holiday (Martin Luther King Jr. Day, 19 January 2026) pushes the open to Tuesday', () => {
    expect(label('2026-01-16T18:00')).toBe('Opens Tue 09:30')
    expect(label('2026-01-19T12:00')).toBe('Opens in 21h 30m')
  })

  it('two closures around a weekend (Christmas Eve observed, 24 December 2027) skip to Monday', () => {
    expect(getWindowStatus(nyse, at('2027-12-23T17:00'), NY).start.toFormat('yyyy-MM-dd')).toBe('2027-12-27')
  })
})

describe('Good Friday', () => {
  it('2026 (3 April) has no session, and the next open is Monday 6 April', () => {
    expect(times('2026-04-03')).toBeNull()
    expect(label('2026-04-02T17:00')).toBe('Opens Mon 09:30')
    expect(label('2026-04-03T10:00')).toBe('Opens Mon 09:30')
    expect(getWindowStatus(nyse, at('2026-04-03T10:00'), NY).start.toFormat('yyyy-MM-dd')).toBe('2026-04-06')
  })

  it('2027 (26 March) has no session, and the next open is Monday 29 March', () => {
    expect(times('2027-03-26')).toBeNull()
    expect(label('2027-03-25T17:00')).toBe('Opens Mon 09:30')
    expect(getWindowStatus(nyse, at('2027-03-26T10:00'), NY).start.toFormat('yyyy-MM-dd')).toBe('2027-03-29')
  })

  it('the Thursday before and the Monday after are normal sessions', () => {
    expect(times('2026-04-02')).toEqual(['2026-04-02 09:30', '2026-04-02 16:00'])
    expect(times('2026-04-06')).toEqual(['2026-04-06 09:30', '2026-04-06 16:00'])
  })
})

describe('early-close marker data', () => {
  it('an early-close occurrence says which holiday shortened it; other occurrences do not', () => {
    expect(getWindowOccurrence(nyse, '2026-11-27', NY)?.shortenedBy).toMatchObject({ name: 'Day after Thanksgiving', type: 'early-close' })
    expect(getWindowOccurrence(nyse, '2026-11-25', NY)?.shortenedBy).toBeUndefined()
    expect(getWindowOccurrence(find('forex-london'), '2026-11-27', NY)?.shortenedBy).toBeUndefined()
  })

  it('the status carries it, so the list can tag the row', () => {
    expect(getWindowStatus(nyse, at('2026-11-27T10:00'), NY).shortenedBy?.name).toBe('Day after Thanksgiving')
    expect(getWindowStatus(nyse, at('2026-11-25T17:00'), NY).shortenedBy?.name).toBe('Day after Thanksgiving') // next open is the early close
    expect(getWindowStatus(nyse, at('2026-11-27T14:00'), NY).shortenedBy).toBeUndefined() // next open is Monday, a normal day
  })

  it('a timeline segment is flagged only where it really ends early', () => {
    const [seg] = getTimelineSegments(nyse, at('2026-11-27T12:00'), NY)
    expect(seg.earlyClose?.name).toBe('Day after Thanksgiving')
    expect(getTimelineSegments(nyse, at('2026-11-25T12:00'), NY)[0].earlyClose).toBeUndefined()
  })

  it('in Tokyo the early close falls after local midnight: only the segment holding the end is flagged', () => {
    const tokyo = 'Asia/Tokyo'
    // The session runs 23:30 Fri 27 Nov to 03:00 Sat 28 Nov (Tokyo time).
    const friday = getTimelineSegments(nyse, at('2026-11-27T12:00', tokyo), tokyo)
    const saturday = getTimelineSegments(nyse, at('2026-11-28T12:00', tokyo), tokyo)
    expect(friday.at(-1)).toMatchObject({ end: 1 })
    expect(friday.at(-1)?.earlyClose).toBeUndefined() // just cut at midnight
    expect(saturday[0].end).toBeCloseTo(3 / 24, 10)
    expect(saturday[0].earlyClose?.name).toBe('Day after Thanksgiving')
  })
})

describe('other effects of holidays', () => {
  it('no alert fires for a session that is not happening, but does for the early-close day', () => {
    const due = (iso: string) => {
      const now = at(iso)
      return getDueAlerts(PRESET_GROUPS, { 'nyse-regular': 30 }, now, new Map(), new Date(now.getTime() - 1000))
    }
    expect(due('2026-11-26T09:00')).toEqual([]) // Thanksgiving: no open to warn about
    expect(due('2026-04-03T09:00')).toEqual([]) // Good Friday
    expect(due('2026-11-27T09:00')).toHaveLength(1) // early close still opens at 09:30
  })
})

describe('how a calendar applies to a window (edge cases)', () => {
  const calendar: HolidayCalendar = {
    id: 'test',
    name: 'Test',
    timeZone: NY,
    earlyCloseTime: '13:00',
    coversThrough: '2030-12-31',
    holidays: [{ date: '2026-03-04', name: 'Test early close', type: 'early-close' }],
  }
  const win = (patch: Partial<TradingWindow>): TradingWindow => ({ ...nyse, holidays: calendar, ...patch })

  it('leaves a same-day window that already ends before the early close unchanged', () => {
    expect(times('2026-03-04', win({ start: '09:00', end: '12:00' }))).toEqual(['2026-03-04 09:00', '2026-03-04 12:00'])
  })

  it('removes the session if the early close is at or before the window\'s start', () => {
    expect(times('2026-03-04', win({ start: '14:00', end: '16:00' }))).toBeNull()
    expect(times('2026-03-04', win({ start: '13:00', end: '16:00' }))).toBeNull()
  })

  it('does not shorten an overnight window', () => {
    expect(times('2026-03-04', win({ start: '22:00', end: '02:00' }))).toEqual(['2026-03-04 22:00', '2026-03-05 02:00'])
  })

  it('keeps the next open correct when the holiday leaves no occurrence for a day in a sparse window', () => {
    const closedMonday: HolidayCalendar = { ...calendar, holidays: [{ date: '2026-03-02', name: 'Closed', type: 'closed' }] }
    const weekly = win({ days: [1], holidays: closedMonday }) // Mondays only; Monday 2 March is closed
    expect(getWindowStatus(weekly, at('2026-03-01T12:00'), NY).start.toFormat('yyyy-MM-dd')).toBe('2026-03-09')
  })
})
