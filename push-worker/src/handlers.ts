import { randomSecret, safeEqual, sha256Hex } from './crypto'
import { HttpError, json, readJsonObject } from './http'
import { validateAlerts, validateSubscription } from './validate'

// A hash no secret can produce, compared against when the id doesn't exist so that an unknown id
// takes the same work (and gives the same answer) as a wrong secret.
const NO_SUCH_HASH = '0'.repeat(64)

const unauthorized = () => new HttpError(401, 'Invalid id or secret')

/** Checks the id + secret in the request body. Throws the same 401 whether the id is unknown or the secret is wrong. */
async function authenticate(env: Cloudflare.Env, body: Record<string, unknown>): Promise<string> {
  const { id, secret } = body
  if (typeof id !== 'string' || typeof secret !== 'string' || id.length > 64 || secret.length > 256) {
    throw unauthorized()
  }
  const row = await env.DB.prepare('SELECT secret_hash FROM subscriptions WHERE id = ?').bind(id).first<{ secret_hash: string }>()
  const matches = safeEqual(await sha256Hex(secret), row?.secret_hash ?? NO_SUCH_HASH)
  if (!row || !matches) throw unauthorized()
  return id
}

/** POST /subscribe: store (or update) a browser push subscription and return its id and a new secret. */
export async function subscribe(request: Request, env: Cloudflare.Env): Promise<Response> {
  const subscription = validateSubscription(await readJsonObject(request))
  const secret = randomSecret()
  const secretHash = await sha256Hex(secret)
  const now = Date.now()

  // One atomic statement. Subscribing again with the same endpoint keeps its id, refreshes the keys and
  // issues a new secret (the old one stops working).
  const row = await env.DB.prepare(
    `INSERT INTO subscriptions (id, endpoint, p256dh, auth, secret_hash, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       secret_hash = excluded.secret_hash,
       last_seen_at = excluded.last_seen_at
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), subscription.endpoint, subscription.p256dh, subscription.auth, secretHash, now)
    .first<{ id: string }>()

  return json({ id: row!.id, secret })
}

/** PUT /schedule: replace the subscription's future, unsent alerts with the given list. */
export async function schedule(request: Request, env: Cloudflare.Env): Promise<Response> {
  const body = await readJsonObject(request)
  const id = await authenticate(env, body)
  const now = Date.now()
  const alerts = validateAlerts(body.alerts, now)

  // One batch = one transaction: either the whole schedule is replaced or nothing changes.
  // The new rows go in as a single JSON parameter so 500 alerts cost one query, not 500.
  const rows = JSON.stringify(alerts.map((a) => ({ f: a.fireAt, t: a.title, b: a.body })))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM alerts WHERE subscription_id = ? AND sent_at IS NULL AND fire_at > ?').bind(id, now),
    env.DB.prepare(
      `INSERT INTO alerts (subscription_id, fire_at, title, body)
       SELECT ?1, json_extract(value, '$.f'), json_extract(value, '$.t'), json_extract(value, '$.b')
       FROM json_each(?2)`,
    ).bind(id, rows),
    env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(now, id),
  ])

  return json({ ok: true, scheduled: alerts.length })
}

/** POST /unsubscribe: delete the subscription; its alerts go with it (ON DELETE CASCADE). */
export async function unsubscribe(request: Request, env: Cloudflare.Env): Promise<Response> {
  const id = await authenticate(env, await readJsonObject(request))
  await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run()
  return json({ ok: true })
}
