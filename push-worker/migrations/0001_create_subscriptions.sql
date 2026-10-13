-- One row per browser push subscription.
-- All timestamps are UTC, stored as integer milliseconds since the Unix epoch.
CREATE TABLE subscriptions (
  id          TEXT PRIMARY KEY,          -- random UUID, handed to the client
  endpoint    TEXT NOT NULL UNIQUE,      -- the push service URL for this browser
  p256dh      TEXT NOT NULL,             -- browser public key (base64url), used to encrypt payloads
  auth        TEXT NOT NULL,             -- browser auth secret (base64url), used to encrypt payloads
  secret_hash TEXT NOT NULL,             -- SHA-256 (hex) of the client's secret; the raw secret is never stored
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
