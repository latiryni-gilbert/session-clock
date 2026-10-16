import { CLEANUP_BATCH_SIZE, SENT_ALERT_RETENTION_MS, STALE_SUBSCRIPTION_MS, STALE_SUBSCRIPTIONS_PER_RUN } from './constants'

/**
 * Deletes alerts that were sent more than a day ago. Returns how many were deleted.
 *
 * The daily clean-up calls this. Alerts the scheduler sends are deleted at once, not marked as sent, so this only
 * finds rows marked before that change; it stays so nothing is ever left behind.
 *
 * (About once a day is plenty.) It deletes at most `limit` rows per call so
 * that one call can't spend a large share of the daily write budget; call again if it returns `limit`.
 *
 * It has no index of its own (sent alerts are deliberately left out of the indexes, because every index
 * entry costs an extra written row), so it scans the alerts table. That costs rows *read*, which has a far
 * larger daily allowance than rows written, but it is why this should run daily and not every minute.
 */
export async function deleteOldSentAlerts(db: D1Database, now: number, limit = CLEANUP_BATCH_SIZE): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM alerts WHERE id IN (
         SELECT id FROM alerts WHERE sent_at IS NOT NULL AND sent_at < ?1 LIMIT ?2
       )`,
    )
    .bind(now - SENT_ALERT_RETENTION_MS, limit)
    .run()
  return result.meta.changes
}

/**
 * Deletes subscriptions whose app hasn't been seen for 30 days (last_seen_at is refreshed at least daily by any
 * upload), together with their alerts (ON DELETE CASCADE). Returns how many subscriptions were deleted. At most
 * `limit` a call, so a large backlog can't use up a day's writes at once; the rest go on later days.
 */
export async function deleteStaleSubscriptions(db: D1Database, now: number, limit = STALE_SUBSCRIPTIONS_PER_RUN): Promise<number> {
  // RETURNING, not meta.changes: D1's change count includes the alerts removed by the cascade, which would overstate it.
  const deleted = await db
    .prepare(
      `DELETE FROM subscriptions WHERE id IN (
         SELECT id FROM subscriptions WHERE last_seen_at < ?1 LIMIT ?2
       ) RETURNING id`,
    )
    .bind(now - STALE_SUBSCRIPTION_MS, limit)
    .all<{ id: string }>()
  return deleted.results.length
}
