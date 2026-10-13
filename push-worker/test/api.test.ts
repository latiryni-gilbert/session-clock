import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { sha256Hex } from '../src/crypto'
import { DAY, MIN, PROD, alertIn, alertRows, call, count, makeSubscription, register, resetDb, schedule, subscribe, unsubscribe } from './helpers'

beforeEach(resetDb)
afterEach(() => vi.restoreAllMocks())

describe('POST /subscribe', () => {
  it('stores the subscription and returns an id and a random secret', async () => {
    const sub = makeSubscription()
    const res = await subscribe(sub)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { id: string; secret: string }
    expect(Object.keys(body).sort()).toEqual(['id', 'secret'])
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const row = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(body.id).first<Record<string, unknown>>()
    expect(row).toMatchObject({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    expect(row!.created_at).toBeGreaterThan(Date.now() - 10_000)
    expect(row!.last_seen_at).toBe(row!.created_at)
  })

  it('stores only a hash of the secret, never the secret itself', async () => {
    const { id, secret } = await register()
    const row = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<Record<string, unknown>>()
    expect(row!.secret_hash).toBe(await sha256Hex(secret))
    expect(row!.secret_hash).not.toBe(secret)
    expect(JSON.stringify(Object.values(row!))).not.toContain(secret)
  })

  it('gives every subscription its own id and secret', async () => {
    const a = await register()
    const b = await register()
    expect(a.id).not.toBe(b.id)
    expect(a.secret).not.toBe(b.secret)
  })

  it('subscribing again with the same endpoint updates it: same id, new keys, new secret, old secret revoked', async () => {
    const first = await register()
    await env.DB.prepare('UPDATE subscriptions SET created_at = 1 WHERE id = ?').bind(first.id).run()
    await schedule(first.id, first.secret, [alertIn(MIN * 60)])

    const newKeys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }
    const res = await subscribe({ ...first.sub, keys: newKeys })
    expect(res.status).toBe(200)
    const second = (await res.json()) as { id: string; secret: string }

    expect(second.id).toBe(first.id)
    expect(second.secret).not.toBe(first.secret)
    expect(await count('subscriptions')).toBe(1)
    const row = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(first.id).first<Record<string, unknown>>()
    expect(row).toMatchObject({ p256dh: newKeys.p256dh, auth: newKeys.auth, created_at: 1 })
    expect(row!.last_seen_at).toBeGreaterThan(1)
    expect((await alertRows(first.id)).results).toHaveLength(1) // the schedule is kept

    expect((await schedule(first.id, first.secret, [])).status).toBe(401)
    expect((await schedule(first.id, second.secret, [])).status).toBe(200)
  })

  it('accepts the shape the browser produces, including expirationTime', async () => {
    expect((await subscribe(makeSubscription({ expirationTime: 1893456000000 }))).status).toBe(200)
  })

  it.each([
    ['no endpoint', { endpoint: undefined }],
    ['an endpoint that is not a string', { endpoint: 42 }],
    ['an endpoint that is not a URL', { endpoint: 'not a url' }],
    ['a plain http endpoint', { endpoint: 'http://fcm.googleapis.com/fcm/send/abc' }],
    ['an IP address endpoint', { endpoint: 'https://203.0.113.7/send' }],
    ['an IPv6 endpoint', { endpoint: 'https://[2001:db8::1]/send' }],
    ['a localhost endpoint', { endpoint: 'https://localhost/send' }],
    ['an internal hostname', { endpoint: 'https://metadata.internal/send' }],
    ['a single-label hostname', { endpoint: 'https://intranet/send' }],
    ['an endpoint with credentials', { endpoint: 'https://user:pass@fcm.googleapis.com/send' }],
    ['an endpoint with a port', { endpoint: 'https://fcm.googleapis.com:8443/send' }],
    ['an endpoint over 2048 characters', { endpoint: `https://fcm.googleapis.com/${'a'.repeat(2100)}` }],
    ['no keys', { keys: undefined }],
    ['keys that are not an object', { keys: 'abc' }],
    ['no p256dh', { keys: { auth: 'tBHItJI5svbpez7KI4CCXg' } }],
    ['no auth', { keys: { p256dh: 'B'.repeat(87) } }],
    ['a p256dh with invalid characters', { keys: { p256dh: `${'B'.repeat(80)}!!!!!!!`, auth: 'tBHItJI5svbpez7KI4CCXg' } }],
    ['an auth that is too short', { keys: { p256dh: 'B'.repeat(87), auth: 'abc' } }],
  ])('rejects %s with 400', async (_name, overrides) => {
    const res = await subscribe(makeSubscription(overrides))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBeTruthy()
    expect(await count('subscriptions')).toBe(0)
  })

  it('does not echo the endpoint or keys back in error messages', async () => {
    const sub = makeSubscription({ endpoint: 'http://secret-host.example.com/private-token-123' })
    const text = await (await subscribe(sub)).text()
    expect(text).not.toContain('private-token-123')
    expect(text).not.toContain(sub.keys.p256dh)
  })
})

describe('PUT /schedule', () => {
  it('stores the alerts, unsent, with fire times as UTC milliseconds', async () => {
    const { id, secret } = await register()
    const at = new Date(Date.now() + 2 * DAY)
    const res = await schedule(id, secret, [{ fireAt: at.toISOString(), title: 'London opens', body: 'in 5 minutes' }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, scheduled: 1, added: 1, removed: 0 })
    expect((await alertRows(id)).results).toEqual([
      { fire_at: at.getTime(), title: 'London opens', body: 'in 5 minutes', sent_at: null },
    ])
  })

  it('converts a UTC offset to UTC', async () => {
    const { id, secret } = await register()
    const at = Math.floor((Date.now() + DAY) / 1000) * 1000
    // The same instant written with a -04:00 offset (four hours earlier on the wall clock).
    const withOffset = `${new Date(at - 4 * 60 * MIN).toISOString().slice(0, 19)}-04:00`
    await schedule(id, secret, [{ fireAt: withOffset, title: 't', body: '' }])
    expect((await alertRows(id)).results[0]!.fire_at).toBe(at)
  })

  it("replaces the subscription's earlier future alerts", async () => {
    const { id, secret } = await register()
    await schedule(id, secret, [alertIn(DAY, { title: 'old 1' }), alertIn(2 * DAY, { title: 'old 2' }), alertIn(3 * DAY, { title: 'old 3' })])
    const res = await schedule(id, secret, [alertIn(5 * DAY, { title: 'new 1' }), alertIn(4 * DAY, { title: 'new 2' })])
    expect(await res.json()).toEqual({ ok: true, scheduled: 2, added: 2, removed: 3 })
    expect((await alertRows(id)).results.map((r) => r.title)).toEqual(['new 2', 'new 1'])
  })

  it('an empty list clears the future alerts', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, [alertIn(DAY)])
    expect((await schedule(id, secret, [])).status).toBe(200)
    expect((await alertRows(id)).results).toHaveLength(0)
  })

  it('leaves sent alerts, alerts already due, and other subscriptions alone', async () => {
    const a = await register()
    const b = await register()
    await schedule(b.id, b.secret, [alertIn(DAY, { title: 'b alert' })])
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body, sent_at) VALUES (?, ?, ?, ?, ?)').bind(a.id, now - 2 * DAY, 'sent', '', now - 2 * DAY),
      env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)').bind(a.id, now - MIN, 'due', ''),
      env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body, sent_at) VALUES (?, ?, ?, ?, ?)').bind(a.id, now + DAY, 'future but sent', '', now),
    ])
    await schedule(a.id, a.secret, [alertIn(2 * DAY, { title: 'a new' })])
    // Ordered by fire time: sent (2 days ago), due (a minute ago), future but sent (+1 day), a new (+2 days).
    expect((await alertRows(a.id)).results.map((r) => r.title)).toEqual(['sent', 'due', 'future but sent', 'a new'])
    expect((await alertRows(b.id)).results.map((r) => r.title)).toEqual(['b alert'])
  })

  it('updates last_seen_at', async () => {
    const { id, secret } = await register()
    await env.DB.prepare('UPDATE subscriptions SET last_seen_at = 1 WHERE id = ?').bind(id).run()
    await schedule(id, secret, [])
    const row = await env.DB.prepare('SELECT last_seen_at FROM subscriptions WHERE id = ?').bind(id).first<{ last_seen_at: number }>()
    expect(row!.last_seen_at).toBeGreaterThan(Date.now() - 10_000)
  })

  it('accepts exactly 500 alerts', async () => {
    const { id, secret } = await register()
    const alerts = Array.from({ length: 500 }, (_, i) => alertIn(MIN * (i + 1), { title: `a${i}`, body: 'x' }))
    const res = await schedule(id, secret, alerts)
    expect(res.status).toBe(200)
    expect((await alertRows(id)).results).toHaveLength(500)
  })

  it('rejects 501 alerts, and keeps the existing schedule', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, [alertIn(DAY, { title: 'keep me' })])
    const alerts = Array.from({ length: 501 }, (_, i) => alertIn(MIN * (i + 1), { title: 'a', body: '' }))
    const res = await schedule(id, secret, alerts)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('500')
    expect((await alertRows(id)).results.map((r) => r.title)).toEqual(['keep me'])
  })

  it('rejects an alert in the past, and keeps the existing schedule', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, [alertIn(DAY, { title: 'keep me' })])
    const res = await schedule(id, secret, [alertIn(MIN), alertIn(-MIN)])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('alerts[1].fireAt is in the past')
    expect((await alertRows(id)).results.map((r) => r.title)).toEqual(['keep me'])
  })

  it('rejects alerts more than 15 days ahead, and accepts ones just inside', async () => {
    const { id, secret } = await register()
    const tooFar = await schedule(id, secret, [alertIn(15 * DAY + 5 * MIN)])
    expect(tooFar.status).toBe(400)
    expect(((await tooFar.json()) as { error: string }).error).toContain('15 days')
    expect((await schedule(id, secret, [alertIn(15 * DAY - 5 * MIN)])).status).toBe(200)
  })

  it.each([
    ['a title that is empty', { title: '' }],
    ['a title over 80 characters', { title: 'x'.repeat(81) }],
    ['a title that is not a string', { title: 5 }],
    ['a body over 200 characters', { body: 'x'.repeat(201) }],
    ['a body that is not a string', { body: null }],
    ['a fireAt with no UTC offset', { fireAt: new Date(Date.now() + DAY).toISOString().slice(0, 19) }],
    ['a fireAt that is not a date', { fireAt: 'tomorrow' }],
    ['a fireAt that is a number', { fireAt: Date.now() + DAY }],
    ['a fireAt that is impossible', { fireAt: '2099-02-31T10:00:00Z' }],
  ])('rejects %s with 400', async (_name, overrides) => {
    const { id, secret } = await register()
    const res = await schedule(id, secret, [alertIn(DAY, overrides)])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('alerts[0]')
    expect((await alertRows(id)).results).toHaveLength(0)
  })

  it('accepts the maximum lengths, counting emoji as one character', async () => {
    const { id, secret } = await register()
    const res = await schedule(id, secret, [alertIn(DAY, { title: '🔔'.repeat(80), body: '🔔'.repeat(200) })])
    expect(res.status).toBe(200)
    expect((await alertRows(id)).results[0]!.title).toBe('🔔'.repeat(80))
  })

  it('accepts an empty body text', async () => {
    const { id, secret } = await register()
    expect((await schedule(id, secret, [alertIn(DAY, { body: '' })])).status).toBe(200)
  })

  it.each([
    ['alerts missing', undefined],
    ['alerts not an array', { fireAt: 'x' }],
    ['an alert that is not an object', ['nope']],
    ['an alert that is null', [null]],
  ])('rejects %s with 400', async (_name, alerts) => {
    const { id, secret } = await register()
    expect((await schedule(id, secret, alerts)).status).toBe(400)
  })
})

describe('POST /unsubscribe', () => {
  it('deletes the subscription and its alerts, and nobody else’s', async () => {
    const a = await register()
    const b = await register()
    await schedule(a.id, a.secret, [alertIn(DAY), alertIn(2 * DAY)])
    await schedule(b.id, b.secret, [alertIn(DAY)])

    const res = await unsubscribe(a.id, a.secret)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await count('subscriptions')).toBe(1)
    expect((await alertRows(a.id)).results).toHaveLength(0)
    expect((await alertRows(b.id)).results).toHaveLength(1)
    expect(await count('alerts')).toBe(1) // no orphans left behind
  })

  it('cannot be repeated: the subscription is gone, so the secret no longer works', async () => {
    const a = await register()
    expect((await unsubscribe(a.id, a.secret)).status).toBe(200)
    expect((await unsubscribe(a.id, a.secret)).status).toBe(401)
  })

  it('allows the same browser to subscribe again afterwards, as a new subscription', async () => {
    const a = await register()
    await unsubscribe(a.id, a.secret)
    const again = await register(a.sub)
    expect(again.id).not.toBe(a.id)
  })
})

describe('authentication (401)', () => {
  const attempts: [string, string, (id: string, secret: string) => Promise<Response>][] = [
    ['PUT /schedule', 'schedule', (id, secret) => schedule(id, secret, [alertIn(DAY)])],
    ['POST /unsubscribe', 'unsubscribe', unsubscribe],
  ]

  it.each(attempts)('%s: a wrong secret and an unknown id get an identical 401', async (_name, _key, run) => {
    const { id, secret } = await register()
    const wrongSecret = await run(id, `${secret.slice(1)}x`)
    const unknownId = await run(crypto.randomUUID(), secret)
    expect(wrongSecret.status).toBe(401)
    expect(unknownId.status).toBe(401)
    expect(await unknownId.text()).toBe(await wrongSecret.text())
    expect([...unknownId.headers].sort()).toEqual([...wrongSecret.headers].sort())
  })

  it.each(attempts)('%s: another subscription’s secret does not work', async (_name, _key, run) => {
    const a = await register()
    const b = await register()
    expect((await run(a.id, b.secret)).status).toBe(401)
    expect(await count('subscriptions')).toBe(2)
  })

  it.each([
    ['PUT', '/schedule', { id: 'x', alerts: [] }],
    ['PUT', '/schedule', { secret: 'x', alerts: [] }],
    ['PUT', '/schedule', { id: 5, secret: 'x', alerts: [] }],
    ['PUT', '/schedule', { id: 'x', secret: ['x'], alerts: [] }],
    ['PUT', '/schedule', { id: 'x', secret: '', alerts: [] }],
    ['PUT', '/schedule', { id: 'x'.repeat(500), secret: 'x', alerts: [] }],
    ['POST', '/unsubscribe', {}],
    ['POST', '/unsubscribe', { id: 'x' }],
  ])('%s %s with a missing or malformed id/secret returns 401', async (method, path, body) => {
    const { id } = await register()
    expect((await call(method, path, body)).status).toBe(401)
    expect(await count('subscriptions')).toBe(1)
    expect(id).toBeTruthy()
  })

  it('checks the secret before the alerts, so a bad secret never reveals validation details', async () => {
    const { id } = await register()
    const res = await call('PUT', '/schedule', { id, secret: 'wrong', alerts: 'not even an array' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid id or secret' })
  })

  it('does not change anything when the secret is wrong', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, [alertIn(DAY, { title: 'keep me' })])
    await schedule(id, 'wrong', [alertIn(2 * DAY, { title: 'intruder' })])
    await unsubscribe(id, 'wrong')
    expect((await alertRows(id)).results.map((r) => r.title)).toEqual(['keep me'])
    expect(await count('subscriptions')).toBe(1)
  })
})

describe('request bodies', () => {
  const endpoints: [string, string][] = [
    ['POST', '/subscribe'],
    ['PUT', '/schedule'],
    ['POST', '/unsubscribe'],
  ]

  it.each(endpoints)('%s %s rejects a body over 64 KB with 413', async (method, path) => {
    const res = await call(method, path, JSON.stringify({ padding: 'x'.repeat(65 * 1024) }))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toContain('64 KB')
  })

  it.each(endpoints)('%s %s rejects an oversized body even without a Content-Length header', async (method, path) => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await exports.default.fetch(
      new Request(`https://push.example.com${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: stream,
        // @ts-expect-error `duplex` is required for streamed request bodies but missing from the DOM types
        duplex: 'half',
      }),
    )
    expect(res.status).toBe(413)
  })

  it('accepts a body just under the limit', async () => {
    const res = await call('POST', '/unsubscribe', JSON.stringify({ id: 'x', secret: 'y', padding: 'x'.repeat(60 * 1024) }))
    expect(res.status).toBe(401) // read and parsed fine; it just isn't a valid login
  })

  it.each(endpoints)('%s %s rejects malformed JSON with 400', async (method, path) => {
    const res = await call(method, path, '{"id": "x", ')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Request body is not valid JSON')
  })

  it.each([
    ['an empty body', ''],
    ['bytes that are not valid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await exports.default.fetch(
      new Request('https://push.example.com/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    )
    expect(res.status).toBe(400)
  })

  it.each([['an array', '[]'], ['null', 'null'], ['a string', '"hi"'], ['a number', '5']])('rejects %s as the body with 400', async (_name, body) => {
    const res = await call('POST', '/subscribe', body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Request body must be a JSON object')
  })

  it('rejects a body that is not declared as JSON with 415', async () => {
    const res = await call('POST', '/subscribe', JSON.stringify(makeSubscription()), { 'content-type': 'text/plain' })
    expect(res.status).toBe(415)
    expect(await count('subscriptions')).toBe(0)
  })

  it('accepts a charset on the JSON content type', async () => {
    const res = await call('POST', '/subscribe', makeSubscription(), { 'content-type': 'application/json; charset=utf-8' })
    expect(res.status).toBe(200)
  })
})

describe('routing', () => {
  it.each([
    ['GET', '/subscribe', 'POST'],
    ['PUT', '/subscribe', 'POST'],
    ['POST', '/schedule', 'PUT'],
    ['GET', '/schedule', 'PUT'],
    ['GET', '/unsubscribe', 'POST'],
    ['DELETE', '/unsubscribe', 'POST'],
  ])('%s %s returns 405 and names the allowed method', async (method, path, allowed) => {
    const res = await call(method, path)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe(`${allowed}, OPTIONS`)
  })

  it.each(['/subscribe/', '/Subscribe', '/schedule/x', '/toString', '/constructor', '/__proto__'])('treats %s as not found', async (path) => {
    expect((await call('POST', path, {})).status).toBe(404)
  })
})

describe('CORS', () => {
  it.each([
    PROD,
    'https://session-clock-git-claude-push-6bd2d9-latiryni-gilberts-projects.vercel.app',
    'https://session-clock-a1b2c3d4e-latiryni-gilberts-projects.vercel.app',
    'http://localhost:5173',
    'http://localhost',
    'https://localhost:4173',
  ])('allows %s', async (origin) => {
    const res = await subscribe(makeSubscription(), { origin })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    expect(res.headers.get('vary')).toContain('Origin')
  })

  it.each([
    'https://evil.example',
    'http://sessionclock.vercel.app',
    'https://sessionclock.vercel.app.evil.example',
    'https://evil.sessionclock.vercel.app',
    'https://sessionclock.vercel.app:8443',
    'https://session-clock-evil.vercel.app',
    'https://session-clock-git-x-someone-elses-projects.vercel.app',
    'https://session-clock-x-latiryni-gilberts-projects.vercel.app.evil.example',
    'https://xsession-clock-x-latiryni-gilberts-projects.vercel.app',
    'http://localhost.evil.example',
    'http://localhost:5173.evil.example',
    'http://127.0.0.1:5173',
    'null',
  ])('blocks %j: 403, no CORS headers, and nothing is stored', async (origin) => {
    const res = await subscribe(makeSubscription(), { origin })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(await count('subscriptions')).toBe(0)
  })

  it('blocks a blocked origin on every endpoint, without running it', async () => {
    const { id, secret } = await register()
    const origin = 'https://evil.example'
    const calls = [
      call('PUT', '/schedule', { id, secret, alerts: [alertIn(DAY)] }, { origin }),
      call('POST', '/unsubscribe', { id, secret }, { origin }),
    ]
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403)
    expect(await count('subscriptions')).toBe(1)
    expect((await alertRows(id)).results).toHaveLength(0)
  })

  it('answers an allowed preflight with 204 and the method and header the endpoint needs', async () => {
    const res = await call('OPTIONS', '/schedule', undefined, {
      origin: PROD,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD)
    expect(res.headers.get('access-control-allow-methods')).toBe('PUT, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(res.headers.get('access-control-max-age')).toBe('86400')
  })

  it('refuses a preflight from a blocked origin', async () => {
    const res = await call('OPTIONS', '/subscribe', undefined, { origin: 'https://evil.example', 'access-control-request-method': 'POST' })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('also sends CORS headers on errors, so the app can read them', async () => {
    const bad = await call('PUT', '/schedule', { id: 'x', secret: 'y' }, { origin: PROD })
    expect(bad.status).toBe(401)
    expect(bad.headers.get('access-control-allow-origin')).toBe(PROD)
    const tooBig = await call('POST', '/subscribe', JSON.stringify({ p: 'x'.repeat(70_000) }), { origin: PROD })
    expect(tooBig.status).toBe(413)
    expect(tooBig.headers.get('access-control-allow-origin')).toBe(PROD)
  })

  it('works without an Origin header (curl, servers) and then sends no CORS headers', async () => {
    const res = await subscribe()
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not add CORS rules to /health', async () => {
    const res = await exports.default.fetch(new Request('https://push.example.com/health', { headers: { origin: 'https://evil.example' } }))
    expect(res.status).toBe(200)
  })
})

describe('database', () => {
  it('has an index for "unsent alerts due before time X"', async () => {
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM alerts WHERE sent_at IS NULL AND fire_at <= ? ORDER BY fire_at',
    )
      .bind(Date.now())
      .all<{ detail: string }>()
    const detail = plan.results.map((r) => r.detail).join(' | ')
    expect(detail).toContain('idx_alerts_due')
    expect(detail).not.toContain('SCAN alerts')
    expect(detail).not.toContain('TEMP B-TREE') // already in order, no sort step
  })

  it('refuses a duplicate endpoint', async () => {
    const { sub } = await register()
    const insert = env.DB.prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
    await expect(insert.bind('another-id', sub.endpoint, 'a', 'b', 'c').run()).rejects.toThrow()
  })

  it('refuses an alert for a subscription that does not exist', async () => {
    const insert = env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)')
    await expect(insert.bind('no-such-id', Date.now(), 't', 'b').run()).rejects.toThrow()
  })
})

describe('logging and failures', () => {
  it('writes nothing to the logs while handling requests, including failures', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const { id, secret, sub } = await register()
    await schedule(id, secret, [alertIn(DAY)])
    await schedule(id, 'wrong', [])
    await call('POST', '/subscribe', '{bad json')
    await unsubscribe(id, secret)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(sub.endpoint).toBeTruthy()
  })

  it('turns an unexpected failure into a generic 500 and logs only the kind of error', async () => {
    const sub = makeSubscription()
    const secretish = 'SECRET-DETAIL-FROM-DB'
    const brokenEnv = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error(`boom ${sub.endpoint} ${sub.keys.auth} ${secretish}`)
        },
      },
    } as unknown as Cloudflare.Env
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await worker.fetch(
      new Request('https://push.example.com/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
      }),
      brokenEnv,
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Internal error' })
    expect(logged).toHaveBeenCalledTimes(1)
    const output = JSON.stringify(logged.mock.calls)
    for (const secret of [sub.endpoint, sub.keys.auth, sub.keys.p256dh, secretish]) expect(output).not.toContain(secret)
  })
})
