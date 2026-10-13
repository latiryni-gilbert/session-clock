// Constants live here, not in index.ts: a Worker's entry module may only export handlers.
export const SERVICE_NAME = 'session-clock-push'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_ALERTS = 500
export const MAX_SCHEDULE_DAYS = 15
export const MAX_TITLE_CHARS = 80
export const MAX_BODY_CHARS = 200
export const MAX_ENDPOINT_CHARS = 2048

// Must equal the `period` of the rate limiters in wrangler.jsonc.
export const RETRY_AFTER_SECONDS = 60

// Unchanged schedule uploads don't write at all, so last_seen_at would go stale for a user who only
// ever re-uploads the same schedule. Refresh it (one row written) at most once a day.
export const LAST_SEEN_REFRESH_MS = 24 * 60 * 60 * 1000

// Sent alerts are kept this long (for debugging) before cleanup may delete them.
export const SENT_ALERT_RETENTION_MS = 24 * 60 * 60 * 1000
export const CLEANUP_BATCH_SIZE = 1000

export const DAY_MS = 24 * 60 * 60 * 1000

// The most alerts one subscription may have added + removed per UTC day. A first upload is about 150 and normal
// days a few dozen, so this only stops a client stuck in a loop. Worth about 1,200 to 2,000 rows written a day.
export const MAX_DAILY_ALERT_CHANGES = 400
