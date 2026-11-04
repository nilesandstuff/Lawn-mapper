-- ALTERs for tables of water/schema.sql that have already shipped (none yet). Each must be safe to run again:
-- the deploy runs this file every time, and an ALTER that fails because its column exists is ignored there.

-- 2026-11-04: which photo a visit's dots were put on (the lawn is traced on the county photo; Mapbox's sits about
-- half a meter from it, so the first visit's dots, placed on Mapbox, fall just off the trace)
ALTER TABLE moisture_visits ADD COLUMN placed_on TEXT;
