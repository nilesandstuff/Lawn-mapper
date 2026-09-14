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

-- What the detector drew before anybody edited it, which was being thrown
-- away: the outline is edited in place, so `detected_sq_ft` recorded how far
-- the answer moved and nothing at all about WHERE it was wrong. Measuring the
-- tree-line overshoot needs both outlines, not two totals.
ALTER TABLE corpus ADD COLUMN detected_shapes TEXT;

-- Whether the property line came from a county record or a person tracing it.
-- The model is scored only inside that line, so the two are not equally good
-- ground truth and the corpus has to be able to tell them apart.
ALTER TABLE corpus ADD COLUMN parcel_source TEXT;

-- Which exclusion prompts ran. The nearest thing to a "hard one" flag: a lawn
-- that needed the woods prompt is a lawn with a tree line.
ALTER TABLE corpus ADD COLUMN exclusions TEXT;

-- Review state. Only approved rows are training data; the rest are candidates.
-- Rejected rows are kept, not deleted: they cost a real measurement and "we
-- looked and said no" is worth more than a gap where a row used to be.
ALTER TABLE corpus ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE corpus ADD COLUMN reviewed_at TEXT;
ALTER TABLE corpus ADD COLUMN reviewed_by TEXT;
ALTER TABLE corpus ADD COLUMN review_note TEXT;

-- Which queue surfaced the row, which decides what it may be used for. A row
-- picked BECAUSE it looked valuable cannot sit in the representative half of
-- the eval, which has to look like ordinary use.
ALTER TABLE corpus ADD COLUMN review_queue TEXT;

-- Indexes over migrated columns belong HERE, after the ALTER, not in
-- schema.sql. Putting this one there aborted the schema run on every database
-- that already had a corpus table -- and the migrations it was blocking were
-- the ones adding the column it indexes. CREATE INDEX IF NOT EXISTS is
-- idempotent, so this is safe on a fresh database too.
CREATE INDEX IF NOT EXISTS corpus_status ON corpus(status, at DESC);
