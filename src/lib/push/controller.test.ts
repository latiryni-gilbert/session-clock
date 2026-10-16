import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, PUBLIC_KEY, WORKER } from '../../test/pushEnv'
import { detectPushState, enableBackgroundAlerts, sendTestNotification, turnOffBackgroundAlerts } from './controller'
import { loadPushAccount } from './storage'

const account = { id: 'sub-id-1', secret: 'the-secret-value-1' }

afterEach(() => vi.restoreAllMocks())

describe('detectPushState', () => {
  it('is off for a supported browser that has never been set up', async () => {
    expect(await detectPushState(makeEnv().env)).toEqual({ kind: 'off' })
  })

  it('is on when this device was enabled and the browser still has the subscription and permission', async () => {
    expect(await detectPushState(makeEnv({ permission: 'granted', account, existing: true }).env)).toEqual({ kind: 'on' })
  })

  it('reports the platform when push is not possible', async () => {
    expect(await detectPushState(makeEnv({ noPushManager: true }).env)).toEqual({ kind: 'unsupported' })
    expect(await detectPushState(makeEnv({ isIos: true }).env)).toEqual({ kind: 'needs-home-screen' })
  })

  it('is blocked when the permission is denied, and says whether it had been on (revoked)', async () => {
    expect(await detectPushState(makeEnv({ permission: 'denied' }).env)).toEqual({ kind: 'blocked', hadAccount: false })
    expect(await detectPushState(makeEnv({ permission: 'denied', account, existing: true }).env)).toEqual({ kind: 'blocked', hadAccount: true })
  })

  it('notices that the browser dropped the subscription', async () => {
    expect(await detectPushState(makeEnv({ permission: 'granted', account }).env)).toEqual({ kind: 'off', note: 'subscription-lost' })
    expect(await detectPushState(makeEnv({ permission: 'granted', account, noRegistration: true }).env)).toEqual({ kind: 'off', note: 'subscription-lost' })
  })

  it('notices that the permission went back to "ask"', async () => {
    expect(await detectPushState(makeEnv({ permission: 'default', account, existing: true }).env)).toEqual({ kind: 'off', note: 'permission-revoked' })
  })

  it('does not claim anything was lost when the browser cannot say', async () => {
    expect(await detectPushState(makeEnv({ permission: 'granted', account, getSubscriptionThrows: true }).env)).toEqual({ kind: 'off' })
  })

  it('treats a subscription with no saved id and secret as off, since it cannot be tested or turned off', async () => {
    expect(await detectPushState(makeEnv({ permission: 'granted', existing: true }).env)).toEqual({ kind: 'off' })
  })

  it('does not ask for permission or call the Worker just to look', async () => {
    const fake = makeEnv({ permission: 'granted', account, existing: true })
    await detectPushState(fake.env)
    expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
    expect(fake.fetchMock).not.toHaveBeenCalled()
  })
})

describe('enableBackgroundAlerts', () => {
  it('asks permission first, then fetches the key, subscribes, tells the Worker, and saves the id and secret', async () => {
    const fake = makeEnv()
    expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })

    expect(fake.events).toEqual(['permission', 'fetch GET /vapid-public-key', 'subscribe', 'fetch POST /subscribe'])
    expect(JSON.parse(fake.saved()!)).toEqual(account)
  })

  it('asks for permission before awaiting anything, so it still counts as coming from the tap', async () => {
    const fake = makeEnv()
    const pending = enableBackgroundAlerts(fake.env)
    expect(fake.Notification.requestPermission).toHaveBeenCalledTimes(1) // already called, synchronously
    await pending
  })

  it('subscribes with the Worker’s key as bytes, and for visible notifications only', async () => {
    const fake = makeEnv()
    await enableBackgroundAlerts(fake.env)
    const options = fake.pushManager.subscribe.mock.calls[0]![0]
    expect(options.userVisibleOnly).toBe(true)
    expect(options.applicationServerKey).toHaveLength(65)
    expect(options.applicationServerKey[0]).toBe(4)
  })

  it('sends the browser’s subscription to /subscribe, exactly as the browser describes it', async () => {
    const fake = makeEnv()
    await enableBackgroundAlerts(fake.env)
    const call = fake.fetchCalls.find((c) => c.path === '/subscribe')!
    expect(call.url).toBe(`${WORKER}/subscribe`)
    expect(call.body).toEqual(fake.held.current!.toJSON())
  })

  describe('permission', () => {
    it('stops, touching nothing, when the user says no', async () => {
      const fake = makeEnv({ answer: 'denied' })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'permission-denied' })
      expect(fake.fetchMock).not.toHaveBeenCalled()
      expect(fake.pushManager.subscribe).not.toHaveBeenCalled()
      expect(fake.saved()).toBeNull()
    })

    it('stops when the prompt is dismissed without an answer', async () => {
      const fake = makeEnv({ answer: 'default' })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'permission-dismissed' })
      expect(fake.fetchMock).not.toHaveBeenCalled()
    })

    it('treats a prompt that fails as denied', async () => {
      const fake = makeEnv()
      fake.Notification.requestPermission.mockImplementation(() => Promise.reject(new Error('boom')))
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'permission-denied' })
    })

    it('also works with the older callback form of requestPermission', async () => {
      const fake = makeEnv()
      fake.Notification.requestPermission.mockImplementation((callback?: (p: string) => void) => {
        callback?.('granted')
        return undefined as never
      })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
    })
  })

  describe('unsupported situations', () => {
    it('does nothing in a browser without push', async () => {
      const fake = makeEnv({ noPushManager: true })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'unsupported' })
      expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
    })

    it('does nothing on iPhone outside the Home Screen app', async () => {
      const fake = makeEnv({ isIos: true })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'needs-home-screen' })
      expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
    })

    it('does nothing without a Worker address', async () => {
      const fake = makeEnv({ workerUrl: null })
      expect((await enableBackgroundAlerts(fake.env)).ok).toBe(false)
      expect(fake.Notification.requestPermission).not.toHaveBeenCalled()
    })
  })

  describe('when the Worker or network fails', () => {
    it.each([
      [503, 'server-unavailable'],
      [429, 'rate-limited'],
      [500, 'error'],
    ])('a %i for the public key is "%s", and nothing is subscribed', async (status, reason) => {
      const fake = makeEnv({ routes: { '/vapid-public-key': status } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason })
      expect(fake.pushManager.subscribe).not.toHaveBeenCalled()
      expect(fake.saved()).toBeNull()
    })

    it('a network failure fetching the key is "network"', async () => {
      const fake = makeEnv({ routes: { '/vapid-public-key': new TypeError('Failed to fetch') } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'network' })
    })

    it('a key that is not valid base64 is an error', async () => {
      const fake = makeEnv({ routes: { '/vapid-public-key': { status: 200, body: { publicKey: '!!! not base64 !!!' } } } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'error' })
    })

    it.each([
      [429, 'rate-limited'],
      [503, 'server-unavailable'],
      [400, 'error'],
    ])('a %i from /subscribe is "%s", and the new browser subscription is removed again', async (status, reason) => {
      const fake = makeEnv({ routes: { '/subscribe': status } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason })
      expect(fake.held.current).toBeNull() // rolled back
      expect(fake.saved()).toBeNull()
    })

    it('a network failure on /subscribe rolls back too', async () => {
      const fake = makeEnv({ routes: { '/subscribe': new TypeError('Failed to fetch') } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'network' })
      expect(fake.held.current).toBeNull()
    })

    it('does not remove a subscription the browser already had when /subscribe fails', async () => {
      const fake = makeEnv({ existing: true, routes: { '/subscribe': 503 } })
      const before = fake.held.current!
      await enableBackgroundAlerts(fake.env)
      expect(before.unsubscribe).not.toHaveBeenCalled()
      expect(fake.held.current).toBe(before)
    })
  })

  describe('the service worker and the push manager', () => {
    it('gives up if the service worker never becomes active', async () => {
      const fake = makeEnv({ workerNeverReady: true, workerReadyTimeoutMs: 5 })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'worker-not-ready' })
      expect(fake.saved()).toBeNull()
    })

    it('reports a failure to subscribe', async () => {
      const fake = makeEnv({ subscribeErrors: [new DOMException('push service error', 'AbortError')] })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'subscribe-failed' })
      expect(fake.fetchCalls.some((c) => c.path === '/subscribe')).toBe(false)
    })

    it('reuses a subscription the browser already holds for the same key', async () => {
      const fake = makeEnv({ existing: true })
      const before = fake.held.current!
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
      expect(before.unsubscribe).not.toHaveBeenCalled()
    })

    it('replaces a subscription made for a different key', async () => {
      const otherKey = new Uint8Array(65).fill(7)
      const fake = makeEnv({ existing: { applicationServerKey: otherKey } })
      const old = fake.held.current!
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
      expect(old.unsubscribe).toHaveBeenCalledTimes(1)
      expect(fake.held.current).not.toBe(old)
      // Noticed up front, rather than by letting the browser refuse once and recovering.
      expect(fake.pushManager.subscribe).toHaveBeenCalledTimes(1)
    })

    it('recovers when the browser refuses with InvalidStateError because of an old subscription with another key', async () => {
      const fake = makeEnv({ existing: { applicationServerKey: null }, subscribeErrors: [new DOMException('different key', 'InvalidStateError')] })
      const old = fake.held.current!
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
      expect(old.unsubscribe).toHaveBeenCalled()
      expect(fake.pushManager.subscribe).toHaveBeenCalledTimes(2)
    })

    it('gives up if the retry fails too', async () => {
      const fake = makeEnv({
        existing: { applicationServerKey: null },
        subscribeErrors: [new DOMException('different key', 'InvalidStateError'), new DOMException('again', 'InvalidStateError')],
      })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'subscribe-failed' })
    })
  })

  describe('saving the id and secret', () => {
    it.each([
      ['storage refuses the write', 'cannot-write'],
      ['storage silently forgets it', 'forgets'],
      ['there is no storage', 'unavailable'],
    ] as const)('when %s, undoes everything: the Worker forgets the device and the browser drops the subscription', async (_name, storage) => {
      const fake = makeEnv({ storage })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: false, reason: 'storage-failed' })
      const undo = fake.fetchCalls.find((c) => c.path === '/unsubscribe')!
      expect(undo.body).toEqual(account)
      expect(fake.held.current).toBeNull()
    })
  })

  describe('enabling again after the browser lost the subscription', () => {
    it('removes the dead subscription from the Worker, and saves the new one', async () => {
      const fake = makeEnv({
        permission: 'granted',
        account: { id: 'old-id', secret: 'old-secret' },
        routes: { '/subscribe': { status: 200, body: { id: 'new-id', secret: 'new-secret' } } },
      })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
      expect(JSON.parse(fake.saved()!)).toEqual({ id: 'new-id', secret: 'new-secret' })
      const cleanup = fake.fetchCalls.find((c) => c.path === '/unsubscribe')!
      expect(cleanup.body).toEqual({ id: 'old-id', secret: 'old-secret' })
    })

    it('does not remove anything when the Worker kept the same id (same endpoint)', async () => {
      const fake = makeEnv({ permission: 'granted', existing: true, account: { id: 'sub-id-1', secret: 'old-secret' } })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
      expect(fake.fetchCalls.some((c) => c.path === '/unsubscribe')).toBe(false)
      expect(loadPushAccount(fake.env.storage)).toEqual(account)
    })

    it('still succeeds when removing the dead subscription fails', async () => {
      const fake = makeEnv({
        permission: 'granted',
        account: { id: 'old-id', secret: 'old-secret' },
        routes: { '/subscribe': { status: 200, body: { id: 'new-id', secret: 'new-secret' } }, '/unsubscribe': new TypeError('offline') },
      })
      expect(await enableBackgroundAlerts(fake.env)).toEqual({ ok: true })
    })
  })

  it('never logs, whatever happens', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    for (const options of [{}, { answer: 'denied' }, { routes: { '/subscribe': 500 } }, { storage: 'cannot-write' as const }, { subscribeErrors: [new Error('x')] }]) {
      await enableBackgroundAlerts(makeEnv(options).env)
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('sendTestNotification', () => {
  const enabled = (options = {}) => makeEnv({ permission: 'granted', account, existing: true, ...options })

  it('asks the Worker to send a test with the saved id and secret', async () => {
    const fake = enabled()
    expect(await sendTestNotification(fake.env)).toEqual({ ok: true })
    const call = fake.fetchCalls[0]!
    expect([call.method, call.path, call.body]).toEqual(['POST', '/test-push', account])
  })

  it('does nothing if the device was never enabled', async () => {
    const fake = makeEnv()
    expect(await sendTestNotification(fake.env)).toEqual({ ok: false, reason: 'not-enabled', reset: false })
    expect(fake.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [502, 'bad-gateway'],
    [500, 'error'],
  ])('a %i is "%s" and changes nothing', async (status, reason) => {
    const fake = enabled({ routes: { '/test-push': status } })
    expect(await sendTestNotification(fake.env)).toEqual({ ok: false, reason, reset: false })
    expect(fake.saved()).not.toBeNull()
    expect(fake.held.current).not.toBeNull()
  })

  it('a network failure changes nothing either', async () => {
    const fake = enabled({ routes: { '/test-push': new TypeError('Failed to fetch') } })
    expect(await sendTestNotification(fake.env)).toEqual({ ok: false, reason: 'network', reset: false })
    expect(fake.saved()).not.toBeNull()
  })

  it.each([
    [410, 'gone'],
    [422, 'gone'],
    [401, 'unauthorized'],
  ])('a %i (%s) resets the device: the saved id and secret and the browser subscription are removed', async (status, reason) => {
    const fake = enabled({ routes: { '/test-push': status } })
    expect(await sendTestNotification(fake.env)).toEqual({ ok: false, reason, reset: true })
    expect(fake.saved()).toBeNull()
    expect(fake.held.current).toBeNull()
  })
})

describe('turnOffBackgroundAlerts', () => {
  const enabled = (options = {}) => makeEnv({ permission: 'granted', account, existing: true, ...options })

  it('has the Worker forget the device, drops the browser subscription, and clears the saved id and secret', async () => {
    const fake = enabled()
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: true, cleared: true })
    expect(fake.fetchCalls[0]!.body).toEqual(account)
    expect(fake.fetchCalls[0]!.path).toBe('/unsubscribe')
    expect(fake.held.current).toBeNull()
    expect(fake.saved()).toBeNull()
  })

  it('still turns off on this device when the Worker cannot be reached, and says so', async () => {
    const fake = enabled({ routes: { '/unsubscribe': new TypeError('offline') } })
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: false, cleared: true })
    expect(fake.held.current).toBeNull()
    expect(fake.saved()).toBeNull()
  })

  it.each([500, 503, 429])('treats a %i from the Worker as "not removed", but still turns off here', async (status) => {
    const fake = enabled({ routes: { '/unsubscribe': status } })
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: false, cleared: true })
    expect(fake.saved()).toBeNull()
  })

  it.each([401, 410])('treats a %i as removed: the Worker no longer knows this device, which is the goal', async (status) => {
    const fake = enabled({ routes: { '/unsubscribe': status } })
    expect((await turnOffBackgroundAlerts(fake.env)).serverRemoved).toBe(true)
  })

  it('works when the browser subscription is already gone', async () => {
    const fake = makeEnv({ permission: 'granted', account })
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: true, cleared: true })
  })

  it('reports when the saved id and secret could not be cleared', async () => {
    const fake = enabled({ storage: 'cannot-clear' })
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: true, cleared: false })
  })

  it('does nothing at the Worker if nothing was saved', async () => {
    const fake = makeEnv()
    expect(await turnOffBackgroundAlerts(fake.env)).toEqual({ serverRemoved: true, cleared: true })
    expect(fake.fetchMock).not.toHaveBeenCalled()
  })

  it('never logs the secret or anything else', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    await turnOffBackgroundAlerts(enabled({ routes: { '/unsubscribe': new TypeError('offline') } }).env)
    await sendTestNotification(enabled({ routes: { '/test-push': 410 } }).env)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

it('the key used in these tests is a real 65-byte VAPID public key', () => {
  expect(PUBLIC_KEY).toHaveLength(87)
})
