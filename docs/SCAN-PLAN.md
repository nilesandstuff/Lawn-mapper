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
- By range from the camera (the S21 has no depth sensor [wrong: corrected in SCAN-H11]; ARCore's depth
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
CORRECTION (2026-11-06): every walk since logged "depth not said" because
the page read depthType from the per-frame XRDepthInformation; the spec
keeps it on the XRSession. Fixed (track.js depthTypeOf); so whether the
S21 gives raw depth is still NOT known, and the walks of 11-04 to 11-06
may have had either. The next walk's log says.
MEASURED (2026-11-06 22:43, at the owner's work, the first walk after the
fix): "depth smooth (cpu-optimized, luminance-alpha)". Asked for raw first,
the S21's Chrome gives smooth. The start screen now offers "Raw depth only"
(depthTypeRequest ['raw']): a walk with it says raw, or gets no depth.
MEASURED (2026-11-07, two short indoor walks with "Raw depth only"): depth
came (6,795 and 12,604 points) and session.depthType was null, where the
['raw', 'smooth'] request had said smooth. Null is what the spec gives
when the runtime ignores the request, so this is not yet raw. The page now
counts the holes in the depth (0 = no depth there: raw leaves them, smooth
fills them) and the walk list prints the share. The option's name is the
spec's and Chromium's own (WPT webxr-depth-sensing.idl): depthTypeRequest,
inside depthSensing; "depthTypePreference" is not in it and would be ignored.
MEASURED (2026-11-07 01:04-01:06, three short indoor walks, the last two on
stairs, holes = share of depth samples the runtime left at 0):
  raw only           depthType null    holes 1% (214 frames)
  raw, then smooth   depthType smooth  holes 8% (53 frames)
  raw only           depthType null    holes 5% (150 frames)
Asking for raw alone gives no MORE holes than smooth; raw depth (ARCore's
raw API) leaves large parts of a picture empty. So the S21's Chrome does
not give raw depth: the request is ignored and the depth is the same either
way. HARD for this phone and this Chrome; the switch stays in case a later
Chrome honours it, and the hole count says so if it does. The ground the page
takes stays the column's densest height (SCAN-H7), not its lowest.

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

### SCAN-H10. Five walks of 2026-11-05: the straightening was matched but not drawn; references beat the live fix; ARCore holds a pin to inches (2026-11-05)

From the walk digests (walks task, BRIEF) and the after-the-walk fix on the two record-only walks:

- **Not drawn**: the live rule read "straightened (28 buildings, 483 trunks as posts)", but the camera view drew roofs
  and crowns from the model's 1 m columns, so the owner saw none of it. Fixed (2c104a5): roofs from the straightened
  outline, a trunk post's column from 2.4 m up.
- **The live fix broke a walk** (20:26): the references put C2, C3, C4 within 6 in; the kept fixes sat a median
  4.8 m from them, inside the 5 m then allowed; two became the held fit and put C2 25 ft off. REF_TOL back to 2 m, 8 deg.
- **ARCore holds a spot**: on the no-reference walk the owner's pin checks read 1 ft 4 in once, then 3, 4 and 3 in;
  another 7 in. Trusting the engine between fixes is right.
- **No references, no placement**: the after-the-walk fix found no single placement ("two places fit about as well")
  and had no heading to start from (one GPS reading). The page now keeps a GPS trail (b71f8dd) for the fix to start
  from. The record-only walk with references came out at the references' own 1.4 and 6.0 ft; no window was kept.
- **8th Wall**: 1,578 world points recorded, tracking 72% (was 31%); the ground "a few inches from the phone, 4+ ft
  up" was its estimated surface at camera height, no longer asked for.


### SCAN-H11. Why the lidar cannot place a walk: the phone's points carry too little true shape (2026-11-05)

The owner, after the record-only walks: "It's strange that there was not enough lidar for a match on the post
processing... Look into that thoroughly." Four rounds of scan/tools/match-study.mjs (task `study`), on the walks of
2026-11-04 22:02 (4 check points with map places) and 2026-11-05 20:37's companion with references (6), both on the
shade map's model of 2026-11-05 (straightened, trunks as posts).

HARD, rounds 1-3 (the whole walk moved round the references' placement, 8,125 placements, 6 m and 12 degrees):

  - ground shape (the phone's ground points against the lidar ground, 15 cm): 69-76% at the references, only 55-93
    placements better; a broad, shallow peak (contrast 1.3x). It narrows the search; it cannot pin.
  - roof edges: strong on one walk (25%, contrast 3.3x, 106 better), nothing on the other (3%).
  - house walls: 0% of the phone's standing points within 30 cm of one at the references on both walks; out to 8 m
    from the phone (instead of 3.5) still 0% and 5%. Lengthening the range is not the fix.
  - the 3D crowns (canopy, occupied cubes): nearly flat (contrast 1.1-1.3x).

HARD, round 4 (the decisive one): each check point taken as the truth; only the points within 15 m of walking
either side of it; the same moves round the references' fit at that moment; and for each signal, how far its
favourite placement puts the check point.

  walk 22:02 (4 checks)   references 2.7 ft median; best signal (ground + occupied) 11.2 ft; walls 19.2; ground 25.8
  walk 20:37 (6 checks)   references 4.2 ft median; best signal (ground + roof edges) 16.9 ft; walls 20.1; canopy 22.7

No signal and no combination comes within 10 ft; most pick a placement near the edge of the search. On a stretch of
walk, the phone's points prefer the wrong place to the right one: the score follows where clutter is, not where the
walk was. One check (the 20:37 walk's fourth) is 145 ft off by the references themselves: a mis-mark, left in.

What this says (the inference, held as SPECULATION until a different input is measured the same way): the lidar is
not short of detail. The phone's own points are. (Corrected 2026-11-05: an earlier line here said the S21 has no
depth sensor; the owner: it has three mechanisms feeding its NPU a depth, good on walls, poor on grass and in bright
light.) What WebXR hands the page from it floats standing points nearer (SCAN-H7; 29% of them more than 0.5 m off by the depth model's reading), barely reaches a
house wall, and what it does put on a wall is lost among phantoms that land on whatever is solid nearby. A 30 cm
test on that input cannot pin a walk, and no reshaping of the lidar changes the input.

What could, in order of promise (none built):
  1. the pictures, not the points: roof lines and tree tops against the sky in the twin's pictures, against the
     model's outline rendered from ARCore's pose. It needs no phone depth at all, only the pose ARCore already holds
     to inches over a few metres (SCAN-H10), and far edges fix the heading hard. The owner's own allowance (2026-11-04):
     "hard edges with vision".
  2. the depth model's points (scan/tools/depth_run.py keeps each picture's depth) in place of ARCore's standing
     points, scored by the same round 4.
  3. ground shape with the GPS trail, for walks without references: a few metres, not inches.

### SCAN-H12. 8th Wall ran in absolute scale with no calibration: the likely reason it never walked (2026-11-05)

HARD: every 8th Wall walk on the S21 registered 0-1.5 m walked (the 21:55 walk: 1 min, 63% "tracked", 0 ft, its
status flipping INITIALIZING / NORMAL), found no ground under the crosshair, and earlier put its estimated ground
"a few inches from the phone". The page configured `scale: 'absolute'`. In the binary (1.0.0), absolute scale turns on
the engine's own metric scale estimation and overrides the start height to 1 with a scale of 1; 8th Wall pairs it
with a Coaching Overlay, "a flow to generate appropriate data for scale estimation", which this page never ran.

Changed: `scale: 'responsive'` (the engine's default; its ground is y = 0 and the camera starts PHONE_HEIGHT_M = 1.4 m
over it, which sets the scale), the estimated surface offered to the crosshair again (below the camera only), and
counted as ground. SPECULATION until a walk shows it: that 8th Wall now registers walking and finds the ground;
any scale error left from the assumed 1.4 m is what the references' fit takes out (T.s).

### SCAN-H13. The walk of 2026-11-05 21:56: ARCore barely bends; placing it once is the whole problem (2026-11-05)

Record only, no references, 6 min, 1,106 ft, tracked 100%, check points C1-C4 marked over 395 ft of walking (task
`fix`, with the new "check points as their own references" lines).

HARD:
  - all four checks fitted as one turn and shift: 0.4, 1.0, 1.3, 1.4 ft left over; AR distances against the map's
    0.0% apart. Over this walk ARCore's frame bent about a foot and its scale was exact.
  - each check placed by the other three: 0.5, 1.9, 2.1, 4.0 ft.
  - the GPS trail's placement (83 readings, median 7.8 m scatter): 26-44 ft off at every check, all one way. GPS
    here is a bias of several metres, not scatter that averages out; the 6-degree test in postfix.test.js assumed
    unbiased scatter.
  - the lidar, searching round that: no placement (two places fit about as well); no 60 m window kept.
  - the walk's two pins are in its summary but not in its twin's live.json (the last save of the walk did not
    land, or came before the pins): to look into.

What it says: the hard part is not keeping the walk on the map, it is putting it there once. A placement good to a
foot at any moment of the walk would carry the whole walk to about a foot. The references' 2.7-4.2 ft (SCAN-H11) is
then mostly the marks themselves (where the spot was put on the photo, how it was aimed), not ARCore.

### SCAN-H14. The skyline places a walk without marks to about 5 ft, with a steady 5-degree twist (2026-11-06)

SCAN-H11's option 1, chosen by the owner. scan/tools/skyline_study.py (task `skyline`): the sky in each picture
(SegFormer-b0, ADE20K, CPU) against the shade map's model seen from every placement, all pictures at once; scored
against the check points' own fit. Synthetic yard: placed to 0.1 ft. Two real walks (21:56 no references; 22:02 with).

HARD:
  - roofs: where a roof makes the model's skyline (0-40 m), the pictures' skyline matches it to a median 0.6-1.5
    degrees. Crowns within 15 m: 29-38 degrees off, the picture lower (November's bare branches show sky through
    what the lidar saw as solid). Far trees: about 3 degrees. Scoring therefore treats the picture's skyline as
    lying between the roofs' skyline and the model's tallest ("the band").
  - with the band, both walks are placed decisively (the next different placement 70-105 log-likelihood lower):
    checks median 4.9 ft (21:56; GPS was 28 ft, the lidar points found nothing) and 5.0 ft (22:02; references 1.6).
  - both best placements sit 5.1-5.6 degrees turned from the truth, the same way, on both walks; a placement about
    2.5 degrees turned with checks median 2.3 ft is the runner-up on the 22:02 walk.
  - the camera's aim at the truth: every ray fits best tilted down 2.5 (21:56) and 3.75 degrees (22:02), turned
    +0.5 and -1.75. Applying one walk's tilt to the other raises the truth's score (181 -> 272, 370 -> 561) but does
    not remove the 5-degree preference (best placements 8.5 and 5.3 ft median, 4.1 and 5.6 degrees turned).
  - the lidar is not rotated against the photo by the shade map: 3DEP's EPT is already EPSG:3857 and the shade map's
    fit is a shift only.

SPECULATION, to measure next: the twist comes from the model's edge (251 x 172 m; 14-29% of rays leave it within
100 m, where the picture's skyline is higher than anything the model holds), or from the bare crowns' band, or from
the pictures' timing against their poses on turns. Each can be tested on these two walks: a wider model, roofs-only
samples, and a per-picture time offset.

### SCAN-H15. The twist is not trees, the edge, a fixed camera offset or picture lag; the roof edges want it too (2026-11-06, night)

Four more tests on the same two walks, after the owner's notes (trunks unreliable, leaf-off crowns read short,
ARCore's small discrete shifts, the back yard lower).

HARD:
  - roof-edge samples alone (the narrow band: 133 and 219 samples) score the twisted placement ABOVE the truth
    (164 vs 201; 251 vs 290), as the under-crown samples do. The twist is not the trees' doing.
  - a 6-degree leaf-off slack on tree tops: best placement still 5.9 degrees off (5.6 ft median).
  - the walk's halves fitted apart: -3.3 and -6.6 degrees (22:02), -6.1 and -2.1 (21:56). Not one body's twist;
    not a constant of the phone.
  - the picture's lag behind its pose (each ray turned by the phone's turn rate then x the lag; half the pictures
    taken turning faster than 10 deg/s): the best lag is -75 and 0 ms, worth under 2 points of score. Not lag.
  - at the truth, with a 3-degree tilt applied, only 13-21% of roof-edge samples sit within 2 degrees of the model's
    roof skyline; without the tilt, round 2 had roofs matching to 0.6-1.5 degrees where a roof MADE the skyline.
    The "tilt" of SCAN-H14 was fitted mostly on under-crown samples; the roofs do not want it.
  - the AR match no longer rests on any tree column (SCAN-DIVERGENCES 9); deployed 2026-11-06 05:09 UTC.

SPECULATION, in order: (1) the 1 m columns' tops at a roof's edge (an eave over a wall reads as the wall's column;
the skyline from a few metres away moves by degrees); (2) the check points' map places (the truth) and the roofs
sit on different photos: the lidar's shift fit to the summer photo vs the editor's imagery; a 1-2 m offset between
the two over a 60 m lot would read as a twist that changes along the walk; (3) a per-stretch ARCore heading
error that the four checks cannot see. The next cheap test is the search run on roof-edge samples alone, and the
twist measured against the references' placement as well as the checks'.

### SCAN-H16. The two truths disagree by 2 degrees; roof edges alone place the walk's second half to 0.3-3.8 ft (2026-11-06)

Step 1 of the owner's three (the twist measured against the references as well as the check points), and the
skyline search run on roof-edge and open-sky samples alone.

HARD (walk 22:02, the one with both):
  - the references' placement is 2.25 degrees turned from the check points' own fit, though it puts the checks a
    median 1.6 ft off (their own fit: 1.3 ft). Four marks over 400 ft cannot pin a heading better than about 2
    degrees when each mark is a foot or two off on the photo. The "5-degree twist" of SCAN-H14 is 3 degrees against
    the references, and a candidate 0.1 degree from them (checks median 2.2 ft) was the search's fourth.
  - roof-edge and open-sky samples alone (219 of 2,016): the best placement is still 5.6 degrees turned; but the
    second half of the walk fitted on those samples alone puts its own checks 3.8, 1.9 and 0.3 ft off (3.1 degrees
    turned); the first half, 18 ft (few roof samples: 65 against 154).
  - walk 21:56, roof samples alone (133): the truth scores above everything the search found (237.6 against
    226.6), a margin of 11.6: the signal is there, weak, and the coarse search (1.5 m, 2 degrees, one eye height)
    does not land on it.

What it says: the roofs are the trustworthy part of the skyline and there are too few of them seen; the truth is
itself uncertain by about 2 degrees; a per-stretch fit (step 3) will do better than one placement because the
second half alone already does. Pavement (step 2) is the way to more trustworthy samples.

### SCAN-H17. Steps 2 and 3: the pavement cast is right; windows show the twist growing along a walk, a steady drift does not fit (2026-11-06)

HARD:
  - pavement from the pictures (SegFormer road, sidewalk, path; earth and floor out, since November lawn reads as
    earth), cast onto the level ground within 8 m: at the truth 6-7% of pavement cells fall inside the traced lawn
    and 92-94% of grass cells do, on both walks. 629 pavement cells (22:02, 347 pictures) and 983 (21:56, 90): sparse,
    because the walks seldom look at the drive. The match against the lidar's brightness waits on the model's
    `intensity`, which the shade map now writes on a lot's next save (merged and deployed 2026-11-06 11:37 UTC, with
    the 2 m surround 100 m out); the readers are in (skyline-prep, pavement_study, skyline_study).
  - windows of 60 m every 20 m, each its own skyline fit from the whole-walk best: 22:02, 12 of 15 kept, their turn
    from the truth running -0.1, -0.8, -2.6, -3.3, -3.6, -0.8, -3.6, -3.8, -3.1, -4.3, -5.8, -6.3 degrees along the
    walk; 21:56, all 11 kept, -1.6 to -7.1 with no trend. The checks by their window: 10.2 and 5.3 ft median, against
    5.0 and 4.9 by one placement: windows alone do not help; each has too few roof samples.
  - a heading drifting steadily with distance walked (theta0 + k x odo, the position carried along), k searched
    from -0.10 to +0.10 degrees a metre: both walks choose k = 0. The growing twist of the 22:02 windows is not a
    steady drift of the camera's heading against its position.

What stands: the skyline alone places a walk to about 5 ft and no better, on these two walks, whichever way it is
cut. The next gain is more trustworthy samples, not a better search: the brightness match once the model has it,
and the surround for the rays that leave the lot.

### SCAN-H18. With the surround the skyline's twist halves; the lidar's brightness tells pavement from grass and holds a walk to 2 ft (2026-11-06)

The shade map's two additions (the features session, merged and deployed 2026-11-06 11:37 UTC; the owner re-saved
the lot at 13:2x): `intensity` per column and a 2 m surround 100 m out (226 x 186 cells).

HARD:
  - skyline with the surround, 22:02 against the references: the best placement 1.6 degrees turned (was 3.1),
    checks median 4.9 ft; the third candidate +1.4 degrees, checks 5.1, 1.2, 1.5, 1.4 ft (median 1.5); no coarse
    placement scores above the truth any more (was 3), and on roof-edge samples the truth and the best tie (313 vs
    315). 21:56: still 5.1 degrees and 4.9 ft, the runner-up 1.9 degrees and 2.0 ft.
  - brightness: the pavement the pictures cast has a median lidar brightness of 26,315 (22:02) and 31,005 (21:56)
    where the grass has 51,403 and the lot's ground 38,137; 89% of cast cells sit over a ground return. The
    signal the owner asked for is there and crisp.
  - brightness as a placement, refined from the truth: 21:56 (1,638 pavement cells) stays within 2.3 ft median,
    2.0 degrees; 22:02 (629 cells, 12 pictures with any pavement) wanders to 12.4 ft. It holds a good placement
    when the walk has looked at the drive; it has not yet been tried from the skyline's placements (next).

### SCAN-H19. Skyline then brightness places a walk with no marks to 2.6 ft, when the walk has looked at the drive (2026-11-06)

HARD:
  - 21:56 (no references; 1,638 pavement cells from 19 pictures): the skyline's best placement (4.9 ft, 5.1 degrees)
    refined on the lidar's brightness lands at checks 6.6, 2.1, 3.1, 1.3 ft (median 2.6), 2.1 degrees turned; from
    the skyline's second, the same spot; from the truth, 2.3 ft. Three starts, one answer.
  - 22:02 (629 pavement cells from 12 pictures of 347): the brightness refine wanders to 12-17 ft from every start,
    the truth included. Too little pavement seen.
  - the skyline's third candidate on 21:56 (300 ft off) is rejected by brightness outright (score -1287 against -839).

What it says: brightness is the sharp signal and the skyline is the coarse one; together, with no marks, a walk that
has looked at its drive and paths for a few seconds sits on the map to about 2.5 ft. The walk itself is the lever:
a protocol that turns the camera along the drive, the sidewalk and the house's roofline early on gives both
signals what they need.

### 9. Placing a walk from its pictures, and nudging the walk to see what places it (2026-11-06)

The owner, 2026-11-06: build the combined placement (SCAN-H19's recommendation 2), and "some way to notify the user
while they're doing a walk to be like 'look at the roof, driveway, road, or patio' if it's been a while since a
good anchor was seen", and use the ground's position and shape in the placement.

- Task `place` of "S. Yard AR tool": the twin with its pictures; skyline_study.py in its lean mode (SKY_LEAN: the
  search alone) writes skyline.json; pavement_study.py refines its best three on the lidar's brightness under the
  cast pavement plus the ground's shape (ARCore's ground points against the model's ground, weight 0.5) and writes
  placement.json (the skyline's best alone when fewer than 1,000 pavement cells were seen); post-fix.mjs uses it for
  the whole walk when no references were marked, scores it beside the references when they were, and sets the
  height from the phone's ground points under it. All kept beside the twin.
- scan/lib/anchors.js on the page: from the picture it already reads about once a second, whether this moment shows
  a roofline against the sky (camera tipped up, sky over something) or pavement (tipped down, grey ground under
  surface.js's paving rule); after 30 m walked without one, a flash and a line on the screen asking for it, at most
  every 15 m. Counts kept in live.json (`anchors`). WebXR only (8th Wall hands the page no picture).

### SCAN-H20. Placed from the pictures, no marks: 1.5-1.8 ft on a walk that saw its drive; the ground's shape helps (2026-11-06)

Task `place` (section 9), run end to end on both walks.

HARD:
  - 21:56 (no references, 1,638 pavement cells): brightness alone 2.6 ft median, -2.1 degrees; the ground's shape
    alone 3.7 ft, +1.9 degrees; together 1.5 ft (numpy median) / 1.8 ft (the fix's), -1.6 degrees, checks 5.6, 1.2,
    1.8, 0.8 ft. The two err in opposite turns; their sum lands between. The after-the-walk fix used it for the walk.
  - 22:02 (629 pavement cells): brightness wanders (17 ft); ground alone from the skyline's starts 3.6 ft, +0.2
    degrees; the two together 11.6 ft (the brightness drags). The placement fell back to the skyline (4.9 ft) and
    now falls back to skyline-then-ground instead. The references on this walk: 2.7 ft by the fix's median.
  - at the truth 71-75% of ARCore's ground points lie within 15 cm of the lidar's ground (the model's `ground`,
    class-2 returns per metre, once one height offset is taken out). The phone's ground is good relative to itself;
    the shape it shares with the lidar places a walk to about 3.6 ft on its own.

### SCAN-H21. The shade map's own points: the ground a little better, the brightness worse; mixed, 1.5 and 2.9 ft (2026-11-06)

The owner: "get the finest returns for the ground... if the shade map can just pass along all of that at the highest
resolution possible, great." The shade map now writes every return it keeps (ptX ... ptKind; its filters and the
column kinds carried along; the owner's lot 339,372 points, 2.3 ground returns a square metre, 4.08 MB gzipped).
skyline-prep.mjs writes them as sky-points.bin; pavement_study.py builds, over the model's box, a 0.25 m ground
(a triangulated surface through the class-2 returns, left out where none is within 0.75 m) and a 0.25 m brightness
(the mean of the three nearest ground returns), and runs the same match on both grids in one run, rows marked
[1.0 m] and [0.25 m points]; the fine one is kept when the model has points.

Synthetic only, so far (a made-up lot with a 10 cm curb and a 15 cm step, ARCore-like noise of 5 cm): the ground's
shape alone, from a start 1.5 m and 3 degrees off, lands at 1.6 ft on the 1 m cells and 0.5 ft on the fine surface.
NOT a result about walks.

MEASURED on the owner's two walks with check points, the lot re-saved with its points (2026-11-06, task place;
medians of the four check points, no marks used):

                                          21:56 (saw its drive)    22:02 (629 pavement cells: ground only)
  1 m columns, both signals               1.5 ft                   3.6 ft
  0.25 m points, both signals             3.7 ft                   2.9 ft
  1 m brightness + 0.25 m ground (kept)   1.5 ft                   2.9 ft

  - The ground's shape alone, from the skyline: 3.4 ft fine against 3.7 at 1 m (21:56), 2.9 against 3.6 (22:02).
  - The share of ARCore's ground points within 15 cm of the lidar's ground at the truth did NOT move: 75% and 72%
    fine, 71-75% at 1 m. The ground term is limited by the phone's ground, not the lidar's resolution.
  - The fine brightness is worse: alone it pulled 21:56 10 degrees off (22.9 ft). One return's intensity is noisy;
    the 1 m column's median of two or three is steadier. Kept at 1 m.
  - So the placement kept since commit "brightness from the 1 m columns, the ground's shape from the shade map's
    points" mixes the two. Chosen on these two walks, so the next walks are the test of it, not these.

### SCAN-H22. At the owner's work the skyline placed walks 190-370 ft off; the GPS trail now bounds the search (2026-11-06)

Two record-only walks on the work lot (22:37 and 22:43, three check points each, depth smooth), task place:

                                          22:43                        22:37
  the pictures' placement (kept)          334 ft (189-367), +92 deg    256 ft (248-264), +10 deg
  the GPS trail's placement alone         14-23 ft                     8-13 ft
  ground shape alone, from the truth      6.1 ft                       1.2 ft   (study only)
  check points placed by the others       1.9-7.9 ft                   2.9-11.9 ft

  - The skyline's three best starts were all 80-110 m from the truth; brightness and ground refine only a few
    metres round a start, so they could not come back. Too little pavement was seen on either (423 and 349 cells).
  - At the truth the ground shape fits as at home (68% and 76% within 15 cm), and from the truth it holds to 1-6 ft:
    what failed is the coarse step, not the fine one.
  - The search had no notion of where the phone roughly was. Now (skyline-prep.mjs, skyline_study.py): the GPS trail's
    placement (postfix.js gpsPrior) goes in sky-input.json; the coarse skyline search keeps only placements putting the
    walk's middle within 10-24 m (twice the trail's spread) and its heading within the trail's degrees + 10; with none
    inside, the whole box as before. The pavement study also starts from the GPS placement itself.
  - At home the GPS trail was 26-44 ft off, inside the gate; the 21:56 walk is rerun to see that nothing is lost.

MEASURED with the gate (2026-11-06, task place):
  - work 22:37: 256 ft -> 1.3 ft median (checks 1.3, 0.9, 3.2 ft; -0.5 degrees), skyline then ground (349 pavement
    cells). Its GPS trail alone: 8-13 ft; its check points placed by the other two: 2.9-11.9 ft.
  - home 21:56: unchanged, 1.5 ft (5.6, 1.1, 1.8, 0.8): the gate (GPS 26-44 ft off there) took nothing away.
  - work 22:43: 334 ft -> 6.5 ft median (6.5, 6.8, 4.3; -1.4 degrees), skyline then ground (423 pavement cells); the
    ground alone from the truth gives 6.1, so this walk's floor is the ground's own. Its GPS alone: 14-23 ft.
  - That run timed out (30 minutes) in the step after: the skyline search took 1,633 s on the work lot's whole box.
    With a gate the coarse skylines are now computed only where the gated placements can put a picture (the gate's
    reach plus the walk's own size), and the job may run 60 minutes.
    Rerun: the whole placement step in 3.6 minutes (it ran past 30 before), the same answer, 6.5 ft (6.5, 6.8, 4.3).

## 10. The Android app (2026-11-07)

The owner: "is it possible to build an android app in our desktop-less workflow?" and then "Yea let's do it. And
build it to be compatible with a full ar viewer in the future, so it doesn't need full rebuild ... minimize the need
to push a whole new apk for minor updates and tweaks."

Why: the browser hides ARCore's best parts. Measured above: the S21's Chrome ignores the raw-depth request (holes
1-5% asked raw, 8% smooth). Native ARCore gives raw depth with a confidence per pixel, the camera's own picture at
full size, the Geospatial API (Street View's place and heading, outdoors, with a key) and session recording.

How (android/README.md): a thin Kotlin shell, ARCore and the camera natively, the scan site's page in a transparent
WebView over it, one bridge between (window.LawnARNative; engine "native" in scan/lib/track.js). The page does
everything it did; the app's options come from the page, so a tweak is a scan deploy. A future AR viewer draws in
the page's WebGL over the camera, as the pins do now; only a new bridge call needs a new APK, and the page asks
for it (BRIDGE_NEEDED). Built and signed by workflow "A. Android app"; served to the admin by the scan site;
signed in by pairing with Chrome.

MEASURED (2026-11-07 17:23, app 1.5, a stationary indoor test): the app's depth is raw, "depth raw (the app,
ARCore, confidence 0.4 and up)", holes 15% of samples over 151 frames, against Chrome's 1-8% (smooth, raw asked or
not). Raw depth reaches the page; the S21's Chrome alone withheld it.

Uploads (2026-11-07, the owner: would closing the app or losing signal lose a walk? It did): every part now waits on
the phone (scan/lib/outbox.js, IndexedDB) until the site has it, retried 5 s doubling to a minute, and sent the next
time the page opens if the app was closed; the page and the HUD say what waits. The app's own background upload
(after the app is closed) would be a bridge 2 call; not built.

Not yet measured: whether raw depth (confidence 0.4 and up, NATIVE_DEPTH) makes the ground fit better than Chrome's
smooth depth (SCAN-H21: 72-75% within 15 cm), and how far the Geospatial pose is off on the owner's lot. Not yet
built: ARCore's session recording (an MP4 of the walk for replay in the runners), a bridge 2 call.

### SCAN-H23. The first outdoor app walk: its last copy never left the phone; Street View now starts the live search (2026-11-07)

The walk (the owner's lot, 3 min, 387 ft, app 1.5, no map open: the app had no picker yet; two pins on check
points) was given its map afterwards from another walk (workflow S, task place, `mapfrom`) and placed from its
pictures. MEASURED: the map arrived (6 references and check points), but the walk's live.json in the bucket held 0
pins and 0 Street View readings, while its summary had 2 pins. So nothing could be scored: no Geospatial accuracy,
no "which check points", no error at the pins. The pictures alone placed it with two places about as good (the best
2.0 apart in log-likelihood; under ~10 is a toss-up), from 14 pictures, 4 with sky; only 551 pavement cells were
seen (1,000 wanted for brightness).

WHY (found, and proven by a test that fails on the old code): the outbox deleted a part by name once it was sent.
live.json is rewritten every few seconds and once more at the walk's end; when the end's copy was written while an
older copy was on its way, or waited in the same round's list, the older copy's success deleted the newer one. The
end's copy, the one with everything, was lost on the phone. Fixed: only the copy that went is removed
(scan/lib/outbox.js settle; scan/test/outbox.test.js). The pins and the Street View trail of that walk are gone.

Also on that walk: raw depth with confidence 0.4 and up kept 8,462 points where Chrome walks of the kind kept
100,000+. NATIVE_DEPTH.minConf is now 0.2, and the walk counts the share of depth samples dropped under the cut
(walks: "under confidence 0.2, dropped").

STREET VIEW LIVE (the owner: "If it's accurate, use it live. Or atleast use it to narrow the fix from other
sources"). scan/lib/geo.js turns each Geospatial reading into a whole placement: the place from lat/lng, the turn
from the East-Up-South orientation against the session's own for the same frame (eus * conj(session), read off the
session's x axis). How it is used, by ARCore's own accuracy figures, which are its estimates and NOT YET MEASURED
here:
  - within 5 m and 12 degrees: the lidar search starts from Street View's placement, searched 2 x its accuracy
    (1.5-6 m, 6-25 degrees), before GPS;
  - within 20 m but unsure of the heading: its place only, any turn, as GPS (GPS goes first when it says it is
    closer);
  - within 2 m and 5 degrees, with no lidar fix and no references: the page draws with it ("Placed by Street View");
  - a reading older than 10 s is not used. A walk replayed afterwards never has it (twin.js), so the replays are
    unchanged.
The walk's summary keeps the readings' count, median and best accuracy, how long Earth took to track, the frames it
waited and in what state, and how many searches started from Street View (walks: "street view:").

Next: an outdoor walk at the owner's lot with the map open (the picker opens it by the phone's place) and pins on
check points. That gives Street View's accuracy against the check points and whether its starts help the live fix.

Checked against Google's raw depth guide and its codelab (2026-11-07, the owner's pointer:
developers.google.com/ar/develop/java/depth/raw-depth). The app matches them on units (millimetres), intrinsics
(texture intrinsics scaled by the depth image over their image dimensions) and unprojection. The guide gives no
confidence threshold; the codelab's demo uses 0.3 (ours is now 0.2, measured by the walk's dropped share). It differed
in one place: ARCore does not make new raw depth every frame, and a repeat is the last depth reprojected. The app kept
those repeats as new pictures; it now keeps a raw image only when its own timestamp changes (app build after 1.5),
skips the smoothed depth when it has raw, and the page uses each depth picture once, so a repeat cannot make a point
"seen twice" by the standing rule.

## 11. ARCore features the owner found in Google's docs, read 2026-11-07, and the road map from them

Read from developers.google.com/ar on 2026-11-07 (anchors, cloud anchors, geospatial depth, streetscape geometry,
scene semantics, SemanticLabel, lighting estimation), not from memory. Everything below the facts is SPECULATION
until a walk measures it.

**Anchors.** What the docs say: an anchor is a pose ARCore keeps updating as its picture of the world improves; each
one costs CPU ("ARCore does not release Trackables that have attached anchors"); no maximum is given; keep content
within 8 m of its anchor. What that means here: an anchor does not fix drift by itself. ARCore corrects only when it
recognises a place it has seen, and the back of a roof seen from the back yard is not the front of it seen from the
front, so ARCore will not tie those two together; our own matching against the lidar (the skyline, the roof edges) is
what can. What anchors CAN give, cheaply: a line of them dropped every ~10 m along a walk records each correction
ARCore makes (an anchor that moves is ARCore admitting drift), which the after-walk fix can use as a drift log. A few
dozen is a modest load. The pins already use anchors in Chrome (SCAN-H10: held to inches); the app has no anchor call
yet (a bridge 2 call).

**Cloud Anchors, for the next stage (a first walk as the reference for later ones).** Hosted in Google Cloud, resolved
later by a new session from the same place's visual features. With an API key they live 24 hours; longer needs
keyless (OAuth) sign-in, extendable through the Cloud Anchor Management API. Hosting wants the spot seen from several
angles while moving round it (feature quality INSUFFICIENT / SUFFICIENT / GOOD). Quotas are generous (30 hosts and 300
resolves a minute). For the next stage: the first, well-fixed walk hosts a handful of anchors at strong spots (house
corners, the drive); a later walk that resolves any one of them is placed at once in the first walk's frame, and so on
the map. This sits beside the plan to build a mesh from the first walk; the two check each other.

**Geospatial Depth.** Merges Streetscape Geometry (Google's building and terrain meshes from Street View: LOD1
footprints extruded, "building heights may be inaccurate", or LOD2 roofs) into the depth image, out to 65 m, where
VPS works. Our concern is right: in a back yard VPS may not localise at all, and without it nothing changes. Two
further reasons to keep it off for now: it comes through the smoothed depth image, so the phone's point cloud would
partly be Google's mesh rather than the yard; and our lidar model of the house is already better geometry than LOD1/2.
Worth keeping in mind as a check: where VPS works, Streetscape's building meshes against our lidar placement.

**Scene Semantics (the most useful of the five).** Per-pixel labels, outdoors, with a confidence image and a cheap
per-label share of the picture: BUILDING, STRUCTURE (fences, walls, guardrails), TREE (trees and shrubs), TERRAIN
(grass, soil), ROAD (includes driveways), SIDEWALK, SKY, OBJECT, VEHICLE, PERSON, WATER, UNLABELED. Not every phone
supports it (isSemanticModeSupported). Today the page tests for sky itself (anchors.js) and the runners run Segformer
after the walk; this would give both live, on the phone, aligned to the depth grid.

**Lighting estimation.** Environmental HDR gives a main light direction and intensity, ambient light and a cubemap,
estimated by machine learning for rendering. Little use to the shade map: the sun's direction is known exactly from
the time and place. The camera's own pictures say more (which ground is sunlit and which shaded, with a timestamp).

### Road map (owner, 2026-11-07; not started unless marked)

Bridge 2 (one new APK, page work after it is site deploys). BUILT 2026-11-07 (items 1-3 and the drift log; not yet
measured on a walk): scan/lib/semantics.js, the app's anchor() / dropAnchor() and labelled depth grid. People and
cars (ARCore sure) are dropped from the points; the nudges use the label shares when the app sends them; the walk
keeps the label shares, a check that the labels sit right on the depth (sky cells with near depth), and the drift
log (an anchor every 10 m; how far ARCore moved each). Unknown from Google's docs: how the label image sits on the
screen; it is taken to share the depth image's frame, and that check says whether it does.
  1. Scene semantics on the depth grid: each depth sample's label and confidence; the share of sky, building, road and
     sidewalk per picture.
  2. Anchors through the bridge: the pins anchored in the app as they are in Chrome, and a drift log of anchors along
     the walk.
Then, on the page and the runners:
  3. Nudges from the semantic shares ("look at a building", "look at the drive") instead of the page's own sky and
     colour tests.
  4. Labelled points in the lidar match: building and structure points weighted as hard edges, tree points as soft,
     cars and people dropped; where to tie the lidar into buildings, shrubs, permanent structures and pavement.
  5. The ground split by label (TERRAIN against ROAD/SIDEWALK) beside surface.js's colour test, for the pavement match.
Future uses of the labels:
  6. Refining lawn traces from walks, or building them from scratch.
  7. Refining tree canopies.
  8. Tree trunks placed for the water model (the AR still ignores trunks for its own fix: owner's direction).
  9. Fences placed for the water and shade models.
  10. Shade truth from walk pictures: sunlit against shaded ground, with time and place, against the shade map.
Next stage (reference walks):
  11. Cloud Anchors hosted on a first well-fixed walk, resolved by later walks; with the first walk's mesh.
Parked:
  - Geospatial Depth (smoothed depth only, VPS in front yards only, our lidar is better geometry); maybe Streetscape
    meshes as a check where VPS works.
  - Lighting estimation (the sun's direction is known).

SCAN-H23, the rest of the cause (2026-11-07, the owner's two walks on app 1.7: "Upload: all saved (735 parts, 78.9 MB
sent); 50 refused by the site"). The Street View trail was kept in live.json with "lat"/"lng", and the site refuses
any twin part holding degrees (src/twin.js leaks, the privacy rule). So every live.json written after Earth first
tracked was refused and dropped: the first outdoor app walk and these two lost their pins, Street View trails and
drift logs from live.json; their summaries (no places) were kept. Fixed: a reading keeps the map's local metres and
its turn (`at`, `theta`), never degrees, and only with a map open; a test passes live.json through the guard; the
upload line now names the last refused part and the site's reason.

### SCAN-H24. App 1.7 on the owner's lot: Street View at 4-5 m and 3.5-4.3 degrees; ARCore's own drift up to 1.1 m; the labels sat wrong (2026-11-07)

Two walks, from their summaries only (their live.json was refused, SCAN-H23: no check marks or trails to score).
MEASURED:
  - Street View (ARCore's own figures): median accuracy 4.1 m and 5.1 m (best 4.1 and 4.5), heading 3.5 and 4.3
    degrees (best 3.2 and 3.8), tracking within 2-3 s. So on the owner's lot it is not localising to VPS grade
    (sub-metre); the place is GPS-like, the heading good. It started 4 of the first walk's live searches (as a whole
    placement, since 4 m and 3.5 degrees pass the 5 m / 12 degree bar); never sure enough (2 m / 5 degrees) to
    place the walk by itself.
  - The live fix on the first walk (434 ft): checks C3, C4, C5 read 36.5, 33.3 and 24.8 ft off by the fix; 31 of 66
    asks kept, 32 refused as "two places fit about as well". Whether Street View's starts helped or hurt is not
    known from this.
  - Drift log: ARCore moved its anchors median 0.11 m (most 0.26 m) on the 434 ft walk, median 0.34 m (most 1.14 m,
    at 185 m walked) on the 780 ft walk. ARCore's own corrections are small next to the placement's errors.
  - Raw depth at confidence 0.2: 45,486 and 67,161 points (8,462 at 0.4 on the earlier walk); 56% and 74% of the
    depth given was still under 0.2.
  - Semantics: 97% of depth cells labelled with confidence; terrain 45-56%, tree 18-20%, building 10-15%, sky 9-11%.
    But 39% and 47% of sky-labelled cells had near depth: the labels did not sit on the depth. Google says the
    label image's height matches the display's aspect ratio, so it is taken to be upright like the screen while the
    depth lies landscape; app 1.8 reads it by screen position when the shapes differ, and says which it did. Until
    then the page uses no label by position (the share-of-picture nudges were unaffected).

Correction to the fix above (owner, 2026-11-07: "I never signed off on that restriction. I just didn't want the gps
for my own house, or work, in the very public github files... i think we should use coordinates"). The refusal of
degrees in twin parts was this session's own rule, wider than the owner's. Twin parts (the private bucket) now keep
the Street View readings in degrees with ARCore's East-Up-South turn, and the map's metres beside them when a map is
open; the site no longer refuses degrees there. Walk summaries still refuse them, as the walk listing prints them in
the public workflow logs; the tools print counts only (CLAUDE.md, "Addresses and coordinates").

## 12. Match what the camera should see, not where points fall on a plan (owner, 2026-11-07)

The owner, from a screenshot of the live view: the roof was drawn flat (fixed the same day: the drawing took each
row's highest cell), and "neither real world objects or lidar objects block the rendered lidar, but in real life
they do... maybe that's part of why lidar matching is so bad... The matching isn't considering the things that the
camera should actually be able to see... loosen the match on individual features while putting more emphasis on
the overall arrangement of features... Seeing a wall, a hill, and a few trees can tell you exactly where you're
standing". And on tall roofs: "looking up the roof may show you the true peak, it might show the eaves, or it might
show a lower peak. That's why the opacity thing matters so much."

HARD (read from the code, 2026-11-07): the live match (scan/lib/lidar.js placementCost) is a plan-view match. Each
phone point is moved by the candidate placement and charged by how far it lands, ON THE MAP, from a wall, a tree or a
fence outline (and high points from the roof's edge); heights enter only through the ground's offset. It never asks
what the model says the camera could see from that spot. So a point on a ridge seen from below is charged against
the roof's edge, the far side of anything costs the same as the near side, and the yard's many similar walls and
fences give "two places fit about as well" (32 of 66 asks on the 434 ft walk, SCAN-H24).

SPECULATION, to be measured: render-and-compare. For a candidate placement, cast the camera's rays through the
model (a 2.5D grid of column heights: the ground, buildings with their roof shapes, canopies as soft), take the
first surface each ray meets, and compare that depth picture with the phone's own depth picture, cell by cell;
sky in the model against sky in the picture (the skyline study already does that part, after the walk, and placed
walks to about 5 ft alone). Occlusion comes free, and so does the arrangement: one picture is scored whole, not
point by point. ARCore's labels weight it: building and ground cells counted hard, tree cells loosely (crowns move
and change by season), cars and people dropped.

Order: build it first after the walk, on the GitHub runner, where walks with check points give the truth and it
can be scored beside the present placement; port it to the live match (WebGL renders small depth pictures quickly)
only if it wins.

### SCAN-H25. Sight lines through the model, first measured: no better than the placement after the walk (2026-11-07)

scan/tools/view_study.py on the owner's two app-1.8 walks with six check points each (907 ft with the live fix on;
729 ft recorded only). Median error at the check points:

| | 907 ft walk | 729 ft walk |
|---|---|---|
| live fix, as walked | 24.0 ft | (record only) |
| after the walk now (skyline, then the ground's shape) | 2.7 ft | 3.6 ft |
| GPS / Street View trail alone | 16.8 ft | 2.2 ft |
| sight lines A: 1 m columns, crowns cheap | 9.0 | 1.4 |
| B: 0.25 m, open under the eaves, crowns neutral | 3.6 | 5.4 |
| C: B, ground by its height | 3.6 | 5.4 |
| D: C, early stops doubled | 4.4 | 3.8 |

HARD: no variant beats the present placement on both walks, and on neither walk is the check points' own fit the
cost's minimum (a search from it moves 3.5-9 ft). At the truth 45-65% of the phone's non-ground lines end in what
the model calls open air: most of what the phone sees standing (shrubs, bare branches, fences, things below the
lidar's notice) is not in the model as anything hard, so the lines that could carry the occlusion signal are few
and outvoted. A's 1.4 ft is one start of four landing well (its starts end at 1.4, 2.0, 6.4 and 7.7 ft), not a
result. The study stays in task place, printing; placement.json is unchanged.

Also measured: ARCore's own drift is small next to these (anchors moved a median 0.1-0.3 m, at most 1.1 m, over
434-907 ft), and the after-the-walk placement, one rigid placement for the whole walk, is 2.7-3.6 ft while the live
fix, which places a window of the last 25 ft at a time, is 24 ft. SPECULATION, the next thing to measure: the live
fix should place the whole walk so far at once, with the ground's shape as the after-walk does (the walk's extent is
what pins it), rather than short windows that each fit two places about equally. And the sight lines want the
phone's points labelled (ARCore's labels: buildings and structures only), which means keeping each point's label in
the twin; the page has it, the twin's cloud record does not.

### SCAN-H26. The whole walk placed at once, live: 2.4 ft where the live fix was 24; the cursor's jump is a phantom (2026-11-08)

The owner, after SCAN-H25: the strategy (what the camera should see against what it sees) is right, so one of the
inputs is wrong; and on the 1.7 and 1.8 walks the crosshair now and then jumped to a few feet away while facing the
house's west wall straight on, though up and down the wall read the true 30-odd feet. Then: "if 1 and 2 still seem
like good ideas, go ahead with them" (1: place the whole walk so far at once, live; 2: keep ARCore's label with each
point).

1. THE WHOLE WALK AT ONCE (scan/lib/walkfix.js, live since this date). Every 10 s the lidar worker takes the Street
View trail's placement (GPS's when Street View has fewer than 10 readings within 10 m) and refines it by all of
ARCore's ground seen so far (one point per half metre, Gaussian 15 cm about the median height offset, the after-walk
study's steps). Used when 45% or more of the ground sits on the lidar's and no placement 2 m or 5 degrees off fits
within 2% as well; without two references it comes before the windowed fix. Replayed by post-fix on the 907 ft walk
(six check points; the live fix as walked was 24.0 ft):

| walked | used? | ground on the lidar | margin | checks median | the trail alone |
|---|---|---|---|---|---|
| 227 ft | no (a place a few metres off fits as well) | 80% | 0.4% | 11.5 ft | 18.6 ft |
| 453 ft | no | 80% | 0.6% | 9.6 ft | 19.7 ft |
| 680 ft | yes | 79% | 2.4% | 3.1 ft | 20.3 ft |
| 907 ft | yes | 79% | 3.4% | 2.4 ft | 19.7 ft |

The 729 ft walk (six check points, recorded only):

| walked | used? | ground on the lidar | margin | checks median | the trail alone |
|---|---|---|---|---|---|
| 182 ft | no | 79% | 0.4% | 41.5 ft | 8.3 ft |
| 364 ft | no | 75% | 1.7% | 17.4 ft | 7.8 ft |
| 547 ft | no | 76% | 1.2% | 6.7 ft | 7.8 ft |
| 729 ft | no | 74% | 1.4% | 3.6 ft | 7.7 ft |

HARD (two walks): the margin gate refused every placement that would have been 6.7-41.5 ft off, and took the two
that were 2-3 ft; it never took a bad one. On the 907 ft walk it places the walk from 680 ft on and ends better than
the after-walk placement (2.4 against 3.1 ft); on the 729 ft walk it never places it, though by the end it would have
been right (3.6 ft, margin 1.4% against the 2% wanted). Both trails it started from were Street View's: 19.7 and 7.7
ft alone, where the GPS trail alone was 16.8 and 2.2 ft (SCAN-H25). SPECULATION: the 2% margin may be a little strict;
two walks are too few to lower it.

2. WHICH DEPTH POINTS ARE REAL (scan/tools/depth_audit.py, in task place). A point is a PHANTOM when the walk's own
other sight lines pass through its 0.3 m cube more than twice as often as anything is seen there. On a synthetic
yard every planted mid-air point is caught and 4-5% of true wall points are flagged; 10-15% of true ground points
are flagged too (glancing lines), so ground shares are not evidence.

| | 907 ft walk | 729 ft walk | 1.7 walk (no checks) |
|---|---|---|---|
| standing points that are phantoms | 30% of 17,873 | 14% of 10,829 | 17% of 7,215 |
| of those within 7 ft | 39% | 19% | 19% |
| standing points short of the model's first hard surface (truth) | 20% | 18% | 18% (placement) |
| ... of those in front of a building | 41% | 14% | 8% |
| view study C, all points / without phantoms | 3.6 / 4.1 ft | 5.4 / 5.2 ft | - |

The owner's west-wall moment is in the 729 ft walk: 4:54 in, 553 ft walked, facing east (80 degrees), camera +5
degrees: 7 readings at 3.4 ft where the model's wall is 24.6 ft, all of them phantoms by the walk's own lines. The
907 ft walk has another facing east (8:56, 842 ft walked): 56 readings at 12.7 ft against the model's 27.9, 70%
phantoms.

HARD: the cursor's jump is ARCore's depth, not the page: the crosshair is ARCore's own hit test, and the saved raw
depth (a separate path, cut at confidence 0.2) shows the same short readings at that moment, which the walk itself
contradicts. HARD: leaving the phantoms out does not mend the sight-line placement (3.6 to 4.1 ft, 5.4 to 5.2 ft):
the open air at the truth (50-65% of lines) is not phantoms.

SPECULATION: the raw-depth confidence cut went from 0.4 to 0.2 on 2026-11-07 (SCAN-H23), before both walks; the
phantoms may be the weak readings it let in. A plain wall is a poor surface for depth from motion and a window
reflects; either could make one spot read short. Not measured: the twin did not keep each point's confidence.

3. LABELS AND CONFIDENCE KEPT (twin labels-NNNN.bin, from this date): for each cloud record ARCore's semantic label,
its confidence, and the depth's own confidence. The audit splits phantoms by label and by confidence, names the
label at each near-reading moment, and runs the view study on ARCore's buildings and structures alone. The next walk
answers: are the phantoms the 0.2-0.4 readings (then the cut goes back up, outdoors at least), and what are the
open-air lines (trees, fences, shrubs, cars)?

### SCAN-H27. The best fit overall: 1.8 ft on one walk, 7.7-13 ft on the other; without labels a tree reads as a wall (2026-11-08)

The owner: not buildings only; match the ground, permanent structures, driveways to the lidar's brightness and the
general positions of shrubs, "going for the best possible fit overall rather than a perfect fit on any one object":
an ornamental grass flown at 7-8 ft is cut down each spring, three shrubs were planted since; "3 partial matches =
fit, 1 pretty good match and 1 partial match = fit."

Also asked: no filtering of our own compared a depth reading with its neighbours (only ARCore's confidence, 0.2, and
range, people and cars, and the height bands). A neighbour check (scan/lib/spikes.js: a spot of up to 3 x 3 cells
read 60% nearer than the surface round it, a post or an edge excluded) could not be judged on the saved walks (the
twin keeps a median 35 of each picture's 448 readings), so it now runs on the page on every whole picture, RECORDED
ONLY (a flag with each point, a count in the summary); the next walk says whether it catches the phantoms.

scan/tools/consensus_study.py, in task place: credits capped per thing (each 2 m of ground; each metre of a
building's edge, graded by how near the points sit to its wall or roof edge, from points whose sight line reaches it;
each lidar thing with points anywhere over its footprint grown 0.75 m, at any height; pavement against brightness,
30 credits at most), nothing lost for what changed, a loss only for seeing through a house; the search kept within
the trail's reach. Median at the check points:

| | 729 ft walk | 907 ft walk |
|---|---|---|
| after the walk now (skyline, then the ground) | 3.7 ft | 3.1 ft |
| the whole walk at once (ground only, live since SCAN-H26) | 3.6 (not taken) | 2.4 |
| ground + buildings + things | 1.8 (margin 1%) | 13.0 (5%) |
| all, seeing through a house counted | 1.8 (2%) | 7.7 (4%) |
| buildings alone | 9.8 | 13.2 |

HARD (two walks): one walk is the best yet, the other well worse; not ready to place walks. On the 907 ft walk a
placement 13 ft off earns 24 building credits to the truth's 15, even counting only walls the camera could see: with
no labels, any standing point near a wall counts as wall, and that walk's standing points are 30% phantoms besides
its trees and shrubs. First version (no line of sight, pavement at a credit a cell): 15.8 and 9.5 ft.

SPECULATION, measured on the next walk: ARCore's labels route the evidence (in the study since this date: a wall
earns only from building or structure points, a thing from tree, structure or object, sky, people and cars from
nothing). Walks from the evening of 2026-11-08 carry them.

### SCAN-H28. The first walk with labels on every point: the best fit overall 1.9 ft; the spike check catches almost nothing (2026-11-08)

Walk 1794162116852 (app 1.9; 7 check marks; depth kept to 30 m; labels, label and depth confidence and the page's own
spike flag with every point). Task place, run 197. Median at the check points:

| | ft | margin |
|---|---|---|
| after the walk (skyline, then the ground; placement.json) | 5.7 | |
| the whole walk at once, live (SCAN-H26) | 7.8 | |
| the whole walk at once, replayed | 4.2 | |
| the GPS trail alone | 8.9 | |
| view study A (1 m columns) | 1.0 | |
| view study C (0.25 m, the ground by height) | 2.8 | |
| best fit overall: ground only | 10.4 | 4% |
| best fit overall: buildings only | 2.2 | 6% |
| best fit overall: things only | 15.5 | 13% |
| best fit overall: ground + buildings + things | 2.1 | 5% |
| best fit overall: all, seeing through a house counted | 1.9 | 5% |

HARD (one walk, the first with labels): with ARCore's labels routing the evidence, every best-fit weighting that
counts buildings lands within 2.7 ft, and the lowest score is the truth's own neighbourhood (refined from the truth,
2.0 ft). The 907 ft walk of SCAN-H27, without labels, was 7.7-13 ft. One walk: the labels are the likeliest reason,
not a proven one (a different walk, a different route). Ground alone and things alone do not place a walk here.

HARD, the phantoms (a point seen through from elsewhere on the walk more than twice as often as seen): 16% of all
points, 18% of standing ones. By label among standing points: tree 27%, terrain 25%, building 15%, structure 10%,
sidewalk 4%. By ARCore's depth confidence: 20-21% below 0.4, 19% at 0.4-0.6, 12-13% at 0.6 and over: the confidence
halves them at best and is no filter on its own. Leaving the phantoms out of view study C: 3.0 ft (2.8 with them).

HARD, the spike check (scan/lib/spikes.js, recorded only): 25 points flagged of 43,377 (0%); 96% of those are
phantoms, but they are 1% of the phantoms. It is right when it fires and almost never fires: the phantoms are not
lone near spots on a surface read correctly round them; they come as whole patches (the worst moment, 1:48 facing
W at a building: 72 readings at a median 21 ft where the model's first surface is 53 ft, 43% phantoms, depth
confidence 0.32, labelled building). Not worth turning on as a filter.

SPECULATION: the patches short of a building at 1:46-1:49 may be something real the lidar lacks (a parked car, a
fence, a trailer) rather than bad depth; 43-63% of them are phantoms by the walk's own lines, so not all.

### SCAN-H29. Do the check marks sit on the lidar? Not measurable to a foot on this lot (2026-11-08)

The owner: the check marks are put on the Mapbox photo, on things it shows, within inches by eye, "BUT I'm wondering
if the aerial imagery is connecting correctly with the reality". Every placement error in SCAN-H2x is measured
against those marks, so a photo off the lidar at a mark is an error in the yardstick. Task checks (run 207, walk
1794162116852, 7 marks), scan/tools/checks-shade.mjs: the shade map's own photo matcher (align.js alignToPhoto,
H103/H108) asked again on the lidar as the scan uses it.

HARD: when the shade map built this lot's model it put the lidar on the same Mapbox photo the marks are on, moved
1.1 ft past the datum move, and called that fit sure. Asked again now: the whole lot 1.1 ft (east +0.1, north +1.1),
NOT sure (its quarters alone 8.0, 2.0, 1.2, 1.1 ft; error about 2.2 ft). Round each mark (35 m squares): none sure;
two read 0.9 and 1.6 ft, four read 6.6-12.1 ft with another match nearly as good (too little open ground: trees,
houses and 1.6 ground returns a square metre). A matcher of the test's own (checks_lidar.py, removed) found
synthetic shifts but read noise here.

So the photo-to-lidar agreement at the marks is NOT known better than about 1-2 ft on this lot, the same size as
the best placements (1.9-2.2 ft, SCAN-H28). SPECULATION: part of what the studies call placement error may be the
marks' own; the best-fit score preferring a pose 2 ft from the marks' fit (SCAN-H28: "refined from the truth it
moves to 2.0 ft") fits that, and fits a flaw in the score just as well.

### SCAN-H30. Repeat walks: no sign the photo's marks are off; the walks disagree with each other by 3-6 ft (2026-11-08)

The owner pointed to the research report: a fit's score "is a residual, not an accuracy. It needs held-out checks:
surveyed corners, or agreement between repeat walks." Task repeat (run 208), scan/tools/repeat_study.mjs, on the
three walks that share the six check marks (1794089603603, 1794090013502, 1794162116852): each mark carried through
each walk's own placement. A gap from the photo's mark that every walk shares would be the yardstick's (SCAN-H29);
walks scattered round the mark are the placements'.

| placement | each walk from the photo's mark (median) | walks from their own mean (median) | their mean from the photo's mark (median) |
|---|---|---|---|
| after the walk (placement.json; never sees the marks) | 3.9 ft | 5.5 ft | 0.7 ft |
| best fit overall (all) | 2.9 | 7.7 | 2.3 |
| best fit (ground + buildings + things) | 3.4 | 10.0 | 4.2 |
| the marks' own fit (fitted to them; not held out) | 1.2 | 1.2 | 1.1 |

HARD (three walks): the after-the-walk placements, which never look at the marks, average to within 0.4-0.7 ft of
the photo's marks at four of the five usable marks (2.1 ft at the fifth): no sign of a shared offset, so no sign the
photo's marks are off the lidar. With walks 3-6 ft apart and only three of them, a shared offset under about 2 ft
cannot yet be ruled out; each further walk narrows it. What is large is the walks' disagreement with each other.
Mark 1794089537730 is 60 ft off on one walk even under the marks' own fit: a mismark there (stood elsewhere, or the
tracking jumped), left out of the medians' reading. Fitted to their own marks, the walks agree to 1.2 ft: ARCore's
bending and the marking itself put about a foot under everything. The best fit's scatter is mostly the 1794090013502
walk (5-12 ft; no labels, SCAN-H27); on the newest walk (labels) it is 0.8-2.4 ft at every usable mark.

RE-RUN with a point marked twice counted by its last mark (run 209; the owner: "I did hit one checkpoint wrong, then
I selected the right ones and did it again"; scan/lib/postfix.js checkMarks, now in every study): the after-the-walk
placements' mean sits 0.4-1.2 ft from five of the six marks and 2.1 ft at one, but 4.9 ft from mark 1794089537730
(the third placed), and there the three walks agree with each other (6.7 ft apart at most) and lean the same way
(east +2.3, north -4.3 ft). Fitted to their own marks, every walk leaves that mark 2.0-4.4 ft off in the same
direction (mean east +1.9, north -2.8 ft) while the other five sit 0.5-1.5 ft. HARD: that one mark disagrees with
the other five the same way on all three walks: the photo's mark there is about 3-5 ft from where the phone stands.
SPECULATION: something with height (a leaning top in the photo) or a point hard to stand on exactly; the owner knows
which it is.

### SCAN-H31. Registered to the lidar with small_gicp, ground first: it cannot move off its start on this lot (2026-11-09)

The owner pointed at the research report's registration tools (small_gicp, TEASER++, Open3D; MIT) and, the site
being non-commercial, at CMRNet / OrienterNet (CC BY-NC) too. scan/tools/register_study.py (task register, run 210,
the three walks of SCAN-H30): the report's recipe (Paired-CSLiDAR): GICP on the ground first, then the ground and
the 0.3-2.5 m band together, each band to itself, a stage kept only if more points land within 0.4 m; four degrees
of freedom; from every start the studies use. On a synthetic yard with gentle relief it found the truth from 5.7 ft.

HARD (three walks): on the owner's lot it does nothing useful. From the after-the-walk placement neither stage lands
more points, so it keeps the start (the repeat table is identical to the after-the-walk one: 3.7 ft from the marks,
the walks 5.0 ft from their own mean); from other starts it settles where it began (7-14 ft). On the newest walk
the score prefers the after-the-walk pose (17,451 points landed, 5.6 ft from the marks) to the marks' own fit
(16,843): the lawn is too flat for the ground to say where along it the walk lies, and adding the low band lands
FEWER points (the lidar has 7,350 low returns there, mostly crowns and roofs' edges the phone does not see the same
way). This is the report's own caution ("the vertical and tilt terms weakly constrained on flat lawns") measured.

So the geometric registration cannot place a walk on this lot by itself. What does say where along the lawn the walk
is: buildings and things with ARCore's labels (SCAN-H28, 1.9 ft on the newest walk). SPECULATION: TEASER++ needs
distinctive features to match globally and would meet the same flat ground; CMRNet (camera against a lidar map,
licence now no bar) is the untried kind, but was trained on dense car lidar and would need a GPU to retrain (Modal:
ask first).

### SCAN-H32. A walk placed by an earlier walk: shapes 2.1-3.7 ft on four of six pairs; pictures held back by the twin's sparse depth (2026-11-09)

The owner, on the next phase (a first walk as the reference that places later ones without marks): matching a phone's
points to the same phone's points should be far easier than to the lidar, "so lets try both photos and shapes"
(later softened: pictures can fix from a single look, so the ground tests decide). scan/tools/walk_fix_study.py, task
walkfix, runs 217-219, on the three walks of SCAN-H30 (1794089603603, 1794090013502, 1794162116852): each walk in
turn the reference, placed by its own marks; each other walk placed from it without its marks, scored on its own six
check marks.

| placed walk, by reference | shapes | pictures | its own marks' fit | after the walk (lidar) |
|---|---|---|---|---|
| ...013502 by ...603603 | 3.7 ft (landed 0.40) | none | 1.4 | 2.7 |
| ...116852 by ...603603 | 2.1 (0.43) | none | 1.2 | 5.6 |
| ...603603 by ...013502 | 2.6 (0.46) | none | 0.8 | 3.6 |
| ...116852 by ...013502 | 27.2 (0.22) | none | 1.2 | 5.6 |
| ...603603 by ...116852 | 2.9 (0.37) | none | 0.8 | 3.6 |
| ...013502 by ...116852 | 15.0 (0.25) | none | 1.4 | 2.7 |
| median | 3.3 | - | 1.2 | 3.6 |

HARD (three walks, one lot):
  - SHAPES (the standing things as a plan, every 2 degrees by correlation with no start, the best eight refined by
    small_gicp with the ground) placed four of six pairs at 2.1-3.7 ft, as well as or better than the lidar's
    after-the-walk placement, with no lidar and no marks; the two failures (15, 27 ft) are both between the newest
    walk and 1794090013502, the walk recorded before labels. The share of points landed (within 0.3 m of the
    reference's) told them apart on all six: 0.37-0.46 for the good, 0.22-0.25 for the failures.
  - Run 217's first shapes (three turns refined, not eight) put ...603603 by ...013502 at 72 ft and by ...116852 at
    4.9 ft; refining more turns brought them to 2.6 and 2.9.
  - PICTURES matched well between walks (63-288 picture pairs a pair of walks passed the two-camera check) but never
    placed a walk. The twin keeps one depth point per small cube, the first seen (43,000-93,000 for a whole walk), so
    few matched picture points have a depth on the reference's side: 10,800-48,000 of a walk's ~500,000 points found
    one (run 219, every depth point through every picture, the nearest surface within 12 px), and from those 0-17
    pictures a pair placed a camera and at most 2 agreed. Requiring depth on both sides (run 218) left 0-13 pairs.
  - Buildings and structures alone could not be tried: only the newest of the three walks has labels.
  - Speed, the batch study on the free runner: shapes 3-6 s a pair of walks; pictures about 5 min a pair (some 2,300
    picture comparisons, about 0.13 s each).

SPECULATION:
  - The pictures failed for want of depth in the REFERENCE, not for want of matches. A reference walk that keeps the
    depth image with each of its pictures (ARCore's, ~160 x 90; some 30 KB a picture, ~12 MB a walk) would give every
    matched point a depth, and is what a live picture fix would need anyway.
  - The landed share (about 0.3 between the good and the bad) is a usable gate: below it the walk is not placed and
    the marks are asked for. Three walks are too few to fix the number.
  - The two failures may be the unlabeled walk (its tree points pass as standing things that the other walks' trees
    do not match), partial overlap, or both; a fourth walk with labels would tell.
  - A live shape fix needs enough of the walk to have seen some walls and shrubs (20-60 s, untested); a live picture
    fix could come from one look at the house.

### 13. Recording and replay, Geospatial Depth, camera modes (the app's bridge 3, 2026-11-08)

The owner: "let's do it so I don't have to keep doing the same walks over and over." App 1.9: every walk in the app is
recorded by ARCore (camera, motion, Geospatial) unless the page's box is unticked, with the page's actions (marks,
pins, checks, undo) on a data track at their frames; after the walk the MP4 goes to the site (twins/<walk>/recording.mp4,
private) and off the phone. "Replay a recorded walk" fetches it and runs ARCore on it instead of the camera, in real
time (Google: playback cannot be sped up, and "ARCore APIs may produce different results during playback"); the page
does the recorded actions again at their frames and keeps the replay as a walk of its own (summary replayOf), so any
change to the page can be tried on a walk already walked. A replay uses no live GPS.

Geospatial Depth (developers.google.com/ar/develop/java/depth/geospatial-depth): with Geospatial and Streetscape
Geometry on and depth AUTOMATIC, ARCore's (smoothed) depth reaches 65 m where Google has VPS. Google documents it for
the smoothed depth only; the page's matching uses raw. On: the smoothed depth past 25 m is kept in the twin, flagged
(flag 2 in labels-NNNN.bin) and left out of every sight-line study and of the live match, since it is Google's model
placed by the Geospatial pose, not the camera's sight. SPECULATION: those points against the lidar would say how well
the Geospatial pose itself is placed, a check independent of the phone's depth.

Camera modes (the owner: "is the 1x camera still the best option? Or should we use the widest available?"): Google's
camera-config page offers no choice of field of view or of physical camera; ARCore tracks with its own camera. The app
now lists every mode ARCore offers on the phone (camera id, picture and texture sizes, frame rates, stereo) in the
walk's summary; the walk list prints them. If ARCore offers more than one camera id, a wider one can be tried; if one,
there is no choice to make.

## 14. Staying ready for iPhones (owner, 2026-11-08)

"We're not ready to build the iPhone app, I just want to make sure we're not doing development that we'll regret
later when we incorporate iPhones." The plan for iPhones, when it comes: a thin Swift app running ARKit under the same
page, answering the same bridge (window.LawnARNative), like the Android app (not Unity: that would rewrite the page in
C# and keep only what ARCore and ARKit share). Until then, these keep the work portable:

  - THE PAGE AND THE STUDIES DO THE WORK; THE APP ONLY REPORTS. A new ability goes in the bridge as data any phone
    can give (a pose, a depth grid with a 0-1 confidence, a picture with its projection), never as an ARCore idea the
    page must know about.
  - ARKIT HAS NO OUTDOOR LABELS. Scene Semantics (sky, building, tree, terrain...) is ARCore's alone; ARKit only
    classifies a LiDAR mesh into indoor kinds, and ARCore on iOS has no semantics or depth. Anything that needs labels
    must also work with them missing, or take them from our own model (the Segformer the studies already run, on the
    pictures, projected onto the points), with LABELS (scan/lib/twin.js) as our own list, not ARCore's.
  - DEPTH IS NOT ON EVERY IPHONE. ARKit gives depth only on Pro models (LiDAR, which reads a few metres); others have
    none. What places a walk must not need depth: the pictures (skyline, pavement) and an offline model from them
    (research report 2026-11-08) work on any phone; depth makes them better where there is some.
  - ARKIT HAS NO RECORDING AND REPLAY. ARCore's MP4 replay is a development tool, not something the product needs. The
    walk's own record is the twin (points, track, pictures with their poses); offline work reads the twin and, when
    there is one, a plain video of the walk, not ARCore's own tracks.
  - Both stacks use the same frame (metres, right-handed, Y up, the camera looking down -Z), as WebXR does: keep it.
  - Street View positioning (Geospatial, Streetscape) is in Google's ARCore SDK for iOS too; Geospatial Depth is not.

## 15. References placed by hand; the automatic lidar fix set aside (owner, 2026-11-09)

"Let's go back to just placing references manually and set aside everything about getting a live fix from lidar and
finding the best fit after a walk. We might want to keep some things to check/correct drift (maybe other users will
have bigger drift problems)... And maybe we should consider using it to line up lidar (and remember that a future
feature will be to refine tree canopies, auto add fences, and update ground grading after a user has done grading
work). But yeah, it looks like automatic lidar alignment is just too difficult to make work." (SCAN-H28 to H31.)

  - The walk is placed by its reference marks. The live lidar fix and the whole-walk fix are off on the page
    (scan/public/app.js LIDAR_LIVE; ?lidarfix=1 turns them on for a test). The lidar is still read and drawn.
  - Kept, as checks: task repeat (walks against each other), task checks (marks against the lidar), the depth audit,
    the inspector. The after-the-walk studies stay in task place as studies, run only by hand.
  - Later, the other way round: a walk placed by references can line the LIDAR up (canopies refined, fences added,
    the ground's grading updated after work), the phone's walk as the newer truth.
  - References want flat ground features (driveway and patio corners, path edges): the well-head check (6-8 in) sat
    3-5 ft off the same way on every walk (SCAN-H30), though too short to lean; the crosshair's hit kind and distance
    are now kept with each mark to tell why next time.
  - The placement map (same day): points and labels sized in screen pixels (they were a sixth of their size), zoom to
    40x, a point keeps where the finger took hold of it, a magnifier while dragging, and the photo the map was traced
    on (the county photo with the editor's line-up, or Mapbox).

## 16. Placed by an earlier walk, live; a depth grid with each picture (owner, 2026-11-09)

After SCAN-H32 the owner: "Yes go ahead with 1 and 2" (1: the live shape fix; 2: depth kept with each picture), and on
the choice between them: "I'll soften my stance about going with shapes if they're about the same. The real test will
be on the ground live tests."

  - THE REFERENCE: a walk placed by its marks, its standing things and ground carried onto the map
    (scan/lib/walkref.js buildRef), one per map, kept as refs/<map>.bin in the twin bucket (GET/PUT
    /api/scan/reference?map=, the admin only). Made by workflow S task reference from a twin
    (scan/tools/reference-build.mjs build); later, at the end of a well-marked walk, by the page.
  - THE LIVE FIX: the page keeps this walk's standing things and ground (20 cm cells, up to 40,000 each) and every
    15 s, once 600 standing cells are in, matches them against the reference in a worker (scan/public/ref-worker.js,
    walkref.js shapeFix: correlation over every 4 degrees on 1 m cells, the best eight refined by point-to-point ICP;
    1.4 s on a synthetic yard on the runner's CPU). Used only when 30% or more of the walk's points land within
    0.3 m of the reference's (SCAN-H32's gate). It places the walk when fewer than two references are marked
    (locate.js fitFor: 'earlier'); two marked references still come first. The HUD says which, or what the match
    waits for; live.json keeps the fix and the asks (prev).
  - THE DEPTH WITH EACH PICTURE: key-NNNN.depth beside key-NNNN.jpg (app.js keyDepth): u16 [nx, ny] then each cell's
    surface distance from the camera in mm, 72 x 128 cells, about 18 KB a picture. On the app it is a finer grid asked
    of the same bridge call (track.js dense: no new APK); in Chrome, the WebXR depth sampled. walk_fix_study.py reads
    it first, so the pictures can be tried again on walks that have it.
  - Task walkfix also runs the page's own fix (reference-build.mjs check) beside the Python study, on the same walks.

  - CALIBRATED (runs 222 and 224, task walkfixjs, the three walks of SCAN-H30). The page's own fix, scored on each
    placed walk's held-out check marks: on 1 m cells it put the pairs where the study's shapes did (2.5-3.9 ft on the
    good ones) but its landed share, then taken on the ICP's sample, sat at 0.23-0.30 and passed nothing. Taken on all
    the walk's points as the study took it, with 0.5 m cells and 4-degree turns: 2.4, 1.9, 2.8, 4.3, 3.0 ft placed
    (landed 0.33-0.41, standing things 0.13-0.24), and 6.5 ft refused (landed 0.24): median of the placed 2.8 ft, the
    study's shapes 3.3. The gates: 0.30 of all points, 0.12 of the standing things (flat ground lands anywhere on a
    flat lot: a test walk of another lot passed on the ground alone). A match takes 3-11 s on the runner's CPU, so
    likely 10-40 s on a phone, in its worker; untested on a phone.

## 17. The photo is not the ground: mark on the lidar, or stretch the photo to it? (owner, 2026-11-09, night)

The owner's walk of 2026-11-09 evening was the first with check marks placed on the COUNTY photo (every earlier home
walk's were on Mapbox), and some marks had to be moved to sit where the real objects are relative to each other.
HARD, the owner's finding, first made on the lawn mapper and not to be re-argued: aerial imagery is not true to the
ground; it is locally distorted (skewed, stretched), differently in each photo. "Realistically, lidar is the only
thing that objectively has a 1:1 relationship with real points in the world."

Consequences already true today:
  - Every placement measured against marks so far (SCAN-H11 to H32) was measured against a photo's frame: Mapbox's
    for the home walks before this one. A walk placed by the earlier-walk fix (section 16) inherits its reference's
    photo frame (1794089603603: Mapbox). This walk's county-photo marks are in another frame, so its scores mix the
    two photos' disagreement with the fix's own error.
  - The marks' "truth" (the marks' own fit, 0.8-1.4 ft) is a photo's truth, not the ground's.

### The idea: references and checks placed on the lidar

The owner's considerations, recorded as given (2026-11-09), each with what has been measured that bears on it:

  1. PIXELS. The lidar must be shown more precisely than it really is: a driveway not running north-south shows as a
     staircase of blocks, and people cannot place points on pixelated shapes.
     -> Known: the lot has about 1.6 returns per square metre (SCAN-H29); the shade map draws 1 m cells. SPECULATION:
        draw what the points imply, not cells: edges fitted as straight lines through many returns (pavement against
        grass by brightness, SCAN-H18; building edges by height), corners as the crossing of two fitted lines. A fitted
        line through dozens of returns is better placed than any one return; the user then snaps to a drawn corner
        rather than judging blocks.
  2. CANOPIES as thin green outlines, not blocks.
  3. ROOFS look wider than the buildings are. The owner's guess: at the overhang the edge cell is split between ground
     and roof, and the whole metre is called roof. The owner may never have seen the 0.5 m grid: the shade map rounds to 1 m
     for its view (the owner wants that view at 0.5 m: a shade-map change, asked of the features session).
     -> Known: real eaves overhang the wall (often 0.3-0.6 m), so a roof's true edge IS outside the wall; the shared
        rule's wallsOf puts walls 2 ft in from a roof's edge (the owner's number, shade findings 33). Not yet measured
        on the owner's lot: the phone's own wall points (ARCore labels building) against the lidar roof edge, on walks
        placed by marks, would give the offset directly.
  4. REFERENCES ARE ON THE GROUND. A ground point placed in front of a hot tub's corner goes at the edge of the hot
     tub's lidar cells, which can be a couple of feet from the real corner; marked in AR, the point then appears on top
     of the hot tub, and the error can double.
     -> SCAN-H30 already found the well-head check (6-8 in high) 3-5 ft off the same way on every walk. Things with
        height make poor marks on any map; on the lidar, only flat ground edges (pavement, patio, path) are safe.
  5. FEW CANDIDATES. Marks placed only where the lidar shows something are far fewer.
     -> True on an all-grass yard. Pavement edges (drive, walk, patio) are the likely candidates; the lot's driveway was
        already the best-placing feature (SCAN-H19, H20).

The owner's own conclusion: these may not be overcome.

### The alternative: stretch each photo onto the lidar

Keep marking on the photo, but warp the photo first so its ground sits on the lidar's ground everywhere, not by one
shift for the whole frame (what the shade map's alignToPhoto does today; per-mark shifts were measured by
scan/tools/checks-shade.mjs, SCAN-H29, and could not be measured to a foot on this lot). The owner asks whether a
machine-learning model registers 3DEP to aerial imagery better than our own matchers. A research question first
(2026-11-09): cross-modal dense matchers (lidar brightness and height shading against the photo) giving many local
correspondences, and a smooth warp (thin-plate spline) per lot through them.

What decides between the two: whether a stretched photo's ground lands within about a foot of the lidar's at
held-out points. Neither is built.

### Research, 2026-11-09 (a research agent; sources as it gave them, not yet checked by a run here)

What sources state:
  - Pretrained image matchers registered SAR to optical satellite pairs zero-shot (Corley, Stoken, Berton, CVPR 2026
    Image Matching Workshop, arXiv 2604.10217): RoMa (code MIT, DINOv2 backbone Apache-2) and XoFTR (Apache-2.0)
    tied best on SpaceNet9 at about 3 px mean error; XoFTR about 10 times faster.
  - MINIMA (CVPR 2025, Apache-2.0; its LightGlue variant uses SuperPoint, non-commercial only) retrains RoMa, LoFTR,
    ELoFTR, XoFTR and LightGlue on synthetic other-modality images, depth and normals among them.
  - Airborne-lidar rasters matched to aerial camera images with SuperGlue and LoFTR: intensity gave the strongest
    matches (Leahy and Jabari, Remote Sensing 17(3):357, 2025). SIFT works on lidar intensity, not on elevation.
  - No published use of RoMa, MINIMA or MatchAnything on airborne-lidar intensity against orthophotos was found.
  - MatchAnything's code now carries a registration licence (an organisation must register first): left aside.
  - Orthophoto accuracy: NAIP is specified to plus or minus 4-6 m; county 4-6 inch programmes report about 1.4-2.5 ft
    at 95% (Los Angeles County, Chatham County GA), rectified on bare-earth models so buildings lean; Mapbox's Vivid
    is specified at 2-8.5 m CE90 depending on tier. 3DEP specifies vertical accuracy only; horizontal is reported per
    project.

SPECULATION (the agent's and this session's): the error at the ground is smooth within a photo frame (orientation,
the rectifying DEM's height error times the view angle) with jumps at mosaic seams, so a smoothed thin-plate spline
per frame, piecewise where residuals jump, should fit it. Match on ground-return intensity (and ground-level edges),
never on roofs and crowns (they lean): drop matches within about 1 m of anything 0.5 m or more above the ground.
Tiles of 384-640 px with overlap; cheap matchers first on the runner's CPU (XoFTR, MINIMA-ELoFTR), RoMa where they
come back thin; outliers removed per tile; 50-300 matches a lot. A warp is kept only if it beats today's single
shift at held-out points; and once warped, the county photo, Mapbox and NAIP should agree with one another there.
The baseline to beat first: the site's own edge-by-direction matcher (public/shade/align.js) run in overlapping
windows instead of once per frame.

A test the owner's walks already allow: the same check points placed on Mapbox (the walks before 2026-11-09 evening)
and on the county photo (that walk) are the two photos' disagreement, measured by eye at real objects; after both
photos are warped to the lidar, the two placements of each point should come together.

### SCAN-H33. The photos stretched onto the lidar, first run: the edge windows are too thin to stretch anything (2026-11-10)

HARD (workflow S run 226, task warp, the owner's home map; 125,588 lidar returns, the model's shift onto a photo
0.89 m, taken off; the county photo kept with the map, 1714x688, and Mapbox for the same frame; 0.25 m cells, 42%
raised and masked out):
  - The baseline matcher (edges by direction in overlapping 24 m windows, ground only) found 30 matches on the county
    photo and 13 on Mapbox. Median shift 1.4 ft and 1.1 ft.
  - Held out (five folds), county: none 5.7 ft RMS, shift 5.7, affine 6.4, spline 7.8. Mapbox: none 6.5, shift 6.7,
    affine 8.7, spline 10.7. The matches disagree with one another by about 6 ft, and every fitted stretch predicts
    unseen matches worse than leaving the photo alone. The matcher, not the warp, is what fails here: on a synthetic
    lot with a known stretch the same code recovers it to a median 9 cm (95% 23 cm).
  - RoMa did not run: its CUDA kernel was missing ("No module named 'local_corr'"). It is now built with
    use_custom_corr=False.
  - The same 4 points on Mapbox and on the county photo, as placed: 1.9, 122.3, 2.5, 0.8 ft apart; after the
    (noise-fitted) stretches: 2.8, 123.8, 2.5, 1.3 ft. The 122 ft one is a point dragged to another spot between
    walks, not a photo's error.
  - Run 226 kept a spline it should not have. Since commit 93a3a8c a stretch is kept only when its held-out error is
    under 0.8 of none's, and an older stretched photo is taken out when no new one is kept.

Runs 227 and 229 (RoMa on the CPU, use_custom_corr=False; the same map and inputs):
  - Lidar brightness to photo: RoMa 107 matches on the county photo, 102 on Mapbox. They agree with one another
    to 0.2-0.3 ft held out (spline), yet say the photo is 373 ft and 436 ft off, and fitted to them, the edge
    windows' matches miss by 370 ft. RoMa's warp is smooth even where it is wrong, so agreement among one
    matcher's own matches proves nothing. Run 227 kept that stretch; since commit 0c8394c no stretch is kept
    whose matches' median says more than 3 m (10 ft), and run 229 kept none and took the old ones out.
  - Photo to photo (Mapbox onto the county photo, same grid): RoMa 2,542 matches, median shift 1.0 ft; held out
    none 3.6 ft RMS, shift 3.4, affine 2.6, spline 1.4 (95% 2.8). So the coordinates are read right, and RoMa
    reads photos against photos well. What it cannot read is the lidar's ground brightness as a picture.
  - Both photos disagree with each other by a smooth few feet (spline 1.4 ft held out against none 3.6): the
    owner's point that the photos are not true at the ground, measured, at least between the two photos.
  - CORRECTION: the walk these runs called "the county walk" (the newest on the map by its recorded start) was
    1794162116852, from 2026-11-08. Tonight's home walk, its checks placed on the county photo, is 1794263367156;
    the 4-point Mapbox-vs-county comparison above is between older walks and is not that test yet.

Runs 235 and 236, RoMa on the ground only (the owner's idea, 2026-11-10: "We can only match against things at
ground level. Because buildings lean... don't give the matcher anything above like 1m"): everything 0.5 m or more
up, and 2.5 m round it, blanked in both pictures; the lidar's brightness evened out (CLAHE).
  - Run 235: 3,230 matches on the county photo and 3,083 on Mapbox, median shift 0.2 ft, held out none 1.1-1.2 ft,
    spline 0.5-0.6 ft. Kept, then doubted: RoMa puts the two photos 1.0-2.2 ft apart (median shift across runs),
    which cannot hold if both sit within 0.2 ft of the lidar.
  - Run 236, the photo moved 4.9 ft on purpose: ground-only RoMa found 0.2 ft of it (county) and 0.0 ft (Mapbox).
    It matches the blanks, which sit in the same place in both pictures, not the ground. Refused; stored stretches
    taken out. The planted-shift test stays in the study for every matcher that passes the other gates.
  - So no matcher here has yet read the lidar's ground against a photo. The photos against each other: RoMa finds
    a smooth 2-D warp between them in every run (none 3.6-6.6 ft RMS held out, affine 2.5-2.8, spline 1.3-1.5).

Run 238, the planted shift between the two photos (the owner, 2026-11-10: "maybe it would be handy, just in
general, if we could stretch aerial imagery onto each other. We have an automatic fit for the lawn mapper, but it's
not very good sometimes"): Mapbox moved 4.9 ft on purpose, RoMa found 2.7 ft of it. So its photo-to-photo numbers
above (spline 1.3-1.5 ft held out) are its agreement with itself and are NOT yet a measured accuracy. A fault of
the study's own, found by this: every RoMa run so far was given the whole frame (1370 cells, 342 m) squeezed to 448
pixels, 0.76 m of ground a pixel. Since commit after 30f353c RoMa runs on one 448-cell tile (112 m) round the map's
point at the grid's own 0.25 m, and a kept field is held to its matches' box. All RoMa findings above were made on
the squeezed frame and are to be read so.

Run 239, RoMa on the 112 m tile at 0.25 m: the lidar with roofs blanked found 0.1 ft of the 4.9 ft planted move
on both photos (it matches the blanks at any size); plain RoMa on the lidar said 272 and 327 ft; photo to photo
found 8.9 ft of the 4.9 ft move, with none 10.5 ft RMS held out on the tile, roofs and trees counted. No matcher
has passed a planted move, on the lidar or between photos, as of this run.

Run 240, photo to photo with only bare-ground matches counted (nothing blanked): 794 matches, RoMa found 9.7 ft
of the 4.9 ft move. With run 239's 8.9 ft that is about DOUBLE the planted move twice running, which is not what
a failing matcher looks like: it points at the study (how the move is planted, or how RoMa's answer is read on a
tile). So the photo-to-photo result is INCONCLUSIVE, not a failure, until the study's own test is tested: the
county photo against itself, still and moved (added after run 240).

Run 241, the test tested: the county photo against itself on the tile. Still, RoMa says 0.00 ft; moved
(+1.20, -0.90) m on purpose, RoMa says (+1.19, -0.90) m, on 3,997 and 4,000 matches. So the planted move, the tile
and the reading of RoMa's answer are right to a centimetre, and RoMa measures a pure move of one photo exactly.
What fails is RoMa ACROSS the two photos at 0.25 m: for the same 4.9 ft move it has now said 8.9, 9.7 and 12.0 ft
(runs 239-241), and its bare-ground matches put Mapbox and the county photo 10.8 ft RMS apart (95% 20 ft) on the
tile, where the owner's own placements of the same spots on both photos are 0.8-2.5 ft apart. Photo to photo with
RoMa as it comes is NOT good enough at the foot level on this lot; run 240's "inconclusive" is settled against it.

SPECULATION: at 0.25 m a cell the two photos differ in what a matcher sees most (shadows, leaf, season), and RoMa
goes smoothly wrong as it did on the lidar; squeezed to 0.76 m (runs 229-238) its numbers were believable (median
1.0-2.2 ft) but it found only half a planted move. A middle size, or matches kept only where both directions
agree, or a matcher made for aerial pairs across seasons, are untried. The judge for any of them is the planted
move first, then the owner's new marks placed on both photos.

THE MARKS (the owner, 2026-11-10): the check points placed so far were not placed to be found again exactly, and
were dragged between walks. Every score made ON THE MARKS carries that error: the walk-to-walk shape fix's feet
(SCAN-H32, run 224's gates, the 1.9 and 3.0 ft above), the marks' own fits, the Mapbox-vs-county mark test. Results
that used no marks stand: RoMa on the lidar (hundreds of feet off), the planted-shift failure, photo against photo.
The owner will place a new set, at ground-level corners found again exactly, and keep it. Since commit 901d98b a
walk placed on an earlier walk is also scored aim to aim (where the crosshair hit the same spot in both walks, no
photo in it), and a set can be placed again on the other photo. The owner: errors of 1.2 ft or less are tolerable.

SPECULATION, next: the lidar has to be made to look like a photo before a photo matcher can use it. A shaded
relief of the ground plus intensity, or the shade map's own classes (roof, tree, ground, paving) drawn as a map;
or MINIMA's RoMa, which was retrained on other-modality pictures (depth among them). Or match on shapes, not
brightness: roof edges and walls from the lidar against the photo's edges, with the lean of a roof taken off.

The placement map has the switch already (2026-11-10): "Photo as traced" or "Stretched onto the lidar" (shown only
when a stretch was kept), and "Crisper", which is Lawn Mapper's own enhancement (public/lib/enhance.js) copied in
unchanged. Each point keeps which photo it was placed on (`on` in live.json's points).

## 18. The earlier walk first; why the walk of 2026-11-09 evening had none; the look; occlusion (owner, 2026-11-10)

The owner: "2nd walk fits should be fit to the previous walks above all else, the other fits should just be
fallback safeguards", and of the live fit that evening, "funny... I think some of the weirdness I observed in the
live fit was from streetview/geospatial overriding the other fits."

HARD:
  - Shapes against pictures was settled for shapes (SCAN-H32) and the shape fix went live at 21:36 UTC on
    2026-11-09 (section 16). The map's reference (walk 1794089603603) was kept at 20:35 UTC.
  - The home walk at 22:29 UTC (1794263367156) never used it: its live.json says the page had no reference. So
    the earlier walk did not place it and nothing overrode anything: with no references marked either, Street View
    alone placed the whole walk (ARCore's own accuracy 0.9 m median), and its checks read 3-6 ft and 11 ft.
  - Why the page had none is NOT known: it took any 404 for "none" for the whole session and recorded no reason.
    The worker and the file format load in a test browser. Replayed afterwards, the shape fix would have refused
    that walk anyway (landed 0.235 against the 0.30 gate; its best guess 12 ft off).

Changed (commit of 2026-11-10): the earlier walk's fix comes first of all, marked references or not
(locate.js prevFirst); the page takes only the site's own "no reference" for none, says anything else in the walk's
log and tries again up to six times, and live.json's prev carries the reason; a reference made before every point
of the map's current set is not used on that walk (a new set is a new start: that walk is placed by its own marks
and becomes the next reference). The look of the lidar in the camera: docs/SCAN-DIVERGENCES.md step 10.

OCCLUSION, read from ARCore's own guide (developers.google.com/ar/develop/java/depth/developer-guide): there is no
switch; "native occlusion" is the session's depth image (Config.DepthMode.AUTOMATIC, acquireDepthImage16Bits, to
about 65 m, the smoothed one with no holes) given to the fragment shader as a texture, each drawn pixel compared
with it and faded over a soft ramp (the guide's DepthGetVisibility). The page does the same in kind (draw.js FS_L)
but from 24 x 42 samples of the RAW depth (zero where unsure, so nothing is hidden there), four times a second,
nearest sample, a hard cut. SPECULATION: most of what looks wrong about real things hiding the lidar is that
coarseness; the smoothed depth image at its own size as a texture each frame needs the app to hand it over (a new
bridge call and APK), not yet built.

Built the same day (the owner: "I'd like that built"): the app's bridge 5 (android/, Bridge.occGrid and
DepthSnapshot.occB64) hands the page ARCore's smoothed depth picture at its own size, one byte a cell, and takes
that picture every frame, not only when there is no raw. The page asks for it about fifteen times a second and the
lidar's shader (draw.js FS_L) reads it between its four nearest cells, holes left out, and fades a fragment out from
10 cm + 3% of the distance behind the real surface to two and a half times that. Checked in a test browser: a wall
5 m off is hidden behind a real thing 3 m off, drawn before one 10 m off, and drawn where there is no depth. NOT
yet seen on a phone. With an older app the 24 x 42 samples remain, read the same new way.

Not to be confused with what places a walk: the shape fix never needed the whole picture each frame. It keeps the
walk's points one to a 10-20 cm cube, gathered from a coarse grid of each depth picture as the phone moves, and a
few thousand such cubes are what is matched. A finer grid is kept with each picture taken (key-NNNN.depth).

## 19. Points that moved by themselves; the walk's late upload; photo to photo is the way (owner, 2026-11-10)

The owner, of the home walk of 2026-11-09 evening: a check point "moved from where I placed it, by a great
distance... It could've been an accidental touch", another "2-3 feet off from where I thought I placed it"; and the
walk "uploaded more data" when the map was opened the next morning.

HARD (run 245, after the late upload): the walk's last parts arrived (its marks 4 before, 6 now; the points the
shape fix sees changed, landed 0.196 where it was 0.235). Still not placed by the earlier walk. The first aim-to-aim
reading (the same six spots aimed at in the walk of 2026-11-07 and this one, no photo in it): by the two walks' own
marks 2.5 ft median; by the shape fix 2.7 ft median (2.7, 113.6, 5.2, 2.0, 0.8, 1.8). One spot is 110 ft from itself
between the walks: a point of the same name that stood somewhere else on the map by then, as the owner saw.

The placement map had two faults that move a point unasked, both fixed 2026-11-10: a finger coming down near a point
and sliding moved the point where it meant to move the map; and a slide was 12 canvas pixels, about three screen
pixels on a phone, so a plain touch on a point nudged it (feet, zoomed out). A point is now picked up only after the
finger rests on it 280 ms, a slide is 10 screen pixels, and every move is said and logged with its distance. Whether
these moved the owner's two points is not known; nothing recorded a move before.

Also: the map's window is at least 1.25 times as tall as wide (a wide photo was a strip), and the magnifier shows the
lawn's and the lot's lines.

DIRECTION (the owner): a screen for tying the lidar to the photo by hand is "too manual" for the live site: not
built. Photo to photo is wanted, for Lawn Mapper's line-up and so a point placed in the AR is at least off the same
way on either photo. RoMa failed the planted move across the two photos (SCAN-H33); next is Lawn Mapper's own
matcher (public/lib/register.js) under the same test, and RoMa at a middle size.

## 20. Where things stand, 2026-11-10: points placed on the lidar is being tried; what to come back to if it fails

The owner, 2026-11-10: "Okay we can try placing points to lidar. Make the change non-destructively so we can switch
back if we need... currently we guess at walls, but I don't think we should if we're going this path. Save all of
your thoughts from the last handful of messages so we can pick back up in the same spot later if placing points on
lidar turns out to be a dead end."

### The chain today, and where the photo is in it

  walk 1 on the map     its marks: where the crosshair hit each spot, fitted to where that spot was placed on the
                        PHOTO (reference-build.mjs marksOf). Its points, so placed, are the map's reference.
  walk 2, live          its shapes fitted to walk 1's shapes (walkref.js shapeFix), first of all (section 18).
  the lidar in view     where the shade map put it: one shift onto the PHOTO (0.89 m on the owner's home map).
So the walk and the lidar are each lined up to the photo, never to each other, and the photo's error at the ground
(its size on the owner's lot NOT yet measured: section 19 and the note after SCAN-H33) is in both links.

### What is being tried now: points placed on the lidar (non-destructive)

The placement map has a third picture, "Lidar" (scan/lib/look.js lidarPicture), beside the photo as traced and the
stretched photo. Same frame, same point placer and zoom; each point keeps which picture it was placed on (`on`:
kept, stretched or lidar). Nothing about the photo or the points already placed is changed: switching back is the
"Photo as traced" button. A point placed on it takes the photo out of the first link (walk 1 on the map).

How it answers the owner's five difficulties of 2026-11-09 (section 17), and where it does not:
  1. Blocks nobody can place on: 0.25 m cells from the returns themselves, the ground's brightness smoothed between
     returns, the picture smoothed when zoomed. NOT done: edges fitted as straight lines with corners to snap to.
  2. Canopies: a thin green line round each crown; the ground under it stays in view.
  3. Roofs wider than buildings: a roof is drawn only where a building's returns stand over the ground, gaps
     between returns closed and the edge taken back by the same amount. NO WALLS are drawn: the laser did not see
     them. (The AR's 3D view and the match still use the shade map's wallsOf, 2 ft in from the roof's edge; not
     changed, awaiting the owner's word.)
  4. Marks on the ground beside raised things: not solved by a picture; only flat ground edges are safe marks.
  5. Few candidates: paving edges by brightness are the hope. NOT yet seen on the owner's lot at this scale: whether
     the 2018 flight's ground brightness shows the drive, walks and patio sharply enough is the first thing to look at.
Not yet seen on a phone. If no sharp ground spot can be found in the picture, this is a dead end for the reason the
owner gave on 2026-11-09 ("these may not be overcome").

### What to come back to if it is a dead end, in the order thought best on 2026-11-10

  A. THE LIDAR FITTED STRAIGHT TO WALK 1's 3D POINTS, after the walk (the owner's idea, 2026-11-10: "fit it to the
     3d points from the phone (based only on strong matches like the roofs, and pavement with other stuff, excluding
     trees, counting for weak matches"). Takes the photo out of both links. Offered, not built. What is known: the
     whole walk fitted to the lidar at once afterwards gave 2.7-3.6 ft (SCAN-H25) and small_gicp could not move off
     its start (SCAN-H31), but both were SCORED ON MARKS PLACED ON A PHOTO, so whether the lidar fit was worse than
     the photo or only disagreed with it is unknown. The hard part: the laser sees roofs and ground from above, the
     phone sees walls, eaves and ground from the side; an eave overhangs its wall by an unknown 1-2 ft and flat
     ground does not hold a walk sideways. The fair test needs no photo: fit two walks to the lidar each on its own,
     then compare where the crosshair hit the same spots (aim to aim).
  B. PHOTO TO PHOTO (wanted by the owner for Lawn Mapper's line-up, and so a point is off the same way on either
     photo). RoMa as it comes failed a planted move across Mapbox and the county photo (8.9, 9.7, 12.0 ft for
     4.9 ft; SCAN-H33) though it reads a move of one photo against itself to a centimetre. Untried: Lawn Mapper's
     own matcher (public/lib/register.js) under the same planted move; RoMa at a middle size (between 0.25 m and
     0.76 m a pixel); matches kept only where both directions agree; a matcher made for aerial pairs.
  C. PHOTO ONTO LIDAR, automatic: dead as tried (SCAN-H33: edge windows too few and 6 ft apart; RoMa on the
     lidar's brightness hundreds of feet off; with roofs blanked it matches the blanks). A hand-tied version
     (a person picks the same spots on both) was refused by the owner as "too manual" for the live site.

### The tests that stand whatever is tried

  - A PLANTED MOVE before any matcher's stretch is believed (warp_study.py; it is itself tested on a photo against
    itself, run 241).
  - AIM TO AIM for anything that places a walk (reference-build.mjs aimToAim): the same spots aimed at on two walks,
    no photo in the score. First reading, on loose marks: 2.5 ft median between the walks of 2026-11-07 and 11-09.
  - The owner's tolerance: 1.2 ft or less.

### The owner's next walks (unchanged by any of this)

At home and at work the next walk is a new first walk: "Start a new set", 3 to 5 points, all check points (no live
fix is needed on it; Street View places the view and its "by geo" readings mean nothing), at spots that can be aimed
at again exactly, never dragged. The walk after it is the test of the shape fit, scored aim to aim. With "Lidar"
chosen on the placement map the points of the new set are placed on the lidar.

## 21. Corners to place points on, from the laser's own returns (owner, 2026-11-10)

The owner, on the first lidar picture (section 20): "I was very clear about how those points from yesterday were
problems that needed solving... They don't need to just be explained away." Straight edges and corners to snap to
were asked for in section 17's point 1, and "The blurry edge is just too imprecise for human eyes". Marks beside raised
things (point 4) cannot be avoided: at home the brick patio does not show on the lidar, at work the drives are dirt
with no edges, and the marks used there were tree stumps and the corner of a ~6 ft stone wall. The deck (5-6 ft round
the pool and hot tub, an upper level ~10 ft) showed as orange zigzags.

What answers it (scan/lib/lidar-marks.js, on the placement map's "Lidar" picture):
  - A RAISED THING WITH UPRIGHT SIDES IS, FROM ABOVE, EXACTLY AS WIDE AS ITS TOP: the laser's outermost returns are its
    edge, and in the walk its corner is aimed at where it is, at any height (a mark's fit uses its place across the
    ground). Point 4's doubling came from blurry cells and a ground mark beside the thing, not from height.
  - Things: raised returns (0.3 m+ over the ground, trees' left out) that touch, or lie further apart at the same
    height (a wall's top); levels within a thing parted by a 0.8 m height step (a deck's upper floor is its own thing).
  - Each thing squared to its own grid, every side set where its own returns and the others' part along it, halfway
    across the gap, in two passes; a short side (a wall's end) looks further for ground beyond it.
  - Every corner says how sure it is: half the gap of returns its two sides were set in. Sure (a white dot) when that is
    0.3 m or less; a hollow yellow ring otherwise (a wall's end, where the laser's last hit on its top may stop short of
    it). A small thing (under 6 m2: a hot tub, a stump, a post) is also marked by its middle (a white cross).
  - Paving told apart from grass by the ground returns' brightness (Otsu's threshold, each return's side by the vote of
    its 15 nearest), outlined the same way, dashed blue; its corners are NEVER said to be sure.
  - Drawn as lines over the ground's brightness, at any zoom, in the magnifier too; a placed point snaps to a corner
    within a fingertip and keeps what it snapped to (`snap` in live.json's points).

HARD, on synthetic yards at 4 returns a square metre (scan/test/lidar-marks.test.js): a two-level deck's ten corners
0.0-0.3 ft (median 0.1); a 0.5 m stone wall's faces within 0.15 m, its ends 0.1 ft where the laser hits them and 4.4 ft
where its last hits stop short (both said unsure); a drive by brightness overlapping the grass's 0.3-1.4 ft. A whole
lot, 38,400 returns, in 2.6 s on a desktop.

HARD, on the owner's lot (scan-deploy task "marks", scan/tools/marks-check.mjs; a box of 191 x 87 m, 125,588 returns,
spacing 0.72 m). The owner's first look (435de21): the deck right, the drive short, shapes all over the woods, the deck
called a building ("Not sure if thats solvable or worth solving").
  - run 250 (b0e1985, solid things only): 0 buildings (the house left out as rough: a roof's slope read as rough), 39
    things, 14 paving slabs. 14 s.
  - run 251 (65f1c7f, roughness from the neighbours' mean; paving must stand out by 1.5 spreads from a 2 m band round
    it; slabs over 1500 m2 skipped): 3 buildings, 50 things, 5 slabs (contrast 1.5-2.2). 3 s.
  - run 252 (723a877, crowns over the ground 1-4 m round a thing: over 50% a thing, 70% a building, is the woods; a
    level, deck-sized level 1.5 m+ under a building's roof is split off): 2 buildings, 25 things, 5 slabs; 27 left out
    as in the woods (one of them a "building" of 38 returns at 3.9 m, crowns 0.93 round it); one deck split off a
    building, 52 returns at 3.4 m, against the 141 m2 building at 7.2 m (the owner's house, by the deck).
  - then, not re-run: a thing of under 6 returns is dropped, and one under 10 m2 with crowns over 30% round it (run 252
    left 15 of 1.5-4 m2 there, 60-120 m out). Of run 252's 25 things that leaves about 10.
  - The drive: the owner's look at run 252's slabs: "2 are my neighbor's grass... They actually pretty neatly outline
    the grass and don't overlap the driveway hardly at all, so you're onto something, it's just backwards... my
    driveway is concrete and the road is black top. Both show up darker than grass, blacktop shows up a little darker
    than concrete." The 474 m2 building is the neighbour's house; the owner's is the 141 m2 one, with the deck.
  - run 254 (aa85906, paving = ground darker than the lawn, in bands of brightness and below cuts, ground under crowns
    left out, contrast in a surface's own noise): 9 slabs of 9-80 m2 kept, specks; the big dark groups nearest the
    lawn (380-1230 m2, 36-46 m from the lawn's middle) failed as unpinned.
  - run 255 (388a7b5, a slab's outside is everything not it; 20 m2 or more): 6 slabs of 26-136 m2, 34-86 m from the
    lawn's middle. The dark groups 36-37 m from it (380-480 m2) still fail: straight enough in parts (held 0.9, pinned
    0.9) but 18-36 sides and strays 0.23-0.31: most likely the drive run into the road, one ragged shape. NOT solved.
    The way the owner offered for it: the aerial photo's geometry for a drive (not built).
  - The owner, on run 255's deploy: "Nothing drew that time" (a page bug: the worker did not send each thing's middle,
    and the on-the-photo test threw), and of the drive: "my driveway is pretty big, has a turnaround spot, and a large
    curved side... That would be fine if it merges with the road though, we do need to also get the road."
  - run 257 (153c9f5, candidates from every band taken best first; straight-edged slabs first, with corners; where none
    lies, a slab mostly of its own colour drawn as its traced outline, smoothed by a metre, no corners, up to 4000 m2):
    6 straight-edged slabs and 11 traced outlines, among them 1229 m2 traced 37 m from the lawn's middle (the drive
    and the road, it is thought) and 194 m2 traced 15 m from it. The owner's look decides.
  - Correction: the 474 m2 building is 7 m from the lawn's middle, the owner's house; the 141 m2 one at 7.2 m, 43 m
    out, is the neighbour's, and the "deck split off a house" (52 returns at 3.4 m) was split off the neighbour's.
NOT yet seen on a phone.

What it does not answer: a stump the 2018 flight hit once or not at all cannot be found from the lidar (about 4
returns a square metre; a 0.5 m stump is hit about once). The brick patio, if its brightness does not part from the
grass. These may need the photo for their geometry (the owner: "If we have to use the imagery to guess at the specific
geometry, that should be fine, because the skew shouldn't come into play on modestly sized driveways"): not built.


## 22. Does NAIP sit on the lidar? (owner, 2026-11-10)

The owner: "I just remembered that NAIP exists. Does naip line up neatly with 3dep? Naip isn't good enough for lawn
traces but it's definitely good enough for placing points... Naip should be newer than 3dep right? That's what
matters." NAIP's fourth band is near infrared, as the lidar's brightness is (1064 nm): grass bright, paving dark in
both, so the two are matched as they are (scan/tools/naip-check.mjs, scan-deploy task naip): the lidar's ground
picture on 0.25 m cells against each NAIP frame's band 4 over the same ground, patch by patch with
public/lib/register.js, and again with NAIP slid a planted 1.25 m east, 1.0 m south.

HARD, run 259 (c31b209), the owner's two maps (home 191 x 88 m; work 224 x 246 m). NAIP frames over both: 2022,
2020, 2018, 2016 (0.6 m), 2014, 2012 (1 m); the newest in Planetary Computer is 2022.
  - The matcher on the lidar against itself: the planted slide found to 0.00 m (556 and 1810 patches, all agree).
  - The planted slide on top of NAIP: found to 0.03-0.5 m (median about 0.1 m; worst 0.48 m and 0.33 m off, on the
    2020 frames). That is the measurement's own error, NAIP against lidar.
  - Few patches agree: 8-36 of 155-751 (5%), against 100% lidar-to-lidar. The match is real (the planted slides come
    back) but rests on a few places: most of either picture is lawn or canopy with nothing to hold.
  - Home: 2022 0.60 m east, 0.54 m south (0.8 m, 2.7 ft); 2020 2.9 m east; 2018 0.7 m (not confident); the USGS
    mosaic 0.24 m (not confident, 7 patches).
  - Work: 2022 2.0 m west, 2.3 m north (3.0 m, 10 ft); 2020 1.9 m; 2018 1.6 m; the USGS mosaic 3.8 m.
  - In every confident case one shift fits the agreeing patches to 0.16-0.20 m rms.
So NAIP does NOT sit on 3DEP to a foot: each year's flight sits differently, 0.8 to 3 m off on these two lots (inside
its 4-6 m specification). But it is off by one slide per lot, which this measures to about 0.1-0.5 m.
NOT built: NAIP as a background on the placement map, slid by its measured shift, the lidar's outlines over it.

READ, NOT MEASURED HERE (2026-11-10, the owner: "Do some research to be sure there's not some reliable way to line up
naip to 3dep perfectly every time... if it gets .1m or closer every time, I'm happy to just make naip the backbone"):
  - Published automatic aerial-photo-to-lidar-intensity registration reaches about 2 pixels, not a tenth of one: Ye et
    al. 2020 (structural features + 3D phase correlation, arXiv 2004.09811), RMSE 1.9 px on 0.2 m pictures (0.4 m),
    against 2.2 px for mutual information and 2.4 px for cross-correlation; its stated limit is "poor structure
    information". Parmehr et al. 2012 (weighted mutual information, ISPRS Annals I-7), 10 cm photo against 1 m lidar,
    right in 90% of 200 m tiles, the failures on flat ground with little to hold. The field's stated goal is 1 pixel.
  - NAIP here is 0.6 m pixels and the lidar 0.72 m between returns: 0.1 m is a sixth of a pixel of either. NAIP's
    specification is 6 m at 95%; FSA's own checks against surveyed control found 3.2 m RMSE (Arizona 2007), and a
    Minnesota report puts 80% of its error in the elevation model it was draped on, so it varies within a frame.
  - So no known method gives 0.1 m every time; run 259's 0.1-0.5 m by one slide is at the level of the published best.

## 23. The owner's plan, step by step: NAIP as its own view; the lidar's ground alone, hard-edged (2026-11-11)

The owner directs the steps. Step 0: NAIP selectable as a background, as delivered, NOT combined with the lidar
("seperate views"). Step 1: "The automatic shapes aren't working... improve the viewability of the lidar. Split it by
heights... ground level (regardless of where the ground is, so we have to follow hills). For now, just hide anything
above ground level... preserve the hard edges... We don't need detail, we need precision", on a grid four times the
lidar's, an edge put through the middling return of three, then each side given back some of its own shade away
from the middle. The test: the width of the straight run of the owner's drive, known by tape measure.

Built: scan/lib/ground-picture.js (groundPicture, stripWidth), the "Lidar ground" and "NAIP" buttons on the placement
map, scan-deploy task drive (scan/tools/drive-width.mjs).

HARD:
  - Made-up lots at the owner's density (a return every 0.72 m), noise a seventh of the grass-to-concrete step: a
    3.66 m drive read 3.64 m on average over 8 lots (3.43 to 3.91; worst 0.25 m off); 2.7 m read 2.66; 5.0 m read 5.12.
  - The owner's lot, run 260 (cd4a8f1): picture 1037 x 474 cells of 0.184 m; levels light 46321, dark 25389, a
    surface's own noise 707; 44% of the picture dark, 8% no ground. The longest straight dark run of one width inside
    the lot: 10.1 m long, 17 cross-sections, median 3.86 m (12 ft 8 in), the middle half 3.75-4.03 m.
NOT known: that the run measured is the drive (the log holds no place; 44% dark says the woods' floor reads dark too),
and the true width (the owner's tape measure).

THE OWNER'S WAY (2026-11-11: "Please ask before directly contradicting plans I've laid out. Try it my way"). The
median of the 7 nearest and the speck removal were the core session's additions, made without asking: now options,
off by default (3747af1). RULE: a change to a method the owner laid out is asked for first, not made and reported.
  - Made-up lots, the owner's way: a 3.66 m drive read 3.71 m on average over 8 lots, worst 0.16 m off (with the
    additions 3.64 m, worst 0.25 m); 2.7 m read 2.68; 5.0 m read 4.85.
  - The owner's lot, run 262: a return's own noise 6556 against levels 47001 and 24197; 46% dark. The longest
    straight dark run of one width inside the lot: 13.8 m long, 22 cross-sections, median 6.45 m (21 ft 2 in), the
    middle half 6.39-6.61 m. Run 260, with the additions, found a different run: 10.1 m long, 3.86 m wide.
  - So the two readings are of two different strips, and which (if either) is the drive is NOT known: the strip
    finder (the longest straight run), not the picture, chose them, and the log holds no place.

## 24. The hard-edged ground picture failed; three options; roof corners first (owner, 2026-11-11)

The owner, on section 23's picture: "My approach was better, but neither produced any sort of usable edge, the edges
are far too noisy, so neither of your measurements are really relevant, because there are no parallel sides. So,
okay, my plan is dead in the water." And the two problems as the owner states them: "it's too difficult for a human to
pick out a spot for references by looking at lidar. Period. Unsolvable. But the imagery doesn't fit to lidar."
The owner's three options, ranked by both: 2 first, then 1 where roofs do not reach, 3 for what is left.

OPTION 1, KEPT FOR LATER ("save your notes on option 1 and we'll come back to it if we have to"). We pick, or help
pick, the references by (a) recognisability (corners, edges by landmarks; or "pick any spot on this edge") and (b) how
well the photo is known to fit the lidar at that spot; each point then carries a margin of error from that, the fit
trusting a front-yard point tightly and a back-yard one loosely. Notes (SPECULATION, nothing built or measured):
  - The confidence signal exists: public/lib/register.js matches the photo to the lidar's ground picture patch by
    patch (section 22). An agreeing patch says the photo fits there AND how far it is off there (to about 0.2 m), so
    no whole-picture fit is needed: a point in an agreeing patch takes that patch's own correction and a tight
    margin; a point far from any takes a wide one.
  - On the owner's two lots only about 5% of patches agreed (NAIP against lidar), mostly drive and road; a back yard
    may have none. Not measured for the county photo or Mapbox against the lidar by this method.
  - Choosing "recognisable" features automatically is the least sure part.
  - The owner's two notes: (1) "preferably this option would show the points on county photos or mapbox... Naip is
    pretty sparse for visual details"; (2) "if naip has to be used, then the user should pick the point... they freely
    place points and we weight those points with the known level of certainty by location, and require more points
    if the total level of certainty is too low".

OPTION 2, BEING BUILT: 2-4 ROOF CORNERS AS THE REFERENCES ("Not walls, roof corners"). The photo leaves the problem:
the corner's place is the lidar's own. The owner's requirements:
  - marked by aiming UP at the corner itself ("straight down guess could be quite inaccurate, and vary unpredictably
    between users");
  - the user picks the corners, or is shown them, on the map the lawn was traced on;
  - a limit on how high above the ground a chosen corner may be;
  - a prescribed, checked procedure in AR, each step confirming its data, the mark made automatically when the corner
    is read steadily and agrees with what it realistically should be; as few steps as possible, no long waits
    ("Patience is a limited resource");
  - corners within 15 ft of a lawn edge when there is one.
OPTION 3: give up on perfect; minimise the error and say how large it may be.

OPTION 2 BUILT (2fd1ae8; scan/lib/roof-corner.js, scan/test/roof-corner.test.js). The rules chosen where the owner
left them open ("prescribe what you think is necessary and sensible"): eave 15 ft (4.6 m) or less; an outward corner
of a building's squared outline with both edges 2.5 m or more; within 15 ft of a lawn edge. The marking uses SIGHT
LINES, not depth: aim up at the corner and hold 0.7 s (taken by itself), step sideways until seen from 25 degrees
round, aim and hold again; the lines must pass within 15 cm and cross within 0.8 m of the lidar's eave height; else
one more aim, up to four. Why not depth: it is weakest at a thin roof edge against the sky.
HARD:
  - Made-up walks: a corner marked 0.1 in off with a 0.15 degree tremor, 0.1-0.4 in with 0.5 degrees, in 6 s; an aim
    at the next corner along, or at a roof 3 m higher, is never marked. A person's steady aiming error (not tremor) is
    NOT in these: a degree at 6 m is 10 cm.
  - The owner's lot (run 264): 2 corners offered, both on the 474 m2 building: its north-east (eave 3.43 m, 3.7 m from
    the lawn, edges 13.5 and 3.9 m, sure) and its south (eave 4.53 m, at the lawn, edges 4.4 and 5.9 m, not sure).
    Before the eave and lawn rules only 5 corners qualify on both buildings (the outline's other corners have an edge
    under 2.5 m); the house's north-west is out by its eave, 4.66 m against 4.6.
NOT known: anything about it on a phone. No walk has used it.

A FIRST WALK KEEPS ITSELF AS THE REFERENCE; SAVED OR FRESH AT THE START (owner, 2026-11-11; eb36462). For a day of
return visits to the same stops. Agreed with the owner before building:
  - corners in tiers: the original rules (15 ft up, 15 ft from the lawn); with fewer than three, corners up to 18 ft up
    and 30 ft from the lawn follow (tier 2); with only two, they are used with a check;
  - the only gate on an unseen reference (walkref.js referenceFit): two roof corners the same distance apart as marked
    as on the lidar, within 1 ft; or three or more marks each within 1 ft of its place after the best fit; and the
    marks 10 ft or more apart. Roof corners alone are used when two or more are marked;
  - "Fresh" replaces the saved walk once the new one passes; the replaced one is kept under refs/backup/.
Built in the page: the phone keeps the standing and ground points on every walk; at the end it builds the reference
and sends it (three tries), and the walk's card says "Saved as this map's reference" or why not. A chosen saved walk
is used even when the map's points are newer than it (the "stale" rule gives way to the owner's choice).
NOT known: any of it on a phone. The roof marking and this have never run on a real walk.

## 25. The first walk with roof corners and admin saves: what the owner found (2026-11-11) -- NOTES, NOTHING BUILT YET

The owner walked a lot with the roof-corner marking and the automatic reference. To pick up "tomorrow or this
weekend". Each line is the owner's, then what is known or guessed about it (guesses are marked).

 1. THE MINI MAP COVERS THE PROMPTS AND THE TOP BOX. Owner's fix: shorten the top box ("trimming wordiness and info
    that isn't doing much"); bring the prompts to the top layer, above the mini map. (A screenshot was mentioned;
    it did not reach the session.)
 2. IT STILL NEEDED A TAP ON MARK TO MOVE ON TO THE NEXT REFERENCE. The automatic start of the next unmarked roof
    corner (autoSight, 7ba75b3) did not happen on the phone. Not diagnosed.
 3. LOOKING AT A CORNER ALREADY SCANNED RUNS THE RESCAN PROMPTS. It should say "move on to next prompt X feet to
    the Y direction" -- a distance and a direction to the next unmarked corner.
 4. REMOVE THE MARK BUTTON ENTIRELY; a small red "Start over" button in its place.
 5. OCCLUSION IS TOO AGGRESSIVE. The AR walls sat almost exactly on the real walls, so a couple of inches of ARCore
    drift hid them. (Guess: a tolerance, so the depth test hides a wall only when the real surface is clearly in
    front of it, by more than the drift -- the size to be asked or measured.)
 6. SLOW TO OPEN THE FIRST TIME, with no sign anything was loading. (Guess: the lidar model and the page's
    modules downloading; a progress line is the least of it.)
 7. LAGGY AND JITTERY: shapes sway, take a while to render, and the render distance is short. "Just needs some
    optimization... Not sure on the specifics." Not profiled.
 8. LESS DATA BOTH WAYS, FOR SPEED. The first walk's upload was too slow to finish before dark, so the shape
    matching against a saved walk was never tried. What is uploaded and how big is not measured here yet; that
    measurement comes first.

Order is not decided. 2, 3 and 4 are one piece of work (the marking flow without a button); 1 is small; 5 needs a
number; 6-8 need measuring before changing.

WHAT THE OWNER'S SCREENSHOT OF THAT WALK SHOWS (2026-11-12; read from the picture, nothing run):
  - The top box is five lines and the mini map sits over its right half and its last line.
  - The marks in use were R1-R3 with "aim where it meets the ground, within 10 ft, tap Mark" and the button read
    "Mark R3 again": the ORDINARY ground references, not roof corners. The automatic sighting only starts for a
    roof-corner target, so on this walk a tap was needed by design. Whether the lot offered no roof corners, or
    they were not picked as the references, is not known -- it decides what item 2 actually is.
  - "Upload: sending 131 parts (4.3 MB)". So the upload is small in bytes and large in number of requests; a guess,
    not measured: the slowness is the 131 separate sends on a phone connection, not the size.
  - AR walls (orange) are drawn over a real block wall and cut off raggedly where the depth test hid them (item 5).

THE OWNER, AFTER THE SCREENSHOT (2026-11-12):
  - The three references were ONE roof diamond and TWO orange corners.
  - R1 is not on a corner: on the map it sits 1-2 ft from one. "I feel like i couldn't have tapped that close to
    a corner without snapping to it... And I know I didn't drag it." The corner it should be on belongs to an
    orange object, an outbuilding (a decent-sized garage with a regular roof). NOT DIAGNOSED: how a reference
    lands near a corner and not on it (the snap's reach, a tap taken as free placement, or a move after).
  - That garage is drawn as an orange object, not a building; and the house just north of it has NO square on it,
    black or orange. Two faults in the marks, not in the walk: a roofed building classed as an object (so no roof
    diamonds on it), and a house missed whole. To be looked at on that map's own points (an admin save).
  - OCCLUSION, DECIDED: "a decently big offset... Maybe 2 feet. So only hide the ar if it sits 2 feet beyond the
    actual depth."
  - ANALYTICS, ASKED: "should we set up some sort of in-house analytics so we can measure the lag/jitter/load
    times/etc." The phone is a Galaxy S21 Ultra, 8 GB. The session's answer: yes (below); not built.

BUILT 2026-11-12, from section 25 (the rest of it is still notes):
  - THE STOPWATCH (scan/lib/perf.js, tests scan/test/perf.test.js; the owner: "yes build it but I want you to be
    able to read the data"). Every walk's summary now carries `perf`: the opening's stages in seconds (map opened,
    lidar read, earlier walk read, AR asked, first frame, lidar shapes drawn); what was downloaded by group (files,
    KB, how many from the phone's cache, time, the slowest); frames (a second, the gap between frames median / 95%
    / 99% / worst, the share over 50 ms, stalls over 250 ms, the page's own work a frame and its share of the
    walk); jitter (how far the camera's place moves a frame while the phone is held still, and jumps over 5 cm in
    one frame); waits (AR asked to first frame, the lidar's shapes built); the upload (sends, taken / to try again
    / refused, KB, a send's median / 95% / worst, seconds inside sends and from the first part kept to the last
    gone, KB a second); the phone (cores, GB, connection, page memory). Times, sizes and counts only; a request
    is counted under a group's name, never its URL. WHERE TO READ IT: the walk's card on the phone ("Speed"), and
    workflow "S. Yard AR tool", task `walks`, whose log prints seven "speed" lines a walk -- that is how a session
    reads it. The summary is posted at the walk's end and again when the last part has gone, so the upload's
    numbers are whole. NOT COVERED: a walk closed before it ends posts nothing; the delay between ARCore's camera
    picture and the page's drawing over it (a likely part of "sway") cannot be seen from the page.
  - OCCLUSION, TWO FEET (scan/lib/draw.js OCC_SLACK_M 0.61): a drawn surface is hidden only when it sits 2 ft (plus
    3% of the distance) behind what the phone's depth sees, gone 25 cm further. It was 10 cm. Not seen on a phone.

THE GARAGE AND THE HOUSE ON THE OWNER'S WORK LOT, LOOKED AT (2026-11-12; task `marks` on that walk's map, runs
43156173646 before and 43156467880 after; numbers only):
  - THE GARAGE WAS AN OBJECT BY THIS SITE'S OWN RULE, MENDED. ~54 m2, 94% of its returns the shade map's roof, its
    middle return 3.3 m up: under the 3.5 m line lidar-marks.js drew to keep decks out. Now, under 3.5 m, a roof
    counts when its heights span a pitch (0.6 m over the middle 80% of its returns; this one 1.2 m) and its middle
    return is 2.2 m or more up; a level deck stays a thing (test: "low garage"). After: a building, three outward
    corners with eaves 2.8 m, one sure. NOT offered as roof corners on this map: three nearer the lawn already fill
    the first tier (within 15 ft of the lawn, eave under 15 ft). Whether a corner that is not "offered" can still
    be tapped as a roof corner is not checked.
  - THE HOUSE IS A TREE TO THE SHADE MAP. One solid group among the returns structures.js calls trees: ~123 m2,
    middle return 6 m up, roughness 0.32 m, the laser through on 11% (the real crowns there: roughness 1.1-2.7 m).
    The marks leave a tree's returns out before anything is grouped, so nothing is drawn. Not worked round here
    (CLAUDE.md: the AR never hides a shade-map fault); sent to the features session 2026-11-12. That it is the
    house the owner means is inferred from its size and height, not seen.
  - R1 OFF ITS CORNER: not diagnosed. A lead: snapped() only snaps on the lidar view (st.photoChoice === 'lidar');
    a point placed on the photo, NAIP or ground view lands where the finger did.
  - From that walk's own record: R2 (the roof diamond) marked itself, 2 aims 43 degrees apart, 0.04 m off the
    lidar's eave; R1 and R3 were ground references; no lidar fix was asked for all walk (0 asks); ARCore moved its
    own anchors a median 0.35 m, most 0.99 m.

THE HOUSE, AFTER BOTH MENDS (2026-11-12; task `marks`, runs 43164592655 and 43164903441):
  - The shade map's roofUnderCrown (build 2, the features session) made the house's columns buildings; the admin
    save's model was rebuilt by the server (admin-saves.js now rebuilds a finished save when SHADE_BUILD goes up).
    With that alone the house was a 2506-return group left out as "not solid" (2.17 m rough): the crown's branches
    are in the building's columns.
  - With the marks reading a building column by its roof (ROOF_OVER_M, SCAN-DIVERGENCES 11): a NEW BUILDING, ~333
    m2, its middle return 5.2 m up, heights spanning 3.9 m, 96% roof by the shade map. The other buildings are as
    they were (~154, ~128, ~53 the garage, ~33 m2). Not seen on a phone or in a picture: that this is the house is
    its size, its height and that it appeared when the roof under the crown did.
  - The ~121 m2 solid patch still called a tree is unchanged, same why codes: it was never the house.
  - 2026-11-12, later: the shade map's build 3 (the features session) gives every building a `roof` height in the
    model (the house: ~5.6 m, under a crown 15-19 m up); scan/lib/lidar-load.js draws a building to `roof` where
    given, `top` elsewhere. Live with their deploy (run 43168496396). The ~121 m2 patch is a stand of evergreens
    west of the house (they looked at the photo): a tree, closed. None of it seen on a phone.
