import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { getWindowStatus, statusLabel } from './windowStatus'
import type { TradingWindow } from './tradingWindow'

const NY = 'America/New_York'
const find = (id: string) => {
  const w = PRESET_GROUPS.flatMap((g) => g.windows).find((x) => x.id === id)
  if (!w) throw new Error(`No preset with id ${id}`)
  return w
}
/** A wall-clock time in New York as a JS Date. */
const ny = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toJSDate()
const label = (id: string, now: string, zone = NY) => statusLabel(getWindowStatus(find(id), ny(now), zone))

describe('same-day window (NYSE, 09:30-16:00, Wed 2026-01-14)', () => {
  it('is upcoming before the open', () => {
    expect(label('nyse-regular', '2026-01-14T08:00')).toBe('Opens in 1h 30m')
  })
  it('is active during the session', () => {
    expect(label('nyse-regular', '2026-01-14T14:48')).toBe('Active - ends in 1h 12m')
  })
  it('opens exactly at start and is closed exactly at end', () => {
    expect(getWindowStatus(find('nyse-regular'), ny('2026-01-14T09:30'), NY).kind).toBe('active')
    expect(getWindowStatus(find('nyse-regular'), ny('2026-01-14T16:00'), NY).kind).toBe('closed')
  })
  it('is closed, with its times, after the close', () => {
    const s = getWindowStatus(find('nyse-regular'), ny('2026-01-14T17:00'), NY)
    expect(s.kind).toBe('closed')
    if (s.kind === 'closed') expect([s.start?.toFormat('HH:mm'), s.end?.toFormat('HH:mm')]).toEqual(['09:30', '16:00'])
  })
})

describe('days the window does not run', () => {
  it('is closed with no times on Saturday', () => {
    const s = getWindowStatus(find('nyse-regular'), ny('2026-01-17T12:00'), NY)
    expect(s).toEqual({ kind: 'closed', start: null, end: null })
    expect(statusLabel(s)).toBe('Closed today')
  })
})

describe('overnight windows that started yesterday', () => {
  it('CME Globex is active at 02:00 Tuesday (opened Monday 18:00)', () => {
    expect(label('cme-equity-futures', '2026-01-13T02:00')).toBe('Active - ends in 15h 00m')
  })
  it('CME Globex is active on Monday morning (opened Sunday 18:00)', () => {
    expect(label('cme-equity-futures', '2026-01-12T09:00')).toBe('Active - ends in 8h 00m')
  })
  it('CME Globex is upcoming during the 17:00-18:00 break', () => {
    expect(label('cme-equity-futures', '2026-01-14T17:30')).toBe('Opens in 30m')
  })
  it('CME Globex is active Friday morning but closed Friday evening (no Friday start)', () => {
    expect(label('cme-equity-futures', '2026-01-16T10:00')).toBe('Active - ends in 7h 00m')
    expect(label('cme-equity-futures', '2026-01-16T19:00')).toBe('Closed today')
  })
  it('ICT Asian is active late evening, starting today', () => {
    expect(label('ict-asian', '2026-01-14T23:30')).toBe('Active - ends in 30m')
  })
  it('ICT Asian is closed at 00:00 sharp and does not run Friday evening', () => {
    expect(getWindowStatus(find('ict-asian'), ny('2026-01-15T00:00'), NY).kind).not.toBe('active')
    expect(label('ict-asian', '2026-01-16T22:00')).toBe('Closed today')
  })
  it('a window that crosses local midnight and started yesterday shows Active', () => {
    const late: TradingWindow = { ...find('nyse-regular'), start: '22:00', end: '02:00' }
    const s = getWindowStatus(late, ny('2026-01-14T01:00'), NY) // opened Tue 22:00
    expect(s.kind).toBe('active')
    if (s.kind === 'active') {
      expect(s.start.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-01-13 22:00')
      expect(s.endsInMs).toBe(60 * 60_000)
    }
  })
})

describe('display zone differs from home zone', () => {
  it('NYSE seen from Tokyo opens later on the same Tokyo day', () => {
    // 2026-01-14 21:00 JST. NYSE opens 23:30 JST the same evening.
    const now = DateTime.fromISO('2026-01-14T21:00', { zone: 'Asia/Tokyo' }).toJSDate()
    const s = getWindowStatus(find('nyse-regular'), now, 'Asia/Tokyo')
    expect(statusLabel(s)).toBe('Opens in 2h 30m')
    if (s.kind === 'upcoming') {
      expect([s.start.toFormat('HH:mm'), s.end.toFormat('HH:mm')]).toEqual(['23:30', '06:00'])
    }
  })
  it('is active across local midnight and upcoming later the same local day', () => {
    const active = DateTime.fromISO('2026-01-14T23:45', { zone: 'Asia/Tokyo' }).toJSDate()
    expect(getWindowStatus(find('nyse-regular'), active, 'Asia/Tokyo').kind).toBe('active')
    const later = DateTime.fromISO('2026-01-15T07:00', { zone: 'Asia/Tokyo' }).toJSDate()
    expect(getWindowStatus(find('nyse-regular'), later, 'Asia/Tokyo').kind).toBe('upcoming')
  })
  it('is closed (not upcoming) when the next open is on a later local day', () => {
    // Sat 2026-01-17 07:00 JST: Friday's NYSE session ended at 06:00 JST; next open is Monday.
    const now = DateTime.fromISO('2026-01-17T07:00', { zone: 'Asia/Tokyo' }).toJSDate()
    const s = getWindowStatus(find('nyse-regular'), now, 'Asia/Tokyo')
    expect(statusLabel(s)).toBe('Closed today')
    if (s.kind === 'closed') expect(s.end?.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-01-17 06:00')
    // By Sunday nothing ended or opens "today" at all, so there are no times to show.
    const sunday = DateTime.fromISO('2026-01-18T12:00', { zone: 'Asia/Tokyo' }).toJSDate()
    expect(getWindowStatus(find('nyse-regular'), sunday, 'Asia/Tokyo')).toEqual({ kind: 'closed', start: null, end: null })
  })
})

describe('statusLabel', () => {
  it('formats each kind', () => {
    expect(label('nyse-regular', '2026-01-14T09:31')).toBe('Active - ends in 6h 29m')
  })
})
