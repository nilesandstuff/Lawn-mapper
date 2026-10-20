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
