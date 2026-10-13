import { CLEANUP_BATCH_SIZE, SENT_ALERT_RETENTION_MS } from './constants'

/**
 * Deletes alerts that were sent more than a day ago. Returns how many were deleted.
 *
 * The scheduler will call this (about once a day is plenty). It deletes at most `limit` rows per call so
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
