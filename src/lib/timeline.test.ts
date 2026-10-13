import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { PRESET_GROUPS } from '../config/presets'
import { NEWS_CALENDAR } from '../config/newsEvents'
import type { NewsEvent } from './newsEvents'
import { getHourTicks, getNewsMarkers, getNowFraction, getTimelineSegments } from './timeline'

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

describe('getNewsMarkers', () => {
  const cpi = NEWS_CALENDAR.events.find((e) => e.id === 'cpi-2026-11-10')!
  const at8 = (time: string, id: string): NewsEvent => ({ ...cpi, id, time })

  it('places today\'s event along the viewer\'s day: CPI at 08:30 New York', () => {
    const [m] = getNewsMarkers(at('2026-11-10T06:00'), NY)
    expect(m.event.id).toBe('cpi-2026-11-10')
    expect(m.fraction).toBeCloseTo(8.5 / 24, 10)
    expect(m.align).toBe('center')
    expect(m.row).toBe(0)
  })

  it('puts it at 07:30 for a Chicago viewer', () => {
    const chicago = 'America/Chicago'
    const [m] = getNewsMarkers(at('2026-11-10T06:00', chicago), chicago)
    expect(m.fraction).toBeCloseTo(7.5 / 24, 10)
    expect(m.at.toFormat('HH:mm')).toBe('07:30')
  })

  it('has no markers on a day without events, and only the events of the viewer\'s own day', () => {
    expect(getNewsMarkers(at('2026-11-11T12:00'), NY)).toEqual([])
    // 14:00 New York on Wed 27 Jan 2027 is 04:00 Thursday in Tokyo.
    const tokyo = 'Asia/Tokyo'
    expect(getNewsMarkers(at('2027-01-27T12:00', tokyo), tokyo)).toEqual([])
    const thursday = getNewsMarkers(at('2027-01-28T12:00', tokyo), tokyo)
    expect(thursday).toHaveLength(1)
    expect(thursday[0].fraction).toBeCloseTo(4 / 24, 10)
  })

  it('uses the real length of a 23-hour daylight-saving day', () => {
    const springForward: NewsEvent[] = [at8('14:00', 'sf')].map((e) => ({ ...e, date: '2027-03-14' }))
    const [m] = getNewsMarkers(at('2027-03-14T12:00'), NY, springForward)
    expect(m.fraction).toBeCloseTo(13 / 23, 10) // 14:00 is 13 elapsed hours into a 23-hour day
  })

  it('hangs labels inward near the edges of the day so they are not cut off', () => {
    const events = [at8('00:30', 'early'), at8('12:00', 'mid'), at8('23:45', 'late')]
    expect(getNewsMarkers(at('2026-11-10T06:00'), NY, events).map((m) => m.align)).toEqual(['start', 'center', 'end'])
  })

  it('alternates labels of events close together between two rows, and resets once there is room', () => {
    const events = [at8('08:30', 'a'), at8('09:00', 'b'), at8('09:30', 'c'), at8('15:00', 'd')]
    expect(getNewsMarkers(at('2026-11-10T06:00'), NY, events).map((m) => m.row)).toEqual([0, 1, 0, 0])
  })

  it('lists markers in time order', () => {
    const events = [at8('14:00', 'late'), at8('08:30', 'early')]
    expect(getNewsMarkers(at('2026-11-10T06:00'), NY, events).map((m) => m.event.id)).toEqual(['early', 'late'])
  })
})
