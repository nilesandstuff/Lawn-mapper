"""
The fused inputs, offline: that each source lands on the patches it covers,
that a missing one reads as zeros with its flag down, and that dropout hides
a whole source at once.

    python3 tools/fuse_test.py
"""

import numpy as np

from fuse_layers import CHANNELS, LIDAR, NAIP, drop_sources, extra_channels, ndvi_from_png

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


rgb = np.zeros((4, 4, 3), dtype=np.uint8)
rgb[:2, :, 0], rgb[:2, :, 1] = 200, 50      # vegetation: NIR high, red low
rgb[2:, :, 0], rgb[2:, :, 1] = 60, 60       # pavement: equal
ndvi, valid = ndvi_from_png(rgb)
check("NDVI of grass is high and of pavement about zero", ndvi[0, 0] > 0.5 and abs(ndvi[3, 3]) < 1e-6)
rgb[3, 3] = 0
_, valid = ndvi_from_png(rgb)
check("a black pixel (no NAIP there) is not valid", not valid[3, 3] and valid[0, 0])

# A 10 x 10 lidar grid over the photograph: a 20 m roof in the west half, no
# ground returns under it; open ground in the east half.
lidar = {
    "height": np.zeros((10, 10)), "n_ground": np.full((10, 10), 8), "n_all": np.full((10, 10), 10),
}
lidar["height"][:, :5] = 20
lidar["n_ground"][:, :5] = 0
e = extra_channels(4, 4, 1.0, 1.0, lidar=lidar)
check("seven channels on the patch grid", e.shape == (len(CHANNELS), 4, 4))
check("the roof is tall on the west patches and flat on the east",
      e[0, 0, 0] == 2.0 and e[0, 0, 3] == 0.0, str(e[0]))
check("no ground returns under the roof, most in the open", e[1, 0, 0] == 0 and e[1, 0, 3] == 0.8)
check("the lidar flag is up and the missing sources' flags down", e[3].min() == 1 and e[5].max() == 0)

# The grid covering twice the photograph (a lot padded to a square): the
# padding patches get nothing.
e2 = extra_channels(4, 4, 2.0, 2.0, lidar=lidar)
check("patches past the photograph read zero", e2[0, 3, 3] == 0 and e2[0, 0, 0] == 2.0)

e3 = extra_channels(2, 2, 1.0, 1.0, ndvi=np.full((6, 6), 0.6, np.float32), canopy=np.eye(6, dtype=bool))
check("NDVI and the canopy share come through", abs(e3[4, 0, 0] - 0.6) < 1e-6 and e3[5, 0, 0] == 1 and 0 < e3[6, 0, 0] < 1)
nd = np.full((6, 6), 0.6, np.float32)
va = np.ones((6, 6), bool)
va[:3, :3] = False
e4 = extra_channels(2, 2, 1.0, 1.0, ndvi=nd, ndvi_valid=va)
check("a patch with no NAIP under it reads NDVI 0 and flag 0; its neighbour does not",
      e4[4, 0, 0] == 0 and e4[5, 0, 0] == 0 and abs(e4[4, 0, 1] - 0.6) < 1e-6)

rng = np.random.default_rng(1)
full = extra_channels(4, 4, 1.0, 1.0, lidar=lidar, ndvi=np.full((4, 4), 0.5, np.float32))
d = drop_sources(full, rng, 1.0, 0.0)
check("dropping the lidar zeroes all its channels and only those",
      not d[list(LIDAR)].any() and np.array_equal(d[list(NAIP)], full[list(NAIP)]))
check("and leaves the original alone", full[3].min() == 1)

print(f"\nAll {passed} checks passed.")
