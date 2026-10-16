-- How many times the scheduler has tried to push this alert and failed (not counting 404/410, which delete the
-- subscription). The scheduler tries first attempts before retries, and deletes an alert after its third failure.
--
-- Additive on purpose: the column has a default, so the Worker that is live while this migration applies (which
-- neither reads nor writes it) keeps working, and every existing alert starts at 0. Adding a column with a
-- constant default rewrites no rows. It is not indexed: an UPDATE of it writes one row, not one per index.
ALTER TABLE alerts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
