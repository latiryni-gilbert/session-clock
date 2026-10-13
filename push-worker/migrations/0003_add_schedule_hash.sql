-- SHA-256 (hex) of the schedule most recently uploaded for this subscription.
-- PUT /schedule compares it with the new upload and skips all alert writes when they match.
-- NULL until the first upload. Adding a nullable column rewrites no rows, so this costs nothing to apply.
ALTER TABLE subscriptions ADD COLUMN schedule_hash TEXT;
