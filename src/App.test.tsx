import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import { advance, freezeClock } from './test/clock'

// The component project pins the browser time zone to America/New_York (see vite.config.ts), so
// 15:48Z is 10:48 in the app. 2026-01-14 is a Wednesday and New York is on standard time (UTC-5).
const WED_1048_NY = '2026-01-14T15:48:00Z'

/** The rows of one group in the session list, found by the group's visible heading. */
function rowsOf(group: string): HTMLElement[] {
  const section = screen.getByRole('heading', { level: 2, name: group }).closest('section')!
  return within(section).getAllByRole('listitem')
}

describe('clock', () => {
  it('shows the frozen time and the time zone name', () => {
    freezeClock('2026-01-14T15:48:05Z')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Session Clock' })).toBeInTheDocument()
    expect(screen.getByText('10:48:05')).toBeInTheDocument()
    expect(screen.getByText('America/New_York')).toBeInTheDocument()
  })

  it('moves on a second at a time', () => {
    freezeClock('2026-01-14T15:48:05Z')
    render(<App />)
    expect(screen.getByText('10:48:05')).toBeInTheDocument()
    advance(1000)
    expect(screen.getByText('10:48:06')).toBeInTheDocument()
    advance(60_000)
    expect(screen.getByText('10:49:06')).toBeInTheDocument()
  })
})

describe('session list', () => {
  it('shows the preset groups', () => {
    freezeClock(WED_1048_NY)
    render(<App />)
    const groups = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(groups).toEqual(['Forex sessions', 'NYSE', 'CME equity futures', 'ICT killzones'])
    expect(rowsOf('Forex sessions')).toHaveLength(4)
    expect(rowsOf('NYSE')).toHaveLength(1)
    expect(rowsOf('CME equity futures')).toHaveLength(1)
    expect(rowsOf('ICT killzones')).toHaveLength(4)
  })

  it('shows an Active row and an Opens in row, active ones first', () => {
    freezeClock(WED_1048_NY)
    render(<App />)
    const forex = rowsOf('Forex sessions')
    // London (03:00-12:00 New York) and New York (08:00-17:00) are open; Sydney (opens 15:00) and Tokyo (19:00) are not.
    expect(forex[0]).toHaveTextContent('London')
    expect(forex[0]).toHaveTextContent('Active - ends in 1h 12m')
    expect(forex[1]).toHaveTextContent('New York')
    expect(forex[1]).toHaveTextContent('Active - ends in 6h 12m')
    expect(forex[2]).toHaveTextContent('Sydney')
    expect(forex[2]).toHaveTextContent('Opens in 4h 12m')
    expect(forex[3]).toHaveTextContent('Tokyo')
    expect(forex[3]).toHaveTextContent('Opens in 8h 12m')
    expect(rowsOf('NYSE')[0]).toHaveTextContent('Active - ends in 5h 12m')
  })

  it('shows each window\'s times in the viewer\'s time zone', () => {
    freezeClock(WED_1048_NY)
    render(<App />)
    expect(rowsOf('NYSE')[0]).toHaveTextContent('09:30 - 16:00')
    expect(rowsOf('Forex sessions')[0]).toHaveTextContent('03:00 - 12:00') // London 08:00-17:00 UK time
  })
})

describe('turned-off windows', () => {
  it('a window switched off in the saved settings does not appear', () => {
    window.localStorage.setItem('session-clock:settings', JSON.stringify({ disabled: ['forex-tokyo'] }))
    freezeClock(WED_1048_NY)
    render(<App />)
    const forex = rowsOf('Forex sessions')
    expect(forex).toHaveLength(3)
    expect(screen.queryByText('Tokyo')).not.toBeInTheDocument() // gone from the list
    expect(screen.queryByText('TKY')).not.toBeInTheDocument() // and from the timeline
    expect(screen.getByText('SYD')).toBeInTheDocument() // the others are still on the timeline
  })

  it('a group whose windows are all off disappears, heading included', () => {
    const ict = ['ict-asian', 'ict-london', 'ict-new-york-am', 'ict-new-york-pm']
    window.localStorage.setItem('session-clock:settings', JSON.stringify({ disabled: ict }))
    freezeClock(WED_1048_NY)
    render(<App />)
    const groups = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(groups).toEqual(['Forex sessions', 'NYSE', 'CME equity futures'])
    expect(screen.queryByText('ICT')).not.toBeInTheDocument() // timeline group label
  })
})

describe('NYSE holidays', () => {
  it('on Thanksgiving 2026 the NYSE row says it is closed and still shows the next open', () => {
    freezeClock('2026-11-26T15:00:00Z') // Thursday 10:00 in New York
    render(<App />)
    const nyse = rowsOf('NYSE')[0]
    expect(nyse).toHaveTextContent('NYSE regular hours')
    expect(nyse).toHaveTextContent('Closed - Thanksgiving Day')
    expect(nyse).toHaveTextContent('Opens in 23h 30m') // Friday 09:30
    expect(nyse).not.toHaveTextContent('Active')
  })

  it('does not say closed on a normal day, or for windows without the NYSE calendar', () => {
    freezeClock('2026-11-25T15:00:00Z') // Wednesday before Thanksgiving
    render(<App />)
    expect(screen.queryByText(/Closed - /)).not.toBeInTheDocument()
    expect(rowsOf('NYSE')[0]).toHaveTextContent('Tomorrow: closed (Thanksgiving Day)')
  })

  it('on Thanksgiving, windows other than NYSE are unaffected', () => {
    freezeClock('2026-11-26T15:00:00Z')
    render(<App />)
    expect(rowsOf('Forex sessions')[0]).toHaveTextContent('Active')
    expect(screen.getAllByText(/Closed - /)).toHaveLength(1)
  })
})
