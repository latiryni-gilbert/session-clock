-- One row per scheduled notification. Deleted automatically with its subscription.
CREATE TABLE alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  fire_at         INTEGER NOT NULL,      -- UTC, integer milliseconds since the Unix epoch
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  sent_at         INTEGER                -- NULL until the alert has been sent
);

-- "Unsent alerts due before time X": WHERE sent_at IS NULL AND fire_at <= X ORDER BY fire_at.
-- Partial index: sent alerts drop out of it, so it stays small however many alerts have been sent.
CREATE INDEX idx_alerts_due ON alerts (fire_at) WHERE sent_at IS NULL;

-- Replacing a subscription's schedule, and the cascade on delete, look alerts up by subscription.
CREATE INDEX idx_alerts_subscription ON alerts (subscription_id);
