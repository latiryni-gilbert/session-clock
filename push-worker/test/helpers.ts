import { env, exports } from 'cloudflare:workers'
import { expect } from 'vitest'

export const MIN = 60_000
export const DAY = 24 * 60 * MIN
export const PROD = 'https://sessionclock.vercel.app'

// A real-looking browser subscription (what PushSubscription.toJSON() gives you).
let counter = 0
export const makeSubscription = (overrides: Record<string, unknown> = {}) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/test-${++counter}-${crypto.randomUUID()}`,
  expirationTime: null,
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
  ...overrides,
})

export const alertIn = (ms: number, extra: Record<string, unknown> = {}) => ({
  fireAt: new Date(Date.now() + ms).toISOString(),
  title: 'NYSE opens',
  body: 'in 15 minutes',
  ...extra,
})

export const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request(`https://push.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

export const subscribe = (sub = makeSubscription(), headers: Record<string, string> = {}) => call('POST', '/subscribe', sub, headers)
export const schedule = (id: string, secret: string, alerts: unknown) => call('PUT', '/schedule', { id, secret, alerts })
export const unsubscribe = (id: string, secret: string) => call('POST', '/unsubscribe', { id, secret })

export async function register(sub = makeSubscription()) {
  const res = await subscribe(sub)
  expect(res.status).toBe(200)
  return { ...((await res.json()) as { id: string; secret: string }), sub }
}

export const alertRows = (id: string) =>
  env.DB.prepare('SELECT fire_at, title, body, sent_at FROM alerts WHERE subscription_id = ? ORDER BY fire_at').bind(id).all<{
    fire_at: number
    title: string
    body: string
    sent_at: number | null
  }>()
export const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n


export async function resetDb() {
  await env.DB.batch([env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM subscriptions')])
}

/**
 * Wraps env.DB so a test can see what a request cost: every SQL statement it ran and the total of D1's
 * meta.rows_written across all of them. (Reads through .first() carry no meta, which is fine: they write nothing.)
 * `beforeBatch` runs just before a batch is sent, for tests that need something to happen mid-request.
 */
export function countDb(db: D1Database, beforeBatch?: () => Promise<void>) {
  const tally = { rowsWritten: 0, sql: [] as string[] }
  const add = (meta: D1Meta) => {
    tally.rowsWritten += meta.rows_written
  }
  type Wrapped = { real: D1PreparedStatement; bind(...values: unknown[]): Wrapped; run(): Promise<D1Result>; all<T>(): Promise<D1Result<T>>; first<T>(): Promise<T | null> }
  const wrap = (real: D1PreparedStatement): Wrapped => ({
    real,
    bind: (...values) => wrap(real.bind(...values)),
    run: async () => {
      const result = await real.run()
      add(result.meta)
      return result
    },
    all: async <T>() => {
      const result = await real.all<T>()
      add(result.meta)
      return result
    },
    first: <T>() => real.first<T>(),
  })
  const counting = {
    prepare: (sql: string) => {
      tally.sql.push(sql)
      return wrap(db.prepare(sql))
    },
    batch: async (statements: Wrapped[]) => {
      await beforeBatch?.()
      const results = await db.batch(statements.map((s) => s.real))
      for (const r of results) add(r.meta)
      return results
    },
  }
  return { tally, env: { ...env, DB: counting } as unknown as Cloudflare.Env }
}

/** Sends a request through the Worker with a counting database, returning the response and what it cost. */
export async function measured(method: string, path: string, body: unknown, beforeBatch?: () => Promise<void>) {
  const { default: worker } = await import('../src/index')
  const { tally, env: countingEnv } = countDb(env.DB, beforeBatch)
  const res = await worker.fetch(
    new Request(`https://push.example.com${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    countingEnv,
  )
  return { res, rowsWritten: tally.rowsWritten, sql: tally.sql }
}
