import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DAILY_ALERT_CHANGES as CAP } from '../src/constants'
import { DAY, MIN, alertRows, measured, register, resetDb, schedule } from './helpers'

beforeEach(resetDb)
afterEach(() => vi.useRealTimers())

const utcDay = (ms: number) => Math.floor(ms / DAY)
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i

// n distinct alerts at fixed times, so asking twice gives the same alerts.
const BASE = Date.now()
const alerts = (n: number, from = 0, tag = 'a') =>
  Array.from({ length: n }, (_, i) => ({ fireAt: new Date(BASE + (from + i + 1) * MIN).toISOString(), title: `${tag}${from + i}`, body: 'x' }))

/** Pretend this subscription has already had `count` alerts changed on UTC day `day`. */
const setUsed = (id: string, count: number, day = utcDay(Date.now())) =>
  env.DB.prepare('UPDATE subscriptions SET changes_day = ?, changes_count = ? WHERE id = ?').bind(day, count, id).run()
const counter = (id: string) =>
  env.DB.prepare('SELECT changes_day AS day, changes_count AS count FROM subscriptions WHERE id = ?').bind(id).first<{ day: number; count: number }>()

describe('counting', () => {
  it('counts alerts added, and alerts added + removed, for the UTC day', async () => {
    const { id, secret } = await register()
    expect(await counter(id)).toEqual({ day: 0, count: 0 }) // a fresh subscription has used nothing

    await schedule(id, secret, alerts(100))
    expect(await counter(id)).toEqual({ day: utcDay(Date.now()), count: 100 })

    // Swap 30 alerts for 30 others: 30 removed + 30 added.
    await schedule(id, secret, [...alerts(70), ...alerts(30, 100, 'b')])
    expect(await counter(id)).toEqual({ day: utcDay(Date.now()), count: 160 })
  })

  it('adds nothing to the rows a changing upload already writes', async () => {
    const { id, secret } = await register()
    const { res, rowsWritten, sql } = await measured('PUT', '/schedule', { id, secret, alerts: alerts(60) })
    expect(res.status).toBe(200)
    // 60 alerts x 3 rows, 1 for the insert statement, 1 for the subscription row (which now also holds the counter).
    expect(rowsWritten).toBeGreaterThanOrEqual(60 * 3)
    expect(rowsWritten).toBeLessThanOrEqual(60 * 3 + 2)
    expect(sql.filter((q) => /UPDATE subscriptions/i.test(q))).toHaveLength(1)
  })

  it('unchanged uploads cost nothing and are not counted', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, alerts(50))
    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: alerts(50) })
    expect(await res.json()).toMatchObject({ unchanged: true })
    expect(rowsWritten).toBe(0)
    expect((await counter(id))!.count).toBe(50)
  })

  it('is per subscription', async () => {
    const a = await register()
    const b = await register()
    await setUsed(a.id, CAP)
    expect((await schedule(a.id, a.secret, alerts(1))).status).toBe(429)
    expect((await schedule(b.id, b.secret, alerts(1))).status).toBe(200)
  })
})

describe(`the cap of ${CAP} changes a day`, () => {
  it('allows an upload that brings the day to exactly the cap', async () => {
    const { id, secret } = await register()
    await setUsed(id, CAP - 1)
    const res = await schedule(id, secret, alerts(1))
    expect(res.status).toBe(200)
    expect((await counter(id))!.count).toBe(CAP)
  })

  it('allows a first upload of exactly the cap', async () => {
    const { id, secret } = await register()
    const res = await schedule(id, secret, alerts(CAP))
    expect(res.status).toBe(200)
    expect((await counter(id))!.count).toBe(CAP)
    expect((await alertRows(id)).results).toHaveLength(CAP)
  })

  it('rejects an upload that goes one over, with 429, Retry-After until 00:00 UTC, and a clear error', async () => {
    const { id, secret } = await register()
    await setUsed(id, CAP - 1)
    const res = await schedule(id, secret, alerts(2))
    expect(res.status).toBe(429)

    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(86_400)
    const resetAt = new Date(Date.now() + retryAfter * 1000)
    expect([resetAt.getUTCHours(), resetAt.getUTCMinutes()]).toEqual([0, 0])

    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe(
      `Daily limit of ${CAP} alert changes reached for this subscription (${CAP - 1} used today, this upload needs 2); try again after 00:00 UTC`,
    )
  })

  it('counts removals too: at the cap, deleting alerts is refused as well', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, alerts(10))
    await setUsed(id, CAP - 1)
    const res = await schedule(id, secret, alerts(8)) // removes 2
    expect(res.status).toBe(429)
    expect((await alertRows(id)).results).toHaveLength(10)
  })

  it('a rejected upload writes nothing: 0 rows, no write statements, schedule and counter untouched', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, alerts(20))
    await setUsed(id, CAP)
    const before = (await alertRows(id)).results
    const hashBefore = await env.DB.prepare('SELECT schedule_hash FROM subscriptions WHERE id = ?').bind(id).first()

    const { res, rowsWritten, sql } = await measured('PUT', '/schedule', { id, secret, alerts: alerts(30, 5, 'z') })
    expect(res.status).toBe(429)
    expect(rowsWritten).toBe(0)
    expect(sql.filter((q) => WRITE_SQL.test(q))).toEqual([])
    expect((await alertRows(id)).results).toEqual(before)
    expect(await env.DB.prepare('SELECT schedule_hash FROM subscriptions WHERE id = ?').bind(id).first()).toEqual(hashBefore)
    expect(await counter(id)).toEqual({ day: utcDay(Date.now()), count: CAP })
  })

  it('at the cap, re-sending the stored schedule still works and still costs nothing', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, alerts(20))
    await setUsed(id, CAP)
    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: alerts(20) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ unchanged: true })
    expect(rowsWritten).toBe(0)
  })

  it('an upload that changes more than the cap on its own can never fit, so it gets a 400, not a "try later"', async () => {
    const { id, secret } = await register()
    const res = await schedule(id, secret, alerts(CAP + 1))
    expect(res.status).toBe(400)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(((await res.json()) as { error: string }).error).toContain(`at most ${CAP} alerts per UTC day`)
    expect((await alertRows(id)).results).toHaveLength(0)
    expect((await counter(id))!.count).toBe(0)
  })

  it('does not count an upload that lost a race (409)', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, alerts(5))
    const race = async () => {
      await env.DB.prepare("UPDATE subscriptions SET schedule_hash = 'someone-else' WHERE id = ?").bind(id).run()
    }
    const { res } = await measured('PUT', '/schedule', { id, secret, alerts: alerts(50) }, race)
    expect(res.status).toBe(409)
    expect((await counter(id))!.count).toBe(5)
  })
})

describe('the reset at 00:00 UTC', () => {
  it("a count from an earlier UTC day doesn't count today, and starts over from this upload", async () => {
    const { id, secret } = await register()
    await setUsed(id, CAP, utcDay(Date.now()) - 1)
    const res = await schedule(id, secret, alerts(25))
    expect(res.status).toBe(200)
    expect(await counter(id)).toEqual({ day: utcDay(Date.now()), count: 25 }) // 25, not 400 + 25
  })

  it('refuses at 23:59:59.999 UTC and accepts at 00:00:00.000 the next day', async () => {
    const { id, secret } = await register()
    vi.useFakeTimers({ toFake: ['Date'] })

    vi.setSystemTime(new Date('2026-10-14T23:59:59.999Z'))
    await setUsed(id, CAP, utcDay(Date.now()))
    const refused = await schedule(id, secret, [{ fireAt: new Date(Date.now() + MIN).toISOString(), title: 't', body: '' }])
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1') // one millisecond left rounds up to a second

    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'))
    const accepted = await schedule(id, secret, [{ fireAt: new Date(Date.now() + MIN).toISOString(), title: 't', body: '' }])
    expect(accepted.status).toBe(200)
    expect(await counter(id)).toEqual({ day: utcDay(Date.parse('2026-10-15T00:00:00Z')), count: 1 })
  })

  it.each([
    ['2026-10-14T00:00:00.000Z', 86_400],
    ['2026-10-14T12:00:00.000Z', 43_200],
    ['2026-10-14T23:00:00.000Z', 3_600],
    ['2026-10-14T23:59:30.000Z', 30],
    ['2026-12-31T23:59:59.000Z', 1],
  ])('Retry-After at %s is %i seconds', async (now, seconds) => {
    const { id, secret } = await register()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    await setUsed(id, CAP, utcDay(Date.now()))
    const res = await schedule(id, secret, [{ fireAt: new Date(Date.now() + MIN).toISOString(), title: 't', body: '' }])
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe(String(seconds))
  })
})

describe('the migration is additive, so the Worker that is live while it applies keeps working', () => {
  it('only adds columns that have defaults', () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0004'))!
    // The migration reader gives one entry per statement; drop comment lines from each.
    const statements = migration.queries
      .map((q) =>
        q
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join(' ')
          .replace(/;\s*$/, '')
          .trim(),
      )
      .filter(Boolean)
    expect(statements).toHaveLength(2)
    for (const q of statements) expect(q).toMatch(/^ALTER TABLE subscriptions ADD COLUMN \w+ INTEGER NOT NULL DEFAULT 0$/)
  })

  it("the previous version's statements still work against the new schema", async () => {
    // Copied from the Worker that was deployed before this change.
    const insert = await env.DB.prepare(
      `INSERT INTO subscriptions (id, endpoint, p256dh, auth, secret_hash, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         secret_hash = excluded.secret_hash, last_seen_at = excluded.last_seen_at
       RETURNING id`,
    )
      .bind('old-worker-id', 'https://fcm.googleapis.com/old', 'p', 'a', 'h', Date.now())
      .first<{ id: string }>()
    expect(insert!.id).toBe('old-worker-id')
    const row = await env.DB.prepare('SELECT secret_hash, schedule_hash, last_seen_at FROM subscriptions WHERE id = ?').bind('old-worker-id').first()
    expect(row).toMatchObject({ secret_hash: 'h', schedule_hash: null })
    const update = await env.DB.prepare('UPDATE subscriptions SET schedule_hash = ?1, last_seen_at = ?2 WHERE id = ?3 AND schedule_hash IS ?4')
      .bind('x', Date.now(), 'old-worker-id', null)
      .run()
    expect(update.meta.changes).toBe(1)
    // ...and the new columns start out as a fresh allowance.
    expect(await counter('old-worker-id')).toEqual({ day: 0, count: 0 })
  })
})
