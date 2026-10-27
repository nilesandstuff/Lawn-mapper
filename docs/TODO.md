# To do

The owner's list, kept by the core session. Newest asks first within each
part. When something is done, move it to "Done" with the date and the commit
or run that did it. Detector work is recorded in docs/DETECTOR-FINDINGS.md;
this file only points there.

## Asked for, not started

### 1. Research: sections cut automatically from words (owner, 2026-10-24)

Find a lightweight way to cut a lawn into sections from a word prompt:
"front yard", "back yard", "side yard". The test case is the Byron Center
condo complex: "what's the total combined sqft of the front yards on the
inside of the loop".

- Compare two routes. An open-vocabulary image model (text-prompted
  segmentation) is one.
- The other is geometry we already have: the property line, the house
  footprints, and the street (Overture roads, public/lib/frontage.js). "Front"
  is the lawn between a house and the street it faces, "back" is the side
  away from it. That needs no model and may be the stronger answer.
- "Inside the loop" needs the road network as a shape: which side of a
  ring road a section sits on.
- Output feeds the sections tool (public/sections.html): the auto-cut sections become ordinary sections the
  owner can adjust.
- Research first, with a recommendation and cost (free runner only unless
  the owner approves Modal). Nothing is built before the owner chooses.

## In progress



- **Storm drains everywhere.** The nightly sweep (workflow 44) reads ~60
  county servers a night, and the live search runs where people look.
  NCDOT's pipes are retried tonight.

## Waiting (older core work)

- Training on county outlines, plus two free-runner runs.
- Live county imagery: catalogue, lookup, default provider, detect.
- A live tile cache for newer USGS lidar (Modal volume lawn-lidar-tiles).
- S60: CHMv2 as the roof-against-tree separator in the roof mask and the
  canopy input.

## Done

- 2026-10-27: the saved lawn picture frames the whole property line and
  every lawn shape with a margin, with the caption bar below the map, and
  is named for the house number and street (01db59c; browser test 40603419208).

- 2026-10-27: the lawn sections tool, its own card on the dashboard
  ("Lawn sections", /sections?map=<id>). Slice, free draw, square, shape
  and join; borders of zero thickness, so the sections always add up to
  the lawn (tools/sections.test.js checks every cut). Each section
  shaded, named and sized, kept as the map's `sections` part. A lawn
  redrawn later is fitted to: sections trimmed, new lawn made a section.

- 2026-10-27: each lawn area in the editor labelled with its size
  ("1.1 k sqft"), inside the shape, following a dragged corner, hidden on
  shapes too small to hold it. Shared with the sections tool
  (public/lib/size-label.js).

- 2026-10-27: the detector's answer trusted under small trees on leaf-off
  photos, live (H127; owner's choice). Three seeds: never worse on seen
  ground, 6 lots better / 1 worse overall.

- 2026-10-26: inferred marks left out of training (S66) measured as worse,
  H128 (runs 40369587372 and 40369617314, linked as twins on the
  predictions page). Not adopted. Comparison runs are now independent and
  linked afterwards by workflow 24 or the page's twin picker.

- 2026-10-25: trusting the detector under trees in the open (S63) measured
  as not a gain, H123 (run 40127014446). Off. A narrower version (only where
  the AI is 70%+ sure) is an untested idea.

- 2026-10-24: why the condo's small front patches were dropped (workflow 32
  run 40127224975): mostly the AI's confidence just under 50%, and under
  trees the tree step clearing them; not the size limit or the lidar. See
  the run log in docs/DETECTOR-FINDINGS.md.

- 2026-10-24: the confidence slider ("How sure the AI must be", 20% to 80%)
  and lawn pieces down to 100 sq ft (commit 7c5bd1d).
- 2026-10-24: water layers searched the moment someone looks at a place
  (47c9eb6), and 15 statewide drainage inventories (ece3ab1).
