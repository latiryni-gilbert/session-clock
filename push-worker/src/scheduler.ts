import { utf8 } from './base64url'
import { deleteOldSentAlerts, deleteStaleSubscriptions } from './cleanup'
import { DEFAULT_PUSHES_PER_RUN, EXPIRED_PER_RUN, LATE_LIMIT_MS, MAX_PUSHES_PER_RUN_LIMIT } from './constants'
import { sendWebPush } from './webpush'

// What the cron trigger does. Two things share this file: the every-minute run that sends due alerts, and the
// once-a-day clean-up. Neither ever logs an endpoint, key, secret or notification text, only counts.

interface DueRow {
  id: number
  fire_at: number
  title: string
  body: string
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * The due alerts in ONE query: up to ?3 that are still on time (oldest first, with the subscription's endpoint and
 * keys), and up to ?4 that are already too late (only their ids matter). Both halves use the partial index on
 * unsent alerts, so a run with nothing due reads next to nothing. ?1 is "now minus the lateness limit", ?2 is "now".
 * Fetching the late ones in the same query means a quiet minute still costs exactly one query.
 */
export const DUE_SQL = `
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

/** Per due alert, exactly one of: sent, failed (will be retried), expired (too late, deleted), gone (deleted with its subscription). */
export interface RunCounts {
  due: number
  sent: number
  failed: number
  expired: number
  gone: number
}

/**
 * One every-minute run: send the due alerts that are still on time, oldest first, as many as the batch allows.
 * - Sent: the alert is deleted at once (deleting costs less than marking it sent and deleting later).
 * - The push service says the subscription is gone (404/410): the subscription and its alerts are deleted.
 * - Any other failure: the alert stays and is tried again next run.
 * - More than 10 minutes late: deleted without a push.
 * A run with nothing due makes one database query and writes nothing.
 */
export async function runScheduler(env: Cloudflare.Env, now: number): Promise<RunCounts> {
  const cutoff = now - LATE_LIMIT_MS
  const { results } = await env.DB.prepare(DUE_SQL).bind(cutoff, now, pushesPerRun(env), EXPIRED_PER_RUN).all<DueRow>()
  const counts: RunCounts = { due: results.length, sent: 0, failed: 0, expired: 0, gone: 0 }
  if (results.length === 0) return counts

  // Too late: delete them first (one query), before the CPU-heavy part, so they go even if a run is cut short.
  const expired = results.filter((row) => row.fire_at < cutoff)
  if (expired.length > 0) {
    await env.DB.prepare('DELETE FROM alerts WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(expired.map((row) => row.id)))
      .run()
    counts.expired = expired.length
  }

  // Each alert is deleted as soon as its push succeeds, so a run that is cut off keeps what it got done.
  const deletingSubscription = new Map<string, Promise<unknown>>()
  await Promise.all(
    results
      .filter((row) => row.fire_at >= cutoff)
      .map(async (row) => {
        const tag = alertTag(row.id)
        const result = await sendWebPush(env, row, utf8(JSON.stringify({ title: row.title, body: row.body, tag })), {
          // The push service should drop it if it can't deliver before it would count as too late.
          ttl: Math.max(1, Math.floor((row.fire_at + LATE_LIMIT_MS - now) / 1000)),
          urgency: 'high',
          topic: tag,
        })
        if (result.kind === 'sent') {
          await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(row.id).run()
          counts.sent++
        } else if (result.kind === 'gone') {
          counts.gone++
          // Several due alerts for one dead subscription are deleted with it once.
          if (!deletingSubscription.has(row.subscription_id)) {
            deletingSubscription.set(row.subscription_id, env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(row.subscription_id).run())
          }
          await deletingSubscription.get(row.subscription_id)
        } else {
          counts.failed++ // stays for the next run
        }
      }),
  )
  return counts
}

/** The one log line for a run: counts only. */
export const formatRun = (c: RunCounts): string => `scheduler run: due=${c.due} sent=${c.sent} failed=${c.failed} expired=${c.expired} gone=${c.gone}`

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
