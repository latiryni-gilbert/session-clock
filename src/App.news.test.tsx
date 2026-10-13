import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { advance, freezeClock } from './test/clock'

// The component tests run in New York time (see vite.config.ts), standard time (UTC-5) in these dates.
// CPI is released at 08:30 on Tue 10 Nov 2026, FOMC (with projections) at 14:00 on Wed 9 Dec 2026.
const CPI_DAY_0615 = '2026-11-10T11:15:00Z' // 06:15 New York
const NEWS_KEY = 'session-clock:news'

function start(iso: string) {
  freezeClock(iso)
  const user = userEvent.setup({ delay: null })
  const view = render(<App />)
  return { user, ...view }
}

type User = ReturnType<typeof userEvent.setup>
const timeline = () => within(screen.getByRole('region', { name: "Today's timeline" }))
const nextLine = () => screen.queryByText(/^Next:/)
const openSettings = (user: User) => user.click(screen.getByRole('button', { name: 'Settings' }))
const closeSettings = (user: User) => user.click(screen.getByRole('button', { name: 'Close settings' }))

describe('news events on the timeline', () => {
  it('draws a labelled marker at the time of today\'s event, and keeps the "now" line', () => {
    start(CPI_DAY_0615)
    const label = timeline().getByText('CPI')
    expect(label).toHaveAttribute('title', 'Consumer Price Index, 08:30 ET')
    expect(timeline().getByLabelText('Now')).toBeInTheDocument()
    // Placed 08:30 of 24 hours (35.4%) along the day.
    expect(label.style.left).toMatch(/^35\.41\d*%$/)
  })

  it('shows the FOMC label on a decision day', () => {
    start('2026-12-09T14:00:00Z')
    expect(timeline().getByText('FOMC')).toHaveAttribute('title', 'FOMC Rate Decision, with projections, 14:00 ET')
  })

  it('has no markers on a day without events', () => {
    start('2026-11-11T15:00:00Z') // Wednesday: nothing scheduled
    for (const label of ['CPI', 'NFP', 'PPI', 'FOMC']) expect(timeline().queryByText(label)).not.toBeInTheDocument()
    expect(timeline().getByLabelText('Now')).toBeInTheDocument()
  })

  it('does not change which rows or bars the timeline shows', () => {
    start(CPI_DAY_0615)
    for (const short of ['SYD', 'TKY', 'LDN', 'NY', 'NYSE', 'CME', 'Asia', 'AM', 'PM']) {
      expect(timeline().getAllByText(short).length).toBeGreaterThan(0)
    }
  })
})

describe('the "Next event" line', () => {
  it('within a day: "Next: CPI in 2h 15m (08:30)"', () => {
    start(CPI_DAY_0615)
    expect(nextLine()).toHaveTextContent('Next: CPI in 2h 15m (08:30)')
  })

  it('adds "+ projections" for an FOMC meeting that has them', () => {
    start('2026-12-09T14:00:00Z') // 09:00 New York
    expect(nextLine()).toHaveTextContent('Next: FOMC in 5h 00m (14:00) + projections')
  })

  it('has no projections note for a plain FOMC meeting', () => {
    start('2027-01-27T13:00:00Z') // 08:00 New York
    expect(nextLine()).toHaveTextContent('Next: FOMC in 6h 00m (14:00)')
    expect(nextLine()).not.toHaveTextContent('projections')
  })

  it('more than a day away: the day and time, skipping the weekend', () => {
    start('2026-12-05T17:00:00Z') // Saturday 12:00 New York
    expect(nextLine()).toHaveTextContent('Next: FOMC Wed 14:00 + projections')
  })

  it('moves on to the following event once one has happened', () => {
    start('2026-11-10T13:29:00Z') // 08:29: CPI is a minute away
    expect(nextLine()).toHaveTextContent('Next: CPI in 1m (08:30)')
    advance(61_000)
    expect(nextLine()).toHaveTextContent(/^Next: PPI Fri 08:30$/)
  })

  it('links to the ForexFactory calendar in a new tab, and nothing else from ForexFactory is shown', () => {
    start(CPI_DAY_0615)
    const link = screen.getByRole('link', { name: /Full calendar on ForexFactory/ })
    expect(link).toHaveAttribute('href', 'https://www.forexfactory.com/calendar')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('shows only the link once the data has no later event', () => {
    start('2028-01-05T15:00:00Z')
    expect(nextLine()).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Full calendar on ForexFactory/ })).toBeInTheDocument()
  })
})

describe('the News events setting', () => {
  it('is on by default, and turning it off hides the markers, the Next line and the link', async () => {
    const { user } = start(CPI_DAY_0615)
    await openSettings(user)
    const toggle = within(screen.getByRole('dialog')).getByRole('switch', { name: 'News events' })
    expect(toggle).toBeChecked()

    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    await closeSettings(user)
    expect(timeline().queryByText('CPI')).not.toBeInTheDocument()
    expect(nextLine()).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /ForexFactory/ })).not.toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(NEWS_KEY)!)).toMatchObject({ enabled: false })
  })

  it('stays off after a refresh, and turning it back on brings everything back', async () => {
    const { user, unmount } = start(CPI_DAY_0615)
    await openSettings(user)
    await user.click(within(screen.getByRole('dialog')).getByRole('switch', { name: 'News events' }))
    await closeSettings(user)

    unmount()
    render(<App />)
    expect(nextLine()).not.toBeInTheDocument()
    await openSettings(user)
    const toggle = within(screen.getByRole('dialog')).getByRole('switch', { name: 'News events' })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    await closeSettings(user)
    expect(nextLine()).toHaveTextContent('Next: CPI in 2h 15m (08:30)')
    expect(timeline().getByText('CPI')).toBeInTheDocument()
  })

  it('the news alert setting is disabled while news events are off', async () => {
    window.localStorage.setItem(NEWS_KEY, JSON.stringify({ enabled: false, alert: 15 }))
    const { user } = start(CPI_DAY_0615)
    await openSettings(user)
    expect(screen.getByRole('combobox', { name: 'Alert for news events' })).toBeDisabled()
  })
})

describe('news event alerts', () => {
  // A 15-minute alert for CPI (08:30 New York = 13:30Z) is due at 13:15Z. Start at 13:05Z.
  const bannerText = () => screen.queryAllByText(/^CPI (in|is out|released)/)

  it('is off by default: no banner appears', () => {
    start('2026-11-10T13:05:00Z')
    advance(30 * 60_000)
    expect(bannerText()).toHaveLength(0)
  })

  it('a 15-minute alert set in the settings shows a banner at the alert time, and only once', async () => {
    const { user } = start('2026-11-10T13:05:00Z')
    await openSettings(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Alert for news events' }), '15')
    expect(JSON.parse(window.localStorage.getItem(NEWS_KEY)!)).toMatchObject({ alert: 15 })
    await closeSettings(user)

    advance(9 * 60_000) // 13:14:00, a minute early
    expect(bannerText()).toHaveLength(0)

    advance(61_000) // 13:15:01
    expect(bannerText()).toHaveLength(1)
    expect(bannerText()[0]).toHaveTextContent('CPI in 15 minutes')

    advance(5 * 60_000)
    expect(bannerText()).toHaveLength(1)
    expect(bannerText()[0]).toHaveTextContent('CPI in 10 minutes') // same banner, counting down (9 min 59 s left rounds up)

    await user.click(screen.getByRole('button', { name: 'Dismiss alert for CPI' }))
    advance(20 * 60_000)
    expect(bannerText()).toHaveLength(0)
  })

  it('a saved alert setting works after a refresh, and a refresh in the alert minute does not repeat it', () => {
    window.localStorage.setItem(NEWS_KEY, JSON.stringify({ enabled: true, alert: 15 }))
    const { unmount } = start('2026-11-10T13:05:00Z')
    advance(10 * 60_000 + 1000) // 13:15:01
    expect(bannerText()).toHaveLength(1)

    unmount()
    render(<App />)
    advance(5000)
    expect(bannerText()).toHaveLength(0)
  })

  it('no news banner while the news events switch is off', () => {
    window.localStorage.setItem(NEWS_KEY, JSON.stringify({ enabled: false, alert: 15 }))
    start('2026-11-10T13:05:00Z')
    advance(15 * 60_000)
    expect(bannerText()).toHaveLength(0)
  })
})
