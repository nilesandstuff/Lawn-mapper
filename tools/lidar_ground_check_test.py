"""Checks for tools/lidar_ground_check.py.   (cd tools && python3 lidar_ground_check_test.py)"""
import numpy as np
from lidar_ground_check import check

passed = 0


def ok(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"PASS  {name}")


classes = np.zeros((10, 10), np.int8)
classes[:, 8:] = 3                       # not lawn
ground = np.ones((10, 10))
good = check(classes, np.full((10, 10), 0.05), ground)
ok("a lawn at the ground is not flagged", good["flag"] is None and good["median_m"] == 0.05)
high = check(classes, np.full((10, 10), 2.4), ground)
ok("a lawn 2.4 m up is flagged, as off the ground and as tall", "off the ground" in high["flag"] and "over 1 m" in high["flag"])
sunk = check(classes, np.full((10, 10), -1.0), ground)
ok("a ground surface above the lawn is flagged", "below the ground" in sunk["flag"])
nohit = check(classes, np.zeros((10, 10)), np.zeros((10, 10)))
ok("a lawn with no ground returns is flagged", "ground return" in nohit["flag"])
edge = np.zeros((10, 10)); edge[:, :2] = 6.0  # branches over a fifth of the lawn
ok("branches over the lawn's edge alone are not a flag", check(classes, edge, ground)["flag"] is None)
ok("too little visible lawn: no reading", check(np.full((10, 10), 3, np.int8), np.zeros((10, 10)), ground)["flag"] is None)
print(f"\nAll {passed} checks passed.")
