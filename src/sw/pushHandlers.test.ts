import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_MESSAGE, handleNotificationClick, handlePush, parsePushMessage } from './pushHandlers'

const SCOPE = 'https://sessionclock.vercel.app/'

/** A push message's data: `json()` returns the value, or throws if given an Error (as it does for invalid JSON). */
const data = (value: unknown) => ({
  json: () => {
    if (value instanceof Error) throw value
    return value
  },
})

function pushEvent(payload: unknown | null) {
  const waited: Promise<unknown>[] = []
  const event = { data: payload === null ? null : data(payload), waitUntil: (p: Promise<unknown>) => waited.push(p) }
  return { event: event as unknown as PushEvent, settled: () => Promise.all(waited) }
}

function registration(showNotification: (title: string, options?: NotificationOptions) => Promise<void> = async () => {}) {
  const show = vi.fn(showNotification)
  return { reg: { scope: SCOPE, showNotification: show } as unknown as ServiceWorkerRegistration, show }
}

describe('parsePushMessage', () => {
  it('reads the {title, body} the Worker sends', () => {
    expect(parsePushMessage(data({ title: 'Session Clock', body: 'Background alerts are working.' }))).toEqual({
      title: 'Session Clock',
      body: 'Background alerts are working.',
    })
  })

  it('allows an empty body', () => {
    expect(parsePushMessage(data({ title: 'London opens', body: '' }))).toEqual({ title: 'London opens', body: '' })
  })

  it('ignores extra fields, and uses only the two it knows', () => {
    expect(parsePushMessage(data({ title: 'a', body: 'b', url: 'https://evil.example', actions: [1] }))).toEqual({ title: 'a', body: 'b' })
  })

  it('cuts overlong text instead of failing', () => {
    const message = parsePushMessage(data({ title: 't'.repeat(500), body: 'b'.repeat(5000) }))!
    expect(message.title).toHaveLength(100)
    expect(message.body).toHaveLength(300)
  })

  it.each([
    ['no data at all', null],
    ['undefined data', undefined],
  ])('returns null for %s', (_name, missing) => {
    expect(parsePushMessage(missing)).toBeNull()
  })

  it.each([
    ['invalid JSON (json() throws)', new SyntaxError('Unexpected token')],
    ['JSON null', null],
    ['a JSON string', 'hello'],
    ['a JSON number', 5],
    ['an array', [{ title: 'a', body: 'b' }]],
    ['no title', { body: 'b' }],
    ['an empty title', { title: '', body: 'b' }],
    ['a blank title', { title: '   ', body: 'b' }],
    ['a title that is not text', { title: 5, body: 'b' }],
    ['no body', { title: 'a' }],
    ['a body that is not text', { title: 'a', body: { nested: true } }],
  ])('returns null for %s', (_name, value) => {
    expect(parsePushMessage(data(value))).toBeNull()
  })

  it('never throws, even if reading the data throws something that is not an Error', () => {
    expect(parsePushMessage({ json: () => { throw 'boom' } })).toBeNull()
  })
})

describe('handlePush', () => {
  it('shows the notification with the title, the body and the app icon', async () => {
    const { reg, show } = registration()
    const { event, settled } = pushEvent({ title: 'Session Clock', body: 'Background alerts are working.' })
    handlePush(event, reg)
    await settled()
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('Session Clock', {
      body: 'Background alerts are working.',
      icon: 'https://sessionclock.vercel.app/pwa-192x192.png',
    })
  })

  it('finds the icon relative to the worker’s scope, so it works under a base path', async () => {
    const reg = { scope: 'https://example.com/clock/', showNotification: vi.fn(async () => {}) }
    const { event, settled } = pushEvent({ title: 'a', body: 'b' })
    handlePush(event, reg as unknown as ServiceWorkerRegistration)
    await settled()
    expect(reg.showNotification).toHaveBeenCalledWith('a', expect.objectContaining({ icon: 'https://example.com/clock/pwa-192x192.png' }))
  })

  it('keeps the worker alive until the notification has been shown', async () => {
    let finish!: () => void
    const { reg } = registration(() => new Promise<void>((resolve) => (finish = resolve)))
    const { event, settled } = pushEvent({ title: 'a', body: 'b' })
    let done = false
    handlePush(event, reg)
    void settled().then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await settled()
    expect(done).toBe(true)
  })

  it.each([
    ['no data', null],
    ['invalid JSON', new SyntaxError('bad')],
    ['the wrong shape', { message: 'hi' }],
    ['the wrong types', { title: 5, body: 6 }],
    ['an array', ['a', 'b']],
  ])('with %s shows the plain fallback notification, using none of the payload', async (_name, payload) => {
    const { reg, show } = registration()
    const { event, settled } = pushEvent(payload)
    handlePush(event, reg)
    await settled()
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith(FALLBACK_MESSAGE.title, expect.objectContaining({ body: FALLBACK_MESSAGE.body }))
  })

  it('never lets a refused notification escape as an error', async () => {
    const { reg } = registration(async () => {
      throw new TypeError('permission revoked')
    })
    const { event, settled } = pushEvent({ title: 'a', body: 'b' })
    expect(() => handlePush(event, reg)).not.toThrow()
    await expect(settled()).resolves.toBeDefined()
  })

  it('never lets a showNotification that throws at once escape as an error', async () => {
    const reg = {
      scope: SCOPE,
      showNotification: () => {
        throw new Error('sync failure')
      },
    }
    const { event, settled } = pushEvent({ title: 'a', body: 'b' })
    expect(() => handlePush(event, reg as unknown as ServiceWorkerRegistration)).not.toThrow()
    await expect(settled()).resolves.toBeDefined()
  })
})

interface FakeClient {
  url: string
  focused?: boolean
  visibilityState?: 'visible' | 'hidden'
  focus: ReturnType<typeof vi.fn>
}
const client = (url: string, extra: Partial<FakeClient> = {}): FakeClient => ({ url, focus: vi.fn(async () => undefined), ...extra })

function clickSetup(clientList: FakeClient[] | Error, openWindow: () => Promise<unknown> = async () => null) {
  const notification = { close: vi.fn() }
  const waited: Promise<unknown>[] = []
  const event = { notification, waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as NotificationEvent
  const open = vi.fn(openWindow)
  const clients = {
    matchAll: vi.fn(async () => {
      if (clientList instanceof Error) throw clientList
      return clientList
    }),
    openWindow: open,
  } as unknown as Clients
  const { reg } = registration()
  return { event, notification, clients, open, reg, settled: () => Promise.all(waited) }
}

describe('handleNotificationClick', () => {
  it('closes the notification', async () => {
    const { event, notification, clients, reg, settled } = clickSetup([])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(notification.close).toHaveBeenCalledTimes(1)
  })

  it('asks for every open window, including ones the worker does not control yet', async () => {
    const { event, clients, reg, settled } = clickSetup([])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
  })

  it('focuses an open Session Clock window instead of opening another', async () => {
    const open = client(`${SCOPE}`)
    const { event, clients, reg, open: openWindow, settled } = clickSetup([open])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('prefers the window that already has focus, then a visible one, then the first', async () => {
    const hidden = client(SCOPE, { visibilityState: 'hidden' })
    const visible = client(SCOPE, { visibilityState: 'visible' })
    const focused = client(SCOPE, { focused: true, visibilityState: 'visible' })

    for (const [list, winner] of [
      [[hidden, visible, focused], focused],
      [[hidden, visible], visible],
      [[hidden, client(SCOPE, { visibilityState: 'hidden' })], hidden],
    ] as const) {
      list.forEach((c) => c.focus.mockClear())
      const { event, clients, reg, settled } = clickSetup([...list])
      handleNotificationClick(event, clients, reg)
      await settled()
      expect(winner.focus).toHaveBeenCalledTimes(1)
      expect(list.filter((c) => c !== winner).every((c) => c.focus.mock.calls.length === 0)).toBe(true)
    }
  })

  it('opens the app when no window of it is open', async () => {
    const { event, clients, reg, open, settled } = clickSetup([])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(open).toHaveBeenCalledWith(SCOPE)
  })

  it('does not mistake other sites, or look-alike addresses, for the app', async () => {
    const others = [
      client('https://example.com/'),
      client('https://sessionclock.vercel.app.evil.example/'),
      client('https://sessionclock.vercel.appx/'),
      client('http://localhost:5173/'),
    ]
    const { event, clients, reg, open, settled } = clickSetup(others)
    handleNotificationClick(event, clients, reg)
    await settled()
    others.forEach((c) => expect(c.focus).not.toHaveBeenCalled())
    expect(open).toHaveBeenCalledWith(SCOPE)
  })

  it('finds the app on a deeper page of the same site', async () => {
    const page = client(`${SCOPE}?utm=x#top`)
    const { event, clients, reg, open, settled } = clickSetup([page])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(page.focus).toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens a window if the browser refuses to focus the open one', async () => {
    const stubborn = client(SCOPE)
    stubborn.focus.mockRejectedValue(new Error('not allowed'))
    const { event, clients, reg, open, settled } = clickSetup([stubborn])
    handleNotificationClick(event, clients, reg)
    await settled()
    expect(open).toHaveBeenCalledWith(SCOPE)
  })

  it('never rejects, whatever the browser refuses', async () => {
    for (const setup of [
      clickSetup(new Error('matchAll failed')),
      clickSetup([], async () => {
        throw new Error('openWindow refused')
      }),
    ]) {
      handleNotificationClick(setup.event, setup.clients, setup.reg)
      await expect(setup.settled()).resolves.toBeDefined()
    }
  })

  it('keeps the worker alive until the window is shown', async () => {
    let finish!: () => void
    const { event, clients, reg, settled } = clickSetup([], () => new Promise((resolve) => (finish = () => resolve(null))))
    handleNotificationClick(event, clients, reg)
    let done = false
    void settled().then(() => (done = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)
    finish()
    await settled()
    expect(done).toBe(true)
  })
})
