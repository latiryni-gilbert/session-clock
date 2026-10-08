import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { getHourTicks, getNowFraction, getTimelineSegments } from './timeline'

const NY = 'America/New_York'
const find = (id: string) => {
  const w = PRESET_GROUPS.flatMap((g) => g.windows).find((x) => x.id === id)
  if (!w) throw new Error(`No preset with id ${id}`)
  return w
}
const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate()
const h = (hours: number) => hours / 24
const segs = (id: string, iso: string, zone = NY) =>
  getTimelineSegments(find(id), at(iso, zone), zone).map((s) => [s.start, s.end])

// 2026-01-14 is a Wednesday; 15 Thu, 16 Fri, 17 Sat, 18 Sun.

describe('getTimelineSegments', () => {
  it('same-day window is a single bar (NYSE 09:30-16:00)', () => {
    expect(segs('nyse-regular', '2026-01-14T12:00')).toEqual([[h(9.5), h(16)]])
  })

  it('overnight window is split in two around its break (CME Globex on Wednesday)', () => {
    // Opened Tue 18:00 -> 17:00 today (left); reopens 18:00 today -> tomorrow (right end).
    expect(segs('cme-equity-futures', '2026-01-14T12:00')).toEqual([
      [0, h(17)],
      [h(18), 1],
    ])
  })

  it('a window ending exactly at midnight only has its evening part (ICT Asian on Wednesday)', () => {
    // Tuesday's session ended at 00:00 today, which leaves nothing on the left.
    expect(segs('ict-asian', '2026-01-14T12:00')).toEqual([[h(20), 1]])
  })

  it('has no bar on days with nothing in them', () => {
    expect(segs('nyse-regular', '2026-01-17T12:00')).toEqual([]) // Saturday
    expect(segs('ict-asian', '2026-01-16T12:00')).toEqual([]) // Friday: Thursday's ended at 00:00, no Friday start
  })

  it('applies the start-day rule to the split parts', () => {
    // Friday: only the tail of Thursday's session (ends 17:00); nothing starts Friday.
    expect(segs('cme-equity-futures', '2026-01-16T12:00')).toEqual([[0, h(17)]])
    // Sunday: only the evening open.
    expect(segs('cme-equity-futures', '2026-01-18T12:00')).toEqual([[h(18), 1]])
    // Saturday: nothing.
    expect(segs('cme-equity-futures', '2026-01-17T12:00')).toEqual([])
  })

  it('places windows by the display zone, splitting at local midnight', () => {
    // Tokyo is UTC+9. NYSE 09:30-16:00 EST = 23:30-06:00 JST the next day.
    const tokyo = 'Asia/Tokyo'
    expect(segs('nyse-regular', '2026-01-14T12:00', tokyo)).toEqual([
      [0, h(6)], // Tuesday NY session, finishing at 06:00 JST on Wednesday
      [h(23.5), 1], // Wednesday NY session, starting 23:30 JST
    ])
  })

  it('uses the real length of a daylight-saving day', () => {
    // 2026-03-08: US clocks spring forward at 02:00, so the day is 23 hours long.
    // CME opens 18:00 EDT, which is 17 elapsed hours after midnight.
    const [cme] = getTimelineSegments(find('cme-equity-futures'), at('2026-03-08T12:00'), NY)
    expect(cme.start).toBeCloseTo(17 / 23, 10)
    expect(cme.end).toBe(1)
    // Monday 03/09 is a normal 24h day again.
    const [nyse] = getTimelineSegments(find('nyse-regular'), at('2026-03-09T12:00'), NY)
    expect(nyse.start).toBeCloseTo(h(9.5), 10)
  })
})

describe('getNowFraction', () => {
  it('is 0 at midnight, 0.5 at noon, and follows the display zone', () => {
    expect(getNowFraction(at('2026-01-14T00:00'), NY)).toBe(0)
    expect(getNowFraction(at('2026-01-14T12:00'), NY)).toBe(0.5)
    expect(getNowFraction(at('2026-01-14T18:00'), NY)).toBe(0.75)
    // Same instant, different local clock.
    expect(getNowFraction(at('2026-01-14T12:00'), 'Asia/Tokyo')).toBeCloseTo(h(2), 10) // 02:00 JST next day
  })
})

describe('getHourTicks', () => {
  it('labels every 3 hours from 00 to 21', () => {
    const ticks = getHourTicks(at('2026-01-14T12:00'), NY)
    expect(ticks.map((t) => t.label)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21'])
    expect(ticks.map((t) => t.fraction)).toEqual([0, h(3), h(6), h(9), h(12), h(15), h(18), h(21)])
  })

  it('supports other steps', () => {
    expect(getHourTicks(at('2026-01-14T12:00'), NY, 6).map((t) => t.label)).toEqual(['00', '06', '12', '18'])
  })

  it('stays aligned with bars on a 23-hour day', () => {
    // 03:00 EDT on 2026-03-08 is only 2 elapsed hours after midnight.
    const ticks = getHourTicks(at('2026-03-08T12:00'), NY)
    expect(ticks.find((t) => t.label === '03')!.fraction).toBeCloseTo(2 / 23, 10)
    expect(ticks.find((t) => t.label === '12')!.fraction).toBeCloseTo(11 / 23, 10)
  })
})
