import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, type FakeOptions } from '../test/pushEnv'
import { BackgroundAlerts } from './BackgroundAlerts'

const account = { id: 'sub-id-1', secret: 'the-secret-value-1' }

afterEach(() => vi.restoreAllMocks())

/** Renders the section with a fake browser and waits for it to finish checking the current state. */
async function show(options: FakeOptions = {}) {
  const fake = makeEnv(options)
  const user = userEvent.setup()
  const view = render(<BackgroundAlerts env={fake.env} />)
  if (fake.env.workerUrl) {
    // "Checking" ends when one of the state's controls or notes appears.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /enable background alerts|send test notification/i }) ?? screen.queryByText(/aren’t supported|blocked|Home Screen/),
      ).not.toBeNull(),
    )
  }
  return { fake, user, ...view }
}
const enableButton = () => screen.getByRole('button', { name: 'Enable background alerts' })
const testButton = () => screen.getByRole('button', { name: 'Send test notification' })
const offButton = () => screen.getByRole('button', { name: 'Turn off' })
const enabled = { permission: 'granted', account, existing: true } as const

describe('visibility', () => {
  it('renders nothing at all when there is no Worker address', () => {
    const { container } = render(<BackgroundAlerts env={makeEnv({ workerUrl: null }).env} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not even look at the browser when the feature is hidden', () => {
    const fake = makeEnv({ workerUrl: null })
    render(<BackgroundAlerts env={fake.env} />)
    expect(fake.fetchMock).not.toHaveBeenCalled()
    expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
  })

  it('has a "Background alerts (beta)" heading and a one-line explanation', async () => {
    await show()
    expect(screen.getByRole('heading', { level: 3, name: 'Background alerts (beta)' })).toBeInTheDocument()
    expect(screen.getByText(/notified even when Session Clock is closed/)).toBeInTheDocument()
  })
})

describe('situations where it cannot be turned on', () => {
  it('on iPhone outside the Home Screen app, explains how to add it first, with no Enable button', async () => {
    await show({ isIos: true, isStandalone: false })
    expect(screen.getByText(/add Session Clock to your Home Screen first/)).toBeInTheDocument()
    expect(screen.getByText(/tap Share, then Add to Home Screen/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable background alerts/i })).not.toBeInTheDocument()
  })

  it('on iPhone from the Home Screen app, allows enabling and shows no such note', async () => {
    await show({ isIos: true, isStandalone: true })
    expect(enableButton()).toBeInTheDocument()
    expect(screen.queryByText(/Home Screen/)).not.toBeInTheDocument()
  })

  it('says so in a browser without push support', async () => {
    await show({ noPushManager: true })
    expect(screen.getByText('Background alerts aren’t supported in this browser.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable/i })).not.toBeInTheDocument()
  })

  it('explains how to unblock notifications when the permission is denied', async () => {
    await show({ permission: 'denied' })
    expect(screen.getByText(/Notifications are blocked for this site/)).toBeInTheDocument()
    expect(screen.getByText(/set Notifications to Allow/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable/i })).not.toBeInTheDocument()
  })
})

describe('the starting state', () => {
  it('offers only "Enable background alerts" when it has not been set up', async () => {
    await show()
    expect(enableButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send test notification' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument()
  })

  it('does not ask for permission or call the Worker just from being shown', async () => {
    const { fake } = await show()
    expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
    expect(fake.fetchMock).not.toHaveBeenCalled()
  })

  it('shows "on" with the test and turn-off buttons when this device was enabled and still works', async () => {
    await show(enabled)
    expect(screen.getByText('Background alerts are on for this device.')).toBeInTheDocument()
    expect(testButton()).toBeEnabled()
    expect(offButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: /enable background alerts/i })).not.toBeInTheDocument()
  })

  it('explains it when the permission was revoked, with the unblock instructions', async () => {
    await show({ permission: 'denied', account, existing: true })
    expect(screen.getByText(/Notifications were turned off for this site, so background alerts stopped/)).toBeInTheDocument()
    expect(screen.getByText(/set Notifications to Allow/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable/i })).not.toBeInTheDocument()
  })

  it('explains it when the browser dropped the subscription, and offers to enable again', async () => {
    await show({ permission: 'granted', account })
    expect(screen.getByText(/Your browser dropped this device’s alert subscription/)).toBeInTheDocument()
    expect(enableButton()).toBeEnabled()
    expect(screen.queryByText('Background alerts are on for this device.')).not.toBeInTheDocument()
  })

  it('explains it when the permission went back to "ask", and offers to enable again', async () => {
    await show({ permission: 'default', account, existing: true })
    expect(screen.getByText(/Notifications were turned off for this site, so background alerts stopped/)).toBeInTheDocument()
    expect(enableButton()).toBeEnabled()
  })
})

describe('Enable background alerts', () => {
  it('turns it on: asks permission, subscribes, saves, and shows the on state with a success message', async () => {
    const { fake, user } = await show()
    await user.click(enableButton())

    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Turned on. Send a test notification to check that it works.')
    expect(fake.events).toEqual(['permission', 'fetch GET /vapid-public-key', 'subscribe', 'fetch POST /subscribe'])
    expect(JSON.parse(fake.saved()!)).toEqual(account)
    expect(testButton()).toBeInTheDocument()
    expect(offButton()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable background alerts/i })).not.toBeInTheDocument()
  })

  it('shows progress and ignores a second tap while it works', async () => {
    let finish!: (r: Response) => void
    const { fake, user } = await show({ routes: { '/subscribe': () => new Promise<Response>((resolve) => (finish = resolve)) } })
    await user.click(enableButton())
    const busy = await screen.findByRole('button', { name: 'Enabling…' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    expect(fake.Notification.requestPermission).toHaveBeenCalledTimes(1)
    finish(new Response(JSON.stringify(account), { status: 200 }))
    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
  })

  it('when the user chooses Block, shows the blocked help and nothing else happens', async () => {
    const { fake, user } = await show({ answer: 'denied' })
    await user.click(enableButton())
    expect(await screen.findByText(/Notifications are blocked for this site/)).toBeInTheDocument()
    expect(fake.fetchMock).not.toHaveBeenCalled()
    expect(fake.saved()).toBeNull()
  })

  it('when the prompt is dismissed, says it stays off until they choose Allow, and keeps the button', async () => {
    const { fake, user } = await show({ answer: 'default' })
    await user.click(enableButton())
    expect(await screen.findByText('Background alerts stay off until you choose Allow when your browser asks.')).toBeInTheDocument()
    expect(enableButton()).toBeEnabled()
    expect(fake.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['the alerts server is unavailable', { routes: { '/vapid-public-key': 503 } }, /aren’t available right now/],
    ['the alerts server cannot be reached', { routes: { '/vapid-public-key': new TypeError('offline') } }, /Couldn’t reach the alerts server/],
    ['registering is rate limited', { routes: { '/subscribe': 429 } }, /Too many attempts\. Wait a minute/],
    ['registering fails', { routes: { '/subscribe': 500 } }, /Something went wrong/],
    ['the service worker is not ready', { workerNeverReady: true, workerReadyTimeoutMs: 5 }, /isn’t ready yet\. Reload the page/],
    ['the browser cannot subscribe', { subscribeErrors: [new DOMException('push service error', 'AbortError')] }, /couldn’t set up push notifications/],
    ['storage cannot save', { storage: 'cannot-write' }, /Couldn’t save this on your device/],
  ] as Array<[string, FakeOptions, RegExp]>)('shows a clear error when %s, and stays off with the button available', async (_name, options, expected) => {
    const { fake, user } = await show(options)
    await user.click(enableButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(enableButton()).toBeEnabled()
    expect(fake.saved()).toBeNull()
    expect(fake.held.current).toBeNull() // nothing half-set-up left behind
  })

  it('after a failure, the next tap can succeed', async () => {
    const answers = [new Response(null, { status: 500 }), new Response(JSON.stringify(account), { status: 200 })]
    const { user } = await show({ routes: { '/subscribe': () => answers.shift()! } })
    await user.click(enableButton())
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await user.click(enableButton())
    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('from "your browser dropped the subscription", turning on again works and clears the note', async () => {
    const { user } = await show({ permission: 'granted', account: { id: 'old', secret: 'old-secret' } })
    expect(screen.getByText(/dropped this device’s alert subscription/)).toBeInTheDocument()
    await user.click(enableButton())
    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
    expect(screen.queryByText(/dropped this device’s alert subscription/)).not.toBeInTheDocument()
  })
})

describe('Send test notification', () => {
  it('sends it with the saved id and secret and confirms', async () => {
    const { fake, user } = await show(enabled)
    await user.click(testButton())
    expect(await screen.findByText('Test notification sent. It should appear in a few seconds.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    const call = fake.fetchCalls.find((c) => c.path === '/test-push')!
    expect(call.body).toEqual(account)
    expect(testButton()).toBeEnabled()
  })

  it('shows progress and ignores a second tap while it works', async () => {
    let finish!: (r: Response) => void
    const { fake, user } = await show({ ...enabled, routes: { '/test-push': () => new Promise<Response>((resolve) => (finish = resolve)) } })
    await user.click(testButton())
    const busy = await screen.findByRole('button', { name: 'Sending…' })
    expect(busy).toBeDisabled()
    expect(offButton()).toBeDisabled()
    finish(new Response(null, { status: 200 }))
    await screen.findByText(/Test notification sent/)
    expect(fake.fetchCalls.filter((c) => c.path === '/test-push')).toHaveLength(1)
  })

  it('on 429 asks to wait a minute, and stays on', async () => {
    const { user } = await show({ ...enabled, routes: { '/test-push': 429 } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait a minute before sending another test.')
    expect(testButton()).toBeInTheDocument()
  })

  it('on 410 resets this device and offers to turn it on again', async () => {
    const { fake, user } = await show({ ...enabled, routes: { '/test-push': 410 } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('This device’s alert subscription has expired, so background alerts were reset. Turn them on again.')
    expect(enableButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send test notification' })).not.toBeInTheDocument()
    expect(fake.saved()).toBeNull()
    expect(fake.held.current).toBeNull()
  })

  it('on 401 (the server no longer knows this device) also resets and offers to turn it on again', async () => {
    const { fake, user } = await show({ ...enabled, routes: { '/test-push': 401 } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('The alerts server no longer recognises this device')
    expect(enableButton()).toBeEnabled()
    expect(fake.saved()).toBeNull()
  })

  it('after a reset, turning on again works', async () => {
    const { user } = await show({ ...enabled, routes: { '/test-push': 410 } })
    await user.click(testButton())
    await screen.findByRole('alert')
    await user.click(enableButton())
    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
  })

  it.each([
    [503, /aren’t available right now/],
    [502, /push service didn’t accept the test/],
    [500, /Something went wrong/],
  ])('on %i shows a clear error and stays on', async (status, expected) => {
    const { fake, user } = await show({ ...enabled, routes: { '/test-push': status } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(testButton()).toBeInTheDocument()
    expect(fake.saved()).not.toBeNull()
  })

  it('when the network fails, says so and stays on', async () => {
    const { user } = await show({ ...enabled, routes: { '/test-push': new TypeError('Failed to fetch') } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach the alerts server. Check your connection and try again.')
    expect(testButton()).toBeInTheDocument()
  })

  it('a later success clears an earlier error', async () => {
    const answers = [new Response(null, { status: 429 }), new Response(null, { status: 200 })]
    const { user } = await show({ ...enabled, routes: { '/test-push': () => answers.shift()! } })
    await user.click(testButton())
    await screen.findByRole('alert')
    await user.click(testButton())
    await screen.findByText(/Test notification sent/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('Turn off', () => {
  it('removes the device from the Worker, drops the browser subscription, clears the saved id and secret, and shows the off state', async () => {
    const { fake, user } = await show(enabled)
    await user.click(offButton())
    expect(await screen.findByRole('status')).toHaveTextContent('Background alerts are off.')
    expect(fake.fetchCalls.find((c) => c.path === '/unsubscribe')!.body).toEqual(account)
    expect(fake.held.current).toBeNull()
    expect(fake.saved()).toBeNull()
    expect(enableButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument()
  })

  it('shows progress and ignores a second tap while it works', async () => {
    let finish!: (r: Response) => void
    const { fake, user } = await show({ ...enabled, routes: { '/unsubscribe': () => new Promise<Response>((resolve) => (finish = resolve)) } })
    await user.click(offButton())
    const busy = await screen.findByRole('button', { name: 'Turning off…' })
    expect(busy).toBeDisabled()
    expect(testButton()).toBeDisabled()
    finish(new Response(null, { status: 200 }))
    await screen.findByText('Background alerts are off.')
    expect(fake.fetchCalls.filter((c) => c.path === '/unsubscribe')).toHaveLength(1)
  })

  it('still turns off on this device when the server cannot be reached, and says so', async () => {
    const { fake, user } = await show({ ...enabled, routes: { '/unsubscribe': new TypeError('offline') } })
    await user.click(offButton())
    expect(await screen.findByRole('status')).toHaveTextContent('Background alerts are off on this device. The alerts server couldn’t be reached to remove it, so it will clean up on its own.')
    expect(fake.held.current).toBeNull()
    expect(fake.saved()).toBeNull()
    expect(enableButton()).toBeEnabled()
  })

  it('can be turned on again afterwards', async () => {
    const { user } = await show(enabled)
    await user.click(offButton())
    await screen.findByText('Background alerts are off.')
    await user.click(enableButton())
    expect(await screen.findByText('Background alerts are on for this device.')).toBeInTheDocument()
  })
})

describe('the secret and the subscription stay out of sight', () => {
  it('never appears on the page and is never logged, through enabling, testing and turning off', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const { user, container } = await show()
    const visibleText = () => container.textContent ?? ''

    await user.click(enableButton())
    await screen.findByText('Background alerts are on for this device.')
    expect(visibleText()).not.toContain(account.secret)
    expect(visibleText()).not.toContain(account.id)
    expect(visibleText()).not.toContain('fcm.googleapis.com')
    expect(visibleText()).not.toContain('fake-p256dh')

    await user.click(testButton())
    await screen.findByText(/Test notification sent/)
    await user.click(offButton())
    await screen.findByText('Background alerts are off.')
    expect(visibleText()).not.toContain(account.secret)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('does not log when things fail either', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const { user } = await show({ routes: { '/subscribe': new TypeError('offline') } })
    await user.click(enableButton())
    await screen.findByRole('alert')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('the buttons live inside the section, under the heading', async () => {
    await show(enabled)
    const section = screen.getByRole('heading', { name: 'Background alerts (beta)' }).closest('section')!
    expect(within(section).getByRole('button', { name: 'Send test notification' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
  })
})

describe('two taps in the same moment', () => {
  // fireEvent clicks twice before React has re-rendered, which is what a double-tap or a ghost click does.
  const clickTwice = (button: HTMLElement) =>
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })

  it('Enable runs once: one permission prompt, one subscription, one /subscribe', async () => {
    const { fake } = await show()
    await clickTwice(enableButton())
    await screen.findByText('Background alerts are on for this device.')
    expect(fake.Notification.requestPermission).toHaveBeenCalledTimes(1)
    expect(fake.pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(fake.fetchCalls.filter((c) => c.path === '/subscribe')).toHaveLength(1)
  })

  it('Send test notification sends one', async () => {
    const { fake } = await show(enabled)
    await clickTwice(testButton())
    await screen.findByText(/Test notification sent/)
    expect(fake.fetchCalls.filter((c) => c.path === '/test-push')).toHaveLength(1)
  })

  it('Turn off runs once', async () => {
    const { fake } = await show(enabled)
    await clickTwice(offButton())
    await screen.findByText('Background alerts are off.')
    expect(fake.fetchCalls.filter((c) => c.path === '/unsubscribe')).toHaveLength(1)
  })
})

describe('messages from an earlier action', () => {
  it('are cleared as soon as the next action starts, not left on screen while it runs', async () => {
    let finish!: (r: Response) => void
    const replies = [() => Promise.resolve(new Response(null, { status: 429 })), () => new Promise<Response>((resolve) => (finish = resolve))]
    const { user } = await show({ ...enabled, routes: { '/test-push': () => replies.shift()!() } })
    await user.click(testButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait a minute')
    await user.click(testButton())
    await screen.findByRole('button', { name: 'Sending…' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    finish(new Response(null, { status: 200 }))
    await screen.findByText(/Test notification sent/)
  })
})
