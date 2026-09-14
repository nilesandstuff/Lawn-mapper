-- Columns added to tables that already exist somewhere.
--
-- WHY THIS FILE HAD TO EXIST. schema.sql is written entirely in CREATE TABLE
-- IF NOT EXISTS, which is idempotent and therefore safe to run on every
-- deploy -- and which does NOTHING AT ALL to a table that is already there.
-- Adding a column to a CREATE statement changes what a fresh database gets
-- and leaves every existing one exactly as it was, silently, with the deploy
-- reporting "schema applied."
--
-- That is not hypothetical. `corpus` shipped on 14 September at 05:27 with
-- sixteen columns; image_key and image_provider were added to the CREATE four
-- hours later, and six successful deploys afterwards the live table still had
-- sixteen columns. Nothing failed. Rows kept saving, because the INSERT names
-- only the original columns. What broke was READING: the console's count
-- selected image_key, got "no such column", and reported the corpus as not
-- recording while it was quietly recording the whole time.
--
-- HOW TO USE IT. When you add a column to a table in schema.sql that has ever
-- been deployed, add the matching ALTER here as well. Both are needed: the
-- CREATE for new databases, the ALTER for the ones already out there.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so these are not written to be
-- individually safe -- running one twice is an error. ci-prepare runs them one
-- at a time and treats "duplicate column name" as already applied, which is
-- the same trick it uses for an R2 bucket that already exists. That makes the
-- FILE idempotent without any statement in it having to be.
--
-- Never edit a line here once it has been deployed; add a new one. And nothing
-- destructive: no DROP, no rename, no type change. A column added to the end
-- of a table is invisible to code that does not know about it, which is what
-- makes this safe to run against a live database from a phone.

-- The credit ledger started life counting one row per press. `units` records
-- how many AI passes that press actually bought, because exclude mode fires
-- several per press and a row count under-reports the Replicate bill.
ALTER TABLE ledger ADD COLUMN units INTEGER NOT NULL DEFAULT 1;

-- Where the aerial photograph for a finished map lives in R2, and which source
-- it came from. Null when no bucket was bound or the fetch failed -- the row
-- is still worth having, because the frame re-fetches.
ALTER TABLE corpus ADD COLUMN image_key TEXT;
ALTER TABLE corpus ADD COLUMN image_provider TEXT;
