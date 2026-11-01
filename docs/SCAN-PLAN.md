# The yard scan tool: research and build plan

Written by the core session, 2026-11-01, at the owner's request:

> "i wanted you to spearhead it as a new tool with a common codebase that can be
> shared between the maps for their respective purposes. Ideally it would be a
> new tool accessible from the dashboard that scans the lawn environment and
> allows users to place gutters, sprinkler heads, and refines the data that was
> acquired from the lidar. Even better, it'd be awesome if it could even refine,
> or wholly substitute, the initial lawn mapper by finding lawn within the
> property line."

The core session builds it (this is a core-owned tool, not a features or water
session tool). This file is the build spec. Keep it current as phases land, and
record measured results in a "Findings" section at the bottom, HARD apart from
SPECULATION, the same way docs/DETECTOR-FINDINGS.md does.

## 1. The short version

- **Scan once, then place things on the scan.** The phone films the yard. The
  film becomes a 3D model (a Gaussian splat plus a point cloud). The model is
  lined up with our lidar, the aerial photo and the property line, so every
  point in it has a real map position. Heads, gutters and fences are then placed
  by tapping them **in the 3D model**, not by aiming a phone in live AR.
- That removes the problem the water session hit (H65-H67 in water/FINDINGS.md):
  ARCore's frame drifts as you walk, about 1-4% of the distance, and an anchor
  once jumped 21 m. A tap on a scan has no walk and no drift.
- It works on iPhone. iPhone browsers have no WebXR, so live AR on iPhone is
  hard. Filming and viewing a 3D model work in every phone browser.
- Live AR comes last, and uses the scan as its reference instead of the 2016
  lidar (which was too thin for the H68 lidar match: about 3 points a square
  metre on the owner's lot).
- Niantic's cloud (VPS) is not usable from a browser and charges per call. We
  use Niantic's **file format** (SPZ) and their free **Scaniverse** app as one
  way in, not their cloud.

## 2. What the research found

### 2.1 8th Wall (open source since Feb 2026)

- The open-source engine is MIT and covers image targets, face effects and sky.
  **It has no SLAM** (no world tracking).
- World tracking (SLAM) ships only in a closed "Distributed Engine Binary"
  (Jan 2026). It is free, commercial use is allowed as part of a larger app, and
  the app must show the copyright notice and a link to the license. Its FAQ
  calls it a limited-use license meant to keep existing uses running, not for
  modification. It is not under active development.
- **VPS, Maps and hand tracking are not included.** The hosted 8th Wall
  platform is closed.
- So 8th Wall can give an iPhone browser world tracking, but not "where am I on
  the map". It is a later, optional piece (phase 6), with the risk that it
  stops working on a future iOS and nobody fixes it.
- Sources: https://8thwall.org/docs/open-source ,
  https://8thwall.org/blog/8th-wall-open-source ,
  https://8thwall.com/docs/migration/engine-distribution ,
  https://8thwall.com/docs/migration/faq

### 2.2 Niantic Spatial (VPS, Scaniverse, SPZ)

- Pricing (nianticspatial.com/en/pricing, read 2026-11-01): Free plan $0 with
  20,000 credits a month, about 1,500 VPS queries; Plus $20 a month; Pro $50 a
  month. A VPS query is 12 credits. Cloud processing of a phone capture is 30
  credits a second (about 10 minutes a month on the free plan).
- VPS needs a VPS map of each place, built from a scan of that place. The SDK
  (NSDK 4.0, Apr 2026) is Unity, Swift, Android and ROS 2. **There is no web
  SDK** on the pricing page or in the announcement.
- **Scaniverse** (iPhone app, Niantic): free, unlimited, on-device splat
  processing, no internet needed, exports splats as **PLY or SPZ**. No account
  seems to be needed to scan and export (App Store listing; not confirmed on a
  phone yet). Splats are metric scale but **not georeferenced**.
- **SPZ** is Niantic's open splat format, about 10x smaller than PLY.
- Conclusion: the GIS friend is right that a splat is the right kind of twin.
  The part to avoid is Niantic's paid, native-only cloud. Scaniverse is a good
  free capture app for iPhone owners, and SPZ is a good storage format.

### 2.3 Phone platforms

- **iPhone Safari: no WebXR at all** (no immersive-ar, no ARKit from the
  browser), and Apple has announced no plans. WebGPU is on in Safari 26.
- **Android Chrome:** WebXR immersive-ar with hit-test, anchors, depth sensing
  and camera access (the water session confirmed all four on the owner's S21,
  H68).
- **ARCore Geospatial / Streetscape:** native apps only, not in Chrome's WebXR.

### 2.4 Splats in the browser

- **Spark** (sparkjs.dev, World Labs, MIT): a three.js splat renderer. Reads PLY,
  compressed PLY, SPZ, SPLAT, KSPLAT and SOG. Needs three.js r180 or later and
  WebGL2; built to run on low-power phones. This is the viewer.
- **Training splats in the browser** (Splat.js, Brush, WebDGS) exists on WebGPU.
  Too heavy for a phone over a whole yard today; worth one experiment later.
- Splats are not survey grade (centimetres, not millimetres). An ISPRS 2026
  study found splats from photos beat phone-lidar meshes on spatial accuracy.
  For lawns, heads and gutters, a few centimetres is plenty.

### 2.5 What this repository already has (from a code read, 2026-11-01)

- **No three.js, no splats, no 8th Wall, no Niantic** anywhere. All 3D is raw
  WebGL (public/shade/view3d.js, water/public/view3d.js).
- **The water session's AR page** (water/public/ar.js, water/lib/ar-align.js,
  water/lib/ar-lidar.js; admin only, Android Chrome): reference points marked on
  the photo and again in AR, a fit that tells a slide from a turn, the phone's
  scale held per phone, and (H68) a "you are here" that matches the phone's
  depth picture to the lidar. Findings H64-H68 and S20-S22. Its results stay in
  localStorage, never in the map record.
- **The shade map's 3D model** is rebuilt from lidar on every visit and never
  saved. Frame: x and y in EPSG:3857 metres, z in real metres; real metres =
  mercator metres x cos(lat). shade/align.js gives a `shift` that lines the
  lidar up with the photo; it is saved in `tools.shade.data.lidar`.
- **Where things live in the map record (docs/MAPS.md):** lawn `shapes` and
  `parcel` in the lawn record; fences in `tools.shade.data.fences`; trees are not
  stored as objects (only the user's erasures); heads in
  `tools.water.data.irrigation.heads[].at` ([lng,lat]); gutters in
  `tools.water.data.gutters` (polylines) and `downspouts`.
- A tool part is at most 64 KB and is written only by its own tool. The
  dashboard lists a tool from `TOOLS` in worker/src/unified.js.

## 3. The design

### 3.1 One idea: the scan is the twin, the lidar is the anchor

```
 phone film / Scaniverse file
            |
            v
   3D model in its own frame          (scale roughly right, position unknown)
            |
            |  line up against: lidar ground and standing shapes (shade's
            |  cloud with its photo shift), the aerial photo, phone GPS
            v
   3D model in map coordinates        (EPSG:3857 x,y + metres z, the shade frame)
            |
   +--------+---------+-----------+------------+
   v        v         v           v            v
 place    trees     fences     fine ground   lawn inside
 heads,   (trunks,  (lines +   (10-20 cm      the property
 gutters  crowns)   heights)   heights)       line
```

Why the line-up works where H68 struggled: H68 matched a noisy 8 m depth
picture from one spot against thin 2016 lidar, live. Here a whole yard's model
(tens of metres of house walls, fences, trees and ground) is matched against the
lidar once, offline, with no time limit, plus the aerial photo as a second
check. The house alone is a large, rigid, unmistakable shape.

What "accurate" means here: consistent with our own map (the photo, the lawn
trace and the lidar after shade's shift), not survey truth. 3DEP's own position
is good to well under a metre; the scan inherits that, while distances inside
the scan are good to centimetres.

### 3.2 The line-up, step by step (lib/georef.js)

1. **Level.** Gravity from the phone's motion sensor during filming, else the
   largest flat patch near the camera path (the lawn) as "down".
2. **Scale.** Scaniverse files are metric. Our own captures get scale from
   Android's ARCore track when present, else from GPS distances (rough), then
   the lidar fit solves it (a 7-number fit: turn, shift, scale). H66 found ARCore
   about 4% short on the owner's phone, so scale is always re-solved, never
   trusted.
3. **Rough place.** Phone GPS at filming (5-10 m) and compass give a start. For
   an imported file with no GPS, the user drags the model onto the photo once.
4. **Fine place, 2.5D.** Rasterise both the model and the lidar at 0.25 m into
   (a) bare ground height and (b) "standing" cells 0.25-2.5 m up (walls, fences,
   trunks, shrubs). Search turn and shift for the best overlap. This is the
   water session's H68 search (water/lib/ar-lidar.js); copy it, name the source
   in the file header, and keep the H68 rules (a fix only when most standing
   cells land and no clearly different place fits within 25%).
5. **Photo check.** Render the model straight down in colour at the aerial
   photo's resolution and cross-correlate with the photo (as shade/align.js
   does for the lidar). It must agree with step 4 within about a metre, or the
   line-up is refused and the user is asked to drag it.
6. **Refine.** Point-to-plane ICP on the house walls and the ground, weighted
   to trust walls (no lean, no growth) over trees.
7. **Report.** Save the transform and its residuals. Show the user the model
   over the photo with the property line, so a bad line-up is visible at a
   glance.

### 3.3 Placing things on the twin (lib/place.js)

- The 3D view (Spark on three.js) shows the splat. A tap casts a ray into the
  model's points and returns the hit in map coordinates.
- Kinds of placement, each a small record: sprinkler head (a point on the
  ground), gutter (a polyline along a roof edge, with its height), downspout (a
  point at the wall foot plus where it drains), fence (a polyline with a height,
  snapped to the fence the scan shows), tree trunk (a point plus a diameter).
- **Photo fix** (phase 5, any phone, no AR): stand in the yard, take one photo
  of a sprinkler head, tap the head in the photo. The photo is matched to the
  scan's own film frames (whose positions are known), which gives where the
  phone was; the tap becomes a ray into the model. No walking, no drift, works
  on iPhone.

### 3.4 What the scan can refine

| What | From the scan | Kept from lidar | Who reads it |
|---|---|---|---|
| Trees | trunk position and width; crown edge seen from below; lowest branches | crown top and leaf density (phones cannot see the top of a tall tree) | shade map |
| Fences | line, height, gaps, gates | nothing | shade map (light, wind), water map (wind) |
| Ground | 10-20 cm heights where filmed | everything outside the film | water map (puddles, flow) |
| Lawn | grass vs not-grass on the ground, inside the property line | nothing | lawn mapper |
| Heads, gutters | positions in map coordinates | nothing | water map |

**Lawn from the scan.** Render the model straight down at 2-5 cm a pixel, in
colour and with height above ground. Grass is low (under 15 cm), green or
straw-coloured, and has grass texture. A first classifier is plain rules; the
detector is not used at that resolution (it was trained on county photos and
would be out of its range). The result is clipped to the parcel and offered to
the lawn mapper as a suggestion, never written over the user's trace.
"Wholly substitute" the lawn mapper is possible only where the whole lawn was
filmed, which is the honest limit: a scan sees what was walked.

### 3.5 Where it lives and how the maps share it

- **A folder of its own: `scan/`**, its own Worker at `scan.<home>` (domain
  from vars.CUSTOM_DOMAIN at deploy time, as tools/home-prepare.js does),
  deployed by its own workflow, reaching `/api/maps/*` over a service binding
  as the water Worker does. Its own R2 bucket for scan files, made by CI
  (tools/ci-prepare.js pattern), never documented as a manual step.
- **Shared library: `scan/lib/*.js`**, plain ES modules with no build step,
  served at `https://scan.<home>/lib/<file>.js` with CORS so the shade map,
  the water map and the lawn mapper can import them:
  - `georef.js` the line-up (3.2)
  - `frames.js` conversions: model frame, EPSG:3857, lng/lat, local east-north
    metres (match water/lib/ar-align.js toLocal/fromLocal and shade/ept.js)
  - `view.js` the 3D viewer (three.js + Spark, vendored under scan/vendor/ with
    exact versions)
  - `place.js` tap-to-place and the placement records
  - `extract.js` trees, fences, fine ground, lawn from a lined-up model
  - `scanfile.js` read PLY and SPZ; write SPZ
- **The map record:** the scan tool writes only `tools.scan.data`: the list of
  scans (id, date, transform, residuals, area covered), and the extracted and
  placed features, kept small (under 64 KB). The big files (the SPZ, the
  top-down images, the fine ground grid) live in R2 under the owner's key and
  are fetched through the scan Worker, which checks the owner.
- **Each other tool keeps its own part.** The water map reads
  `tools.scan.data.heads` and `.gutters` and offers "use the scan's heads"; the
  shade map reads `.trees` and `.fences` the same way; the lawn mapper reads
  `.lawn`. The scan tool never writes another tool's part. Those buttons live in
  each tool's own code, so they are asked of the session that owns it (3.7).
- **Dashboard entry** in worker/src/unified.js TOOLS (core-owned, so ours):
  `{ id: 'scan', name: 'Yard scan', needs: [], url: 'https://scan.{home}/?map={id}', note: 'Experimental.' }`,
  admin-only (`admin: true`) until phase 3 is measured on real yards.

### 3.6 Getting the 3D model: three ways in

| Way in | Phones | Cost | Quality | When |
|---|---|---|---|---|
| **A. Import a Scaniverse (or Polycam, Luma) PLY/SPZ** | iPhone (Scaniverse); any app that exports PLY | free | best (on-device training) | phase 1 |
| **B. Film in our page, build on GitHub Actions** | any phone browser | free (CPU runner, 20-60 min a scan) | point cloud, then a splat if a GPU is used | phase 4 |
| **C. Film in our page, build on Modal GPU** | any phone browser | paid, roughly $0.10-0.50 a scan (estimate, to be measured) | splat in minutes | phase 4, **only if the owner approves** |

- Our own capture (B, C): the page records video at 1-2 frames a second kept,
  with GPS, compass and motion readings timestamped beside each frame, and on
  Android the ARCore pose per frame when WebXR is available (better scale and a
  head start for the 3D build). Frames go to R2 in the background as the user
  walks.
- The build: GLOMAP or COLMAP for camera positions and a sparse cloud (CPU is
  fine), then OpenMVS for a dense cloud on CPU (B), or a splat trainer (gsplat
  or Brush) on a GPU (C). Film frames are deleted after the build; the SPZ and
  derived files are kept.
- The site already runs paid work on Modal (the model server). B is the free
  default per CLAUDE.md; C needs the owner's yes with a measured cost first.

### 3.7 The other sessions

- **Water session.** Its AR page (H64-H68) is the closest thing to this tool.
  Proposal to send them: the scan tool becomes the place where heads and gutters
  are placed on a twin; their AR page can later use the scan as its reference
  instead of the lidar (phase 6), through `scan/lib/georef.js`. Their heads and
  gutters stay in `tools.water.data`; they add a "use the scan's heads" import.
  Ask, do not assume: they own water/.
- **Features session (shade).** Ask for: reading `tools.scan.data.trees` and
  `.fences` into the shade model, and later loading the scan's fine ground. They
  own public/shade*.
- Both are messaged by a one-time scheduled Routine into their session (see
  CLAUDE.md). This plan is the thing to point them at.

### 3.8 Privacy and security

- A scan is film of someone's yard and house. It is private to its owner:
  R2 keys by owner, served only to that owner, never public, never in the
  repository, never used for training without an explicit opt-in.
- People or faces caught on film: the 3D model blurs them away in practice, but
  the film frames do not, which is one more reason to delete frames after the
  build.
- GPS from filming is used for the line-up and then kept only as the
  transform. No addresses in the repository, logs or findings (CLAUDE.md).
- File upload limits and type checks on import (a PLY or SPZ, a size cap, parsed
  in a worker, never executed).

## 4. Phases, each with a done test

Each phase ships behind admin-only until its done test passes on a real yard,
and its result goes in the Findings below.

1. **Import, view, line up (Way A).** scan/ folder and Worker, its deploy
   workflow, the R2 bucket via CI, the dashboard entry (admin). Upload a
   Scaniverse SPZ/PLY; view it in Spark; drag it roughly onto the photo; the
   2.5D fit, photo check and ICP place it. Save the transform.
   *Done when:* on the owner's lot, house corners in the model land within
   0.5 m of the same corners in the lidar after shade's shift, and the photo
   check agrees.
2. **Place on the twin.** Tap to place heads, gutters, downspouts, fences,
   trunks; save them in `tools.scan.data`; show them on the photo.
   *Done when:* five heads placed in the model, then measured in the yard with
   a tape from two house corners, are within 0.3 m.
3. **Extract.** Trunks and crown edges, fences, fine ground, lawn inside the
   property line, each with a confidence. Offer them to the other tools (ask
   their sessions first, 3.7).
   *Done when:* the lawn from the scan agrees with the owner's own trace on
   their lot to within 5% of area; fences match what the owner draws by hand.
4. **Our own capture (Way B, then C if approved).** The filming page, upload,
   the GitHub Actions build, and import of the result into phase 1.
   *Done when:* a scan filmed in the browser on an iPhone and on the S21 both
   pass phase 1's test.
5. **Photo fix.** One photo plus a tap places a head without AR.
   *Done when:* within 0.3 m of the tape-measured position, on both phones.
6. **Live AR on the twin (optional).** Android Chrome: WebXR plus re-fixing
   against the scan every few seconds (render the splat from ARCore's pose
   guess and compare with the camera picture). iPhone: only if the owner wants
   live AR there, via the 8th Wall binary SLAM, knowing its license and
   maintenance risk (2.1).
   *Done when:* check points stay within 0.3 m over a full walk of the yard
   (H66 measured 0.01-2.56 m with the reference-point method).

## 5. Decisions for the owner

1. **Capture first:** start with Scaniverse import (free, iPhone) before
   building our own filming page? Recommended: yes. It proves the line-up and
   placing on real data before any capture or build work.
2. **Paid GPU for building splats (Way C):** not needed until phase 4; the
   free CPU build comes first. A measured cost will be brought back before any
   Modal use.
3. **Live AR on iPhone (phase 6):** only via 8th Wall's closed SLAM binary.
   Recommended: decide after phase 5, which may make it unnecessary.

## 6. Open questions to settle by measuring, not arguing

- How well a scan's ground lines up with 3DEP ground under grass (lidar ground
  is the soil; the scan's is the grass top, a few cm higher).
- Whether one film per yard is practical (a typical walk is 3-10 minutes;
  Scaniverse suggests phone scans up to about 500 square metres, so a large yard
  may need two scans merged).
- How old lidar (the owner's county is 2016) affects the line-up where the
  yard has changed (new fence, removed tree). The house should carry it.

## Findings

None yet. Record each measured result here: HARD (measured, with the yard
named only as "the owner's lot" or by its lng,lat map id, never an address) apart
from SPECULATION.
