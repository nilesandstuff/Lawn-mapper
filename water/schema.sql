-- THE WATER TOOL'S OWN DATABASE (water session), D1 "lawn-water", applied by .github/workflows/water-deploy.yml.
-- All CREATE ... IF NOT EXISTS: a column added to a table that has shipped also needs its ALTER in
-- water/migrations.sql (CLAUDE.md: "Schema changes need two edits, not one").

-- GAUGE READINGS (owner, 2026-10-20): a pressure measured at a sprinkler head with its zone running, beside
-- what the tool predicted there -- ground truth for the pressure model (lib/hydraulics.js). No addresses: the
-- map's id, never its street.
CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,              -- ms since 1970, when it was entered
  map_id TEXT,
  head_id TEXT,
  zone INTEGER,
  method TEXT,                      -- 'pitot' (in the stream: the nozzle's pressure) | 'riser' (on the riser, nozzle off)
  measured_psi REAL NOT NULL,
  predicted_psi REAL,               -- the prediction for that method: nozzle pressure for a pitot, the lateral's for a riser gauge
  predicted_inlet_psi REAL,
  predicted_nozzle_psi REAL,
  body TEXT, nozzle TEXT, kind TEXT,
  head_gpm REAL, zone_gpm REAL,
  source_psi REAL, source_read TEXT, source_from TEXT,
  typical_pvb INTEGER, typical_valve INTEGER,
  rise_ft REAL,                     -- ground at the head above the gauge at the backflow preventer (lidar)
  detail TEXT                       -- the worksheet and inputs, JSON
);
CREATE INDEX IF NOT EXISTS readings_at ON readings (at);
CREATE INDEX IF NOT EXISTS readings_map ON readings (map_id);

-- SOIL MOISTURE READINGS (owner, 2026-11-02: "tap a dot, then it prompts me for the reading... Then later we can run
-- the simulation and see how it holds up"): spot readings with a hand meter on a property, taken on the /moisture page,
-- ground truth for the water balance (lib/balance.js). One visit per save; its readings beside it. The property is its
-- county parcel number and the point found; never its street or house number. The admin only.
CREATE TABLE IF NOT EXISTS moisture_visits (
  id TEXT PRIMARY KEY,              -- made by the page, so saving again replaces the visit
  at INTEGER NOT NULL,              -- ms since 1970, when the visit began
  saved INTEGER NOT NULL,           -- when it was last saved
  lng REAL, lat REAL,               -- the property's pin
  parcel_pin TEXT, county TEXT,     -- the county's parcel number, when the property line was found
  map_id TEXT,                      -- a saved map on this property, if there is one
  meter TEXT,                       -- which meter
  unit TEXT,                        -- 'vwc' (% water by volume) | 'scale' (the meter's own scale) | 'surface_f' (surface temperature, F) | 'other'
  depth_in REAL,                    -- how deep the probe went
  note TEXT,
  weather TEXT,                     -- what the visitor said of the last days' weather, JSON (optional)
  placed_on TEXT,                   -- the photo the dots were put on: 'county:<svc>' (the one the lawn was traced on) or 'mapbox' (2026-11-04)
  air_f REAL                        -- surface-temperature visits: the air's temperature then, F, in the shade (2026-11-09)
);
CREATE INDEX IF NOT EXISTS moisture_visits_pin ON moisture_visits (parcel_pin);
CREATE INDEX IF NOT EXISTS moisture_visits_at ON moisture_visits (at);
CREATE TABLE IF NOT EXISTS moisture_readings (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  n INTEGER,                        -- the dot's number in the visit
  spot TEXT,                        -- the spot's id: the same spot read again on a later visit keeps its id
  at INTEGER,                       -- when it was read
  lng REAL NOT NULL, lat REAL NOT NULL,
  value REAL NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS moisture_readings_visit ON moisture_readings (visit_id);
-- marks made on a visit (2026-11-04): where a tree trunk stands, tapped on the readings page; ground truth for the
-- water map's trunk finder (water/lib/trunks.js), and the trunks the tree-root draw uses on a lawn that has them
CREATE TABLE IF NOT EXISTS moisture_marks (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  n INTEGER,
  kind TEXT NOT NULL,               -- 'trunk'
  lng REAL NOT NULL, lat REAL NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS moisture_marks_visit ON moisture_marks (visit_id);

-- THE MODEL AGAINST A VISIT'S READINGS (2026-11-04): worked out on the water map in the admin's browser (the readings
-- and their places never leave the database for anywhere else), kept here as numbers only, so the workflow's
-- "moisture" task can print it in a public log: no place, no point, no map id. One row per visit, replaced on each check.
CREATE TABLE IF NOT EXISTS moisture_checks (
  visit_id TEXT PRIMARY KEY,
  checked INTEGER NOT NULL,         -- when
  rho REAL,                         -- Spearman rank correlation, reading against the model's wetness, lawn spots only
  n INTEGER,                        -- how many lawn spots went into rho
  detail TEXT                       -- JSON: per spot { n, value, wet, zone, kind, need } and the run's settings
);

-- GROUND TRUTH BY PROPERTY (2026-11-15, src/truth.js): the Yard AR walks (thermal now, soil moisture and wind to
-- come), each tied for good to its map and parcel, the weather of its minutes frozen, and every comparison kept per
-- model version so the accumulated walks can be scored again as the model changes. No addresses, no coordinates.
CREATE TABLE IF NOT EXISTS truth_walks (
  walk TEXT PRIMARY KEY,            -- the walk's id, as the core's /api/maps/thermal names it
  map_id TEXT NOT NULL,             -- the map it was walked on
  parcel_pin TEXT,                  -- the parcel, when known: every map of one property
  source TEXT,                      -- 'thermal' (the Yard AR app's thermal camera) and later others
  started INTEGER NOT NULL,         -- ms
  ended INTEGER,
  kinds TEXT,                       -- what it measured: surface, moisture, wind (comma separated)
  notes TEXT,                       -- the walker's notes and the sky sweep's summary, JSON
  seen INTEGER                      -- when the water map first saw it
);
CREATE INDEX IF NOT EXISTS truth_walks_map ON truth_walks (map_id);
CREATE INDEX IF NOT EXISTS truth_walks_pin ON truth_walks (parcel_pin);
CREATE TABLE IF NOT EXISTS truth_weather (
  walk TEXT PRIMARY KEY,
  fetched INTEGER,                  -- when it was fetched and frozen
  sources TEXT,                     -- JSON: [{ name, km, rows, has }], never a station's position
  series TEXT                       -- JSON: [{ t, ta, rh, wind, cloud, ghi }]
);
CREATE TABLE IF NOT EXISTS truth_results (
  walk TEXT NOT NULL,
  model TEXT NOT NULL,              -- the model version that made the prediction
  kind TEXT NOT NULL,               -- surface | moisture | wind
  checked INTEGER,
  n INTEGER,                        -- records compared
  bias REAL,                        -- measured minus modelled, mean (C for surface)
  rmse REAL,
  rho REAL,                         -- rank correlation over the records
  detail TEXT,                      -- JSON: by angle band, by sun and shade, the settings
  PRIMARY KEY (walk, model, kind)
);

-- THE NO-PAGE SCORING'S QUEUE (2026-11-16, src/jobs.js): what the main site's timer pushes over its binding (an admin
-- save's shade model landed, a thermal walk converted), kept before it is worked on. No addresses, no coordinates.
CREATE TABLE IF NOT EXISTS kit_jobs (
  key TEXT PRIMARY KEY,             -- kind|map|walk
  kind TEXT NOT NULL,               -- model (the map's scoring kit to build) or walk (a walk to score)
  map_id TEXT NOT NULL,
  walk TEXT,
  model_at TEXT,                    -- the shade model's X-Model-At, for a model job
  queued INTEGER,
  state TEXT,                       -- queued, done, failed
  tries INTEGER,
  detail TEXT                       -- why it failed, or what it made
);
