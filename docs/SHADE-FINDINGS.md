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
JERC 22% / 3%; OSBS 30% / 13%) -- the pines question of finding 7.

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

## Bookmarked tests (asked for, not yet run)

- TWICE-FLOWN STREETS (owner, 2026-10-14): places in the 3DEP catalogue
  flown once in leaf and once without (different projects or years). Build
  the page's model from the leaf-off flight, fill it, and compare it with the
  leaf-on flight of the same trees on residential streets -- the NEON test
  (13) where people's lawns are. First step: list such overlaps from the
  lidar index (public/shade/lidar-index.json, WESM seasons).
