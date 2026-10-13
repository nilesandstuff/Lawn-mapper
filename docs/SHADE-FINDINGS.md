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

## Speculation

- The pines (3) might be told apart by crown shape or by a leaf-off photo
  that shows them green; untested. The evergreen rule is the owner's
  choice (2026-10-11), so a change goes to him first.
- Winter (4) may differ by how much wood the lidar sees per site (Wasser
  2013: leaf-off lidar under-reads bare crowns); no correction is warranted
  by these numbers.

## Not yet in

- Aerial photo shadows on the corpus lots (tools/shade-check-naip.js, NAIP
  every leaf-on year; tools/shade-check-imagery.js, the county photos and
  Mapbox): running.
