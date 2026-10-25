# To do

The owner's list, kept by the core session. Newest asks first within each
part. When something is done, move it to "Done" with the date and the commit
or run that did it. Detector work is recorded in docs/DETECTOR-FINDINGS.md;
this file only points there.

## Asked for, not started

### 1. Each area labelled with its size (owner, 2026-10-24)

Subtle text in the middle of each lawn area with its size, written like
**"1.1 k sqft"**.

- Format: under 1,000 as is ("850 sqft"); from 1,000 one decimal in
  thousands ("1.1 k sqft"); from 10,000 whole thousands ("12 k sqft").
- Placed inside the shape, not at its centre point, which can fall outside
  an L-shaped or ring-shaped area. `placeInside` in public/lib/frontage.js
  already finds such a spot.
- Moves and updates as the shape is edited; hidden on areas too small to
  hold the text.
- Where: the lawn editor first; the sections tool (item 2) would use the
  same labels.

### 2. Measure lawn sections: front, back, side (owner, 2026-10-24)

A tool opened from the dashboard that loads a saved map in a simplified
viewer. It has the same general look as the main editor, trimmed down, for
splitting the lawn into named sections and reading each one's size.

- **Tools:**
  - **Slice:** draw a straight line through an area to cut it in two.
  - **Free draw:** cut along a hand-drawn line.
  - **Square:** drag a rectangle to cut out the part of the lawn inside it.
  - **Shape:** place points to make a polygon that cuts its area out of
    the existing sections.
- **Borders of zero thickness.** The cut pieces share their borders
  exactly, so the sections always add up to the lawn's total: no square
  foot lost or added. A test should check that the sum equals the whole.
- **Each section shaded differently,** with its size label (item 1), and
  ideally a name (front, back, side...).
- **Saved with the map** as the tool's own part (POST /api/maps/tool,
  docs/MAPS.md), like the other tools.
- **Open question (owner):** a tool of its own on the dashboard, or folded
  into the lawn mapper. Undecided.
- **Related:** the existing "Calibrate product usage by area" tool (slices)
  cuts the lawn into equal pieces automatically for spreader calibration.
  The sections tool is user-drawn and different, but the two could share
  the cutting code.

### 3. Research: sections cut automatically from words (owner, 2026-10-24)

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
- Output feeds item 2: the auto-cut sections become ordinary sections the
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
