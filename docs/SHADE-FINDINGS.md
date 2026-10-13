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

- Leaf-off darkness near trees (6) as ground, not shadow: testable by
  comparing ground on the sunward side of a trunk (no shadow possible) with
  open lawn; not done.
