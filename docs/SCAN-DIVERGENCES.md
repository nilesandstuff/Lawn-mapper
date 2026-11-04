# Where the yard AR tool diverges from the shade map's output

The owner, 2026-11-04: "I want the AR to perfectly follow the shade map's output at this point... We will try to
solve issues in the shade map first, but the AR is allowed to make changes on top of that for issues that only
affect the AR. Maintain a doc that describes every way in which the AR diverges from the shade map."

This is that document. The AR reads the shade map's finished model (public/lib/lidar-model.js, docs/MAPS.md "The
finished lidar model") and rebuilds nothing: no lidar point is read, no height is judged, no tree-versus-building
rule is run here. Everything below is a step taken ON that output, for the match or the camera view, and each is
the AR's own. A line not here is a bug: either the AR is doing something unlisted, or this file is behind the code.

The code: scan/lib/lidar-load.js (gridsFromModel) and scan/lib/lidar.js (buildGrids, placementCost, register).

## 1. The 1 m columns are put on a 0.25 m grid in map metres

The model's columns are in EPSG:3857; the match works in metres round the map's origin. Each fine cell takes the
value of the column under its centre (scan/lib/lidar.js buildingsOnGrid, valuesOnGrid): a resampling, nothing
inferred. The ground between columns is therefore stepped at 1 m, not smooth.

## 2. Which columns are solid for the match

The phone's "standing" points are the depth points 0.4 to 2.4 m over its ground (scan/lib/locate.js BANDS). A
column is solid for them when the shade map's own cubes between those two heights over its ground hold any leaf
(`mu` > 0): a trunk, a hedge, a shed, a stone wall, an unknown thing -- and NOT a crown a person walks under, whose
low cubes the shade map leaves open. The cubes' contents are the shade map's; only the height band is the AR's,
and it is the band its own points are taken at. A file without cubes falls back to the kind alone: every TREE,
SOLID_TREE, STRUCTURE and UNKNOWN column, whole.

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

## 4. Each wall is judged on its own inset, and the roof's edge is a target of its own

Owner, 2026-11-03: walls are "USUALLY within 2 feet of the overhang... sometimes 1 foot or less, other times 10
feet (an all-seasons room or large front porch)". So the match does not insist on the drawn wall: a run of phone
points along a building is a piece, its distance inside the roof's edge is measured across itself (8 headings),
and it is charged only for being outside the usual 1 ft to 3 ft (WALL_USUAL), a little, up to a cap. The phone's
points 2.4 m and more up (gutters, fascia) are matched to the roof's edge itself (distRoof). The roof's edge here
is the model's column edge, so a wall or an edge is known to the AR only to its 1 m column; a fix that rests on
walls and trunks is free by up to half a column each way, and two fits closer than 1.5 m are one place
(SAME_PLACE_M), not two.

## 5. The traced lawn's edge is a match target

Ground points the camera saw as grass or as paving (scan/lib/surface.js, from the camera picture) are matched
against the lawn the person traced in the lawn mapper (the map's shapes, a signed distance field at 0.25 m). This
is the map's lawn trace, not the shade map's output; the shade map has no part in it.

## 6. The camera view draws the model's columns

Solid cells (step 2 and 3) are drawn as blue boxes as tall as the model's `top` for that column (0.5 m at least,
15 m at most, for legibility). Every other column with anything in it is drawn as a green box from its lowest cube
with leaf (`mu` > 0) to its top, orange when the column is BUILDING. Nothing is drawn that the model does not have.

## 7. What the AR does not take from the model

The fences drawn in the shade map's step 1 (its part's `fences`) are not read yet; the person's erased cells are
already applied in the model and need no reading. The model's `why` is not used.
