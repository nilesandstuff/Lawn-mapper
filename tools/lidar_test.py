"""
The arithmetic of the lidar reader, offline.

Every way this can be wrong is quiet: a raster flipped north-for-south lands
the driveway's returns on the lawn's labels and reports a real-looking AUC
about the wrong ground; an octree walk that misses the coarse nodes reads a
thin cloud as thinner; an AUC with the classes swapped says "coin toss" about
a perfect separation. None of it fails. So the pieces are checked here on
made-up points before a run spends its time downloading real ones.

    python3 tools/lidar_test.py
"""

import numpy as np

from lidar_frame import (
    CLASSES, auc, box_sum, classify, fill_surface, height_png, layers_from, node_box, rasterise,
    separations, summarise, touches, understory_counts, understory_layers, walk,
)

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


# ------------------------------------------------------------- the octree
bounds = [0, 0, 0, 128, 128, 128]
check("the root node is the whole cube", node_box(bounds, "0-0-0-0") == (0, 0, 128, 128))
check("a depth-2 node is a quarter along each side", node_box(bounds, "2-3-0-0") == (96, 0, 128, 32))
check("touching is inclusive of shared edges", touches((0, 0, 10, 10), (10, 10, 20, 20)))
check("and false across a gap", not touches((0, 0, 10, 10), (11, 11, 20, 20)))

# A hierarchy with points at depths 0..2 everywhere, and a subtree file at 2-3-3-x.
tree = {"0-0-0-0": 100}
for k in range(2):
    for i in range(2 ** (k + 1)):
        for j in range(2 ** (k + 1)):
            for z in (0, 1):
                tree[f"{k + 1}-{i}-{j}-{z}"] = 10
loaded = []


def hierarchy(key):
    if key == "2-3-3-0":
        loaded.append(key)
        return 5
    return tree.get(key)


got = walk(hierarchy, bounds, (100, 100, 120, 120))
check("the walk keeps the root and every touching node down the tree",
      "0-0-0-0" in got and "1-1-1-0" in got and "2-3-3-0" in got, str(got))
check("and leaves out the nodes that do not touch the box", "1-0-0-0" not in got and "2-0-0-0" not in got)

# ------------------------------------------------------------- the raster
# A 10 x 10 m box, 2 m cells: 5 x 5. One ground point at the NORTH-WEST corner
# and one canopy point 8 m up at the south-east.
bbox = (0, 0, 10, 10)
pts = np.array([
    [0.5, 9.5, 100.0, 4000, 2],   # ground, NW: row 0, col 0
    [9.5, 0.5, 108.0, 500, 1],    # canopy, SE: row 4, col 4
    [9.5, 0.5, 100.2, 30000, 2],  # ground under it, bright
])
r = rasterise(pts, bbox, 2)
check("the grid is 5 x 5 at 2 m", r["n_all"].shape == (5, 5))
check("north is the top row", r["n_ground"][0, 0] == 1 and r["n_ground"][4, 0] == 0)
check("a cell with two returns counts both", r["n_all"][4, 4] == 2 and r["n_ground"][4, 4] == 1)
check("ground intensity is the ground return's, not the canopy's", r["i_ground"][4, 4] == 30000)
check("an empty cell is NaN, not zero", np.isnan(r["i_ground"][2, 2]))

layers = layers_from(r, 2)
check("height is the top return over the ground, about 8 m", abs(layers["height"][4, 4] - 7.8) < 0.01)
check("open ground is height 0", layers["height"][0, 0] == 0)
check("a cell with no returns is height 0, not NaN", layers["height"][2, 2] == 0)
check("the ground surface is filled everywhere", not np.isnan(layers["ground_z"]).any())
check("ground density is per square metre", abs(layers["ground_per_m2"][0, 0] - 0.25) < 1e-6)

z = np.full((3, 3), np.nan, dtype=np.float32)
z[1, 1] = 5
check("fill_surface spreads a single value to its neighbours", (fill_surface(z) == 5).all())

hp = height_png(np.array([[0.04, 3.7, 40.0, np.nan]]))
check("height travels as a tenth of a metre a byte, clamped, NaN as 0", hp.tolist() == [[0, 37, 255, 0]], str(hp.tolist()))

# ---------------------------------------------------------- the understory
# Two cells on flat ground at 100 m. The NW cell is a LAWN TREE: ground, a
# crown at 9 and 10 m, nothing between. The SE cell is WOODS: ground, a shrub
# at 1.5 m, a sapling at 2.5 m, a crown at 12 m. A point at 3.5 m is neither.
wpts = np.array([
    [0.5, 9.5, 100.0, 1, 2], [0.7, 9.3, 109.0, 1, 1], [0.9, 9.1, 110.0, 1, 1],
    [9.5, 0.5, 100.0, 1, 2], [9.3, 0.7, 101.5, 1, 1], [9.1, 0.9, 102.5, 1, 1],
    [9.2, 0.8, 112.0, 1, 1], [9.4, 0.6, 103.5, 1, 1],
])
ground = fill_surface(rasterise(wpts, bbox, 2)["z_ground"])
below, mid = understory_counts(wpts, bbox, 2, ground)
check("the lawn tree's cell: one return below 3 m, none in the band", below[0, 0] == 1 and mid[0, 0] == 0)
check("the wood's cell: three below 3 m, two in the 0.5-3 m band", below[4, 4] == 3 and mid[4, 4] == 2, f"{below[4, 4]} {mid[4, 4]}")
ul = understory_layers(below, mid)
check("understory share 0 under the lawn tree, 2/3 in the wood",
      ul["understory"][0, 0] == 0 and abs(ul["understory"][4, 4] - 2 / 3) < 1e-6)
check("a cell where nothing came back low is NaN, not 0", np.isnan(ul["understory"][2, 2]))
check("box_sum adds the 3x3 square and stops at the edge", box_sum(np.ones((3, 3)))[1, 1] == 9 and box_sum(np.ones((3, 3)))[0, 0] == 4)
check("over 6 m the wood's neighbour inherits its share", abs(ul["understory_6m"][3, 3] - 2 / 3) < 1e-6)
check("a ground-classified point counts as ground even if it sits a metre high",
      understory_counts(np.array([[0.5, 9.5, 101.0, 1, 2]]), bbox, 2, np.full((5, 5), 100.0, dtype=np.float32))[1][0, 0] == 0)

# ------------------------------------------------------------ the classes
truth = np.array([[1, 1, 0, 0]], dtype=bool)
within = np.array([[1, 1, 1, 0]], dtype=bool)
canopy = np.array([[0, 1, 1, 1]], dtype=bool)
c = classify(truth, within, canopy)
check("visible lawn, lawn under canopy, not-lawn under canopy, and outside the line",
      c.tolist() == [[0, 1, 2, -1]], str(c.tolist()))

# ------------------------------------------------------------------ AUC
check("a perfect separation is 1", auc([3, 4, 5], [0, 1, 2]) == 1.0)
check("the reverse is 0", auc([0, 1, 2], [3, 4, 5]) == 0.0)
check("identical distributions are a coin toss", auc([1, 2, 3], [1, 2, 3]) == 0.5)
check("NaNs are left out, an empty side is None", auc([1, np.nan], [0]) == 1.0 and auc([], [1]) is None)

# ------------------------------------------------------- summary and seps
classes = np.array([[0, 0, 1, 1, 2, 2, 3, 3]], dtype=np.int8)
lay = {
    "ground_per_m2": np.array([[1, 1, 0.5, 0.5, 0.1, 0.1, 1, 1]], dtype=np.float32),
    "intensity": np.array([[20, 20, 18, 18, 9, 9, 40, 40]], dtype=np.float32),
    "height": np.array([[0, 0, 6, 6, 9, 9, 0, 0]], dtype=np.float32),
    "n_ground": np.array([[1, 1, 1, 1, 0, 1, 1, 1]]),
    "n_all": np.ones((1, 8), dtype=np.int32),
}
rows = summarise(classes, lay)
check("each class is counted", all(rows[n]["cells"] == 2 for n in CLASSES))
check("the summary keeps the class's own numbers", rows["not lawn, under canopy"]["height_p50"] == 9)
seps = separations(classes, lay)
check("under canopy, denser ground reads as lawn (AUC 1)", seps["under canopy"]["ground_per_m2"] == 1.0)
check("and brighter ground reads as lawn here (AUC 1)", seps["under canopy"]["intensity"] == 1.0)
check("visible: lawn is darker than the pavement in this fixture (AUC 0)", seps["visible"]["intensity"] == 0.0)
check("without the understory layers the separation says None, not a number",
      seps["under canopy"]["understory"] is None and rows["visible lawn"]["understory_p50"] is None)
lay["understory"] = np.array([[0, 0, 0.05, 0.1, 0.4, 0.5, 0, 0]], dtype=np.float32)
lay["understory_6m"] = lay["understory"]
seps = separations(classes, lay)
check("with them: lawn under canopy with less understory reads BELOW 0.5 (here 0)", seps["under canopy"]["understory"] == 0.0)

print(f"\nAll {passed} checks passed.")
