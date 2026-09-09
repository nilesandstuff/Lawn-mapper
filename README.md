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

### Which photograph

A lawn photographed in April and in July is two different problems: bare trees
and long shadows against full canopy and a high sun. `worker/src/imagery.js`
offers a choice of source, and `tools/probe-imagery.js` is what decides whether
a source is allowed in.

That probe is the load-bearing part. Every measurement is made against the
**frame** — a centre, a zoom and a pixel size — and the pixel-to-lng/lat maths
assumes the picture covers exactly that rectangle. Mapbox's static endpoint is
defined that way; an ArcGIS service is not, and may return a slightly different
extent snapped to its own grid. A source that is off by a few metres does not
look broken: the lawn traces cleanly and the number is wrong. So each source is
asked, in `f=json` mode, what extent it actually served, and is only added here
if it matches to well under a pixel. Both USGS services return our exact extent
to 0.000 m.

| Source | On the map | Detection | Notes |
| --- | --- | --- | --- |
| Mapbox satellite | yes | yes | the default, and the sharpest |
| Google satellite | yes | yes | only with a `GOOGLE_MAPS_KEY`; usually a different year and sun angle |
| USGS NAIP | yes | yes | 30 cm native, reflown every 2–3 years |
| USGS NAIP NDVI | yes | **no** | tested and rejected — see below |
| Esri World Imagery | yes | **no** | cached basemap, see below |

Google is the second opinion worth having, because it is usually flown in a
different year and a different light from Mapbox — the one thing that actually
moves a shaded lawn from "not grass" to "grass". It needs two conversions, and
both are silently catastrophic if wrong, so both are asserted in
`tools/worker.test.js` against the world size each scheme describes:

- **Tile scale.** Google Static Maps is a 256-pixel tile scheme, Mapbox is 512,
  so the same ground scale is Google zoom = Mapbox zoom **+ 1**. Off by one is
  a factor of two in every distance and four in every area, and the picture
  still looks like a house from above.
- **Whole zoom levels only.** Google floors fractional zoom. Our frames are
  fractional, so `providerFrame()` rebuilds the frame at a zoom Google can
  serve — floored, never rounded up, so a parcel that fitted still fits — and
  the Worker echoes that served frame back as the authoritative one. The
  browser applies the same rule before laying the preview on the map, or the
  photograph would sit on the wrong rectangle while looking perfectly sharp.

The key never reaches the browser: the catalogue at `/api/config` carries
labels and capabilities only, the image is fetched through `/api/imagery`, and
`tools/worker.test.js` asserts that a configured key does not appear in what is
sent out.

A view-only source is not a silent fallback. The picker marks it in the list,
the note under it opens with **AI detection not available for this imagery
source** in bold, and if you detect anyway the status line names the source
that actually answered.

Esri is a cached basemap: `singleFusedMapCache` is true and
`exportTilesAllowed` is false, so its `export` operation answers every request
with the extent you asked for and an image **zero pixels wide** — at 1280 px,
512 px and 256 px alike. It serves pre-baked tiles happily, which is enough to
look at and not enough to detect from. It is kept because looking is most of the
point: judging whether the trees are in leaf costs nothing and happens before
any money is spent. Detection falls back to Mapbox and the status line says so.

NDVI was the interesting idea, and it does not work. NAIP carries a
near-infrared band, and vegetation reflects far more infrared than anything
built, so the contrast between those bands should separate growing things from
pavement using a signal a shadow barely touches — exactly the failure we kept
hitting, lawn in shade read as not-lawn. Measured on real lawns it failed twice
over: NAIP is 30 cm native against a frame asking for about 3.5 cm, so every
edge arrives soft, and turf and tree canopy do not separate at that resolution.
Boundaries no crisper than the shadows they replaced, and no way to tell the
trees from the grass. Fixing it would need finer multispectral imagery than
anything free, so it is a dead end rather than an unfinished feature — kept as a
view layer, because seeing where the vegetation is still tells you something.

### One way to ask, and why the second was removed

`worker/src/sam.js` holds the models as a table rather than a slug, because
they differ in what they need from the browser rather than just in name. There
is one entry in it.

**Quick** is a text prompt: one press, every patch in the frame at once,
including the disconnected ones a person would forget. What it cannot do is be
argued with — when it decides a shaded strip is not grass, there is no way to
say otherwise.

**Precise** took pins, and has been removed. Of every model
`tools/find-sam-model.js` could reach, exactly three accepted point prompts:
`meta/sam-2-video` (real SAM 2, binary masks, but wants a **video file** a
Worker cannot build from one PNG), `casia-iva-lab/fastsam` (well used, but
returns the photograph with masks drawn **on** it and has no `mask_only`), and
`ocg2347/sam-pointprompt` — so the third, by elimination rather than
enthusiasm. The plumbing worked. The model did not: it could not tell a tree's
shadow lying across a lawn from dense woodland, which is the single distinction
this product depends on. Being able to point at a patch buys nothing when the
model then decides the patch is forest, so it went, rather than staying in the
picker as an option that produces confidently wrong answers.

`tools/probe-candidates.js` (workflow **5**, probe `candidates`) is how the
replacement gets chosen: it runs each candidate through the real pipeline on
one real lot — same frame, same property line, same tracer — and prints the
square footage each returns, so they can be compared against a number we
already know. Two things are checked before that, because both are
disqualifying and neither is in any model's description: whether the output is
a **bare mask** (95% pure black and white; several of these return the
photograph with masks painted on it, which traces into confident nonsense) and
whether the mask **lands on the parcel** at all.

The shortlist it runs, and why each is on it:

| Candidate | Why |
| --- | --- |
| `schananas/grounded_sam` | takes a **negative** prompt — "grass", ruling out "trees, forest, woods". The failure that killed the last model is exactly a case where saying what is *not* lawn is easier than scoring what is |
| `tmappdev/lang-segment-anything` | the same grounding-plus-SAM idea with five million runs behind it, and two inputs total |
| `casia-iva-lab/fastsam` | text-promptable, but publishes no `mask_only`, so it is expected to fail the purity check — expected is not measured |

It has been run. On a 21,740 sq ft Jenison lot, asking for "grass" and ruling
out "trees, forest, woods, bushes, shrubs":

| Candidate | Verdict | Clipped | % of lot | Pieces |
| --- | --- | --- | --- | --- |
| `mattsays/sam3-image` | hard mask | 9,133 sq ft | 42% | 4 |
| `schananas/grounded_sam` | hard mask | 21,012 sq ft | 97% | 1 |
| `tmappdev/lang-segment-anything` | soft mask | 3,771 sq ft | 17% | 1 |
| `casia-iva-lab/fastsam` | annotated photo | — | — | — |

**Nothing beat the incumbent, and the two that ran failed in opposite
directions.** grounded_sam masked 70% of the entire frame and returned it as
one piece — house, drive and neighbours included; its published default prompt
is `"clothes,shoes"`, and aerial imagery appears to be outside what it does.
lang-segment-anything returned a single region of 17%, which is one patch of a
property that has several. Only sam3's answer has the shape of a real lot:
several separate patches making 42% of a parcel that also carries a house and
a driveway. FastSAM was confirmed unusable — 41% of its output pixels carry
real colour — which is what a model with no `mask_only` was always going to do.

So the picker stays at one model, and correcting the outline stays the job of
the editing tools rather than of a second opinion that does not exist.

### Measured against a lot whose answer is known

A percentage of a parcel is not proof. So the same probe was pointed at a
1.75-acre Rockford lot whose owner knows it: **28,000 sq ft mown in total, of
which about 20,000 is visible lawn** and the rest is grass under a continuous
tree canopy. It has a large wooded area behind the house, scattered trees, and
open ground -- the exact mix that broke the point-prompted model.

| Candidate | Found | vs 20,000 visible | Pieces |
| --- | --- | --- | --- |
| `mattsays/sam3-image` | 17,386 sq ft | **13% under** | 2 |
| `schananas/grounded_sam` | 0 sq ft | found nothing | 0 |
| `tmappdev/lang-segment-anything` | 47,930 sq ft | **2.4x over** | 3 |

lang-segment-anything masked 69% of the entire frame -- 209,817 sq ft before
clipping -- which is the woods being called grass: the original failure,
reproduced. grounded_sam returned an empty mask here and 97% of the lot on the
other test, so it is all-or-nothing on aerial imagery rather than mistunable.
Both are out on evidence.

sam3 found the visible lawn to within 13%, in two pieces, and did not claim
the woodland. That under-read matches the direction and rough size of the gap
against measuremylawn.com, so the error looks systematic and mild rather than
erratic.

**And then the owner's screenshot showed exactly where it was losing area:**
the outline traced the boundary between sunlit and shaded grass, precisely.
Not confusion about what grass is -- a brightness cut. The photograph is
leaf-off with a low sun, so long shadows stripe the lawn and the grass under
them scored just below the confidence threshold. That made it a tunable
problem rather than a model problem, and the sweep settled it:

| Source | Threshold | Found | Pieces |
| --- | --- | --- | --- |
| Mapbox | 0.1 (was) | 17,393 sq ft | 2 |
| **Mapbox** | **0.05 (now)** | **25,059 sq ft** | 2 |
| Mapbox | 0.02 | 25,247 sq ft | 2 |
| Google | 0.1 | 13,847 sq ft | 1 |
| Google | 0.05 | 13,991 sq ft | 1 |
| Google | 0.02 | 14,338 sq ft | 1 |

0.05 recovers 7,666 sq ft of shaded grass -- very nearly the whole gap between
what this owner sees from the air and what he mows -- and **0.02 then adds
0.75%**, so 0.05 has found essentially everything this model will find here.

The app was then checked against the probe on the same lot and agreed at about
25,000 sq ft, which is the one thing none of the earlier numbers established.
Looking at that result, the owner reported that part of the gain is a
disconnected patch away in the woods: **some woodland is counted at 0.05**,
alongside a real increase in genuine lawn. The plateau never ruled that out --
it says the total stopped growing, not what the total is made of, and this
README previously claimed more than that. 0.05 stands because it recovers more
real lawn than it wrongly adds and a stray section is one tap to delete, which
is a judgement about which way to be wrong rather than a free lunch. See
`worker/src/sam.js`.

Google was worse here for a structural reason worth knowing: it serves whole
zoom levels only, and this lot's fitted zoom is fractional, so Google returned
a wider frame at the same 1280 px and lost resolution (21.8 cm/px). Coarser
pixels found one blob instead of two. Google is a genuine second opinion on
lots whose fitted zoom lands near a whole level, and a coarser one otherwise.

**What that test also exposed:** "Count grass under trees" contributed
**nothing** on this lot -- `+0 sq ft in 0 gaps`. It fills holes ENCLOSED
inside the lawn, and a treeline adjoining the lawn is not a hole. So the
8,000 sq ft between this owner's two figures is not recoverable automatically,
and the honest description of what this app measures is *visible* lawn, with
the canopy option helping only where trees are scattered within it. Grass under
a solid canopy has to be painted in with the Add brush.

What no probe can settle by itself is which of those two numbers a customer
means. That needs a lot where the true answer is already known, which is why
the tool takes an `ADDRESS`.

The pin interaction survives it — the mode, the numbered markers, the
conversion below — because what is wanted is a model that understands mown
grass, not necessarily one that takes points, and the search
(`tools/find-sam-model.js`) is deliberately not limited to point prompts.

Pins are converted to image pixels in the **browser**, not the Worker, because
the browser is the side that knows the image's real dimensions — Mapbox renders
at @2x, so a 640 frame arrives 1280 px wide, and a pin sent in frame units lands
at half the distance from the corner: a plausible-looking spot somewhere else on
the property.

`tools/check-replicate.js` validates every model in the table against its
published schema, not just the default. The one that breaks silently is the one
nobody runs by accident.

`public/lib/edges.js` handles the other half of a real measurement: parcels
that stop at the right-of-way easement while the owner mows to the kerb. The
user picks a boundary and slides it outward in feet; it stays exactly parallel
to the surveyed line, and the corners slide along their neighbours rather than
being dragged. Real boundaries arrive as a run of nearly-collinear digitised
segments -- eight of them on the parcel this was tested against -- so the whole
run moves as one. Corners still backed by the county record are drawn as yellow
dots and stop being marked once an edge moves them.

## County coverage

Each confirmed by a point query that returned a real parcel:

| Area | Source |
|---|---|
| **North Carolina — all of it** | `services.nconemap.gov`, `NC1Map_Parcels` layer 1 |
| Washoe County, NV | `gisweb.washoecounty.gov`, `Assessor_GSACAMA` layer 0 |
| Kent County, MI | `gis.kentcountymi.gov`, `agisprod` → `ParcelsWithCondos` layer 0 |
| Ottawa County, MI | `gis.miottawa.org`, `AR_ParcelSearch_gdb` layer 6 |
| Allegan County, MI | `gis.allegancounty.org`, `Parcel_Drafter_MIL1` layer 0 |
| Muskegon County, MI | `maps.muskegoncountygis.com`, `PropertyViewer` layer 23 |
| Newaygo County, MI | `arcgisweb.countyofnewaygo.com`, `hosting` → `DrainsParcelsNewaygoCounty` |

**North Carolina is one entry for a hundred counties**, and that was an
accident. The hunt was for Johnston County's own server, which does not exist
in any reachable form; what answered was NC OneMap, the state republishing
every county's parcels on one layer with one schema. For a long time a bounding
box around Smithfield was the only thing holding it to one county. Widening
that box to the state was the entire change.

What it does not promise is that every county is *in* there. NC OneMap carries
what each county has submitted, so a gap returns no parcel — which the app
already handles by offering to trace by hand. The preflight probe therefore
tests five counties five hundred miles apart rather than five points in one
town, because one town proves nothing about a claim this size.

`tools/probe-statewide.js` (workflow **3**, tick *statewide*) asks which other
states publish this way. Every URL in it is a guess written from recollection
of state GIS programmes; the tool exists precisely because a plausible URL that
answers with the wrong layer is indistinguishable from a working one until you
ask it for a house and measure what comes back.

Every endpoint in this project's first version had already gone stale, so
treat the table as perishable and re-run the discovery workflow when lookups
start failing.

**Kent — covering Grand Rapids, the largest population here — was written off
as having no public endpoint, and did have one all along.** Its ArcGIS Server
runs under the instance name `agisprod` rather than the conventional `arcgis`
or `server`, so every path the discovery tool could invent returned 404 and
the county looked dead. Nothing was going to guess that; a person found it by
opening the services directory in a browser. The lesson is that the candidate
list in `discover-counties.js` is a shortcut, not a substitute for looking.

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
