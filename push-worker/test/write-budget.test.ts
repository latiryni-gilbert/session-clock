import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { canonicalAlerts, hashSchedule, planChanges, type ExistingAlert } from '../src/schedule'
import { DAY, MIN, alertRows, count, measured, register, resetDb, schedule } from './helpers'

// What D1 charges, as measured locally: an alert row costs 3 rows written (the row plus its two index
// entries), and each INSERT statement costs 1 more (the AUTOINCREMENT counter). Updating a subscription costs 1.
// Local D1 undercounts deletes (it doesn't charge for index entries), so tests about deletes compare
// against the full rewrite instead of asserting an exact figure.
const PER_ALERT = 3

// A day of alerts: 20 per day, one every 30 minutes starting at `startDay` days from a fixed moment, so that
// asking for the same day twice gives identical alerts.
const BASE = Date.now()
const day = (startDay: number, n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    fireAt: new Date(BASE + startDay * DAY + (i + 1) * 30 * MIN).toISOString(),
    title: `Alert ${startDay}-${i}`,
    body: 'soon',
  }))
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => day(from + i)).flat()

beforeEach(resetDb)

describe('rows written by PUT /schedule', () => {
  it('first upload: about three rows per alert, not more', async () => {
    const { id, secret } = await register()
    const alerts = days(1, 3) // 60 alerts
    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 60, removed: 0 })
    // 60 alerts x 3 rows, plus 1 for the insert statement, plus 1 for the subscription's hash.
    expect(rowsWritten).toBeGreaterThanOrEqual(60 * PER_ALERT)
    expect(rowsWritten).toBeLessThanOrEqual(60 * PER_ALERT + 2)
  })

  it('unchanged re-upload: writes nothing, and never touches the alerts table', async () => {
    const { id, secret } = await register()
    const alerts = days(1, 3)
    await schedule(id, secret, alerts)

    const { res, rowsWritten, sql } = await measured('PUT', '/schedule', { id, secret, alerts })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, scheduled: 60, unchanged: true })
    expect(rowsWritten).toBe(0)
    expect(sql.filter((q) => /\balerts\b/i.test(q))).toEqual([])
    expect((await alertRows(id)).results).toHaveLength(60)
  })

  it('unchanged means the same alerts, whatever order they are listed in', async () => {
    const { id, secret } = await register()
    const alerts = day(1)
    await schedule(id, secret, alerts)
    const { rowsWritten, res } = await measured('PUT', '/schedule', { id, secret, alerts: [...alerts].reverse() })
    expect(await res.json()).toMatchObject({ unchanged: true })
    expect(rowsWritten).toBe(0)
  })

  it('a schedule that gained one day: pays only for the new day', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, days(1, 3)) // 60 alerts

    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: days(1, 4) }) // + 20
    expect(await res.json()).toMatchObject({ added: 20, removed: 0 })
    expect(rowsWritten).toBeGreaterThanOrEqual(20 * PER_ALERT)
    expect(rowsWritten).toBeLessThanOrEqual(20 * PER_ALERT + 2)
    // The old way deleted and re-inserted all 80: at least 80 x 3 (insert) + deletes.
    expect(rowsWritten).toBeLessThan((80 * PER_ALERT) / 3)
    expect((await alertRows(id)).results).toHaveLength(80)
  })

  it('a sliding window (one day dropped, one added): only those 40 alerts are touched', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, days(1, 3))

    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: days(2, 4) })
    expect(await res.json()).toMatchObject({ added: 20, removed: 20 })
    // Inserting 20 (61 incl. overhead) + deleting 20 (at least 1 each) + the hash: well under rewriting all 60.
    expect(rowsWritten).toBeLessThan(60 * PER_ALERT * 2)
    const titles = (await alertRows(id)).results.map((r) => r.title)
    expect(titles).toHaveLength(60)
    expect(titles).not.toContain('Alert 1-0')
    expect(titles).toContain('Alert 4-19')
  })

  it('changing one alert touches one alert', async () => {
    const { id, secret } = await register()
    const alerts = days(1, 3)
    await schedule(id, secret, alerts)
    const changed = alerts.map((a, i) => (i === 7 ? { ...a, body: 'edited' } : a))
    const { res, rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: changed })
    expect(await res.json()).toMatchObject({ added: 1, removed: 1 })
    expect(rowsWritten).toBeLessThan(10)
    expect((await alertRows(id)).results.filter((r) => r.body === 'edited')).toHaveLength(1)
  })

  it('removing alerts only deletes; adding none inserts nothing', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, day(1))
    const { res, sql } = await measured('PUT', '/schedule', { id, secret, alerts: day(1).slice(0, 5) })
    expect(await res.json()).toMatchObject({ added: 0, removed: 15 })
    expect(sql.some((q) => /INSERT INTO alerts/i.test(q))).toBe(false)
  })

  it('the stored hash always matches the stored alerts', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, days(1, 2))
    await schedule(id, secret, days(2, 3))
    const rows = (await alertRows(id)).results
    const stored = await env.DB.prepare('SELECT schedule_hash FROM subscriptions WHERE id = ?').bind(id).first<{ schedule_hash: string }>()
    const fromRows = await hashSchedule(canonicalAlerts(rows.map((r) => ({ fireAt: r.fire_at, title: r.title, body: r.body }))))
    expect(stored!.schedule_hash).toBe(fromRows)
  })

  it('treats a repeated alert in one upload as a single alert', async () => {
    const { id, secret } = await register()
    const a = day(1, 1)[0]!
    const res = await schedule(id, secret, [a, a, { ...a }])
    expect(await res.json()).toMatchObject({ scheduled: 1, added: 1 })
    expect((await alertRows(id)).results).toHaveLength(1)
  })

  it('does not insert an alert that already exists but was already sent', async () => {
    const { id, secret } = await register()
    const [a] = day(1, 1)
    await schedule(id, secret, [a])
    await env.DB.prepare('UPDATE alerts SET sent_at = ? WHERE subscription_id = ?').bind(Date.now(), id).run()
    const res = await schedule(id, secret, [a, ...day(2, 1)])
    expect(await res.json()).toMatchObject({ added: 1, removed: 0 })
    expect((await alertRows(id)).results).toHaveLength(2)
  })
})

describe('last_seen_at on unchanged uploads', () => {
  it('is not touched (0 rows written) when it is recent', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, day(1))
    const { rowsWritten } = await measured('PUT', '/schedule', { id, secret, alerts: day(1) })
    expect(rowsWritten).toBe(0)
  })

  it('is refreshed (1 row written) once it is more than a day old', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, day(1))
    await env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(Date.now() - 2 * DAY, id).run()
    const { rowsWritten, res } = await measured('PUT', '/schedule', { id, secret, alerts: day(1) })
    expect(await res.json()).toMatchObject({ unchanged: true })
    expect(rowsWritten).toBe(1)
    const row = await env.DB.prepare('SELECT last_seen_at FROM subscriptions WHERE id = ?').bind(id).first<{ last_seen_at: number }>()
    expect(row!.last_seen_at).toBeGreaterThan(Date.now() - 10_000)
  })
})

describe('overlapping uploads', () => {
  it('an upload that finds the schedule changed underneath it does nothing and gets 409', async () => {
    const { id, secret } = await register()
    await schedule(id, secret, day(1, 5))
    // Another request changes the stored hash after this one has read the alerts but before it writes.
    const race = async () => {
      await env.DB.prepare("UPDATE subscriptions SET schedule_hash = 'someone-else' WHERE id = ?").bind(id).run()
    }
    const { res } = await measured('PUT', '/schedule', { id, secret, alerts: day(2, 10) }, race)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('another request')
    // Nothing was applied: still the original 5 alerts.
    expect((await alertRows(id)).results.map((r) => r.title)).toEqual(day(1, 5).map((a) => a.title))
  })

  it('two simultaneous different uploads never double up the alerts', async () => {
    const { id, secret } = await register()
    const [a, b] = await Promise.all([schedule(id, secret, days(1, 2)), schedule(id, secret, day(3))])
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true)
    expect([a.status, b.status]).toContain(200)
    const rows = (await alertRows(id)).results
    expect(new Set(rows.map((r) => `${r.fire_at}|${r.title}`)).size).toBe(rows.length)
    const stored = await env.DB.prepare('SELECT schedule_hash FROM subscriptions WHERE id = ?').bind(id).first<{ schedule_hash: string }>()
    const fromRows = await hashSchedule(canonicalAlerts(rows.map((r) => ({ fireAt: r.fire_at, title: r.title, body: r.body }))))
    expect(stored!.schedule_hash).toBe(fromRows)
  })
})

describe('planChanges', () => {
  const existing = (id: number, fireAt: number, title: string, sentAt: number | null = null): ExistingAlert => ({ id, fire_at: fireAt, title, body: 'b', sent_at: sentAt })
  const want = (fireAt: number, title: string) => ({ fireAt, title, body: 'b' })

  it('matches on fire time, title and body together', () => {
    const plan = planChanges([existing(1, 100, 'A'), existing(2, 200, 'B')], [want(100, 'A'), want(200, 'C'), want(300, 'B')])
    expect(plan.deleteIds).toEqual([2])
    expect(plan.insert).toEqual([want(200, 'C'), want(300, 'B')])
  })

  it('never deletes a sent alert', () => {
    expect(planChanges([existing(1, 100, 'A', 5)], []).deleteIds).toEqual([])
  })

  it('does nothing when nothing changed', () => {
    expect(planChanges([existing(1, 100, 'A')], [want(100, 'A')])).toEqual({ deleteIds: [], insert: [] })
  })
})

it('the table is empty again after the tests (sanity check for the reset)', async () => {
  expect(await count('alerts')).toBe(0)
})
