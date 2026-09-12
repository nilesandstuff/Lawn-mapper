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
  credits       INTEGER NOT NULL DEFAULT 0,
  -- The owner's account. Kept as a flag rather than a huge balance so the
  -- ledger below stays honest about what was actually spent.
  unlimited     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- One row per way of signing in to the same account.
--
-- Separate from users so that signing in with Google and then with a magic
-- link to the same address lands on ONE account rather than two. The email is
-- the identity; a provider is a door to it.
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,          -- 'google' | 'email' | ...
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
  kind        TEXT NOT NULL,          -- 'magic' | 'oauth'
  email       TEXT,
  data        TEXT,                   -- JSON: provider, verifier, next
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
  reason   TEXT NOT NULL,           -- 'welcome' | 'detect' | 'refund' | 'grant'
  detail   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user_at ON ledger(user_id, at DESC);
CREATE INDEX IF NOT EXISTS ledger_at ON ledger(at DESC);
