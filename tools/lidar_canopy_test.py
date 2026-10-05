"""Checks for tools/lidar_canopy.py on made-up layers.   (cd tools && python3 lidar_canopy_test.py)"""
import numpy as np
from lidar_canopy import lidar_canopy, to_photo, outlines

passed = 0


def check(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"PASS  {name}")


H, W = 20, 30
z = lambda v=0.0: np.full((H, W), v, dtype=np.float32)
L = {k: z() for k in ["height", "first_h", "last_h", "spread", "penetration", "multi", "veg_class", "building_class"]}
L["penetration"][:] = 1.0
# A roof: tall, one echo per pulse, classed building.
L["height"][2:8, 2:10] = 6; L["building_class"][2:8, 2:10] = 1
# A bare tree: tall, pulses split, most last returns on the ground.
L["height"][10:16, 2:8] = 12; L["multi"][10:16, 2:8] = 0.6
# An evergreen: tall, split, few last returns reach the ground.
L["height"][10:16, 14:20] = 15; L["multi"][10:16, 14:20] = 0.5; L["penetration"][10:16, 14:20] = 0.2
# A narrow tree, one cell wide and four long, in an unclassified cloud.
L["height"][3:7, 24] = 8; L["multi"][3:7, 24] = 0.7
# A hedge under 2 m.
L["height"][18, 2:20] = 1.2; L["multi"][18, 2:20] = 0.8

tree, dense = lidar_canopy(L, cell_m2=1.0)
check("the roof is not a tree", not tree[2:8, 2:10].any())
check("the bare tree is a tree", tree[10:16, 2:8].all())
check("the evergreen is a tree", tree[10:16, 14:20].all())
check("the one-cell-wide tree survives (no opening)", tree[3:7, 24].all())
check("the hedge under 2 m is not", not tree[18].any())
check("dense: the evergreen's middle, not the bare tree", dense[12:14, 16:18].all() and not dense[10:16, 2:8].any())
px = to_photo(tree, 300, 200)
check("stretched to the photo, the shape lands in the same place", px[130, 50] and not px[50, 60])
cl = outlines(px, 0.1, 2)
check("three tree patches traced", len(cl) == 3)
print(f"\nAll {passed} checks passed.")
