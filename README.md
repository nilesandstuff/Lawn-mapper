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
public/lib/   Maths shared by both sides (area, projection, mask tracing, edges)
tools/        Tests, the county-server probe, and the CI helpers
.github/      Six workflows: check, deploy, find county servers, browser test,
              a real detection, find a promptable model
wrangler.toml One config; one deploy ships the API and the site together
```

The site and the API are one Worker on one origin. That means no CORS to
configure, no second deploy target that can drift out of sync, and the browser
can read the AI mask off a `<canvas>` without it being tainted cross-origin.

## Status: complete, and verified against the live services

The whole path works — address in, corrected lawn polygon and square footage
out, exportable as PNG or PDF.

Neither environment that wrote this code had outbound network access, so
everything touching a third party was originally unverified. That gap is now
closed by running the checks on a GitHub Actions runner, which does have
access. Confirmed live, by running them rather than by looking them up: a real
address goes in and a real lawn polygon comes out of `mattsays/sam3-image`, and
parcel lookups return real polygons for Ottawa, Allegan and Muskegon. See
*County coverage* below for what that turned up — every endpoint the project
shipped with had already gone stale.

Still unverifiable without eyes on real imagery: whether the traced lawn lands
exactly on the grass. The app checks its own projection at runtime and the
"Show the raw AI mask" toggle makes any error visible.

## Deploying

Manual workflows, all triggered from the Actions tab:

| Workflow | Does |
|---|---|
| **1. Preflight checks** | Tests, Replicate model check, county GIS probe. Read-only. |
| **2. Deploy** | Tests, resolves the KV namespace, deploys, applies the API keys. |
| **3. Find county servers** | Searches for a working parcel layer when one goes stale, and prints a config block. Read-only. |
| **4. Browser test** | Drives the real app in a real browser at phone size, with real touch events. Free by default; will run one real detection on request. |
| **5. Test a real detection** | One end-to-end segmentation against live imagery, with the mask-to-parcel overlap reported. **Costs a few cents**, so it asks you to type `spend`. |
| **6. Find a promptable AI model** | Searches Replicate for a text-promptable segmentation model when the current one is withdrawn or renamed. Read-only. |

Workflow 4 exists because two bugs got all the way to the deployed site
without any test noticing. Tapping the map was dead on a phone -- Mapbox GL
Draw calls preventDefault on touchend, which suppresses the click event
`map.on('click')` needs -- and the earlier test used `page.click()`, which
sends a mouse click even under mobile emulation. It now sends genuine touch
events, and it caught the edge tool inflating a real parcel threefold on the
very next run.

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
| `/api/segment` | SAM 3 lawn detection | **yes** — quota'd |
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

`public/lib/mask.js` turns SAM's raster mask into editable polygons, tracing
enclosed holes as interior rings so a lawn that wraps around a house doesn't
bill the roof as turf, and keeping detached patches as separate shapes the user
can delete independently. `tools/mask.test.js` measures every synthetic case
against the frame's known ground resolution.

### Detection: one press, no pins

A lawn is usually several disconnected pieces — split by a driveway, a pool, a
garage. SAM 2 could only segment what its prompt points touched, so every piece
needed a pin and a forgotten piece was silently missing from the total. SAM 3
takes a **text** prompt and returns every match in the frame at once, so the
pins are gone: pressing the button is the whole interaction.

The prompt is just `"grass"`. Measured against a real 21,740 sq ft lot,
`"grass"`, `"lawn"` and `"grass lawn"` agreed to within 0.6% — the model
resolves them to one concept, so the shortest wins. It lives in
`worker/src/sam.js`, overridable with a `SAM_PROMPT` variable, and *not* in the
Worker entrypoint: a Workers entrypoint may only export handlers, and exporting
a plain constant from it kills the isolate on startup and takes the whole site
down. `tools/worker.test.js` guards that.

Asking for everything in the frame means the frame includes the neighbours'
grass, so the mask is **clipped to the property line** before it is measured —
`rasterizePolygon` in `public/lib/mask.js` fills the parcel into a raster and
ANDs it with SAM's. On the lot this was tested against that removed 3,721 sq ft,
a third of everything found.

Tree canopies hide grass that is really there, and an overhead photograph
offers no way to tell a shaded lawn from a pool. Enclosed gaps under
`TREE_GAP_SQFT` (900 sq ft, roughly a large tree's footprint) are counted as
lawn rather than subtracted; it is a toggle, on by default, and the app always
reports how much it filled in. Anything it gets wrong is fixable by hand —
every detected piece is an editable polygon that can be reshaped or deleted.

`public/lib/edges.js` handles the other half of a real measurement: parcels
that stop at the right-of-way easement while the owner mows to the kerb. The
user picks a boundary and slides it outward in feet; it stays exactly parallel
to the surveyed line, and the corners slide along their neighbours rather than
being dragged. Real boundaries arrive as a run of nearly-collinear digitised
segments -- eight of them on the parcel this was tested against -- so the whole
run moves as one. Corners still backed by the county record are drawn as yellow
dots and stop being marked once an edge moves them.

## County coverage

Verified live, each confirmed by a point query returning a real parcel:

| County | Status |
|---|---|
| Ottawa | working — `gis.miottawa.org`, `AR_ParcelSearch_gdb` layer 6 |
| Allegan | working — `gis.allegancounty.org`, `Parcel_Drafter_MIL1` layer 0 |
| Muskegon | working — `maps.muskegoncountygis.com`, `PropertyViewer` layer 23 |
| **Kent** | **no public endpoint found** |
| Newaygo | no public endpoint found |

Every endpoint in this project's first version had already gone stale, so
treat the table as perishable and re-run the discovery workflow when lookups
start failing.

**Kent is the notable gap** — it covers Grand Rapids. Its old host 404s at
every known path and it publishes no parcel layer to the public ArcGIS Online
catalogue, so finding the current one probably means asking Kent County GIS
directly. Until then those addresses go to manual drawing, which measures just
as accurately; only the convenience of a pre-drawn property line is lost.

## Known gaps (documented limitations, not bugs)

- **The Replicate model slug** (`mattsays/sam3-image`) is confirmed live, but
  it is a community model: it can be renamed or withdrawn without notice. The
  preflight workflow re-checks it, reading the slug straight out of
  `worker/src/sam.js`, and verifies both that it has a runnable version and
  that every input field the Worker sends appears in that version's schema. An
  earlier check only confirmed the model *existed* and passed happily while
  every real detection failed. Workflow 6 finds a replacement if it does go.
- **Allegan addresses** may render as a house number without a street name.
  That layer has no single address column and the parts are ambiguously named;
  it is cosmetic, and the geometry the measurement depends on is unaffected.
- **`TILE_SIZE` in `public/lib/mercator.js`** encodes how wide Mapbox considers
  the world at a given zoom. Getting it wrong scales every AI-detected area by
  4x. The app cross-checks it against Mapbox GL's own projection at runtime and
  logs a specific console error on a mismatch, but the assumption itself is
  unverified offline. The "Show the raw AI mask" checkbox makes it visible: a
  correctly georeferenced mask sits exactly on the grass it traced.
- **The satellite imagery cannot be dated or seasonal.** Mapbox serves one
  curated global mosaic; there is no parameter for "spring", "leaf-off", or a
  capture date, and which season any given tile shows is not knowable from the
  API. So the lawn may be photographed dormant and brown, or under full summer
  canopy, and nothing in the request can influence that. The tree-gap fill and
  hand correction exist because of this, not despite it.
- **Quota is a cost guardrail, not enforcement.** Clearing site data or
  changing network gets a fresh allowance. It exists to stop a script running
  thousands of predictions overnight, and it is a read-then-write against KV,
  so a burst of simultaneous requests can slip past the limit by a small margin.

## Development

```bash
npm install
npm test               # area, mask tracing, edges, Worker exports, CI config
                       # -- five suites, fully offline
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
