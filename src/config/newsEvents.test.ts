import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { daysUntilCoverageEnds } from '../lib/holidays'
import type { NewsEvent } from '../lib/newsEvents'
import { NEWS_CALENDAR } from './newsEvents'

const events = NEWS_CALENDAR.events
const of = (type: NewsEvent['shortName']) => events.filter((e) => e.shortName === type)
const dates = (type: NewsEvent['shortName']) => of(type).map((e) => e.date)

describe('US news event data', () => {
  it('has the CPI dates entered (08:30, BLS)', () => {
    expect(dates('CPI')).toEqual([
      '2026-11-10', '2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10', '2027-04-13', '2027-05-12',
      '2027-06-10', '2027-07-14', '2027-08-11', '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10',
    ])
  })

  it('has the NFP (Employment Situation) dates entered (08:30, BLS)', () => {
    expect(dates('NFP')).toEqual([
      '2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07',
      '2027-06-04', '2027-07-02', '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03',
    ])
  })

  it('has the PPI dates entered (08:30, BLS)', () => {
    expect(dates('PPI')).toEqual([
      '2026-11-13', '2026-12-15', '2027-01-14', '2027-02-12', '2027-03-12', '2027-04-14', '2027-05-13',
      '2027-06-11', '2027-07-15', '2027-08-10', '2027-09-10', '2027-10-15', '2027-11-12', '2027-12-15',
    ])
  })

  it('has the FOMC rate decision dates entered (14:00, Federal Reserve), with the projections flag', () => {
    expect(dates('FOMC')).toEqual([
      '2026-10-28', '2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28',
      '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
    ])
    expect(of('FOMC').filter((e) => e.includesProjections).map((e) => e.date)).toEqual([
      '2026-12-09', '2027-03-17', '2027-06-09', '2027-09-15', '2027-12-08',
    ])
  })

  it('gives every event the right fields: unique readable id, name, label, time, zone, currency and source', () => {
    for (const e of events) {
      expect(e.id, e.id).toBe(`${e.shortName.toLowerCase()}-${e.date}`)
      expect(e.name.trim()).not.toBe('')
      expect(e.timeZone).toBe('America/New_York')
      expect(e.currency).toBe('USD')
      expect(e.time).toBe(e.shortName === 'FOMC' ? '14:00' : '08:30')
      expect(e.source).toBe(e.shortName === 'FOMC' ? 'Federal Reserve' : 'BLS')
    }
  })

  it('has no two events with the same id', () => {
    const ids = events.map((e) => e.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    expect(new Set(ids).size).toBe(events.length)
  })

  it('has only real weekday dates', () => {
    for (const e of events) {
      const day = DateTime.fromISO(e.date, { zone: 'utc' })
      expect(day.isValid, e.id).toBe(true)
      expect(day.weekday, `${e.id} (${day.weekdayLong}) is on a weekend`).toBeLessThanOrEqual(5)
    }
  })

  it('is listed in date order and stays within the covered range', () => {
    const keys = events.map((e) => `${e.date}T${e.time}`)
    expect([...keys].sort()).toEqual(keys)
    for (const e of events) expect(e.date <= NEWS_CALENDAR.coversThrough, e.id).toBe(true)
  })

  it('has one CPI, NFP and PPI release in each month from November 2026 to December 2027 (no gaps, no doubles)', () => {
    const months = Array.from({ length: 14 }, (_, i) => DateTime.utc(2026, 11, 1).plus({ months: i }).toFormat('yyyy-MM'))
    for (const type of ['CPI', 'NFP', 'PPI'] as const) {
      expect(dates(type).map((d) => d.slice(0, 7)), type).toEqual(months)
    }
  })

  it('has the usual weekdays: NFP on Fridays, FOMC decisions on Wednesdays', () => {
    for (const e of of('NFP')) expect(DateTime.fromISO(e.date, { zone: 'utc' }).weekday, e.id).toBe(5)
    for (const e of of('FOMC')) expect(DateTime.fromISO(e.date, { zone: 'utc' }).weekday, e.id).toBe(3)
  })

  it('marks projections only on FOMC meetings in March, June, September and December', () => {
    for (const e of of('FOMC')) {
      const quarterEnd = [3, 6, 9, 12].includes(Number(e.date.slice(5, 7)))
      expect(e.includesProjections, e.id).toBe(quarterEnd)
    }
    for (const e of events.filter((x) => x.shortName !== 'FOMC')) expect(e.includesProjections, e.id).toBeUndefined()
  })

  it('has 52 events in all (14 CPI, 14 NFP, 14 PPI, 10 FOMC)', () => {
    expect([of('CPI').length, of('NFP').length, of('PPI').length, of('FOMC').length]).toEqual([14, 14, 14, 10])
    expect(events).toHaveLength(52)
  })
})

describe('news data coverage reminder', () => {
  it('records the last covered date and the zone it counts in', () => {
    expect(NEWS_CALENDAR.coversThrough).toBe('2027-12-31')
    expect(NEWS_CALENDAR.timeZone).toBe('America/New_York')
  })

  // This test is meant to start failing in time: it is the reminder to add the next year's dates.
  it('US news data covers more than 60 days from today', () => {
    const daysLeft = daysUntilCoverageEnds(NEWS_CALENDAR)
    expect(
      daysLeft,
      `The US news event data ends ${NEWS_CALENDAR.coversThrough}, ${daysLeft} days from now. ` +
        `Add the next year's CPI, NFP, PPI and FOMC dates to src/config/newsEvents.ts and move coversThrough forward.`,
    ).toBeGreaterThan(60)
  })
})
