import { describe, expect, it, vi } from 'vitest'
import { fetchPublicKey, parseRetryAfter, registerSubscription, removeSubscription, sendTestPush, uploadSchedule } from './client'

const BASE = 'https://push.example.workers.dev'
const account = { id: 'the-id', secret: 'the-secret' }
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
const fetching = (response: Response | Error) =>
  vi.fn(async () => {
    if (response instanceof Error) throw response
    return response
  })

describe('fetchPublicKey', () => {
  it('GETs /vapid-public-key and returns the key', async () => {
    const f = fetching(reply(200, { publicKey: 'BKEY' }))
    expect(await fetchPublicKey(BASE, f)).toEqual({ ok: true, publicKey: 'BKEY' })
    expect(f).toHaveBeenCalledWith(`${BASE}/vapid-public-key`, expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store' }))
  })

  it.each([
    ['no key', { x: 1 }],
    ['an empty key', { publicKey: '' }],
    ['a key that is not text', { publicKey: 5 }],
    ['null', null],
  ])('treats a 200 with %s as an error', async (_name, body) => {
    expect(await fetchPublicKey(BASE, fetching(reply(200, body)))).toEqual({ ok: false, reason: 'error' })
  })

  it('treats a 200 that is not JSON as an error', async () => {
    expect(await fetchPublicKey(BASE, fetching(new Response('<html>', { status: 200 })))).toEqual({ ok: false, reason: 'error' })
  })

  it('reports 503 as unavailable', async () => {
    expect(await fetchPublicKey(BASE, fetching(reply(503, { ok: false })))).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('registerSubscription', () => {
  it('POSTs the subscription as JSON and returns the id and secret', async () => {
    const f = fetching(reply(200, { id: 'i', secret: 's' }))
    const subscription = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } }
    expect(await registerSubscription(BASE, subscription, f)).toEqual({ ok: true, id: 'i', secret: 's' })
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/subscribe`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual(subscription)
    expect(init.credentials).toBe('omit')
  })

  it.each([
    ['no id', { secret: 's' }],
    ['no secret', { id: 'i' }],
    ['an empty id', { id: '', secret: 's' }],
    ['numbers', { id: 1, secret: 2 }],
  ])('treats a 200 with %s as an error', async (_name, body) => {
    expect(await registerSubscription(BASE, {}, fetching(reply(200, body)))).toEqual({ ok: false, reason: 'error' })
  })
})

describe('sendTestPush and removeSubscription', () => {
  it('POST the id and secret, to the right paths', async () => {
    const test = fetching(reply(200, { ok: true }))
    const off = fetching(reply(200, { ok: true }))
    expect(await sendTestPush(BASE, account, test)).toEqual({ ok: true })
    expect(await removeSubscription(BASE, account, off)).toEqual({ ok: true })
    const [testUrl, testInit] = test.mock.calls[0]! as unknown as [string, RequestInit]
    const [offUrl, offInit] = off.mock.calls[0]! as unknown as [string, RequestInit]
    expect([testUrl, offUrl]).toEqual([`${BASE}/test-push`, `${BASE}/unsubscribe`])
    expect(JSON.parse(testInit.body as string)).toEqual(account)
    expect(JSON.parse(offInit.body as string)).toEqual(account)
  })
})

describe('failures', () => {
  it.each([
    [429, 'rate-limited'],
    [410, 'gone'],
    [422, 'gone'],
    [401, 'unauthorized'],
    [503, 'unavailable'],
    [502, 'bad-gateway'],
    [400, 'error'],
    [413, 'error'],
    [415, 'error'],
    [404, 'error'],
    [500, 'error'],
  ])('maps HTTP %i to "%s" for every call', async (status, reason) => {
    const failure = { ok: false, reason }
    expect(await fetchPublicKey(BASE, fetching(reply(status, { ok: false })))).toEqual(failure)
    expect(await registerSubscription(BASE, {}, fetching(reply(status, { ok: false })))).toEqual(failure)
    expect(await sendTestPush(BASE, account, fetching(reply(status, { ok: false })))).toEqual(failure)
    expect(await removeSubscription(BASE, account, fetching(reply(status, { ok: false })))).toEqual(failure)
  })

  it('reports a network failure, whatever was thrown', async () => {
    for (const error of [new TypeError('Failed to fetch'), new DOMException('timed out', 'TimeoutError')]) {
      expect(await sendTestPush(BASE, account, fetching(error))).toEqual({ ok: false, reason: 'network' })
      expect(await fetchPublicKey(BASE, fetching(error))).toEqual({ ok: false, reason: 'network' })
    }
  })

  it('never passes on anything the Worker said beyond the status', async () => {
    const result = await sendTestPush(BASE, account, fetching(reply(502, { ok: false, error: 'details: secret-things' })))
    expect(JSON.stringify(result)).not.toContain('secret-things')
  })

  it('does not log anything', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    await sendTestPush(BASE, account, fetching(new TypeError('Failed to fetch')))
    await registerSubscription(BASE, { endpoint: 'x' }, fetching(reply(500)))
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('uploadSchedule', () => {
  const alerts = [{ fireAt: '2026-11-24T06:45:00.000Z', title: 'London opens in 15 minutes', body: 'Session Clock' }]

  it('PUTs the id, secret and alerts as JSON to /schedule', async () => {
    const f = fetching(reply(200, { ok: true }))
    expect(await uploadSchedule(BASE, account, alerts, f)).toEqual({ ok: true })
    expect(f).toHaveBeenCalledWith(
      `${BASE}/schedule`,
      expect.objectContaining({ method: 'PUT', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'the-id', secret: 'the-secret', alerts }) }),
    )
  })

  it.each([
    [401, 'unauthorized'],
    [410, 'gone'],
    [422, 'gone'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [502, 'bad-gateway'],
    [400, 'error'],
    [409, 'error'],
    [500, 'error'],
  ])('maps %i to %s', async (status, reason) => {
    expect(await uploadSchedule(BASE, account, alerts, fetching(reply(status)))).toEqual({ ok: false, reason })
  })

  it('passes on Retry-After from a 429 or 503', async () => {
    const r = (status: number, value: string) => new Response(null, { status, headers: { 'retry-after': value } })
    expect(await uploadSchedule(BASE, account, alerts, fetching(r(429, '60')))).toEqual({ ok: false, reason: 'rate-limited', retryAfterSeconds: 60 })
    expect(await uploadSchedule(BASE, account, alerts, fetching(r(503, '7200')))).toEqual({ ok: false, reason: 'unavailable', retryAfterSeconds: 7200 })
  })

  it('reports a network failure', async () => {
    expect(await uploadSchedule(BASE, account, alerts, fetching(new TypeError('offline')))).toEqual({ ok: false, reason: 'network' })
  })
})

describe('parseRetryAfter', () => {
  it.each([
    ['60', 60],
    [' 5 ', 5],
    ['0', 0],
    ['999999999', 86_400], // capped at a day
  ])('reads %j as %i seconds', (value, seconds) => expect(parseRetryAfter(value)).toBe(seconds))
  it.each([[null], [undefined], [''], ['soon'], ['-5'], ['1.5'], ['Wed, 21 Oct 2026 07:28:00 GMT']])('ignores %j', (value) => expect(parseRetryAfter(value)).toBeUndefined())
})
