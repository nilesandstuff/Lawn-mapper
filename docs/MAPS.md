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
| `DELETE /api/maps?id=` | A map and every tool's part of it. |

**Reading the owner's maps from a session with no cookie** (2026-10-21): `GET /api/admin/saved-maps` (the administrators' maps, newest first: `id`, `address`, `at`, `county`, `provider`, `tools` as a list of tool ids, `owner`) and `GET /api/admin/saved-maps/one?id=` (exactly what `/api/maps/one` returns, plus `owner`), with `Authorization: Bearer <MAPS_READ_TOKEN>` -- a Worker secret the deploy applies from the repository secret of the same name. A missing or wrong key answers 404 like every admin route. Read-only; a signed-in administrator can call them without the key.

A guest's second map (`POST /api/maps` or `/api/maps/new`) answers **409** with `{ error: 'guest-limit', message }`: show the message and a way to sign in. Signing in keeps the map they have.

## What each tool keeps in its part

Only what it needs to pick up where the person left off. Derived numbers that can be recomputed from the map and the lidar do not belong there.

- **shade**: a traced property line (when the county had none), the erased tree cells, and the settings the person chose.
- **slices**: the piece size and application width.
- **sections**: `{ v: 1, sections: [{ id, name, poly }], at }`, each section's MultiPolygon in [lng, lat] to about a millimetre. They are fitted to the lawn again on opening, so a lawn redrawn since still adds up (public/lib/sections.js).
- **water**: the soak test, a gauge or controller total, the zones.

## Status, worked out on the dashboard

For each tool (home/public/dashboard.js `toolState`): done when it has a part written after every tool it needs last changed (for `lawn`, the map's own `at`, once it has a lawn); needs an update when one of them changed after it; ready when every tool it needs is done and it has no part yet; locked when one is not done. A tool marked `soon` in `TOOLS` shows as coming soon. A tool's `note` is printed on its card (the water map: "Highly experimental and early in development.", owner 2026-10-23). A tool marked `admin` is still being built: `/api/tools` lists it only for an admin account, so nobody else sees it at all (the water map was, owner 2026-10-16, until it opened to everyone on 2026-10-23; none is marked now).
