"""Checks for tools/tree_lidar.py on made-up points.   python3 tools/tree_lidar_test.py"""
import numpy as np
from tree_lidar import tree_layers

passed = 0
def check(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"PASS  {name}")

# A 10 m x 10 m box at 1 m cells. Ground everywhere at z=100.
pts = []
for gx in np.arange(0.25, 10, 0.5):
    for gy in np.arange(0.25, 10, 0.5):
        if gx < 6:  # under the evergreen nothing reaches the ground
            pts.append([gx, gy, 100.0, 2, 1, 1])    # single-return ground
# A bare tree over x 0-4: pulses split, first at 110, last on the ground.
for gx in np.arange(0.25, 4, 0.5):
    for gy in np.arange(0.25, 10, 0.5):
        pts.append([gx, gy, 110.0, 5, 1, 2]); pts.append([gx, gy, 100.1, 2, 2, 2])
# An evergreen over x 6-10: pulses stop in the crown, last returns high.
for gx in np.arange(6.25, 10, 0.5):
    for gy in np.arange(0.25, 10, 0.5):
        pts.append([gx, gy, 112.0, 5, 1, 2]); pts.append([gx, gy, 108.0, 5, 2, 2])
pts = np.array(pts, dtype=float)
L, gw, gh = tree_layers(pts, [0, 0, 10, 10], cell=1.0)
check("a 10 m box at 1 m cells is 10 x 10", (gw, gh) == (10, 10))
bare, ever = (slice(None), slice(0, 4)), (slice(None), slice(6, 10))
check("under the bare tree last returns reach the ground", float(np.nanmean(L["last_h"][bare])) < 1.0)
check("under the evergreen they stop high in the crown", float(np.nanmean(L["last_h"][ever])) > 5.0)
check("so penetration tells them apart", float(np.nanmean(L["penetration"][bare])) > 0.5 > float(np.nanmean(L["penetration"][ever])))
check("both are tall, and split their pulses", float(np.nanmin(L["height"][ever])) > 10 and float(np.nanmean(L["multi"][ever])) > 0.5)
check("open ground: no height, no split pulses", float(np.nanmax(L["height"][:, 4:6])) < 0.5 and float(np.nanmax(L["multi"][:, 4:6])) == 0)
print(f"\nAll {passed} checks passed.")
