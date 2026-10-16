import { utf8 } from './base64url'
import { deleteOldSentAlerts, deleteStaleSubscriptions } from './cleanup'
import {
  CANDIDATES_PER_PUSH,
  DEFAULT_PUSHES_PER_RUN,
  EXPIRED_PER_RUN,
  LATE_LIMIT_MS,
  MAX_ATTEMPTS,
  MAX_PER_SUBSCRIPTION_PER_RUN,
  MAX_PUSHES_PER_RUN_LIMIT,
} from './constants'
import { loadVapidKeys } from './vapid'
import { sendWebPush } from './webpush'

// What the cron trigger does. Two things share this file: the every-minute run that sends due alerts, and the
// once-a-day clean-up. Neither ever logs an endpoint, key, secret or notification text, only counts.

interface DueRow {
  id: number
  fire_at: number
  title: string
  body: string
  attempts: number
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * The due alerts in ONE query, in two halves.
 *
 * On time (?1 <= fire_at <= ?2): the candidates for this run, best first, up to ?3 of them: alerts not yet tried
 * before alerts already tried and failed ("first attempts before retries"), then oldest first. At most ?5 per
 * subscription are returned: the ROW_NUMBER() window ranks each subscription's alerts the same way and keeps the first ?5.
 * That cap is what stops a subscription with hundreds of due alerts from filling the list and hiding the alerts of
 * everyone else. (The window reads every unsent alert due in the last 10 minutes, which is a small, bounded set.)
 *
 * Too late (fire_at < ?1): up to ?4, oldest first; only their ids matter.
 *
 * Both halves use the partial index on unsent alerts, so a run with nothing due reads next to nothing and a quiet
 * minute is still exactly one query. ?1 is "now minus the lateness limit" and ?2 is "now".
 */
export const DUE_SQL = `
  SELECT * FROM (
    SELECT id, fire_at, title, body, attempts, subscription_id, endpoint, p256dh, auth FROM (
      SELECT a.id AS id, a.fire_at AS fire_at, a.title AS title, a.body AS body, a.attempts AS attempts,
             a.subscription_id AS subscription_id, s.endpoint AS endpoint, s.p256dh AS p256dh, s.auth AS auth,
             ROW_NUMBER() OVER (PARTITION BY a.subscription_id ORDER BY a.attempts > 0, a.fire_at, a.id) AS rank_in_subscription
      FROM alerts a JOIN subscriptions s ON s.id = a.subscription_id
      WHERE a.sent_at IS NULL AND a.fire_at >= ?1 AND a.fire_at <= ?2
    )
    WHERE rank_in_subscription <= ?5
    ORDER BY attempts > 0, fire_at, id
    LIMIT ?3
  )
  UNION ALL
  SELECT * FROM (
    SELECT a.id, a.fire_at, a.title, a.body, 0, a.subscription_id, '', '', ''
    FROM alerts a
    WHERE a.sent_at IS NULL AND a.fire_at < ?1
    ORDER BY a.fire_at LIMIT ?4
  )`

/** How many pushes a run may send: MAX_PUSHES_PER_RUN if it is a sensible number, within the hard limit, else the default. */
export function pushesPerRun(env: { MAX_PUSHES_PER_RUN?: string }): number {
  const configured = Number.parseInt(env.MAX_PUSHES_PER_RUN ?? '', 10)
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_PUSHES_PER_RUN
  return Math.min(configured, MAX_PUSHES_PER_RUN_LIMIT)
}

/**
 * The notification tag for an alert. A device shows at most one notification per tag, so the same alert can't
 * appear twice there, however many times it is delivered (a retry, or a run that was cut off before deleting it).
 * Alert ids are never reused (AUTOINCREMENT), so a tag always means the same alert.
 */
export const alertTag = (alertId: number): string => `alert-${alertId}`

/**
 * What a run did. `due` is the alerts it dealt with, so `due = sent + failed + expired + gone` always holds:
 * - sent: pushed and deleted.
 * - failed: the push failed (not 404/410); the alert's attempts went up by one. `dropped` of these were the third failure, so
 *   the alert was deleted instead.
 * - expired: more than 10 minutes late, deleted without a push.
 * - gone: the push service said the subscription no longer exists; it was deleted with all its alerts (that includes
 *   the subscription's other due alerts that this run saw, which were not pushed).
 * `skipped` is not part of `due`: alerts the run saw but left alone because an earlier push to their subscription
 * failed in the same run (or, if the push keys aren't configured, all of them).
 */
export interface RunCounts {
  due: number
  sent: number
  failed: number
  expired: number
  gone: number
  dropped: number
  skipped: number
}

/** Highest priority first: alerts not yet tried before retries, then oldest first. */
const byPriority = (a: DueRow, b: DueRow) => Number(a.attempts > 0) - Number(b.attempts > 0) || a.fire_at - b.fire_at || a.id - b.id

/**
 * One every-minute run: push the due alerts that are still on time, as many as the batch allows.
 * - Order: alerts not yet tried before retries, then oldest first. A failing subscription's retries can never take
 *   a slot from another subscription's first attempt.
 * - A subscription's alerts are pushed one after another (and only while they succeed): if a push to it fails, its other
 *   alerts are skipped for the rest of the run, so one broken subscription costs one push, not the whole batch.
 *   Different subscriptions are pushed in parallel.
 * - Sent: the alert is deleted at once (deleting costs less than marking it sent and deleting later).
 * - The push service says the subscription is gone (404/410): the subscription and its alerts are deleted.
 * - Any other failure: attempts goes up by one, and the alert is tried again in a later run; the third failure deletes it.
 * - More than 10 minutes late: deleted without a push.
 * A run with nothing due makes one database query and writes nothing.
 */
export async function runScheduler(env: Cloudflare.Env, now: number): Promise<RunCounts> {
  const cutoff = now - LATE_LIMIT_MS
  const budget = pushesPerRun(env)
  const { results } = await env.DB.prepare(DUE_SQL)
    .bind(cutoff, now, budget * CANDIDATES_PER_PUSH, EXPIRED_PER_RUN, MAX_PER_SUBSCRIPTION_PER_RUN)
    .all<DueRow>()
  const counts: RunCounts = { due: 0, sent: 0, failed: 0, expired: 0, gone: 0, dropped: 0, skipped: 0 }
  if (results.length === 0) return counts

  // Too late: delete them first (one query), before the CPU-heavy part, so they go even if a run is cut short.
  const expired = results.filter((row) => row.fire_at < cutoff)
  if (expired.length > 0) {
    await env.DB.prepare('DELETE FROM alerts WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(expired.map((row) => row.id)))
      .run()
    counts.expired = expired.length
    counts.due += expired.length
  }

  const candidates = results.filter((row) => row.fire_at >= cutoff).sort(byPriority)
  if (candidates.length === 0) return counts

  // Without usable push keys no push can be made, and that is not the alerts' fault: leave them (and their attempts) alone.
  if (!(await loadVapidKeys(env))) {
    counts.skipped = candidates.length
    return counts
  }

  const handled = new Set<number>()
  const failing = new Set<string>() // subscriptions with a failed push in this run: their other alerts are skipped
  const gone = new Set<string>() // the subset whose subscription no longer exists
  let slots = budget

  // Each pass pushes one alert per subscription, best first, in parallel; the next pass gives a subscription whose
  // push succeeded its next alert. At most `budget` pushes in all, whether they succeed or not.
  while (slots > 0) {
    const pass: DueRow[] = []
    const inPass = new Set<string>()
    for (const row of candidates) {
      if (pass.length >= slots) break
      if (handled.has(row.id) || failing.has(row.subscription_id) || inPass.has(row.subscription_id)) continue
      pass.push(row)
      inPass.add(row.subscription_id)
    }
    if (pass.length === 0) break
    slots -= pass.length
    for (const row of pass) handled.add(row.id)

    await Promise.all(
      pass.map(async (row) => {
        const tag = alertTag(row.id)
        const result = await sendWebPush(env, row, utf8(JSON.stringify({ title: row.title, body: row.body, tag })), {
          // The push service should drop it if it can't deliver before it would count as too late.
          ttl: Math.max(1, Math.floor((row.fire_at + LATE_LIMIT_MS - now) / 1000)),
          urgency: 'high',
          topic: tag,
        })
        counts.due++
        // Every push is followed by exactly one query, so a run is at most 1 + 1 + N queries and N pushes.
        if (result.kind === 'sent') {
          await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(row.id).run()
          counts.sent++
        } else if (result.kind === 'gone') {
          failing.add(row.subscription_id)
          gone.add(row.subscription_id)
          counts.gone++
          await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(row.subscription_id).run()
        } else {
          failing.add(row.subscription_id)
          counts.failed++
          if (row.attempts + 1 >= MAX_ATTEMPTS) {
            await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(row.id).run()
            counts.dropped++
          } else {
            await env.DB.prepare('UPDATE alerts SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run()
          }
        }
      }),
    )
  }

  // What the run saw but did not push, because its subscription failed earlier in the run.
  for (const row of candidates) {
    if (handled.has(row.id) || !failing.has(row.subscription_id)) continue
    if (gone.has(row.subscription_id)) {
      counts.gone++ // deleted with its subscription
      counts.due++
    } else {
      counts.skipped++
    }
  }
  return counts
}

/** The one log line for a run: counts only. */
export const formatRun = (c: RunCounts): string =>
  `scheduler run: due=${c.due} sent=${c.sent} failed=${c.failed} expired=${c.expired} gone=${c.gone} dropped=${c.dropped} skipped=${c.skipped}`

export interface MaintenanceCounts {
  sentAlerts: number
  staleSubscriptions: number
}

/** The once-a-day clean-up: old sent alerts, and subscriptions that haven't been seen for 30 days (with their alerts). */
export async function runMaintenance(env: Cloudflare.Env, now: number): Promise<MaintenanceCounts> {
  const sentAlerts = await deleteOldSentAlerts(env.DB, now)
  const staleSubscriptions = await deleteStaleSubscriptions(env.DB, now)
  return { sentAlerts, staleSubscriptions }
}

export const formatMaintenance = (c: MaintenanceCounts): string =>
  `daily clean-up: old_sent_alerts_deleted=${c.sentAlerts} stale_subscriptions_deleted=${c.staleSubscriptions}`
