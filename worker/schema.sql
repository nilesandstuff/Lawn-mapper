-- The account store.
--
-- WHY THIS IS SQL AND NOT THE KV NAMESPACE EVERYTHING ELSE USES.
--
-- Credits. A balance that is read, decremented and written back is a race, and
-- KV has no way to close it: two detections started a second apart both read
-- the same number and both write one less than it, and the second pass is
-- free. That is not a rare interleaving -- exclude mode fires several passes
-- per press, and a phone on a flaky connection retries. D1 is SQLite, so
-- "spend one credit if there is one" is a single statement whose own result
-- says whether it happened.
--
-- The rest follows the credits: an account's identity, sessions and saved maps
-- all want to be joined against and counted, which is a query here and a
-- full scan of a key prefix there.
--
-- IDEMPOTENT ON PURPOSE. Every statement is IF NOT EXISTS, so the deploy
-- workflow runs the whole file on every deploy and new tables simply appear.
-- A migration numbering scheme buys ordering guarantees this does not need
-- yet, and costs a step that has to be done right from a phone.

-- ---------------------------------------------------------------- people
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  -- Lowercased, and verified by construction: a magic link proves the address
  -- receives mail, and Google is only trusted when it says email_verified.
  -- An unverified address is never written here.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  picture       TEXT,
  -- 'user' or 'admin'. Admin is granted from the ADMIN_EMAILS setting at sign
  -- in, so the first one can be created from a phone with no SQL console.
  role          TEXT NOT NULL DEFAULT 'user',
  -- BOUGHT credits, which do not expire and are spent only once today's
  -- allowance is gone. See `allowances` below for the allowance itself, and
  -- for why the two are separate things rather than one number.
  credits       INTEGER NOT NULL DEFAULT 0,
  -- The owner's account. Kept as a flag rather than a huge balance so the
  -- ledger below stays honest about what was actually spent.
  unlimited     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- One row per way of signing in to the same account.
--
-- There is one door today -- an emailed link -- so this table has one row per
-- account and earns its keep on the day there are two. It is kept because the
-- alternative is a migration at exactly the moment somebody wants a provider
-- added, and because the shape is the thing that makes "one account, several
-- ways in" true rather than hoped for: the email is the identity, a provider
-- is a door to it.
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,          -- 'email' today
  subject     TEXT NOT NULL,          -- the provider's own stable id
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);

-- ---------------------------------------------------------------- sessions
-- Opaque and server-side, not a signed token.
--
-- A JWT in a cookie cannot be revoked without keeping a list of the revoked
-- ones, which is the table below with extra steps and a worse failure mode.
-- This way "sign out everywhere" is a DELETE.
--
-- The id stored here is a HASH of the cookie value. A leaked database backup
-- then contains no usable sessions, which is the same reasoning as not storing
-- passwords.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  seen_at     TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------- sign-in
-- Short-lived one-time state: a magic-link token, or an OAuth round trip.
--
-- IN SQL RATHER THAN KV, and this one is not a preference. KV is eventually
-- consistent: a magic link written in one datacentre and clicked from a phone
-- on a different network can be read before the write has propagated, and the
-- link reports itself invalid. Minutes-old state that must be readable
-- immediately and exactly once is the case KV is worst at.
--
-- `id` is a hash of the token, for the same reason sessions are.
CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  -- 'magic' today. Carried so a second sort of short-lived token cannot be
  -- spent as a sign-in link by handing it to the wrong endpoint.
  kind        TEXT NOT NULL,
  email       TEXT,
  data        TEXT,                   -- JSON: where to land afterwards
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at);

-- ---------------------------------------------------------------- the maps
-- A saved measurement, owned by an account so it follows the person rather
-- than the browser.
--
-- `key` is address + method + arithmetic, the same identity the local store
-- uses -- so re-measuring the same lot the same way updates that map instead
-- of piling up a third, and one address can hold both its find-grass and its
-- exclude-objects answer. UNIQUE(user_id, key) is what enforces that, rather
-- than the application remembering to.
CREATE TABLE IF NOT EXISTS maps (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  address      TEXT,
  lng          REAL,
  lat          REAL,
  county       TEXT,
  model        TEXT,
  mode         TEXT,
  square_feet  INTEGER,
  -- The whole save record, so restoring never depends on the columns above
  -- keeping up with what a measurement is made of.
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS maps_user_updated ON maps(user_id, updated_at DESC);

-- ---------------------------------------------------------------- credits
-- Every movement, so a balance can be explained rather than just asserted.
--
-- "Why do I have 12 credits" is the question this answers, and it is the
-- question that gets asked about anything people pay for. The balance on the
-- user row is the running total; this is what it is made of.
CREATE TABLE IF NOT EXISTS ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  delta    INTEGER NOT NULL,        -- negative is spending
  -- How many AI passes the row is about, whether or not they were charged.
  --
  -- Separate from `delta` because the owner's account is UNCHARGED, not
  -- unused: its detections move no balance and still cost real money at
  -- Replicate. Counting usage from `delta` alone would report the account
  -- doing the most detecting as doing none.
  units    INTEGER NOT NULL DEFAULT 0,
  -- 'detect' | 'refund' | 'grant'. ('welcome' appears in rows written before
  -- new accounts stopped getting a signing-up grant -- see allowance.js for
  -- why they no longer do. Kept readable rather than rewritten: a ledger that
  -- is edited to match today's rules is not a ledger.)
  reason   TEXT NOT NULL,
  detail   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user_at ON ledger(user_id, at DESC);
CREATE INDEX IF NOT EXISTS ledger_at ON ledger(at DESC);

-- ------------------------------------------------------------ the allowance
-- Today's free passes for one account.
--
-- AN ALLOWANCE IS NOT A BALANCE, which is why this is not another column on
-- `users`. A balance is a thing you own: spend it and it is gone until you get
-- more. An allowance is a thing you are lent daily: spend it and it is back in
-- the morning. Keeping both on one number would mean either credits that
-- evaporate overnight or an allowance that accumulates, and the second is the
-- one that turns "30 a day" into "300 if you wait a week and then run a
-- script".
--
-- So: this table resets, `users.credits` does not, and a detection spends this
-- one first. Which also makes a future paid top-up mean what people will
-- expect -- extra, on top of the free daily passes, not instead of them.
--
-- THE RESET IS A DATE STRING, NOT A CLOCK OR A CRON. `day` is the local
-- calendar day the count belongs to (America/Detroit -- see quota.js for why
-- the users' day and not UTC's). A row from yesterday is not stale data to
-- sweep up; it simply does not match today's key, so the spend below treats
-- the count as zero and overwrites it. There is nothing scheduled to fail.
--
-- `daily_limit` is a per-account override, NULL meaning "whatever the free
-- tier is today". It is what a business gets when the shared-address ceiling
-- is in its way, and setting it is also a statement that the account is
-- vouched for -- see allowance.js.
CREATE TABLE IF NOT EXISTS allowances (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  day          TEXT,
  used         INTEGER NOT NULL DEFAULT 0,
  daily_limit  INTEGER,
  updated_at   TEXT
);

-- ------------------------------------------------------------- the settings
-- Numbers the owner can change without a deploy.
--
-- These started as constants, then became repository variables, and both have
-- the same problem: changing one is a trip to a settings page and a deploy,
-- from a phone, to answer a question like "is five a day too mean". A number
-- nobody can adjust in the moment is a number that stays wrong.
--
-- Rows here WIN OVER the environment variables, which stay as the defaults --
-- so a fresh deployment has sensible numbers before anybody opens the console,
-- and clearing a row here goes back to them rather than to zero. See limits.js.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- -------------------------------------------------------------- the corpus
-- Finished lawn maps, kept to train a segmentation model on later.
--
-- NO ADDRESS AND NO USER ID, deliberately. A model needs a photograph and the
-- outline drawn on it; it does not need to know whose house it is. Storing the
-- parts that identify a person, in a table whose whole purpose is to be
-- exported and fed to something else later, would be collecting what cannot be
-- used and would have to be stripped before it ever left here. Coordinates are
-- unavoidable -- they ARE the training example -- but a lat/lng is a place and
-- a name attached to it is a person.
--
-- NO IMAGE EITHER, and that is the load-bearing decision. Mapbox and Google
-- both forbid storing their tiles, and Google's terms forbid training on their
-- content outright -- so a corpus of saved satellite images is one that cannot
-- legally be used for the thing it was collected for. What is stored instead
-- is the frame and the outline, a few KB rather than a megabyte, and the
-- picture is re-fetched from NAIP when a training set is actually built. NAIP
-- is USDA aerial imagery: US federal work, public domain, free to store,
-- train on and redistribute. It is already a provider in this app.
--
-- That also keeps the corpus flexible in a way stored pixels would not: the
-- same rows render at 512px this year and 1024px next, at whatever resolution
-- the model of the day wants, from rasterizePolygon.
--
-- WHAT MAKES A ROW WORTH TRAINING ON is not recorded as a verdict, because the
-- answer changes as the idea of a good example changes. The SIGNALS are stored
-- and the filtering happens at export: `provider` says whether the imagery can
-- be re-fetched compatibly, `hand_edited` says a person touched it, and
-- `detected_sq_ft` against `square_feet` says by how much. A map the AI drew
-- and nobody corrected is the model's own output handed back to it, which
-- teaches it nothing and launders its mistakes into ground truth.
CREATE TABLE IF NOT EXISTS corpus (
  -- Place plus method, so re-finishing the same lawn updates its row instead
  -- of piling up near-duplicates that would all land in one training batch.
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  lng            REAL,
  lat            REAL,
  county         TEXT,
  -- Which imagery the person was looking at when they drew this. The export
  -- filter, not a detail: see above.
  provider       TEXT,
  model          TEXT,
  mode           TEXT,
  hand_edited    INTEGER NOT NULL DEFAULT 0,
  -- What the detector said before anyone edited it. NULL when the lawn was
  -- drawn entirely by hand, which is a perfectly good training example and a
  -- different kind from a correction.
  detected_sq_ft INTEGER,
  square_feet    INTEGER,
  parcel_sq_ft   INTEGER,
  -- The frame is what makes the row re-renderable: centre, zoom and size are
  -- exactly what imagery.js needs to fetch the same photograph again.
  frame          TEXT,
  parcel         TEXT,
  shapes         TEXT NOT NULL,
  -- WHAT THE DETECTOR ITSELF DREW, before anybody edited it.
  --
  -- `detected_sq_ft` above records how far the answer MOVED; this records
  -- where it was wrong, which is a different and more useful question. The
  -- known fault is a tree line overshooting by roughly a quarter, and you
  -- cannot measure an overshoot from two totals -- you need both outlines to
  -- see that one sits outside the other along the canopy edge.
  --
  -- It is also the only way to calibrate a fix without training anything: with
  -- a few dozen of these, the overshoot can be measured per provider and per
  -- mode and trimmed back in post-processing, which is days of work against
  -- months for a model.
  --
  -- Unrecoverable if not caught here. The outline is edited IN PLACE, so by
  -- the time somebody presses finish the detector's own answer is gone.
  -- NULL when the lawn was drawn entirely by hand.
  detected_shapes TEXT,
  -- Did the property line come from a county record or a person tracing it?
  --
  -- The boundary is the one thing this app never guesses, and the whole
  -- training plan leans on that: the model is scored only inside it. A traced
  -- line is a person's best guess and a county line is a record, so the two
  -- are not equally good ground truth and a corpus that could not tell them
  -- apart would quietly mix them.
  parcel_source  TEXT,
  -- Which exclusion prompts ran, e.g. "woods,driveway". The nearest thing to a
  -- "was this a hard one" flag the app knows: a lawn needing the woods prompt
  -- is a lawn with a tree line, and the hard slice of the eval is mostly those.
  exclusions     TEXT,
  -- Where the aerial photograph is in R2, and which source it came from.
  --
  -- TWO COLUMNS BECAUSE THEY DISAGREE. `provider` above is what the person was
  -- LOOKING AT when they drew the outline; this is what was actually stored to
  -- pair with it, and for Google they are not the same -- Google's terms are
  -- the restrictive ones, so a lawn drawn on Google is banked against the
  -- Mapbox tile for the same frame instead. A training set that assumed one
  -- field meant both would silently mix a mask drawn on one photograph with a
  -- different photograph of the same place and never say so.
  --
  -- NULL when no bucket is bound, or the fetch failed. The row is still worth
  -- having: the frame re-fetches.
  image_key      TEXT,
  image_provider TEXT,
  -- Has a person looked at this one and said it is good?
  --
  -- 'new' until reviewed, then 'approved' or 'rejected'. Only approved rows
  -- are training data; the rest are candidates. A rejected row is KEPT rather
  -- than deleted -- it cost a real measurement, the judgement may be revisited,
  -- and "we looked and said no" is worth more than a gap where a row was.
  --
  -- Re-finishing a map resets this to 'new', because an approval is of the
  -- OUTLINE and editing the outline invalidates it. That is also the review
  -- edit flow working as intended: tweak, finish, approve the tweaked one.
  status         TEXT NOT NULL DEFAULT 'new',
  -- Does this property actually have a tree line? Judged by eye during review.
  --
  -- NOT INFERRED FROM THE EXCLUSION LIST, which is what it used to be and was
  -- wrong. `exclusions LIKE '%woods%'` records that somebody ticked the Trees
  -- box during an exclude-mode detection -- a choice about how the AI was run,
  -- off by default, and unavailable at all in Find-grass or hand-drawn mode. A
  -- wooded lot traced by hand counted zero, so the number stayed near zero
  -- while the corpus filled with exactly the lawns it was supposed to find.
  --
  -- A person looking at the photograph can answer it in a moment, and review
  -- is already that moment. NULL until judged, so "no canopy" and "not looked
  -- at yet" stay different answers.
  --
  -- A GRADE, NOT A FLAG, and the name is older than the meaning:
  --   0  none -- the edge of the lawn is plainly visible
  --   1  some -- canopy overhangs, the edge was still readable
  --   2  it decided the edge -- the boundary under there was a judgement
  --
  -- Only 2 counts toward the hard-slice target. "Has a tree line" could not be
  -- answered: a row of trees, or any canopy that makes the cover ambiguous?
  -- The second is what the slice is for, and on a wooded street it is true of
  -- every lawn -- so as a yes/no it would have been yes everywhere and counted
  -- nothing. See docs/training-data.md, Rule 5.
  --
  -- The COLUMN keeps its name. Renaming it would mean an ALTER that cannot run
  -- twice, and migrations.sql has to survive being re-run on every deploy.
  tree_line      INTEGER,
  reviewed_at    TEXT,
  reviewed_by    TEXT,
  review_note    TEXT,
  -- WHICH QUEUE SURFACED THIS, and it decides what the row may be used for.
  --
  -- 'priority' means it was picked BECAUSE it looked valuable -- a correction,
  -- a tree line, a thin county. Exactly right for training and disqualifying
  -- for the representative half of the eval, which has to look like ordinary
  -- use and cannot be assembled from maps chosen for being interesting.
  --
  -- 'random' means it came up in a blind draw, so it carries no selection of
  -- its own and the representative slice is built from these.
  review_queue   TEXT,
  created_at     TEXT NOT NULL
);
-- The index over `status` lives in migrations.sql, NOT here, and the reason is
-- an ordering deadlock that cost a deploy: on a database that already has a
-- corpus table, CREATE TABLE IF NOT EXISTS adds no columns, so indexing
-- `status` from this file fails -- which aborts the whole schema run, which
-- skips the migrations that would have added the column. Anything indexing a
-- migrated column has to sit after the ALTER that creates it.
CREATE INDEX IF NOT EXISTS corpus_at ON corpus(at DESC);
-- The export query: usable imagery, actually corrected, newest first.
CREATE INDEX IF NOT EXISTS corpus_pick ON corpus(provider, hand_edited, at DESC);

-- ---------------------------------------------------------------------------
-- WHERE PEOPLE ASKED FOR A PROPERTY LINE AND THERE WAS NONE.
--
-- The counties list is a guess about where the customers are. This is the
-- measurement: every address somebody actually typed that came back with no
-- boundary, grouped by the county it was in. A county at the top of this table
-- with real people behind it is worth a morning in workflow 3; one nobody has
-- ever asked for is not, however easy its server would be to add.
--
-- ONE ROW PER (county, state, person), NOT ONE PER LOOKUP.
--
-- Two numbers were asked for and they need different things. Hits is a sum, so
-- a counter serves it. Unique people cannot be recovered from a counter at
-- all -- it needs the identities kept apart -- and keeping one row per lookup
-- to get it would grow without limit for a table that is only ever read as an
-- aggregate. Keying on the person gives both exactly: SUM(hits) is the first,
-- COUNT(*) within a county is the second, and the row count is bounded by
-- counties times people rather than by traffic.
--
-- `covered` is whether a county was CONFIGURED and still gave nothing, which
-- is a different job from one that is missing entirely: the first is a server
-- to look at, the second is a county to add. Stored as a max over the group,
-- because a county that has ever answered is configured.
CREATE TABLE IF NOT EXISTS parcel_gaps (
  county    TEXT NOT NULL,
  state     TEXT NOT NULL,
  -- The account id when signed in, the browser's own client id otherwise.
  -- Never an address and never an IP: this answers "how many people", and the
  -- rest of the row is already the only part anybody needs.
  who       TEXT NOT NULL,
  hits      INTEGER NOT NULL DEFAULT 0,
  covered   INTEGER NOT NULL DEFAULT 0,
  first_at  TEXT NOT NULL,
  last_at   TEXT NOT NULL,
  PRIMARY KEY (county, state, who)
);
CREATE INDEX IF NOT EXISTS parcel_gaps_place ON parcel_gaps(state, county);
