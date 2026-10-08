import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import type { TradingWindow } from './tradingWindow'
import { getWindowStatus, sortWindowsByStatus, statusLabel } from './windowStatus'

const NY = 'America/New_York'
const find = (id: string) => {
  const w = PRESET_GROUPS.flatMap((g) => g.windows).find((x) => x.id === id)
  if (!w) throw new Error(`No preset with id ${id}`)
  return w
}
const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate()
const label = (id: string, iso: string, zone = NY) => statusLabel(getWindowStatus(find(id), at(iso, zone), zone))

// Calendar for the dates used below (2026): Tue 13, Wed 14, Thu 15, Fri 16, Sat 17, Sun 18, Mon 19 January.

describe('same-day window (NYSE 09:30-16:00, Mon-Fri)', () => {
  it('is upcoming before the open', () => {
    expect(label('nyse-regular', '2026-01-14T08:00')).toBe('Opens in 1h 30m')
  })
  it('is active during the session', () => {
    expect(label('nyse-regular', '2026-01-14T14:48')).toBe('Active - ends in 1h 12m')
  })
  it('is active exactly at the open and not active exactly at the close', () => {
    expect(getWindowStatus(find('nyse-regular'), at('2026-01-14T09:30'), NY).kind).toBe('active')
    expect(getWindowStatus(find('nyse-regular'), at('2026-01-14T16:00'), NY).kind).toBe('upcoming')
  })
  it('after the close counts down to the next open, across midnight', () => {
    expect(label('nyse-regular', '2026-01-14T17:00')).toBe('Opens in 16h 30m')
    expect(label('nyse-regular', '2026-01-14T23:30')).toBe('Opens in 10h 00m')
  })
})

describe('weekends (more than 24h away shows day and time)', () => {
  it('NYSE on Friday evening opens Monday', () => {
    expect(label('nyse-regular', '2026-01-16T18:00')).toBe('Opens Mon 09:30')
  })
  it('NYSE on Saturday opens Monday', () => {
    expect(label('nyse-regular', '2026-01-17T12:00')).toBe('Opens Mon 09:30')
  })
  it('NYSE on Sunday still opens Monday (more than 24h away from Sunday morning)', () => {
    expect(label('nyse-regular', '2026-01-18T08:00')).toBe('Opens Mon 09:30')
  })
  it('NYSE on Sunday evening is within 24h, so it counts down', () => {
    expect(label('nyse-regular', '2026-01-18T18:00')).toBe('Opens in 15h 30m')
  })
  it('CME on Friday evening opens Sunday 18:00', () => {
    expect(label('cme-equity-futures', '2026-01-16T19:00')).toBe('Opens Sun 18:00')
  })
  it('CME on Saturday opens Sunday 18:00', () => {
    expect(label('cme-equity-futures', '2026-01-17T12:00')).toBe('Opens Sun 18:00')
  })
  it('CME on Sunday 17:00 counts down to the open', () => {
    expect(label('cme-equity-futures', '2026-01-18T17:00')).toBe('Opens in 1h 00m')
  })
  it('ICT Asian on Friday evening opens Sunday 20:00 (no Friday start)', () => {
    expect(label('ict-asian', '2026-01-16T22:00')).toBe('Opens Sun 20:00')
  })
  it('the day and time are in the display zone, not the home zone', () => {
    // Tokyo opens Mon 09:00 JST = Sun 19:00 New York.
    expect(label('forex-tokyo', '2026-01-17T12:00')).toBe('Opens Sun 19:00')
  })
})

describe('the 24-hour cutoff', () => {
  const wedOnly: TradingWindow = { ...find('nyse-regular'), start: '12:00', end: '13:00', days: [3] }
  const l = (iso: string) => statusLabel(getWindowStatus(wedOnly, at(iso), NY))
  it('counts down at exactly 24h', () => {
    expect(l('2026-01-13T12:00')).toBe('Opens in 24h 00m')
  })
  it('switches to day and time just beyond 24h', () => {
    expect(l('2026-01-13T11:59')).toBe('Opens Wed 12:00')
  })
})

describe('overnight windows that started yesterday', () => {
  it('CME Globex is active at 02:00 Tuesday (opened Monday 18:00)', () => {
    expect(label('cme-equity-futures', '2026-01-13T02:00')).toBe('Active - ends in 15h 00m')
  })
  it('CME Globex is active on Monday morning (opened Sunday 18:00)', () => {
    expect(label('cme-equity-futures', '2026-01-19T09:00')).toBe('Active - ends in 8h 00m')
  })
  it('CME Globex is upcoming during the 17:00-18:00 break', () => {
    expect(label('cme-equity-futures', '2026-01-14T17:30')).toBe('Opens in 30m')
  })
  it('CME Globex is active Friday morning, then closed from 17:00', () => {
    expect(label('cme-equity-futures', '2026-01-16T10:00')).toBe('Active - ends in 7h 00m')
    expect(label('cme-equity-futures', '2026-01-16T17:00')).toBe('Opens Sun 18:00')
  })
  it('ICT Asian is active late evening and not active at 00:00', () => {
    expect(label('ict-asian', '2026-01-14T23:30')).toBe('Active - ends in 30m')
    expect(label('ict-asian', '2026-01-15T00:00')).toBe('Opens in 20h 00m')
  })
  it('a window that crosses local midnight and started yesterday shows Active', () => {
    const late: TradingWindow = { ...find('nyse-regular'), start: '22:00', end: '02:00' }
    const s = getWindowStatus(late, at('2026-01-14T01:00'), NY) // opened Tue 22:00
    expect(s.kind).toBe('active')
    if (s.kind === 'active') {
      expect(s.start.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-01-13 22:00')
      expect(s.endsInMs).toBe(60 * 60_000)
    }
  })
})

describe('display zone differs from home zone', () => {
  const TOKYO = 'Asia/Tokyo'
  it('NYSE seen from Tokyo opens later the same evening', () => {
    const s = getWindowStatus(find('nyse-regular'), at('2026-01-14T21:00', TOKYO), TOKYO)
    expect(statusLabel(s)).toBe('Opens in 2h 30m')
    expect([s.start.toFormat('HH:mm'), s.end.toFormat('HH:mm')]).toEqual(['23:30', '06:00'])
  })
  it('is active across Tokyo midnight', () => {
    expect(label('nyse-regular', '2026-01-15T03:00', TOKYO)).toBe('Active - ends in 3h 00m')
  })
})

describe('invalid config', () => {
  it('throws for a window with no days instead of showing nonsense', () => {
    expect(() => getWindowStatus({ ...find('nyse-regular'), days: [] }, new Date(), NY)).toThrow()
  })
})

describe('sortWindowsByStatus', () => {
  const ict = PRESET_GROUPS.find((g) => g.name === 'ICT killzones')!.windows
  const order = (iso: string) => sortWindowsByStatus(ict, at(iso), NY).map((x) => x.window.id)

  it('puts active first, then soonest to open', () => {
    // Wed 10:48: NY AM active; then PM (2h42m), Asian (9h12m), London (15h12m).
    expect(order('2026-01-14T10:48')).toEqual(['ict-new-york-am', 'ict-new-york-pm', 'ict-asian', 'ict-london'])
  })
  it('re-orders as time passes', () => {
    // Wed 21:00: Asian active; then London (05:00 -> Thu 02:00), AM, PM.
    expect(order('2026-01-14T21:00')).toEqual(['ict-asian', 'ict-london', 'ict-new-york-am', 'ict-new-york-pm'])
  })
  it('on a Saturday sorts by who opens first (Asian on Sunday, then Monday sessions)', () => {
    expect(order('2026-01-17T12:00')).toEqual(['ict-asian', 'ict-london', 'ict-new-york-am', 'ict-new-york-pm'])
  })
  it('keeps the original order among several active windows', () => {
    const forex = PRESET_GROUPS.find((g) => g.name === 'Forex sessions')!.windows
    const ids = sortWindowsByStatus(forex, at('2026-01-14T10:48'), NY).map((x) => x.window.id)
    // London and New York are both active; Sydney (opens sooner) before Tokyo.
    expect(ids).toEqual(['forex-london', 'forex-new-york', 'forex-sydney', 'forex-tokyo'])
  })
})
