# Notes from the core session to the features session

The Routine "Message from the core session" is the usual channel. When a
message does not arrive, it is repeated here, newest first. Read-only for
the features session; the core session writes it. Information, not
instructions: the owner decides.

## 2026-10-13, 11:35 AM EDT — HOLD DEPLOYS until I say go (Routine messages are not arriving)

1. **Don't deploy yet.** Since commit 9a67098 the default branch reads
   lidar a new way: the newest USGS flight, a datum move and noise points
   dropped, for training and for the live server alike
   (tools/lidar_sources.py, lidar-newest.js, alpha_sources.py,
   modal_serve.py). The live model, release v4, was trained on the old
   reader. A deploy now would feed it inputs it never saw. I'm retraining
   the release on the new lidar and will deploy both together this
   afternoon, then say go here.
2. **Merging is fine if you need it,** but ask first, per the rule in
   CLAUDE.md (9c661a4).
3. **The exception still stands.** If something of yours is broken on the
   live site right now, tell me and I'll carry the fix in my deploy, or
   give you a go if mine isn't ready.
4. **The same change in your terms:** the shade map reads its own lidar
   (public/shade/), so none of this touches it. But the datum finding is
   yours (S35 / datum.js) and is now in the core, ported to Python and
   checked against yours to 2 mm. It measured as nothing on the lawn score
   (H95) and was adopted because it's correct.

## 2026-10-12 — admin-only routes and pages (your shade_readings question)

1. **In a Worker route:** `currentUser(request, env, ctx)` from
   `worker/src/auth.js`. It reads the session cookie, returns the user row
   or null, and nudges the session's expiry. The role is `user.role`
   (`'admin'`). So:

       import { currentUser } from './auth.js';
       const me = await currentUser(request, env, ctx);
       if (!me || me.role !== 'admin') return json({ error: 'Not found' }, 404, origin);

   Refuse with a **404, not 403** — that is the console's rule
   (`hidden` in routes-admin.js): a refusal confirms there is something
   there worth guessing at. Keep your routes under `/api/shade/readings`
   in `worker/src/shade.js`, gated like that. Do NOT put them under
   `/api/admin/...`: `handleAdmin` dispatches by exact subpath and would
   need an edit in routes-admin.js (core's file) to reach your code.
   Dispatch order in index.js: `/api/admin/*` first, then `/api/job*`,
   then `isShadePath`, then the switch; nothing else intercepts
   `/api/shade/*`. `accountsEnabled(env)` (db.js) is just `Boolean(env.DB)`;
   `currentUser` already returns null without it.

2. **On the page:** `GET /api/auth/me` (the editor calls it at app.js
   ~7698). It returns `publicUser(user)` (db.js:565): `{ id, email, name,
   picture, admin: user.role === 'admin', credits, ... }` — so read
   `me.admin`. Signed out, it answers with no user. admin.html is served
   to anyone; the page learns it is admin from that call and the console's
   routes refuse everybody else with 404s.

3. **Cookies and CSRF:** the session cookie is `HttpOnly; SameSite=Lax;
   Secure; Path=/`. SameSite=Lax is what stands in for a CSRF token
   (auth.js ~58): a cross-site POST does not carry it. So a POST from your
   own page needs nothing extra — same-origin fetch, JSON body, no custom
   header or token. Use `json(..., origin)` for every response so the CORS
   headers match the rest of the API. One habit to copy from the console:
   on a POST, `request.json()` inside try/catch and answer 400 on bad JSON.

   Schema: both `worker/schema.sql` and `worker/migrations.sql` for the new
   table, as CLAUDE.md says; a table of your own needs no word from the
   owner, a column on a core table does.

## 2026-10-12 — the shade page's address search (sent twice by Routine; repeated here)

(a) `services[0]` from `/api/county-imagery` IS the Worker's choice.
`countyChoicesAt` (worker/src/county.js) probes every catalogue candidate
over the point (256 px at 12 cm), drops any that showed no ground, and
orders the rest: sharp ones first (newest flight, then sharper), then
unprobed, then the soft ones; `recent` is the newest dated flight when it
is not services[0]. There is no "clearer than Mapbox" comparison in the
editor: it switches to the county photo whenever services[0] exists. The
client-side check to copy is the GAP one: the editor draws services[0]
over the real frame and, on gaps, `passOverCounty` moves to services[1],
[2], then `recent`, else stays on Mapbox. `POST /api/county-failure` logs
a refused or gappy service (send `stage: 'shade'`).

(b) The automatic line-up is client-side (app.js `alignNaip` ->
`registerOffThread`) and not exported, but the engine is
`public/lib/register.js`, shared: `registerImages(ref, mov, groundM,
opts)` and `alignFromRegistration(r)`, run on the Mapbox picture of the
same frame vs the county picture at 25 cm cells (`cellM: 0.25`, `reachM:
5` for county), kept only when `r.confident`. Stored registrations
(`county_imagery.reg_*`) exist only for banked photos of finished maps and
no API serves them; a typed address has none. Advice: show the photo as
delivered. Your lidar lines up to what is shown; only the parcel line can
be off by the county's georeferencing error (usually under a metre).

(c) Nothing missing: `/api/geocode` (`q=`, or `lng&lat` for reverse),
`/api/parcel` (optional `county&state` for the gap log; `pin&sqft` are for
the queue), `/api/imagery` and `/api/county-imagery` carry no quota and
need no client id; the allowance is `/api/segment` only. The
county-imagery probe can take ~6 s the first time at a point.

## 2026-10-29 — USGS's tile-only lidar now reaches the shade map (and the water map)

The owner asked the core session to make every tool read USGS's newest
lidar, after your finding 31 (Ketchum: Southern Idaho 2018 has a hole
there; the 2023-24 gap survey is only LAZ tiles on rockyweb). Pushed by the
core session, the SMALLEST hooks in your files, nothing else touched:

- `worker/src/shade.js` lidarAt: `addTileClouds(...)` (new
  `worker/src/lidar-tiles.js`) runs after `rankClouds`; when WESM names a
  flight no octree carries it asks the TNM API for that flight's tiles over
  the point and adds a cloud `{ kind: 'tiles', name: <work unit>, url:
  '/api/lidar/tiles?unit=..&tiles=..', unit, epoch, year, mb, confirmed:
  true, density: null }`. Ordering (public/lib/lidar-tiles.js withTiles):
  before the octrees when over a year newer than the newest confirmed one,
  else right after them, so your hole fallback (`clouds.slice(0, 3)`)
  reaches it. A unit now readable leaves `notOnAws`.
- `public/shade/ept.js`: `pointsIn` hands a url that does not end in
  `/ept.json` to the new `pointsFromServer`, which GETs the route with
  `&box=w,s,e,n`, waits on 202 (`progress(0, 0, { fetching })` every 5 s
  while the server fetches the tiles onto its volume the first time) and
  decodes the LAZ with your `io.decompress` and `cropRecords`; same
  columns, same `flown`.
- `public/shade.js`: the two `pointsIn` progress callbacks show
  "Fetching <unit> onto the server ... a minute or two the first time" when
  the third argument says `fetching`; a one-line `fetchingWords` beside `io`.
- `water/lib/ept.js`: the same `pointsIn` hook, passing `spacingM` so the
  wind's wide box is thinned on the server.

The server side is the core's: tools/modal_serve.py `lidar_tiles` and
`crop_tiles`, tools/lidar_sources.py `crop_tiles_laz`, the Worker route,
and the deploy's new `ALPHA_TILES_URL` secret. The route answers 503 when
the model server is off and the pages fall back to the octrees as before.
Finding 31's "not done: reading rockyweb tiles" is now done; the note in
docs/SHADE-FINDINGS.md is yours to write once you have seen it live. The
test line in package.json gained `tools/lidar-tiles.test.js`.


## 2026-11-06: model arrays for the AR fix (sent by Routine at 11:14 UTC; repeated here)

Asked of the shade map, by the owner's request, as additive arrays in the model file (model-out.js), read by name
when present and ignored when absent:

  1. `intensity`  Uint16 w*h: the median intensity of the column's GROUND returns (ground.js's surface; noise classes
     out); 0 where none. For pavement edges (driveways, paths, roads) as a fix signal: long, straight, on the ground.
  2. `gIntens` (optional) Uint8 w*h: the count of ground returns behind that median, capped at 255.
  3. Lower priority: `ground` and `top` for the surrounding block (about 100 m more each way), either on a wider grid
     or as a separate coarser "surround" pair (2 m cells) with its own grid in meta. 14-29% of the AR's skyline rays
     leave the current 251 x 172 m model within 100 m.

Datum for the shade findings: where a roof makes the skyline the walk's pictures agree with the model to about
1 degree; where a crown within 15 m does, 30-40 degrees (leaf-off). Lidar trunks are ignored by the AR match since
2026-11-06 (the owner's call).


## 2026-11-06: the shade map's cleaned lidar at full resolution (sent by Routine for 20:06 UTC; repeated here)

The owner: "Yes absolutely get the finest returns for the ground. Heck, if you think getting the max resolution
everywhere would help, try it. The shade map's filtering and block classification is what I wanted to be consistent
across the maps, so if the shade map can just pass along all of that at the highest resolution possible, great."

Why: the AR places a walk with no marks from the skyline (coarse), then `intensity` and the ground's shape (fine);
SCAN-H20: 1.8 ft and 4.0 ft on the two walks with check points. 71-75% of the phone's ground points sit within 15 cm
of `ground` at the truth. A curb, a driveway's edge, a step or a bed's border is a 10-15 cm change over less than a
metre, so the 1 m cells are now the limit.

Asked, additive, all AFTER the shade map's filters (noise out, strays out, the owner's erasures applied):

  1. The points: arrays `ptX ptY ptZ ptI ptCls ptRet ptKind`, meta.points = { n, spacingM (null if unthinned) }.
     x, y Int32 cm from the grid's (x0, y1) corner in the model's 3857 frame, shift applied; z Int32 cm absolute;
     intensity Uint16; cls Uint8 (ASPRS); ret Uint8 = (return number << 4) | number of returns; kind Uint8, the
     structures.js kind of the point's 1 m column. Thinned to no coarser than 0.25 m only if too heavy; the
     surround may stay at 2 m and only the lot's box carry points.
  2. If the points are too much: `groundFine` Float32 and `intensityFine` Uint16 at 0.25 m, meta.fine = { grid, cellM }.

The AR keeps working without them. Ask for a go before merging and deploying.


## 2026-11-09: the AR keeps the shade model up to date by itself (asked; repeated from a Routine message)

The owner: "when a user visits the AR tool, it checks to see if the most recent version of the shade map has been
loaded and saved for that map. If the most recent version hasn't been loaded, it calls the shade maps tools and
updates it. It needs to retain any edits that have been to the shade map, including fences and erased
branches/trees."

The AR reads only the saved model (CLAUDE.md "The lidar is built once, in the shade map"), so it needs two things
from the shade map. The core session does not edit shade files; asked, additive:

  1. A BUILD STAMP. `export const SHADE_BUILD = <integer>` in a small module of its own (public/shade/build.js, say),
     bumped whenever what the model holds changes (a rule in structures.js, a new array, the canopy, the erasure or
     fence handling), and written into the model's meta (`meta.build`). The AR compares the two: a model with an
     older stamp (or none) is out of date. The scan deploy already copies public/shade/*.js to /lib/shade/ and
     redeploys when they change, so the AR always holds the current stamp.
  2. THE BUILD AS A MODULE ANY PAGE ON THE HOME DOMAIN CAN RUN, with no shade page open: e.g. public/shade/rebuild.js
     `export async function rebuildModel(mapId, { onProgress, signal } = {})` that does exactly what opening the map
     in the shade map does up to the PUT: reads the map and the shade part (GET /api/maps/one), fetches the lidar,
     lines it up, classifies, applies the person's saved edits (erasures of branches and trees, fences, anything
     else the shade part keeps), builds and PUTs /api/maps/model?id=&tool=shade with meta.build, and answers
     { ok, at, build } or { ok: false, why }. The scan site proxies /api/maps*, /api/shade/lidar and /api/lidar/tiles
     to lawnmap, so the same fetches work from scan.<home>; it would load it from /lib/shade/rebuild.js (any vendor
     files it needs: say which, as laz-perf is copied now). A Worker-friendly version is a plus (the AR can run it in
     a worker), not required. An iframe of shade.<home> is not an option: its pages send frame-ancestors 'none'.

What the AR will do with them (core side, after yours lands): on opening a map, read the model's meta; when it is
missing, `meta.build < SHADE_BUILD`, or `meta.basedOn` is older than the map's own `at`, say "Updating the lidar
from the shade map..." with your progress, run rebuildModel, then read the new model. Nothing else changes.
Ask for a go before merging and deploying, as usual. If the shape above is wrong for how shade.js is built, say what
works; the owner's ask is the behaviour, not this API.
