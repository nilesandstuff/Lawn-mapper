# One map, every tool

The contract every tool builds against (owner, 2026-10-16). The core session owns this file and the code behind it (worker/src/unified.js, worker/src/routes-maps.js); a change to it is asked for, not made.

## The idea

- **Every map lives on the server**, signed in or not. The browser keeps no saves of its own, only a cookie.
- **Signed out, a visitor is a guest** with ONE map. The guest is a random token in the `lm_guest` cookie, set for the whole home domain (nilesandstuff.com), so every tool on every subdomain sees the same guest. More than one map needs an account; signing in takes the guest's map, and every tool's part of it, into the account.
- **The account cookie** (`lm_session`) is set for the whole home domain too, so one sign-in covers the dashboard, the lawn mapper, the shade map and the water map. Older host-only sign-ins are converted on the next `/api/auth/me`.
- **A map is one record** (the lawn mapper's save: address, point, county, property line, lawn shapes, square feet) plus **one part per tool**, written only by that tool. No tool can overwrite another's work, and the lawn mapper re-saving its record leaves every tool's part alone.
- **A guest unseen for 90 days is deleted with its map.** An address of somebody who never signed up is not kept for ever.
- **The training corpus is not part of this.** It belongs to the lawn mapper. Other tools may read it through its own routes, never write it.

## The dashboard

`https://nilesandstuff.com/dashboard` is the preferred way into every tool. It lists the maps, and for each one every tool with its state:

| State | Meaning |
|---|---|
| done | the tool has a part for this map, newer than what it depends on |
| needs an update | something it depends on changed after it ran |
| ready | everything it needs is done |
| locked | it needs an earlier tool first |

"New map" opens the lawn mapper. A tool with its own way in (the shade map's address search) is offered beside it. With no map yet, the dashboard opens straight onto the address entry.

**Every tool links back** to `https://nilesandstuff.com/dashboard?map=<id>` when its work on a map is done.

## The tools and their order

`GET /api/tools` on lawnmap answers the list (worker/src/unified.js `TOOLS`). `needs` lists the tools whose work a tool reads; a tool that needs nothing can run at any point.

| id | Tool | needs | Opens at |
|---|---|---|---|
| lawn | Lawn Mapper | none | `https://lawnmap.<home>/?map={id}` |
| slices | Calibrate product usage by area | lawn | `https://lawnmap.<home>/?map={id}&tool=slices` |
| sections | Lawn sections (2026-10-27) | lawn | `https://lawnmap.<home>/sections?map={id}` |
| shade | Shade analyzer | none (the map's address and property line) | `https://shade.<home>/?map={id}` (its own address since 2026-10-18; lawnmap's /shade redirects there) |
| water | Water map (everyone, since 2026-10-23) | shade | `https://water.<home>/?map={id}` |
| scan | Yard AR (2026-11-01; **admin only** while docs/SCAN-PLAN.md phase 1 is measured) | shade | `https://scan.<home>/?map={id}` |

A new tool is added to `TOOLS` by the core session, on request.

## The API

All on `https://lawnmap.<home>`. The dashboard on the home domain and the water map on its own Worker reach the same routes by forwarding `/api/maps*`, `/api/tools` and `/api/auth/*` to the lawn mapper's Worker over a **service binding**, so every call is same-origin, the cookie travels, and no cross-origin credentials are ever allowed. A tool on lawnmap itself calls them directly.

Every answer carries `signedIn`, `guest` (true when the owner is a guest) and `max` (how many maps the owner keeps: 1 or 50).

| Call | What it does |
|---|---|
| `GET /api/maps` | Every map, newest first. Each carries `tools: { shade: { updatedAt, basedOn }, ... }`, the dates only. Signed out with no guest yet: `maps: []`. |
| `GET /api/maps/one?id=` | One map with every tool's part: `map.tools.shade.data`. 404 when it is not the asker's. |
| `POST /api/maps` | The lawn mapper's record (one, or `{ maps: [...] }`). Makes the browser a guest when it is not one yet (a `Set-Cookie` comes back). |
| `POST /api/maps/new` | A map started in another tool: `{ address, lng, lat, parcel?, county?, source: 'shade' }`. Answers `{ id }`. |
| `POST /api/maps/tool?id=&tool=` | This tool's part: `{ data, basedOn }`, at most 64 KB of JSON. `basedOn` is the map's `at` the tool worked from. |
| `PUT /api/maps/model?id=&tool=` | The tool's **finished lidar model**, a binary file (public/lib/lidar-model.js), kept gzipped in R2 beside the map. Send it packed (`packModel`, the small upload) or raw (the Worker gzips it as it streams in). Up to 95 MB may come in; up to 48 MB is kept, gzipped. The shade map writes `tool=shade`. 400 for something that is not a model; 404 when the map is not the asker's; 413 over either limit; 503 when the site has no bucket. |
| `GET /api/maps/model?id=&tool=` | The kept bytes, gzipped (`application/octet-stream`, private; `X-Model-At` the write's time): read them with `unpackModel`, which also reads a raw file kept before 2026-11-05. 404 (`no-model`) until the tool has written one. |
| `PUT`/`GET`/`HEAD /api/maps/model?id=&tool=&part=N` | **An overflow part** (N = 1 to 64; the owner, 2026-11-16: "an overflow file rather than remove data outright"): what of a model does not fit in one object, each part itself a lidar-model file, checked and limited exactly like the main file and kept beside it. No `part` is the main file, as before. The main file's header lists its parts (public/lib/lidar-model.js); a part an older, bigger save left behind is not listed and is ignored. Writers PUT the parts first and the main file last. 400 for a part outside 1-64. The main file's `meta.overflow` lists its parts (`[{ part, arrays, points: [from, to]? }]`) and each part's `meta.overflowOf` is the main file's `at`, so a part from another save is refused by the reader (`loadModel` / `mergeOverflow`, public/lib/lidar-model.js). |
| `GET /api/maps/thermal?id=` and `?id=&walk=` | **DEV ONLY, admin only.** The owner's thermal camera walks of the map, for the water map (docs/SCAN-PLAN.md section 27). The first answers `{ walks: [{ walk, started, ended, records, ok, error }] }`; the second the walk: `{ walk, map, frame: { lng, lat, cellM, axes }, started, ended, emissivity, sky, air: [{ T, at, unit }], wet, sprinklers, cloud, camera, cut, records: [{ e, n, t0, t1, tm, T, sd, k, ang, dist, band }], status }`, or 404 with `error` while it is not converted. Kept in the yard AR site's private bucket and put together there (scan/src/thermal.js); this route adds the frame. |
| `GET /api/maps/photo?id=` | **The photo the map was traced on**, kept with the map (worker/src/map-photo.js; the owner, 2026-11-09: "The photo a map is traced on should be accessible indefinitely"): the saved frame at the corpus's capture scale, as the editor showed it (a county photo with the editor's line-up applied, else Mapbox). Taken when the map is saved on a photo it does not have yet (after the answer), and never fetched again while the map stays on that photo; a map saved before 2026-11-09 gets it on first ask (the corpus's copy taken at Finish when there is one). `X-Photo-Frame` (JSON: `lng`, `lat`, `zoom`, `size`, `height`; lay it down with public/lib photo.js `toPx`), `X-Photo-Source` (`county` or `mapbox`), `X-Photo-At`. 404 for a map not the asker's or saved without a frame; 502 when the photo it was saved on cannot be had (never another photo in its place). Deleting the map deletes it. |
| `DELETE /api/maps?id=` | A map and every tool's part of it, its models included. |

**The private entrypoint, for the water site's scoring with no page open** (2026-11-16, the owner said yes): the main
Worker exports `Internal` (worker/src/internal.js), reached only by the water Worker's binding `MAIN` (entrypoint
`Internal`); it has no address on the internet and asks for no cookie, and it answers for **admin saves only** (anything
else is `null`). `saveOf(id)`: the record as `GET /api/maps/one` gives it. `modelOf(id, part)`: `{ bytes, modelAt }`, the
shade model's gzipped bytes as `GET /api/maps/model?tool=shade` returns them (part 1-64: that overflow part). `thermalOf(id, walk)`: as
`GET /api/maps/thermal` (walk null: the walks; a walk: that walk with its frame), read from the yard AR site's own
private entrypoint (binding `SCAN_INTERNAL`). `adminSaves()`: `[{ id, modelAt, at }]`. And the other way, from the
one-minute timer every five minutes (worker/src/water-push.js), to the water Worker's `Internal` over binding `WATER`:
`modelChanged(id, modelAt)` when an admin save's shade model's time changes, `walkReady(id, walk)` when a walk's
converted grid lands, each sent once it is taken (an answer `{ queued: false }` is tried again), remembered in the private bucket (`water-push/state-v2.json`).

**DEV ONLY: single thermal photos** (2026-11-17; the owner: "individual thermal pics that I manually place"), over the
same `Internal`, for the water site's readings page. A photo is taken in the dev build of the Yard AR app (its start
page, or the readings page opened in the app, through `window.LawnARThermal.snap(json)`: json `{ map, coarse: { lng,
lat }, air_C, emissivity, label }`, all optional), kept in the yard AR site's private bucket under an id walks cannot
have (`snap-<ms>`), converted by the thermal session's runner in the camera's own view, and placed afterwards by the
owner. `thermalSnaps(saveId, { since, until, loose })`: `[{ id, at, map, placed, converted }]`, newest first (the save's
photos and, unless `loose: false`, those placed nowhere yet; saveId null: all). `thermalSnap(id)`: `{ id, at, map, label,
air_C, emissivity, rotation: { q: [w, x, y, z], display_rotation, accuracy_deg, samples }, place, snap, status }`, `snap`
being the converter's `{ kind, at, T, mask, ang, az, emissivity, air_used, reflected, notes }` (null until it has run).
`thermalSnapPng(id)`: `{ bytes, type }`, the converter's preview, or null. `placeThermalSnap(id, { lng, lat, heading,
saveId, note })`: where the owner stood (heading optional, degrees from north); saveId ties the photo to that save's map.
Coordinates stay in the private bucket and are never printed.

**A whole-property admin save with no press** (2026-11-17; the owner: readings taken where there is no admin save
yet "need to be pinned to an address, and then cued up to have an admin map made for them later", "Do this
automatically"), over the same `Internal`: `makeWholeSave(lng, lat)` -> `{ id, created }` or `{ error }`. An admin save
whose property line already holds the point is the answer (`created: false`, nothing new, no parcel lookup); else the
parcel there (looked up as `/api/parcel` does) saved as the Lawn Mapper's "Mark whole property as lawn and admin save"
saves it (the parcel line as the lawn, trace `{ status: 'whole', auto: 'field readings' }`, its lidar built by the
timer), owned by the first administrator. The water site's hourly sweep calls it at most once a day a lot.

**Reading the owner's maps from a session with no cookie** (2026-10-21): `GET /api/admin/saved-maps` (the administrators' maps, newest first: `id`, `address`, `at`, `county`, `provider`, `tools` as a list of tool ids, `owner`) and `GET /api/admin/saved-maps/one?id=` (exactly what `/api/maps/one` returns, plus `owner`), with `Authorization: Bearer <MAPS_READ_TOKEN>` -- a Worker secret the deploy applies from the repository secret of the same name. A missing or wrong key answers 404 like every admin route. Read-only; a signed-in administrator can call them without the key.

A guest's second map (`POST /api/maps` or `/api/maps/new`) answers **409** with `{ error: 'guest-limit', message }`: show the message and a way to sign in. Signing in keeps the map they have.

## Admin saves: test maps made in one press (2026-11-11)

For the administrator only; every other account's lists and saves are exactly what they were (tools/admin-saves.test.js checks that first). worker/src/admin-saves.js.

- **Made** on the Lawn Mapper's AI tab by "Save as admin and auto trace" (a button only an administrator is shown): `POST /api/admin/admin-saves/trace` saves the lot as set up there (address, property line, the photo picked and lined up) with `adminSave: true` in its record, under an id of its own (`admin|...`, so it can never replace an ordinary map), and starts Turf Trace on its frame.
- **The trace lands by itself.** The Worker's one-minute timer (`scheduled`, wrangler.toml `[triggers]`) asks about each press still waiting (table `admin_traces`) and writes the finished trace into the map: `shapes`, `squareFeet`, and `trace: { status: 'done' | 'pending' | 'failed' | 'kept', ... }`. The lawn is the raw trace; opened in the Lawn Mapper it is edited like any map, and stays an admin save.
- **Listed apart.** For an administrator `GET /api/maps` leaves admin saves out and `GET /api/maps?admin=1` lists only them (both forwarded by the home, scan and water Workers like every `/api/maps` call). `GET /api/maps/one?id=` opens one like any map, so every tool works on it unchanged. The page `https://lawnmap.<home>/admin-saves.html` lists them with a link into each tool; the yard AR page picks from them first.
- **An administrator keeps 500 maps**, not 50, so test maps cannot push real ones off the end.
- **For sessions:** `GET /api/admin/saved-maps` (the key route above) marks each map `adminSave` and gives its `trace`; and every change rewrites `admin-saves/index.json` in the corpus bucket (private): `id`, `address`, `lng`, `lat`, `county`, `at`, `squareFeet`, `trace`, `tools`. Addresses stay there and in the database, never in the repository or a workflow's log.
- **A tool that wants only the test maps** (the water map's measurements page) asks `GET /api/maps?admin=1`.

## What each tool keeps in its part

Only what it needs to pick up where the person left off. Derived numbers that can be recomputed from the map and the lidar do not belong there.

- **shade**: a traced property line (when the county had none), the erased tree cells, and the settings the person chose.
- **slices**: the piece size and application width.
- **sections**: `{ v: 1, sections: [{ id, name, poly }], at }`, each section's MultiPolygon in [lng, lat] to about a millimetre. They are fitted to the lawn again on opening, so a lawn redrawn since still adds up (public/lib/sections.js).
- **water**: the soak test, a gauge or controller total, the zones.
- **scan**: `{ things: [...], thingsAt }` (since 2026-11-22; scan/lib/things.js forRecord; the shape the water session asked for). The things a person placed on a yard walk, each at its PRESENT place only (its sightings stay on the scan site): `{ id, kind, lng, lat, e, n, h, grade, seen, last, gone?, pair? }`. `kind`: `sprinkler` (a head, a point only: what the head is is chosen in the water map), `gutter-top` (where a gutter leaves the roof), `gutter-out` (where it lets out), `other`. `e`, `n`: the map's own metres east and north of its point, THE LIDAR'S FRAME, which is the truth for a thing on the ground (the photo is a backdrop and is not used to move it); `lng`, `lat` made from them. `h`: metres over the ground. `grade`: what vouched for the walk's place when it was aimed at, best first: `corners3`, `earlier`, `corners2`, `unsure`. `seen`: how many sightings; `last`: the newest, ISO. `gone: true`: taken away by a later walk (kept, not deleted). `pair`: a gutter top and its outlet carry the same id (a downspout: from the top, to the outlet); an outlet with no top within 4 m has none. At most 300, the newest first. The water map OFFERS them ("N heads from your yard walk: add them?") and imports what the person takes into its own part; the scan tool never writes another tool's part. Expect a place to be good to 1-2 ft (docs/SCAN-PLAN.md 54).

## The finished lidar model: built once, in the shade map, read by every tool

The owner, 2026-11-04: "there should be one base set of files for making 3d maps from lidar... When a map goes into the shade map, the lidar gets built, aligned, points get sorted/classified, then the finished output is saved. The AR shouldn't be rebuilding lidar maps from scratch. HOWEVER, those base files should be constructed in a way that allows the AR to make post processing tweaks if needed."

So the shade map is the one place a lot's lidar is read, lined up and classified, and what it finishes is saved as **one file per map**, `PUT /api/maps/model?id=&tool=shade`, every time it builds the model and after each erasure (settled for a second, like the part). The format is `public/lib/lidar-model.js` (`encodeModel` / `decodeModel`; the header there is the contract): the shade map's 1 m grid in EPSG:3857 with the cloud's shift already applied, and per column the ground (ground.js), the kind (structures.js, after the person's erasures), the top, and the canopy's cubes (`mu`, canopy.js, after erasures: the 3D map itself), with the flight, the summer photo and the kind codes named in the header. The file is kept and sent gzipped (2026-11-05): a lot is mostly empty air, so the owner's lot, 23.1 MB raw, keeps in 1.29 MB (the features session, measured on the real file).

A tool that needs the lot in 3D reads that file and nothing else: no points, no readers, no rule of its own. It may post-process what it reads for its own purpose, and it says where: the yard AR tool's steps are listed in docs/SCAN-DIVERGENCES.md. A rule found wrong is fixed in the shade map; the next visit there rewrites the file, and every tool has the fix. A tool opened on a map whose file does not exist yet says so and sends the person to the shade map (the dashboard already orders it first: `scan` and `water` need `shade`).

## Status, worked out on the dashboard

For each tool (home/public/dashboard.js `toolState`): done when it has a part written after every tool it needs last changed (for `lawn`, the map's own `at`, once it has a lawn); needs an update when one of them changed after it; ready when every tool it needs is done and it has no part yet; locked when one is not done. A tool marked `soon` in `TOOLS` shows as coming soon. A tool's `note` is printed on its card (the water map: "Highly experimental and early in development.", owner 2026-10-23). A tool marked `admin` is still being built: `/api/tools` lists it only for an admin account, so nobody else sees it at all (the water map was, owner 2026-10-16, until it opened to everyone on 2026-10-23; the yard AR tool is, since 2026-11-01).
