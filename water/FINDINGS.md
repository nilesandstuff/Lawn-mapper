# What we know about water on a lawn

**The water tool's memory (water session).** Read it before changing a
threshold or interpreting a result, and add to it after every measurement.

Same rules as docs/DETECTOR-FINDINGS.md, which this file copies the form of:

- **HARD FINDING** — measured here (with how to repeat it), or measured by
  the core session and said so, or cited with a link.
- **SPECULATION** — a theory that fits and has not been tested. It may be
  worth acting on. It is not worth asserting.
- **THE PLAN** — what the owner decided. A decision, not a result.
- **THE BAR** — what a step must reach, written down BEFORE it is measured.

Every finding carries its date and what it was measured on. Addresses never
go in this file (or anywhere in the repository): lots are named by a label.

---

## Where things stand

*Kept current so a fresh session can pick up without the conversation.*

- **THE WATERING PLAN (owner's vision, VISION.md, 2026-10-18) is live on the
  admin-only site**: soil survey + ten years of weather + the daily water
  balance per square metre -> zones, how much and how often each month, this
  week's next watering, ground left too wet or dry; downspouts, gutters and
  the 4 in topsoil choice saved with the map; shade from the shade map's own
  light worker; the hillside reading (S10). H16, S8-S10; sources in
  PARAMS-SOURCES.md. Root zone 12 in, cool/warm season (owner). Paving
  heat as an estimate (S8). SAM 3 on Replicate scored for paving and
  lost to the free lidar + photo (H18); so did IGNF's FLAIR, with or without
  lidar height (H19). Overture's buildings (with roofs both lidar finders
  agree on) and its road and sidewalk bands are on top since 2026-10-19 (H20).
- **Step 1, the low-spot map, works offline** (2026-10-16): water/lib/ reads
  a lot's lidar from the public octrees, builds a 1 m ground surface, finds
  roofs, fills low spots, traces runoff and measures the ground beside each
  building, in 2-5 s a lot. `node water/tools/lowspots.mjs` with WATER_LOTS;
  workflow "Water" runs it and the tests.
- **Over the 104-map corpus (H9)** it runs on 98, and reports a low spot on
  59% of lawns -- many of them far too deep to be lawn hollows (S5).
- **Sorting spots by kind (H10)**: from the points alone, only 2 of 11
  "hollows" in a blind photo check were on open ground (the rest pavement,
  roofs, trees). So only hollows on a saved map's traced lawn count as lawn
  problems; trees are sorted out well (4 of 5).
- **Paving and roofs (H12)**: paving is judged from the laser's brightness
  calibrated on the map's own traced lawn (AUC 0.90 against the Chesapeake
  land use on squares it was not fitted on); roofs are found 85%, 80%
  precise. The map shows the lot's cover and runoff weighted by surface.
- **Roofs (H13)**: the water map's finder OR the shade map's: 91% of roof
  found (98% within 1 m), 77% precise (86% within 1 m).
- **The site is admin only** until it ships (owner, 2026-10-16), and the
  dashboard card is asked of the core session.
- **What it can see is now measured on made-up ground (H8), not yet on real
  wet spots.** Roughly: a spot holding 5 cm or more of water, 8 m or more
  across, is found most of the time; anything 3 m across, or holding under
  3 cm, is not. The field check (THE BAR below) has not happened.
- **The site is live** (2026-10-16, 4:05 PM EDT): water.<home domain>. An
  address (or "where I am") -> the county's property line -> the lidar,
  read in the browser -> the low-spot map over the photo. Finding the
  property is the shade map's way, through the water Worker, which asks
  Lawn Mapper's public routes server-side (they answer only Lawn Mapper's
  origin in a browser). Nothing is saved. Reading a signed-in visitor's
  saved Lawn Mapper maps (lawn outlines included) needs Lawn Mapper to let
  this site ask for them: not built, to be asked of the core session.
- **The owner's spreader barometer (H15)** follows a yard's overall slope
  (r 0.89-0.97) but is off by 19-50 cm even on flat ground, so it cannot
  check centimetre hollows.
- **Waiting on:** the first real rain, for the field check.

---

## THE PLAN (owner, 2026-10-15; relayed by the core session 2026-10-16)

Model how rain and irrigation behave on one lawn, so a person can tune their
watering and see problems worth fixing. "I don't want to do it if it can't
work well, and it has to be nearly free." Each step passes a bar written
down before it is measured, or the work stops and says so.

1. Low-spot map (lidar ground -> surface -> filled depressions, flow, grade
   beside the house), checked against the owner's GPS photos of standing
   water after a real rain.
2. A watering schedule per zone: a daily water balance, calibrated by a
   can-and-ruler soak test, checked against a soil moisture meter.
3. Recommendations, only for what 1 and 2 have proven, worded "likely" until
   a soak test confirms them.

## THE BAR for step 1 (owner's suggestion, written 2026-10-16, before any field data)

- At least **7 of 10 real wet spots found**, and at least **7 of 10 reported
  spots really wet**, over the lots the owner checks after the next real rain.
- "Found" means a reported spot whose wet area comes within **5 m** of the
  photo's GPS position (a phone's fix is good to 3-5 m under open sky).
  "Really wet" means standing water or ground that squishes underfoot inside
  or within 5 m of the reported spot.
- Only spots on the lot count, and only spots the map can be asked about:
  the photo has to be on open ground the lidar saw (not under a deck, not
  where the house has been extended since the flight).
- Fixed before the check: the kernel (0.8 m), MIN_DEPTH 3 cm, MIN_AREA 4 m^2,
  and the noise floor rule (lib/lowspots.js). If the check fails, say so;
  re-tuning on the same photos and re-scoring them is not a pass.

---

## HARD FINDINGS

### H1. Lidar ground density and scatter (core session, 2026-10-15/16)

USGS 3DEP, the same Entwine octrees the shade map reads; ground is class 2.
On 11 corpus lots: **1-9 ground points per m^2**. The points within each 1 m
cell scatter **1.2-3.5 cm** (median standard deviation). So a low spot needs
to be at least ~2 m across and 3-5 cm deep to tell from noise. Swath seams
could be checked on only one flight (a **2 cm step**), because Entwine keeps
a single point_source_id on most clouds. The lidar is as old as its flight;
regrading since then is invisible.

### H2. The soil survey over the corpus (core session, 2026-10-15/16)

USDA Soil Data Access (https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest,
SQL with SDA_Get_Mukey_from_intersection_with_WktWgs84). Of the 104 locked
corpus lots (tools/locked-lawns.json): **103 have a named soil with a
drainage class**; 24 are "Urban land-X complexes" with a named soil listed;
1 is Urban land only. Drainage class of the top component: **51 well, 21
moderately well, 15 poorly, 8 somewhat poorly, 4 somewhat excessively, 2
very poorly, 2 excessively drained.** **53 have a water-table depth**
(muaggatt.wtdepannmin). The top horizon carries ksat_r (um/s), awc_r, sand
and clay. CAVEAT: the survey maps the native soil; a lawn is usually graded
fill and compacted topsoil, so infiltration can be far below the survey's
ksat.

### H3. Groundwater wells (core session, 2026-10-15/16)

USGS NWIS lists **zero active groundwater wells** over roughly Holland to
Ionia. The practical substitute is the soil survey's water-table depth.

### H4. Weather and storms (core session, 2026-10-15/16)

NASA POWER daily, no key: PRECTOTCORR, T2M, RH2M, WS2M, ALLSKY_SFC_SW_DWN,
EVPTRNS -- enough for FAO-56 reference ET. NWS has the forecast. POWER's
rain is a coarse grid that misses local storms; until Turf Tools answers
(https://claude.ai/artifact/QDLx1YVwoysn1XysfGt3rS), a user enters their own
gauge or controller totals. NOAA Atlas 14 storm sizes answer with no key,
e.g. https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py?lat=..&lon=..&type=pf&data=intensity&units=english&series=pds

### H5. Shade (core session, 2026-10-16)

The shade map's per-cell light is readable from the live site (its public
/api/shade/* routes and modules under /shade/). Shaded turf uses less water.

### H6. The first three West Michigan points (water session, 2026-10-16)

Three development points (a Hudsonville-area street, a Wyoming-area street,
central Grandville; coordinates not kept), each a 50 m lot plus 40 m round
it, read by water/tools/lowspots.mjs:

| flight (octree)                       | flown (laser clock) | ground pts/m^2 over open ground | scatter* | noise floor |
|---------------------------------------|---------------------|-----|--------|--------|
| USGS_LPC_MI_31Co_Ottawa_2016_LAS_2019 | 2017-11-26          | 2.90 | 3.6 cm | 4.4 cm |
| USGS_LPC_MI_31Co_Kent_2016_LAS_2019   | 2017-11-26          | 3.38 | 3.0 cm | 3.3 cm |
| USGS_LPC_MI_31Co_Kent_2016_LAS_2019   | 2017-11-27          | 1.70 | 3.5 cm | 4.3 cm |

\* median standard deviation of the ground points within 2 m of each cell
(lib/surface.js `sd`). This includes the ground's own slope and texture
across those 4 m, so it reads higher than H1's within-1 m-cell figure.

- **Neither octree classes buildings.** All three boxes held classes 1, 2
  and 7 only (e.g. 16,863 ground, 9,498 unclassified, 6 noise in the first
  Kent box; 42,568 / 54,666 / 18 in the Ottawa one). Roofs are
  found from the points instead (lib/surface.js): no ground, 2 m+ up,
  80%+ single returns. Looked right on all three maps by eye; not measured.
- **Both flights are late November**, leaves off: ground under deciduous
  trees is seen. (USGS's own dates for these work units run Nov 2017 - May
  2018, and the datum correction uses that window's middle.)
- Each lot took 2-5 s on one CPU, the network included.

### H7. Noise alone digs low spots several error bars deep (water session, 2026-10-16)

On flat made-up ground (1.2 ground pts/m^2, 2 cm scatter, 80 m square), the
filled surface showed spurious spots 2.3-2.8 cm deep whose own error bars
(the bottom's and the rim's standard errors combined) were 1.2-1.8 cm.
Filling picks the lowest bottom and the highest spill path the noise offers,
so "depth over its error bar" is not a test: a 3-sigma rule passed noise.
Replaced by a noise floor measured per flight (lib/lowspots.js noiseFloor):
eight runs of flat ground with the lot's own density and scatter; a real spot
must be deeper than the deepest spot noise dug in any of them.

### H8. What the map can find, on made-up ground (water session, 2026-10-16)

`SEEDS=10 node water/tools/limits.mjs`. Smooth dishes 3-12 m across and
3-12 cm deep, on flat ground and ground falling 0.5% and 1%, alone in a 50 m
lot, 10 noise seeds each; binned by the water each dish REALLY holds (a dish
on a slope spills on its low side). Share of dishes reported, with the
number of trials:

    1.2 ground pts/m^2, 2.5 cm scatter: noise floor 4.2 cm, 0.017 false spots per lot
      water held      3 m      5 m      8 m     12 m across
      2.0-3.0 cm   0% (20)  0% (20)  0% (10)  0% (30)
      3.0-4.5 cm   0% (20)  0% (10)  0% (20)     -
      4.5-6.5 cm   0% (20) 10% (20) 65% (20) 85% (20)
      6.5-9.0 cm   5% (20) 40% (20) 95% (20) 85% (20)
      9.0-20 cm   23% (30) 70% (30)100% (20)100% (20)

    1.2 ground pts/m^2, 3.5 cm scatter: noise floor 5.9 cm, 0.017 false spots per lot
      2.0-3.0 cm   0% (20)  0% (20)  0% (10)  0% (30)
      3.0-4.5 cm   0% (20)  0% (10)  0% (20)     -
      4.5-6.5 cm   0% (20)  0% (20) 15% (20) 35% (20)
      6.5-9.0 cm   0% (20)  5% (20) 55% (20) 50% (20)
      9.0-20 cm    7% (30) 37% (30) 90% (20)100% (20)

    3 ground pts/m^2, 2.5 cm scatter: noise floor 2.1 cm, 0.000 false spots per lot
      2.0-3.0 cm   0% (20)  0% (20)  0% (10) 20% (30)
      3.0-4.5 cm   0% (20)  0% (10) 20% (20)     -
      4.5-6.5 cm   0% (20) 35% (20)100% (20)100% (20)
      6.5-9.0 cm  15% (20) 70% (20)100% (20)100% (20)
      9.0-20 cm   40% (30) 97% (30)100% (20)100% (20)

    3 ground pts/m^2, 3.5 cm scatter: noise floor 3.0 cm, 0.015 false spots per lot
      2.0-3.0 cm   0% (20)  0% (20) 20% (10) 47% (30)
      3.0-4.5 cm   0% (20) 10% (10) 35% (20)     -
      4.5-6.5 cm  10% (20) 40% (20)100% (20)100% (20)
      6.5-9.0 cm  20% (20) 80% (20)100% (20)100% (20)
      9.0-20 cm   37% (30) 97% (30)100% (20)100% (20)

Read plainly: **on these flights a spot 3 m across is nearly invisible, a
spot 5 m across is a coin toss unless it holds 7 cm or more, and a spot 8 m
or more across holding 5 cm or more is found most of the time.** Noise
alone makes under 2 false spots per 100 lots. The reported depth runs
shallow -- smoothing takes 1-3 cm off -- so a reported depth is a "at least".

Also measured and NOT adopted: a narrower kernel for denser flights (sigma
down to 0.5 m at 3 pts/m^2). At 2.5 cm scatter it helped (5 m spots holding
4.5-6.5 cm: 35% -> 50%); at 3.5 cm, which is what the real lots show (H6),
it hurt (the same row: 40% -> 10%; 5 m, 6.5-9 cm: 80% -> 45%), because the
noise floor rose faster than the spots got deeper.

These are made-up dishes in Gaussian noise. Real ground has texture, swath
seams (H1: a 2 cm step), and things that are not ground at all; real
detection will be lower and false spots higher. H8 is the ceiling, not the
forecast.

### H9. The low-spot map over the locked corpus (water session, 2026-10-16)

Workflow "W. Water tool", task corpus, run 38962100110 (4:28 PM EDT): the
locked set, 104 maps (fingerprint 131u7jm), each its property line plus
30 m, the lidar picked by the shade map's own lidarAt. Maps are numbered,
never named.

- **Ran on 98 of 104**; 6 have no public lidar on AWS. 49 different
  flights in 23 states; **only 13 maps are in West Michigan** (Kent 2016 x9,
  Ottawa 2016 x4). The corpus is a national sample, not the owner's area.
- Ground points per m^2 over open ground: **median 3.2** (10th-90th 1.5-9.0).
  Scatter (H6's measure): **median 4.4 cm**, worst 11.5 cm. Noise floor:
  **median 3.4 cm** (10th-90th 1.6-6.7 cm); 4 lots over 10 cm, where the
  map can see almost nothing.
- **58 of 98 lawns (59%) carry at least one reported low spot**: 133 spots
  on lawns, 205 on the lots. Where there is one, it covers a median 4% of
  the lawn.
- **Many are deep**: the deepest spot on a lawn is over 25 cm on at least 28
  lawns (counted from #18-#104 of the log), up to 104 cm. A lawn hollow does not hold a meter of water; these
  are almost certainly built or wet features -- ponds, ditches and swales,
  in-ground pools, window wells, a creek -- or ground the flight misread.
  S5 below. **Not yet separated from real lawn hollows.**
- Beside the house (91 lots with a roof on the lot): ground falls toward the
  house along a median **8%** of the outline; **10 lots** have a quarter or
  more falling toward it; a median **22%** of the outline meets the code's
  5% fall. See S6 before reading that last number as a fact about houses.
- 1.7 s a lot (median) on GitHub's runner.

Lawn Mapper's zone answered **403 to every request from GitHub's runner**
(the first corpus run, 38958512969: 0 of 104), so the workflow tools pick
the lidar by importing worker/src/shade.js's lidarAt instead of asking
/api/shade/lidar. The water Worker (on Cloudflare) is not refused.

### H10. Telling a lawn hollow from everything else (water session, 2026-10-16)

water/lib/kinds.js sorts each reported spot by what the points say about
it: water (few returns, or class 9), trees (canopy over it), paved (under
0.45 of the open ground's returns, or dark ground returns), ditch (long and
narrow), built (deep against a wall), deep (over 25 cm), else hollow.

**Development set**: 12 squares of 200 m round Grand Rapids, 247 reported
spots; 34 photographed and looked at. Of the spots first called water,
only 1 of 8 was water (a pond); the rest were roads and driveways. Of those
called hollow, most were in woods or under conifers. The trees and paved
rules were added and the water ratio lowered from 0.35 to 0.15, LOOKING AT
THESE 34, so they score nothing.

**Blind test**: 12 other squares in the owner's work area (Rockford, Byron
Center, Caledonia, Jenison, Walker, Wayland, Kentwood, Wyoming, Comstock
Park, Ada, Allendale, Hudsonville; 209 spots: 82 hollow, 80 trees, 21 ditch,
18 paved, 8 deep). 30 photographed, unlabelled; what each showed was written
down BEFORE the rules' answers were revealed:

| rules said | n  | right | what the photos showed instead |
|------------|----|-------|--------------------------------|
| hollow     | 11 | **2** | pavement 4, roofs the roof-finder missed 2, a tree, a gap between buildings |
| trees      | 5  | **4** | a roof |
| paved      | 5  | **2** | open ground, trees 2 |
| ditch      | 5  | 0 of 5 truly ditches | open ground 3, trees, pavement |
| deep       | 4  | --    | 3 on open ground (a field basin, a dirt arena, a dark patch), a roof |

So **the points alone cannot tell a lawn hollow from pavement or a roof**:
2 of 11 "hollows" were on open ground. The **trees** rule works (4 of 5).
**Roofs are missed** often enough to matter (4 of 30 photos were on a
roof): the roof-finder's rule (no ground, 2 m up, 80% single returns) lets
some roofs through.

What follows, and is built: a spot counts as a lawn problem only when it is
a hollow AND on the traced lawn of a saved map; everything else is shown
faint as "low, but not a lawn problem". Without a traced lawn the page says
some spots may be on pavement or a roof. Whether hollows ON a traced lawn
are real is still the field check's question.

**Over the locked corpus with the kinds** (workflow "W. Water tool", task
corpus, run 38981476880, 7:30 PM EDT; 98 of 104 maps, as H9): the 133 spots
touching a traced lawn sort as **40 hollow, 35 trees, 30 ditch, 14 deep,
14 paved**. **25 of 98 lawns (26%) have a lawn hollow** (H9's 59% counted
every kind); the deepest hollow on a lawn is a median 12.8 cm, at most
22.3 cm. The ditch rule scored 0 of 5 in the blind check, so the 30
"ditches" on lawns are unsorted: some will be yard swales, which do hold
water after rain.

### H11. The laser's brightness, and the rest, for "is this cell lawn" (water session, 2026-10-17)

Owner's question: is the return brightness used to tell pavement and water
apart? water/lib/cells.js measures every 1 m cell from the points alone,
each relative to its own box: ground brightness (over the box's 75th
percentile), return density, canopy share, single-return share, roughness,
how far the ground stands over its surroundings (a flat roof called
ground), no ground return. water/tools/surfaces.mjs, workflow "W. Water
tool" task surfaces, run 2026-10-17 9:48 PM EDT: inside the property line
and off the roofs of the locked corpus, a cell is LAWN if inside the traced
lawn; maps split odd/even, fitted on 48 (61,925 cells), scored on 50
(64,347 cells, 63% lawn).

AUC on the test half (0.5 = a coin, 1 = perfect):

| measure | AUC |
|---|---|
| **brightness** | **0.70** (0.705 where the cell has a ground return) |
| single returns | 0.58 |
| return density | 0.45 (i.e. 0.55 the other way) |
| canopy | 0.42 (0.58 the other way: trees are not lawn) |
| roughness, raised, no-return | 0.49-0.51 (nothing) |
| all together, logistic | **0.69** -- no better than brightness alone |

**For the low-spot map with no traced lawn** (test half): 21 spots called
hollow inside property lines, 14 (67%) on the traced lawn. Adding "its
cells look like lawn" (cut 0.5, chosen on the fit half) kept 20, 14 on the
lawn (70%): one spot removed, none of the real ones lost. Nothing worth
shipping; LAWN_MODEL stays null and the map does not use it.

Read plainly: **brightness carries a real but weak signal** -- grass is
brighter than asphalt, but concrete, mulch, beds and bare soil overlap it,
and the traced lawns are themselves loose at the edges. The other measures
add nothing a straight-line model can use. **Water was not measured**: the
corpus has no water labels; the water rule stays on return density and
class 9 (H10). Also from this run: inside property lines, 67% of the
spots the kinds call hollow ARE on the traced lawn -- far better than the
2 of 11 in H10's photo check, which counted roads and parking lots outside
any property line.

### H12. Roofs, and how impervious the rest is, on the Chesapeake land use (water session, 2026-10-17)

Owner, 2026-10-17: the lawn is always traced by the time a map reaches the
water map, so judge how impervious the NON-lawn ground is, by the laser's
brightness calibrated per map on the traced lawn (and roofs).

Answer key: the Chesapeake Bay Program's 1 m land use (lib/chesapeake.js;
the service the core's landcover.js reads), read onto the water map's grid
with the lidar's datum shift. `SQUARES=24 node water/tools/impervious.mjs`
(also workflow "W. Water tool", task impervious), run 2026-10-17 about
11:40 PM EDT: 23 residential squares of 160 m kept from 96 drawn in
Fairfax, Montgomery, Howard, Chesterfield, Lancaster, York and Dauphin
counties; 6 flights. The land use's turf stands in for the traced lawn.

**Roofs** (the water map's finder, lib/surface.js, against "Structures"):
**85% of roof cells found, 80% of what it calls roof is roof, IoU 0.71.**
Worst on VA_Sandy_2014 (Chesterfield, 6 squares): 54-78% precision.

**Paving**, ground-return brightness (3 x 3 cells) of open, non-roof cells;
"Roads" + "Other Impervious" against the pervious classes; AUC pooled over
all squares, i.e. one threshold for every map:

| brightness | paved vs beds/bare | paved vs turf | paved vs both |
|---|---|---|---|
| raw (flights record 8-bit ~160 or 16-bit ~50,000 for grass) | 0.60 | 0.71 | 0.70 |
| over the box's 75th percentile (H11) | 0.77 | 0.84 | 0.84 |
| **over this map's lawn** | 0.77 | **0.86** | 0.86 |
| roof = 0, lawn = 1 | 0.76 | 0.80 | 0.80 |

Roofs as a second calibration point make it WORSE: roof brightness swings
with the roofing (on 6 of 23 squares the roofs came back as bright as the
lawn or brighter). Not used.

**Fitted on 12 squares, tested on the other 11** (logistic):

| model | paved vs both | paved vs beds/bare |
|---|---|---|
| brightness over the lawn alone | 0.890 | 0.802 |
| + ground scatter, single-return share, return density | **0.896** | **0.840** |

The second is shipped (lib/impervious.js PAVED_MODEL): every non-lawn,
non-roof cell with ground returns and under half canopy gets P(paved);
cells mostly under trees are left unjudged. On one Fairfax square, by
land-use class, median P(paved): other impervious 0.95, roads 0.93,
canopy over turf 0.09, forest 0.07, pervious 0.13.

What it feeds: the lot's cover (lawn, roofs, likely paving, other ground),
and runoff weighted by what each surface sheds (textbook runoff
coefficients: roof 0.9, paving 0.85, other ground 0.3, lawn 0.15), roof
water let off at each roof's lowest edge because the downspouts are not in
the lidar. The weights and the downspout guess are NOT measured.

### H13. Roofs: the water map's finder, the shade map's, and both (water session, 2026-10-17)

The shade map's building classifier (public/shade/ seasonalCanopy with
classify: true, on buildCanopy's model; copied unchanged into
water/lib/shade/ on the features session's advice, 2026-10-17 11:12 PM
EDT) against the water map's own (lib/surface.js), on H12's 23 squares and
answer key ("Structures"; canopy over impervious left out). Cells; pooled;
exact | within 1 m. `SQUARES=24 node water/tools/impervious.mjs`, run
2026-10-17 about 12:30 AM EDT:

| finder | found | precise | IoU |
|---|---|---|---|
| water map (surface.js) | 85% \| 96% | 80% \| 87% | 0.71 |
| shade: H38 flat-roof rule alone | 46% \| 84% | 89% \| 92% | 0.44 |
| shade: + solid at the grass (pitched roofs) + eaves | 87% \| 96% | 73% \| 82% | 0.66 |
| shade: + tree-vs-roof patch test (as shipped) | 83% \| 91% | 85% \| 94% | 0.72 |
| **either says roof (adopted)** | **91% \| 98%** | 77% \| 86% | 0.72 |
| both say roof | 77% \| 89% | 90% \| 96% | 0.71 |
| water map less the shade map's evergreens | 84% \| 95% | 82% \| 89% | 0.71 |

By flight, IoU water / shade: VA_Sandy_2014 0.58 / **0.70** (the water
map calls evergreens roofs there); PA_Dauphin_2016 **0.72** / 0.60;
VA_UpperMiddleNeck_2018 0.86 / 0.86; PA_Northcentral_2019 0.75 / 0.78;
VA_NorthernVA_2022 **0.75** / 0.59; PA_South_Central_2017 0.59 / 0.62.

The first footprint measurement of the shade map's classifier; sent to
the features session by stage, as it asked. The flat rule alone is
precise but finds under half the roof (pitched roofs are the rest); the
pitched-roof catch finds them and brings in trees; the patch test takes
most of the trees back out.

**Adopted: either says roof** (lib/lowspots.js). Each alone is IoU 0.71-0.72
but they miss different roofs; together they find 98% of roof cells within
1 m. A missed roof is the worse error for the water map (a fake low spot,
a hole in the walls); the cost is that about 1 roof cell in 7 within 1 m
is a tree or eave edge.

Over the locked corpus with the union (workflow task corpus, run
38998726182, 2026-10-17 11:29 PM EDT): spots touching traced lawns 129
(was 133): 42 hollow, 29 trees, 29 ditch, 16 paved, 12 deep, 1 water;
**lawns with a lawn hollow still 25 of 98**. Traced lawns rarely overlap
roofs, so better roofs change little ON the lawn; the roof-made false
hollows of H10's photo check were off any traced lawn. Beside the house:
ground falls toward it on a median 10% of the outline (was 8%), 13 lots a
quarter or more (was 10).

### H14. One ground and one frame with the shade map (water session, 2026-10-17)

Owner, 2026-10-17: "copy the shade map's way of building the ground ...
Make sure your system is the exact same as the shade map (if the shade map
has to change to accommodate you, tell it that)."

The two grounds, on 6 squares of 160 m (Kent 2016 x3, Ottawa 2016,
Northern VA 2022, PA Northcentral 2019), open ground with roofs left out:
the shade map's (buildCanopy: the LOWEST class-2 return per 1 m column,
filled outward) against the water map's (surface.js: Gaussian-weighted
MEAN of the class-2 returns within 2 m, sigma 0.8 m, with an error bar):

| | shade map's | water map's |
|---|---|---|
| height (shade minus water) | median -1.3 to -3.1 cm (10th-90th -9.5 to +2.6) | -- |
| cell-to-cell roughness (median \|z - mean of 8 neighbours\|) | 1.5-2.6 cm | 0.4-0.9 cm |
| low spots over 3 cm per square | 8-67 | 5-34 |

The lowest of a few noisy returns sits low and rough; on it the low-spot
map finds 1.5-3x the spots, the extra ones noise. So the water map keeps
its ground, and asked the features session (2026-10-17 5:15 PM EDT) to
take the water map's ground into a shared public/shade/ground.js that both
maps use -- for light, a 2 cm smoother ground should change nothing
against GRASS_M 0.5 m, but that is for its own readings checks to say.

**Done, 2026-10-17 (features session, commits up to de5b4c7):** the
shade map took the water map's ground into public/shade/ground.js and made
it its default after its own check (its Finding 26: 3,133 of 3,913 field
readings scored the same with the smooth ground as with the lowest
return). The water map copied ground.js (and the canopy.js that uses it)
back unchanged into lib/shade/; lib/surface.js's groundSurface and inpaint
now hand over to it. Checked: the water map's outputs on a Fairfax test lot
came out identical, number for number, before and after.

When a map carries the shade map's part, the water map takes the cloud,
box and shift the shade map kept there (tools.shade.data.lidar), so a cell
index means the same piece of ground in both parts.

The frame IS now the shade map's: the cloud is moved by the datum
correction BEFORE it is gridded (lib/lowspots.js; as the shade map's
cellOf shift), so a cell is the same ground in both maps' grids. Asked the
features session for its exact box rule for a saved map, so cell indices
match too.

---

### H15. The owner's barometer against the lidar ground (water session, 2026-10-17)

Owner, 2026-10-17: the phone rode the fertilizer spreader with the
barometer on; subtract the hopper height and compare with the lidar.
Read through the shade map's field-reading tables (shade_baro, shade_fixes,
shade_orient, shade_cuts; the features session's instructions), visit by
visit, by water/tools/baro.mjs (workflow "W. Water tool", task baro). Only
spreader visits count (median moving speed 2 m/s or more; the phone was
carried on the slower ones). Fit per visit: barometer height minus 1.27 m
= lidar ground + an offset + a straight-line weather drift, at the best
barometer lag (searched to 15 s).

Recordings re-uploaded by 6:39 PM EDT: 17 (13 after uploads replace what
they cover), 5 with the barometer, 7 visits; 4 compared (1 carried, 1 with
no usable barometer seconds, 1 over 400 m long).

| visit | lidar relief | residual | shape r | bumps r (20 s) | GPS error worth | flat ground (<3%), smoothed 5 s |
|---|---|---|---|---|---|---|
| #2 | 444 cm | 73 cm | 0.91 | 0.36 | 33 cm | 50 cm (46 s) |
| #4 | 173 cm | 27 cm | 0.89 | 0.63 | 16 cm | 24 cm (158 s) |
| #6 | 261 cm | 24 cm | 0.97 | 0.80 | 24 cm | 19 cm (52 s) |
| #7 | 84 cm | 35 cm | 0.69 | 0.48 | 15 cm | 40 cm (153 s) |

- **The yard's overall shape agrees**: correlation 0.89-0.97 on three of
  four passes. On the flattest yard (84 cm of relief) it is 0.69.
- **The leftover is 24-73 cm, and most of it is the barometer's, not the
  GPS's.** The GPS (3.8-4.6 m median) is worth 15-33 cm on these slopes,
  but where the ground is nearly flat, and a wrong fix costs almost nothing,
  the barometer still disagrees by 19-50 cm after 5 s smoothing. The
  barometer's lag is 0-1 s, so it is not that.
- **Weather drift is large and uneven**: 6-48 cm a minute. A straight line
  over 8-25 minutes cannot follow it; a wigglier fit would start to eat the
  ground's own shape, so it was not tried.
- **So the barometer cannot check the low-spot map.** A lawn hollow is
  3-25 cm deep; the barometer's own error on flat ground is about the
  same size or bigger. It confirms the lidar's slope across a yard, which
  was never in doubt. The field check stays THE BAR's: wet spots after a
  real rain.

Four visits from one batch of re-uploads; more uploads can be read by the
same task without changes, and would firm up the numbers but would not
close a gap this wide.

---

### H16. The watering plan: what it rests on, and its first runs (water session, 2026-10-18)

The owner's vision (water/VISION.md, verbatim, 2026-10-18): how much AND how
often to water each area of a lawn, from slope, soil drainage, rain and ET
(Kc 0.8). Built in lib/soil.js, et.js, weather.js, balance.js, gutters.js,
zones.js, plan.js; every parameter's source is in water/PARAMS-SOURCES.md.

Checked, not just built:
- **ET0** matches FAO-56's own worked example (Brussels, 6 July: 3.88 against
  3.9 mm/day) and Ra example 8 (32.2 MJ/m2).
- **The balance conserves water**: on a made-up lot with a roof, rain = use +
  drained + run off the grid + held, to 0.1% (test/plan.test.js).
- **Sand vs silt loam** on one made-up lawn: two zones, the sand watered more
  often and less each time.
- **A zone watered on the morning its use would cross the readily available
  water** never stresses; first written as "the day after", it logged one
  dry day per cycle -- 12% of the season on a lot that was never dry (fixed).

First runs on corpus maps (stand-in lawn: open ground within 20 m of the map's
point; numbers only; FAO p 0.4, 6 in root zone), typical July (median of ten):
| map | soil | per watering (readily available water) | July |
|---|---|---|---|
| #55 | somewhat poorly / moderately well drained, D | 0.50 in | 5x |
| #60 | urban land - sand, A (two zones) | 0.17 / 0.26 in | 24x / 13x |
| #80 | poorly / somewhat poorly drained, C/D, D (two zones) | 0.40 / 0.52 in | 7x / 4x |
| #3 (Colorado) | somewhat poorly drained, C | 0.38 in | 16x |
Colorado's 16 x 0.38 in is about 1.4 in a week, the usual Front Range
figure. Michigan's 5 x 0.50 in on a silt loam is under KSU's "1/2 in three
times a week" for bluegrass in midsummer, because July rain there nearly
matches the grass's use (110 mm against 112 mm, POWER, ten years). The page
adds the day's own use to each watering, so it shows about 0.05 in more.

Data speed: NASA POWER ten years daily in about 1 s; Soil Data Access
usually under 1 s a query, but once 211 s (now: 20 s timeout, 3 tries).
POWER's newest days lag 3-4 days (sunshine longest); the nearest NWS
station fills them.

Owner's answers, 2026-10-18 (later the same day): root zone **12 in** ("varies
based on species. But let's call it 12 inches for now") -- now used; a
**warm-season** choice (p 0.5, the shade map's warm-season growing season) --
on the page, saved with the map; his own Kc numbers to come. The table above
was run at 6 in. Also changed then: water running over the ground now spreads
to every lower neighbour (Freeman 1991, slope^1.1) instead of one line, so a
downspout's water fans out (test: 10+ cells wetter); and "run-on" is now
measured by volume (cells getting a quarter or more again of their rain).

Open choices with a large effect (as asked, before the answers):
- **The root zone depth.** 6 in (15 cm) was used; practice runs 6-12 in and
  the irrigation industry's controller protocol uses 10 in for tall fescue.
  On sand (#60) a 6 in root zone holds 0.41 in, so the plan waters nearly
  daily in July at 0.17 in; at 10 in it would hold 0.68 in and water about
  every other day at 0.27 in.
- **Loam topsoil's conductivity**: 13.2 mm/h (Rawls 1982/1993) or 3.4 mm/h
  (the Green-Ampt effective value, Rawls 1983); the slower is used, for a
  packed lawn.

---

### H17. Paving: the lidar and the USDA photo together (water session, 2026-10-18)

Owner, 2026-10-18: paving by "whatever is most accurate and fastest", a paid
vision model allowed if it is best. First the free candidates: NAIP, the
USDA's aerial photo with a near-infrared band (lib/naip.js; USGS image
service, no key, open to browsers, one request per lot, about 0.3 m averaged
onto the 1 m grid). Scored like H12 on the Chesapeake 1 m land use: 23
residential squares, fitted on 12, tested on 11, open ground cells only
(roofs apart), each model on the same 162,288 test cells:

| features | right | finds paving | precise | AUC paved vs rest |
|---|---|---|---|---|
| lidar brightness over the lawn | 78.5% | 62% | 87% | 0.891 |
| lidar: + scatter, single returns, density (was in use) | 84.5% | 75% | 89% | 0.898 |
| photo: vegetation index | 83.8% | 81% | 83% | 0.883 |
| photo: + brightness, blueness | 84.8% | 81% | 85% | 0.905 |
| lidar + photo, all eight | 86.6% | 84% | 86% | 0.925 |
| **lidar + photo, all against the lawn (in use)** | **85.2%** | **82%** | **85%** | -- |
| lidar brightness + photo greenness and brightness, against the lawn | 83.9% | 82% | 82% | -- |

So the photo alone is about as good as the lidar alone, and together they
are better than either: 9 more points of the paving found. Against beds and
bare ground the gain is small (0.843 -> 0.854): bare soil and gravel have no
green, like paving, and are not bright like concrete. IN USE: the
against-the-lawn seven (no raw vegetation index), 1.4 points under all
eight, because a photo flown in a dry or late season would read a whole
lawn as paving, and these 23 squares are one region's photos (VA/PA); on a
Michigan test lot with a stand-in "lawn" that included driveway, the raw
index moved the paved share from 14% to 36%. lib/impervious.js
PAVED_MODEL_PHOTO; the lidar-only model stays for when the photo does not
answer. A first 4-square run said the photo was worse (0.84): small samples
mislead here as in the detector's findings.
Still to measure before anything paid: a vision model on Replicate needs the
owner's API token (a GitHub secret) and costs per image; its bar is now
85.2% right / 82% found (86.6% / 84% for the region-fitted eight) on these
same squares.

---

### H18. SAM 3 on Replicate does not beat the free lidar and photo for paving (water session, 2026-10-18)

Owner, 2026-10-18: "whatever is most accurate and fastest", his Replicate
token offered. The paid candidate: SAM 3 (mattsays/sam3-image, the model the
main site asks for "grass"), asked for "pavement", "driveway" and "road" one
at a time (one concept per prompt, as the core found), masks unioned, on the
same NAIP photo at 3 px a metre, scored on the same 23 Chesapeake squares as
H17 (workflow task paving-sam; 66 predictions, none failed, 8 s of GPU in all).
On the test squares' cells it saw (148,647):

| | right | finds paving | precise |
|---|---|---|---|
| SAM 3 alone (half the cell or more in its masks) | 79.5% | 60% | 89% |
| lidar + photo against the lawn (in use), same cells | 84.9% | 81% | 83% |
| lidar + photo + SAM 3 | 84.3% | 77% | 85% |

SAM 3 is precise but misses 40% of the paving, and as a ninth input it made
the fit slightly worse. So the free lidar + photo stays. CAVEAT: the model saw
NAIP (0.3-0.6 m); the main site's Mapbox photos are sharper, and a runner
cannot fetch them (the lawnmap 403) -- SAM 3 on a sharper photo is untested.

---

### H19. IGNF's FLAIR land-cover U-Nets, out of the box, lose to the water map's own finders (water session, 2026-10-19)

Owner, 2026-10-18: any models that take lidar and RGB (NIR if need be) and
segment roofs and concrete/blacktop with no training on our part? The core
session found IGNF's FLAIR (Etalab 2.0; FLAIR-INC_{rgb,rgbi,rgbie}_15cl
_resnet34-unet; trained on French photos at 0.2 m; "e" adds height above
ground) and scored it on its own lots (DETECTOR-FINDINGS H100; message
2026-10-19). Here, the fair test it suggested: water/tools/flair_score.py
(workflow task flair) on the water map's held-out Chesapeake squares (9 of the
H17 test squares had everything), NAIP at 0.2 m, height above ground from the
same lidar, the same open-ground cells as H17 for paving, every judged cell for
roofs (exact | within 1 m):

| | paving: right | finds | precise | roofs: found | precise |
|---|---|---|---|---|---|
| in use: lidar + photo (paving), lidar roof finders, either (roofs) | 84.0% | 82% | 86% | 91% / 97% | 78% / 83% |
| FLAIR rgb | 78.5% | 68% | 86% | 75% / 80% | 82% / 88% |
| FLAIR rgbi (+ NAIP NIR) | 77.6% | 62% | 90% | 52% / 58% | 87% / 94% |
| FLAIR rgbie (+ NIR + lidar height) | 77.7% | 63% | 90% | 72% / 78% | 87% / 94% |

FLAIR is precise but misses a third of the paving and a quarter or more of
the roofs; NAIP's near-infrared makes it call roofs paving (rgb: 15.5% of
roof called paving), likely because US NAIP infrared is not French IRC
photography. Nothing changes in the map. CAVEAT, as in H18: NAIP is softer
than the main site's Mapbox photos (the core's run used ~10 cm Mapbox and got
paving 73-79% found); a runner cannot fetch Mapbox (the lawnmap 403).

---

### H20. Overture's buildings, roads and sidewalks on top (water session, 2026-10-19)

Owner, 2026-10-19: Overture "even shows sidewalks ... let's use that on top of
current system. It doesn't show driveways, so we'll still have to use the
current system to find driveways." lib/overture.js reads the latest release's
PMTiles (transportation and buildings themes; STAC catalog for the release;
range requests, open to browsers, about 1.5 s a lot) with no library; a road
segment becomes a paved band of a typical width for its class (residential
8 m, sidewalk/footway 1.5 m, service 4 m...). Scored on the 23 Chesapeake
squares as H12/H17 (roofs: every judged cell, exact | within 1 m; paving: the
H17 test cells, 162,288):

| roofs | found | precise | IoU |
|---|---|---|---|
| lidar finders, either (was in use) | 91% / 98% | 77% / 86% | 0.71 |
| Overture buildings alone | 89% / 96% | 89% / 96% | 0.79 |
| either, and Overture | 84% / 95% | 94% / 99% | 0.80 |
| either, or Overture | 96% / 99% | 74% / 85% | 0.72 |
| **Overture, or both lidar finders agree (in use)** | **92% / 98%** | **85% / 94%** | **0.79** |

| paving | right | finds | precise |
|---|---|---|---|
| lidar + photo against the lawn (H17) | 85.2% | 82% | 85% |
| Overture road and sidewalk bands alone | 68.9% | 35% | 90% |
| **in use OR an Overture band (in use)** | **85.5%** | **85%** | **83%** |
| in use + the bands as two more inputs | 85.3% | 82% | 85% |

90% of the cells under an Overture band are paved in the land use. The bands
add little on these squares (most of their road was found already); they
matter most under trees, where the laser and photo see least. Overture had 49
driveways round one Michigan test lot, so some driveways come from it too.
Band widths are a first cut, not tuned. Also live since 2026-10-19: a saved
map is drawn on the photo it was saved with (the county photo and the
editor's line-up, or Mapbox; the shade map's traced.js).

---

### H21. The owner's first check on his own lot: rain read high, reference ET reads high (water session, 2026-10-19)

The owner checked the plan on the owner's lot. His sources against the app's typical months (medians of ten):

| | app (before) | owner's sources |
|---|---|---|
| June rain | 3.4 in | 3.0-3.9 in |
| July rain | 3.95 in | 2.7-3.4 in |
| June grass use (ET0 x 0.8) | 4.1 in | Enviroweather 4.0-4.4 in |
| July grass use | 4.4 in | Enviroweather 4.4-4.8 in |

RAIN, FIXED: NASA POWER's rain is a ~50 km grid. PRISM's daily 4 km grid
(built from the gauges; ACIS GridData grid 21, free, open to browsers) gives,
for the same place, ten Junes median 2.80 in and ten Julys 2.94 in (POWER 3.22
and 3.94). Rain now comes from PRISM for the typical years and the recent
weeks (lib/weather.js prismRain); POWER keeps temperature, humidity, wind and
sunshine. Days neither POWER nor the station has yet take PRISM's rain and the
last three days' water use.

ET, OPEN: Enviroweather's "Potential ET" is the REFERENCE (FAO-56 / ASCE
grass) ET, before any grass coefficient (MSU Extension). The app's reference
there: June 5.09 in, July 5.39 in (medians; by year 4.12-5.29 June,
5.07-5.65 July) -- about 15-20% ABOVE Enviroweather's reference, not below it;
the 0.8 grass coefficient made the app's grass use land close to
Enviroweather's reference. Not NASA's sunshine (estimating sunshine from the
temperature range instead moves June by -2%) and not the wind (2 m/s fixed:
-1%). Asked of the owner how the 0.8 should apply to a reference that
matches Enviroweather's. The weather card now shows the reference beside the
grass's use.

Also from his check: the roof count asked about every roof in the analysis
box, 30 m past the property line (21 roofs): now only roofs on the property
(or within 5 m of the lawn), 6 m2 or more. The map zooms (pinch, drag, wheel,
buttons; a drag is never a tap). Paving black, roofs white. Plainer labels. A
soil choice (sand ... heavy clay: Rawls 1982 texture averages, TR-55 group) for
when the owner knows the survey is wrong -- his lot is heavy clay where the
survey says loam; heavy clay takes 0.10-0.20 in an hour (USDA table), so the
plan splits a watering into runs of an hour's worth, an hour apart. The soil
card no longer mentions topsoil unless it was chosen, and says 12 in.

---

### H22. The owner's second check: the soil read wrong in one place, evergreens, a deck, zones that moved (water session, 2026-10-19)

SOIL. Owner: "i don't want to override the tool by putting in my own soil
type ... are we sure that we're reading the info right?" Under the owner's lot
the survey has Filer loam (90%; Capac, Parkhill, Metea, Oshtemo minor): Ap
0-23 cm loam (sand 50, clay 15, Ksat 1 um/s, AWC 0.21), B/E and Bt 23-92 cm
clay loam (clay 28, Ksat 0.55 um/s), C loam to 203 cm. Read right: the water
the roots can use (2.35 in in the top 12 in), group C, well drained. Read
WRONG: how fast it takes water. The survey's own Ksat for the top layer is
3.6 mm/h = 0.14 in/h (slow -- what the owner sees); the plan said 1.25 in/h
because the old rule put a loam on the 50%-sand line in the USDA slope
table's "light sandy loam" row and never looked at the measured Ksat. Now:
the USDA texture triangle, and no more than the survey's measured Ksat of the
top 6 in (lib/soil.js maxSprinklerRate, textureClass). The soil card lists
the layers (loam over clay loam). The soil menu is gone (no override).

ROOFS. His evergreen row read as roof. On his lot the pieces the lidar
alone calls roof that are evergreens have a NAIP vegetation index of 0.27-0.36,
real roofs 0.02-0.13, open ground 0.35. Lidar-only roof cells at 60% or more
of the scene's open-ground green are now dropped (lib/lowspots.js greenVeto;
Overture's buildings stand). Chesapeake squares with the photo (21):

| roofs | found | precise | IoU |
|---|---|---|---|
| Overture, or both lidar finders agree | 92% / 98% | 85% / 94% | 0.79 |
| **that, less what the photo shows green (in use)** | **92% / 98%** | **86% / 96%** | **0.80** |
| either lidar finder (when Overture fails) | 91% / 98% | 77% / 86% | 0.71 |
| either, less what the photo shows green | 85% / 94% | 87% / 96% | 0.75 |

DECK. A 5 ft wooden deck and a hot tub read as blacktop. The flight over
his lot has 2-3 points per square meter, and no flat raised surface stood out
there (a search for flat surfaces 0.4-2.5 m up found only scattered cells).
So the person marks it: an area tool -- deck with gaps (the ground under it,
dried at 0.3 of the open lawn's rate), brick or paver patio (TR-55 gravel
curve numbers), solid surface, roof, lawn, bed -- saved with the map, over
every finder.

ZONES THAT MOVED. "The map loads a bit differently each time... there wasn't
a zone 3 this time." Causes: the plan was shown first in full sun, then again
with shade; a source that failed silently (Overture, the photo, soil,
weather); and k-means zones, where a small change anywhere moved every zone
(a marked deck took one zone from 1,873 to 205 sq ft). Now: each source asked
three times and named on the page when it still fails; the plan shown once,
shade in; zones are fixed bands of days between waterings in the thirstiest
month (2, 3, 4.5, 7, 10), small bands joined to a neighbour, close ones
merged -- the same deck now leaves two zones untouched and takes from the
other two about its own area (test: a 3 x 3 m bed moves at most 20 cells).

---

## SPECULATION

### S8. Paving beside a lawn raises the lawn's water use at its edge

The literature (water/PARAMS-SOURCES.md 1c): turf beside hardscape uses
about 5-11% more water at the edge, fading to under 5% by about 7 m; the
afternoon-facing edge is the strongest (Brown 2005, a desert field edge;
WUCOLS gives 1.1-1.4 as an expert microclimate factor). Not measured on a
lawn by orientation anywhere found. IN THE MODEL since 2026-10-18 (owner asked
about "thermal effects of impervious surfaces"), as an ESTIMATE: grass
within 7 m of paving or a roof uses up to 8% more at the edge, fading to
nothing at 7 m, half as much when the hot surface is north or east of it
(lib/balance.js edgeBoost). Unmeasured on a lawn; the page says "an
estimate". Paving's own runoff and evaporation ARE in it: curve
number 98, a 1 mm film that evaporates (measured 0.4-1 mm, Zhou 2021).

### S10. Ground water from the land above a lawn (the hillside reading)

Owner, 2026-10-18: "known details about the water table if possible,
especially in areas below steep hills." lib/upslope.js reads the USGS 3DEP
10 m ground 600 m round the lot (the elevation service's raw float format,
6-13 s) and gives: the land draining toward the lawn and its slope; the
lawn's topographic wetness index as a percentile of its surroundings; its
height above the nearest drainage line (HAND; Agren et al. 2014: wet if 1 m
or less). Graded likely / possible / unlikely; on the page only, NOT in the
water balance.
On ten corpus lots: a 4 ha channel threshold marked street gutters (two lots
"10 m from a channel" with nothing draining onto them), so 20 ha; the lawn's
median, not its wettest cell (the wettest made every lawn rank 72-98th).
Then: #40 (7.5 ha of 16% slope above it, 93rd percentile) likely; the other
nine unlikely. No ground truth yet: a wet spring on lawns it calls likely and
unlikely is the check. The soil survey's own monthly water table (lib/soil.js,
"Wet" layers) IS in the balance: it stops drainage and makes dual-group soils
the wetter group in those months.

### S9. Shaded lawn needs less water, but less than the shade suggests

ET = full-sun ET x (0.3 + 0.7 x the share of sunlight received)
(Danielson & Feldhake 1981): about 30% of the use comes with warm dry air,
which shade does not stop. In lib/balance.js (shadeFactor). WIRED IN
2026-10-18: on a map with a traced lawn the page runs the shade map's own
light worker (copied unchanged, lib/shade/light-worker.js) over the lawn for
the summer days of the growing season, and each cell's share is its daily
light against the open sky's (NASA's clouds). On the dev test lot: 4 s, the
lawn's middle at 52% of open sky, zones at 45-67%; the plan went from two
zones to three. The growing season is now the shade map's (climate.js
growingSeason, the owner's 20% GP rule), about 190 days there, for both maps.

### S1. Many real wet spots may not be low spots at all

Ground that stays wet because the soil is compacted or poorly drained (H2:
25 of 103 corpus lots are poorly to very poorly drained, natively), because
a downspout empties there, or because a spot under 5 m across holds water
(H8: invisible), will not be on a lidar low-spot map. If so, the "7 of 10
real wet spots found" bar is at risk from step 1 alone, and the soil (step
2's soak test, H2) carries part of the answer. Untested: the field check is
what tests it.

### S2. Storm inlets and yard drains will look like ponds

A catch basin or yard drain sits in a low spot by design and drains it
through a pipe the lidar cannot see. The first maps show water "standing"
along curbs and at street low points. On a lawn, a reported spot with a
drain grate in it is a false positive of this kind; the field check should
note grates.

### S3. The noise floor is cautious on sloping yards

It is measured on flat noise (the worst case), and the scatter it uses
includes each cell's own slope (H6 footnote). Both push the floor up on a
sloping lot. Not measured how much recall that costs.

### S4. Roofs found from the points

The roof rule (no ground, 2 m+ up, mostly single returns) looked right on
three maps by eye. Not measured against footprints. A low-hanging conifer
with no ground under it could pass as a roof; a flat roof covered by
overhanging bare branches could fail.

### S5. The deep spots on lawns are features, not hollows

H9: at least 28 of 98 lawns have a "low spot" over 25 cm deep. Lawns do not
hold that; retention ponds, roadside ditches, swales, pools, window wells
and creek banks do, and a flight with 8-11 cm scatter can invent one. If
so, the map's raw count overstates lawn problems badly, and a depth cap or
a check against the photo (open water, a pool's edge) belongs before the
field check scores it. Untested: no picture of these lots has been looked
at (the log names none, on purpose).

### S6. The fall beside the house reads flatter than it is

Only a median 22% of house outlines "meet 5%" (H9). The slope is a plane
through 5 x 5 m of the smoothed surface around each point 0.5-3 m out, so
part of that window often lies on the flatter yard beyond the foundation
strip, and the 0.8 m kernel softens the strip's own slope. Both push the
measure toward flat. The "falls toward the house" share (median 8%) is the
safer number to act on; neither is checked against a level and a tape.
