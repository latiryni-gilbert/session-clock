import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { NEWS_CALENDAR } from '../config/newsEvents'
import { getEventsOnLocalDate, getEventsToday, getNextEvent, localizeEvent, type NewsEvent } from './newsEvents'

const NY = 'America/New_York'
const event = (id: string) => NEWS_CALENDAR.events.find((e) => e.id === id)!
const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate()
const hhmm = (dt: DateTime) => dt.toFormat('HH:mm')

describe('events as seen from another time zone', () => {
  it('CPI (08:30 New York) shows at 07:30 for a Chicago user', () => {
    const day = getEventsOnLocalDate('2026-11-10', 'America/Chicago')
    expect(day).toHaveLength(1)
    expect(day[0].event.id).toBe('cpi-2026-11-10')
    expect(hhmm(day[0].at)).toBe('07:30')
    expect(day[0].at.zoneName).toBe('America/Chicago')
  })

  it('shows the same CPI at 08:30 in New York, 13:30 in London and 22:30 in Tokyo', () => {
    const cpi = event('cpi-2026-11-10')
    expect(hhmm(localizeEvent(cpi, NY).at)).toBe('08:30')
    expect(hhmm(localizeEvent(cpi, 'Europe/London').at)).toBe('13:30')
    expect(hhmm(localizeEvent(cpi, 'Asia/Tokyo').at)).toBe('22:30')
  })

  it('belongs to the viewer\'s own calendar day, which can differ from New York\'s', () => {
    // 14:00 on Wed 27 Jan 2027 in New York is 04:00 on Thu 28 Jan in Tokyo.
    expect(getEventsOnLocalDate('2027-01-27', 'Asia/Tokyo').map((e) => e.event.id)).not.toContain('fomc-2027-01-27')
    const tokyo = getEventsOnLocalDate('2027-01-28', 'Asia/Tokyo')
    expect(tokyo.map((e) => e.event.id)).toEqual(['fomc-2027-01-27'])
    expect(hhmm(tokyo[0].at)).toBe('04:00')
    // 08:30 on 10 Nov in New York is 00:30 on 11 Nov in Sydney.
    expect(getEventsOnLocalDate('2026-11-10', 'Australia/Sydney')).toEqual([])
    expect(getEventsOnLocalDate('2026-11-11', 'Australia/Sydney').map((e) => e.event.id)).toEqual(['cpi-2026-11-10'])
  })

  it('returns nothing for a day without events, and sorts a busy day earliest first', () => {
    expect(getEventsOnLocalDate('2026-11-11', NY)).toEqual([])
    const synthetic: NewsEvent[] = [
      { ...event('fomc-2026-12-09'), id: 'late' },
      { ...event('cpi-2026-12-10'), date: '2026-12-09', id: 'early' },
    ]
    expect(getEventsOnLocalDate('2026-12-09', NY, synthetic).map((e) => e.event.id)).toEqual(['early', 'late'])
  })

  it('getEventsToday uses the viewer\'s current day', () => {
    expect(getEventsToday(at('2026-11-10T12:00', 'America/Chicago'), 'America/Chicago').map((e) => e.event.shortName)).toEqual(['CPI'])
    expect(getEventsToday(at('2026-11-10T23:59', NY), NY).map((e) => e.event.shortName)).toEqual(['CPI'])
    expect(getEventsToday(at('2026-11-11T00:00', NY), NY)).toEqual([])
  })

  it('rejects an invalid date or zone instead of returning nonsense', () => {
    expect(() => getEventsOnLocalDate('nope', NY)).toThrow()
    expect(() => getEventsOnLocalDate('2026-11-10', 'Mars/Base')).toThrow()
  })
})

describe('an FOMC decision across a daylight-saving change', () => {
  // The US clocks go forward on Sun 14 March 2027, the UK's on Sun 28 March.
  const jan = event('fomc-2027-01-27') // US winter time
  const mar = event('fomc-2027-03-17') // US summer time, UK still on winter time
  const apr = event('fomc-2027-04-28') // both on summer time

  it('stays at 14:00 for a New York viewer all year', () => {
    for (const e of [jan, mar, apr]) expect(hhmm(localizeEvent(e, NY).at)).toBe('14:00')
  })

  it('moves for a London viewer: 19:00, then 18:00 while only the US has changed, then 19:00 again', () => {
    expect(hhmm(localizeEvent(jan, 'Europe/London').at)).toBe('19:00')
    expect(hhmm(localizeEvent(mar, 'Europe/London').at)).toBe('18:00')
    expect(hhmm(localizeEvent(apr, 'Europe/London').at)).toBe('19:00')
  })

  it('is the same instant of the year\'s clocks: 19:00 UTC in winter, 18:00 UTC in US summer time', () => {
    expect(localizeEvent(jan, 'UTC').at.toISO()).toBe('2027-01-27T19:00:00.000Z')
    expect(localizeEvent(mar, 'UTC').at.toISO()).toBe('2027-03-17T18:00:00.000Z')
    expect(localizeEvent(apr, 'UTC').at.toISO()).toBe('2027-04-28T18:00:00.000Z')
  })

  it('moves for a Tokyo viewer (no daylight saving there): 04:00, then 03:00 the next day', () => {
    expect(hhmm(localizeEvent(jan, 'Asia/Tokyo').at)).toBe('04:00')
    expect(hhmm(localizeEvent(mar, 'Asia/Tokyo').at)).toBe('03:00')
    expect(localizeEvent(mar, 'Asia/Tokyo').at.toISODate()).toBe('2027-03-18')
  })

  it('a day the viewer\'s clocks change is still found correctly (a 23-hour day in New York)', () => {
    const springForward: NewsEvent[] = [{ ...jan, id: 'sf', date: '2027-03-14', time: '14:00' }]
    expect(getEventsOnLocalDate('2027-03-14', NY, springForward).map((e) => e.event.id)).toEqual(['sf'])
    expect(getEventsOnLocalDate('2027-03-13', NY, springForward)).toEqual([])
    expect(getEventsOnLocalDate('2027-03-15', NY, springForward)).toEqual([])
  })
})

describe('getNextEvent', () => {
  it('skips past a weekend: Friday after the jobs report, the next event is Wednesday\'s CPI', () => {
    // NFP is Fri 8 Jan 2027 at 08:30. At 10:00 it is over; Saturday, Sunday, Monday and Tuesday have nothing.
    const next = getNextEvent(at('2027-01-08T10:00'), NY)!
    expect(next.event.id).toBe('cpi-2027-01-13')
    expect(next.at.toFormat('ccc yyyy-MM-dd HH:mm')).toBe('Wed 2027-01-13 08:30')
    expect(next.msUntil).toBe((4 * 24 + 22.5) * 3_600_000) // 4 days 22.5 hours
  })

  it('from a Saturday it is still the next weekday event', () => {
    expect(getNextEvent(at('2026-11-07T12:00'), NY)!.event.id).toBe('cpi-2026-11-10')
    expect(getNextEvent(at('2026-12-05T09:00'), NY)!.event.id).toBe('fomc-2026-12-09') // Sat after Dec NFP
  })

  it('on Friday evening after NFP, with the FOMC decision the following Wednesday', () => {
    const next = getNextEvent(at('2026-12-04T10:00'), NY)!
    expect(next.event.id).toBe('fomc-2026-12-09')
    expect(next.event.includesProjections).toBe(true)
    expect(hhmm(next.at)).toBe('14:00')
  })

  it('is strictly after now: at the moment of an event, the one after it is next', () => {
    expect(getNextEvent(at('2026-11-10T08:29:59'), NY)!.event.id).toBe('cpi-2026-11-10')
    expect(getNextEvent(at('2026-11-10T08:30:00'), NY)!.event.id).toBe('ppi-2026-11-13')
  })

  it('is expressed in the viewer\'s zone, with the same time left', () => {
    const ny = getNextEvent(at('2026-11-07T12:00'), NY)!
    const chicago = getNextEvent(at('2026-11-07T12:00'), 'America/Chicago')!
    expect(chicago.event.id).toBe(ny.event.id)
    expect(hhmm(chicago.at)).toBe('07:30')
    expect(chicago.msUntil).toBe(ny.msUntil)
  })

  it('picks the earliest even if the list is not in order', () => {
    const shuffled = [...NEWS_CALENDAR.events].reverse()
    expect(getNextEvent(at('2026-11-07T12:00'), NY, shuffled)!.event.id).toBe('cpi-2026-11-10')
  })

  it('is null once the data runs out', () => {
    expect(getNextEvent(at('2027-12-15T08:30'), NY)).toBeNull() // the last event is PPI on 2027-12-15
    expect(getNextEvent(at('2028-06-01T12:00'), NY)).toBeNull()
    expect(getNextEvent(at('2026-11-07T12:00'), NY, [])).toBeNull()
  })

  it('finds the first event from before the data starts', () => {
    expect(getNextEvent(at('2026-10-01T12:00'), NY)!.event.id).toBe('fomc-2026-10-28')
  })
})
