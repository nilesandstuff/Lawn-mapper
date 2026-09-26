"""
The NAIP-CHM matching and bookkeeping, offline. The reads are not tested here
(they need the network); what is tested is everything that can be quietly
wrong: a box in the wrong projection matches the wrong quad and reports a
real-looking agreement about somebody else's trees.

    python3 tools/naip_chm_test.py
"""

import numpy as np

from naip_chm import geo_bounds, lonlat_box, match_index, newest_only, overlaps, three_way, two_way

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


geo = '{"type":"Polygon","coordinates":[[[-80.749,24.936],[-80.749,25.0006],[-80.813,25.0007],[-80.8133,24.9368],[-80.749,24.936]]]}'
check("the index polygon's bounds, lon then lat", geo_bounds(geo) == (-80.8133, 24.936, -80.749, 25.0007), str(geo_bounds(geo)))

# Kent 8,626's frame centre, in Web Mercator, back to lon/lat.
x, y = -9530117.0, 5316548.0
box = lonlat_box((x - 50, y - 50, x + 50, y + 50))
check("a Web Mercator box comes back as lon/lat round Kent County", -85.62 < box[0] < box[2] < -85.60 and 43.02 < box[1] < box[3] < 43.05, str(box))
check("overlap is strict: touching edges are not a match", not overlaps((0, 0, 1, 1), (1, 0, 2, 1)) and overlaps((0, 0, 1, 1), (0.5, 0.5, 2, 2)))

rows = [
    ((-85.7, 43.0, -85.6, 43.1), 2020, "2020-07-01", "old.tif"),
    ((-85.7, 43.0, -85.6, 43.1), 2022, "2022-08-23", "new.tif"),
    ((-85.6, 43.0, -85.5, 43.1), 2022, "2022-08-24", "east.tif"),
    ((-80.0, 30.0, -79.9, 30.1), 2023, "2023-01-01", "florida.tif"),
]
m = match_index(rows, {"kent": (-85.61, 43.03, -85.59, 43.04), "far": (-100, 40, -99.9, 40.1)})
check("a frame on a quad edge matches both quads, newest first",
      [u for _, _, u in m["kent"]] == ["east.tif", "new.tif", "old.tif"], str(m["kent"]))
check("and only the newest year is read", [u for _, _, u in newest_only(m["kent"])] == ["east.tif", "new.tif"])
check("a frame with nothing over it gets an empty list, not an error", m["far"] == [] and newest_only([]) == [])

W = np.ones((2, 4), dtype=bool)
restor = np.array([[1, 1, 0, 0], [1, 0, 0, 0]], dtype=bool)
lidar = np.array([[1, 0, 1, 0], [1, 0, 1, 1]], dtype=bool)
naip = np.array([[1, 0, 1, 0], [0, 1, 0, 0]], dtype=bool)
tw = three_way(W, restor, lidar, naip)
check("three-way: both 2 (NAIP on 1), lidar only 3 (NAIP on 1), model only 1 (NAIP 0), neither 2 (NAIP 1)",
      tw == {"both": [2, 1], "lidar only": [3, 1], "model only": [1, 0], "neither": [2, 1]}, str(tw))
W2 = W.copy()
W2[:, 3] = False
check("cells outside the line are not counted", three_way(W2, restor, lidar, naip)["lidar only"] == [2, 1])
check("two-way for a frame with no lidar", two_way(W, restor, naip) == {"both": 1, "model only": 2, "naip only": 2})

print(f"\nAll {passed} checks passed.")
