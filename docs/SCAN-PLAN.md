# The yard AR tool: research and build plan

Written by the core session, 2026-11-01, at the owner's request, and rebuilt
twice the same day as the owner set the priorities. The core session builds it
(a core-owned tool, not a features or water session tool). This file is the
build spec. Keep it current as phases land, and record measured results in
"Findings" at the bottom, HARD apart from SPECULATION, the same way
docs/DETECTOR-FINDINGS.md does.

## 0. What the owner asked for, in their words

The request:

> "i wanted you to spearhead it as a new tool with a common codebase that can be
> shared between the maps for their respective purposes. Ideally it would be a
> new tool accessible from the dashboard that scans the lawn environment and
> allows users to place gutters, sprinkler heads, and refines the data that was
> acquired from the lidar. Even better, it'd be awesome if it could even refine,
> or wholly substitute, the initial lawn mapper by finding lawn within the
> property line."

The first priority:

> "at the core of this, the original intended use is as a way to place
> sprinkler heads on the lawn. Because A. Placing dots on a map is tricky, a
> sprinkler in the middle of a lawn is just not visible from aerial imagery. B.
> We tried GPS, walk the lawn and press "place a sprinkler here" but that was
> terribly inaccurate. So... The ability to walk the lawn, point to the
> sprinkler with the cursor and tap "add a head here" is really the original
> point. Everything beyond that is a bonus, but a potentially huge bonus that
> be be smoothest if it could all work in one session of walking the lawn"

Live AR is required, and iPhone is in:

> "the other thing I wanted to do, eventually, was to have a viewer that allows
> the user to walk the lawn and inspect specific areas based on the output of
> the shade map and water map. So basically, real time ar is crucial."
>
> "It looks like 8th wall and slam support Safari in iPhones. Slam is not open
> source, but it's free. Vps is gone, but we could calibrate the initial
> location with 2 reference points, while maintaining the fix by referencing
> 3dep. Worst case scenario, if my research was wrong and 8th wall doesn't
> actually support Safari, iPhone users can still download the Mozilla web xr
> app"

And on the water session's first AR walks:

> "That point about drift because of looking around only applies to that first
> attempt with ARcore. I think there were other issues with our implementation,
> so don't take that as a given fact."

So the water session's H65-H67 results are **measured outcomes of one early
page**, not proof of what limits phone AR. Their causes are SPECULATION here.

And on references, lidar and what to trust (2026-11-01, after the live-first
draft):

> "I do like the idea of prescriped reference points, but they should probably
> be driveway corners instead. Because lidar may underestimate the location of
> walls because of eaves, front door entrance arches, porches, etc."
>
> "we also need to keep that point in mind when using lidar points as
> references... Don't trust what's under anything that the lidar can't see the
> ground at. Trees should be a good reference as long as we have a way to error
> correct for the fact that trees grow or may be cut down since the lidar was
> taken, roofs too, and driveways would be great. Maybe prompt the user to look
> up if the fix is getting lost. All in all, i think slam should hopefully take
> some of the burden off of that."
>
> "to be clear, i want to make use of the Niantic innovations (like the gaussian
> splats and slam) because they seem very promising."

So: driveway and paving corners first; nothing under a roof or a crown is
trusted as a reference; trees and roofs are matched with an allowance for
change since the flight; and Niantic's SLAM (8th Wall) and Gaussian splats
(SPZ, Scaniverse, the splat viewer) are to be used where they fit.

## 1. The short version

- **One live AR page for both phones.** Open it on the lawn, the camera shows
  the yard with a crosshair. Put the crosshair on a head, tap "add a head
  here", and the head appears where you aimed, live, in place.
- **Tracking:** Android uses Chrome's WebXR (ARCore). iPhone uses 8th Wall's
  free SLAM engine, which runs in Safari. Both sit behind one small interface,
  so the rest of the code does not care which phone it is on. If 8th Wall fails
  on an iPhone, the fallback is Mozilla's WebXR Viewer app (old, see 2.3).
- **Where am I on the map:**
  1. **Start:** mark two reference points (the owner's idea). They are chosen
     from the lidar where possible (house corners, which do not lean or move),
     shown in the AR view to aim at, rather than tapped on the aerial photo.
  2. **Keep the fix:** every second or two, what the phone sees (walls, fences,
     trunks, the ground's shape) is matched against the 3DEP lidar, and the fix
     is nudged. Android has a depth picture for this (the water session built
     the match in H68). iPhone uses 8th Wall's 3D feature points instead.
  3. **More references any time:** a third or fourth point improves the fix.
- **Then the viewer:** the same page draws the shade map's and water map's
  results on the real lawn: sun hours, dry and wet spots, sprinkler coverage,
  where water runs and pools. Each map provides its own layers through a shared
  layer format (3.4).
- **The bonuses ride along:** the page also keeps a picture every half metre
  with its camera position. Those pictures can later build a 3D model of the
  yard (fences, trunks, fine ground, the lawn's edge, a splat to look at), and
  can sharpen every tap after the walk. None of that needs a second walk, and
  none of it is needed for heads.
- Niantic's location service (VPS) is gone from 8th Wall and native-only
  elsewhere, so it is not used.

## 2. What the research found

### 2.1 8th Wall (open source since Feb 2026)

- The open-source engine is MIT and covers image targets, face effects and sky.
  It has no SLAM.
- **SLAM ships in the free "Distributed Engine Binary"** (Jan 2026, xr.js),
  loaded from our own pages (a script tag or a copy in our files). Commercial
  use is allowed as part of a larger app. The license notice at the top of
  xr.js must stay, unmodified, and a credits screen must show the copyright
  notice and a link to the LICENSE (github.com/8thwall/engine). Not under
  active development, so a future iOS could break it and nobody would fix it.
- 8th Wall's whole history is AR in mobile browsers, iPhone Safari included,
  and its engine lists "Absolute Scale". **Whether today's binary runs well on
  the owner's iPhone is the first thing to prove** (phase 1).
- World tracking gives a camera pose every frame and a hit test that returns
  3D points of type FEATURE_POINT, ESTIMATED_SURFACE or DETECTED_SURFACE
  (XR8.XrController.hitTest). The feature points are what the iPhone feeds to
  the 3DEP match. It works with three.js.
- Not included: VPS, Lightship Maps, the Geospatial Browser, hand tracking.
- Sources: https://8thwall.org/docs/open-source ,
  https://github.com/8thwall/engine ,
  https://8thwall.org/docs/api/engine/xrcontroller/hittest ,
  https://8thwall.com/docs/migration/faq

### 2.2 Niantic Spatial (VPS, Scaniverse, SPZ)

- Pricing (nianticspatial.com/en/pricing, read 2026-11-01): Free plan $0 with
  about 1,500 VPS queries a month; Plus $20 a month; Pro $50 a month.
- VPS needs a VPS map of each place, built from a scan of that place. The SDK
  (NSDK 4.0, Apr 2026) is Unity, Swift, Android and ROS 2. **No web SDK.**
- **Scaniverse** (iPhone app): free on-device splats, exports PLY or SPZ. Splats
  are metric scale but not georeferenced. A possible import later (phase 6).
- **SPZ** is Niantic's open splat format, about 10x smaller than PLY.

### 2.3 Phone platforms

- **iPhone Safari:** no WebXR (no immersive-ar, no ARKit from the browser).
  AR in Safari comes from engines that do their own tracking from the camera
  and motion sensors, which is what 8th Wall's SLAM is.
- **Mozilla WebXR Viewer** (iPhone app, a browser with WebXR on ARKit): still
  listed on the App Store, but last updated around 2020, described by Mozilla
  as experimental and "not an officially supported Mozilla application". A
  fallback to test once, not a foundation.
  (apps.apple.com/app/id1295998056, github.com/mozilla-mobile/webxr-ios)
- **Android Chrome:** WebXR immersive-ar with hit-test, anchors, depth sensing
  and camera access, all four confirmed on the owner's S21 (water H68).
- **ARCore Geospatial / Streetscape:** native apps only.

### 2.4 Splats in the browser (bonus)

- **Spark** (sparkjs.dev, MIT): a three.js splat renderer for PLY, SPZ and
  others; WebGL2; built for phones.
- Training splats in the browser (Splat.js, Brush) exists on WebGPU; too heavy
  for a phone over a yard today.

### 2.5 What this repository already has (code read, 2026-11-01)

- No three.js, splats, 8th Wall or Niantic anywhere. 3D is raw WebGL
  (public/shade/view3d.js, water/public/view3d.js).
- **The water session's AR test page** (water/public/ar.js, water/lib/ar-align.js,
  water/lib/ar-lidar.js, water/public/ar-lidar-worker.js; admin only, Android):
  references marked on the photo and in AR, a fit that tells a slide from a
  turn, the phone's scale held per phone, anchors, and (H68) a fix from the
  phone's depth picture matched to the lidar, built but not yet walked. Its
  results stay in localStorage. The water session has agreed (2026-11-01) to
  hold new features on it until this tool exists, and to let its code be
  carried into scan/lib with those four files named as the source.
- **Measured on that page** (water/FINDINGS.md; outcomes, not causes): the
  phone measured distances 3.6% and 4.4% short on two walks; check points
  0.01-2.56 m off; anchors moved 0.19-0.67 m, one 21 m; reference dots tapped
  on the photo disagreed by up to 1.3 m; a head aimed from 14 ft landed 7 ft
  off. The owner's 2016 county lidar has about 3 points a square metre and no
  building or tree classes; the house is found by the water map's roof rule.
- **The shade map's 3D model** is rebuilt from lidar each visit, not saved.
  Frame: x, y in EPSG:3857 metres, z in real metres; real metres = mercator
  metres x cos(lat). shade/align.js gives a `shift` lining lidar up with the
  photo, saved in `tools.shade.data.lidar`. shade/ground.js makes the ground.
- **The map record (docs/MAPS.md):** lawn `shapes` and `parcel`; fences in
  `tools.shade.data.fences`; heads in `tools.water.data.irrigation.heads[].at`
  ([lng,lat]); gutters in `tools.water.data.gutters` and `downspouts`. A tool
  part is at most 64 KB and written only by its own tool. The dashboard lists a
  tool from `TOOLS` in worker/src/unified.js.

## 3. The design

### 3.1 One tracking interface, two engines (lib/track.js)

```
            page code (aim, tap, draw layers)
                         |
                  lib/track.js
          pose each frame, hit test, points seen
             /                          \
   WebXR engine                     8th Wall engine
   Android Chrome (ARCore)          iPhone Safari (SLAM in xr.js)
   + depth picture, anchors         + feature points
             \                          /
          Mozilla WebXR Viewer on iPhone uses the WebXR engine
```

- The interface gives: the camera pose each frame in the session's own frame
  (metres, y up), a hit test at the crosshair (the ground, or the nearest
  surface), the 3D points around the phone (depth on Android, world points on
  iPhone), tracking state (good, limited, lost, reset), and the GL context and
  matrices to draw with.
- Rendering: phase 1 draws its dot and pins in plain WebGL (scan/lib/draw.js)
  so the bare test has no library to load; three.js comes in with the viewer
  (phase 4), where layers and splats need it.
- Phase 1 also runs 8th Wall on the Android phone, to compare the two engines
  on the same lawn.
- **The 8th Wall binary, as built (read 2026-11-01):** it is served from our
  own site (scan/tools/prepare.mjs copies @8thwall/engine-binary 1.0.0's
  dist/ unchanged at deploy time; never committed). It still looks for an
  "appKey" on its script tag and falls back to the script's address when
  there is none; its own text calls this "standalone mode", in which the
  platform token (VPS and the rest) "is not available". World tracking should
  run without a key or a server; the first phone test says. Its license
  (section 1.2) forbids use in a product "offered for a fee" whose value
  "derives, entirely or substantially" from the engine; Lawn Mapper's paid
  maps are the maps, and the AR page is one view of them, so this is within
  it, but it is a line to remember if the AR tool were ever sold on its own.

### 3.2 Where am I on the map (lib/locate.js)

Two frames: the session's (where the phone started) and the map's (EPSG:3857
metres, the shade frame). The fix is the turn, shift and, if measured, scale
between them.

1. **Two references to start.** The page offers candidates, in this order
   (the owner, 2026-11-01): driveway, sidewalk and patio corners, taken from
   the paving the lidar and the photo agree on (the lidar sees the ground
   there, so the corner is where it says); then a fence post or a shed
   corner; and only when none of those is handy, a house corner, which the
   lidar places by the roof and so may sit outside the wall by an eave,
   porch or arch. Each candidate is drawn in the AR view to aim at, and can
   be dragged on the photo if it is off. The user aims at each and taps. Two
   points give the turn and the shift. Scale comes from the tracking engine;
   with a third point it is checked, and the page reports it.
2. **Keeping the fix with 3DEP.** Every 1-2 s, the last stretch of what the
   phone has seen (points 0.25-2.5 m above the ground: walls, fences, trunks,
   shrubs; and the ground's own shape) is gridded and searched against the
   same grid from the lidar, starting from the current fix. A new fix is taken
   only when most of the points land and no clearly different fit is nearly as
   good (the H68 rules). It is applied smoothly so pins do not jump.
   Android: the depth picture (H68's code, carried over). iPhone: 8th Wall's
   world points (`enableWorldPoints`, phase 1 counts them). Whether they are
   dense enough is a phase 2 question.
   **What the lidar is trusted for** (the owner, 2026-11-01): only cells where
   the lidar saw the ground. Under a roof overhang or a tree crown the ground
   is interpolated, so a wall foot or a trunk there is a weak match, never a
   reference. Paving, fences, sheds and the house's roof edge seen from below
   are strong. Trees and roofs are matched with an allowance for change since
   the flight (a crown may be wider or gone, a roof replaced): a standing
   point that lands near nothing costs little, and a lidar feature with
   nothing near it in the walk is not held against the fix.
   **Look up.** When the fix is slipping and the ground around the phone is
   plain grass, the page says "look up": roof edges and crowns against the
   sky are the lidar's strongest features and the phone's clearest ones. SLAM
   itself carries the fix between matches, so the match need not be constant.
3. **References any time.** "Mark a reference" stays on screen; each new
   one improves the fit. A reference far back in the walk counts for less, so
   an old error does not hold the fix (the water page's walk weighting is the
   starting point; its numbers are to be re-measured, not assumed).
4. **Watching the fix.** The page shows its confidence. Lost tracking or an
   engine reset puts it in "re-mark one reference" mode. Each tap stores the
   fix's state at that moment.

### 3.3 Placing things (lib/place.js)

- Tap kinds: sprinkler head, valve box, downspout foot, fence end or corner,
  tree trunk, and a check point (a known spot, not used in the fit, to measure
  accuracy).
- A tap stores: the map position from the live fix; the session position;
  the hit type; the aim distance; the fix's confidence; and the picture plus
  the crosshair pixel (so the tap can be sharpened later, 3.6).
- Aim distance matters: the page warns when aiming from far away (H67's 14 ft
  case) and suggests stepping closer.
- Gutters without aiming into the air: tap each downspout's foot; the gutters
  come from the roof edge the lidar has, and are shown in AR to confirm.

### 3.4 The viewer: shade and water on the real lawn (lib/layers.js)

- A **layer** is a georeferenced thing to draw on or above the ground: a
  raster on the ground (sun hours in a month, soil moisture, water-table depth,
  sprinkler coverage), lines (flow paths, gutters), points (heads with their
  spray arcs), or volumes (tree crowns, fences).
- Each tool supplies its own layers from its own part of the map record or
  its own public routes, in one small shared format, so the AR page draws them
  without knowing what they mean. The shade and water sessions own what their
  layers say and how they are computed; the format is agreed with them.
- Layers are draped on the lidar ground (shade/ground.js heights) so they hug
  the slope, and hidden behind the house and trees using the lidar's solid
  cells (drawn invisibly to block what is behind them).
- A tap on the lawn in viewer mode shows that spot's numbers (e.g. "5.2 sun
  hours in June, 0.6 in of water short this week").

### 3.5 Where it lives and how the maps share it

- **A folder of its own: `scan/`**, its own Worker at `scan.<home>` (domain
  from vars.CUSTOM_DOMAIN at deploy time, as tools/home-prepare.js does), its
  own deploy workflow, reaching `/api/maps/*` over a service binding as the
  water Worker does, and an R2 bucket for pictures made by CI
  (tools/ci-prepare.js pattern).
- **Shared library `scan/lib/*.js`**, plain ES modules, served at
  `https://scan.<home>/lib/<file>.js` with CORS: `track.js`, `locate.js`,
  `place.js`, `layers.js`, `frames.js` (map, session, lng/lat and local metre
  conversions, matching water/lib/ar-align.js and shade/ept.js), `lidar.js`
  (the lot's cloud gridded for the match, carried from ar-lidar.js).
- **Vendored libraries** in scan/vendor/ at exact versions: three.js, the 8th
  Wall xr.js with its notice intact, later Spark. A credits screen links the
  8th Wall LICENSE.
- **The map record:** the tool writes only `tools.scan.data`: the placed taps
  (heads, downspouts, etc. with [lng,lat] and confidence), the reference
  points, the walks (date, phone, engine, fix quality), all under 64 KB.
  Pictures live in R2 under the owner's key.
- **Each tool keeps its own part.** The water map imports
  `tools.scan.data.heads` into `tools.water.data` with a button it builds (the
  water session has agreed and wants the heads' shape once settled). The
  shade map may later read trunks and fences the same way.
- **Dashboard entry** in worker/src/unified.js TOOLS (core-owned):
  `{ id: 'scan', name: 'Yard AR', needs: ['shade'], url: 'https://scan.{home}/?map={id}', note: 'Experimental.' }`
  (needs the shade map because that is where the lot's lidar and its photo
  shift come from), admin-only until phase 3's test passes. Also linked from
  the water map's heads card (asked of the water session).

### 3.6 The bonuses from the same walk (later)

- **Sharpen every tap after the walk.** The kept pictures, with their camera
  poses, are solved together after the walk (bundle adjustment), and each tap
  is recomputed from its picture and pixel. Optional: only if live accuracy
  falls short. Needs a server (Modal, which costs money: ask first with a
  measured cost) or an on-phone solver.
- **A 3D model of the yard** from the same pictures: fences (line and height),
  trunks and crown edges, ground heights every 10-20 cm, the lawn's edge inside
  the property line (offered to the lawn mapper as a suggestion, never over the
  user's trace), and a splat to look at. Only where the walk went.
- **Scaniverse import** (PLY/SPZ) lined up with the lidar the same way.

### 3.7 The other sessions

- **Water session:** agreed to everything in 2026-11-01's message (hold the AR
  test page, code carried with sources named, heads imported into
  tools.water.data). Tell them the heads' shape when settled, and agree the
  layer format with them before phase 4.
- **Features session (shade):** agree the layer format; later, trunks and
  fences from the scan. They own public/shade*.
- Both are reached by a one-time scheduled Routine (CLAUDE.md).

### 3.8 Privacy and security

- Pictures of someone's yard and house are private to the map's owner: R2 keys
  by owner, served only to them, never public, never in the repository, never
  used for training without an explicit opt-in, deleted once used (7 days at
  most).
- GPS is a rough start only, kept as the fix, not as a track.
- No addresses in the repository, logs or findings (CLAUDE.md).
- Upload limits and type checks on everything the page sends.

## 4. Phases, each with a done test

Each phase stays admin-only until its test passes on a real yard, and its
result goes in the Findings.

1. **Tracking on both phones.** scan/ folder, Worker, deploy workflow, the
   dashboard entry (admin). track.js with both engines. A bare page: camera,
   crosshair, hit-test dot, a pin you can drop. Built 2026-11-01; the first
   walk is SCAN-H1.
   *Done when:* on the owner's lot, WebXR on the S21 keeps a pin dropped on a
   spot, walked away from 20 m and back, within about a foot of the spot, and
   two taped marks 10 m apart read within 2%. The iPhone side waits: the
   owner has no iPhone and will rarely have one, so 8th Wall is kept working
   on Android for the day one is at hand, and is not a gate.
2. **Locate.** Two references (driveway and paving corners first), the 3DEP
   match from the depth picture, the fix's state on screen, check points.
   Built 2026-11-02 (scan/lib/align.js, locate.js, lidar.js and
   lidar-worker.js, the last two carried from the water session's H68 code
   with their agreement; the page's photo with references and check points).
   References are tapped on the photo by hand for now; offering paving
   corners automatically is a later refinement.
   *Done when:* five check points spread over the lot (taped from house
   corners) read within 0.3 m, after a full walk of the yard, on the S21.
3. **Heads.** Tap kinds, saving in `tools.scan.data`, the water map's import
   (water session).
   *Done when:* the owner's heads, placed in one walk, are within 0.3 m of
   tape-measured spots, on both phones.
4. **The viewer.** The layer format agreed with the shade and water sessions;
   their layers drawn on the lawn, draped and hidden behind the house.
   *Done when:* the owner walks the lot with shade and water layers on and the
   layers stay put on the lawn (within 0.5 m) for the whole walk.
2b. **The ground-class match** (section 7): the lawn and paving edges from
   the map (the lawn trace, the photo, the lidar's ground intensity) against
   the phone's ground points classed grass or paving from the camera picture
   and the depth step. Dense, unchanged since the flight, strongest in the
   front yard. Only after 2's log says where the solid-cell match fails.
5. **Sharpen after the walk** (only if 2-3 fall short; server cost asked
   first).
6. **The 3D model bonuses**: fences, trunks, fine ground, lawn edge, splat,
   Scaniverse import.

## 5. Decisions for the owner

None blocking phase 1. Later:
- A paid server for sharpening taps or building the 3D model (phases 5-6):
  only if needed, with a measured cost first.

## 6. Open questions to settle by measuring, not arguing

- Does 8th Wall's binary track as well as ARCore outdoors on grass? On the
  owner's iPhone, at all? (Phase 1.)
- Are 8th Wall's feature points dense enough to match against 3DEP, without a
  depth picture? (Phase 2.)
- Does a 2016 cloud at 3 points a square metre carry the match where the yard
  has changed since (new fence, removed tree)? The house should.
- Lidar ground is the soil; a phone sees the grass top, a few cm higher. Does
  that matter for the match? Probably not; measure.

## 7. The lock: what the match sees, and what the literature says (2026-11-03)

The owner, after SCAN-H2: why was the lock so wrong; is it looking at the
lidar ground; is the alignment the same as the shade map's; show the lidar in
the camera; what logging is there; and would matching against aerial
imagery draped over the lidar be a better system? With a literature review.

**What the match is fed (scan/lib/lidar.js, carried from water H68).** Two
grids at 0.25 m from the lot's cloud: the bare ground (ground returns,
holes filled) and the "solid" cells: lidar points 0.25-2.5 m above the
ground (fences, shrubs, trunks, parked cars at the flight, low branches)
plus the house's walls (its roof footprint pulled in by the eaves, then its
outline). From the phone: the depth picture's points sorted into ground
(within 0.2 m of the ground level) and standing (0.4-2.4 m above it). The
cost: standing points must land near solid cells (truncated at 1 m);
ground points must follow the lidar ground's SHAPE up to one height offset
(weight 0.5, truncated at 0.3 m). On a flat lawn the ground term carries
no position at all (a plane fits anywhere): position comes from the
standing points alone. So yes, it looks at the lidar ground, and the ground
helps only where it has shape (a step, a drop, a bank).

**Where it went wrong in SCAN-H2 (SPECULATION, to be read off the new
log).** Three candidates: (1) the first fix was seeded from GPS, any turn,
up to 20 m round the GPS point, on a lawn whose fences and walls repeat;
with half the points landing it passed the 50% bar, and the next fixes
searched only 1.5 m round it; (2) the phone's ground level came from the
crosshair's depth, one number for the whole walk, so on a slope or a drop
standing and ground points were mislabelled; (3) the lidar's solid cells
hold what stood there at the flight, not what stands there now.

**Alignment.** The same as the shade and water maps: the shade map's kept
shift (its lidar ground INTENSITY matched to the photo the lawn was traced
on, which is Mapbox's ground or a county photo moved onto it), else the
NAD83 correction at the flight's epoch. The references are tapped on the
Mapbox photo, so references and lidar share a ground frame to within the
shade shift's error (under 20 cm when applied). Alignment is not the 8.9 m.

**The literature.**
- Render-and-compare against a textured mesh works where the mesh has
  the texture the camera sees: MeshLoc (Panek, Kukelova, Sattler, ECCV 2022,
  arxiv.org/abs/2207.10762) found rendering realism matters little, and
  Render2Loc (Yan et al. 2023, arxiv.org/abs/2302.06287) reports
  centimetre-level poses from a textured OBLIQUE aerial mesh with a noisy
  prior, rendering depth as well as colour. But on the 2025 egenioussBench
  (aerial textured mesh, city scale; emergentmind.com/papers/2605.05351)
  the mesh-based methods placed only 19% of queries within 0.5 m and 2 deg
  on the hard split, blamed on "viewpoint discrepancy and textureless
  geometry". A NADIR orthophoto draped on a 2016 DEM is the weakest case of
  this: no facade texture at all, grass seen from above against grass seen
  at grazing angles.
- Ground-to-aerial cross-view localization (Shi et al. 2020,
  arxiv.org/abs/2005.03860; the 2025 air-ground benchmark,
  arxiv.org/abs/2509.07362; Nuro's DSM work, arxiv.org/abs/2503.13896)
  reaches metre-level, sub-metre only with learned models trained on
  aligned vehicle lidar, none of it browser-sized.
- What does reach centimetres from a camera is SEMANTIC map matching, the
  driving literature: curbs, lane markings and crosswalks against a vector
  map (RoadMap, Huawei, arxiv.org/abs/2106.02527; Poggenhans et al. 2018,
  KIT; the HD-map survey arxiv.org/abs/2409.09726). Curbs give "a reliable,
  continuous lateral constraint"; the limit is feature density.
- Google's own answer (ARCore Geospatial / Streetscape Geometry,
  developers.google.com/ar/develop/.../streetscape-geometry) localizes
  against building meshes made from Street View, i.e. facades, and is
  native-app only.
- Smartphone-to-prior-lidar registration outdoors (ISPRS Annals 2026,
  isprs-annals.copernicus.org/articles/XI-4-2026/205/2026/) aligns phone
  scans to prescanned tiles with GNSS only to pick the tile: the same shape
  as ours, with a denser prior.

**So: would imagery draped over the lidar be the better system?** Not as
pixels. The yard's camera view is facades, fences, trunks and grass at a
grazing angle, none of which a nadir photo holds, and the one published
benchmark on aerial meshes puts that approach at 19% within half a metre.
What the owner's idea does point at, and the literature backs, is matching
what the photo DOES hold that the phone can also see: the edges of paving
(driveway, sidewalk, patio, curbs) and the lawn's own outline. The photo
and the lawn trace give those as lines on the map (the lawn mapper's
product); the lidar's ground intensity gives them too (shade/align.js);
and the phone can classify its ground points as grass or paving from the
camera picture under each depth sample, and see the curb step in depth.
Matching that boundary is dense (metres of edge, not a few posts),
unchanged since the flight, and strongest exactly in the front yard where
the references now go by hand. That is phase 2b.

**Built now (SCAN-H2's follow-up):** the lidar drawn in the camera view
through the fit (solid cells blue, canopy green, roofs orange, see-through,
with a Lidar button to hide them), black dots where the phone's standing
points land on a solid cell and red where they land on nothing; the ground
level per 1 m column instead of one number from the crosshair; and a log of
every ask (points offered, prior, time, landing share, cost, the runner-up's
ratio and distance, the disagreement with the references, kept or why not)
in the walk's copy.

**Walls judged one by one (owner, 2026-11-03).** Walls usually stand within
2 ft of the roof's edge, sometimes a foot or less, sometimes 10 ft (a porch,
a sunroom, rarely a pavilion). So the match no longer assumes 2 ft. What the
phone sees standing is cut into pieces in its own frame (a corner splits two
walls; a bush stays whole), and under each placement a piece that lands just
inside a roof finds its OWN inset, measured straight across itself. Its
points pay for being crooked to the roof's edge, not for the inset; an
unusual inset (past 3 ft) pays a small charge, and a long wall no more in
all than a short one's, so a porch wall seen well cannot outvote the trees.
The price, measured in scan/test/lidar.test.js: one long wall alone no longer
says how far from it the phone is (the made-up lot's first fix went from
within 15 cm to within 25 cm); the porch case it was built for is found
where the 2 ft rule is pulled off.

**The roof's edge.** Points the phone sees 2.4 to 12 m up (gutters, fascia)
are matched to the lidar roof's edge itself, which needs no inset at all.
A high point far from any edge (a crown) costs the same wherever the
placement puts it, so trees neither help nor hurt there. Looking up at the
gutters is now a way to get a fix.

**Skeptical of a jump.** A fix more than 1.5 m or 8 degrees from the last
kept one is held, not taken; the next search is widened to reach both, and
the jump is taken only if a second fix agrees with it within 0.6 m (the
world moved: ARCore corrected its map). The walk's copy counts jumps held
and taken.

**The walk's twin, kept (owner, 2026-11-03: "start saving the outputs of the
digital twin that is being constructed? I want to see how it lines up with
reality").** Every walk now sends, as it goes, what the phone built: its depth
points (one per 5 cm cube, with the ground it stood on), its track five times
a second, a camera picture about once a second while moving (WebXR
camera-access, with each picture's pose and projection), and the fixes and
marks so far. They go to the scan site's own R2 bucket (scan/lib/twin.js,
scan/src/twin.js; the bucket made by scan/tools/r2.mjs in the deploy), admin
only, never into a log. /twin.html lays a walk over the photo and the same
lidar: the phone's walls, fences and trunks in red against the lidar's in
blue, placed by the walk's own fixes, the references alone or the fixes
alone, with how many land within a foot.

**Gaussian splats.** Not made by ARCore or WebXR: ARCore gives tracking,
depth, planes and the camera picture. A splat is built after a walk from
many posed pictures (what Niantic's Scaniverse does on the phone, and what
gsplat or nerfstudio do on a GPU). The twin's pictures, each with its pose,
are what such a pass needs; running one wants a GPU (Modal is paid: asked
first). Workflow "S2. Yard AR splat" (scan-splat.yml, scan/tools/splat_modal.py)
does it for one walk when the owner says so: gsplat on a Modal GPU, started
from the phone's depth points and trained against its pictures at the poses
ARCore gave them (no structure-from-motion step), kept beside the twin and
shown on its page with the pictures beside the splat's renders. The 8th Wall engine is Niantic's tracking (its SLAM), not its
splats; its view on the S21 was a broken fisheye in the first walk, and the
canvas fix for that is untested.

## 8. The lidar is the shade map's finished model, read, not rebuilt (2026-11-04)

The owner, after SCAN-H7: "I want the AR to perfectly follow the shade map's output at this point. That means any
rules you have about height that differ from shade map rules, remove. It will be too difficult to hunt down bugs
between 2 different implementations of the same thing... I don't want duplicate files here. There should be one
base set of files for making 3d maps from lidar... When a map goes into the shade map, the lidar gets built,
aligned, points get sorted/classified, then the finished output is saved. The AR shouldn't be rebuilding lidar
maps from scratch."

Done the same day: the shade map's finished model is one file per map (public/lib/lidar-model.js; PUT/GET
/api/maps/model, docs/MAPS.md), the AR's worker reads it and grids it (scan/lib/lidar-load.js gridsFromModel),
and every step the AR takes on top of it is in docs/SCAN-DIVERGENCES.md. Gone from the AR: its own point band
(0.25-2.5 m), its roof fallback, CROWN_M, LAWN_LOW_M, the 3 m default wall. The readers (ept.js, las.js, laz.js)
are no longer imported by the AR's worker. What the AR now knows only to a 1 m column: a roof's edge and a trunk's
place, so a fix resting on them is free by up to half a column; the tests say "to a column" where they said 25 cm
(scan/test/lidar.test.js), and two fits within 1.5 m are one place (lidar.js SAME_PLACE_M). If the walks show the
lock wants the roof's edge finer than a column, that is a request to the shade map (a sub-column edge in the
model), not a rule here. The shade map writes the file from its own session's change; until it does, the AR says
"open this map in the shade map first".

## Findings

HARD findings are measured, with the yard named only as "the owner's lot",
never an address. SPECULATION is kept apart and labelled.

### SCAN-H1. The first walk: WebXR on the S21 holds to about half a metre; planes put pins underground; one swing cost 3 m (2026-11-01)

The owner's lot, 8 minutes, 277 m walked, Chrome 156 on the Galaxy S21, Chrome's
WebXR (ARCore), at dusk with cloud coming in ("significantly darker outside by
the end"). The phone granted depth-sensing, camera-access, plane-detection,
anchors and dom-overlay. No tracking lost, no frame reset, 99.8% of frames
tracked. Pins were placed from 1.5-2.9 m. Measured (the page's copy, held in
the chat):
- **Drift when nothing went wrong:** P2 0.24 and 0.29 m off after 149 m walked;
  P6 0.10, 0.30, 0.35, 0.58 m after 1.5, 3, 68 and 80 m. About 0.5% of the
  distance walked, for comparison with the water page's 1% (water S20).
- **P1, 0.62-0.90 m off on every check, not growing** (six checks from 60 to
  149 m walked): a constant offset, and its 3D error (0.85-1.20 m) was larger
  than its level error, so the ground height was wrong when it was dropped,
  not the tracking since.
- **P4 and P5, 3.0 m off after 152 m,** both checked right after a burst of
  turns at 100-458 degrees a second (the copy's last fifty events). The owner:
  "one movement knocked the backyard pretty far out of alignment". ARCore
  reported no reset and no loss: it moved its map by about 3 m silently. The
  pins were not anchored, so nothing moved with it.
- **The ground:** the owner: "Some pins were placed several feet under ground,
  or 6 inches above it. (Note that my backyard sits about 6 feet lower than
  much of the front)". The page's hit test accepted planes, and ARCore
  stretches a found plane past where it saw it, so the front yard's plane
  reached under the back yard.
- The fast-turn alarm at 90 degrees a second fired 93 times, mostly ordinary
  looking round: too low.
- **8th Wall on the S21:** the owner did not use it: "the view on the 8th wall
  was very messed up. It was like a weird stabilized fisheye that had super
  poor resolution". The owner has no iPhone and will rarely have one.

Changed for the second walk (same day): the ground under the crosshair comes
from the depth picture first and the plane only as a comparison, both kept;
each pin gets an ARCore anchor and its checks say how far off it is as placed
and as anchored (an anchor moved more than 1.5 m is ignored, water H67); the
alarm at 150 degrees a second; walks saved to the site's own database and
printed by the workflow's `walks` task; the 8th Wall canvas sized to the
screen before the engine starts (SPECULATION: the blur and distortion were
the default 300 x 150 drawing buffer stretched by its style).

### SCAN-H2. The second walk: references mark cleanly; the lidar match locks wrongly and overrides them (2026-11-02)

NOT the owner's lot: the lawn at the owner's workplace (the owner, after the
fact: "this was not the same property as the ones over the weekend"), a
different county survey from SCAN-H1's. 5 minutes, 276 m walked, the S21,
WebXR, dusk again ("thanks to day light savings, it's once again getting
dark"). The lidar there read 224,382 points and 9,739 solid cells, lined up
by the shade map's shift; what the owner's home lot gives is not yet
measured by this page. Measured (the walk saved to the site; workflow S,
task `walks`):
- **References:** R1 marked three times, R2 twice, from 2.5-2.9 m. With only
  two, nothing says how far each was off (leaving one out leaves one).
- **The lidar match:** 207 asks, 5 fixes. Refused 198 times for too few
  points landing and 4 times for two places fitting alike. The five that
  passed landed 52, 52, 59, 60 and 71% of points, barely over the 50% bar.
- **The one check point, C1: 8.87 m off, by a lidar fix 4 m of walk old**
  (three fixes before it). A confident wrong lock, which the page preferred
  to the references. The owner also dropped the last pin where C1 is and the
  one before where R1 is; their map positions stayed on the phone, so the
  copy cannot say how far off they were (fixed below).
- Pins: all six by depth, from 2.0-3.0 m, the plane's answer within 0.02-0.2 m
  in height (no stretched plane this time). Anchored, but not checked.
- The fast-turn alarm at 150 degrees a second fired 4 times.

Changed (same day): a lidar fix that puts the phone more than 2 m or 10
degrees from where the references' fit puts it is refused and counted
("disagrees with the references by X m"); with no references a fix needs 65%
landing; every check point records its error by the fix and by the references
alone; every pin records its distance to the nearest reference or check point
(a distance, no position); the pin button says "Check pin", since "Mark" is
right for a check point too.

SPECULATION: the wrong locks come from the GPS-seeded first fix (any turn,
up to 20 m round a GPS point) on a yard whose fences and walls repeat; once
wrong, the "from the last fix" searches stay wrong. A 50% landing bar from
the water session's simulation is too low for a real yard with cars, people
and new fences; what the right bar is, the agreeing fixes will say.

SPECULATION from the first walk: anchors would have carried P4 and P5 with
ARCore's 3 m correction (ARCore moves anchors with its map; the water page's
anchors moved 0.19-0.67 m on ordinary walks, water H66) -- to be measured by
the as-anchored checks. The P1 offset came from a plane hit 0.5-0.6 m off in
height at a 2.7 m aim. Dusk may have cost accuracy; no daylight walk yet.

### SCAN-H3. A thin flight: the lock finds nothing to hold; the references hold; the canopy ring is phantom (2026-11-03)

HARD, measured on the owner's walk on a new lawn (not the owner's lot),
3 min, 168 m walked, WebXR on the S21, three references marked, no check
points (too bright to read the screen). The twin check (task `twin` of
workflow "S. Yard AR tool", scan/tools/twin-check.mjs) against the lidar
the page read:

- The flight is thin: 35,408 points over 15,286 m2, 2.3 a m2.
- 0 lidar fixes in 108 asks: 103 refused for too little landing (6-18%),
  5 for a crash (GPS off the edge of the lidar read; fixed, "GPS puts you
  off the edge of the lidar read for this map").
- Placed by the references alone, 6% of the phone's 8,673 standing points
  landed within 30 cm of a solid cell; of the 30% standing under a crown,
  none. Of what landed, 499 on building walls, 31 on the lidar's own low
  points, 0 on STRUCTURE walls.
- Within 6 m of the walk, every building-wall cell had something the phone
  saw (0 of 33 unseen); the lidar's own low-point cells 84% unseen (36 of
  43); the STRUCTURE walls 100% unseen (45 of 45). The STRUCTURE columns:
  142 in 13 patches, 29% touching a tree column, 35% within 2 m of one.
  These are the blue walls under canopies the owner saw: asked of the shade
  map (structures.js is the rule's home).
- Replayed through the match after the changes below, every 5 m from the
  references' fit: 23 asks, 3 fixes, 1 within 2 m of the references.

What changed on the AR side alone: low points under a crown are not solid;
with references marked a fix may pass on 40 points landed in number; the
runner-up must also land about as many points to count as "as good"; the
coarse pass scores 400 points. None of it rescues this flight.

SPECULATION, not yet measured: on a flight this thin the lock must come
from what a thin flight still sees well -- roof edges (the phone's points
2.4 m up hit them 66-75 times an ask late in this walk) and the ground's
shape -- and from the photo (phase 2b: drive, walk and lawn edges), not
from shrubs, trunks and fences, which it mostly does not have. Until then
the references are the walk's fit on such a lawn.

The first splat (workflow S2, the same walk, the owner's yes): 144 pictures
of 640x1422, 163,049 depth points to start from, 387,818 splats after 7,000
steps, 135 s of training on an L4 (the first run spent most of half an hour
building the GPU image, cached since). It matches its own pictures to 16.8
dB PSNR: rough (20 is rough, 25 good). The pictures are the right way up
(a short trial each way: 0.286 against 0.296 loss, a thin margin).
SPECULATION on why it is rough: ARCore's poses drift a little against the
pictures, the camera's exposure changes in bright sun, and 7,000 steps is a
short run.

### SCAN-H4. The lawn's edge as a match target, replayed on SCAN-H3's walk (2026-11-03)

HARD, by the twin check's replay (every 5 m, from the references' fit,
searched 4 m and 15 degrees):

- The ground's colour from the walk's 144 pictures: 74,509 ground points
  read as grass, 3,732 as paving (scan/lib/surface.js). Where the
  references put them, 6% sat on the wrong side of the traced lawn's edge
  by more than 35 cm; of the 2,969 within 1.5 m of the edge, 83% on the
  right side. The colours and the traced lawn agree.
- Fixes out of 23 asks, and how many within 2 m of the references: walls
  and shrubs alone 3 (1); with the lawn's edge 5 (1); weighed 3 times 8
  (1); weighed 8 times 9 (1); roof edges counted twice changed nothing.
- The fixes the lawn's edge found, 13-28 m and 118-138 m into the walk:
  0.6-3.4 m and 9-20 degrees from the references, with 99-100% of the edge
  points on the right side against the references' 74-96%. From 73 to 108
  m the references' fit landed almost nothing (0-2 points) and the fixes
  were 3-10 m away from it.

SPECULATION, to be settled by a walk with check points: the references'
turn was about 10 degrees off on this walk (three marks, close together,
and ARCore's heading drifting over 168 m), and the lawn-edge fixes were
nearer the truth than the references they were judged against. If so, the
references judge (2 m, 10 degrees) refuses good fixes on a walk like this.
Not changed until measured. The live page weighs the lawn's edge 3 times.

### SCAN-H5. The second walk of the day: a denser flight, the lawn's edge finds the most, and blue columns in the lawn (2026-11-03)

HARD, the owner's later walk on a bigger lawn (2,792 m2 traced; 4.8 lidar
points a m2), two references, by the twin check:

- Where the references put the phone, 22% of the grass and paving points
  sat on the wrong side of the traced lawn's edge by more than 35 cm (71%
  right within 1.5 m of the edge): the references were worse than on
  SCAN-H3's walk.
- Replayed every 5 m from the references (searching 6 m and 25 degrees),
  fixes and how many within 5 m and 25 degrees of the references: walls
  and shrubs 9 (0); with the lawn's edge weighed 3: 8 (2); weighed 8: 9
  (5); weighed 8 with the roof edges at full weight: 12 (5). From 43 to 53
  m into the walk the fixes sat 4.3-8.5 m from the references with turns
  of 3-5 degrees, and landed about twice the points (237-308 against
  131-138).
- The blue columns the owner saw in the lawn: 181 solid cells more than
  0.5 m inside the traced lawn, all from unclassified (class 1) single-
  return points, median 0.51 m over the match's ground (lowest 0.26,
  highest 2.49); the phone saw something near only 26 of them. The match's
  ground there sits a median 0.27 m above the lowest ground return within
  2 m: a hillside where the flight's ground labelling missed some ground.

Changed (AR only): inside the traced lawn, unclassified points under 1.2 m
are not solid (lidar.js LAWN_LOW_M); the lawn's edge weighs 8 and a roof
edge point counts fully (SURF_W, HIGH_W); the references judge is 5 m and
25 degrees (owner: "loosen it... the goal is to get rid of reference
points"), and the search from them 6 m and 25 degrees.

SPECULATION: the 4-8 m fixes mid-walk are right and the references wrong
there (twice the points land, the edge agrees as well); a walk with check
points away from the references settles it. The owner saw lidar points on
houses hundreds of feet away line up well with the camera: the shift onto
the photo's ground is right at a distance.

### SCAN-H6. At work, with check points: the references were good and the lock was not (2026-11-03)

HARD, the owner's walk on the workplace lawn (not the owner's lot; 4.1
lidar points a m2, 7,329 m2 traced), two references (R2 marked three
times, one by mistake), two check points: C1 1 ft 0 in off, C2 10 in off,
both by the references. So here the references were good to a foot, and
the walk is a fair test of the lidar lock.

- The live page: 0 fixes kept in 80 asks; 2 found, 7.6-7.8 m and 13-15
  degrees from the references, refused by the references judge (rightly).
- The stone wall drawn too tall (owner): every BUILDING and STRUCTURE wall
  was drawn 3 m tall; now as tall as its column. And every STRUCTURE wall
  was matched 2 ft inside its edge as if it had eaves: the phone saw
  nothing at 60% of those cells; matched at the edge, the phone's points
  landing on STRUCTURE walls went from 305 to 1,159 and the unseen share
  fell to 49%.
- Low unclassified points inside the traced lawn: 1,324 cells, the phone
  saw something at 3; the lawn rule (SCAN-H5) leaves 83 of them solid.
- The lawn's edge, where the references put the phone: 22% of grass and
  paving points on the wrong side, 99% of those "paving" inside the trace:
  sunlit, washed-out November grass read as paving. Paving now needs under
  7% colour (was 12%): the wrong side fell to 12%.
- Replayed every 5 m: no setting (walls alone, with the lawn's edge at 1,
  3 or 8, paving only, roof edges doubled) found a fix within 5 m and 25
  degrees of these good references; 15 of 20 asks were "two places fit".

So on this lawn the lidar lock does not yet stand without references.
SPECULATION: the "two places fit" refusals are the next thing to study --
a long stone wall and a regular lawn edge repeat along their length, and
the match has nothing across them to break the tie.

The Mark button: once every point was marked it fell back to the nearest
reference without saying so (the owner's accidental third R2). It now
names its target, takes a pick from the mini map, and Undo takes back a
mark.

### SCAN-H7. The work walk, dug into: the phone's depth, not the lidar, was what the lock had to work with (2026-11-04)

The owner, on SCAN-H6's reading: the "paving inside the lawn" was a
gravel drive beside the lawn, in the first pictures and others; the grass
was green and the light soft. HARD, all on that walk (check points C1 1 ft,
C2 10 in by the references), by the twin check:

- The picture is read the right way round: against the traced lawn where
  the references place the points, 9% of grass and paving on the wrong
  side read as kept, 9% mirrored, 18% flipped top to bottom. The first
  nine pictures read 56, 40, 28, 37, 42, 33, 55, 33, 17% paving, then 1,
  0, 0%: the owner stepping off the gravel. Every picture of the walk is
  read, in order. The washed-out-grass guess in SCAN-H6 was wrong.
- At the references' pose the phone's "standing" points were mostly not
  things: with the page's floor rule of the time (the lowest point of a
  column and its eight neighbours) 82% of them stood under 0.3 m over the
  lidar's ground (the ground itself; the lowest of hundreds of noisy
  depth samples sits well under it), 2% landed on a solid cell, and of
  the rest 88% stood inside the mowed lawn, where nothing stands.
- By range from the camera (the S21 has no depth sensor; ARCore's depth
  is estimated from motion): within 2 m, 86% misread ground; 2-3 m, 23%
  land; past 3 m, 83-91% stand on nothing.
- Floor rules compared: the lowest point, 2% land; the 15th percentile,
  3% (83% still the ground: the tail under the ground is long); the
  densest 5 cm height, own column first, standing within 3.5 m, 21% land
  (6,652 points left of 139,650).
- Of those 6,652, by the picture: the landed were grass 0, paving 263,
  other 855; the missing grass 1,574, paving 374, other 1,607. Dropping
  grass-coloured standing points costs no real one. With that and a cell
  seen 3+ times, 30% land.
- The lidar slid as one against the standing points, by thirds of the
  walk: first third (the gravel and the stone wall) 73% land where the
  references put them, 80% slid 5.25 m along the wall (the "two places
  fit" tie is the wall sliding along itself); second and third thirds
  (the open lawn) 0% land at any shift within 8 m. The lidar sits right
  on this map; in open lawn the phone sees nothing real to match.
- The cost round the references' pose stays flat (a 2 m step costs under
  10% more at 20 of 21 asks; west is cheaper than the truth) and the
  replay with the new rules found 3 fixes in 12 asks, 1 within 5 m and 25
  degrees. The lawn-edge colours near the edge were 59% on the right
  side: depth that is off along the ray moves a ground point sideways too.

Changed on the AR side: a column's floor is its densest height, own
column first (locate.js floorOf, OWN_COLUMN_N); standing points only
within 3.5 m, ground within 6 m (STAND_RANGE, GROUND_RANGE); standing
points come only from the once-a-second colour pass (24 x 40), never
grass-coloured, and count once their cell is seen twice (STAND_SEEN); the
twin records the floor the page took under each point. The twin check
compares floor rules, slides the lidar, and measures filters before they
are built.

SPECULATION: on a phone without a depth sensor the camera picture is the
stronger signal (section 7: render-and-compare, edges of drive and wall),
and the depth should serve the ground and near walls only. A phone whose
ARCore depth comes from a time-of-flight sensor would be worth a walk to
compare. Not measured.

The owner's reading (2026-11-04): the S21's depth comes from sub-pixel
stereo across its lenses, parallax between camera feeds and the laser
autofocus, fused by the NPU; grass confuses all of them (time-of-flight
sensors too); low-confidence depth can be filtered; and the visual parts
assume a rigid world, so wind moves things. In WebXR there is no
confidence buffer, but a page may ask for RAW depth (depthTypeRequest
['raw', 'smooth']): the least processing, and what the runtime is not
confident of comes back invalid (0), which depth.at already drops. SMOOTH
depth fills those in, and that fill across plain grass is the likeliest
source of the invented points. The page now asks for raw first and the
walk's log says which it got (depthType). A request only; not yet measured
on a walk.

The owner's word (2026-11-04, through the features session): LAS classes
7 and 18 and returns over 80 m stay out everywhere; the detector's
lidar_frame.py is unchanged. SPECULATION from the features session (shade
findings 33), not measured here: on the owner's lot, emptying every cube
under 2.5 m in a tree column (1,500 cubes, 3.8% of the canopy's mass)
moves the lawn's mean direct beam by about one point at a 10-degree sun
and nothing at noon; whether those low points are trunks and shrubs or
phantoms is not known from the lidar alone. The AR's 3 m crown rule
(SCAN-H7) stands on what the phone saw under crowns, not on this.

### SCAN-H8. The owner's lot, 2026-11-04 22:02, six check points: the fixes made it worse; the lawn trace drove them (2026-11-05)

Measured on walk 1793829761981 (9 min, 344 m walked, 2 references, 6 check points; the model written before the
shade map's canopy and own-return fixes), from its record and the twin check's replay:

- **At every check point the lidar fix was worse than the references alone.** By the fix: 0.57, 2.53, 6.93, 2.65,
  2.30 m; by the references: 0.13, 0.45, 1.77, 1.27, 0.31 m. (C4 was 43 m off both ways: its map place, or its mark,
  is wrong.)
- **The kept fixes sat a median 2.2 m from the references** (p90 4.2 m), all inside the 5 m the references allow,
  so all were taken. Each ask carried a median 32 standing points against 2,132 grass-and-paving points weighed 8
  times: the lawn trace, not the lidar, chose the fix.
- **Jitter:** 131 fixes in 295 asks, each drawn at once; standing at one spot, four fixes in a row each differed.
- **The real height offset was steady**: the phone's ground points against the lidar's ground, per 20 m of walk,
  247.60 to 247.93 m, a 0.33 m spread over the whole walk. The 1-6 ft the owner saw came from the page drawing at
  the crosshair's last depth hit, not from the lidar.
- **The cost landscape is flat**: round the references' pose, a 2 m step cost under 10% more in 65 of 66 asks.
  Replayed with today's classing and no lawn edges, 28 asks gave 4 fixes, 1 within the references' bounds. Under
  the references only 22% of the phone's standing points land within 30 cm of a solid cell (13% under the walk's
  fixes); 87% of the solid cells at standing height were tree columns, before the shade map's own-return fix.
- **8th Wall** (walk 1793831670545, 3 min, 1.5 m walked): tracked 31% of frames, re-initializing three times; no
  depth, so no points for the match at all; its hit test was only ever offered feature points.

Done the same day (dc187ae): one held fit, moved only by three agreeing fixes; no lawn trace or lawn colour in the
match; the drawing's height from the ground points (groundOffset); 8th Wall's hit test offered surfaces. Expected:
far fewer fix changes, the references and ARCore carrying most of a walk, the lidar drawn at the ground. Open: with
the lawn trace gone the match has little to hold on this lot; whether the own-return model (fewer phantom tree
columns) gives it more is the next walk's question.

### SCAN-H9. Record first, fix afterwards: built, tested, and safe; on the owner's lot it adds nothing yet (2026-11-05)

The owner, 2026-11-05: straighten what is straight, trunks thin; build record-then-fix; find out why 8th Wall gives
no depth; run depth from pictures for later. Done the same day (6c93b02, cd624b0, a92350a, 00ae32c, 9d07a37):

- **8th Wall**: the engine's web build has no depth map (the depth field in its message format is internal; the frame
  it hands the page has rotation, position, intrinsics, world points, lighting and detected images). The page had
  switched world points on and kept only their count. They now feed the twin and the match.
- **Straightening** (scan/lib/outline.js; SCAN-DIVERGENCES step 3b): on the owner's lot, 28 buildings straightened,
  3 structures as lines, 91 trunks as 30 cm posts. A turned edge comes out within centimetres (test); an edge along
  the grid stays within half a column, a toss-up the model already made.
- **Record then fix** (scan/lib/postfix.js, task `fix`): on a synthetic 160 m walk drifting 1.2 m and 2.5 degrees the
  fix is a median 0.35 m off, one placement 0.53 m, the references' worst 1.65 m. On the owner's walk of 2026-11-04
  22:02 the first version made it WORSE: no single placement found, two windows kept and stretched over 344 m, check
  points a median 15 ft off against 4.2 ft by the references. With the references as its bound (a window within
  1.5 m and 5 degrees of them at its own stretch, the references everywhere else) it equals them: 4.2 ft, no window
  kept (8 ambiguous, 7 disagreeing with their neighbours, 2 too far from the references). The base mesh: 231,815
  cells of 10 cm from 445,833 points, 2.4 MB gzipped, kept with the walk.
- **What that says**: on this lot the match against the model still has too little to hold, whole walk or not, with
  the model written before the shade map's own-return fix and only 7,457 standing points over 344 m (the page's
  classing). The value of recording first is that the fix can be re-run on the same walk whenever the inputs get
  better (the own-return model, trunks placed within their column, depth from pictures), at no cost to the owner.
- **Depth from one picture** (task `depth`, 2026-11-05, the same walk; Depth Anything V2 small on the free runner,
  580 s for 436 pictures; kept as depth-summary.json and depth-maps.npz, 22 MB, beside the twin). Each picture's
  guess was scaled to ARCore's own points from the same moment, so near the phone they agree by construction (ground
  within 2 m: 4 cm). Farther out they part: ground at 4-6 m a median 0.35 m apart, standing points at 4-6 m 0.45 m.
  Of ARCore's 25,107 standing points the model puts 29% more than 0.5 m farther away (ARCore floating them nearer,
  the phantoms of SCAN-H7?) and agrees within 25 cm on 30%. SPECULATION until measured against something true: the
  scale comes from ARCore, so this says where the two disagree, not which is right. The next run should score both
  against the lidar's ground and walls where the references place the walk.

