# Where the yard AR tool diverges from the shade map's output

The owner, 2026-11-04: "I want the AR to perfectly follow the shade map's output at this point... We will try to
solve issues in the shade map first, but the AR is allowed to make changes on top of that for issues that only
affect the AR. Maintain a doc that describes every way in which the AR diverges from the shade map."

This is that document. The AR reads the shade map's finished model (public/lib/lidar-model.js, docs/MAPS.md "The
finished lidar model") and rebuilds nothing: no lidar point is read, no height is judged, no tree-versus-building
rule is run here. Everything below is a step taken ON that output, for the match or the camera view, and each is
the AR's own. A line not here is a bug: either the AR is doing something unlisted, or this file is behind the code.

The code: scan/lib/lidar-load.js (gridsFromModel) and scan/lib/lidar.js (buildGrids, placementCost, register).

## 0. Not about the lidar, but about trusting it

None of these change what the model says. Two page-side rules sit on top of every step below (scan/lib/locate.js):
the page HOLDS one fit and moves it only when three fixes in a row agree it is wrong (2026-11-05, the owner:
"trust the ar engine for longer periods of time"), and it draws the lidar at the height the phone's own ground points
say, not the crosshair's (groundOffset).

## 1. The 1 m columns are put on a 0.25 m grid in map metres

The model's columns are in EPSG:3857; the match works in metres round the map's origin. Each fine cell takes the
value of the column under its centre (scan/lib/lidar.js buildingsOnGrid, valuesOnGrid): a resampling, nothing
inferred. The ground between columns is therefore stepped at 1 m, not smooth.

## 2. Which columns are solid for the match

The phone's "standing" points are the depth points 0.4 to 2.4 m over its ground (scan/lib/locate.js BANDS). A
column is solid for them when it has something OF ITS OWN in that band, read from the file in this order:
`low` (its lowest own return over the grass, exact) in the band; else any own `returns` in a cube overlapping the
band; else, for a file written before the evening of 2026-11-04, any leaf (`mu` > 0) in such a cube. The last is
the pooled canopy, and shade findings 35 measured why it is last: on the owner's lot 59% of the crowned columns it
called solid were solid only because canopy.js pools a sparse flight's neighbours (right for light, wrong for a
wall), and 8% only because a 1 m cube reached a crown's underside. A file with none of the three falls back to
the kind alone: every TREE, SOLID_TREE, STRUCTURE and UNKNOWN column, whole. The numbers are all the shade map's;
only the band is the AR's, and it is the band its own points are taken at.

Not done any more (removed 2026-11-04): the AR's own band of lidar points 0.25-2.5 m up; its own roof rule
(the water map's buildingMask) as a fallback; skipping low points under crowns 3 m or taller (CROWN_M); treating
unclassified points under 1.2 m inside the traced lawn as ground (LAWN_LOW_M); drawing a wall 3 m tall when its
height was unknown. Phantom columns under canopies are the shade map's to fix (the owner: "don't do anything to
hide them on your end unless the shade map determines that we can't solve that").

## 3. A building is matched and drawn as its walls, not its roof

The phone cannot see into a house, and points landing inside a solid footprint would cost nothing wherever they
went. So a BUILDING column is not solid; its walls are. Where the walls stand is the shade map's rule, structures.js
wallsOf (2 ft in from the roof's edge, the owner's number), run on the model's BUILDING columns; the AR takes that
mask's OUTLINE as the solid cells. A STRUCTURE (a stone wall, a shed, bins) has no eaves and is solid at its own
edge, i.e. by step 2.

## 3b. Straight things made straight (2026-11-05)

The owner: "let's do the shape/line cleaning for roofs and objects that we think are actually straight. Let's not touch
trees. But tree trunks i believe currently get averaged to 1m, so let's just make those a thin line." From the
model's 1 m columns (scan/lib/outline.js, scan/lib/lidar-load.js straightShapes):

- **Buildings**: each BUILDING patch's outline is traced, fitted with straight sides (a line through the staircase's
  steps), and sides within 12 degrees of the building's main direction, or square to it, are turned onto it. The
  walls are that outline moved 2 ft in (the shade map's WALL_INSET_M), in place of wallsOf on the columns. An edge
  that runs along the grid cannot be helped: whether its edge column is roof is a toss-up the model already made, so
  such an edge stays within half a column; a turned edge comes out within centimetres.
- **Structures**: a long thin STRUCTURE patch (three times as long as wide: a wall, a fence) is one line through its
  middle, 30 cm wide; any other (a shed, bins) is its straightened outline.
- **Trunks**: a patch of up to 4 standing tree columns under a crown (a column top 3 m or more) is one post, 30 cm each
  way (a trunk's own surface; the match's own 30 cm hit radius), at the centre of the columns' own returns at standing
  height, each column's place moved to where its own standing returns are (the shade map's lowDx, lowDy, since
  2026-11-05); without them, to the column centre, within half a column.
- **Not touched**: bigger patches of standing tree columns (hedges, bushes, a low crown), UNKNOWN columns, the canopy.

, and the roof's edge is a target of its own

Owner, 2026-11-03: walls are "USUALLY within 2 feet of the overhang... sometimes 1 foot or less, other times 10
feet (an all-seasons room or large front porch)". So the match does not insist on the drawn wall: a run of phone
points along a building is a piece, its distance inside the roof's edge is measured across itself (8 headings),
and it is charged only for being outside the usual 1 ft to 3 ft (WALL_USUAL), a little, up to a cap. The phone's
points 2.4 m and more up (gutters, fascia) are matched to the roof's edge itself (distRoof). The roof's edge here
is the model's column edge, so a wall or an edge is known to the AR only to its 1 m column; a fix that rests on
walls and trunks is free by up to half a column each way, and two fits closer than 1.5 m are one place
(SAME_PLACE_M), not two.

## 5. The traced lawn is NOT used (removed 2026-11-05)

Until 2026-11-05 the ground points the camera saw as grass or paving were matched against the lawn the person
traced. The owner: "lawn traces shouldn't be used anymore to get a fix. We can use hard edges with vision or lidar
brightness, but not the actual geometry of the lawn traces." The walk of 2026-11-04 22:02 agreed: its asks carried a
median 2,132 such points weighed 8 times against 32 standing points, and its kept fixes sat a median 2.2 m from the
references, which the check points put within half a metre. The colour is still read and kept in the twin; the
match is not given it, nor the trace. Lidar brightness would be a column array the shade map writes; it does not yet.

## 6. The camera view draws the model's columns

Solid cells (step 2 and 3) are drawn as blue boxes. A building's wall stands to its column's `top`. Anything else
stands from its lowest own return up through the cubes that have own returns without a gap (0.5 m at least, 15 m
at most, for legibility), so a trunk under a crown is a post, not a wall to the treetop (the owner, 2026-11-04: "in
AR, I'm seeing blue walls under those same canopies"; shade findings 35: one low cube, a median 2 m of air, then the
crown). A file without per-cube returns draws to the column's top as before. Every other column with anything in it
is drawn as a green box from its lowest cube with leaf (`mu` > 0) to its top. Buildings are drawn orange from the
straightened outline the match uses (step 3b), as runs along the match's 0.25 m rows, not as 1 m columns; a trunk
made into a post is drawn as the post, its column green only from 2.4 m up (2026-11-05: the owner saw none of the
straightening, because the drawing still showed the raw columns).
Each run stands to the roof's own height: a run breaks where the column top changes by more than 0.3 m (2026-11-07:
the owner's screenshot showed a gable drawn as a flat block, every row at its highest cell, the ridge). The drawing
shows only the nearest lidar surface at each pixel (a depth pass first), so the far side of a house or a shape behind
it no longer shows through; pins and marks are drawn over it all. The real world does not yet hide the lidar.
Nothing is drawn that the model does not have.

## 7. Which canopy: `mu`, as flown

The shade map writes two canopies (public/shade/model-out.js, 2026-11-04): `mu`, the canopy as the laser saw it
with erasures applied, and `muOn`, the same with every deciduous crown in summer leaf, which it blends by the day.
The AR reads `mu` only: what stands at the phone's height is the same in both (the leaf fill never reaches below a
crown's branch floor), and for drawing the canopy the laser's own answer is the honest one. A file too big for
`muOn` changes nothing here.

## 8. What the AR does not take from the model

The fences drawn in the shade map's step 1 (its part's `fences`) are not read yet; the person's erased cells are
already applied in the model and need no reading. The model's `why` is not used.

## 9. Trees are not in the match (2026-11-06)

The owner: "lidar tree trunks are not reliable. I'm working on that with the shade map. For now, we need to ignore
them." scan/lib/lidar-load.js straightShapes drops every TREE and SOLID_TREE column from the solids the live fix and
the after-the-walk fix may rest on (no trunk posts either); buildings, walls and STRUCTURE stay. The drawing is
unchanged. `treesInMatch: true` (the tests) restores step 3b's posts. Goes when the shade map's trunks are trusted.
