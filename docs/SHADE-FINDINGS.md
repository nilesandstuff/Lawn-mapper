# Shade map: what has been measured

The shade map's own record (features session), kept the way
docs/DETECTOR-FINDINGS.md keeps the detector's: HARD FINDINGS are measured,
with their data named, and SPECULATION is labelled as such. A result without
its data is not a result. Scripts are in tools/ (shade-check-*.js), so any
of this can be run again.

## Hard findings

### 1. Under a full summer canopy, the model's light is right (NEON, 2022 and 2023)

NEON's ground light sensors (DP1.00066.001, a 1 m line sensor at the soil
under the canopy, every 30 minutes) against the tower top (DP1.00024.001),
on clear days only (the tower's light at least 85% of its best within two
weeks), against the page's own DLI share at the same spot from the same 3DEP
lidar (tools/shade-check-neon.js). Days with the leaves fully out:

| Site | 2023 measured / model | 2022 measured / model |
|---|---|---|
| SCBI (VA) | 2.4% / 2.4% | 2.2% / 2.3% |
| ORNL (TN) | 3.3% / 3.2% | 3.4% / 3.3% |
| HARV (MA) | 2.8% / 1.5% | 1.6% / 1.6% |
| BART (NH) | 1.2% / 0.8% | 1.0% / 0.8% |
| DELA (AL) | 3.6% / 4.2% | 4.0% / 3.4% |
| UKFS (KS) | 3.9% / 3.0% | 5.8% / 2.9% |
| GRSM (TN) | 2.4% / 1.7% | 2.8% / 1.6% |
| MLBS (VA) | 7.3% / 2.2% | 7.5% / 2.2% |

Within about a point at most hardwood sites. Forest floors, not lawns: this
tests the canopy's transmittance, which lawn trees share.

### 2. The leaf calendar was early in spring and late in fall; recalibrated

Measured the day half the leaves' shade arrived and half was gone, from the
ground sensors (geometric midpoint between winter and summer light, 21-day
running median), at eleven deciduous NEON sites, in 2022 and 2023. The old
rule (shade starting when the typical mean passes 10 C, half gone when it
drops back below 10 C) was 16-18 days early in spring on average (2-6 weeks
early in the South, about right in the North) and 13-16 days late in fall.

PhenoCam (canopy greenness cameras; 119 deciduous sites across the lower 48,
956 site-years, the 50% transitions of gcc_90) showed green-up near the old
date and green fading three weeks before the old fall date: the canopy
greens about 12 days before it shades, and the light comes back in fall as
the leaves turn, before they drop.

New rule (seasonal.js, 5), each part tested on data it was not fitted on:

| | spring error | fall error |
|---|---|---|
| old rule, NEON 2022 / 2023 | 21 / 19 days | 15 / 19 days |
| new rule, NEON 2022 / 2023 | 10 / 9 days (lag from the other year) | 12.5 / 11 days |
| PhenoCam green-up, each site from the other 118 | 7.2 days (old 10.7) | - |

- Spring: green-up when the typical mean passes 14.5 C, or 7.5 C under the
  summer's warmest where summers are cool (fitted on PhenoCam), and the
  shade half there 12 days later (NEON).
- Fall: half the shade gone two weeks before the 10 C day (NEON). A fitted
  fall shape did no better at NEON than the plain shift.
- A fixed spring temperature (15.2 C) fitted NEON's eastern forests well but
  put Seattle's leaves out in June: rejected.
- KNOWN WEAK: the Pacific Northwest. One PhenoCam site there; Portland comes
  out in early June, April in life (old rule: mid-May).

### 3. Southern pines are called deciduous and given summer leaves

At TALL (AL), JERC (GA) and OSBS (FL), pine forests, every tree within 20 m
of every ground sensor is called deciduous by the evergreen rule (sparse
pine crowns pass more than 0.2 of the winter sun). The model adds leaves
the pines never grow: in summer it passes 2-12% of the light where the
sensors measured 16-37%, in both years. The bare model is close at TALL in
winter (19% measured, 18% model). Hardwood sites are classified correctly
(no evergreens called at SCBI or ORNL).

### 4. In winter, the bare model is neither consistently bright nor dark

Leaves fully off, no snow (southern and mid-latitude sites): ORNL 27-41%
measured against 52-61% model, SCBI 24-34% against 38-51%, UKFS 29-41%
against 34-47%, but GRSM 25-40% against 21-24% and MLBS 24-38% against
22-33%. Northern sites (BART, TREE, STEI, UNDE, HARV in deep winter) read
near zero under snow and say nothing about trees.

### 5. Trees' summer shadows on lawns: right on average (NAIP, 53 photo-years)

USDA NAIP photos (Microsoft Planetary Computer, every leaf-on year, 60 cm
to 1 m) of the corpus lots (data/labelled-crowns.csv's 60 lots; 29 lots in
13 states had lidar, a crisp photo and enough buildings), against the model
at the moment of each photo (tools/shade-check-naip.js). The sun's position
and the photo's offset fitted on BUILDINGS' shadows only (open ground near
a roof that no tree touches at that sun); what shadow looks like in each
photo read off buildings too (grass inside a building's full shadow against
grass in full sun; shade = under half the direct beam, the model's own
definition); photos whose buildings' shadows are under 1.8x darker than sun
(haze) left out -- most of the 288 photo-years. Then the trees, with nothing
tuned on them, on grass the buildings leave in sun:

| summer, leaves on | photo | model |
|---|---|---|
| tree-reachable grass in shade | 16.4% | 18.4% |
| mean share of the direct beam there | 0.769 | 0.791 |
| agreement, cell by cell | 85.5% (90.5% off shadow edges) | |

Per photo, agreement has a median of 86% (10th percentile 70%). The
differences lean both ways (model darker by count of cells, brighter by
beam), so nothing to correct. The same photos scored with the BARE model
show 7.9% in shade: the leaves are what the photos see, and the model's
summer leaves are about the right density.

Newer lidar (the core session, 2026-10-13): nine of the corpus lots now
have a newer USGS flight published only as download tiles, which the shade
map cannot read (C81, C79, C24, C23, B25, B26, C30, C29, C39). Four of them
gave 5 of the 53 photo-years above, scored on the older octree. Without them,
48 photo-years: photo 16.6%, model 18.2%, agreement 85.8% -- no change. (For
a photo, the nearer flight in time is the right one, not the newest: four
of the five photos are closer to the old flight than to the new.)

### 6. Leaf-off photos are darker near bare trees than the bare model, but not as shadow

County photos (66 leaf-off frames) and Mapbox (13), read for leaf state
from the photo itself (crowns as green as the lawn, or not), the sun's
direction fitted on buildings (tools/shade-check-imagery.js): near bare
trees the photos are darker than the bare model in 69 of 79 (mean beam
share 0.873 model against 0.805 photo, county). But making the bare crowns
denser does not fit (tools/shade-check-bare.js, 37 frames): even 4x
denser leaves half the lots still too bright, and every step lowers the
cell-by-cell agreement (84.5% at 1x, 81.6% at 4x) -- the extra darkness is
not where the crowns' shadows fall. Most likely the ground under trees is
darker in spring (leaf litter, mulch, browner grass), not shaded. No change.

Unresolved: ten county photos that read as leaf-on put the model darker
than the photo (0.62 against 0.73); NAIP's 53 summer photos do not. They
may be spring flights with the leaves part out.

### 7. No better evergreen rule found (pines), tested four ways (2026-10-13)

Labelled trees: NEON's mapped stems with species (DP1.10098.001; 6,434
living canopy trees over 8 m on 426 plots at 16 sites, placed from survey
points good to ~0.2 m; evergreen by genus or species, larch and bald cypress
deciduous, live oaks and hollies evergreen), matched to their lidar crowns
(2,370 crowns, tools/shade-crown-features.js), plus the core's labelled lawn
crowns (186 matched). Scored with each site held out, by the light cost of
a mistake (9 per broadleaf left bare, 2 per evergreen given leaves):

| rule | cost | evergreens right | deciduous right |
|---|---|---|---|
| today's (winter-dense, not a dome) | 1538 | 71/516 | 1657/1729 |
| + crowns brighter than their neighbors | 1585 | 79/516 | 1650/1729 |
| + a bright group when a scene's crowns split in two | 1853 | 98/516 | 1604/1717 |
| almost none evergreen | 1079 | 8/516 | 1722/1729 |

- Within any one flight, evergreens return the laser 1.5-5x brighter than
  bare crowns (AUC 0.88-0.98 at 9 of 11 sites) and split fewer pulses; but
  the levels differ from flight to flight (bare crowns 0.06-0.61 of the
  ground), and a pine stand has no bare neighbors to be brighter than.
- In a leaf-off photo, an evergreen crown's green against the lawn's: AUC
  0.74 over 458 lawn-crown photos -- grass shows through bare crowns.
- Southern pines stay called deciduous; nothing here does better.
- Today's rule calls 72 bare deciduous crowns evergreen, nearly all on
  MIXED-season flights (HARV 46, BART 11, TREE 4): part of those scans saw
  leaves, so the crowns look winter-dense.

### 8. The phone's light sensor takes in the sun as about cos^2.5 of its angle (tilt tests, 2026-10-13)

The owner stood in the open and tilted the phone (Galaxy S21 Ultra, bare,
in hand) slowly in every direction, sun 38 degrees up, mostly clear: first
12:38-12:42 EDT with the screen on, then 12:43-12:46 with it off (as it is
at work). Workflow 35's window gave lux and orientation each second
(tools/shade-readings.js). The brightest readings (90th percentile) at each
angle between the sun and the screen's face, compass offset -14:

| sun off the face | 0-10 | 20-30 | 30-40 | 40-50 | 50-60 | 60-70 | 70-80 |
|---|---|---|---|---|---|---|---|
| screen on | 91k | 81k | 74k | 72k | 38k | 28k | 13k |
| screen off | 99k | 77k | 60k | 51k | 30k | 11k | 6k |
| 95k x cos^2.5 + 5k | 99k | 84k | 70k | 54k | 37k | 21k | 9k |

- Fitted with a loss that lets clouds only dim: power 2-2.5 best with the
  screen on, 2.5-3 with it off; plain cosine clearly worse in both. Face-on
  sun 90,000-110,000, sky 4,000-6,000, lux and orientation in step to the
  second. Adopted: 2.5, within a hair of the best in both.
- The phone's compass: the best fit turned its heading 26 degrees (screen
  on) and 14 (screen off) from true north. On the hopper the fitted
  mounting angle absorbs this for the heading; the face's tilt there is
  small (under 20 degrees), so the error in the sun's angle stays small.
- Adopted (truth.js sunGain, sunOrShadeAround): each reading judged
  against what sun and shade would read at its own angle (sun and shade
  levels fitted per 90-second window, so the day's haze drops out); readings where the two would differ by under 3x are left out,
  replacing the fixed 65 degree cut.
- On the one field visit at hand (2026-10-12's last, late afternoon): 82% of
  45 readings agree with the model, against 67% of 30 with the fixed cut
  (the same at power 2 and 2.5; 78% with the phone modelled at its true
  height, 50 inches, not 1 m -- two readings flip). One visit; not yet a
  result.
- On that visit the face-on sun came out at about 31,000 lux (median), a
  third of the tilt tests'; the owner confirms clouds were popping up after
  4 PM and it was late in the day.
- CLEAR-DAY FIELD CHECK (2026-10-13, the owner's work day, the phone bare on
  the hopper cover, one patch of cloud left out of the recording): each
  reading judged at its own angle (cos^2.5), half an hour at a time
  (workflow 35, levels):

| time (EDT) | sun up | face-on sun, median | brightest tenth | readings judged sun / shade |
|---|---|---|---|---|
| 10:00 | 23 | 50,400 | 78,800 | 481 / 80 |
| 10:30 | 27 | 39,300 | 67,200 | 107 / 142 |
| 11:00 | 30 | 45,400 | 64,600 | 164 / 52 |
| 11:30 | 35 | 61,700 | 88,900 | 103 / 33 |
| 12:00 | 36 | 63,600 | 91,500 | 288 / 72 |
| 12:30 | 38 | 63,300 | 90,200 | 262 / 142 |
| 13:00 | 39 | 71,000 | 94,500 | 356 / 22 |

  With the sun 35-39 degrees up, the brightest tenth of the field readings,
  brought to face-on by cos^2.5, is 89,000-95,000: the tilt tests' level
  (90,000-100,000, same sun height). The curve carries over from the hand
  to the hopper. The median sits about a third lower than the brightest
  tenth (dappled light and part-shade among the readings judged sun). At
  the same sun height (26-31 degrees), yesterday's cloudy late afternoon
  read 31,000 against today's 39,000-45,000.

### 9. The phone agrees with the model 95% where the model is sure of sun and 89% behind buildings (field check, 2026-10-13)

The owner's full working day (clear, one patch of cloud left out of the
recording; 23 visits, 3,883 readings judged), scored by
tools/shade-field-check.js (workflow 35, check). The truck was found from his
routine at each stop and its readings left out (public/shade/truck.js). The
sun was placed for each reading's time and place, each reading was judged at
its own angle, and the phone's angle on the hopper was fitted per stop (it
ranged 234-302 degrees; one fit for the whole day failed). Lidar: the
2016-18 leaf-off flight under every stop. Leaves by the calendar: 21% on.
The model's confidence, from the beam at the reading and at 8 points 3 m
around it (GPS error):

| where | readings | phone agrees | the misses |
|---|---|---|---|
| open: model sure of sun | 1,879 | 95% | all "model too bright" (phone read shade) |
| behind a building (no leaves involved) | 84 | 89% | all "model too dark" |
| deep tree shade | 33 | 33% | all "model too dark" (phone read sun) |
| edges, thin crowns (model unsure) | 1,887 | 67% | too dark 414, too bright 207 |
| all | 3,883 | 81% | |

- The phone method is sound: where the answer is known without trees
  (open lawn, building shadows), it agrees 89-95%. The open misses (5%) are
  shade the 2018 lidar does not hold, or the operator; the building misses
  are GPS within a few meters of a wall.
- Near trees the model is too dark twice as often as too bright; a third of
  those misses (127 of 414) are one new build the lidar predates.
- WITHOUT THE CLOUD RULE (2026-10-14; the owner records only in clear sun,
  so a run of shade over a minute is no longer dropped as a likely cloud):
  the same day, 4,078 readings scored (195 more), agreement 81% still;
  open 95% of 1,899, behind a building 87% of 86, deep tree shade 55% of
  51 (from 33% of 33: the long shade the rule dropped was real shade),
  edges 68%. Where the leaves decide (466): calendar 284, full 252, bare
  214.
- FLECKS OF SUN ARE RARE (2026-10-14; the owner re-uploaded the day's
  exports, stored the new way: each second's median and brightest of ~4
  samples): of 22,917 seconds, 133 (0.6%) had a brightest sample over 3x
  the median and over 10,000 lux. Scored on medians: 3,913 readings, 80%
  agree (81% on means); open 95%, behind a building 91%, deep tree shade
  49% of 57, edges 66%. So averaging flecks into shade is not why the
  phone reads sun in deep tree shade. The 4:05 PM stop (tree line along
  one side) did not split clearly into sun and shade on medians and was
  not scored.
- The truck: at every stop the anchors where the phone is set down and
  picked up agreed within 0-2.5 m (one spot per stop). Its shadow, with
  the sun 25-39 degrees up, falls almost entirely inside the 10 ft margin.
- WHERE THE LEAVES DECIDE (the model's full and bare canopies disagree; 389
  readings): the phone agreed with the calendar's 21% at 221, with full
  leaves at 181, with bare trees at 208. One stop (1:00-1:26 PM) gave 102 of
  its 104 to bare trees: a NEW BUILD (owner), built after the 2016-18
  flight, so the model there still holds what stood before (trees since
  cleared, no house); its near-tree misses were 127 too dark, 3 too
  bright. Without it: calendar 208, full 179, bare 106 of 285. Stop by stop it varies: some fit full leaves (2:44, 4:05), one fits
  bare. The owner saw most trees still holding most of their leaves, with
  one lot losing many (its trees to the south). As finding 2 found at NEON,
  the shade goes before the leaves fall.

### 10. The owner's stops: newer photos agree with the 2016-18 lidar; one stop flags thinner trees (2026-10-14)

Every stop of 2026-10-13 in 120 m squares, against the county's own flights
(Ottawa 2024, 2021, 2018, 5.6 cm) and Mapbox, the sun and offset fitted on
buildings' shadows, shade cell by cell on grass the trees reach, each photo
scored against the lidar's trees bare and in leaf (workflow 35, photos;
tools/shade-field-photos.js; fetched straight from the sources -- the live
site refuses GitHub's runners):

| photo | squares | read as | agree, trees bare | agree, trees in leaf |
|---|---|---|---|---|
| county 2024 | 31 | all leaf-off | 92% | 87% |
| county 2021 | 19 (18 hazy) | 15 leaf-off, 3 mixed, 1 on | 87% | 82% |
| county 2018 | 23 | all leaf-off | 91% | 85% |
| Mapbox | 6 (31 hazy) | leaf-off | 81% | 79% |

- No usable leaf-on photo over his stops: the 2021 flight, leaf-on by eye
  over one park, reads leaf-off at 15 of 19 squares here (the crowns not yet
  as green as the lawn: early spring). So the summer canopy cannot be
  checked from photos in his area; NAIP (finding 5) remains the summer test.
- Bare-tree shade agrees 87-96% stop by stop: no wholesale change since the
  flight. The one stop that stands out is 4:28 PM: the lidar has shade the
  photos do not show on 9-13% of grass (2018, 2021, 2024 alike), against
  1-4% elsewhere -- the same stop where the phone read sun at 19 of 24
  readings in the model's deep tree shade (finding 9). Thinner or fewer
  trees there than the lidar holds is the likely reading.
- The new build (1:00 PM) shows 3-9% shade in the photos the lidar lacks;
  not a clear signal at this scale.

### 11. The tree misses are not the leaf filling, the solid fill, or a low sun (field check, 2026-10-14)

Owner's question, looking at the 4:28 PM stop: is the leaf filling putting
crowns lower than they stand, and is each reading judged at its own time?
Workflow 35 (check, 2026-10-13; tools/shade-ray-check.js), 3,913 readings:

- TIME: each reading's sun is placed at its own second and spot; 4:28 PM on
  Oct 13 checked by hand (24.7 degrees up, azimuth 230), agreeing with sun.js to 0.1.
- On the 430 rays the model calls shade and the phone read lit, the optical
  depth by source (median shares): the laser's own leaf-off branches 78%,
  leaves among those branches 12%, leaves BELOW the lowest branch 0%, the
  solid fill under dense crowns 0%. Stopped a median 5.8 m up and 7 m away.
- Removing the low leaves changes 3 readings in 3,913; the fill, 1. Bare
  trees would turn 117 of the 430 to sun (92 of them the new build's).
- Crowns clumped (x0.7, x0.5 per meter, Beer's law along a long slant): no
  better (3,134 and 3,164 against 3,143).
- Through trees, by sun height: under 25 degrees 201/359 agree, 25-32 173/266,
  over 32 464/793. No fall-off as the sun drops.
- 4:28 PM alone: the misses' light was stopped 8.4 m up, 17 m away, sun 23
  degrees: mid-crown in trees the photos (10) already show thinner than the
  2018 flight.

The mechanism the owner suspected is real (seasonal.js fills a clump's
leaves from its 10th-percentile return height, so a shrub joined to a tall
tree starts the tree's leaves low; tested on a synthetic tree), but on
these readings it carries none of the error.

### 12. No steady GPS bias; the stops' best moves are small and scattered (field check, 2026-10-14)

Owner: "my gps should also be adjusted to match our version of reality."
FRAMES: the lidar is moved from NAD83 into the global frame the phone's GPS
uses (datum.js, about 1 m); the plate's drift since the 2018 flight is
about 15 cm. The check view also moved the lidar onto the photo (the
match's left-over move) but NOT the readings; fixed 2026-10-14 (truth-ui.js
moveTrack). The field check never applies the photo move, so its numbers
(9, 11) were in one frame all along.
GPS BIAS: each stop's whole track moved in 1 m steps up to 4 m, scored
against the same model (2026-10-13, workflow 35):
- the day as a whole fits best NOT moved (3,143 of 3,913);
- stop by stop the best move scatters: 1E 1N, 4E 4N (the new build), 2W 1S,
  none, none, 2E 1N, 1E 1S, 1W 1N, 1E 3N, 1E 4N, none;
- gains are small, 0-13 readings a stop (the best of 81 moves always gains
  a little by chance). 4:28 PM: 113 to 126 of 195 at 1E 3N, still 65%.
So a phone GPS that wanders a meter or few from stop to stop, and no
correction that fits the day. Fitting each stop's move to the readings
would score the model against itself; not done.

### 13. Against leaf-on lidar: the fill is close; open ground near trees a little dark (NEON, 2026-10-14, CORRECTED)

Owner: "how trees are being filled in ... compare our fill model with hard
reality." tools/shade-check-leafon.js: the page's model from the 3DEP
leaf-off cloud with full summer leaves (OURS) against the same canopy maths
on NEON's peak-greenness lidar of the same trees (LEAF-ON; nothing filled),
flights a year or less apart: UKFS (KS, 2015/2016-07), SCBI and BLAN (VA,
2020-21/2021-08), ORNL (TN, 2015-16/2016-06); MLBS found no tile at 25-60%
tree cover. 32 windows of 250 m, 2 NEON tiles a site picked for 25-60%
cover; clouds lined up by canopy and roof tops (all within a meter). Light
at 1.27 m for the sun 20-65 degrees up from five directions.

CORRECTION, same day: the first numbers here (open ground 85%, our crowns
24% wider) were a bug in the check, not the model -- NEON points in the
overlap of neighbouring windows went to the first window only, leaving 40 m
strips of the others with no leaf-on data, read as open ground. Fixed in
readTile; the numbers below are from the fixed run.

The leaf-on model is scored two ways, because under a dense leaf-on layer
the laser saw nothing and canopy.js fills solid to the grass (right under a
roof, a guess under a tree): with that fill (A), and with it under roofs
only (B, the fairer one for trees).

| Place | agree (B) | ours too dark / too bright (B) | mean beam leaf-on / ours (B) | agree (A) |
|---|---|---|---|---|
| OPEN, within 20 m of trees | 93% | 6% / 1% | 0.85 / 0.80 | 93% |
| under a crown edge (3 m) | 83% | 12% / 5% | 0.39 / 0.33 | 85% |
| deep under canopy | 92% | 7% / 1% | 0.12 / 0.06 | 97% |
| under a small crown (<300 m2, ~400 points) | 76% | 20% / 4% | 0.46 / 0.34 | 75% |

- FOOTPRINT: ours covers 102% of the leaf-on crown columns (7% of ours
  where leaf-on has none) -- right, within the flights' year apart.
- The lawn's case, open ground near trees, agrees 93%, leaning dark: ours
  passes 0.80 of the beam where leaf-on passes 0.85.
- Fill changes scored on the same windows (B), none worth more than a
  point or two anywhere: no footprint widening (open 93%, beam 0.81; edge
  84%), crowns thinned over 2 m to the edge (93%, 0.81; small crowns 77%),
  leaves where the winter branches are (93%, 0.81), crown base per column
  (93%, 0.80; small crowns worse, 73%), each column's own top (93%, 0.82;
  edge 82%).

### 14. The shipped fill is the best of those tried; GPS error explains about 20 of the 34 missing points at shadow edges (2026-10-14)

FILL CHOICES (seasonal.js `fill`; all scored on finding 13's 32 NEON
windows, leaf-on model without fill in trees). None beat the shipped fill by
more than a point or two at open ground near trees; the most balanced, no
footprint widening plus each column's own top (open beam 0.84 against
leaf-on 0.85, edges 0.42/0.39, deep 0.11/0.12), was then held to NEON's
GROUND LIGHT SENSORS (finding 1's eight sites, 2023, clear leaf-on days,
same code):

| Site | measured | shipped fill | no widening + own top |
|---|---|---|---|
| SCBI | 1.9% | 2.4% | 8.9% |
| ORNL | 3.1% | 3.3% | 6.1% |
| HARV | 2.8% | 1.6% | 2.7% |
| BART | 1.2% | 0.8% | 1.8% |
| DELA | 2.4% | 4.3% | 6.4% |
| UKFS | 3.4% | 3.0% | 6.9% |
| GRSM | 1.5% | 1.8% | 2.8% |
| MLBS | 5.6% | 2.3% | 4.0% |

Mean miss 1.0 point shipped, 2.6 the alternative: the closing and the
tallest-neighbour top are what make a closed canopy's floor right. On the
owner's 2026-10-13 readings (21% leaves) the alternative gained 45 of 3,913
(80% to 81%). Not shipped. Also tried: crowns thinned to the edge, leaves
where the winter branches are, crown base per column, a lower leaf-area cap
(4, 3), own top only within 2-4 m of the edge -- none moved open ground by
more than 0.02 of the beam.

GPS CEILING (tools/shade-field-check.js gpsCeiling; 2026-10-13): if the
model were exact and the phone's fix wandered by its own reported accuracy
(median 3.8 m), agreement would be at most: open 100% (actual 95%),
behind buildings 99% (91%), deep tree shade 100% (49%), shadow edges ~80%
(66%). So at edges GPS costs about 20 of the 34 missing points; deep tree
shade's misses are not GPS at all (the trees; see 9, 10).

OPEN SUN READ AS SHADE (95 of 1,910 on 2026-10-13): spread evenly over
where the sun stood from behind the operator (2-8% in every 15-degree band
from 30 to 180 degrees; 8% with the sun in front), the tilt gain, sun height and
speed the same as the open readings read right. No pile-up just past the
35-degree rule: the operator's shadow is not wider than the rule; these
look like scattered misses (GPS near things the 2018 lidar lacks, the
odd vehicle), not a flaw of the method.

NO LAG between the light and the GPS (2026-10-13, lagScan): the phone's
verdict against the model at the track k seconds later agrees 73.7, 75.5,
77.8, 80.3, 80.5, 78.7, 76.7% for k = -3..+3 (edges 55.0 to 65.8%, best at 0):
the two streams line up to within about half a second. (A lag would run
along the way the mower goes, which the whole-track moves of finding 12
cannot see.)

3D GROUND: the light has always been computed on the lidar's ground (each
ray starts at its point's ground height; the beam falls on the ground's own
slope; hillsides shade themselves). Tested on bare slopes of 6-31 degrees with
the sun 10-35 degrees up: self-shadow exactly where the sun is behind the
slope, none from the 1 m grid's steps. Only the picture lay flat; since
2026-10-14 it drapes on the lidar ground when the map is tilted.

Also seen (not acted on): in NEON's leaf-off and in-between seasons the
model is far too bright on forest floors (SCBI leaf-off 24.6% measured,
45.7% model; ORNL 27.9% / 58.2%; between: SCBI 5.9% / 10.3%, ORNL 6.8% /
16.1%) -- finding 4's winter question, and October is "between".

### 15. Bare forest floors in winter: mostly too bright, and wood seen from the side fits 9 of 11 sites (NEON, 2026-10-14)

NEON's ground light sensors on clear leaf-off days, 2023 (tools/shade-check-
neon.js), the shipped model against one where bare wood stops more of a low
sun than the near-vertical laser saw (rays.js woodScale: 60% of the wood
area upright like trunks, G = 0.2 + 0.38 sin(zenith) against the laser's
G at 10 degrees; leaf-off days only). Measured / shipped / wood-from-the-side, % of
the open sky's light:

| Site | 3DEP flight ends | measured | shipped | wood 0.6 |
|---|---|---|---|---|
| SCBI | 2021-01 | 24.6 | 45.7 | 31.7 |
| ORNL | 2016-01 | 27.9 | 58.2 | 38.6 |
| DELA | 2021-01 | 21.8 | 49.8 | 31.4 |
| UKFS | 2015-03 | 29.3 | 39.1 | 21.3 |
| TALL | 2017-03 | 21.0 | 26.3 | 16.7 |
| LENO | 2023-03 | 17.0 | 29.4 | 13.8 |
| JERC | 2018 (mixed) | 17.0 | 23.6 | 13.0 |
| HARV | 2014-12 (mixed) | 15.9 | 23.1 | 12.4 |
| BART | 2018-05 (mixed) | 3.0 | 5.2 | 3.7 |
| GRSM | 2016-04 | 25.7 | 22.1 | 11.0 |
| MLBS | 2017-04 | 31.7 | 27.8 | 14.2 |

Mean miss 11.9 points shipped, 7.6 with the wood from the side (30%
upright: 10.2 over the first eight). The two it makes worse are the two
flown in April in the mountains -- where buds and early leaves may already
be in the "leaf-off" cloud, so the model is dark there before any
correction. Left out: STEI and TREE (northern Wisconsin; sensors near dark
all winter, snow on them most likely), BLAN (its sensors disagree with the
model even in summer, 6% against 50%: not under the trees the lidar shows),
SERC and CLBJ (no 3DEP lidar at the sensors). Also the ratio of shipped to
measured falls as the winter sun climbs at the southern sites (ORNL 2.6x in
December, 1.6x in March) -- what wood seen from the side predicts.

NOT SHIPPED: it would need a rule by flight month, the leaf-off season
hardly matters to a growing lawn, and the owner's October lawns lean the
other way (too dark near trees, 9, 11, 14). Noted in passing: in the pine
savannas the model is far too DARK in summer (TALL 16% measured, 5% model;
JERC 22% / 3%; OSBS 30% / 13%) -- the pines question of finding 7. With
no leaves added at all (the canopy as flown, SHADE_NOLEAVES), May to
September: TALL 16.9% measured, 42.1% model; JERC 24.3% / 41.6%; OSBS
32.7% / 67.7%. The truth lies between: the summer leaves are going onto
trees that should not get them (pines called deciduous), or too many.
CONFIRMED for the first: within 40 m of the sensors 0% of the crown columns
are called evergreen at TALL and OSBS, 0-2% at JERC (pines 19-24 m tall):
open pine crowns pass more than the 0.2 of the winter sun the rule (2)
asks of an evergreen, so they get a deciduous crown's full summer leaves.
Finding 7 found no better rule four ways; this puts a number on what it
costs in pine country (10-20 points of the day's light under the canopy).
Finding 7's rules were rescored with each crown's OWN cost of a mistake
(either mistake puts a crown at the other of its two lights, bare as flown
or in full leaf, so it costs ln(winter share / 0.064) whichever way; the
old fixed 9:2 came from the two classes' medians). Today's rule 958, none
evergreen 958, adding "a crown carried high on its trunk" (pines' crown base
sits 0.39-0.44 up the tree against 0.22-0.31 for the broadleaf at the same
sites) 1,000-1,027: it catches up to 39 of TALL's 152 pines but calls more
lawn broadleaf evergreen (112 of 134 right, against 133). The verdict stands:
the winter laser alone cannot tell an open pine from a bare broadleaf -- in
pine country the pines are MORE see-through in winter (median 0.52-0.72)
than the broadleaf beside them. A map of forest types (pine regions) as a
prior is the next idea, TRIED the same day: the US Forest Service's forest
type groups (FIA Forest Atlas, 250 m, imagery.geoplatform.gov ImageServer
USFS_EDW_FIA_ForestAtlas_TreeSpecies_109; TALL and OSBS read longleaf/
slash pine, JERC oak-pine, SCBI oak-hickory, HARV maple-beech-birch). Rule:
in a loblolly/shortleaf, longleaf/slash or oak-pine pixel, a crown carried
high (crown base over 0.35 of its height) is evergreen; elsewhere today's.
Per-crown cost 958 -> 651 over all labelled crowns (TALL 315 -> 137, OSBS
264 -> 160, JERC 115 -> 78) -- but on LAWNS 53 -> 65: of the 17 labelled
lawn crowns in mapped pine country 16 are broadleaf yard trees, and 5 of
them carry their crowns high and flip. Not shipped: the map is for lawns,
and the lawn sample there is small. More labelled Southern lawn trees would
decide it.

### 16. Lawn trees filled their own way; the phone's bounce is not the problem (2026-10-14)

Owner, 2026-10-14: "forest canopies behave differently from lawn canopies
... We care much more about lawn trees." The fill change that finding 14
turned down (no widening + each column's own top) won on both lawn-like
tests and lost only under closed forest. So, by crown: a crown in a clump
under 2,000 m2 keeps its own top and is not widened by the closing, and so
do a big canopy's columns within 3 m of its edge; inside closed canopy the
closing and the tallest-neighbour top stay (seasonal.js LAWN_CLUMP_M2,
LAWN_EDGE_TOP_M; SHIPPED as the default 2026-10-14). On the three yardsticks:

| | shipped before | lawn-tree fill |
|---|---|---|
| NEON leaf-on, open ground near trees (beam; leaf-on 0.85) | 0.80 | 0.83 |
| NEON leaf-on, under a crown edge (beam; leaf-on 0.39) | 0.33 | 0.38 |
| NEON leaf-on, deep canopy (beam) | 0.06 | 0.07 |
| NEON ground sensors in leaf, hardwood sites (8) | 1.0 pt mean miss | unchanged (SCBI 2.4, ORNL 3.3, UKFS 3.0...) |
| NEON ground sensors in leaf, TALL pine savanna (16.2% measured) | 4.8% | 6.7% |
| owner's readings 2026-10-13 (21% leaves) | 3,143 / 3,913 | 3,157 / 3,913 |

Small, and nowhere worse.

PHONE BOUNCE (owner: the phone is taped to a vinyl hopper cover that bounces
on rough lawns). 2026-10-13: judged as if the phone lay flat (no
orientation at all) 81% of 3,836, with its orientation 80% of 3,913 -- the
orientation neither helps nor hurts measurably (the face is within 10
degrees of level 93% of the time). By how far the face swung since the
second before: 0-2 degrees 82% (1,716 readings), 2-5 79% (1,518), 5-10 78%
(218), over 10 (12, too few). Shadow edges 65-67% at every swing. The light is a
per-second median of ~4 samples, which damps a bounce; the bumpy seconds
cost a few points, not the edge misses.

### 17. Overcast readings: the barometer reads the lidar's ground to 0.17 m; the sky view explains the light; the leaves were still mostly on (2026-10-14)

Owner, 2026-10-14: an overcast day, two short recordings kept off the site,
with the barometer and compass added. tools/shade-overcast.js (counts and
fits only). Both recordings are short -- one yard with trees (about 4.5
minutes moving, 254 readings, ~40 m across) and one open lawn (4 minutes) --
and readings a second apart are not independent: the barometer result is
hard; the leaf result is one yard and goes under speculation.

BAROMETER. The phone's relative altitude against the lidar ground under
each GPS fix, with a straight-line drift for the weather (-0.15 m/min,
measured at the same time): off by 0.17 m (SD) over 3.5 m of relief,
correlation 0.98. GPS altitude: 0.54 m, 0.82. Shifting the track up to 6 m
each way, the best fit is at no shift (0, 0): the GPS track sits on the
lidar's ground where it says it does, here within about 1-2 m north-south
(the slope's direction), poorly fixed east-west (the yard is flat that way).
An independent check of the GPS-to-lidar frame (12), with no photo in it.

COMPASS: adds nothing. Sensor Logger's compass bearing against the
orientation sensor's heading: spread +-90 degrees (it reads the magnet in
the phone's own frame; the orientation sensor already fuses it with the
gyro, which is what the checks use).

SKY VIEW. With no sun every lux comes from the sky at large, so the
readings test the diffuse half of the light (climate.js dliOn x skyView) --
which sunny readings cannot. The sky darkened 35% in nine minutes while the
phone stood still, so each reading is set against its neighbours within 45 s.
In the yard with trees, how well the model's sky view explains the light's
rises and falls along the track (correlation of the detrended logs):

| sky view | corr | median miss |
|---|---|---|
| none (light = sky alone) | - | x1.41 |
| the map's (even sky, level surface), the calendar's 14% leaves | 0.49 | x1.22 |
| CIE overcast sky | 0.51 | x1.22 |
| CIE sky through the phone's cos^2.5 sensor | 0.56 | x1.20 |
| the top 30 degrees only | 0.65 | x1.15 |
| phone's, leaves 0% / 30% / 50% / 70% / 100% on | 0.47 / 0.63 / 0.70 / 0.74 / 0.77 | x1.24 / 1.19 / 1.16 / 1.17 / 1.21 |

The model's sky view does explain the light under trees (0.49-0.77, against
nothing without it). The phone's narrower sensor fits better than the map's
cosine, as finding 8 says it should: a phone reading weights the sky
overhead more than grass does, so comparisons must use the phone's
weighting; the map's own (for the grass) stands. On the open lawn the sky
view barely varies (median 0.83-1.0) and explains little (corr 0.1-0.2).

LEAVES, FROM THE SUNNY READINGS (2026-10-13, workflow 35's new leaf share
scan; the owner, 2026-10-14: "the vast majority of trees have probably 75%
of their leaves, not sure I've seen any in lawns that were below 50%").
Agreement at each leaf share, without the new-build stop (whose trees are
gone, finding 9):

| leaves on | 0% | 15% | 30% | 50% | 70% | 85% | 100% |
|---|---|---|---|---|---|---|---|
| where the leaves decide (134) | 36 | 72 | 89 | 91 | 92 | 95 | 98 |
| all scored (3,588) | 2,918 | 2,954 | 2,971 | 2,973 | 2,974 | 2,977 | 2,980 |

Rising all the way to full leaves; the calendar's 21% sits near 15-30%.
(Finding 9's count, which favoured the calendar over full leaves, was made
before the lawn-tree fill, 16.) With the new-build stop the day favours
bare trees (124 of 225), all of it that one stop.

### 18. Twice-flown streets: none in broadleaf towns; the catalogue's seasons are right (2026-10-15)

The bookmarked test (owner, 2026-10-14), tools/shade-check-twice.js. Every
pair of 3DEP flights whose outlines overlap, one flown June-September and
one leaf-off by WESM's dates, within 3 years, east of 100 W: 47 pairs, and
every one is Florida, the Gulf coast, the Plains or Nebraska river work.
Windows in Census urban areas with houses (3%+ roofs) and trees (10%+):
6, all Florida (Jacksonville 2007, Palm Beach 2018-19), 2007-era densities.

| Florida, 6 windows | leaf-on flight | ours (from the bare flight) |
|---|---|---|
| open ground within 20 m of trees, mean beam | 0.84 | 0.85 (agree 89%) |
| under a crown edge | 0.44 | 0.60 (agree 64%) |
| deep under canopy | 0.21 | 0.51 |
| sky view, open near trees | 0.82 | 0.83 |
| sky view, under a crown edge | 0.43 | 0.59 |

Open ground near trees right; under crowns too bright. Weak evidence for a
Michigan lawn: the bare flight itself already passes 0.56 of the beam under
deep canopy that the summer flight has at 0.21, so the winter laser saw
sparse crowns the summer laser saw dense -- old low-density flights,
evergreens called from a thin winter cloud, or cypress and other Southern
deciduous trees; not separable from six windows.

A second pass sampled 60 eastern and midwestern metros by the POINTS' OWN
GPS CLOCKS (flightDays), not WESM's dates: no sample point anywhere had a
summer flight and a bare flight within 3 years. The test the owner asked
for cannot be run on northern broadleaf streets from the public catalogue.

WESM'S SEASON LABELS ARE RIGHT: of 145 flights sampled whose WESM season
was on or off, the points' clocks agreed on 144. The one miss is
USGS_LPC_PA_Allentown_2016_LAS_2017, listed as August 2016 and flown on
2016-03-26 (leaf-off). The map's season call (find.js leafSeason from
WESM) stands; no change needed.

SATELLITE LEAF-FALL DATES (MODIS MCD12Q2 MidGreendown, 500 m, median of
2014-2023, 3 x 3 pixels) against the calendar's half-shade-gone day:

| | satellite | calendar | satellite minus calendar |
|---|---|---|---|
| HARV / BART / UNDE / TREE (northern forests) | Oct 7 / Oct 3 / Sep 24 / Sep 21 | Oct 10 / Sep 26 / Sep 24 / Sep 24 | -3 / +7 / 0 / -3 |
| SCBI / SERC / BLAN / UKFS / MLBS / GRSM | Oct 7 / 12 / 20 / 2 / 1 / 14 | Oct 22 / 27 / 22 / 18 / 16 / 24 | -15 / -15 / -2 / -16 / -15 / -10 |
| ORNL / DELA (south) | Oct 5 / Sep 28 | Oct 29 / Nov 19 | -24 / -52 |
| the owner's neighbourhood | Oct 27 | Oct 5 | +22 |

At forests the satellite runs 0-15 days EARLIER than the calendar (colour
fades before the shade goes, finding 2); at the owner's it runs 22 days
LATER, so about a month later than forest behaviour predicts. CAVEAT: a
500 m suburban pixel is half lawn, which stays green to frost and drags
the green-down date late; the satellite cannot separate the trees from
the grass there. The owner's eyes, the overcast sky view and the sunny
leaf scan (17) remain the evidence that the lawn trees were in leaf.

### 19. The branch floor: leaves and a tree's solid fill end at its lowest branches; the laser's own clock dates each flight (2026-10-15)

Owner, 2026-10-15: "just because we didn't measure a real world example
where that caused issues, doesn't mean we shouldn't fix it... A lone tree
on top of a hill could be falsely predicted to have way more shadow when
the sun is low." Rule adopted: a change toward how trees are is made
unless a measurement shows it hurts.

THE FIX (seasonal.js, SHIPPED as the default): a column's leaves start at
its BRANCH FLOOR, the height under which only a tenth of the crown returns
within 2 m fall (the tenth, not the lowest: the lowest-return rule made
small crowns 6 points too dark on NEON's leaf-on laser, one stray return
dragging a crown's leaves to the grass), not at its clump's base; and a
tree's solid fill under a layer nothing got through ends at that floor too
(a pine's trunk in open air; a spruce reaching the grass stays solid;
roofs untouched; canopy.js now records what it filled). In the test scene
(a tall tree, crown 8-16 m, joined to a 3 m shrub, the sun 20 degrees up
passing under the crown) the old fill let 4% of the sun reach the phone
behind it, the fix 100%; straight down through the crown the shade is
unchanged.

MEASURED, each part alone and together (the three yardsticks):

| | NEON leaf-on laser (open / edge / deep / small crown, beam vs truth) | NEON forest floors in leaf (measured 1.9 / 3.1 / 3.4 / 2.8%) | owner's readings 2026-10-13 |
|---|---|---|---|
| shipped before | 0.83/0.85, 0.38/0.39, 0.07/0.12, 75% 0.38/0.46 | 2.4 / 3.3 / 3.0 / 1.6 | 3,157 of 3,913 |
| floor (10th pct) alone | 0.83, 0.39, 0.07, 76% 0.38 | 3.5 / 3.1 / 3.3 / 2.0 | - |
| unfill alone | 0.83, 0.38, 0.07, 76% 0.40 | 2.4 / 3.3 / 3.0 / 1.6 | - |
| leaves where the branches were (spread) | 0.83, 0.39, 0.08, 76% 0.40 | 5.2 / 5.0 / 3.9 / 2.2 | - |
| floor + unfill (SHIPPED) | 0.83, 0.39, 0.08, 77% 0.40 | 3.5 / 3.1 / 3.3 / 2.1 | 3,153 |
| floor + spread + unfill | 0.83, 0.39, 0.09, 77% 0.41 | 5.5 / 4.9 / 4.2 / 2.5 | 3,153 |

"Leaves where the branches were" (muOn weighted by the leaf-off returns
per cube) brightens closed forest floors by 2-3 points: the winter laser
sees a canopy's top branches far more than its lower ones, so leaves
weighted by returns sit too high in a forest. Not used. The shipped pair
is better or equal on the laser, neutral on the floors (3 of 4 sites
nearer; mean miss 0.60 against 0.58 points), and 4 readings of 3,913 lower
on the owner's day: within noise all three ways.

CROWN "CLUMPING" (x0.7, x0.5 per meter) is not shipped and is not a
missing piece of physics: the model is a 3D block model, so a ray through a
crown's edge already crosses fewer leafy blocks; the test only thinned
every crown. The leaf density per block is an effective value that already
holds within-crown clumping (seasonal.js 3), and two yardsticks put it
about right (edges 0.39 = 0.39; forest floors within a point).

THE LASER'S OWN CLOCK (las.js gpsMs, gpsTimes; ept.js flown; find.js
flightOf; the page and shade-site.js). WESM, the catalogue the map asked
for a flight's dates, answered every query with an error body for hours
on 2026-10-15; with no season the light worker added no leaves and every
tree stood bare. Now each flight's dates come from the points' GPS times
(right for 144 of 145 flights sampled across 60 metros, 18); WESM is the
fallback for files with no usable time. Entwine's node files on AWS say
"week time" in the header and hold adjusted standard time, so the value
decides (under a week: unusable; else standard). One project can hold two
flights years apart in one box (Ottawa County: April 2016 and April 2018),
so the season is judged node by node.

## Speculation

- Mixed-season flights (7) may be better treated as leaf-on for the
  evergreen call (no evergreens called): it would have cut the light cost
  at HARV, BART and TREE, but the page treats mixed as leaf-off for the
  leaves too, and that wants its own test.
- Winter (4) may differ by how much wood the lidar sees per site (Wasser
  2013: leaf-off lidar under-reads bare crowns); no correction is warranted
  by these numbers.

- Deep tree shade read as sun (9) -- not the new build's (its readings
  were edges): trees cut or thinned since the 2018 flight, crowns called evergreen that are not, or GPS at a crown's edge.
  Per-tree, not tested.

- The fill's lean dark near trees (13, ~5 points of beam) may be a small
  part of the owner's "too dark near trees" (9, 11), not most of it.

- Per-stop GPS wander (12) may be behind part of the edge misses (1,867
  readings at 66%); an independent fix (the truck's resting spot against
  the photo, a surveyed point) would test it without circularity.

- The low-leaf mechanism (11) may matter on lots with tall, high-crowned
  trees joined to understory and a low sun across open lawn; not seen on
  2026-10-13's stops.

- Wood seen from the side (15) by flight month: on for mid-winter flights,
  off for April ones -- would want more April and May flights to test.
- Pine savannas too dark in leaf (15): open-grown pines' crowns filled
  with deciduous leaves, or their needles too dense from the laser's view?

- Leaf-off darkness near trees (6) as ground, not shadow: testable by
  comparing ground on the sunward side of a trunk (no shadow possible) with
  open lawn; not done.

- THE FALL CALENDAR IS EARLY FOR LAWN TREES (17)? Measured here: the
  owner's eyes, the overcast sky view and the sunny readings all put the
  lawn trees at 50-100% of their shade on Oct 13-14, where the calendar
  (fitted to NEON forest floors, finding 2) has 14-21%. Published phenology
  says city trees in cold regions drop later than forest (Li et al. 2021,
  Global Ecology and Biogeography; USA-NPN). The old rule (half the shade
  gone on the 10 C day, no two-week lead) would give about 68% here on Oct
  14. One region, one fall, one week: wants another region or another
  year before the calendar changes for every lawn.

## Bookmarked tests (asked for, not yet run)

- TWICE-FLOWN STREETS: RUN 2026-10-15, finding 18. No broadleaf-town pairs
  exist in the catalogue; Florida only.