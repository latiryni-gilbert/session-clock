import { LAST_SEEN_REFRESH_MS, MAX_DAILY_ALERT_CHANGES, TEST_PUSH_BODY, TEST_PUSH_TITLE, TEST_PUSH_TTL_SECONDS } from './constants'
import { randomSecret, safeEqual, sha256Hex } from './crypto'
import { HttpError, json, readJsonObject } from './http'
import { enforceRateLimit } from './ratelimit'
import { canonicalAlerts, hashSchedule, planChanges, type ExistingAlert } from './schedule'
import { secondsUntilUtcMidnight, utcDay } from './time'
import { utf8 } from './base64url'
import { validateAlerts, validateSubscription } from './validate'
import { loadVapidKeys } from './vapid'
import { sendWebPush } from './webpush'

// A hash no secret can produce, compared against when the id doesn't exist so that an unknown id
// takes the same work (and gives the same answer) as a wrong secret.
const NO_SUCH_HASH = '0'.repeat(64)

const unauthorized = () => new HttpError(401, 'Invalid id or secret')

interface Authenticated {
  id: string
  scheduleHash: string | null
  lastSeenAt: number
  changesDay: number
  changesCount: number
  endpoint: string
  p256dh: string
  auth: string
}

/** Checks the id + secret in the request body. Throws the same 401 whether the id is unknown or the secret is wrong. */
async function authenticate(env: Cloudflare.Env, body: Record<string, unknown>): Promise<Authenticated> {
  const { id, secret } = body
  if (typeof id !== 'string' || typeof secret !== 'string' || id.length > 64 || secret.length > 256) {
    throw unauthorized()
  }
  const row = await env.DB.prepare('SELECT secret_hash, schedule_hash, last_seen_at, changes_day, changes_count, endpoint, p256dh, auth FROM subscriptions WHERE id = ?')
    .bind(id)
    .first<{
      secret_hash: string
      schedule_hash: string | null
      last_seen_at: number
      changes_day: number
      changes_count: number
      endpoint: string
      p256dh: string
      auth: string
    }>()
  const matches = safeEqual(await sha256Hex(secret), row?.secret_hash ?? NO_SUCH_HASH)
  if (!row || !matches) throw unauthorized()
  return {
    id,
    scheduleHash: row.schedule_hash,
    lastSeenAt: row.last_seen_at,
    changesDay: row.changes_day,
    changesCount: row.changes_count,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
  }
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

/**
 * PUT /schedule: make the subscription's future alerts match the given list.
 *
 * D1's free tier allows 100,000 rows written a day, and every inserted or deleted alert costs about three
 * (the row and its two index entries), so this writes as little as it can:
 *   1. the same schedule as last time: nothing is written;
 *   2. otherwise only the alerts that were removed or added are deleted or inserted;
 *   3. a subscription may add + remove at most MAX_DAILY_ALERT_CHANGES alerts per UTC day, so a client stuck
 *      in a loop of changing uploads can't spend the budget. The running total is kept on the subscription
 *      row, in the UPDATE that records the new schedule hash, so counting it writes no extra rows.
 */
export async function schedule(request: Request, env: Cloudflare.Env): Promise<Response> {
  const body = await readJsonObject(request)
  const sub = await authenticate(env, body)
  const { id } = sub
  const now = Date.now()
  const alerts = canonicalAlerts(validateAlerts(body.alerts, now))
  const hash = await hashSchedule(alerts)

  if (sub.scheduleHash === hash) {
    // Nothing to do. Only keep last_seen_at from going stale, at most once a day.
    if (now - sub.lastSeenAt > LAST_SEEN_REFRESH_MS) {
      await env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(now, id).run()
    }
    return json({ ok: true, scheduled: alerts.length, unchanged: true })
  }

  // Past this point the upload will write to D1, so it is limited per subscription.
  await enforceRateLimit(env.SCHEDULE_CHANGE_LIMITER, id)

  const existing = await env.DB.prepare('SELECT id, fire_at, title, body, sent_at FROM alerts WHERE subscription_id = ? AND fire_at > ?')
    .bind(id, now)
    .all<ExistingAlert>()
  const { deleteIds, insert } = planChanges(existing.results, alerts)

  // The daily cap. Unchanged uploads returned above and never count. This check comes before any write.
  const changes = deleteIds.length + insert.length
  const today = utcDay(now)
  const usedToday = sub.changesDay === today ? sub.changesCount : 0
  if (changes > MAX_DAILY_ALERT_CHANGES) {
    // Not a matter of waiting: even a fresh day couldn't fit it, so don't send the client off to retry at midnight.
    throw new HttpError(
      400,
      `This upload would change ${changes} alerts, but a subscription can change at most ${MAX_DAILY_ALERT_CHANGES} alerts per UTC day, so it can never be applied; send a smaller schedule`,
    )
  }
  if (usedToday + changes > MAX_DAILY_ALERT_CHANGES) {
    throw new HttpError(
      429,
      `Daily limit of ${MAX_DAILY_ALERT_CHANGES} alert changes reached for this subscription (${usedToday} used today, this upload needs ${changes}); try again after 00:00 UTC`,
      { 'retry-after': String(secondsUntilUtcMidnight(now)) },
    )
  }

  // One batch = one transaction. Every statement only acts if the stored hash is still the one this
  // request started from, so two overlapping uploads can't both apply (and double up the alerts): the
  // second finds the hash changed, does nothing, and gets a 409.
  const unchangedSince = 'EXISTS (SELECT 1 FROM subscriptions WHERE id = ?1 AND schedule_hash IS ?3)'
  const statements: D1PreparedStatement[] = []
  if (deleteIds.length > 0) {
    statements.push(
      env.DB.prepare(`DELETE FROM alerts WHERE subscription_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND ${unchangedSince}`).bind(
        id,
        JSON.stringify(deleteIds),
        sub.scheduleHash,
      ),
    )
  }
  if (insert.length > 0) {
    // The new rows go in as one JSON parameter so 500 alerts cost one query, not 500.
    const rows = JSON.stringify(insert.map((a) => ({ f: a.fireAt, t: a.title, b: a.body })))
    statements.push(
      env.DB.prepare(
        `INSERT INTO alerts (subscription_id, fire_at, title, body)
         SELECT ?1, json_extract(value, '$.f'), json_extract(value, '$.t'), json_extract(value, '$.b')
         FROM json_each(?2) WHERE ${unchangedSince}`,
      ).bind(id, rows, sub.scheduleHash),
    )
  }
  // Last, because the statements above check the old hash.
  statements.push(
    env.DB.prepare(
      `UPDATE subscriptions
       SET schedule_hash = ?1, last_seen_at = ?2, changes_day = ?5, changes_count = ?6
       WHERE id = ?3 AND schedule_hash IS ?4`,
    ).bind(hash, now, id, sub.scheduleHash, today, usedToday + changes),
  )
  const results = await env.DB.batch(statements)
  if (results[results.length - 1]!.meta.changes === 0) {
    throw new HttpError(409, 'The schedule was changed by another request; try again')
  }

  return json({ ok: true, scheduled: alerts.length, added: insert.length, removed: deleteIds.length })
}

/** POST /unsubscribe: delete the subscription; its alerts go with it (ON DELETE CASCADE). */
export async function unsubscribe(request: Request, env: Cloudflare.Env): Promise<Response> {
  const { id } = await authenticate(env, await readJsonObject(request))
  await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run()
  return json({ ok: true })
}

/** GET /vapid-public-key: the key the browser passes to pushManager.subscribe as applicationServerKey. */
export async function vapidPublicKey(_request: Request, env: Cloudflare.Env): Promise<Response> {
  const keys = await loadVapidKeys(env)
  if (!keys) throw new HttpError(503, 'Push notifications are not configured on the server')
  // The key changes only if someone replaces it, so browsers may keep it for an hour.
  return json({ publicKey: keys.publicKey }, 200, { 'cache-control': 'public, max-age=3600' })
}

const TEST_PAYLOAD = utf8(JSON.stringify({ title: TEST_PUSH_TITLE, body: TEST_PUSH_BODY }))

/**
 * POST /test-push: send this subscription one notification, to prove background alerts work.
 * A 404 or 410 from the push service means the browser has dropped the subscription, so it is deleted
 * (its alerts go with it). Any other failure deletes nothing.
 */
export async function testPush(request: Request, env: Cloudflare.Env): Promise<Response> {
  const sub = await authenticate(env, await readJsonObject(request))
  if (!(await loadVapidKeys(env))) throw new HttpError(503, 'Push notifications are not configured on the server')
  await enforceRateLimit(env.TEST_PUSH_LIMITER, sub.id)

  const result = await sendWebPush(env, sub, TEST_PAYLOAD, { ttl: TEST_PUSH_TTL_SECONDS, urgency: 'high' })
  switch (result.kind) {
    case 'sent':
      return json({ ok: true })
    case 'gone':
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(sub.id).run()
      throw new HttpError(410, 'The push service says this subscription no longer exists, so it was removed; subscribe again')
    case 'rejected':
      throw new HttpError(502, `The push service refused the message (status ${result.status})`)
    case 'unreachable':
      throw new HttpError(502, 'Could not reach the push service')
    case 'unsupported':
      throw new HttpError(502, 'This subscription is not on a push service the server sends to')
    case 'invalid-subscription':
      throw new HttpError(422, "This subscription's keys are not valid; subscribe again")
    case 'not-configured':
      throw new HttpError(503, 'Push notifications are not configured on the server')
  }
}
