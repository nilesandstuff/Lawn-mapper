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


The owner, after the first draft (2026-11-01), setting the priority:

> "at the core of this, the original intended use is as a way to place
> sprinkler heads on the lawn. Because A. Placing dots on a map is tricky, a
> sprinkler in the middle of a lawn is just not visible from aerial imagery. B.
> We tried GPS, walk the lawn and press "place a sprinkler here" but that was
> terribly inaccurate. So... The ability to walk the lawn, point to the
> sprinkler with the cursor and tap "add a head here" is really the original
> point. Everything beyond that is a bonus, but a potentially huge bonus that
> be be smoothest if it could all work in one session of walking the lawn (so
> not record > wait to upload and process > walk again and aim at gutters and
> sprinklers)"

## 1. The short version

- **One walk.** Walk the lawn with the phone's camera on, a crosshair in the
  middle of the screen. Put the crosshair on a head and tap "add a head here".
  Same for a downspout's foot, a valve box, a fence end. Tap "Finish" at the
  end. There is no second walk.
- **The walk is the scan.** While you walk, the page keeps a picture every
  half metre or so, with the phone's motion readings and GPS. Each tap is saved
  as "this pixel in this picture", not just as a map position.
- **Finish corrects the whole walk at once.** The pictures are pieced into a
  3D model of the yard (the same way photo-scanning apps work). That fixes the
  drift that wrecked the water session's AR walks, because the model is solved
  as a whole: walking back past the start or past the house ties the ends
  together. The model is then lined up with the house and ground from our
  lidar and the aerial photo, automatically, with no dots to tap on a photo.
  Every tap is then re-computed from its corrected picture. Target: 1-3 minutes
  of waiting after Finish, standing still.
- **Why the old attempts failed, and what this changes:**
  - GPS: phone GPS is 3-10 m off under trees and near houses. Here GPS is
    only a rough start; the house sets the position.
  - The AR page (water H65-H67): two errors stacked. ARCore drifted with the
    walk (check points 0.01-2.56 m off, scale 3.6-4.4% short, one anchor moved
    21 m), and the reference dots tapped on the aerial photo disagreed with
    each other by up to 1.3 m. Solving the whole walk afterwards removes most
    of the first; matching the house's 3D shape instead of dots on a photo
    removes the second.
- **Both phones, one page.** Android Chrome shows each head live as you tap
  (ARCore), and Finish then corrects it. iPhone Safari has no AR in the
  browser, so the page records and the heads appear after Finish. Same walk,
  same result.
- **The bonuses come from the same pictures:** fences, tree trunks, fine ground
  heights, the lawn's edge, gutters (from the roof edge the lidar already has,
  plus the downspouts you tapped), and a 3D splat to look at later. None of them
  needs another walk.
- Niantic's location service (VPS) is native-app only and paid per call, so it
  is not used. Scaniverse files can still be imported as a bonus, not as the
  main path.

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

### 3.1 The walk (public page: scan.<home>/walk?map=<id>)

```
 WALK (phone)                                FINISH (server, 1-3 min)
 ------------------------------------       ---------------------------------
 camera + crosshair                          1. solve the walk: picture
 keep a picture every ~0.5 m or 10 deg          positions + a 3D point cloud,
   (1280 px JPEG, ~150 KB)                      drift tied out (bundle
 + time, GPS, compass, motion sensor            adjustment, loop closure)
 + Android: ARCore pose per picture          2. each tap: its pixel, seen in
 tap "head here" -> picture + crosshair         the pictures around it, gives
   pixel (+ Android: ARCore hit point)          the head's 3D point
 pictures upload in the background           3. line the model up with the
   as you walk                                  house and ground from lidar,
 the server starts solving before               checked against the photo
   you finish                                4. heads, downspouts etc. on the
                                                map; you confirm or nudge
```

- **Tapping a head.** The crosshair pixel in the picture at the tap. To make
  the head's 3D point solid, the page asks for a short sideways step or sway
  (about 30 cm, a second or two) with the head still near the crosshair; the
  page follows the head's little patch of image across those pictures (image
  tracking), so the head is seen from several spots and its position is fixed
  by those sight lines meeting, not by where a guessed ground plane is.
  Fallback: the sight line meets the solved ground.
- **Live pins (Android).** ARCore's hit-test places the pin at once so you can
  see you got it. That pin is a preview; Finish replaces it. A tap is never lost
  if ARCore loses tracking, because it is kept as picture + pixel.
- **iPhone.** The camera through the browser (getUserMedia) plus the motion
  and compass readings (DeviceMotionEvent and DeviceOrientationEvent, after the
  permission prompt iOS requires). No live pins, but a dot appears where GPS
  roughly places the tap, and a tick confirms it was saved. Optional later:
  live pins through 8th Wall's SLAM binary (2.1).
- **Coaching on screen** (from the water session's lessons): "walk slowly",
  "turn slower" (over 90 degrees a second blurs pictures), "go back past the
  house corner before finishing" (ties the walk's ends together), "keep the
  house in view now and then" (the house sets the position), "too dark".
- **Gutters without aiming in the air.** Tap each downspout where it meets the
  ground. The gutters themselves are taken from the roof edge, which the lidar
  already has (the water map's roof rule) and the pictures confirm.
- **No signal?** Pictures queue on the phone (IndexedDB) and upload when they
  can; Finish then waits for them. A walk is about 300-600 pictures, 45-90 MB.

### 3.2 Solving the walk (lib/solve on the server)

1. **Picture positions.** Feature points in each picture, matched only to the
   pictures taken near it in time and, on Android, near it by ARCore's pose
   (far fewer pairs than matching everything with everything). Matches to
   pictures from much earlier in the walk are the "loop closures" that remove
   drift. Then bundle adjustment: all picture positions and all 3D points
   solved together. Tools: GLOMAP or COLMAP (open source), on CPU.
2. **Starting guesses.** Android: ARCore's poses (good locally, so the solve is
   fast). iPhone: built from the pictures alone; motion readings give "down"
   and the compass gives a rough heading.
3. **Incremental.** The server solves batches as pictures arrive, so at Finish
   only the last stretch and one final adjustment are left.
4. **Each tap.** Triangulated from the tracked head patch (3.1), or the sight
   line meets the solved ground.

### 3.3 Lining the walk up with the map (lib/georef.js)

1. **Level.** "Down" from the motion sensor; check it against the solved lawn
   being nearly flat.
2. **Scale.** Pictures alone do not know metres. Scale comes from ARCore
   (Android; known to run about 4% short on the owner's phone, H66) or GPS
   (rough), and is then solved in the lidar fit (turn, shift, scale: 7
   numbers). Never trusted from the phone alone.
3. **Rough place.** GPS across the whole walk (many fixes average out much
   better than one) and the compass.
4. **Fine place.** Grid the walk's points and the lidar at 0.25 m into bare
   ground height and "standing" cells 0.25-2.5 m up (house walls, fences,
   trunks). Search turn, shift and scale for the best overlap. This is the
   water session's H68 search (water/lib/ar-lidar.js), copied with its source
   named, but fed with the whole walk instead of 8 m around one spot: H68's
   simulation fixed only 39% of single spots, mostly because one spot is "too
   far from anything standing"; a whole walk always includes the house.
5. **Photo check.** The walk's ground rendered top-down in colour against the
   aerial photo (as shade/align.js does). Must agree within about a metre, or
   the page asks the user to drag the result into place once.
6. **Refine.** Point-to-plane ICP on house walls and ground, trusting walls
   (no lean, no growth) over trees.
7. **Show it.** The heads and the walk's outline over the photo with the
   property line, with "Looks right" and "Nudge" buttons.
8. **Fallback for thin lidar.** If a lot's lidar has no usable house walls,
   reference dots as the water page has them today, but marked in the scan's
   pictures (house corners, driveway edges), with no live drift to fight.

What "accurate" means: consistent with our map (the photo, the lawn trace, the
lidar after shade's shift). Heads should land within 0.3 m of a tape-measured
position (the done test, section 4).

### 3.4 What the scan can refine

| What | From the scan | Kept from lidar | Who reads it |
|---|---|---|---|
| Trees | trunk position and width; crown edge seen from below; lowest branches | crown top and leaf density (phones cannot see the top of a tall tree) | shade map |
| Fences | line, height, gaps, gates | nothing | shade map (light, wind), water map (wind) |
| Ground | 10-20 cm heights where walked | everything outside the walk | water map (puddles, flow) |
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
  - `walk.js` the walk page's capture: pictures by distance and turn, sensor
    readings, taps as picture + pixel, the upload queue
  - `track.js` following a tapped head's patch across nearby pictures
  - `georef.js` the line-up (3.3)
  - `frames.js` conversions: model frame, EPSG:3857, lng/lat, local east-north
    metres (match water/lib/ar-align.js toLocal/fromLocal and shade/ept.js)
  - `view.js` the 3D viewer (three.js + Spark, vendored under scan/vendor/ with
    exact versions)
  - `place.js` the placement records (head, downspout, valve box, fence end)
    and tap-to-place on the 3D view for edits after the walk
  - `extract.js` trees, fences, fine ground, lawn from a lined-up model
  - `scanfile.js` read PLY and SPZ; write SPZ
- **The map record:** the scan tool writes only `tools.scan.data`: the list of
  walks (id, date, transform, residuals, area covered), the placed heads and
  other taps, and the extracted features, kept small (under 64 KB). The big
  files (the pictures until solved, the point cloud, the SPZ, the top-down
  images, the fine ground grid) live in R2 under the owner's key and
  are fetched through the scan Worker, which checks the owner.
- **Each other tool keeps its own part.** The water map reads
  `tools.scan.data.heads` and `.gutters` and offers "use the scan's heads"; the
  shade map reads `.trees` and `.fences` the same way; the lawn mapper reads
  `.lawn`. The scan tool never writes another tool's part. Those buttons live in
  each tool's own code, so they are asked of the session that owns it (3.8).
- **Dashboard entry** in worker/src/unified.js TOOLS (core-owned, so ours):
  `{ id: 'scan', name: 'Yard scan', needs: [], url: 'https://scan.{home}/?map={id}', note: 'Experimental.' }`,
  admin-only (`admin: true`) until phase 3's test passes on real yards. The
  walk page is also linked from the water map's heads card (asked of the water
  session).

### 3.6 Where Finish runs, and what it costs

One walk with a 1-3 minute wait rules out GitHub Actions as the solver (a job
takes a minute or more just to start, and a workflow is not built to answer a
web page). Choices:

| Where | Wait after Finish | Cost | Notes |
|---|---|---|---|
| **Modal CPU** (the model server's account, a new function) | 1-3 min (estimate) | roughly 2-5 cents a walk (estimate: 4-8 CPUs for 5-10 minutes in total) | the site already runs lidar fetches there; **needs the owner's yes** |
| **Modal GPU** for the 3D splat (bonus only) | +5-10 min, in the background, after the heads are shown | roughly 10-50 cents a walk (estimate) | not needed for heads; **needs the owner's yes** |
| **On the phone** (WebAssembly solver) | unknown, likely several minutes, phone gets hot | free | a much bigger build; an experiment for later |

Every estimate is to be measured on real walks before anything is switched on
for users, and reported back with the real figure.

### 3.7 Importing a ready-made scan (bonus)

A Scaniverse (or Polycam, Luma) PLY or SPZ can be uploaded and lined up with
steps 3.3.3-3.3.7, for people who already have one. Scaniverse builds splats
free on an iPhone. This is not the main path: those apps do not let you tap
heads during the scan.

### 3.8 The other sessions

- **Water session.** Its AR page (H64-H68) is this tool's ancestor, and the
  owner has asked the core session to lead this work. Tell them early so the
  work is not done twice, and ask (they own water/): the walk page becomes the
  way heads are placed; their AR page's lessons (walk weighting, the phone's
  scale, anchor jumps, the H68 lidar search) are carried into scan/lib with
  the source named; heads stay in `tools.water.data` after a "use the scan's
  heads" import on the water map, which they build. Their walk logs from H65-
  H67 are the best test data for the solver, if they kept them.
- **Features session (shade).** Ask for: reading `tools.scan.data.trees` and
  `.fences` into the shade model, and later loading the scan's fine ground. They
  own public/shade*.
- Both are messaged by a one-time scheduled Routine into their session (see
  CLAUDE.md). This plan is the thing to point them at.

### 3.9 Privacy and security

- A walk is pictures of someone's yard and house. It is private to its owner:
  R2 keys by owner, served only to that owner, never public, never in the
  repository, never used for training without an explicit opt-in.
- People or faces caught in the pictures: the 3D model blurs them away in
  practice, but the pictures do not, which is one more reason to delete the
  pictures once the walk is solved (kept 7 days at most, for re-solving).
- GPS from the walk is used for the line-up and then kept only as the
  transform. No addresses in the repository, logs or findings (CLAUDE.md).
- Upload limits and type checks: pictures are JPEG with a size cap per walk;
  imported scans are a PLY or SPZ with a size cap, parsed in a worker, never
  executed.


## 4. Phases, each with a done test

Heads come first; every bonus waits until heads pass their test. Each phase is
admin-only until its test passes on a real yard, and its result goes in the
Findings below.

1. **The walk page.** scan/ folder, its Worker and deploy workflow, the R2
   bucket made by CI, the dashboard entry (admin). Camera, crosshair, pictures
   kept by distance and turn, sensor readings, taps saved as picture + pixel,
   background upload with an offline queue. Android: ARCore poses and live
   pins. Both phones.
   *Done when:* a walk on the owner's lot from the iPhone and the S21 arrives
   in R2 complete, every tap with its picture.
2. **Solve the walk.** The solver as a Modal function (after the owner's yes,
   section 5), run on walk 1's pictures; head points by tracking and
   triangulation.
   *Done when:* the walk's own model, with no map yet, puts heads at the
   right distances from each other: taped head-to-head distances within
   0.15 m.
3. **Line it up and save.** georef.js (3.3), the confirm screen, heads saved
   in `tools.scan.data.heads`; the water map's "use the scan's heads" (asked of
   the water session).
   *Done when:* heads on the map are within 0.3 m of their tape-measured spots
   (taped from two house corners), on both phones. For comparison, H66's check
   points were 0.01-2.56 m off.
4. **Make it smooth.** Incremental solving during the walk so Finish takes
   1-3 minutes; coaching messages; downspouts, valve boxes, fence ends as tap
   kinds; gutters from the roof edge.
   *Done when:* Finish to heads-on-map is under 3 minutes for a 10-minute walk.
5. **Bonuses from the same walk.** Fences, trunks and crown edges, fine
   ground, the lawn inside the property line (3.4); the splat for viewing (GPU,
   only with the owner's yes); Scaniverse import (3.7). Offered to the other
   tools through their own import buttons, asked of their sessions.
   *Done when:* the scan's lawn agrees with the owner's trace within 5% of
   area where the walk covered it; fences match what the owner draws by hand.
6. **Optional: live pins on iPhone** (8th Wall's SLAM binary), and on Android
   live correction during the walk against the solved model, so live pins are
   already right. Only if phases 1-4 leave a reason for it.

## 5. Decisions for the owner

1. **Modal CPU for Finish** (phase 2): a few cents a walk, estimated, with a
   1-3 minute wait. Without it, the free choice is solving on the phone, a much
   bigger build with an unknown wait. Recommended: yes, with the real cost
   measured on the first walks and reported before anyone else uses it.
2. **Modal GPU for the 3D splat** (phase 5): not needed for heads. Decide
   later with a measured cost.
3. **Live pins on iPhone** (phase 6): decide after phase 4.

## 6. Open questions to settle by measuring, not arguing

- How well a scan's ground lines up with 3DEP ground under grass (lidar ground
  is the soil; the scan's is the grass top, a few cm higher).
- Whether one walk per yard is practical (a typical walk is 3-10 minutes;
  Scaniverse suggests phone scans up to about 500 square metres, so a large yard
  may need two scans merged).
- How old lidar (the owner's county is 2016) affects the line-up where the
  yard has changed (new fence, removed tree). The house should carry it.
- Whether a head, a few centimetres tall and often sunk in grass, can be
  followed across pictures reliably (3.1), or whether the sight line meeting
  the solved ground is the better fix. Test both on the first walks.
- Whether a lawn walk, mostly grass with few features, solves without gaps.
  The coaching ("keep the house in view now and then") is the guess at a fix;
  the first walks will say. Plain grass is also where ARCore drifted most
  (water S20).

## Findings

None yet. Record each measured result here: HARD (measured, with the yard
named only as "the owner's lot" or by its lng,lat map id, never an address) apart
from SPECULATION.
