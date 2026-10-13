import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { DAY, alertIn, count, makeSubscription, register, resetDb } from './helpers'

beforeEach(resetDb)

// Every request in these tests comes from a client address of the test's choosing, like Cloudflare supplies in production.
const fromIp = (ip: string, method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request(`https://push.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
      body: JSON.stringify(body),
    }),
  )
let n = 0
const freshIp = () => `198.51.100.${(++n % 250) + 1}`

describe('POST /subscribe: 3 per minute per client', () => {
  it('allows 3, then answers 429 with Retry-After, and does not process the request', async () => {
    const ip = freshIp()
    for (let i = 0; i < 3; i++) expect((await fromIp(ip, 'POST', '/subscribe', makeSubscription())).status).toBe(200)
    const limited = await fromIp(ip, 'POST', '/subscribe', makeSubscription())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ ok: false, error: 'Too many requests; try again shortly' })
    expect(await count('subscriptions')).toBe(3)
  })

  it('counts each client separately', async () => {
    const a = freshIp()
    const b = freshIp()
    for (let i = 0; i < 3; i++) await fromIp(a, 'POST', '/subscribe', makeSubscription())
    expect((await fromIp(a, 'POST', '/subscribe', makeSubscription())).status).toBe(429)
    expect((await fromIp(b, 'POST', '/subscribe', makeSubscription())).status).toBe(200)
  })

  it('counts invalid requests too, since they cost the Worker work', async () => {
    const ip = freshIp()
    for (let i = 0; i < 3; i++) expect((await fromIp(ip, 'POST', '/subscribe', {})).status).toBe(400)
    expect((await fromIp(ip, 'POST', '/subscribe', {})).status).toBe(429)
  })

  it('sends CORS headers on the 429 so the web app can read it', async () => {
    const ip = freshIp()
    const origin = 'https://sessionclock.vercel.app'
    for (let i = 0; i < 3; i++) await fromIp(ip, 'POST', '/subscribe', makeSubscription(), { origin })
    const limited = await fromIp(ip, 'POST', '/subscribe', makeSubscription(), { origin })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin)
  })

  it('does not count preflights', async () => {
    const ip = freshIp()
    const origin = 'https://sessionclock.vercel.app'
    for (let i = 0; i < 10; i++) {
      const res = await fromIp(ip, 'OPTIONS', '/subscribe', undefined, { origin })
      expect(res.status).toBe(204)
    }
    expect((await fromIp(ip, 'POST', '/subscribe', makeSubscription(), { origin })).status).toBe(200)
  })
})

describe('PUT /schedule: 10 requests per minute per client, 2 changing uploads per minute per subscription', () => {
  it('limits requests per client address, even with wrong credentials', async () => {
    const ip = freshIp()
    for (let i = 0; i < 10; i++) expect((await fromIp(ip, 'PUT', '/schedule', { id: 'x', secret: 'y', alerts: [] })).status).toBe(401)
    const limited = await fromIp(ip, 'PUT', '/schedule', { id: 'x', secret: 'y', alerts: [] })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('lets a client repeat the same schedule as often as the per-client limit allows, since that writes nothing', async () => {
    const { id, secret } = await register()
    const ip = freshIp()
    const alerts = [alertIn(DAY)]
    for (let i = 0; i < 10; i++) expect((await fromIp(ip, 'PUT', '/schedule', { id, secret, alerts })).status).toBe(200)
  })

  it('limits uploads that change something to 2 a minute per subscription', async () => {
    const { id, secret } = await register()
    // Fixed alerts: the same title must mean the same alert (alertIn() stamps the current time each call).
    const schedules = ['one', 'two', 'three'].map((title) => [alertIn(DAY, { title })])
    const upload = (alerts: unknown) => fromIp(freshIp(), 'PUT', '/schedule', { id, secret, alerts })
    expect((await upload(schedules[0])).status).toBe(200)
    expect((await upload(schedules[1])).status).toBe(200)
    const limited = await upload(schedules[2])
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    // The third change was not applied.
    const rows = await env.DB.prepare('SELECT title FROM alerts WHERE subscription_id = ?').bind(id).all<{ title: string }>()
    expect(rows.results.map((r) => r.title)).toEqual(['two'])
    // ...but re-sending the schedule that is already stored still works: it changes nothing, so it isn't limited.
    const again = await upload(schedules[1])
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ unchanged: true })
  })

  it('gives each subscription its own allowance', async () => {
    const a = await register()
    const b = await register()
    const upload = (s: { id: string; secret: string }, title: string) =>
      fromIp(freshIp(), 'PUT', '/schedule', { id: s.id, secret: s.secret, alerts: [alertIn(DAY, { title })] })
    await upload(a, '1')
    await upload(a, '2')
    expect((await upload(a, '3')).status).toBe(429)
    expect((await upload(b, '1')).status).toBe(200)
  })
})

describe('other endpoints and failure modes', () => {
  it('POST /unsubscribe is not rate limited (it only ever frees rows)', async () => {
    const ip = freshIp()
    for (let i = 0; i < 15; i++) expect((await fromIp(ip, 'POST', '/unsubscribe', { id: 'x', secret: 'y' })).status).toBe(401)
  })

  it('does not limit requests that carry no client address (outside Cloudflare, e.g. local development)', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await exports.default.fetch(
        new Request('https://push.example.com/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(makeSubscription()) }),
      )
      expect(res.status).toBe(200)
    }
  })

  it('fails open when a limiter errors or is missing, rather than taking the API down', async () => {
    const broken = { limit: () => Promise.reject(new Error('limiter down')) }
    for (const limiters of [{ SUBSCRIBE_LIMITER: broken }, { SUBSCRIBE_LIMITER: undefined }]) {
      const res = await worker.fetch(
        new Request('https://push.example.com/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
          body: JSON.stringify(makeSubscription()),
        }),
        { ...env, ...limiters } as unknown as Cloudflare.Env,
      )
      expect(res.status).toBe(200)
    }
  })

  it('is configured in wrangler.jsonc with the limits documented in the README', async () => {
    // Hits the real bindings: they exist and enforce the numbers above (covered by the tests earlier in this file).
    expect(env.SUBSCRIBE_LIMITER).toBeDefined()
    expect(env.SCHEDULE_LIMITER).toBeDefined()
    expect(env.SCHEDULE_CHANGE_LIMITER).toBeDefined()
  })
})

describe("when D1's daily free-tier limit is used up", () => {
  const limitEnv = (message: string) =>
    ({
      ...env,
      DB: {
        prepare: () => {
          throw new Error(message)
        },
      },
    }) as unknown as Cloudflare.Env
  const send = (e: Cloudflare.Env, path = '/subscribe') =>
    worker.fetch(
      new Request(`https://push.example.com${path}`, { method: path === '/schedule' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...makeSubscription(), id: 'x', secret: 'y', alerts: [] }) }),
      e,
    )

  it.each(["D1_ERROR: Your account has exceeded D1's free tier daily row write limit.", "D1_ERROR: Your account has exceeded D1's free tier daily row read limit."])(
    'answers 503 with Retry-After until the counters reset at 00:00 UTC (%s)',
    async (message) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const res = await send(limitEnv(message))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ ok: false, error: 'Storage is unavailable until the daily limit resets at 00:00 UTC' })
      const retryAfter = Number(res.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThanOrEqual(1)
      expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60)
      // The reset really is at the next UTC midnight.
      const resetAt = new Date(Date.now() + retryAfter * 1000)
      expect([resetAt.getUTCHours(), resetAt.getUTCMinutes()]).toEqual([0, 0])
      expect(warn).toHaveBeenCalledWith('D1 daily free-tier limit reached')
      warn.mockRestore()
    },
  )

  it('applies to /schedule too (the authentication read fails first)', async () => {
    expect((await send(limitEnv("D1_ERROR: exceeded D1's free tier daily row read limit"), '/schedule')).status).toBe(503)
  })

  it('leaves /health working, since it needs no database', async () => {
    const res = await worker.fetch(new Request('https://push.example.com/health'), limitEnv("D1_ERROR: exceeded daily row write limit"))
    expect(res.status).toBe(200)
  })

  it('still reports other database errors as a generic 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(limitEnv('D1_ERROR: no such table: subscriptions'))
    expect(res.status).toBe(500)
    error.mockRestore()
  })
})
