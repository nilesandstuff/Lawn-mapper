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
-- The frame the photograph was actually taken on, which since H20 is not the
-- frame the phone displayed: the banked picture is captured at 10 cm a pixel
-- or better, so its zoom and size differ from the display's. NULL on every row
-- banked before that, and those were taken on `frame`.
ALTER TABLE corpus ADD COLUMN image_frame TEXT;

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

-- How much canopy is over the lawn, graded by eye during review.
--
-- Replaces inferring it from the exclusion list, which recorded a choice about
-- how the AI was run rather than anything about the lawn: the Trees box is off
-- by default and does not exist outside exclude mode, so a wooded lot traced by
-- hand counted zero.
--
-- 0 none, 1 some, 2 it decided where the lawn ended; NULL until judged. Only 2
-- counts toward the hard slice -- see schema.sql for why it is a grade rather
-- than the yes/no this column was named for. The name stays: an ALTER that
-- renames cannot run twice, and this file is re-run on every deploy.
ALTER TABLE corpus ADD COLUMN tree_line INTEGER;

-- When somebody last looked this map over for inferred areas.
--
-- The CREATE in schema.sql does nothing to a table that already exists, so
-- every deployed database needs this ALTER as well -- see the commit "CREATE
-- TABLE IF NOT EXISTS cannot add a column", which cost six deploys and looked
-- like a feature that had been switched off.
--
-- NULL means never checked, and that is deliberately different from "checked
-- and nothing was inferred". The shapes cannot tell those apart: no marks
-- means either nothing to mark or nobody asked. Without the distinction the
-- review queue would either never empty or never fill.
ALTER TABLE corpus ADD COLUMN inferred_checked_at TEXT;

-- The audition set: hand-traced lawns held back as an answer key, so a paid
-- stranger's first attempts can be SCORED rather than judged by eye.
--
-- The matching CREATE is in schema.sql and does nothing to a database that
-- already has the corpus table, which every deployed one does -- see the
-- commit "CREATE TABLE IF NOT EXISTS cannot add a column", which cost six
-- deploys and looked like a feature that had been switched off.
--
-- Zero rather than NULL, because "not an audition map" is the answer for
-- every row that existed before this, and there is no third state to keep.
ALTER TABLE corpus ADD COLUMN audition INTEGER NOT NULL DEFAULT 0;

-- How many AI passes one claimed lawn has been given for free.
--
-- A paid worker arrives signed out, from a crowd platform, where the
-- signed-out allowance is five passes a day for a whole browser -- and the
-- starting outline is the thing they are paid to CORRECT, so they have to be
-- able to get one. Raising the public allowance instead would hand the same
-- number to every visitor on the internet, which is real money.
--
-- The CREATE in schema.sql does nothing to a database that already has this
-- table, and this branch has been deployed -- see the commit "CREATE TABLE IF
-- NOT EXISTS cannot add a column", which cost six deploys and looked like a
-- feature that had been switched off.
ALTER TABLE lawn_jobs ADD COLUMN detections INTEGER NOT NULL DEFAULT 0;

-- How long one paid map actually took, claim to submission.
--
-- A compliance number rather than a curiosity: every crowd platform left after
-- MTurk decides whether a task underpays from the MEDIAN OBSERVED time, not
-- from the estimate the requester typed in. The submission already measures it
-- to enforce the ninety-second floor, so keeping it costs nothing -- and there
-- is nowhere else to get it, since the platform's own timing includes reading
-- the instructions and is a different number.
--
-- The CREATE in schema.sql does nothing to a database that already has this
-- table, and this one has been deployed.
ALTER TABLE lawn_jobs ADD COLUMN seconds INTEGER;

-- Where a worker came from, which decides what they see when they finish.
--
--   crowd      a paid stranger from a platform: needs a completion code
--   hired      engaged directly and paid hourly: no platform, so a code is a
--              puzzle rather than a receipt -- a running count instead
--   volunteer  followed a public link to help for nothing: no code, no gates,
--              no time floor
--
-- lawn_workers shipped one deploy before this column existed, so the CREATE in
-- schema.sql reaches new databases only.
ALTER TABLE lawn_workers ADD COLUMN kind TEXT NOT NULL DEFAULT 'crowd';

-- Where to send 75c a map, for somebody who came in through the paid public
-- link and traced lawns that were then approved.
--
-- On the account rather than in the link, which is the whole reason the paid
-- route goes through sign-in: in a URL a payment address is typed once per
-- device with no way to correct a typo, it sits in every access log the
-- request touches, and there is no second way to reach somebody when a
-- payment bounces.
--
-- NOT cleaned the way a worker id is. cleanWorker strips '@', which turns
-- dave@example.com into daveexample.com; a payment address has to survive
-- verbatim. `users` shipped long ago, so the CREATE reaches new databases only.
ALTER TABLE users ADD COLUMN payout_kind TEXT;
ALTER TABLE users ADD COLUMN payout_handle TEXT;
ALTER TABLE users ADD COLUMN payout_at TEXT;

-- WHICH LINK A WORKER ARRIVED ON, recorded on the job itself.
--
-- The route was computed on every claim -- it decides the gates, the daily cap
-- and what somebody sees when they finish -- and then discarded. So the "who
-- is tracing" page had nothing to read, and COALESCEd to 'crowd' for everybody
-- the owner had not hand-edited: seven volunteers listed as crowd workers on a
-- batch where no crowd link had ever been handed out.
--
-- Not cosmetic, because that row is also the editor. It opened with "Crowd"
-- already selected, and saving it wrote that as the stored truth -- which
-- routeFor prefers over the link, so a volunteer would start hitting crowd
-- gates at five maps.
--
-- NULL on every row claimed before this, and the page says "unknown" rather
-- than guessing. lawn_jobs shipped long ago, so the CREATE in schema.sql
-- reaches new databases only.
ALTER TABLE lawn_jobs ADD COLUMN route TEXT;

-- WHICH LAWNS ARE THE BENCHMARK. Every number in docs/DETECTOR-FINDINGS.md
-- from 2026-09-23 on was measured on the same 32 approved maps (fingerprint
-- 1rijjz2), and one map moves a table by up to ten points (H7). The corpus
-- has to grow, so those 32 are stamped here and the training, canopy and SAM
-- tools select by it (tools/lawn-set.js): LAWN_SET=benchmark is the default,
-- =all is everything, =new is only what arrived since. NULL means "not in the
-- frozen set", which every map approved after this is.
ALTER TABLE corpus ADD COLUMN cohort TEXT;

-- THE ONE DATA STATEMENT IN THIS FILE, and it is safe to run on every deploy
-- because its WHERE makes it so: only rows finished before the freeze, only
-- rows still unstamped. The second run finds nothing to do. A row finished
-- before the cutoff but approved after it WOULD be stamped by a later deploy;
-- train-detector.js checks the fingerprint of what it got against 1rijjz2
-- and says so if that ever happens.
UPDATE corpus SET cohort = 'benchmark-1rijjz2'
 WHERE cohort IS NULL AND status = 'approved' AND image_key IS NOT NULL
   AND frame IS NOT NULL AND at < '2026-09-24T16:30:00Z';

-- HOW NAIP LINES UP WITH MAPBOX, per map (see the column in schema.sql).
-- corpus shipped long ago, so the CREATE there reaches new databases only.
ALTER TABLE corpus ADD COLUMN naip_align TEXT;

-- NOT-LAWN TRACES, per map (see the column in schema.sql). corpus shipped
-- long ago, so the CREATE there reaches new databases only.
ALTER TABLE corpus ADD COLUMN not_lawn TEXT;

-- WHICH TRAINED-MODEL RELEASE DREW THE OUTLINE (see the column in schema.sql).
ALTER TABLE corpus ADD COLUMN model_version TEXT;

-- HOW UNSURE THE TRAINED MODEL IS ABOUT A QUEUED LOT (see schema.sql).
-- lawn_jobs shipped long ago, so the CREATE there reaches new databases only.
ALTER TABLE lawn_jobs ADD COLUMN uncertainty REAL;
ALTER TABLE lawn_jobs ADD COLUMN scored_model TEXT;
ALTER TABLE lawn_jobs ADD COLUMN scored_at TEXT;

-- SAVED BY AN ADMINISTRATOR (see the columns in schema.sql). corpus shipped
-- long ago, so the CREATE there reaches new databases only.
ALTER TABLE corpus ADD COLUMN admin_edited_at TEXT;
ALTER TABLE corpus ADD COLUMN admin_edited_by TEXT;

-- COUNTY PHOTOS: HOW EACH WAS LINED UP, AND OUTLINES TRACED ON IT (see the
-- columns in schema.sql). county_imagery shipped on 2026-10-01, so the
-- CREATE there reaches new databases only. tools/county-imagery.js runs these
-- too, since it can run before the deploy that would.
ALTER TABLE county_imagery ADD COLUMN reg_model TEXT;
ALTER TABLE county_imagery ADD COLUMN reg_affine TEXT;
ALTER TABLE county_imagery ADD COLUMN reg_inliers INTEGER;
ALTER TABLE county_imagery ADD COLUMN reg_patches INTEGER;
ALTER TABLE county_imagery ADD COLUMN reg_rms_m REAL;
ALTER TABLE county_imagery ADD COLUMN reg_confident INTEGER;
ALTER TABLE county_imagery ADD COLUMN reg_why TEXT;
ALTER TABLE county_imagery ADD COLUMN shapes TEXT;
ALTER TABLE county_imagery ADD COLUMN not_lawn TEXT;
ALTER TABLE county_imagery ADD COLUMN outlines_at TEXT;
ALTER TABLE county_imagery ADD COLUMN outlines_by TEXT;
ALTER TABLE county_imagery ADD COLUMN mapbox_shapes TEXT;
ALTER TABLE county_imagery ADD COLUMN mapbox_not_lawn TEXT;

-- THE PROPERTY LINE AS IT STOOD WHEN THE AI TRACED (see the column in
-- schema.sql). corpus shipped long ago, so the CREATE there reaches new
-- databases only.
ALTER TABLE corpus ADD COLUMN detected_parcel TEXT;

-- HOW MUCH THE PERSON DISAGREED WITH THE AI, by shape (see the column in
-- schema.sql), for the console's "Disagreed with the AI" filter.
ALTER TABLE corpus ADD COLUMN ai_wrong_pct REAL;

-- WHICH COUNTY PHOTO A MAP WAS MADE ON, AND HOW IT WAS LINED UP (see the
-- columns in schema.sql), so a reopened map shows the photo where its
-- outlines were drawn.
ALTER TABLE corpus ADD COLUMN county_svc TEXT;
ALTER TABLE corpus ADD COLUMN county_align TEXT;

-- EVERY MAP'S NUMBER, the C in C01 (see the column in schema.sql). Existing
-- maps are given theirs by tools/ci-prepare.js numberMaps, in the order they
-- were made.
ALTER TABLE corpus ADD COLUMN lot_no INTEGER;

-- EVERGREEN CROWNS AND LEAF-OFF PHOTOS (see the columns in schema.sql).
ALTER TABLE corpus ADD COLUMN evergreens TEXT;
ALTER TABLE corpus ADD COLUMN leaf_off INTEGER;
