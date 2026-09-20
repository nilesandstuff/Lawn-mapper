-- Lawns for the paid-queue browser test to hand out.
--
-- LOCAL ONLY. This is run against the local D1 that `wrangler dev --local`
-- keeps in .wrangler/state, never against the deployed database -- the test
-- claims, submits and skips these, and doing that to the real queue would
-- burn real lawns and put test maps in the corpus.
--
-- REAL COORDINATES, in Ottawa County, Michigan, which is the county the other
-- browser test already leans on because its parcel service answers. The point
-- of using a live county is that the test then exercises the same parcel
-- lookup and the same frame arithmetic a worker will -- and openJob goes
-- through confirmLocation, so a frame that is wrong here is wrong for a paid
-- worker too. If the county is down the app falls back to "trace the property
-- line yourself", which is also a path worth having on screen.
--
-- Five of them: one for the worker who finishes, one for the worker who skips,
-- one for the lawn the skip releases, and slack so a rerun that left rows
-- claimed does not empty the queue and turn every check into "nothing left".
INSERT INTO lawn_jobs (id, lng, lat, county, fips, parcel_sqft, state, created_at)
VALUES
  ('11110000-aaaa-4bbb-8ccc-dddddddddddd', -85.86610, 42.86740, 'Ottawa', '26139', 12000, 'approved', '2026-09-01T00:00:01Z'),
  ('11110001-aaaa-4bbb-8ccc-dddddddddddd', -85.86480, 42.86695, 'Ottawa', '26139',  9500, 'approved', '2026-09-01T00:00:02Z'),
  ('11110002-aaaa-4bbb-8ccc-dddddddddddd', -85.86350, 42.86810, 'Ottawa', '26139', 14500, 'approved', '2026-09-01T00:00:03Z'),
  ('11110003-aaaa-4bbb-8ccc-dddddddddddd', -85.86720, 42.86620, 'Ottawa', '26139',  8200, 'approved', '2026-09-01T00:00:04Z'),
  ('11110004-aaaa-4bbb-8ccc-dddddddddddd', -85.86230, 42.86905, 'Ottawa', '26139', 11000, 'approved', '2026-09-01T00:00:05Z'),
  -- Two more since the volunteer route was added: one for the helper to trace
  -- and send, one for the lawn they are handed after it.
  ('11110005-aaaa-4bbb-8ccc-dddddddddddd', -85.86150, 42.86580, 'Ottawa', '26139',  9800, 'approved', '2026-09-01T00:00:06Z'),
  ('11110006-aaaa-4bbb-8ccc-dddddddddddd', -85.86840, 42.86960, 'Ottawa', '26139', 13200, 'approved', '2026-09-01T00:00:07Z');
