import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { DAY, alertIn, alertRows, count, resetDb, schedule } from './helpers'
import { callWorker, mockPushService, newVapidPair, registerBrowser, verifyVapidHeader } from './webpush-helpers'

const PROD = 'https://sessionclock.vercel.app'

beforeEach(resetDb)
afterEach(() => vi.restoreAllMocks())

const testPush = (id: string, secret: string, headers: Record<string, string> = {}, bindings: Record<string, unknown> = {}) =>
  callWorker('POST', '/test-push', { id, secret }, headers, bindings)
const subscriptionExists = async (id: string) => (await env.DB.prepare('SELECT 1 AS x FROM subscriptions WHERE id = ?').bind(id).first()) !== null

describe('POST /test-push: sending', () => {
  it('sends one notification that the browser can decrypt, signed with the VAPID key', async () => {
    const { id, secret, browser, endpoint } = await registerBrowser()
    const push = mockPushService()

    const res = await testPush(id, secret)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('cache-control')).toBe('no-store')

    expect(push.calls).toHaveLength(1)
    const call = push.calls[0]!
    expect(call.url).toBe(endpoint)
    expect(call.init.method).toBe('POST')
    expect(call.init.redirect).toBe('manual')
    expect(call.headers.get('content-encoding')).toBe('aes128gcm')
    expect(call.headers.get('content-type')).toBe('application/octet-stream')
    expect(call.headers.get('ttl')).toBe('60')
    expect(call.headers.get('urgency')).toBe('high')

    const vapid = await verifyVapidHeader(call.headers.get('authorization')!, env.VAPID_PUBLIC_KEY)
    expect(vapid.claims).toMatchObject({ aud: new URL(endpoint).origin, sub: 'https://sessionclock.vercel.app' })

    const message = JSON.parse(new TextDecoder().decode(await browser.decrypt(call.body)))
    expect(message).toEqual({ title: 'Session Clock', body: 'Background alerts are working.' })
  })

  it('accepts any 2xx from the push service as success', async () => {
    for (const status of [200, 201, 202]) {
      const { id, secret } = await registerBrowser()
      mockPushService(() => new Response(null, { status }))
      expect((await testPush(id, secret)).status).toBe(200)
      vi.restoreAllMocks()
    }
  })

  it('does not wait for or keep the push service’s response body', async () => {
    const { id, secret } = await registerBrowser()
    const cancel = vi.fn()
    const body = new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])), cancel })
    mockPushService(() => new Response(body, { status: 201 }))
    expect((await testPush(id, secret)).status).toBe(200)
    expect(cancel).toHaveBeenCalled()
  })

  it('works for each kind of push service endpoint', async () => {
    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      const { id, secret } = await registerBrowser(endpoint)
      const push = mockPushService()
      expect((await testPush(id, secret)).status).toBe(200)
      expect(push.calls[0]!.url).toBe(endpoint)
      vi.restoreAllMocks()
    }
  })

  it('writes nothing to the database', async () => {
    const { id, secret } = await registerBrowser()
    const before = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first()
    mockPushService()
    await testPush(id, secret)
    expect(await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first()).toEqual(before)
  })
})

describe('POST /test-push: authentication', () => {
  it('rejects a wrong secret and an unknown id with the same 401, and sends nothing', async () => {
    const { id, secret } = await registerBrowser()
    const push = mockPushService()
    const wrongSecret = await testPush(id, `${secret.slice(1)}x`)
    const unknownId = await testPush(crypto.randomUUID(), secret)
    expect(wrongSecret.status).toBe(401)
    expect(unknownId.status).toBe(401)
    expect(await unknownId.text()).toBe(await wrongSecret.text())
    expect(push.calls).toHaveLength(0)
  })

  it.each([
    ['no id', { secret: 'x' }],
    ['no secret', { id: 'x' }],
    ['an id that is not a string', { id: 5, secret: 'x' }],
    ['an empty body object', {}],
  ])('rejects %s with 401 and sends nothing', async (_name, body) => {
    const push = mockPushService()
    expect((await callWorker('POST', '/test-push', body)).status).toBe(401)
    expect(push.calls).toHaveLength(0)
  })

  it("another subscription's secret does not work", async () => {
    const a = await registerBrowser()
    const b = await registerBrowser()
    const push = mockPushService()
    expect((await testPush(a.id, b.secret)).status).toBe(401)
    expect(push.calls).toHaveLength(0)
  })

  it('checks the credentials before anything about push is revealed', async () => {
    const res = await testPush('nobody', 'nothing', {}, { VAPID_PRIVATE_KEY: undefined })
    expect(res.status).toBe(401) // not 503: an unauthenticated caller learns nothing about the server's configuration
  })

  it.each([
    ['malformed JSON', '{"id":'],
    ['an array', '[]'],
  ])('rejects %s with 400', async (_name, raw) => {
    const res = await worker.fetch(
      new Request('https://push.example.com/test-push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it('refuses a body over 64 KB', async () => {
    const res = await callWorker('POST', '/test-push', { id: 'x', secret: 'y', padding: 'x'.repeat(70_000) })
    expect(res.status).toBe(413)
  })

  it('only allows POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await callWorker(method, '/test-push')
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST, OPTIONS')
    }
  })
})

describe('POST /test-push: rate limits', () => {
  it('allows one a minute per subscription: the second is a 429 with Retry-After, and sends nothing', async () => {
    const { id, secret } = await registerBrowser()
    const push = mockPushService()
    expect((await testPush(id, secret)).status).toBe(200)
    const second = await testPush(id, secret)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('60')
    expect(await second.json()).toEqual({ ok: false, error: 'Too many requests; try again shortly' })
    expect(push.calls).toHaveLength(1)
  })

  it('counts each subscription separately', async () => {
    const a = await registerBrowser()
    const b = await registerBrowser()
    const push = mockPushService()
    expect((await testPush(a.id, a.secret)).status).toBe(200)
    expect((await testPush(b.id, b.secret)).status).toBe(200)
    expect((await testPush(a.id, a.secret)).status).toBe(429)
    expect(push.calls).toHaveLength(2)
  })

  it('does not count requests with wrong credentials against the subscription', async () => {
    const { id, secret } = await registerBrowser()
    mockPushService()
    for (let i = 0; i < 3; i++) expect((await testPush(id, 'wrong')).status).toBe(401)
    expect((await testPush(id, secret)).status).toBe(200)
  })

  it('also limits each client address to 10 requests a minute, even with wrong credentials', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.77' }
    for (let i = 0; i < 10; i++) expect((await testPush('x', 'y', ip)).status).toBe(401)
    const limited = await testPush('x', 'y', ip)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('sends CORS headers on the 429 so the app can read it', async () => {
    const { id, secret } = await registerBrowser()
    mockPushService()
    await testPush(id, secret, { origin: PROD })
    const limited = await testPush(id, secret, { origin: PROD })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('access-control-allow-origin')).toBe(PROD)
  })

  it('goes ahead if the limiter is unavailable, rather than failing', async () => {
    const { id, secret } = await registerBrowser()
    mockPushService()
    const broken = { limit: () => Promise.reject(new Error('down')) }
    expect((await testPush(id, secret, {}, { TEST_PUSH_LIMITER: broken })).status).toBe(200)
  })
})

describe('POST /test-push: subscriptions the push service says are gone', () => {
  it.each([404, 410])('a %i deletes the subscription and its alerts', async (status) => {
    const { id, secret } = await registerBrowser()
    const other = await registerBrowser()
    await schedule(id, secret, [alertIn(DAY), alertIn(2 * DAY)])
    await schedule(other.id, other.secret, [alertIn(DAY)])
    mockPushService(() => new Response(null, { status }))

    const res = await testPush(id, secret)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'The push service says this subscription no longer exists, so it was removed; subscribe again',
    })
    expect(await subscriptionExists(id)).toBe(false)
    expect((await alertRows(id)).results).toHaveLength(0)
    // Nobody else is touched.
    expect(await subscriptionExists(other.id)).toBe(true)
    expect((await alertRows(other.id)).results).toHaveLength(1)
    expect(await count('alerts')).toBe(1)
  })

  it('after that the old secret no longer works', async () => {
    const { id, secret } = await registerBrowser()
    mockPushService(() => new Response(null, { status: 410 }))
    await testPush(id, secret)
    expect((await testPush(id, secret)).status).toBe(401)
  })

  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [413, 'Payload Too Large'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
    [502, 'Bad Gateway'],
    [503, 'Service Unavailable'],
    [301, 'Moved'],
    [302, 'Found'],
  ])('a %i (%s) deletes nothing and reports a 502', async (status) => {
    const { id, secret } = await registerBrowser()
    await schedule(id, secret, [alertIn(DAY)])
    mockPushService(() => new Response(null, { status }))

    const res = await testPush(id, secret)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: `The push service refused the message (status ${status})` })
    expect(await subscriptionExists(id)).toBe(true)
    expect((await alertRows(id)).results).toHaveLength(1)
  })

  it.each([
    ['a network error', new TypeError('network connection lost')],
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ])('%s deletes nothing and reports a 502', async (_name, error) => {
    const { id, secret } = await registerBrowser()
    mockPushService(() => error)
    const res = await testPush(id, secret)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not reach the push service' })
    expect(await subscriptionExists(id)).toBe(true)
  })

  it('gives the push service a time limit', async () => {
    const { id, secret } = await registerBrowser()
    const push = mockPushService()
    await testPush(id, secret)
    expect(push.calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('POST /test-push: subscriptions it will not send to', () => {
  it.each([
    'https://example.com/push/abc',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://169.254.169.254.example.com/latest',
  ])('does not send to %s (not a push service), and deletes nothing', async (endpoint) => {
    // Such a subscription can only get into the database by being added directly; subscribe accepts any public https URL.
    const { id, secret } = await registerBrowser()
    await env.DB.prepare('UPDATE subscriptions SET endpoint = ? WHERE id = ?').bind(endpoint, id).run()
    const push = mockPushService()
    const res = await testPush(id, secret)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'This subscription is not on a push service the server sends to' })
    expect(push.calls).toHaveLength(0)
    expect(await subscriptionExists(id)).toBe(true)
  })

  it('answers 422, sends nothing and deletes nothing when the stored keys are unusable', async () => {
    const { id, secret } = await registerBrowser()
    await env.DB.prepare("UPDATE subscriptions SET p256dh = ? WHERE id = ?").bind('B'.repeat(87), id).run() // not a point on the curve
    const push = mockPushService()
    const res = await testPush(id, secret)
    expect(res.status).toBe(422)
    expect(push.calls).toHaveLength(0)
    expect(await subscriptionExists(id)).toBe(true)
  })

  it('answers 503 and sends nothing when the private key is missing or is not the public key’s pair', async () => {
    const other = await newVapidPair()
    for (const bindings of [{ VAPID_PRIVATE_KEY: undefined }, { VAPID_PRIVATE_KEY: other.privateKey }]) {
      const { id, secret } = await registerBrowser()
      const push = mockPushService()
      const res = await testPush(id, secret, {}, bindings)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ ok: false, error: 'Push notifications are not configured on the server' })
      expect(push.calls).toHaveLength(0)
      expect(await subscriptionExists(id)).toBe(true)
      vi.restoreAllMocks()
    }
  })
})

describe('CORS', () => {
  it('works from the app and sends the CORS headers', async () => {
    const { id, secret } = await registerBrowser()
    mockPushService()
    const res = await testPush(id, secret, { origin: PROD })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD)
  })

  it('refuses other origins before doing anything', async () => {
    const { id, secret } = await registerBrowser()
    const push = mockPushService()
    const res = await testPush(id, secret, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(push.calls).toHaveLength(0)
  })

  it('answers a preflight', async () => {
    const res = await callWorker('OPTIONS', '/test-push', undefined, { origin: PROD, 'access-control-request-method': 'POST' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
  })
})

describe('logging', () => {
  it('logs nothing, and the responses repeat nothing sensitive, on success or any kind of failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const responses: string[] = []
    const scenarios: Array<() => Response | Error> = [
      () => new Response(null, { status: 201 }),
      () => new Response(null, { status: 410 }),
      () => new Response(null, { status: 500 }),
      () => new TypeError('connection to push endpoint failed'),
    ]
    const sensitive: string[] = []
    for (const scenario of scenarios) {
      const { id, secret, browser, endpoint } = await registerBrowser()
      sensitive.push(endpoint, browser.subscription.keys.p256dh, browser.subscription.keys.auth, secret, 'Background alerts are working')
      mockPushService(scenario)
      responses.push(await (await testPush(id, secret)).text())
      vi.restoreAllMocks()
      for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => {})
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    for (const text of responses) for (const secret of sensitive) expect(text).not.toContain(secret)
    vi.restoreAllMocks()
    // The VAPID private key appears nowhere either.
    for (const text of responses) expect(text).not.toContain(env.VAPID_PRIVATE_KEY!)
  })

  it('an unexpected failure logs only the kind of error, never the endpoint, keys or message', async () => {
    const { id, secret, endpoint, browser } = await registerBrowser()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenDb = {
      prepare: () => {
        throw new Error(`boom ${endpoint} ${browser.subscription.keys.auth} ${secret}`)
      },
    }
    const res = await testPush(id, secret, {}, { DB: brokenDb })
    expect(res.status).toBe(500)
    const output = JSON.stringify(logged.mock.calls)
    for (const value of [endpoint, browser.subscription.keys.auth, browser.subscription.keys.p256dh, secret]) expect(output).not.toContain(value)
  })
})
