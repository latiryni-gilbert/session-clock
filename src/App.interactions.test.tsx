import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { advance, freezeClock } from './test/clock'
import { listGroups, rowsOf } from './test/queries'

// Wednesday 14 January 2026, 08:00 in New York (the component tests pin that time zone; standard time, UTC-5).
const WED_0800_NY = '2026-01-14T13:00:00Z'

const SETTINGS_KEY = 'session-clock:settings'
const CUSTOM_KEY = 'session-clock:custom-windows'
const ALERTS_KEY = 'session-clock:alerts'

const OPENING_RANGE = {
  id: 'custom-opening-range-aaaa',
  name: 'Opening range',
  shortName: 'ORB',
  start: '09:30',
  end: '10:00',
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
  color: '#6366f1',
}

/** Puts things in "saved" storage before the app starts, as if from an earlier visit. */
function saved({ custom, disabled, alerts }: { custom?: object[]; disabled?: string[]; alerts?: object } = {}) {
  if (custom) window.localStorage.setItem(CUSTOM_KEY, JSON.stringify({ windows: custom }))
  if (disabled) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ disabled }))
  if (alerts) window.localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts))
}

/** Freezes the clock, renders the app and returns a user. (user-event's `delay: null` keeps it from waiting on the frozen timers.) */
function start(iso = WED_0800_NY) {
  freezeClock(iso)
  const user = userEvent.setup({ delay: null })
  const view = render(<App />)
  return { user, ...view }
}

// The panel is one dialog whose name follows its title: Settings, Add window, Edit window or Delete window.
const settingsDialog = () => screen.getByRole('dialog')
const openSettings = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Settings' }))
const closeSettings = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Close settings' }))
const clickInDialog = (user: ReturnType<typeof userEvent.setup>, name: string | RegExp) =>
  user.click(within(settingsDialog()).getByRole('button', { name }))

/** Fills the Add window form. Labels are matched by their start because some carry a counter ("Name 0/30"). */
async function fillForm(user: ReturnType<typeof userEvent.setup>, f: { name: string; shortName: string; start: string; end: string }) {
  await user.type(screen.getByLabelText(/^Name/), f.name)
  await user.type(screen.getByLabelText(/^Short label/), f.shortName)
  await user.type(screen.getByLabelText('Start'), f.start)
  await user.type(screen.getByLabelText('End'), f.end)
}

describe('settings panel: opening and closing', () => {
  it('the gear opens the panel, and the X closes it', async () => {
    const { user } = start()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await openSettings(user)
    expect(settingsDialog()).toHaveAccessibleName('Settings')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true')

    await closeSettings(user)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus() // keyboard users land back on the gear
  })

  it('clicking outside the panel closes it, but clicking inside does not', async () => {
    const { user } = start()
    await openSettings(user)
    await user.click(within(settingsDialog()).getByRole('heading', { name: 'Settings' }))
    expect(settingsDialog()).toBeInTheDocument()

    // The dimmed area around the panel is the panel's parent.
    await user.click(settingsDialog().parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Escape closes it too', async () => {
    const { user } = start()
    await openSettings(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('settings panel: turning windows and groups off', () => {
  it('turning a window off removes it from the list and the timeline, and it stays off after a refresh', async () => {
    const { user, unmount } = start()
    expect(rowsOf('Forex sessions')).toHaveLength(4)
    expect(screen.getByText('TKY')).toBeInTheDocument()

    await openSettings(user)
    const tokyo = within(settingsDialog()).getByRole('switch', { name: 'Show Forex sessions Tokyo' })
    expect(tokyo).toBeChecked()
    await user.click(tokyo)
    expect(tokyo).not.toBeChecked()
    await closeSettings(user)

    expect(rowsOf('Forex sessions')).toHaveLength(3)
    expect(screen.queryByText('Tokyo')).not.toBeInTheDocument()
    expect(screen.queryByText('TKY')).not.toBeInTheDocument()

    // A refresh: throw the page away and start the app again; only what was saved survives.
    unmount()
    render(<App />)
    expect(rowsOf('Forex sessions')).toHaveLength(3)
    expect(screen.queryByText('Tokyo')).not.toBeInTheDocument()
    expect(screen.queryByText('TKY')).not.toBeInTheDocument()
    await openSettings(user)
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show Forex sessions Tokyo' })).not.toBeChecked()
  })

  it('turning a whole group off hides its heading, and turning it back on brings it back', async () => {
    const { user } = start()
    expect(listGroups()).toContain('ICT killzones')
    expect(screen.getByText('Asia')).toBeInTheDocument() // a timeline label

    await openSettings(user)
    await user.click(within(settingsDialog()).getByRole('checkbox', { name: 'Show all ICT killzones' }))
    // Every window in the group is now off in the panel too.
    for (const w of ['Asian', 'London', 'New York AM', 'New York PM']) {
      expect(within(settingsDialog()).getByRole('switch', { name: `Show ICT killzones ${w}` })).not.toBeChecked()
    }
    await closeSettings(user)

    expect(listGroups()).toEqual(['Forex sessions', 'NYSE', 'CME equity futures'])
    expect(screen.queryByText('Asia')).not.toBeInTheDocument()
    expect(screen.queryByText('ICT')).not.toBeInTheDocument() // the timeline's group label

    await openSettings(user)
    await user.click(within(settingsDialog()).getByRole('checkbox', { name: 'Show all ICT killzones' }))
    await closeSettings(user)
    expect(listGroups()).toContain('ICT killzones')
  })
})

describe('add window form', () => {
  it('saving an empty form shows the errors and saves nothing', async () => {
    const { user } = start()
    await openSettings(user)
    await clickInDialog(user, '+ Add window')
    expect(screen.queryAllByRole('alert')).toHaveLength(0) // no nagging before the first attempt

    await clickInDialog(user, 'Save window')

    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'Enter a name.',
      'Enter a short label.',
      'Enter a start time.',
      'Enter an end time.',
    ])
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/^Name/)).toHaveFocus() // the first problem gets the cursor
    expect(window.localStorage.getItem(CUSTOM_KEY)).toBeNull()

    await clickInDialog(user, 'Cancel')
    expect(within(settingsDialog()).queryByRole('heading', { name: 'My windows' })).not.toBeInTheDocument()
    await closeSettings(user)
    expect(listGroups()).not.toContain('My windows')
  })

  it('end time equal to the start time, and a missing day, are refused with a message', async () => {
    const { user } = start()
    await openSettings(user)
    await clickInDialog(user, '+ Add window')
    await fillForm(user, { name: 'Same', shortName: 'SAM', start: '09:30', end: '09:30' })
    await clickInDialog(user, 'Save window')
    expect(screen.getByRole('alert')).toHaveTextContent('The end time must be different from the start time.')

    await user.type(screen.getByLabelText('End'), '10:00') // fix it; the message goes away
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await user.click(screen.getByLabelText(day))
    await clickInDialog(user, 'Save window')
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one day.')
    expect(window.localStorage.getItem(CUSTOM_KEY)).toBeNull()
  })

  it('a correctly filled form adds the window under My windows in the list, the timeline and the settings', async () => {
    const { user, unmount } = start()
    await openSettings(user)
    await clickInDialog(user, '+ Add window')
    await fillForm(user, { name: 'Opening range', shortName: 'ORB', start: '09:30', end: '10:00' })
    await clickInDialog(user, 'Save window')

    // Back on the settings list, with a confirmation and the new window under "My windows".
    expect(within(settingsDialog()).getByRole('status')).toHaveTextContent('Added “Opening range” under My windows.')
    expect(within(settingsDialog()).getByRole('heading', { name: 'My windows' })).toBeInTheDocument()
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show My windows Opening range' })).toBeChecked()
    await closeSettings(user)

    // The session list: a new last group, with the window's times and status.
    expect(listGroups().at(-1)).toBe('My windows')
    const row = rowsOf('My windows')[0]
    expect(row).toHaveTextContent('Opening range')
    expect(row).toHaveTextContent('09:30 - 10:00')
    expect(row).toHaveTextContent('Opens in 1h 30m')
    // The timeline: its group label and the short label.
    expect(screen.getByText('Mine')).toBeInTheDocument()
    expect(screen.getByText('ORB')).toBeInTheDocument()

    // And it is still there after a refresh.
    unmount()
    render(<App />)
    expect(rowsOf('My windows')[0]).toHaveTextContent('Opening range')
    expect(screen.getByText('ORB')).toBeInTheDocument()
  })

  it('searching "tokyo" in the time zone picker offers Asia/Tokyo, and picking it fills the box', async () => {
    const { user } = start()
    await openSettings(user)
    await clickInDialog(user, '+ Add window')

    const picker = screen.getByRole('combobox', { name: /^Time zone/ })
    expect(picker).toHaveValue('America/New_York') // starts on the detected zone
    await user.clear(picker)
    await user.type(picker, 'tokyo')

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Asia/Tokyo'])
    await user.click(options[0])
    expect(picker).toHaveValue('Asia/Tokyo')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows a message and no options when nothing matches the search', async () => {
    const { user } = start()
    await openSettings(user)
    await clickInDialog(user, '+ Add window')
    const picker = screen.getByRole('combobox', { name: /^Time zone/ })
    await user.clear(picker)
    await user.type(picker, 'zzzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No matching time zone')).toBeInTheDocument()
  })
})

describe('editing and deleting a custom window', () => {
  it('editing the start time updates the window\'s row', async () => {
    saved({ custom: [OPENING_RANGE] })
    const { user } = start()
    expect(rowsOf('My windows')[0]).toHaveTextContent('09:30 - 10:00')
    expect(rowsOf('My windows')[0]).toHaveTextContent('Opens in 1h 30m')

    await openSettings(user)
    await clickInDialog(user, 'Edit Opening range')
    // The same form, filled in with the window's current values, with its own title and button.
    expect(screen.getByRole('button', { name: /Edit window/ })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Opening range')
    expect(screen.getByLabelText('Start')).toHaveValue('09:30')
    expect(screen.queryByRole('button', { name: 'Save window' })).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('Start'))
    await user.type(screen.getByLabelText('Start'), '09:45')
    await clickInDialog(user, 'Save changes')
    expect(within(settingsDialog()).getByRole('status')).toHaveTextContent('Saved changes to “Opening range”.')
    await closeSettings(user)

    expect(rowsOf('My windows')[0]).toHaveTextContent('09:45 - 10:00')
    expect(rowsOf('My windows')[0]).toHaveTextContent('Opens in 1h 45m')
  })

  it('editing uses the same validation, and keeps the window\'s on/off state', async () => {
    saved({ custom: [OPENING_RANGE], disabled: [OPENING_RANGE.id] }) // switched off
    const { user } = start()
    expect(screen.queryByText('Opening range')).not.toBeInTheDocument()

    await openSettings(user)
    await clickInDialog(user, 'Edit Opening range')
    await user.clear(screen.getByLabelText(/^Name/))
    await clickInDialog(user, 'Save changes')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name.')

    await user.type(screen.getByLabelText(/^Name/), 'Renamed range')
    await clickInDialog(user, 'Save changes')
    // Saved under its old id, so it is still switched off.
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show My windows Renamed range' })).not.toBeChecked()
    await closeSettings(user)
    expect(screen.queryByText('Renamed range')).not.toBeInTheDocument()
  })

  it('deleting asks first; Cancel keeps it, Delete removes it, and Undo brings it back exactly as it was', async () => {
    saved({ custom: [OPENING_RANGE] })
    const { user } = start()
    const before = rowsOf('My windows')[0].textContent

    await openSettings(user)
    await clickInDialog(user, 'Delete Opening range')
    expect(within(settingsDialog()).getByRole('heading', { name: 'Delete Opening range?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus() // the safe choice

    // Cancel: nothing is deleted.
    await clickInDialog(user, 'Cancel')
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show My windows Opening range' })).toBeInTheDocument()

    // Delete: gone from the settings...
    await clickInDialog(user, 'Delete Opening range')
    await clickInDialog(user, 'Delete')
    expect(within(settingsDialog()).getByRole('status')).toHaveTextContent('Deleted Opening range')
    expect(within(settingsDialog()).queryByRole('switch', { name: 'Show My windows Opening range' })).not.toBeInTheDocument()
    expect(within(settingsDialog()).queryByRole('heading', { name: 'My windows' })).not.toBeInTheDocument() // an empty group is hidden
    expect(window.localStorage.getItem(CUSTOM_KEY)).toBe(JSON.stringify({ windows: [] }))
    await closeSettings(user)
    // ...the list and the timeline.
    expect(listGroups()).not.toContain('My windows')
    expect(screen.queryByText('ORB')).not.toBeInTheDocument()

    // Undo: back, with the same text as before.
    await openSettings(user)
    await user.click(within(settingsDialog()).getByRole('button', { name: 'Undo' }))
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show My windows Opening range' })).toBeChecked()
    await closeSettings(user)
    expect(rowsOf('My windows')[0].textContent).toBe(before)
    expect(screen.getByText('ORB')).toBeInTheDocument()
  })

  it('Undo also restores a window that was switched off, and the offer expires after a few seconds', async () => {
    saved({ custom: [OPENING_RANGE], disabled: [OPENING_RANGE.id] })
    const { user } = start()
    await openSettings(user)
    await clickInDialog(user, 'Delete Opening range')
    await clickInDialog(user, 'Delete')
    await user.click(within(settingsDialog()).getByRole('button', { name: 'Undo' }))
    expect(within(settingsDialog()).getByRole('switch', { name: 'Show My windows Opening range' })).not.toBeChecked()

    // Delete again and let the offer run out.
    await clickInDialog(user, 'Delete Opening range')
    await clickInDialog(user, 'Delete')
    expect(within(settingsDialog()).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    advance(4000)
    expect(within(settingsDialog()).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    advance(1500)
    expect(within(settingsDialog()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })
})

describe('alerts', () => {
  // Forex London opens at 08:00 London time, which in January is 08:00 UTC, so 03:00 in New York.
  // Start at 02:50 New York (07:50 UTC): a 5-minute alert is due at 02:55 (07:55 UTC).
  const LONDON_5_MIN = { lead: { 'forex-london': 5 }, sound: false }
  const banner = () => screen.queryAllByText(/^Forex London opens in/)

  it('a window with a 5-minute alert shows a banner at the alert time, and only once', async () => {
    saved({ alerts: LONDON_5_MIN })
    const { user } = start('2026-01-14T07:50:00Z')
    expect(banner()).toHaveLength(0)

    advance(4 * 60_000 + 30_000) // 07:54:30, half a minute early
    expect(banner()).toHaveLength(0)

    advance(31_000) // 07:55:01, just past the alert time
    expect(banner()).toHaveLength(1)
    expect(banner()[0]).toHaveTextContent('Forex London opens in 5 minutes')

    // Time passing and the page re-rendering do not add another one; its countdown just moves on.
    advance(60_000)
    expect(banner()).toHaveLength(1)
    expect(banner()[0]).toHaveTextContent('Forex London opens in 4 minutes')

    // Dismissed, it stays dismissed: the same opening is not announced again.
    await user.click(screen.getByRole('button', { name: 'Dismiss alert for Forex London' }))
    expect(banner()).toHaveLength(0)
    advance(3 * 60_000)
    expect(banner()).toHaveLength(0)
  })

  it('refreshing the page during the alert minute does not show it a second time', () => {
    saved({ alerts: LONDON_5_MIN })
    const { unmount } = start('2026-01-14T07:50:00Z')
    advance(5 * 60_000 + 1000) // 07:55:01
    expect(banner()).toHaveLength(1)

    // A refresh a moment later is still inside the alert's grace period; the saved record is what stops a repeat.
    unmount()
    render(<App />)
    advance(5000)
    expect(banner()).toHaveLength(0)
  })

  it('without an alert set, nothing appears', () => {
    start('2026-01-14T07:50:00Z')
    advance(15 * 60_000)
    expect(screen.queryByText(/opens in \d+ minutes?$/)).not.toBeInTheDocument()
  })

  it('a window switched off does not alert', () => {
    saved({ alerts: LONDON_5_MIN, disabled: ['forex-london'] })
    start('2026-01-14T07:50:00Z')
    advance(6 * 60_000)
    expect(banner()).toHaveLength(0)
  })

  it('an alert set in the settings panel works', async () => {
    const { user } = start('2026-01-14T07:50:00Z')
    await openSettings(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Alert for Forex sessions London' }), '5')
    await closeSettings(user)
    advance(5 * 60_000 + 1000)
    expect(banner()).toHaveLength(1)
  })
})
