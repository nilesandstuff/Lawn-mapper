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

The frame IS now the shade map's: the cloud is moved by the datum
correction BEFORE it is gridded (lib/lowspots.js; as the shade map's
cellOf shift), so a cell is the same ground in both maps' grids. Asked the
features session for its exact box rule for a saved map, so cell indices
match too.

---

## SPECULATION

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
