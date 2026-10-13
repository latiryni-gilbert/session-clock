import type { NewsCalendar, NewsEvent } from '../lib/newsEvents'

/**
 * US high-impact news events. All times are America/New_York.
 *
 * Sources: the BLS release schedules (CPI, Employment Situation, PPI) and the Federal Reserve's FOMC
 * calendar. Check them against bls.gov and federalreserve.gov before relying on them.
 * To extend: add the next year's dates below and move `coversThrough`. A test fails once today is
 * within 60 days of `coversThrough`, as a reminder.
 */
const TIME_ZONE = 'America/New_York'

/** Consumer Price Index, released 08:30. */
const CPI_DATES = [
  '2026-11-10', '2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10',
  '2027-04-13', '2027-05-12', '2027-06-10', '2027-07-14', '2027-08-11',
  '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10',
]

/** Employment Situation (the "non-farm payrolls" report), released 08:30. */
const NFP_DATES = [
  '2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05',
  '2027-04-02', '2027-05-07', '2027-06-04', '2027-07-02', '2027-08-06',
  '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03',
]

/** Producer Price Index, released 08:30. */
const PPI_DATES = [
  '2026-11-13', '2026-12-15', '2027-01-14', '2027-02-12', '2027-03-12',
  '2027-04-14', '2027-05-13', '2027-06-11', '2027-07-15', '2027-08-10',
  '2027-09-10', '2027-10-15', '2027-11-12', '2027-12-15',
]

/** FOMC rate decision days (the second day of each meeting), announced 14:00. */
const FOMC_DATES = [
  '2026-10-28', '2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28',
  '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
]

/** FOMC meetings that also publish the Summary of Economic Projections (marked * in the Fed's calendar). */
const FOMC_WITH_PROJECTIONS = new Set([
  '2026-12-09', '2027-03-17', '2027-06-09', '2027-09-15', '2027-12-08',
])

function make(
  shortName: NewsEvent['shortName'],
  name: string,
  time: string,
  source: NewsEvent['source'],
  date: string,
): NewsEvent {
  return {
    id: `${shortName.toLowerCase()}-${date}`,
    name,
    shortName,
    date,
    time,
    timeZone: TIME_ZONE,
    currency: 'USD',
    source,
  }
}

export const NEWS_CALENDAR: NewsCalendar = {
  timeZone: TIME_ZONE,
  coversThrough: '2027-12-31',
  events: [
    ...CPI_DATES.map((d) => make('CPI', 'Consumer Price Index', '08:30', 'BLS', d)),
    ...NFP_DATES.map((d) => make('NFP', 'Employment Situation (Non-Farm Payrolls)', '08:30', 'BLS', d)),
    ...PPI_DATES.map((d) => make('PPI', 'Producer Price Index', '08:30', 'BLS', d)),
    ...FOMC_DATES.map((d) => ({
      ...make('FOMC', 'FOMC Rate Decision', '14:00', 'Federal Reserve', d),
      includesProjections: FOMC_WITH_PROJECTIONS.has(d),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
}
