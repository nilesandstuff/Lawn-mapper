"""
That a canopy patch's outline keeps the clearings inside it.

The bug this guards was found in the pictures: a treeless patch of grass the
size of a house, ringed by woods, drawn as canopy because the outline was the
longest contour and nothing else. The raw mask was right and the outline was
wrong, and the two overlap numbers workflow 19 reports were counted on the
outline.

    python3 tools/canopy_test.py
"""

import numpy as np

from clumps import clumps_for, outlines_for


def blob(h, w, boxes):
    m = np.zeros((h, w), dtype=bool)
    for y0, x0, hh, ww in boxes:
        m[y0:y0 + hh, x0:x0 + ww] = True
    return m


def area(ring):
    """Shoelace, on [row, col] points."""
    r, c = ring[:, 0], ring[:, 1]
    return 0.5 * abs(np.dot(r, np.roll(c, 1)) - np.dot(c, np.roll(r, 1)))


passed = 0


def check(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"PASS  {name}")


# A solid block has an outline and no holes.
solid = blob(60, 60, [(10, 10, 40, 40)])
outer, holes = outlines_for(solid, tolerance=1.0)
check("a solid patch has an outer ring", outer is not None)
check("and no holes", holes == [])
check("its outer ring is about the block's area", abs(area(outer) - 1600) < 120)

# A block with a clearing in it: the clearing comes back as a hole ring.
wood = blob(60, 60, [(10, 10, 40, 40)])
wood[25:35, 25:35] = False
outer, holes = outlines_for(wood, tolerance=1.0)
check("a clearing inside a patch is a hole", len(holes) == 1)
check("the hole is about the clearing's area", abs(area(holes[0]) - 100) < 25)
check("the outer ring still goes round the whole patch", abs(area(outer) - 1600) < 120)

# A gap smaller than the minimum is a gap between branches, not a clearing.
_, small = outlines_for(wood, tolerance=1.0, min_px=200)
check("a hole under the minimum is dropped", small == [])

# Two clearings are two holes.
wood2 = blob(60, 60, [(10, 10, 40, 40)])
wood2[14:20, 14:20] = False
wood2[38:46, 38:46] = False
_, two = outlines_for(wood2, tolerance=1.0)
check("two clearings are two holes", len(two) == 2)

# A bay open to the outside is not a hole: it is part of the outer boundary.
bay = blob(60, 60, [(10, 10, 40, 40)])
bay[10:30, 25:35] = False
_, none = outlines_for(bay, tolerance=1.0)
check("a bay open to the edge of the patch is not a hole", none == [])

# CANOPY RUNNING OFF THE FRAME (B09, 2026-10-04): most of the picture is
# canopy, with open ground inside it. The outline must go round the canopy,
# along the frame's edge, not round the open ground.
edge = np.ones((60, 60), dtype=bool)
edge[20:40, 20:40] = False          # a clearing in the middle
edge[0:15, 45:60] = False           # open ground in a corner, off the frame
outer, holes = outlines_for(edge, tolerance=1.0)
check("a patch running off the frame is outlined round the canopy, not the gaps",
      abs(area(outer) - (3600 - 225)) < 150)
check("and its clearing is a hole, the open corner is not", len(holes) == 1 and abs(area(holes[0]) - 400) < 60)
check("the outline stays on the frame", all(-1 <= y <= 60 and -1 <= x <= 60 for y, x in outer))

# clumps_for still splits patches that do not touch.
labels, n = clumps_for(blob(60, 60, [(0, 0, 10, 10), (30, 30, 10, 10)]))
check("two separate patches are two clumps", n == 2)
check("an empty mask has no clumps", clumps_for(np.zeros((4, 4), dtype=bool))[1] == 0)

print(f"\nAll {passed} checks passed.")
