# Lawn Mapper

Measures a lawn's square footage from an address: geocode → confirm location
→ pull the parcel boundary from county GIS (or let the user draw it) → AI
proposes the lawn shape inside that boundary → user corrects it → export.

Standalone project for now; intended to fold into lawn-answers.com later.

**Deploying it? Follow [DEPLOY.md](DEPLOY.md).** It needs only a phone browser:
the build, the pre-deploy checks and the deploy all run as GitHub Actions you
trigger from the repo's Actions tab.

## Repo layout

```
worker/src/   Cloudflare Worker -- the API
public/       The website, served by that same Worker as static assets
public/lib/   Maths shared by both sides (area, projection, mask tracing)
tools/        Tests, the county-server probe, and the CI helpers
.github/      The two workflows that check and deploy the project
wrangler.toml One config; one deploy ships the API and the site together
```

The site and the API are one Worker on one origin. That means no CORS to
configure, no second deploy target that can drift out of sync, and the browser
can read the AI mask off a `<canvas>` without it being tainted cross-origin.

## Status: complete and deployable, pending live checks

The whole path works — address in, corrected lawn polygon and square footage
out, exportable as PNG or PDF. What has *not* been verified is anything
requiring a network call, because neither environment that wrote this code had
outbound access.

Those checks live in **`.github/workflows/preflight.yml`**, which runs on a
GitHub runner that does have access: it re-runs the offline tests, confirms the
Replicate model still exists (reading the slug out of `worker/src/index.js`, so
it checks what the code actually calls), and probes the four county GIS
servers. Run it before the first deploy and whenever lookups start failing.

## Deploying

Two manual workflows, both triggered from the Actions tab:

| Workflow | Does |
|---|---|
| **1. Preflight checks** | Tests, Replicate model check, county GIS probe. Read-only. |
| **2. Deploy** | Tests, resolves the KV namespace, deploys, applies the API keys. |

`tools/ci-prepare.js` fills in the two values that would otherwise need a
terminal — the KV namespace id (found or created via the deploy token) and the
custom-domain route (from a `CUSTOM_DOMAIN` repository variable). It only
rewrites the runner's checkout; the committed `wrangler.toml` keeps its
placeholder. Its parsing and rewriting are unit-tested, because a failure there
surfaces as a confusing red workflow for someone with no way to debug it.

### The API (`worker/src/`)

| Endpoint | Purpose | Costs money |
|---|---|---|
| `/api/config` | Hands the browser the public Mapbox token | no |
| `/api/geocode` | Address → up to 5 candidates, flagged by coverage | no |
| `/api/parcel` | Point → county parcel boundary, or null | no |
| `/api/imagery` | Satellite PNG for a fixed frame | no |
| `/api/mask` | Proxies the AI mask back same-origin | no |
| `/api/segment` | SAM 2 lawn detection | **yes** — quota'd |
| `/api/quota` | Remaining daily allowance | no |

`/api/mask` only accepts `replicate.delivery` URLs. Without that check it would
be an open proxy able to reach hosts only visible from Cloudflare's network.

### The frontend (`public/`)

Plain ES modules, no build step — what is in the folder is what runs. Mapbox
GL JS and Mapbox GL Draw load from Mapbox's CDN.

The flow deliberately puts a **confirm-your-house step before anything slow or
billable**. A geocode that lands one street over yields a number that looks
entirely credible and is wrong, and no amount of downstream care recovers from
it.

`public/lib/mask.js` is the part the earlier revision of this README listed as
unbuilt: it turns SAM's raster mask into editable polygons, tracing enclosed
holes as interior rings so a lawn that wraps around a house doesn't bill the
roof as turf, and keeping detached patches (front yard, back yard) as separate
shapes the user can delete independently. `tools/mask.test.js` measures every
synthetic case against the frame's known ground resolution.

## Known gaps (documented limitations, not bugs)

- **Newaygo County**: no confirmed public ArcGIS REST endpoint. Addresses there
  fall through to manual drawing — same path as anywhere outside the footprint,
  so nothing breaks. Closing it means calling their GIS office.
- **Layer indexes and field names for Kent, Allegan and Muskegon** are educated
  values from published service metadata, not live-verified. Run
  `npm run probe:counties` before trusting them.
- **The Replicate model slug** (`meta/sam-2`) needs a live check against
  Replicate's catalogue — model identifiers do get renamed. The preflight
  workflow checks this; it is the single most likely thing to be stale.
- **`TILE_SIZE` in `public/lib/mercator.js`** encodes how wide Mapbox considers
  the world at a given zoom. Getting it wrong scales every AI-detected area by
  4x. The app cross-checks it against Mapbox GL's own projection at runtime and
  logs a specific console error on a mismatch, but the assumption itself is
  unverified offline. The "Show the raw AI mask" checkbox makes it visible: a
  correctly georeferenced mask sits exactly on the grass it traced.
- **Quota is a cost guardrail, not enforcement.** Clearing site data or
  changing network gets a fresh allowance. It exists to stop a script running
  thousands of predictions overnight, and it is a read-then-write against KV,
  so a burst of simultaneous requests can slip past the limit by a small margin.

## Development

```bash
npm install
npm test               # area maths, mask tracing, CI config -- fully offline
npm run dev            # http://localhost:8787, site and API together
npm run probe:counties # live check of the county GIS servers
npm run deploy
```

None of this is required to deploy — see DEPLOY.md. If you do have a terminal,
`npm run dev` needs the two secrets in a `.dev.vars` file at the repo root
(already gitignored):

```
MAPBOX_TOKEN=pk....
REPLICATE_TOKEN=r8_...
```

## The one rule that matters most

Never compute area from projected map coordinates (Web Mercator / EPSG:3857).
At Michigan's latitude that inflates area by ~1.88x, silently. `area.js` takes
WGS84 lng/lat only — `tools/area.test.js` has a test that reproduces this exact
error mode so it can't regress unnoticed, and `mercator.js` deliberately stops
at converting pixels to lng/lat so that projected coordinates never reach the
area code.
