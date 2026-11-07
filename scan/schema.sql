-- THE YARD AR TOOL'S OWN DATABASE (core session), D1 "lawn-scan", applied by .github/workflows/scan-deploy.yml.
-- All CREATE ... IF NOT EXISTS: a column added to a table that has shipped also needs its ALTER in
-- scan/migrations.sql (CLAUDE.md: "Schema changes need two edits, not one").

-- WALKS (owner, 2026-11-01: "save logs for the admin page so I don't need to copy and paste them"): each
-- walk's results as the page makes them (scan/lib/walk.js summary): distances and counts, no positions, no
-- addresses. Replaced when posted again with the same id.
CREATE TABLE IF NOT EXISTS walks (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,              -- ms since 1970, when the walk began
  engine TEXT NOT NULL,             -- 'webxr' | '8thwall' | 'native' (the Android app)
  phone TEXT,                       -- the browser's user agent string
  json TEXT NOT NULL                -- the summary
);
CREATE INDEX IF NOT EXISTS walks_at ON walks (at);

-- THE ANDROID APP'S PAIRING (src/app.js, 2026-11-07): Chrome, signed in, leaves its session here under a random code
-- for five minutes; the app's WebView claims it once. A new table, so no ALTER is owed in migrations.sql.
CREATE TABLE IF NOT EXISTS app_pairs (
  token TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  expires INTEGER NOT NULL          -- ms since 1970
);
