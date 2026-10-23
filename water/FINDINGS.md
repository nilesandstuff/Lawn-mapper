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
  PARAMS-SOURCES.md. Root zone 8 in (owner, 2026-10-20; was 12), cool/warm season (owner);
  at most two soak cycles a day, and depths put down with the IA scheduling multiplier (H24). Paving
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

Owner, same day: "i do want the tool to be sensitive in the sense that changes
to map inputs do have knock-on effects in the same way that a real lawn is
affected by many different things." They are: the bands change where zone
LINES are drawn, not what each square metre gets. Every cell's need comes from
the daily balance with everything that reaches it. Test (plan.test.js,
"knock-on"): moving a downspout from the east side of a house to the west sends
the roof's water round the north side -- that band of lawn needs > 5 mm less a
July -- and leaves the old east outlet's lawn > 5 mm drier; a corner the water
never reaches changes by < 1 mm. A zone line moves wherever a cell's need
crosses a band edge, knock-ons included; each zone's schedule and its too-wet /
still-dry ground follow its cells' needs even when no line moves. The page has
a "water need, square by square" layer: each lawn square's own watering in the
thirstiest month.

---

### H23. Overture's buildings sit about a metre off the roofs; moved onto the lidar's, a small gain (water session, 2026-10-20)

Source: the core session's H101 (docs/DETECTOR-FINDINGS.md; on 104 lots Overture's buildings are a median
0.87 m from the lidar's roofs, one shift per lot, in a direction that changes lot by lot). lib/overture.js
alignBuildings moves all of a box's outlines by the one shift, at a quarter metre within 4 m, that best
overlaps the roofs both lidar finders agree on, scored only within reach of Overture's buildings; used when
the overlap is at least 0.3 and gains at least 0.02.

- Scored only near Overture's buildings, or the lidar's roofs it does not have (sheds, newer houses) dilute
  every shift alike: on the owner's lot the fit read 0.32 -> 0.34 (not applied) over the whole box and
  0.74 -> 0.77 near its buildings, about 0.7 m (applied). Every lidar reference (water finder, shade
  finder, both, either) gave the same shift there to within a quarter metre.
- 23 Chesapeake squares (workflow W run 39, task impervious): applied on 11 of 20 with Overture, shifts
  0.5 to 2.0 m. Pooled roof IoU: Overture alone 0.79 -> 0.80 (precise within 1 m 96% -> 97%); the
  map's rule (Overture, or both lidar finders) 0.79 -> 0.80; with the green veto 0.81 -> 0.81. Found
  unchanged (89%, 92%, 91-92%).
- Read: a small gain, and nothing lost. The Chesapeake truth is drawn on aerial photos itself, so it may
  share part of the offset the fit removes, and could understate the gain; that is not measured.
  In the plan, the gain is where it matters most: the strip of lawn against the house, which as published
  was partly a roof on one side and missing a roof edge on the other.

### H24. "Too efficient with water": three causes, and the owner's dry-week figure (water session, 2026-10-20)

The owner: the front yard (full sun) needs about 1 in a week in late June and July, over 2 or 3 waterings,
to look good; the plan asked for less, less often. The balance is the owner's equation,
dS = (P + I + CR) - (ETc + R + D), plus water running on from roofs, paving and uphill; CR (capillary rise
from a water table) is the one term it does not have. On the owner's lot, a stand-in lawn (the lot's
open ground; his traced lawn is not readable from here), typical July (rain 3.31 in, grass use 4.32 in):

| | each | July waterings | July total | a week with no rain |
|---|---|---|---|---|
| before: 12 in roots, refill to full, depths as reaching the grass | 1.00 in | 3 (2-4) | 2.93 in | (not shown) |
| 8 in roots, two cycles a day, scheduling multiplier 1.27 | 0.28 in | 11 (7-15) | 3.12 in | about 1.2 in, 4 waterings |

- Root depth 8 in (owner): the soil holds 1.68 in there, the readily available water 0.67 in.
- At most two soak cycles a day (owner), each at most an hour's intake: the survey's top-6-in rate here is
  0.14 in/h, so a day puts down 0.28 in. That, not the root zone, sets the depth and the rhythm on this
  clay. Watering lightly as soon as the soil had dried by a cycle's worth was tried and kept the root zone
  full, so the rain ran off: 5.67 in in July, 1.3 in a week. Kept: wait for the readily available water,
  then put back what a day allows -- the root zone keeps its room for rain.
- The Irrigation Association's scheduling multiplier 1 / (0.4 + 0.6 DU), DU 0.65 (a typical home spray
  system): 1.27. Before, depths were what reaches the grass.
- The dry-week figure is the one comparable to the owner's 1 in: 1.2 in. The reference ET reads 15-20%
  above Enviroweather's (H21, deferred by the owner); with that, about 1.0 in. The 4 waterings against his
  2-3 come from the 0.14 in/h intake and the one-hour cycle, an assumption a soak test would check.

### H25. The sprinkler catalogue: makers' charts, checked against their own printed rates (water session, 2026-10-20)

lib/heads/*.json, transcribed by five research agents from the makers' performance charts (schema and
rules: lib/heads/SCHEMA.md; each family names its source; each file's "notes" lists its doubts).
lib/heads.js reads them: a head's flow and throw at the pressure reaching it (linear between the chart's
rows, held at its ends), for its arc; a zone's flow and rate; pipes; GPS.

- Rain Bird sprays (55 nozzles: MPR, VAN, HE-VAN, U, R-VAN, strips), Rain Bird rotors (78), Hunter rotors
  (77), Hunter sprays and MP Rotator (57), Toro and K-Rain (305): 572 nozzles on 152 bodies. Orbit
  publishes no flow chart that could be found (its site gives radius only), so its Voyager II is not
  offered until one is.
- Adjustable nozzles whose charts print a row per arc (Toro TVAN and PRN-TA, K-Rain KVF / KV / rotary,
  Rain Bird VAN and R-VAN, Hunter Pro Adjustable and MP Rotator) are read at their own arc: a Toro TVAN8 at
  a quarter puts out 0.71 gpm at 30 psi, where its full circle scaled down would say 0.38.
- Checked: the tool's rate for a Rain Bird 5000 3.0 nozzle at 45 psi, half circle, 0.39 in/h, and a Hunter
  PGP Ultra blue 3.0 at 45 psi, 0.40 in/h, are the charts' own printed rates (0.39, 0.40).
- Small VAN nozzles (4, 6, 8, 10) do not put out flow in proportion to the arc (a 4-VAN at 90 degrees puts
  out more per degree than at 330): their per-arc tables are read, between the printed arcs.
- Rain Bird's 5000 PRS chart is printed by the pressure coming in, so a PRS body's regulation is not
  applied on top of it (pressureIs: inlet).
- Hunter's original Hunter-hosted PDFs answered 403 to the agent; its numbers are Hunter's own documents
  as distributors host them, cross-checked against a second Hunter edition.
- The pressure at a zone's heads is an estimate: what comes in, less 8 psi for the backflow preventer
  and valve, and friction in an assumed 50 ft of supply line and 50 ft of zone line (Hazen-Williams).
  GPS placing averages each head's fixes after a calibration on a known spot; not yet measured in the
  field.

### H26. The pressure at every head: how it is worked out, and what is measured vs estimated (water session, 2026-10-20)

The owner asked for the pressure at each head from a likely layout of the lines, their sizes, the ground's
rise and fall, the real flows and the pressure at the backflow preventer, with scale as an option.
lib/hydraulics.js, from three research files in lib/hydraulics/ (devices.json, pipes.json, PRACTICE.md):

- Devices (HARD, the makers' own charts): 74 backflow preventers, valves and meters, 573 points. A typical
  1 in PVB loses 2.7 psi at 10 gpm, a typical 1 in valve 3.1 psi (medians of the makers'). Every backflow
  curve was read off a chart image (about +/-0.3 psi; the method checked on Badger's meter curves, within 0.4
  of its printed table); valves and the meter table are printed values.
- Friction (HARD formula, chosen): Darcy-Weisbach at 60 F, not the industry's Hazen-Williams C 150, which reads
  5-25% low in 1/2-1 in plastic pipe (Keller & Bliesner; checked: 3/4 in Class 200 at 4 gpm, 1.02 psi per 100
  ft as derived in pipes.json; Rain Bird's own 2 in main within 10% of its chart). IDs are the Irrigation
  Association's average-wall IDs.
- Fittings: each lateral tee counted (Spears' PVC equivalents, published; poly's barbed inserts from the ASTM
  D2609 minimum bore, DERIVED and an upper bound); the supply and street lines take Rain Bird's and Hunter's
  10%. Swing joints: Hunter's SJ curve for sprays (it agrees with designers' 1-2 psi; Rain Bird's SA figure is
  a third of it -- the unpublished barb bores decide), Rain Bird TSJ for rotors.
- Heads: the charts are at the base of the head (Toro states it; Rain Bird's 5000 graph agrees), so no body
  loss. Past a chart, flow as pressure^0.52 (sprays) or ^0.53 (rotors), fitted on this catalogue's charts.
  Regulated bodies: Rain Bird 1800 PRS holds its setting from 5 psi above it, below that loses 5 (its spec:
  at most 6); Hunter PRB rotors need 15.
- Layout (SPECULATION, untested against real trenches -- none in hand): a tree from the valve where a head
  joins at the least pipe plus half its distance back along the pipe (Prim-Dijkstra), so the flow splits near
  the valve as Rain Bird and Hunter say and Hunter's WRONG snake is not drawn; under paving costs 2x, through
  a building 4x. Pipe sized by design flow under 5 ft/s from 3/4 in.
- Elevation (HARD): the lidar ground at the PVB (gauge 0.3 m up), the laterals 8 in down, nozzles 4 in up.
- Scale: nothing published gives a number for scale in PVC, PE, PEX or copper, so they stay smooth; old
  galvanized roughens at Kamerstein's rates by water type (measured on mains; ESTIMATE for a home line). The
  water questions otherwise give care, not numbers: staining where heads reach paving or walls, iron bacteria,
  lime on nozzles.
- Checked in the browser on a test lot: 60 psi static -> 53.8 psi at Zone 1's farthest head on flat ground
  (meter 0.3, street line 0.5, PVB 2.7, supply 0.1, valve 1.7, laterals 0.2, swing joint 0.7), 57.0 with the
  lidar's 3.2 psi of fall to it.
- Not yet: valve-box depth and riser losses; the IA's 10% and others' 20% spread rules both shown; a field
  check with a gauge on a head (a pitot on a nozzle) is the bar this has not met.

### H27. Gauge readings, the head picker, arcs and coverage (water session, 2026-10-20)

- GAUGE READINGS: a reading at a head replaces the estimate there, worked back to the head's inlet (a pitot
  reads the nozzle, after any regulator: under its setting the inlet is the reading plus what the regulator
  needs; a riser gauge reads the lateral with that head shut: the inlet is that less its swing joint), and the
  zone's other heads move by the zone's average miss. Each reading is kept with the model's own prediction
  in the water Worker's D1 "lawn-water" (made by the deploy, 2026-10-20); /admin shows the model's misses.
  No readings yet: the model's accuracy is UNMEASURED.
- HEAD PICKER: four sections (rotary nozzles on a spray body; fixed spray / shrub; gear-driven rotors;
  impact). A rotary nozzle defaults onto the body made for it whose regulator is nearest its design pressure
  (an R-VAN on Rain Bird's 45 psi body, as Rain Bird recommends).
- ARCS (lib/arcs.js): rays every 5 degrees to each head's throw at its own pressure; an adjustable nozzle
  takes the widest run of lawn that spares buildings and paving, a fixed pattern is turned to the most lawn,
  the throw is shortened (not under 75%) where the arc can't be turned off a hard surface. Choosing between
  a narrower arc and a shorter throw is by lawn area watered (an adjustable head 3 m from a drive takes a
  260 degree arc at full throw rather than a full circle cut to 75%). Tested on a square lawn: corner 90,
  edge 180, middle 360.
- COVERAGE (lib/precip.js): each head's flow laid over its arc and throw by its kind's radial profile;
  conserves each head's gpm to within 4% on a 0.25 m grid (tested). Shown as each zone run to its own
  average depth, summed: dry (under 60%), missed, overlapping (over 150%), with the lawn's lower-quarter DU.
  The radial profiles (lib/hydraulics/profiles.json): MEASURED for gear rotors, low-angle rotors, rotary
  nozzles and high-efficiency sprays (Fresno State CIT's zero-wind tests: Hunter I-20 and PGJ, Rain Bird 5000,
  Toro T5 and PRN; CIT grids of Toro Precision and Rain Bird HE-VAN; Hunter's MP curves), impact from farm
  heads; ASSUMED for conventional sprays (no profile found: a wedge with a dry ring about 2 ft round the head,
  from a Rain Bird patent). Near-head spikes (one catch can) clamped at 3x the mean. Check: rotors at
  head-to-head spacing, zero wind, DU 73% -- inside the research's own simulated 69-90% and the makers' claims;
  real audits run about 50% (Mecham 2004). Not modelled: the profile's shift with pressure (measured: water
  moves inward as pressure rises; a doughnut forms at 25-30 psi on rotors), wind, ragged arc edges.

### H28. No per-map lining up: the water map shows a finished map as it was saved (water session, 2026-10-20)

Owner, 2026-10-20: "the water map will only ever receive finished maps via the unified save, so you won't
need to do any lining up. So don't apply any shifts." A per-map photo-onto-lidar move (ground matcher, then
roof fit, then the core's lots) was built, shipped and taken out the same day (commits cee6feb and its
revert). The water map draws the saved map's photo and trace as saved, and reads the lidar in the frame the
shade map and the detector share (the datum move, S35; the shade map's own kept shift when it has one).
The core session reached the same place independently: with the datum move the lidar's GROUND sits within
0.1-0.5 m of the photo on every lot its ground matcher measures, and its 1-3 m roof-fit offsets are roof
lean (docs/DETECTOR-FINDINGS.md H107, S46). What the water session measured on the way, kept for the record
(moves of the photo onto the RAW lidar, metres, before the datum move):
  Fargo C20 (Mapbox)       ground matcher E +1.18 N -0.62; driveway edges by hand E +0.7..+1.1; roof fit E +3.00 N -1.00
  the owner's lot (Mapbox) ground matcher E +0.43 N -1.01; road and driveway edges by hand E +0.65 N -1.05; roof fit unsure
The datum move alone, as a move of the photo, is E +1.16 N -0.80 at Fargo (flight 2022) and E +0.77 N -0.94
on the owner's lot (2016): within about 0.35 m of the ground numbers above, which is why the ground sits on
the photo after it.

### H29. The head picker asks only what can be seen; adjustable arcs are fitted together (water session, 2026-10-21)

Owner: "most homeowners only know what they can learn by looking at the actual head while it's installed"; "the
spray body only matters here in terms of A. how high it pops up. B. if it's pressure regulated"; "for heads with
an adjustable arc, let's automatically try to fit the correct arc for best head to head coverage and max coverage
of the lawn ... tap the head to adjust the arc, so there's not overlapping drag handles".

- PICKER. Spray and rotary nozzles: what's on top when it runs; the nozzle's brand; the nozzle by the name printed
  on it; how high it pops up (2, 3, 4, 6, 12 in, or a shrub riser); whether the body says PRS/PR/P30/P40/P45 (no
  or can't tell, 30, 40, 45 psi). One generic spray body per height and setting (lib/heads.js sprayBodyId) takes
  every swappable spray and rotary nozzle: a check valve, side inlet, stainless stem or the maker change nothing
  the model computes. Rotors and impacts: the series on the cap (named by hand, lib/heads.js seriesOf: "PGP Ultra
  or I-20", "5000 series"...), a regulator if that series has one, the nozzle's number, the pop-up height. The
  arc is no longer asked. The pop-up height now sets the nozzle's height in the pressure model (was 4 in for all).
  Older saves keep their exact bodies.
- ARCS (lib/arcs.js fitArcs). The lawn round the heads in half-metre cells; a cell is worth, by how many heads
  reach it, 1 for the first, 0.5 the second (head to head), 0.3 a third, 0.1 more; -2 a head on a building or
  paving; -0.4 on other ground. Each adjustable head takes the arc (within its nozzle's range) AND the throw (full
  down to 75%, the radius screw) that add the most given every other head; fixed patterns are only turned; three
  rounds. On a 12 x 9 m test lawn with heads at the corners and mid-sides: every corner 90 deg and every side
  180 deg, facing in; the sides next to a house throw 85% rather than narrow (water/test/heads.test.js). On the
  owner's real map (30 R-VAN24 heads, read with the saved-maps key, nothing written back): fitted in the page in
  well under a second; arcs 130-270 deg, half of them at the nozzle's 270 max. Not yet checked against what the
  owner's heads are actually set to.
- EDITING. In the arcs step, tapping a head selects it; only that head shows handles: a white dot on each edge
  of its arc (one for a strip, which it turns) and a yellow square at the end of its throw. Dragging an edge
  moves that edge alone, within the nozzle's range; a fixed pattern turns. The head is then "set by you" and
  the others fit round it.

### H30. Placing on a grid, arcs last, the radius screw, valves by series, and pipe laid as installers lay it (water session, 2026-10-21/22)

Owner's notes, 2026-10-21 (snap to grid; arcs only once fitted and last, with the diffuser screw; a check on heads
with a model; adjustment right after the fit; woods and beds may be watered; "do the valve models actually make
a difference"; lines not through houses or under trees, and "big improvements ... research how that is usually
done"). Two research passes (subagents, sources below) and the core session asked about houses, roads and drives
(its answer pending when this was written).

- GRID (lib/heads.js longestEdgeInSight, snapToGrid). Made when the first head goes down, through it, its lines
  along the traced lawn's longest straight edge (the outline straightened by Douglas-Peucker at 0.3 m) whose
  middle the first head can see. Snap is a checkbox in placing and checking, every 0.5-10 ft (1 by default);
  taps and drags snap, GPS fixes stay where measured. On the owner's map: four heads at whole 5 ft steps of it.
- ARCS LAST. The steps end on the arcs: they are fitted first ("Fitting every head's arc to your lawn..."), and
  no arc is drawn anywhere before that; then tap-and-drag adjustment, with the coverage map as a toggle in the
  same step. Beds, woods and other ground now cost a sprinkler nothing much (-0.05 a head, ties only); buildings
  and paving -2. Each head of the same zone a head's water reaches is worth 4 m2 of lawn (head to head), so
  edge heads keep reaching their neighbours: on the 12 x 9 m test lawn, corners 90, sides 180, facing in.
- THE RADIUS SCREW [P = published]. Every maker allows 25% (K-Rain 30%) [P: Rain Bird spray countermat D41550,
  HE-VAN, R-VAN, 5000; Toro TVAN, MPR Plus, PRN, Super 800; Hunter MP]. Flow: rotary nozzles keep matched
  precipitation, gpm ~ R^2 [P: Hunter MP, Rain Bird R-VAN, Toro PRN, K-Rain RN; consistent with the MP2000's own
  pressure table, n 1.86]; rotors and impacts keep their flow, the screw sitting in the stream [P: Toro Super 800
  "this does not reduce the flow"], so the rate rises 1/k^2; sprays throttle at the inlet, gpm ~ R^0.85 (an
  inference from Rain Bird HE-VAN pressure tables, n 0.73-0.97: no maker prints flow at a reduced radius).
  Distribution: a rotor screwed from 42 to 30 ft doubled the rate 10-20 ft out and left the first 10 ft about the
  same [P: Hunter Irrigation Notes LIT-085]; modelled as the full spread at rho k raised by 1/k^2 past 3 m (or a
  third of the throw), volume kept (lib/precip.js screwedProfile). Rotary nozzles cut 25% for 25% closer spacing
  kept DU 0.72 [P: Kumar et al., IA 2014]. No published DU against reduction for sprays or rotors. Flow and
  throw both follow the screw now, in the pressure model too (lib/heads.js headWater THROW_GPM_EXP).
- VALVES. They differ: at 1 in and 10 gpm the makers' charts run from about 1 psi (Hunter PGV angle) to 6 psi
  (Rain Bird PGA), and that reaches every head on the zone. Within a series the globe, angle, barb and jar-top
  bodies are close, so the choice is now brand, series and size (37 entries to 24), each its plain body's chart.
  Pressure-regulating modules (PRS-Dial, Accu-Sync) are not in the device list yet.
- PIPE LAYOUT (lib/layout.js). Published practice [P]: "the most direct route with the fewest turns" (Hunter,
  Residential System Design Guide LIT-226); a trunk with spurs, at most two pipes at a head (Stryker, Irrigation
  Tutorials); the main kept short, sharing trenches (Rain Bird, Landscape Irrigation Design Manual pp. 57-60);
  "keep the trenches out from under the canopy" (Stryker); paving crossed by one sleeve, perpendicular (Michigan
  State spec). No commercial tool was found that auto-routes residential laterals. Built: a 0.5 m grid along the
  lawn's long edge; buildings impassable, canopy x6, paving 25 a cell and no turning on it, a band 0.5-1 m inside
  the lawn's edge 0.7; a search over (cell, heading) with 3 cells a turn; the main first, then each zone as a tree
  from its valve (a spine to its farthest head, then each head from the nearest point of the tree, reached
  anywhere within 0.9 m: its swing pipe); a cell another line runs along costs 0.3 of itself (one trench),
  crossing one 15; zones farthest first, then each again with the others in place. The costs are the research's
  guesses (its own words), to tune. On a 30 x 20 m test lot with a house, a tree and a drive: no run through the
  house or under the tree, every run square, a trunk along the lawn's edges with short stubs (water/test/
  layout.test.js). Not yet: feeding a zone from its middle (Rain Bird's split-length rule), tree trunk keep-out
  discs (no trunk sizes), a measured comparison with a real system's pipe.

### H31. Houses, drives and roads for the arcs: the core session's advice, applied (water session, 2026-10-22)

Asked on the owner's word ("minimizing contact with houses, roads, and driveways ... Ask core session for
advice"); the core's answer, 2026-10-21, with its measurements (docs/DETECTOR-FINDINGS.md H103, H104, H107, H108,
H111). What it advised, and what the water map does with it:
- WALLS: the lidar's footprint, not the photo's roof, which leans 1.5-3 m on Mapbox lots in some towns (Fargo
  1.75 m W, Kentucky 3 m, Louisiana 3-4 m; H107, H111). The water map's walls are the lidar roof finders with
  Overture's buildings aligned onto them (H20, H23); the core reports the owner scrapped Overture shapes for the
  lawn map (H105). NOT CHANGED YET: whether to drop Overture from the water map's walls is the owner's call.
- DRIVES AND WALKS: the photo's edge where visible, the lidar's ground brightness where not; within ~0.5 m of the
  photo on most lots (H108 median 0.50 m, 81 lots), a tail of 2-3 m on a few (H111, C71). Overture lines are
  centrelines only, never widths. ROADS: outside the parcel line, then ground brightness.
- MARGINS: 0.5 m off a lidar-derived edge; 1 m where sources disagree by more than a metre.
- SCORING, applied (lib/arcs.js): a wall -3, paving on the lot -2, paving outside the property line (the road)
  -1.5 a head; lawn within a metre of a wall or paving pays a quarter of that, a soft band instead of a flip;
  the throw a spread: a hard surface out to 1.15x the throw costs 0.3 of itself, so arcs that run beside a drive
  beat arcs that point at it. On the 12 x 9 m test lawn the side heads now throw 80% (was 85%) off the house.
- Nothing over HTTP marks drive, walk, road or house per pixel today; the core offered to add a roof/void mask
  to the live server's answer if the owner wants it.

### H32. Roofs by the core's lidar rule; zones fed from their middle; trunks from the crowns (water session, 2026-10-22)

Owner, 2026-10-22: "can't you use the same setup as the core session for finding roofs? Yes I want to drop overture
buildings"; "If fed from middle is the advice, then yes let's do that"; "can we find trunks with lidar?"

- ROOFS (lib/roofs.js coreRoofs). The detector's training rule (tools/lidar_frame.py masks_from): no ground return,
  3+ returns, the top 2.5 m+ over the ground, every return within 1.5 m, on 2 m cells; then fitted to the water
  map's 1 m grid (trimmed where a 1 m cell's own top is under 2 m and the ground was hit; grown into neighbours the
  laser never got through that are 2.5 m+ up; one-cell holes filled). Overture's buildings are no longer used;
  its road and sidewalk lines still are, for paving. Scored on the 23 Chesapeake squares (cells found exactly |
  within 1 m; correct exactly | within 1 m; IoU): the core's rule 73% | 91%, 93% | 97%, 0.69; with the photo's
  green veto 66% | 86%, 95% | 98%, 0.64; the rule before (Overture moved onto the lidar's roofs, or both lidar
  finders agree) 92% | 98%, 86% | 95%, 0.80. The core's rule is the most PRECISE roof finder here but misses
  about a quarter of the roof cells (it sits inside the roof, as the core found: H111). Lidar-only ways to
  win the edge back, same squares: its 1 m growth widened (4 rounds, one stray ground hit) 0.71; or both lidar
  finders agree 0.74; or the shade map's finder 0.74 (86% | 96% found, 84% | 93% correct); or either 0.72. IN USE:
  the core's rule, or the shade map's finder where the photo is not green (the core's own cells stand: a pulse
  that never reached the ground is no evergreen's) -- 83% | 95% found, 87% | 95% correct, IoU 0.74 on the 19
  squares where the photo answered. Dropping Overture's buildings costs 0.06 IoU on these squares (0.80 to
  0.74), mostly roof edges; the owner chose it, the core having found Overture's shapes plain wrong in places
  (DETECTOR-FINDINGS H105).
- PIPE FED FROM THE MIDDLE (lib/layout.js zoneTree). Rain Bird: "the valve serving a group of sprinklers should be
  at the center of the group to balance the flow and size of lateral pipe" (Landscape Irrigation Design Manual
  pp. 57-60). The valve box is where it is, so each zone's heads are joined first, as one tree grown from the head
  nearest their middle; then the valve's line, a run of its own (the heads' pipe costs it 20 cells to cross, so it
  cannot slip along it), joins where the cost to get there plus the farthest head's run from that point is least.
  On the 30 x 20 m test lot (11 heads round a house) the valve's line now joins the middle of the west run and
  splits both ways (it had joined at the end of the south run), for 272 ft of pipe against 264.
- TRUNKS (lib/roofs.js treeTrunks). Airborne lidar at 2-10 returns a square metre hits few trunks and nothing of
  their thickness; it finds each crown's top well, and an open-grown tree's top stands over its trunk. Trunks are
  placed at crown tops (the shade map's crown method: local maxima of a pit-free 1 m canopy height model, 4 m and
  taller, a search radius growing with height, crowns flooded downhill); pipe never crosses a disc of 40% of the
  crown's radius, at least 1 m (the layout research's stand-in for the arborists' foot-per-inch-of-trunk rule,
  21 NCAC 23 .0406, when the trunk's size is unknown), and canopy beyond costs x6 as before. Checked against the
  core's hand-traced crowns (data/labelled-crowns.csv, single crowns of 8-150 m2: 80 on 29 maps): a lidar
  treetop inside the traced crown for 42 (53%); 48 (60%) counting trees from 2.5 m; within 2 m of the traced
  crown's centre for 23; median distance 3.8 m. Evergreens 2.6 m, broadleaf 3.9 m. Not a measure of trunks
  themselves (a crown traced on a photo, years from the flight, leaning, against a lidar crown top): of the
  water map's trunk positions only that they sit in the right crown about half to three-fifths of the time.

### H33. Trees dropped; straight runs; how heads join the pipe; the pressure measured at the heads (water session, 2026-10-22)

Owner, 2026-10-22: "Scratch the tree rules completely, and stop showing trunks on the map"; on the pipe looking
gridded, "let's not do that unless the grid is genuinely the best practice way"; "Are you accounting for heads being
connected ... with a short .5 inch swing pipe... Except zone 5, which are on saddles"; and two more ways to get the
pressure at the heads, "skip as much other info as possible (especially stuff that's buried or in valve boxes)".

- TREES: no canopy cost, no trunk discs, no trunks drawn; lib/roofs.js treeTrunks removed. H32's crown-top
  measurement stands as a record (53% of hand-traced crowns had a lidar top inside them).
- STRAIGHT RUNS: the pipe had come out square for two reasons, neither the practice: the router's grid steps only
  square, and its grid was turned to the PLACING grid's angle when one was set. Now the router's own lines follow
  the lawn's longest straight edge (never the placing grid), and every corner is taken out where the straight line
  between the points either side costs no more to trench (never through a house, across paving no more than
  before): "the most direct route with the fewest turns" (Hunter). Runs along the lawn's edge stay there where that
  band is cheaper (installers run laterals there); across open lawn they go straight.
- HOW HEADS JOIN THE PIPE, per zone: flexible 1/2 in swing pipe (Hunter's SJ curve: 1.7 psi at 2 gpm), rigid
  swing joints (Rain Bird TSJ), or saddles -- a clamp-on tee with the head on a short nipple, its loss an ESTIMATE
  (a tee branch, K 1.8 from Crane TP-410, at a 1/2 in schedule 80 bore: 0.09 psi at 2 gpm; no maker publishes
  one), standing in for the lateral's tee too. Not knowing keeps the old default (sprays swing pipe, rotors rigid).
- MEASURED PRESSURE (lib/measured.js). A step after the heads asks how to find the pressure: worked out from the
  pipes and water supply (as before), a gauge reading, or how far a head throws. The two measured ways skip the
  backflow preventer, valve box, water supply, pipes and water quality (8 steps instead of 12). One reading a
  zone: a pitot tube (the nozzle's pressure; on a regulated body under its setting, the inlet is that plus what
  the regulator needs, at its setting only "at least") or a gauge in place of the nozzle (the inlet); or a throw,
  by tape or by two GPS fixes (at the head, then where its water stops: their drift largely cancels), read back
  through the nozzle's chart to the inlet pressure that throws that far (flagged "at least" where the chart stops
  gaining throw: the R-VAN24 reaches 24 ft at 50 psi and holds it to 55). Every other head of the zone gets the
  readings' pressure moved by the lidar's height between them (0.433 psi a foot), weighted to the nearest; a zone
  with no reading borrows the others', flagged. What this leaves out is friction along the zone (a few psi end
  to end), so a head midway along is the one to measure ("pick a head" chooses the one nearest the zone's middle).
  On the owner's map, four zones read by throw (19-22 ft) gave 30-41 psi at their heads; one zone borrowed.

### H34. Rust and scale in poly pipe: looked for again, still no number to use (water session, 2026-10-22)

The owner asked for a second look at friction from rust and mineral scale in poly (H26 left PE, PVC, PEX and
copper smooth). What was found, by kind of build-up:

- Rust: none. Polyethylene and PVC do not corrode. Rain Bird's and the Irrigation Association's charts give PE
  C 140 (PVC 150) with no ageing allowance (lib/hydraulics/pipes.json).
- Old plastic, measured: the one field test found is an 8 in PVC main in service 46 years, C 164 at 3.9 ft/s
  (Uni-Bell 2022, "Testing Confirms PVC Pipe Hydraulic Coefficients" -- the PVC trade group's own test). A
  calibrated city network model put PVC over 20 years old at C 130-140 (Water 2019, 11, 2378; fitted, not
  measured; it would mean 14-30% more friction loss than C 150). Nothing found for poly roll pipe, and nothing
  for any pipe as small as a lawn's.
- Slime (biofilm), measured in polyethylene: Cowle, Babatunde & Bockelmann-Evans (2017, J. Hydraulic
  Research 55(2), accepted manuscript read) grew it in a 100 mm HDPE pipe for 20 days. Friction rose within
  25 h, settled after 180 h at a friction factor of 0.026-0.034, and the slower the water the rougher the
  film; at the same pressure drop that is 15-22% less flow (their figure). Their water was synthetic sewage,
  far richer than chlorinated tap water, so it is an upper bound, not a lawn line's value.
- Iron from well water, measured in polyethylene: Gong, Erkelens, Lambert & Forward (2019, J. Water Resour.
  Plann. Manage. 145(9)) followed HDPE pipelines carrying iron-bacteria ground water in South Australia. Head
  loss rose steadily, faster in smaller pipes and at higher speeds; the deposit (iron oxide strands from
  Mariprofundus) narrows the bore as well as roughening it (about 2 mm off the diameter for each 1 mm of
  roughness). The paper is paywalled and its rates were not readable, so no number is taken from it.
- Lime scale: hard water drops it where it becomes supersaturated -- warmed, losing CO2, or evaporating. The
  scaling study found on HDPE (AQUA 2021, 70(8), 1204) had to heat the water to 30-50 C and degas it to get
  scale. Cold mains water in a buried line is not that; nozzles, screens and the wetted ground are (H26).

So the model is unchanged: poly stays smooth; iron-bearing well water stays a flag. On a lawn's pipe the
largest of these would be a slow, unmeasured loss. The pressure measured at the heads (H33) already includes
whatever the pipes have become, which makes it the better answer for an old system.

### H35. Smoother arcs, measured pressure shown by zone, what to change, when to water, one map view at a time (water session, 2026-10-23)

The owner's notes of 2026-10-23, all built and checked in a browser on the owner's real map (the readings typed
there were test values on a local copy; nothing was saved to the real map):

- ARC DRAG: it re-solved the whole system, pipe layout included, on every finger move, and redrew on every
  pointer event; the edge not being dragged was rebuilt from rounded numbers each move, so it crept. Now the
  pressures hold still during a drag (a head's own flow at its arc is still recomputed, so the fan follows), the
  layout is kept until a head, a valve box or the backflow preventer moves, the canvas redraws once a frame, and
  the edge follows the finger's unwrapped turn since it took hold. Checked: swept 300 degrees past an R-VAN24's
  270 maximum it stays at 270; swept back past its 45 minimum it stops at 45; the other edge stays put (to half a
  degree once let go).
- MEASURE STEP: each head keeps its zone's colour, with the zone's number in it; its pressure is a ring outside a
  black line (green in its chart, orange under, purple over); a check beside each measured head and in the table.
  A zone with no reading of its own shows no pressure until the person chooses to go on without one ("Go on with
  the estimate"); then it borrows the others', as before. The pressure step's dots are drawn the same way. Note:
  zones 3, 4 and 5's colours are the ring's green, orange and purple; the black line keeps them apart.
- WHAT COULD BE BETTER (lib/fixes.js, new step after the arcs). The line drawn: a run time can give a zone as a
  whole more or less (zones at different rates, ground slower than the heads: the schedule's), so only what it
  cannot fix is listed, each with its change: pressure over a chart (regulating bodies or a valve module), under
  it (less flow on the zone: rotary nozzles on spray bodies, smaller nozzles, or a split zone), rotors and sprays
  on one valve, a head laying down 1.7x or 1/1.7 its zone-mates' rate (matched precipitation), lawn no head
  reaches or that gets under half (turn or open an arc, a wider nozzle, head-to-head spacing, or heads of its own
  if it is lawn meant to be watered), and a fifth or more of a head's water on the house or paving. Numbered on
  the map; "Show it" marks the heads; a button takes the person to the step that changes it. Uniformity is now
  given over the lawn the heads reach (the owner's map: an unwatered west lawn made the whole-lawn DU 0%).
- WHEN TO WATER (lib/schedule.js, the last step). Each valve's lawn is where its heads put down the most (the
  coverage model on the plan's own grid); the ten-year plan is run again with those as its zones (the analysis
  worker); then per zone: the plan's depth over its multiplier for a typical system (DU 0.65), times the IA
  scheduling multiplier on that zone's own lower-quarter DU (held to 0.4-0.9), in minutes at the zone's own mean
  rate; one run, or cycle and soak (at most two, an hour apart) where the zone waters faster than its slowest tenth
  of ground takes in; how often from the plan's typical-year count, month by month, grouped Spring / Summer / Fall
  / Winter. Also: rain that skips a watering, a dry week in the peak month, the next watering from this week's
  weather, and the part of a zone that still dries out or gets too wet (a run time cannot fix it). On the owner's
  map with test readings: R-VAN24 zones at 0.20-0.28 in/h, 30-37% even (heads 22-36 ft apart throwing 19-21 ft),
  2 runs of 37-51 min, 1-2 days a week in summer; every zone on one day would be about 7.5 hours, so the page says
  to give zones different days and let the other zones' runs be each one's soak. The rates and evenness are the
  coverage model's (S-level for conventional sprays, H27); a catch-cup test would measure them.
- MAP VIEWS: one at a time (watering zones, water need, soil, standing water and runoff, slope, sprinklers), each
  with only its own key and a line saying what it shows; roofs and paving and the photo stay as switches. New:
  the SOIL view (the survey's units on the property, and each described: texture on top, water held in the root
  zone, how fast it takes water in, drainage, runoff group, water table, and what that means for watering) and a
  SLOPE view (rise over about 4 m from the lidar, on the property, in classes from 2% up, with the beside-the-house
  strip). The sprinklers view crashed after a measured route (it drew pipe that was never laid): fixed.

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
