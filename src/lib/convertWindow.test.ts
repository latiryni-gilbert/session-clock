import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { getWindowOccurrence } from './convertWindow'

const find = (id: string) => {
  const w = PRESET_GROUPS.flatMap((g) => g.windows).find((x) => x.id === id)
  if (!w) throw new Error(`No preset with id ${id}`)
  return w
}
const fmt = (o: { start: { toFormat: (f: string) => string }; end: { toFormat: (f: string) => string } } | null) =>
  o && [o.start.toFormat("yyyy-MM-dd HH:mm"), o.end.toFormat("yyyy-MM-dd HH:mm")]

describe('getWindowOccurrence', () => {
  it('same-day window: NYSE on Wed 2026-01-14', () => {
    const nyse = find('nyse-regular')
    expect(fmt(getWindowOccurrence(nyse, '2026-01-14', 'America/New_York'))).toEqual([
      '2026-01-14 09:30',
      '2026-01-14 16:00',
    ])
    expect(fmt(getWindowOccurrence(nyse, '2026-01-14', 'UTC'))).toEqual(['2026-01-14 14:30', '2026-01-14 21:00'])
    // Tokyo is 14h ahead of New York in winter, so the close lands on the next calendar day.
    expect(fmt(getWindowOccurrence(nyse, '2026-01-14', 'Asia/Tokyo'))).toEqual([
      '2026-01-14 23:30',
      '2026-01-15 06:00',
    ])
  })

  it('overnight window: CME Globex starting Sunday 2026-01-11 ends Monday 17:00', () => {
    const cme = find('cme-equity-futures')
    const occ = getWindowOccurrence(cme, '2026-01-11', 'America/New_York')!
    expect(fmt(occ)).toEqual(['2026-01-11 18:00', '2026-01-12 17:00'])
    expect(occ.end.diff(occ.start, 'hours').hours).toBe(23)
    expect(fmt(getWindowOccurrence(cme, '2026-01-11', 'UTC'))).toEqual(['2026-01-11 23:00', '2026-01-12 22:00'])
  })

  it('ICT Asian ending at 00:00 ends at midnight of the next day', () => {
    const asian = find('ict-asian')
    const occ = getWindowOccurrence(asian, '2026-01-14', 'America/New_York')!
    expect(fmt(occ)).toEqual(['2026-01-14 20:00', '2026-01-15 00:00'])
    expect(occ.end.diff(occ.start, 'hours').hours).toBe(4)
    expect(fmt(getWindowOccurrence(asian, '2026-01-14', 'UTC'))).toEqual(['2026-01-15 01:00', '2026-01-15 05:00'])
  })

  it('skips days the window does not start on', () => {
    const nyse = find('nyse-regular')
    expect(getWindowOccurrence(nyse, '2026-01-17', 'UTC')).toBeNull() // Saturday
    expect(getWindowOccurrence(nyse, '2026-01-18', 'UTC')).toBeNull() // Sunday
    // Start-day rule: CME has no session STARTING Friday or Saturday...
    const cme = find('cme-equity-futures')
    expect(getWindowOccurrence(cme, '2026-01-16', 'UTC')).toBeNull() // Friday
    expect(getWindowOccurrence(cme, '2026-01-17', 'UTC')).toBeNull() // Saturday
    // ...but does start on Thursday, running into Friday.
    expect(fmt(getWindowOccurrence(cme, '2026-01-15', 'America/New_York'))).toEqual([
      '2026-01-15 18:00',
      '2026-01-16 17:00',
    ])
  })

  it('shifts London across the UK clock change (US already on summer time)', () => {
    // 2026: US clocks changed Mar 8; UK clocks change Sun Mar 29.
    const london = find('forex-london') // 08:00-17:00 Europe/London
    const ny = 'America/New_York'
    // Fri Mar 27: London on GMT (UTC+0), New York on EDT (UTC-4) -> 4h apart.
    expect(fmt(getWindowOccurrence(london, '2026-03-27', ny))).toEqual(['2026-03-27 04:00', '2026-03-27 13:00'])
    // Mon Mar 30: London on BST (UTC+1) -> gap shrinks to 3h, so it opens at 03:00 NY.
    expect(fmt(getWindowOccurrence(london, '2026-03-30', ny))).toEqual(['2026-03-30 03:00', '2026-03-30 12:00'])
    // Same instants in UTC: 08:00 London is 08:00Z before the change, 07:00Z after.
    expect(fmt(getWindowOccurrence(london, '2026-03-27', 'UTC'))![0]).toBe('2026-03-27 08:00')
    expect(fmt(getWindowOccurrence(london, '2026-03-30', 'UTC'))![0]).toBe('2026-03-30 07:00')
  })

  it('rejects bad input instead of returning nonsense', () => {
    const nyse = find('nyse-regular')
    expect(() => getWindowOccurrence(nyse, 'nope', 'UTC')).toThrow()
    expect(() => getWindowOccurrence(nyse, '2026-01-14', 'Mars/Base')).toThrow()
  })
})
