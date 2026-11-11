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
| `GET /api/maps/photo?id=` | **The photo the map was traced on**, kept with the map (worker/src/map-photo.js; the owner, 2026-11-09: "The photo a map is traced on should be accessible indefinitely"): the saved frame at the corpus's capture scale, as the editor showed it (a county photo with the editor's line-up applied, else Mapbox). Taken when the map is saved on a photo it does not have yet (after the answer), and never fetched again while the map stays on that photo; a map saved before 2026-11-09 gets it on first ask (the corpus's copy taken at Finish when there is one). `X-Photo-Frame` (JSON: `lng`, `lat`, `zoom`, `size`, `height`; lay it down with public/lib photo.js `toPx`), `X-Photo-Source` (`county` or `mapbox`), `X-Photo-At`. 404 for a map not the asker's or saved without a frame; 502 when the photo it was saved on cannot be had (never another photo in its place). Deleting the map deletes it. |
| `DELETE /api/maps?id=` | A map and every tool's part of it, its models included. |

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
- **scan**: nothing yet. From phase 3 (docs/SCAN-PLAN.md): the taps placed in AR (heads, downspouts, fence ends, trunks, each `[lng, lat]` with a confidence), the reference points and the walks. The water map will import the heads into its own part; the scan tool never writes another tool's part.

## The finished lidar model: built once, in the shade map, read by every tool

The owner, 2026-11-04: "there should be one base set of files for making 3d maps from lidar... When a map goes into the shade map, the lidar gets built, aligned, points get sorted/classified, then the finished output is saved. The AR shouldn't be rebuilding lidar maps from scratch. HOWEVER, those base files should be constructed in a way that allows the AR to make post processing tweaks if needed."

So the shade map is the one place a lot's lidar is read, lined up and classified, and what it finishes is saved as **one file per map**, `PUT /api/maps/model?id=&tool=shade`, every time it builds the model and after each erasure (settled for a second, like the part). The format is `public/lib/lidar-model.js` (`encodeModel` / `decodeModel`; the header there is the contract): the shade map's 1 m grid in EPSG:3857 with the cloud's shift already applied, and per column the ground (ground.js), the kind (structures.js, after the person's erasures), the top, and the canopy's cubes (`mu`, canopy.js, after erasures: the 3D map itself), with the flight, the summer photo and the kind codes named in the header. The file is kept and sent gzipped (2026-11-05): a lot is mostly empty air, so the owner's lot, 23.1 MB raw, keeps in 1.29 MB (the features session, measured on the real file).

A tool that needs the lot in 3D reads that file and nothing else: no points, no readers, no rule of its own. It may post-process what it reads for its own purpose, and it says where: the yard AR tool's steps are listed in docs/SCAN-DIVERGENCES.md. A rule found wrong is fixed in the shade map; the next visit there rewrites the file, and every tool has the fix. A tool opened on a map whose file does not exist yet says so and sends the person to the shade map (the dashboard already orders it first: `scan` and `water` need `shade`).

## Status, worked out on the dashboard

For each tool (home/public/dashboard.js `toolState`): done when it has a part written after every tool it needs last changed (for `lawn`, the map's own `at`, once it has a lawn); needs an update when one of them changed after it; ready when every tool it needs is done and it has no part yet; locked when one is not done. A tool marked `soon` in `TOOLS` shows as coming soon. A tool's `note` is printed on its card (the water map: "Highly experimental and early in development.", owner 2026-10-23). A tool marked `admin` is still being built: `/api/tools` lists it only for an admin account, so nobody else sees it at all (the water map was, owner 2026-10-16, until it opened to everyone on 2026-10-23; the yard AR tool is, since 2026-11-01).
