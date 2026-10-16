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

// The test notification (POST /test-push): what it says, and how long a push service may hold it for an offline device.
export const TEST_PUSH_TITLE = 'Session Clock'
export const TEST_PUSH_BODY = 'Background alerts are working.'
export const TEST_PUSH_TTL_SECONDS = 60

// --- The scheduler (the cron trigger that sends due alerts) ---

// An alert that is later than this when the scheduler finds it is skipped and deleted: a late session alert misleads.
export const LATE_LIMIT_MS = 10 * 60 * 1000

// How many pushes one run sends. The free plan allows about 10 ms of CPU per run and each push costs about
// 1 ms of encryption plus the request and the delete after it, so 3 leaves a wide margin (see README.md).
// `MAX_PUSHES_PER_RUN` in wrangler.jsonc overrides it, up to the limit below: a run makes at most 2 + 2N database
// queries and push requests, and the free plan allows 50, so N = 20 (42) is as high as it may go.
export const DEFAULT_PUSHES_PER_RUN = 3
export const MAX_PUSHES_PER_RUN_LIMIT = 20

// Alerts found already too late are deleted without a push, at most this many a run, so a backlog (after an
// outage, say) drains steadily and can never crowd out alerts that are still on time.
export const EXPIRED_PER_RUN = 20

// The cron expression for the once-a-day clean-up. Must equal the second entry in `triggers.crons` in wrangler.jsonc.
export const DAILY_CRON = '17 3 * * *'

// Subscriptions whose app hasn't been seen for this long are deleted by the daily clean-up, at most this many a day.
export const STALE_SUBSCRIPTION_MS = 30 * DAY_MS
export const STALE_SUBSCRIPTIONS_PER_RUN = 200
