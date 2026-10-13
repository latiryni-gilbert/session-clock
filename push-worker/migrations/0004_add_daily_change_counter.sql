-- How many alerts a subscription has had added + removed on one UTC day, for the daily cap in PUT /schedule.
-- changes_day is the UTC day number (milliseconds since the epoch / 86,400,000); changes_count is the total for that day.
-- A day other than today means "nothing counted yet today", so the count resets by itself at 00:00 UTC.
--
-- Additive on purpose: both columns have defaults, so the Worker that is live while this migration applies
-- (which neither reads nor writes them) keeps working. Existing rows get day 0 (1970), i.e. a fresh allowance.
-- Adding a column with a constant default rewrites no rows.
ALTER TABLE subscriptions ADD COLUMN changes_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN changes_count INTEGER NOT NULL DEFAULT 0;
