-- ALTERs for tables of water/schema.sql that have already shipped (none yet). Each must be safe to run again:
-- the deploy runs this file every time, and an ALTER that fails because its column exists is ignored there.

-- 2026-11-04: which photo a visit's dots were put on (the lawn is traced on the county photo, and Mapbox's sits about
-- half a meter from it, so the first visit's dots, placed on Mapbox, fall just off the trace). NO SEMICOLON IN A
-- COMMENT HERE: tools/d1.mjs splits this file on them (it strips comments first since 2026-11-04, after one in this
-- very comment cut the ALTER in two and the readings page saved 500s for six hours).
ALTER TABLE moisture_visits ADD COLUMN placed_on TEXT;

-- 2026-11-09: surface-temperature visits carry the air's temperature at the time, F
ALTER TABLE moisture_visits ADD COLUMN air_f REAL;
