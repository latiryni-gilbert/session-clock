import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import wranglerConfig from '../wrangler.jsonc?raw'
import { DAILY_CRON, EXPIRED_PER_RUN, LATE_LIMIT_MS, STALE_SUBSCRIPTIONS_PER_RUN } from '../src/constants'
import { alertTag, DUE_SQL, formatRun, pushesPerRun, runMaintenance, runScheduler } from '../src/scheduler'
import { DAY, MIN, countDb, count, resetDb } from './helpers'
import { mockPushService, registerBrowser, runCron, verifyVapidHeader } from './webpush-helpers'

// A fixed "now" for the logic: alerts are placed relative to it and runs are told it explicitly.
const NOW = Date.now()
const GONE_STATUSES = [404, 410]

beforeEach(resetDb)
afterEach(() => vi.restoreAllMocks())

type Account = Awaited<ReturnType<typeof registerBrowser>>

/** Adds an alert that was due `minutesLate` minutes before NOW (negative: in the future). Returns its id. */
async function alertFor(account: Pick<Account, 'id'>, minutesLate: number, title = 'London opens', body = 'in 15 minutes') {
  const row = await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(account.id, NOW - minutesLate * MIN, title, body)
    .first<{ id: number }>()
  return row!.id
}
const remainingAlerts = async () => (await env.DB.prepare('SELECT id FROM alerts ORDER BY fire_at, id').all<{ id: number }>()).results.map((r) => r.id)
const subscriptionIds = async () => (await env.DB.prepare('SELECT id FROM subscriptions').all<{ id: string }>()).results.map((r) => r.id)
const run = (bindings: Record<string, unknown> = {}, now = NOW) => runScheduler({ ...env, ...bindings } as unknown as Cloudflare.Env, now)
const ok = () => new Response(null, { status: 201 })
const status = (s: number) => () => new Response(null, { status: s })
const spyOnConsole = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))

describe('a run with nothing due', () => {
  it('costs one database query, writes nothing, and sends nothing', async () => {
    const account = await registerBrowser()
    await alertFor(account, -5) // due in five minutes: not yet
    await alertFor(account, -60 * 24) // tomorrow
    const push = mockPushService()
    const { tally, env: counting } = countDb(env.DB)

    const counts = await runScheduler(counting, NOW)

    expect(counts).toEqual({ due: 0, sent: 0, failed: 0, expired: 0, gone: 0 })
    expect(tally.sql).toEqual([DUE_SQL]) // exactly one query, and it is the read
    expect(tally.rowsWritten).toBe(0)
    expect(push.calls).toHaveLength(0)
    expect(await remainingAlerts()).toHaveLength(2)
  })

  it('does the same with an empty database', async () => {
    const { tally, env: counting } = countDb(env.DB)
    await runScheduler(counting, NOW)
    expect(tally.sql).toHaveLength(1)
    expect(tally.rowsWritten).toBe(0)
  })

  it('does not even set up the push keys (no crypto) when there is nothing to send', async () => {
    const push = mockPushService()
    const counts = await run({ VAPID_PRIVATE_KEY: undefined })
    expect(counts.failed).toBe(0) // a missing key only matters once something is due
    expect(push.calls).toHaveLength(0)
  })

  it('reads through the index on unsent alerts for both halves of the query, with no sort', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${DUE_SQL}`).bind(0, 1, 2, 3).all<{ detail: string }>()
    const details = plan.results.map((r) => r.detail)
    expect(details.filter((d) => d.includes('SEARCH a USING INDEX idx_alerts_due'))).toHaveLength(2)
    expect(details.some((d) => /SCAN a\b/.test(d) && !d.includes('USING INDEX'))).toBe(false) // never a full table scan
    expect(details.some((d) => d.includes('TEMP B-TREE'))).toBe(false)
  })
})

describe('sending a due alert', () => {
  it('pushes {title, body, tag}, then deletes the alert', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1, 'London opens', 'in 15 minutes')
    const push = mockPushService(ok)

    const counts = await run()

    expect(counts).toEqual({ due: 1, sent: 1, failed: 0, expired: 0, gone: 0 })
    expect(push.calls).toHaveLength(1)
    expect(push.calls[0]!.url).toBe(account.endpoint)
    expect(JSON.parse(new TextDecoder().decode(await account.browser.decrypt(push.calls[0]!.body)))).toEqual({
      title: 'London opens',
      body: 'in 15 minutes',
      tag: `alert-${id}`,
    })
    expect(await remainingAlerts()).toEqual([])
    expect(await subscriptionIds()).toEqual([account.id])
  })

  it('signs the push with the VAPID key and marks it urgent', async () => {
    const account = await registerBrowser()
    await alertFor(account, 0)
    const push = mockPushService(ok)
    await run()
    const call = push.calls[0]!
    const vapid = await verifyVapidHeader(call.headers.get('authorization')!, env.VAPID_PUBLIC_KEY)
    expect(vapid.claims.aud).toBe(new URL(account.endpoint).origin)
    expect(call.headers.get('urgency')).toBe('high')
    expect(call.headers.get('content-encoding')).toBe('aes128gcm')
  })

  it('gives the alert its own tag, and the same one on every delivery of it, in the payload and as the push Topic', async () => {
    const account = await registerBrowser()
    const first = await alertFor(account, 2, 'A')
    const second = await alertFor(account, 1, 'B')
    const outcomes = [status(500), ok, ok] // A fails once and is retried; B succeeds
    const push = mockPushService(() => outcomes.shift()!())
    await run() // sends A (500) and B (ok) in the same run
    await run() // retries A
    const tags = await Promise.all(push.calls.map(async (c) => JSON.parse(new TextDecoder().decode(await account.browser.decrypt(c.body))).tag))

    expect(alertTag(first)).toBe(`alert-${first}`)
    expect(tags.sort()).toEqual([`alert-${first}`, `alert-${first}`, `alert-${second}`].sort()) // A twice, with the same tag
    expect(new Set(push.calls.map((c) => c.headers.get('topic')))).toEqual(new Set([`alert-${first}`, `alert-${second}`]))
    for (const call of push.calls) expect(call.headers.get('topic')).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(tags.filter((t) => t === `alert-${first}`)).toHaveLength(2)
  })

  it('never sends anything but title, body and tag', async () => {
    const account = await registerBrowser()
    await alertFor(account, 0)
    const push = mockPushService(ok)
    await run()
    const payload = JSON.parse(new TextDecoder().decode(await account.browser.decrypt(push.calls[0]!.body)))
    expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title'])
  })

  it('tells the push service to drop it once it would count as too late: the TTL is what is left of the 10 minutes', async () => {
    const account = await registerBrowser()
    await alertFor(account, 0) // due now: 600 s left
    await alertFor(account, 4) // 4 minutes late: 360 s left
    await alertFor(account, 9.99) // 9 min 59.4 s late: 0.6 s left, never less than 1
    const push = mockPushService(ok)
    await run({ MAX_PUSHES_PER_RUN: '10' })
    expect(push.calls.map((c) => c.headers.get('ttl')).sort((a, b) => Number(b) - Number(a))).toEqual(['600', '360', '1'])
  })

  it('deletes with one query per alert and never marks anything as sent', async () => {
    const account = await registerBrowser()
    await alertFor(account, 2)
    await alertFor(account, 1)
    mockPushService(ok)
    const { tally, env: counting } = countDb(env.DB)
    await runScheduler(counting, NOW)
    expect(tally.sql).toEqual([DUE_SQL, 'DELETE FROM alerts WHERE id = ?', 'DELETE FROM alerts WHERE id = ?'])
    expect(tally.sql.some((q) => /UPDATE|sent_at\s*=/i.test(q))).toBe(false)
    expect(await count('alerts')).toBe(0)
  })

  it('an alert due exactly now is sent; one due a moment later is not', async () => {
    const account = await registerBrowser()
    const exact = await alertFor(account, 0)
    const later = await alertFor(account, -1 / 60000) // one millisecond from now
    const push = mockPushService(ok)
    await run()
    expect(push.calls).toHaveLength(1)
    expect(await remainingAlerts()).toEqual([later])
    expect(exact).not.toBe(later)
  })

  it('leaves other people’s alerts, and alerts not yet due, alone', async () => {
    const a = await registerBrowser()
    const b = await registerBrowser()
    await alertFor(a, 1)
    const bFuture = await alertFor(b, -30)
    mockPushService(ok)
    await run()
    expect(await remainingAlerts()).toEqual([bFuture])
    expect(new Set(await subscriptionIds())).toEqual(new Set([a.id, b.id]))
  })
})

describe('batching and carry-over', () => {
  it('sends at most 3 a run by default, oldest first, and carries the rest over to the next runs', async () => {
    const account = await registerBrowser()
    const ids: number[] = []
    for (let i = 0; i < 8; i++) ids.push(await alertFor(account, 8 - i, `Alert ${i}`)) // Alert 0 is the oldest
    const push = mockPushService(ok)
    const titles = async (calls: typeof push.calls) =>
      Promise.all(calls.map(async (c) => JSON.parse(new TextDecoder().decode(await account.browser.decrypt(c.body))).title))

    const first = await run()
    expect(first).toMatchObject({ due: 3, sent: 3 })
    expect(await titles(push.calls)).toEqual(expect.arrayContaining(['Alert 0', 'Alert 1', 'Alert 2']))
    expect(await remainingAlerts()).toEqual(ids.slice(3))

    const before = push.calls.length
    expect(await run()).toMatchObject({ due: 3, sent: 3 })
    expect(await titles(push.calls.slice(before))).toEqual(expect.arrayContaining(['Alert 3', 'Alert 4', 'Alert 5']))
    expect(await remainingAlerts()).toEqual(ids.slice(6))

    expect(await run()).toMatchObject({ due: 2, sent: 2 })
    expect(await remainingAlerts()).toEqual([])
    expect(push.calls).toHaveLength(8)
    expect(await run()).toMatchObject({ due: 0 })
    expect(push.calls).toHaveLength(8) // nothing is sent twice
  })

  it('takes the oldest first whichever order they were created in, across subscriptions', async () => {
    const a = await registerBrowser()
    const b = await registerBrowser()
    const newest = await alertFor(a, 1)
    const oldest = await alertFor(b, 9)
    const middle = await alertFor(a, 5)
    const spare = await alertFor(b, 3)
    mockPushService(ok)
    await run({ MAX_PUSHES_PER_RUN: '3' })
    expect(await remainingAlerts()).toEqual([newest]) // the three oldest went
    expect([oldest, middle, spare]).not.toContain(newest)
  })

  it('never sends more than the batch size, however many are due', async () => {
    const account = await registerBrowser()
    for (let i = 0; i < 40; i++) await alertFor(account, 1 + i / 100)
    const push = mockPushService(ok)
    await run()
    expect(push.calls).toHaveLength(3)
    expect(await count('alerts')).toBe(37)
  })

  it('MAX_PUSHES_PER_RUN sets the batch size', async () => {
    const account = await registerBrowser()
    for (let i = 0; i < 12; i++) await alertFor(account, 1 + i / 100)
    const push = mockPushService(ok)
    await run({ MAX_PUSHES_PER_RUN: '5' })
    expect(push.calls).toHaveLength(5)
  })

  it.each([
    [undefined, 3],
    ['', 3],
    ['abc', 3],
    ['0', 3],
    ['-4', 3],
    ['NaN', 3],
    ['1', 1],
    ['7', 7],
    [' 7 ', 7],
    ['20', 20],
    ['21', 20],
    ['9999', 20],
  ])('reads MAX_PUSHES_PER_RUN=%j as %i', (value, expected) => {
    expect(pushesPerRun({ MAX_PUSHES_PER_RUN: value })).toBe(expected)
  })

  it('the configured value in wrangler.jsonc is the default the code assumes', () => {
    expect(wranglerConfig).toMatch(/"MAX_PUSHES_PER_RUN":\s*"3"/)
  })

  it('stays inside 50 queries and requests even at the highest batch size, in the worst mix', async () => {
    // 20 on time and all sent: 1 read + 20 deletes + 20 pushes. Plus the expired ones: 1 more delete.
    const account = await registerBrowser()
    for (let i = 0; i < 20; i++) await alertFor(account, 1 + i / 100)
    for (let i = 0; i < EXPIRED_PER_RUN; i++) await alertFor(account, 30 + i)
    const push = mockPushService(ok)
    const { tally, env: counting } = countDb(env.DB)
    await runScheduler({ ...counting, MAX_PUSHES_PER_RUN: '999' } as unknown as Cloudflare.Env, NOW)
    expect(push.calls).toHaveLength(20)
    expect(tally.sql.length + push.calls.length).toBeLessThanOrEqual(50)
    expect(tally.sql.length + push.calls.length).toBe(1 + 1 + 20 + 20)
  })

  it('stays inside it when every push finds a dead subscription, too', async () => {
    const accounts = await Promise.all(Array.from({ length: 20 }, () => registerBrowser()))
    for (const [i, account] of accounts.entries()) await alertFor(account, 1 + i / 100)
    const push = mockPushService(status(410))
    const { tally, env: counting } = countDb(env.DB)
    await runScheduler({ ...counting, MAX_PUSHES_PER_RUN: '20' } as unknown as Cloudflare.Env, NOW)
    expect(tally.sql.length + push.calls.length).toBe(1 + 20 + 20)
    expect(tally.sql.length + push.calls.length).toBeLessThanOrEqual(50)
  })
})

describe('the 10-minute rule', () => {
  it('sends an alert that is exactly 10 minutes late', async () => {
    const account = await registerBrowser()
    await alertFor(account, LATE_LIMIT_MS / MIN)
    const push = mockPushService(ok)
    expect(await run()).toMatchObject({ sent: 1, expired: 0 })
    expect(push.calls).toHaveLength(1)
  })

  it('skips and deletes an alert even a millisecond later than that, without a push', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, LATE_LIMIT_MS / MIN + 1 / 60000)
    const push = mockPushService(ok)
    const counts = await run()
    expect(counts).toEqual({ due: 1, sent: 0, failed: 0, expired: 1, gone: 0 })
    expect(push.calls).toHaveLength(0)
    expect(await remainingAlerts()).not.toContain(id)
    expect(await subscriptionIds()).toEqual([account.id]) // the subscription stays
  })

  it('deletes all the late ones with one query, and still sends the on-time ones in the same run', async () => {
    const account = await registerBrowser()
    for (let i = 0; i < 5; i++) await alertFor(account, 30 + i)
    const fresh = [await alertFor(account, 2), await alertFor(account, 1), await alertFor(account, 0)]
    const push = mockPushService(ok)
    const { tally, env: counting } = countDb(env.DB)
    const counts = await runScheduler(counting, NOW)
    expect(counts).toEqual({ due: 8, sent: 3, failed: 0, expired: 5, gone: 0 })
    expect(push.calls).toHaveLength(3)
    expect(tally.sql.filter((q) => q.startsWith('DELETE FROM alerts WHERE id IN'))).toHaveLength(1)
    expect(await remainingAlerts()).toEqual([])
    expect(fresh).toHaveLength(3)
  })

  it('late ones never crowd out the on-time ones, however many there are', async () => {
    const account = await registerBrowser()
    for (let i = 0; i < 60; i++) await alertFor(account, 20 + i)
    for (let i = 0; i < 3; i++) await alertFor(account, 1 + i / 10)
    const push = mockPushService(ok)
    const counts = await run()
    expect(counts.sent).toBe(3) // the three on-time alerts went out at once
    expect(push.calls).toHaveLength(3)
  })

  it('clears a backlog of late ones steadily, at most 20 a run', async () => {
    const account = await registerBrowser()
    for (let i = 0; i < 50; i++) await alertFor(account, 30 + i)
    mockPushService(ok)
    expect((await run()).expired).toBe(EXPIRED_PER_RUN)
    expect(await count('alerts')).toBe(30)
    expect((await run()).expired).toBe(20)
    expect((await run()).expired).toBe(10)
    expect(await count('alerts')).toBe(0)
  })

  it('deletes late ones even when push is not set up, since that needs no push', async () => {
    const account = await registerBrowser()
    await alertFor(account, 60)
    expect(await run({ VAPID_PRIVATE_KEY: undefined })).toMatchObject({ expired: 1, failed: 0 })
    expect(await count('alerts')).toBe(0)
  })

  it('an alert that keeps failing is retried until it is 10 minutes late, then deleted unsent', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 0)
    const push = mockPushService(status(503))
    expect(await run({}, NOW)).toMatchObject({ failed: 1 })
    expect(await run({}, NOW + 5 * MIN)).toMatchObject({ failed: 1 })
    expect(await run({}, NOW + 10 * MIN)).toMatchObject({ failed: 1 }) // exactly 10 minutes late: still tried
    expect(await remainingAlerts()).toEqual([id])
    const sends = push.calls.length
    expect(await run({}, NOW + 10 * MIN + 1)).toMatchObject({ expired: 1, failed: 0 })
    expect(push.calls).toHaveLength(sends) // no push for the expired one
    expect(await remainingAlerts()).toEqual([])
  })
})

describe('subscriptions the push service says are gone', () => {
  it.each(GONE_STATUSES)('a %i deletes the subscription and every alert of it, due or not', async (code) => {
    const dead = await registerBrowser()
    const alive = await registerBrowser()
    await alertFor(dead, 1)
    await alertFor(dead, -60) // not due yet
    await alertFor(dead, -60 * 24)
    const kept = await alertFor(alive, -30)
    mockPushService((call) => (call.url === dead.endpoint ? new Response(null, { status: code }) : ok()))

    const counts = await run()

    expect(counts).toEqual({ due: 1, sent: 0, failed: 0, expired: 0, gone: 1 })
    expect(await subscriptionIds()).toEqual([alive.id])
    expect(await remainingAlerts()).toEqual([kept])
  })

  it('sends to the live ones in the same run and counts each outcome', async () => {
    const dead = await registerBrowser()
    const alive = await registerBrowser()
    await alertFor(dead, 3)
    await alertFor(alive, 2)
    const push = mockPushService((call) => (call.url === dead.endpoint ? new Response(null, { status: 410 }) : ok()))
    expect(await run()).toMatchObject({ sent: 1, gone: 1 })
    expect(push.calls).toHaveLength(2)
  })

  it('several due alerts for one dead subscription delete it once, and each is counted', async () => {
    const dead = await registerBrowser()
    await alertFor(dead, 3)
    await alertFor(dead, 2)
    await alertFor(dead, 1)
    mockPushService(status(410))
    const { tally, env: counting } = countDb(env.DB)
    const counts = await runScheduler(counting, NOW)
    expect(counts).toMatchObject({ due: 3, gone: 3, sent: 0, failed: 0 })
    expect(tally.sql.filter((q) => q === 'DELETE FROM subscriptions WHERE id = ?')).toHaveLength(1)
    expect(await count('subscriptions')).toBe(0)
    expect(await count('alerts')).toBe(0)
  })

  it('a subscription that can never receive (not on a push service, or with unusable keys) is retried, not deleted', async () => {
    const strange = await registerBrowser()
    const broken = await registerBrowser()
    await env.DB.prepare('UPDATE subscriptions SET endpoint = ? WHERE id = ?').bind('https://example.com/not-a-push-service', strange.id).run()
    await env.DB.prepare('UPDATE subscriptions SET p256dh = ? WHERE id = ?').bind('B'.repeat(87), broken.id).run()
    await alertFor(strange, 1)
    await alertFor(broken, 1)
    const push = mockPushService(ok)
    expect(await run()).toMatchObject({ due: 2, sent: 0, failed: 2, gone: 0 })
    expect(push.calls).toHaveLength(0) // neither was sent anywhere
    expect(await count('subscriptions')).toBe(2)
    expect(await count('alerts')).toBe(2)
  })
})

describe('failures are retried', () => {
  it.each([
    ['400', status(400)],
    ['401', status(401)],
    ['403', status(403)],
    ['413', status(413)],
    ['429', status(429)],
    ['500', status(500)],
    ['502', status(502)],
    ['503', status(503)],
    ['a redirect', status(302)],
    ['a network error', () => new TypeError('network connection lost')],
    ['a timeout', () => new DOMException('timed out', 'TimeoutError')],
  ] as Array<[string, () => Response | Error]>)('after %s the alert stays, and so does the subscription', async (_name, respond) => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1)
    mockPushService(respond)
    expect(await run()).toEqual({ due: 1, sent: 0, failed: 1, expired: 0, gone: 0 })
    expect(await remainingAlerts()).toEqual([id])
    expect(await subscriptionIds()).toEqual([account.id])
  })

  it('the next run sends it, and then deletes it', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1)
    const outcomes = [status(503), ok]
    const push = mockPushService(() => outcomes.shift()!())
    expect(await run()).toMatchObject({ failed: 1, sent: 0 })
    expect(await remainingAlerts()).toEqual([id])
    expect(await run()).toMatchObject({ failed: 0, sent: 1 })
    expect(await remainingAlerts()).toEqual([])
    expect(push.calls).toHaveLength(2)
    expect(await run()).toMatchObject({ due: 0 })
    expect(push.calls).toHaveLength(2) // and never again
  })

  it('a failed alert does not hold back the others in the same batch', async () => {
    const good = await registerBrowser()
    const bad = await registerBrowser()
    const failing = await alertFor(bad, 3)
    await alertFor(good, 2)
    await alertFor(good, 1)
    mockPushService((call) => (call.url === bad.endpoint ? new Response(null, { status: 503 }) : ok()))
    expect(await run()).toMatchObject({ sent: 2, failed: 1 })
    expect(await remainingAlerts()).toEqual([failing])
  })

  it('known limitation: alerts that keep failing at the front of the queue hold back newer ones until they expire', async () => {
    const bad = await registerBrowser()
    const good = await registerBrowser()
    for (let i = 0; i < 3; i++) await alertFor(bad, 5 + i) // the three oldest
    const waiting = await alertFor(good, 1)
    const push = mockPushService((call) => (call.url === bad.endpoint ? new Response(null, { status: 503 }) : ok()))
    expect(await run()).toMatchObject({ due: 3, failed: 3, sent: 0 })
    expect(push.calls.every((c) => c.url === bad.endpoint)).toBe(true)
    expect(await remainingAlerts()).toContain(waiting) // still waiting behind them
  })

  it('counts a missing or mismatched private key as failures and deletes nothing', async () => {
    const account = await registerBrowser()
    await alertFor(account, 1)
    const push = mockPushService(ok)
    expect(await run({ VAPID_PRIVATE_KEY: undefined })).toMatchObject({ due: 1, failed: 1, sent: 0 })
    expect(push.calls).toHaveLength(0)
    expect(await count('alerts')).toBe(1)
  })
})

describe('a mixed run adds up', () => {
  it('every due alert ends as exactly one of sent, failed, expired or gone', async () => {
    const [okAcc, failAcc, goneAcc] = [await registerBrowser(), await registerBrowser(), await registerBrowser()]
    await alertFor(okAcc, 4)
    await alertFor(failAcc, 3)
    await alertFor(goneAcc, 2)
    await alertFor(okAcc, 40) // late
    await alertFor(okAcc, 50) // late
    mockPushService((call) => (call.url === failAcc.endpoint ? new Response(null, { status: 500 }) : call.url === goneAcc.endpoint ? new Response(null, { status: 404 }) : ok()))
    const counts = await run()
    expect(counts).toEqual({ due: 5, sent: 1, failed: 1, expired: 2, gone: 1 })
    expect(counts.due).toBe(counts.sent + counts.failed + counts.expired + counts.gone)
  })
})

describe('the daily clean-up', () => {
  const setLastSeen = (id: string, ms: number) => env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(ms, id).run()

  it('deletes subscriptions not seen for 30 days, with their alerts, and keeps the rest', async () => {
    const stale = await registerBrowser()
    const justStale = await registerBrowser()
    const edge = await registerBrowser()
    const recent = await registerBrowser()
    const fresh = await registerBrowser()
    await setLastSeen(stale.id, NOW - 90 * DAY)
    await setLastSeen(justStale.id, NOW - 30 * DAY - 1)
    await setLastSeen(edge.id, NOW - 30 * DAY) // exactly 30 days: not yet
    await setLastSeen(recent.id, NOW - 29 * DAY)
    await alertFor(stale, -60)
    await alertFor(stale, -120)
    const keep = await alertFor(recent, -60)

    const counts = await runMaintenance(env, NOW)

    expect(counts.staleSubscriptions).toBe(2)
    expect(new Set(await subscriptionIds())).toEqual(new Set([edge.id, recent.id, fresh.id]))
    expect(await remainingAlerts()).toEqual([keep]) // the stale ones' alerts went with them
  })

  it('a subscription that was seen again (any upload refreshes last_seen_at) is kept', async () => {
    const account = await registerBrowser()
    await setLastSeen(account.id, NOW - 60 * DAY)
    await setLastSeen(account.id, NOW - 1 * DAY)
    await runMaintenance(env, NOW)
    expect(await subscriptionIds()).toEqual([account.id])
  })

  it('also runs the existing clean-up of old sent alerts', async () => {
    const account = await registerBrowser()
    const insert = env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body, sent_at) VALUES (?, ?, ?, ?, ?)')
    await env.DB.batch([
      insert.bind(account.id, NOW - 3 * DAY, 'old sent', '', NOW - 3 * DAY),
      insert.bind(account.id, NOW - 3600_000, 'recent sent', '', NOW - 3600_000),
      insert.bind(account.id, NOW + DAY, 'upcoming', '', null),
    ])
    expect((await runMaintenance(env, NOW)).sentAlerts).toBe(1)
    const titles = (await env.DB.prepare('SELECT title FROM alerts ORDER BY title').all<{ title: string }>()).results.map((r) => r.title)
    expect(titles).toEqual(['recent sent', 'upcoming'])
  })

  it(`deletes at most ${STALE_SUBSCRIPTIONS_PER_RUN} stale subscriptions a day, so a large backlog cannot use up the day's writes`, async () => {
    const insert = env.DB.prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    await env.DB.batch(Array.from({ length: 250 }, (_, i) => insert.bind(`old-${i}`, `https://fcm.googleapis.com/old-${i}`, 'p', 'a', 'h', 1, NOW - 60 * DAY)))
    expect((await runMaintenance(env, NOW)).staleSubscriptions).toBe(STALE_SUBSCRIPTIONS_PER_RUN)
    expect(await count('subscriptions')).toBe(250 - STALE_SUBSCRIPTIONS_PER_RUN)
    expect((await runMaintenance(env, NOW)).staleSubscriptions).toBe(50)
    expect(await count('subscriptions')).toBe(0)
  })

  it('makes two queries, sends no push, and leaves due alerts for the minute run', async () => {
    const account = await registerBrowser()
    const dueId = await alertFor(account, 1)
    const push = mockPushService(ok)
    const { tally, env: counting } = countDb(env.DB)
    await runMaintenance(counting, NOW)
    expect(tally.sql).toHaveLength(2)
    expect(push.calls).toHaveLength(0)
    expect(await remainingAlerts()).toEqual([dueId])
  })

  it('uses a cron entry that exists in wrangler.jsonc, next to the every-minute one', () => {
    expect(DAILY_CRON).toBe('17 3 * * *')
    expect(wranglerConfig).toContain(`"crons": ["* * * * *", "${DAILY_CRON}"]`)
  })
})

describe('the cron entry point', () => {
  it('the every-minute cron sends due alerts, and does not do the daily clean-up', async () => {
    const account = await registerBrowser()
    const stale = await registerBrowser()
    await env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(Date.now() - 90 * DAY, stale.id).run()
    await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)').bind(account.id, Date.now() - MIN, 'Due', 'now').run()
    const push = mockPushService(ok)
    spyOnConsole()
    await runCron('* * * * *')
    expect(push.calls).toHaveLength(1)
    expect(await count('alerts')).toBe(0)
    expect(new Set(await subscriptionIds())).toEqual(new Set([account.id, stale.id])) // the stale one is still there
  })

  it('the daily cron cleans up, and does not send', async () => {
    const account = await registerBrowser()
    const stale = await registerBrowser()
    await env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(Date.now() - 90 * DAY, stale.id).run()
    await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)').bind(account.id, Date.now() - MIN, 'Due', 'now').run()
    const push = mockPushService(ok)
    spyOnConsole()
    await runCron(DAILY_CRON)
    expect(push.calls).toHaveLength(0)
    expect(await count('alerts')).toBe(1)
    expect(await subscriptionIds()).toEqual([account.id])
  })

  it('has both a fetch and a scheduled handler, and the cron triggers are declared', async () => {
    const worker = (await import('../src/index')).default
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
    expect(wranglerConfig).toContain('"crons"')
  })
})

describe('logging', () => {
  it('writes exactly one line per run, with counts only', async () => {
    const account = await registerBrowser()
    await alertFor(account, 1)
    mockPushService(ok)
    const [log, ...others] = spyOnConsole()
    await runCron('* * * * *')
    expect(log!.mock.calls).toEqual([['scheduler run: due=1 sent=1 failed=0 expired=0 gone=0']])
    for (const spy of others) expect(spy).not.toHaveBeenCalled()
  })

  it('even a run with nothing due writes its line', async () => {
    const [log] = spyOnConsole()
    await runCron('* * * * *')
    expect(log!.mock.calls).toEqual([['scheduler run: due=0 sent=0 failed=0 expired=0 gone=0']])
  })

  it('the daily clean-up writes one line, with counts only', async () => {
    const [log] = spyOnConsole()
    await runCron(DAILY_CRON)
    expect(log!.mock.calls).toEqual([['daily clean-up: old_sent_alerts_deleted=0 stale_subscriptions_deleted=0']])
  })

  it('formats counts as numbers only', () => {
    expect(formatRun({ due: 5, sent: 1, failed: 1, expired: 2, gone: 1 })).toBe('scheduler run: due=5 sent=1 failed=1 expired=2 gone=1')
  })

  it('never writes an endpoint, key, secret, tag or notification text, whatever happens in the run', async () => {
    const sensitive: string[] = []
    const mix = [status(201), status(500), status(410), () => new TypeError('network error')]
    for (const respond of mix) {
      const account = await registerBrowser()
      const id = await alertFor(account, 1, 'Secret title', 'Secret body text')
      sensitive.push(account.endpoint, account.browser.subscription.keys.p256dh, account.browser.subscription.keys.auth, account.secret, account.id, `alert-${id}`)
      const outcomes = new Map([[account.endpoint, respond]])
      mockPushService((call) => (outcomes.get(call.url) ?? ok)())
      const spies = spyOnConsole()
      await runCron('* * * * *')
      const output = JSON.stringify(spies.flatMap((s) => s.mock.calls))
      for (const value of ['Secret title', 'Secret body text', env.VAPID_PRIVATE_KEY!, ...sensitive]) expect(output).not.toContain(value)
      vi.restoreAllMocks()
    }
  })

  it('on an unexpected failure logs only the kind of error, never the message, and rethrows so the run counts as failed', async () => {
    const account = await registerBrowser()
    const brokenDb = {
      prepare: () => {
        throw new Error(`boom ${account.endpoint} ${account.secret}`)
      },
    }
    const [log, , , error] = spyOnConsole()
    await expect(runCron('* * * * *', { DB: brokenDb })).rejects.toThrow()
    expect(error!.mock.calls).toEqual([['scheduler failed:', 'Error']])
    expect(log!.mock.calls).toEqual([])
    expect(JSON.stringify(error!.mock.calls)).not.toContain(account.endpoint)
  })
})
