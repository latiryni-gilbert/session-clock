import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { daysUntilCoverageEnds } from '../lib/holidays'
import { NYSE_HOLIDAYS } from './holidays'
import { PRESET_GROUPS } from './presets'

const windows = PRESET_GROUPS.flatMap((g) => g.windows)
const iso = (dt: DateTime) => dt.toISODate()!

// --- Independent rules, used to cross-check the hand-entered dates ---------------------------------
/** The nth (1-based) given ISO weekday of a month. */
const nthWeekday = (year: number, month: number, weekday: number, n: number) => {
  const first = DateTime.utc(year, month, 1)
  return first.plus({ days: ((weekday - first.weekday + 7) % 7) + 7 * (n - 1) })
}
const lastWeekday = (year: number, month: number, weekday: number) => {
  const last = DateTime.utc(year, month + 1, 1).minus({ days: 1 })
  return last.minus({ days: (last.weekday - weekday + 7) % 7 })
}
/** NYSE observes a Saturday holiday on the Friday before, a Sunday holiday on the Monday after. */
const observed = (date: DateTime) => (date.weekday === 6 ? date.minus({ days: 1 }) : date.weekday === 7 ? date.plus({ days: 1 }) : date)
/** Easter Sunday (anonymous Gregorian algorithm). */
const easter = (year: number) => {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return DateTime.utc(year, month, day)
}

function expectedHolidays(year: number): { date: string; type: 'closed' | 'early-close' }[] {
  const out: { date: string; type: 'closed' | 'early-close' }[] = []
  const jan1 = DateTime.utc(year, 1, 1)
  if (jan1.weekday !== 6) out.push({ date: iso(observed(jan1)), type: 'closed' }) // a Saturday Jan 1 is not observed on Dec 31
  out.push({ date: iso(nthWeekday(year, 1, 1, 3)), type: 'closed' }) // Martin Luther King Jr. Day
  out.push({ date: iso(nthWeekday(year, 2, 1, 3)), type: 'closed' }) // Washington's Birthday
  out.push({ date: iso(easter(year).minus({ days: 2 })), type: 'closed' }) // Good Friday
  out.push({ date: iso(lastWeekday(year, 5, 1)), type: 'closed' }) // Memorial Day
  out.push({ date: iso(observed(DateTime.utc(year, 6, 19))), type: 'closed' }) // Juneteenth
  out.push({ date: iso(observed(DateTime.utc(year, 7, 4))), type: 'closed' }) // Independence Day
  out.push({ date: iso(nthWeekday(year, 9, 1, 1)), type: 'closed' }) // Labor Day
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  out.push({ date: iso(thanksgiving), type: 'closed' })
  out.push({ date: iso(thanksgiving.plus({ days: 1 })), type: 'early-close' })
  const christmasObserved = observed(DateTime.utc(year, 12, 25))
  const eve = DateTime.utc(year, 12, 24)
  if (eve.weekday <= 5 && iso(eve) !== iso(christmasObserved)) out.push({ date: iso(eve), type: 'early-close' })
  out.push({ date: iso(christmasObserved), type: 'closed' })
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

describe('NYSE holiday data', () => {
  const byYear = (year: number) =>
    NYSE_HOLIDAYS.holidays.filter((h) => h.date.startsWith(`${year}-`)).map(({ date, type }) => ({ date, type }))

  it('has the dates entered for 2026 (10 closures, 2 early closes)', () => {
    const closed = byYear(2026).filter((h) => h.type === 'closed').map((h) => h.date)
    const early = byYear(2026).filter((h) => h.type === 'early-close').map((h) => h.date)
    expect(closed).toEqual(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'])
    expect(early).toEqual(['2026-11-27', '2026-12-24'])
  })

  it('has the dates entered for 2027 (10 closures, 1 early close)', () => {
    const closed = byYear(2027).filter((h) => h.type === 'closed').map((h) => h.date)
    const early = byYear(2027).filter((h) => h.type === 'early-close').map((h) => h.date)
    expect(closed).toEqual(['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'])
    expect(early).toEqual(['2027-11-26'])
  })

  it('agrees with the NYSE holiday rules, worked out independently (including Good Friday from the date of Easter)', () => {
    for (const year of [2026, 2027]) expect(byYear(year)).toEqual(expectedHolidays(year))
  })

  it('is well-formed: valid weekday dates, in order, no duplicates, named, within coverage', () => {
    const dates = NYSE_HOLIDAYS.holidays.map((h) => h.date)
    expect(new Set(dates).size).toBe(dates.length)
    expect([...dates].sort()).toEqual(dates)
    for (const h of NYSE_HOLIDAYS.holidays) {
      const day = DateTime.fromISO(h.date, { zone: 'utc' })
      expect(day.isValid, h.date).toBe(true)
      expect(day.weekday, `${h.date} ${h.name} is on a weekend`).toBeLessThanOrEqual(5)
      expect(h.name.trim()).not.toBe('')
      expect(['closed', 'early-close']).toContain(h.type)
      expect(h.date <= NYSE_HOLIDAYS.coversThrough, `${h.date} is after coversThrough`).toBe(true)
    }
  })

  it('closes early at 13:00 New York time', () => {
    expect(NYSE_HOLIDAYS.earlyCloseTime).toBe('13:00')
    expect(NYSE_HOLIDAYS.timeZone).toBe('America/New_York')
  })

  it('names the holidays', () => {
    const name = (date: string) => NYSE_HOLIDAYS.holidays.find((h) => h.date === date)?.name
    expect(name('2026-11-26')).toBe('Thanksgiving Day')
    expect(name('2026-04-03')).toBe('Good Friday')
    expect(name('2026-12-25')).toBe('Christmas Day')
  })

  it('is attached to the NYSE regular hours preset only, which uses the same time zone', () => {
    expect(windows.filter((w) => w.holidays).map((w) => w.id)).toEqual(['nyse-regular'])
    const nyse = windows.find((w) => w.id === 'nyse-regular')!
    expect(nyse.holidays).toBe(NYSE_HOLIDAYS)
    expect(nyse.timeZone).toBe(NYSE_HOLIDAYS.timeZone)
  })
})

describe('holiday data coverage reminder', () => {
  it('counts the days left until the data runs out', () => {
    const at = (day: string) => DateTime.fromISO(day, { zone: 'America/New_York' })
    expect(daysUntilCoverageEnds(NYSE_HOLIDAYS, at('2027-12-31'))).toBe(0)
    expect(daysUntilCoverageEnds(NYSE_HOLIDAYS, at('2027-10-31'))).toBe(61)
    expect(daysUntilCoverageEnds(NYSE_HOLIDAYS, at('2027-11-01'))).toBe(60)
    expect(daysUntilCoverageEnds(NYSE_HOLIDAYS, at('2028-01-02'))).toBe(-2)
  })

  // This test is meant to start failing in time: it is the reminder to add next year's dates.
  it('NYSE holiday data covers more than 60 days from today', () => {
    const daysLeft = daysUntilCoverageEnds(NYSE_HOLIDAYS)
    expect(
      daysLeft,
      `The NYSE holiday data ends ${NYSE_HOLIDAYS.coversThrough}, ${daysLeft} days from now. ` +
        `Add the next year's closures and early closes to src/config/holidays.ts and move coversThrough forward.`,
    ).toBeGreaterThan(60)
  })
})
