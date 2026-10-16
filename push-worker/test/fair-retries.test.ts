import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CANDIDATES_PER_PUSH, MAX_ATTEMPTS, MAX_PER_SUBSCRIPTION_PER_RUN } from '../src/constants'
import { DUE_SQL, runScheduler, type RunCounts } from '../src/scheduler'
import { MIN, countDb, count, resetDb, schedule, alertIn } from './helpers'
import { mockPushService, registerBrowser } from './webpush-helpers'

const NOW = Date.now()
type Account = Awaited<ReturnType<typeof registerBrowser>>

beforeEach(resetDb)
afterEach(() => vi.restoreAllMocks())

const counted = (c: Partial<RunCounts>): RunCounts => ({ due: 0, sent: 0, failed: 0, expired: 0, gone: 0, dropped: 0, skipped: 0, ...c })
const ok = () => new Response(null, { status: 201 })
const status = (s: number) => () => new Response(null, { status: s })

/** An alert that fell due `minutesLate` minutes before NOW, already tried `attempts` times. Returns its id. */
async function alertFor(account: Pick<Account, 'id'>, minutesLate: number, title = 'Alert', attempts = 0) {
  const row = await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body, attempts) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(account.id, NOW - minutesLate * MIN, title, 'body', attempts)
    .first<{ id: number }>()
  return row!.id
}
const attemptsOf = async (id: number) => (await env.DB.prepare('SELECT attempts FROM alerts WHERE id = ?').bind(id).first<{ attempts: number }>())?.attempts ?? null
const ids = async () => (await env.DB.prepare('SELECT id FROM alerts ORDER BY id').all<{ id: number }>()).results.map((r) => r.id)
const run = (bindings: Record<string, unknown> = {}, now = NOW) => runScheduler({ ...env, ...bindings } as unknown as Cloudflare.Env, now)
/** Which subscription's push this call was: the push service is told apart by endpoint. */
const respondBy = (rules: Map<string, () => Response | Error>) => (call: { url: string }) => (rules.get(call.url) ?? ok)()

describe('attempts: failures are counted and the third deletes the alert', () => {
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
  ] as Array<[string, () => Response | Error]>)('a failed push (%s) adds one to attempts and keeps the alert', async (_name, respond) => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1)
    mockPushService(respond)
    expect(await run()).toEqual(counted({ due: 1, failed: 1 }))
    expect(await attemptsOf(id)).toBe(1)
  })

  it('a subscription that is not on a push service, or has unusable keys, counts as failing too', async () => {
    const strange = await registerBrowser()
    const broken = await registerBrowser()
    await env.DB.prepare('UPDATE subscriptions SET endpoint = ? WHERE id = ?').bind('https://example.com/nope', strange.id).run()
    await env.DB.prepare('UPDATE subscriptions SET p256dh = ? WHERE id = ?').bind('B'.repeat(87), broken.id).run()
    const a = await alertFor(strange, 1)
    const b = await alertFor(broken, 1)
    mockPushService(ok)
    expect(await run()).toEqual(counted({ due: 2, failed: 2 }))
    expect([await attemptsOf(a), await attemptsOf(b)]).toEqual([1, 1])
  })

  it('404 and 410 are not failures: the subscription goes, and nothing is counted as failed', async () => {
    for (const code of [404, 410]) {
      const dead = await registerBrowser()
      const other = await registerBrowser()
      await alertFor(dead, 1)
      const kept = await alertFor(other, -30)
      mockPushService(respondBy(new Map([[dead.endpoint, status(code)]])))
      expect(await run()).toEqual(counted({ due: 1, gone: 1 }))
      expect(await attemptsOf(kept)).toBe(0)
      vi.restoreAllMocks()
      await resetDb()
    }
  })

  it('the third failed attempt deletes the alert instead of counting again, across three runs', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 0)
    const push = mockPushService(status(503))

    expect(await run({}, NOW)).toEqual(counted({ due: 1, failed: 1 }))
    expect(await attemptsOf(id)).toBe(1)
    expect(await run({}, NOW + 1 * MIN)).toEqual(counted({ due: 1, failed: 1 }))
    expect(await attemptsOf(id)).toBe(2)
    expect(MAX_ATTEMPTS).toBe(3)
    expect(await run({}, NOW + 2 * MIN)).toEqual(counted({ due: 1, failed: 1, dropped: 1 })) // third: deleted
    expect(await ids()).toEqual([])
    expect(push.calls).toHaveLength(3)

    expect(await run({}, NOW + 3 * MIN)).toEqual(counted({})) // and never tried again
    expect(push.calls).toHaveLength(3)
    expect(await count('subscriptions')).toBe(1) // the subscription itself stays
  })

  it('an alert that already failed twice is deleted by its next failure', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1, 'third strike', 2)
    mockPushService(status(500))
    expect(await run()).toEqual(counted({ due: 1, failed: 1, dropped: 1 }))
    expect(await ids()).not.toContain(id)
  })

  it('an alert that has failed once becomes 2, not deleted', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1, 'second strike', 1)
    mockPushService(status(500))
    expect(await run()).toEqual(counted({ due: 1, failed: 1 }))
    expect(await attemptsOf(id)).toBe(2)
  })

  it('an alert that finally succeeds is sent and deleted, whatever its attempts', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1, 'finally', 2)
    mockPushService(ok)
    expect(await run()).toEqual(counted({ due: 1, sent: 1 }))
    expect(await ids()).not.toContain(id)
  })

  it('a failed push costs one UPDATE and one row written; the third failure costs a DELETE instead', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1)
    mockPushService(status(503))
    const first = countDb(env.DB)
    await runScheduler(first.env, NOW)
    expect(first.tally.sql).toEqual([DUE_SQL, 'UPDATE alerts SET attempts = attempts + 1 WHERE id = ?'])
    expect(first.tally.rowsWritten).toBe(1)

    await env.DB.prepare('UPDATE alerts SET attempts = 2 WHERE id = ?').bind(id).run()
    const third = countDb(env.DB)
    await runScheduler(third.env, NOW)
    expect(third.tally.sql).toEqual([DUE_SQL, 'DELETE FROM alerts WHERE id = ?'])
  })

  it('attempts survive a schedule re-upload of an alert that did not change', async () => {
    const account = await registerBrowser()
    const keep = alertIn(60 * MIN, { title: 'kept' })
    await schedule(account.id, account.secret, [keep])
    const [{ id }] = (await env.DB.prepare('SELECT id FROM alerts').all<{ id: number }>()).results as [{ id: number }]
    await env.DB.prepare('UPDATE alerts SET attempts = 2 WHERE id = ?').bind(id).run()
    await schedule(account.id, account.secret, [keep, alertIn(120 * MIN, { title: 'new one' })]) // a changed schedule
    expect(await attemptsOf(id)).toBe(2) // the unchanged alert is the same row
    expect(await count('alerts')).toBe(2)
  })
})

describe('order: first attempts before retries, then oldest first', () => {
  const pushedTitles = async (push: ReturnType<typeof mockPushService>, accounts: Account[]) =>
    Promise.all(
      push.calls.map(async (call) => {
        const owner = accounts.find((a) => a.endpoint === call.url)!
        return JSON.parse(new TextDecoder().decode(await owner.browser.decrypt(call.body))).title as string
      }),
    )

  it('a retry that is older does not go before a newer alert that has never been tried', async () => {
    const a = await registerBrowser()
    const b = await registerBrowser()
    await alertFor(a, 9, 'old retry', 1)
    await alertFor(b, 1, 'new first attempt')
    const push = mockPushService(ok)
    await run({ MAX_PUSHES_PER_RUN: '1' })
    expect(await pushedTitles(push, [a, b])).toEqual(['new first attempt'])
  })

  it('among first attempts the oldest go first, when there are more than the batch can take', async () => {
    const subs = await Promise.all([1, 2, 3, 4].map(() => registerBrowser()))
    await alertFor(subs[0]!, 3, 'third oldest')
    await alertFor(subs[1]!, 7, 'oldest')
    await alertFor(subs[2]!, 1, 'newest')
    await alertFor(subs[3]!, 5, 'second oldest')
    const push = mockPushService(ok)
    await run({ MAX_PUSHES_PER_RUN: '2' })
    expect((await pushedTitles(push, subs)).sort()).toEqual(['oldest', 'second oldest'])
  })

  it('retries go after every first attempt, and among themselves oldest first', async () => {
    const subs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => registerBrowser()))
    await alertFor(subs[0]!, 2, 'retry newer', 1)
    await alertFor(subs[1]!, 8, 'retry oldest', 2)
    await alertFor(subs[2]!, 3, 'first b')
    await alertFor(subs[3]!, 7, 'first a')
    await alertFor(subs[4]!, 4, 'retry middle', 1)
    await alertFor(subs[5]!, 1, 'first c')
    const push = mockPushService(ok)

    await run({ MAX_PUSHES_PER_RUN: '4' }) // the three first attempts, then the oldest retry
    expect((await pushedTitles(push, subs)).sort()).toEqual(['first a', 'first b', 'first c', 'retry oldest'])
    await run({ MAX_PUSHES_PER_RUN: '4' })
    expect((await pushedTitles(push, subs)).slice(4).sort()).toEqual(['retry middle', 'retry newer'])
  })

  it("a failing subscription's retries never take slots from other subscriptions' first attempts", async () => {
    const failing = await registerBrowser()
    for (let i = 0; i < 6; i++) await alertFor(failing, 9 - i / 10, `stuck ${i}`, 1) // older than everything else, all retries
    const healthy = await Promise.all([1, 2, 3].map(() => registerBrowser()))
    for (const [i, h] of healthy.entries()) await alertFor(h, 2 - i / 10, `healthy ${i}`)
    const push = mockPushService(respondBy(new Map([[failing.endpoint, status(503)]])))

    expect(await run()).toEqual(counted({ due: 3, sent: 3 })) // all three slots went to first attempts
    expect(push.calls.map((c) => c.url).sort()).toEqual(healthy.map((h) => h.endpoint).sort())
    expect(await count('alerts')).toBe(6) // the stuck alerts are untouched
  })

  it('retries still happen when there is room', async () => {
    const failing = await registerBrowser()
    const healthy = await registerBrowser()
    const retry = await alertFor(failing, 4, 'retry me', 1)
    await alertFor(healthy, 1, 'first attempt')
    const push = mockPushService(respondBy(new Map([[failing.endpoint, status(503)]])))

    expect(await run()).toEqual(counted({ due: 2, sent: 1, failed: 1 })) // the first attempt, and the retry in the spare slot
    expect(push.calls).toHaveLength(2)
    expect(await attemptsOf(retry)).toBe(2)
  })

  it('a retry on its own is tried every run until it succeeds or is dropped', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 0, 'lonely retry', 1)
    const outcomes = [status(503), ok]
    const push = mockPushService(() => outcomes.shift()!())
    expect(await run({}, NOW)).toEqual(counted({ due: 1, failed: 1 }))
    expect(await run({}, NOW + MIN)).toEqual(counted({ due: 1, sent: 1 }))
    expect(push.calls).toHaveLength(2)
    expect(await ids()).not.toContain(id)
  })
})

describe('one failing subscription with many due alerts does not delay a healthy one', () => {
  it('the healthy alert is pushed in the very same run, and the failing subscription gets one push', async () => {
    const failing = await registerBrowser()
    const healthy = await registerBrowser()
    const stuck: number[] = []
    for (let i = 0; i < 40; i++) stuck.push(await alertFor(failing, 9 - i / 100, `stuck ${i}`)) // all older than the healthy alert
    const waiting = await alertFor(healthy, 1, 'healthy alert')
    const push = mockPushService(respondBy(new Map([[failing.endpoint, status(503)]])))

    const counts = await run()

    expect(push.calls.filter((c) => c.url === healthy.endpoint)).toHaveLength(1) // not delayed
    expect(push.calls.filter((c) => c.url === failing.endpoint)).toHaveLength(1) // one probe, not three
    expect(counts).toEqual(counted({ due: 2, sent: 1, failed: 1, skipped: MAX_PER_SUBSCRIPTION_PER_RUN - 1 }))
    expect(await ids()).not.toContain(waiting)
    expect(await attemptsOf(stuck[0]!)).toBe(1) // the oldest was the one tried
    expect(await attemptsOf(stuck[1]!)).toBe(0) // the others were left alone
  })

  it('even when the failing subscription has hundreds of due alerts (the query itself must not be filled by them)', async () => {
    const failing = await registerBrowser()
    const healthy = await registerBrowser()
    const insert = env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)')
    await env.DB.batch(Array.from({ length: 400 }, (_, i) => insert.bind(failing.id, NOW - 9 * MIN + i, `stuck ${i}`, 'b')))
    const waiting = await alertFor(healthy, 1, 'healthy alert')
    const push = mockPushService(respondBy(new Map([[failing.endpoint, status(503)]])))

    expect(await run()).toMatchObject({ sent: 1, failed: 1 })
    expect(push.calls.some((c) => c.url === healthy.endpoint)).toBe(true)
    expect(await ids()).not.toContain(waiting)
  })

  it('with two failing subscriptions and one healthy one, three slots serve all three', async () => {
    const x = await registerBrowser()
    const y = await registerBrowser()
    const h = await registerBrowser()
    for (let i = 0; i < 5; i++) await alertFor(x, 9 - i / 100)
    for (let i = 0; i < 5; i++) await alertFor(y, 8 - i / 100)
    await alertFor(h, 1)
    const push = mockPushService(respondBy(new Map([[x.endpoint, status(500)], [y.endpoint, status(500)]])))
    expect(await run()).toMatchObject({ sent: 1, failed: 2 })
    expect(new Set(push.calls.map((c) => c.url))).toEqual(new Set([x.endpoint, y.endpoint, h.endpoint]))
  })

  it('a failing subscription costs one push per run, run after run, and works through its alerts', async () => {
    const failing = await registerBrowser()
    const all: number[] = []
    for (let i = 0; i < 6; i++) all.push(await alertFor(failing, 9 - i / 100, `stuck ${i}`))
    const push = mockPushService(status(503))
    for (let r = 0; r < 4; r++) await run({}, NOW + r * 1000)
    expect(push.calls).toHaveLength(4) // one per run
    expect(await Promise.all(all.map(attemptsOf))).toEqual([1, 1, 1, 1, 0, 0]) // each run tried the next never-tried alert
  })

  it('a slot freed by a failing subscription goes to the next alerts in line', async () => {
    const failing = await registerBrowser()
    const others = await Promise.all([1, 2, 3, 4].map(() => registerBrowser()))
    for (let i = 0; i < 3; i++) await alertFor(failing, 9 - i / 10)
    for (const [i, o] of others.entries()) await alertFor(o, 5 - i / 10, `other ${i}`)
    const push = mockPushService(respondBy(new Map([[failing.endpoint, status(503)]])))
    const counts = await run() // 3 slots: failing probe, then two healthy
    expect(counts).toMatchObject({ failed: 1, sent: 2, skipped: 2 })
    expect(push.calls.filter((c) => c.url === failing.endpoint)).toHaveLength(1)
    expect(await count('alerts')).toBe(3 + 4 - 2)
  })
})

describe('within a run, a failed push skips that subscription for the rest of the run', () => {
  it('its other alerts are not pushed, keep their attempts, and are counted as skipped', async () => {
    const account = await registerBrowser()
    const first = await alertFor(account, 5, 'first')
    const second = await alertFor(account, 4, 'second')
    const third = await alertFor(account, 3, 'third')
    const push = mockPushService(status(500))
    expect(await run()).toEqual(counted({ due: 1, failed: 1, skipped: 2 }))
    expect(push.calls).toHaveLength(1)
    expect([await attemptsOf(first), await attemptsOf(second), await attemptsOf(third)]).toEqual([1, 0, 0])
  })

  it('applies only to that subscription', async () => {
    const x = await registerBrowser()
    const y = await registerBrowser()
    await alertFor(x, 5)
    await alertFor(x, 4)
    await alertFor(y, 3)
    await alertFor(y, 2)
    const push = mockPushService(respondBy(new Map([[x.endpoint, status(500)]])))
    expect(await run({ MAX_PUSHES_PER_RUN: '5' })).toMatchObject({ sent: 2, failed: 1, skipped: 1 })
    expect(push.calls.filter((c) => c.url === y.endpoint)).toHaveLength(2) // both of y's alerts went
  })

  it('a subscription whose pushes succeed keeps going: all its alerts go, one after another, oldest first', async () => {
    const account = await registerBrowser()
    await alertFor(account, 3, 'third oldest')
    await alertFor(account, 5, 'oldest')
    await alertFor(account, 4, 'middle')
    const push = mockPushService(ok)
    expect(await run()).toEqual(counted({ due: 3, sent: 3 }))
    const titles = await Promise.all(push.calls.map(async (c) => JSON.parse(new TextDecoder().decode(await account.browser.decrypt(c.body))).title))
    expect(titles).toEqual(['oldest', 'middle', 'third oldest'])
  })

  it('stops at the first failure: success, failure, then the third is skipped', async () => {
    const account = await registerBrowser()
    const a = await alertFor(account, 5)
    const b = await alertFor(account, 4)
    const c = await alertFor(account, 3)
    const outcomes = [ok, status(500)]
    const push = mockPushService(() => outcomes.shift()!())
    expect(await run()).toEqual(counted({ due: 2, sent: 1, failed: 1, skipped: 1 }))
    expect(push.calls).toHaveLength(2)
    expect(await ids()).toEqual([b, c])
    expect(await attemptsOf(b)).toBe(1)
    expect(await attemptsOf(c)).toBe(0)
    expect(a).toBeLessThan(b)
  })

  it('different subscriptions are pushed at the same time, one subscription’s alerts one at a time', async () => {
    const x = await registerBrowser()
    const y = await registerBrowser()
    await alertFor(x, 5)
    await alertFor(x, 4)
    await alertFor(y, 3)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const push = mockPushService(async () => {
      await gate
      return ok()
    })
    const finished = run()
    for (let i = 0; i < 100 && push.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    // While everything is held up: x's first and y's first are both under way, x's second is waiting for its first.
    expect(push.calls.map((c) => c.url).sort()).toEqual([x.endpoint, y.endpoint].sort())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(push.calls).toHaveLength(2)
    release()
    await finished
    expect(push.calls).toHaveLength(3) // x's second went after its first finished
  })

  it('a dead subscription is pushed once; its other due alerts go with it and are counted as gone', async () => {
    const dead = await registerBrowser()
    await alertFor(dead, 3)
    await alertFor(dead, 2)
    await alertFor(dead, 1)
    const push = mockPushService(status(410))
    expect(await run()).toEqual(counted({ due: 3, gone: 3 }))
    expect(push.calls).toHaveLength(1)
    expect(await count('subscriptions')).toBe(0)
    expect(await count('alerts')).toBe(0)
  })
})

describe('limits on one run', () => {
  it(`a subscription gets at most ${MAX_PER_SUBSCRIPTION_PER_RUN} pushes in a run, however many it has due and however big the batch`, async () => {
    const busy = await registerBrowser()
    for (let i = 0; i < 10; i++) await alertFor(busy, 9 - i / 100)
    const push = mockPushService(ok)
    expect(await run({ MAX_PUSHES_PER_RUN: '20' })).toEqual(counted({ due: 3, sent: 3 }))
    expect(push.calls).toHaveLength(MAX_PER_SUBSCRIPTION_PER_RUN)
    expect(await count('alerts')).toBe(7) // the rest carry over
  })

  it('a run never makes more pushes than the batch size, whether they succeed or fail', async () => {
    for (const respond of [ok, status(503)]) {
      await resetDb()
      for (let i = 0; i < 12; i++) await alertFor(await registerBrowser(), 1 + i / 100)
      const push = mockPushService(respond)
      await run()
      expect(push.calls).toHaveLength(3)
      vi.restoreAllMocks()
    }
  })

  it('stays inside 50 queries and requests at the highest batch size, even when every push fails', async () => {
    for (let i = 0; i < 20; i++) await alertFor(await registerBrowser(), 1 + i / 100)
    const push = mockPushService(status(503))
    const { tally, env: counting } = countDb(env.DB)
    await runScheduler({ ...counting, MAX_PUSHES_PER_RUN: '20' } as unknown as Cloudflare.Env, NOW)
    expect(push.calls).toHaveLength(20)
    expect(tally.sql.length).toBe(1 + 20) // one read, and one UPDATE per failed push
    expect(tally.sql.length + push.calls.length).toBeLessThanOrEqual(50)
  })

  it('returns at most 3 alerts per subscription from the query, best first within each', async () => {
    const busy = await registerBrowser()
    const other = await registerBrowser()
    for (let i = 0; i < 10; i++) await alertFor(busy, 9 - i / 100, `busy ${i}`)
    await alertFor(busy, 9.5, 'busy retry', 1) // the oldest, but a retry
    await alertFor(other, 1, 'other')
    const { results } = await env.DB.prepare(DUE_SQL).bind(NOW - 10 * MIN, NOW, 100, 20, MAX_PER_SUBSCRIPTION_PER_RUN).all<{ title: string; subscription_id: string }>()
    const busyRows = results.filter((r) => r.subscription_id === busy.id)
    expect(busyRows.map((r) => r.title)).toEqual(['busy 0', 'busy 1', 'busy 2']) // never-tried first, oldest first; the retry ranks below them
    expect(results.filter((r) => r.subscription_id === other.id)).toHaveLength(1)
  })

  it('with no usable push keys, nothing is pushed and no alert is counted against', async () => {
    const account = await registerBrowser()
    const id = await alertFor(account, 1, 'x', 2)
    const push = mockPushService(ok)
    expect(await run({ VAPID_PRIVATE_KEY: undefined })).toEqual(counted({ skipped: 1 }))
    expect(push.calls).toHaveLength(0)
    expect(await attemptsOf(id)).toBe(2)
  })

  it('known limit: as many failing subscriptions as there are slots can use every slot of a run, for the few runs it takes to work through them', async () => {
    const failing = await Promise.all([1, 2, 3].map(() => registerBrowser()))
    for (const f of failing) for (let i = 0; i < 3; i++) await alertFor(f, 9 - i / 100)
    const healthy = await registerBrowser()
    await alertFor(healthy, 1, 'waits')
    const push = mockPushService(respondBy(new Map(failing.map((f) => [f.endpoint, status(503)]))))
    await run()
    expect(push.calls.every((c) => c.url !== healthy.endpoint)).toBe(true) // all three slots probed failing subscriptions
    for (let r = 0; r < 2; r++) await run({}, NOW + (r + 1) * 1000) // their other alerts, one each per run
    expect(push.calls.some((c) => c.url === healthy.endpoint)).toBe(false)
    await run({}, NOW + 4000) // by now every alert of theirs has been tried once, and retries rank last
    expect(push.calls.some((c) => c.url === healthy.endpoint)).toBe(true)
    expect(CANDIDATES_PER_PUSH).toBe(3)
  })
})

describe('the migration is additive, so the Worker that is live while it applies keeps working', () => {
  it('only adds a column with a default, and existing alerts start at 0', async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0005'))!
    const statements = migration.queries
      .map((q) => q.split('\n').filter((l) => !l.trim().startsWith('--')).join(' ').replace(/;\s*$/, '').trim())
      .filter(Boolean)
    expect(statements).toEqual(['ALTER TABLE alerts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'])

    const account = await registerBrowser()
    await env.DB.prepare('INSERT INTO alerts (subscription_id, fire_at, title, body) VALUES (?, ?, ?, ?)').bind(account.id, NOW, 't', 'b').run() // no attempts given
    expect((await env.DB.prepare('SELECT attempts FROM alerts').first<{ attempts: number }>())!.attempts).toBe(0)
  })

  it("the previous version's scheduler query still runs against the new table", async () => {
    // Copied from the Worker that was deployed before this change.
    const OLD_DUE_SQL = `
      SELECT * FROM (
        SELECT a.id AS id, a.fire_at AS fire_at, a.title AS title, a.body AS body, a.subscription_id AS subscription_id,
               s.endpoint AS endpoint, s.p256dh AS p256dh, s.auth AS auth
        FROM alerts a JOIN subscriptions s ON s.id = a.subscription_id
        WHERE a.sent_at IS NULL AND a.fire_at >= ?1 AND a.fire_at <= ?2
        ORDER BY a.fire_at LIMIT ?3
      )
      UNION ALL
      SELECT * FROM (
        SELECT a.id, a.fire_at, a.title, a.body, a.subscription_id, '', '', ''
        FROM alerts a
        WHERE a.sent_at IS NULL AND a.fire_at < ?1
        ORDER BY a.fire_at LIMIT ?4
      )`
    const account = await registerBrowser()
    await alertFor(account, 1)
    const { results } = await env.DB.prepare(OLD_DUE_SQL).bind(NOW - 10 * MIN, NOW, 3, 20).all()
    expect(results).toHaveLength(1)
  })
})
