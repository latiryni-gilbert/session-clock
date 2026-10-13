import type { HolidayCalendar } from '../lib/tradingWindow'

/**
 * NYSE full closures and early closes (13:00 New York time).
 *
 * Source: the NYSE holiday and early-close schedule. Check it against nyse.com before relying on it.
 * When a holiday falls on a Saturday NYSE closes the Friday before; on a Sunday, the Monday after
 * (hence "observed" dates below). To extend: add the next year's rows and move `coversThrough`.
 * A test fails once today is within 60 days of `coversThrough`, as a reminder.
 */
export const NYSE_HOLIDAYS: HolidayCalendar = {
  id: 'nyse',
  name: 'NYSE',
  timeZone: 'America/New_York',
  earlyCloseTime: '13:00',
  coversThrough: '2027-12-31',
  holidays: [
    // 2026
    { date: '2026-01-01', name: "New Year's Day", type: 'closed' },
    { date: '2026-01-19', name: 'Martin Luther King Jr. Day', type: 'closed' },
    { date: '2026-02-16', name: "Washington's Birthday", type: 'closed' },
    { date: '2026-04-03', name: 'Good Friday', type: 'closed' },
    { date: '2026-05-25', name: 'Memorial Day', type: 'closed' },
    { date: '2026-06-19', name: 'Juneteenth National Independence Day', type: 'closed' },
    { date: '2026-07-03', name: 'Independence Day (observed)', type: 'closed' },
    { date: '2026-09-07', name: 'Labor Day', type: 'closed' },
    { date: '2026-11-26', name: 'Thanksgiving Day', type: 'closed' },
    { date: '2026-11-27', name: 'Day after Thanksgiving', type: 'early-close' },
    { date: '2026-12-24', name: 'Christmas Eve', type: 'early-close' },
    { date: '2026-12-25', name: 'Christmas Day', type: 'closed' },
    // 2027
    { date: '2027-01-01', name: "New Year's Day", type: 'closed' },
    { date: '2027-01-18', name: 'Martin Luther King Jr. Day', type: 'closed' },
    { date: '2027-02-15', name: "Washington's Birthday", type: 'closed' },
    { date: '2027-03-26', name: 'Good Friday', type: 'closed' },
    { date: '2027-05-31', name: 'Memorial Day', type: 'closed' },
    { date: '2027-06-18', name: 'Juneteenth National Independence Day (observed)', type: 'closed' },
    { date: '2027-07-05', name: 'Independence Day (observed)', type: 'closed' },
    { date: '2027-09-06', name: 'Labor Day', type: 'closed' },
    { date: '2027-11-25', name: 'Thanksgiving Day', type: 'closed' },
    { date: '2027-11-26', name: 'Day after Thanksgiving', type: 'early-close' },
    { date: '2027-12-24', name: 'Christmas Day (observed)', type: 'closed' },
  ],
}
