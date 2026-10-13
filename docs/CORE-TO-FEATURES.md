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
