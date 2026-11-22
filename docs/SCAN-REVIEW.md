# The yard walk: a review of the approach (core session, 2026-11-20)

The owner: "do a high level thinking/research exploration to see if there's any course corrections and
refinements that we should consider. Just a really thorough examination of how we can do this better."

Three kinds of statement, kept apart: MEASURED HERE (docs/SCAN-PLAN.md 30-34), FROM SOURCES (web research of
2026-11-20, four threads; a source's own claim is not our measurement), and JUDGEMENT (the core session's, untested).

## 0. The goal, and where the work stands against it (kept current; last 2026-11-22)

The goal is the owner's, word for word in CLAUDE.md ("THE GOAL OF THE YARD AR TOOL"). Each line of it, and what is
actually so (MEASURED unless marked; section numbers are docs/SCAN-PLAN.md's):

| The goal | Where it stands |
|---|---|
| First walk: a baseline fix to the lidar | Two or three roof corners place a walk. The phone reads their distances about 5% short of the map at the owner's lot and 2% elsewhere (50); with three corners the fit may scale, with two it cannot. Which side is off is not settled. |
| First walk: a shape mesh for later walks | Not a mesh yet. What is kept: the walk's standing and ground points as the map's reference (walkref.js), and for the viewer a joined cloud of 11 in cells with a kind each (dense_prep.py). A walk comes back to itself within 6-20 in across 12 minutes once its first 1.5-2 minutes are left out (48). |
| Walk 2 on: fixed by the reference's shapes | Built (the live shape fix from an earlier walk) but NOT proven: the one time it was watched (2026-11-21, first short walk) it moved the walk 675 in, off a reference saved from two corners that disagreed. A reference must be judged before it is used. |
| Place sprinkler heads, gutters | Not built. The page has plain pins and tape measures; none carries a kind or is kept with the map. |
| Fences, trees placed by themselves | Kinds are voted onto points: grass, built, paved, tree against plant by height (36, 44). Fences get almost no points (59 of 350,000 on the big walk). Trunks are not picked out. Bare branches get nearly no depth at all: the phone's depth does not see them. |
| Lawn trace refined, missing buildings, slope | Not built. The ground comes out in levels about 5 in apart; a 6 ft hill read 4.5-5 ft to the owner's eye (not measured). |
| Each walk adds to the reference; overwrites only when surely better | The merge exists (refkeep.js mergeRef, updateRef); "surely better" is not yet a measured rule. |

JUDGEMENT, the order that follows from it: (1) one walk agreeing with itself, start cut and all, as a kept SHAPE
(the first row's mesh), because every later row stands on it; (2) a reference judged before it is trusted, then
walk 2 fixed by it and scored by its own corners; (3) the things a person places (sprinkler heads, gutters), which
need only (2); (4) trunks and fences from the classes; (5) trace, buildings, slope. Bare branches wait on a depth
the phone does not give (a depth model on the photos is the one lead).

## 1. Where the present approach strains

MEASURED HERE
  - A photo's raw depth has a distance under a fifth of its cells; 13% of a walk's shapes can be placed in 3D.
  - 45% of the points the owner's names reach take two different names from different photos.
  - The ground lies in levels about 5 in apart; two visits to one spot differ by 5-6 in; one visit is 4 in thick.
  - The phone's own labels agree with the owner's names where the classes are big: grass -> terrain 97%, tree 98%,
    building -> building/structure 95%. 73% of the points the owner erased by hand the phone had called sky.

FROM SOURCES
  - ARCore depth is stereo from the phone's own motion, "most accurate" from 0.5 to 5 m; plain surfaces "usually"
    get confidence zero, so a fifth of a lawn photo having depth is expected, not a fault. One independent test
    (indoors, one phone) found 23-30 cm mean error, falling as the confidence cut rose to about 0.6. Ours is 0.2.
    developers.google.com/ar/develop/depth ; developers.google.com/ar/develop/java/depth/raw-depth ; arXiv 2204.01693
  - Raw depth is not new on every frame: an unchanged timestamp is old depth put under a new pose.
  - ARCore's tracking: 0.07 m off after a 514 m outdoor loop, 3.98 m after 114 m of stairs (arXiv 2207.06780);
    height is its weak axis; it jumps when it recognises a place, rightly or wrongly (arXiv 1807.09828). 5-6 in over
    a walk is ordinary.
  - Geospatial depth draws Street View's building and terrain meshes INTO the depth pictures, raw included.
  - Under dense low plants neither photos nor lidar find the ground: they find the top of the grass (EGU2020-20468).
    Inch-level ground from photos is reported only on small plots with fixed reference marks. The airborne lidar
    is itself good to about 10 cm in height.
  - The standard shade model (SOLWEIG/UMEP) and every drainage method read a 2.5D model: a ground height grid, a
    grid of what stands on it and how high, a canopy top and bottom. None reads a free 3D cloud.
  - Robot mowers ask one question a frame, grass or not, and keep a flat map. Nobody found builds a named 3D yard.
  - No product was found that measures a yard from an Android phone without a lidar sensor, with a tested accuracy.

## 2. Course corrections, most worth doing first

A. NAME PIXELS, NOT SHAPES; VOTE INTO THE MAP. (JUDGEMENT, on sources.) The hard part of the present pipeline is
   deciding that a shape in one photo is the same thing as a shape in another. The classes that matter are few and
   coarse, and they do not need that question answered: give every pixel of every photo a class, and let each
   point or map cell take the vote of every photo that saw it, weighing near and square-on views more. This is the
   long-standing way to label a noisy map (arXiv 1609.05130, 2303.07836). It replaces the cut into shapes, the
   matching, and the namer; every pixel votes, so sparse depth costs coverage in 3D but not names; two names on
   one point become a margin instead of a conflict. Voters: the phone's own labels (already recorded, free), a
   picture model with ground classes (COCO-Stuff, ADE20K or Mapillary labels folded to the owner's key; free on
   the CPU runner or 2-4 cents on a GPU), and for what those call "other" (machinery, bins) a model asked by name.
   THE OWNER'S 799 NAMED SHAPES ARE THE TEST: every candidate can be scored against them at no cost.

B. THE LIDAR IS THE FRAME; THE WALK ADDS TO IT. (JUDGEMENT, on sources.) The finished thing is a 2.5D map on the
   lidar: per cell, what the surface is, and what stands there and how high (with its underside for canopies).
   The walk supplies what the air cannot see. The 3D view stays as the owner's window on the evidence.

C. PUT EACH STRETCH OF A WALK ON THE LIDAR'S GROUND. (JUDGEMENT; the between-visits gap is MEASURED.) Fit a height
   offset (and tilt) for each 10-20 m of the track against the lidar ground under it, using only sure, near
   ground points, and split stretches where the pose jumps. Free. Then measure the levels again: if they close,
   drift was the cause. If the passes still disagree, correct the poses themselves from matched picture features
   across passes (ALIKED + LightGlue, bundle adjustment with the phone's poses as priors; CPU, free, 10-30 min by
   estimate).

D. TIGHTER DEPTH FOR GROUND, AND TWO CHECKS OF THE RECORDING. (FROM SOURCES; to be measured here.) Ground from
   near range and higher confidence; the new uncut raw grid lets a study choose the cut. Check that depth with an
   unchanged timestamp is never fused twice, and measure a walk with Geospatial depth off against one with it on.

E. DENSE DEPTH AFTERWARDS, FOR THINGS RATHER THAN GROUND. (FROM SOURCES; costs are the researcher's estimates.)
   The owner's projection idea exists as MapAnything (Sep 2025): it takes photos, known poses and sparse depth and
   returns dense metric depth consistent between views; one checkpoint is Apache-licensed. Estimated 3-8 GPU
   minutes a walk, 4-10 cents. Per-photo filling (Prompt Depth Anything, in transformers, Apache) is 1-3 cents but
   does not agree between views. Classical dense stereo is 40 cents to $1.20 and weakest on grass. None of these
   repairs drift; C comes first.

F. HOW TO WALK. (FROM SOURCES, thin.) Slowly; some sideways movement, since walking straight along the view gives
   stereo little to work with; fences, walls and trunks in frame; one closing loop. A second pass over the same
   ground hurts until C is in place.

## 3. What is probably out of reach (JUDGEMENT, on sources)

  - Humps and hollows of an inch or two across a whole yard from a walk: grass hides the ground and drift is as
    big as the thing sought. THIS CONTRADICTS A STATED AIM of the owner ("map legitimate low and high spots") and
    is theirs to decide; C will show how thin the ground can be made first. Slope and flow can come from the
    lidar; single low spots from the owner marking them, or a deliberate close, slow look at that spot.
  - Thin things (wire fence, thin trunks) found and named by themselves.

## 4. What this means for work in hand

  - Re-cutting the photos with the big shapes kept: not worth paying for if A works. Held.
  - The naming page and the 3D view: kept; the names are now the test set, the erasing the test of each filter.
  - Paid GPU: nothing in A, C or D needs it. E is one or two trial runs, under $2 by estimate.
