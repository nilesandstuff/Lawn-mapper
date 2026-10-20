"""
The fused inputs, offline: that each source lands on the patches it covers,
that a missing one reads as zeros with its flag down, and that dropout hides
a whole source at once.

    python3 tools/fuse_test.py
"""

import numpy as np

from fuse_layers import (CHANNELS, INTENSITY_CHANNELS, LIDAR, NAIP, RETURN_CHANNELS, RETURN_LIDAR, drop_sources, extra_channels,
                         frame_rank, intensity_index, ndvi_from_png)

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

# Lidar by return (H73): four more channels after the seven, hidden with the lidar.
ret = {"penetration": np.array([[0.2, 1.0], [np.nan, 1.0]], np.float32),
       "multi": np.array([[0.6, 0.0], [0.0, 0.0]], np.float32),
       "spread": np.array([[8.0, 0.0], [0.0, 0.0]], np.float32)}
er = extra_channels(2, 2, 1.0, 1.0, lidar=lidar, returns=ret, with_returns=True)
check("eleven channels with the returns", er.shape[0] == len(CHANNELS) + len(RETURN_CHANNELS))
check("a crown's returns come through; a cell with no points reads as open ground",
      abs(er[7, 0, 0] - 0.2) < 1e-6 and abs(er[8, 0, 0] - 0.6) < 1e-6 and abs(er[9, 0, 0] - 0.8) < 1e-6
      and er[7, 1, 0] == 1.0 and er[10].min() == 1)
check("without the switch, still seven", extra_channels(2, 2, 1.0, 1.0, lidar=lidar, returns=ret).shape[0] == len(CHANNELS))
dr = drop_sources(er, np.random.default_rng(2), 1.0, 0.0)
check("dropping the lidar zeroes the return channels too", not dr[list(LIDAR + RETURN_LIDAR)].any())

# The lidar's ground brightness (S38): ranked within the frame, after everything else.
r = frame_rank(np.array([[10.0, np.nan], [30.0, 20.0]]))
check("brightness is ranked within the frame, darkest 0, brightest 1, no return NaN",
      r[0, 0] == 0 and r[1, 0] == 1 and r[1, 1] == 0.5 and np.isnan(r[0, 1]))
check("two flights on different scales rank the same",
      np.array_equal(frame_rank(np.array([1.0, 2.0, 3.0])), frame_rank(np.array([100.0, 900.0, 5000.0]))))
li = dict(lidar, intensity=np.where(lidar["n_ground"] > 0, np.tile(np.arange(10.0), (10, 1)), np.nan))
ei = extra_channels(2, 2, 1.0, 1.0, lidar=li, with_intensity=True)
i, f = intensity_index(False)
check("nine channels with the brightness, last", ei.shape[0] == len(CHANNELS) + len(INTENSITY_CHANNELS) and (i, f) == (7, 8))
check("the roof half has no ground to be bright (flag 0); the open half holds every rank (mean 0.5)",
      ei[f, 0, 0] == 0 and ei[i, 0, 0] == 0 and ei[f, 0, 1] == 1 and abs(ei[i, 0, 1] - 0.5) < 1e-6)
check("ties share their rank", np.allclose(frame_rank(np.array([5.0, 5.0, 9.0])), [0.25, 0.25, 1.0]))
check("with the returns on, the brightness sits after them", intensity_index(True) == (11, 12)
      and extra_channels(2, 2, 1.0, 1.0, lidar=li, returns=ret, with_returns=True, with_intensity=True).shape[0] == 13)
check("without the switch the brightness is not there, whatever the lidar carries",
      extra_channels(2, 2, 1.0, 1.0, lidar=li).shape[0] == len(CHANNELS))
check("no lidar: brightness and flag are zeros", not extra_channels(2, 2, 1.0, 1.0, with_intensity=True)[[i, f]].any())
di = drop_sources(ei, np.random.default_rng(3), 1.0, 0.0, more_lidar=(i, f))
check("dropping the lidar zeroes the brightness too", not di[list(LIDAR) + [i, f]].any() and np.array_equal(di[list(NAIP)], ei[list(NAIP)]))

# The paved centrelines (owner, 2026-10-20): after everything else, their own source for dropout.
from fuse_layers import OVERTURE_CHANNELS, overture_index  # noqa: E402
ovt = {"line": np.pad(np.ones((5, 5)), ((0, 5), (0, 5))) * 0.4}
eo = extra_channels(2, 2, 1.0, 1.0, lidar=li, with_intensity=True, overture=ovt, with_overture=True)
o = overture_index(False, True)
check("eleven channels with the lines, last two", eo.shape[0] == len(CHANNELS) + len(INTENSITY_CHANNELS) + len(OVERTURE_CHANNELS) and o == 9)
check("the line's nearness fills its quarter and nothing else; the flag is 1",
      abs(eo[o, 0, 0] - 0.4) < 1e-6 and eo[o, 1, 1] == 0 and eo[o + 1].min() == 1)
check("with the returns on too, the lines sit after the brightness", overture_index(True, True) == 13
      and extra_channels(2, 2, 1.0, 1.0, lidar=li, returns=ret, with_returns=True, with_intensity=True, overture=ovt, with_overture=True).shape[0] == 15)
check("without the switch the lines are not there", extra_channels(2, 2, 1.0, 1.0, lidar=li, with_intensity=True, overture=ovt).shape[0] == 9)
check("no lines: zeros and a 0 flag", not extra_channels(2, 2, 1.0, 1.0, with_intensity=True, with_overture=True)[o:o + 2].any())
do = drop_sources(eo, np.random.default_rng(4), 0.0, 0.0, overture=tuple(range(o, o + 2)), p_overture=1.0)
check("dropping the lines zeroes their two and leaves the lidar", not do[o:o + 2].any() and np.array_equal(do[list(LIDAR)], eo[list(LIDAR)]))
dl = drop_sources(eo, np.random.default_rng(5), 1.0, 0.0, more_lidar=(i, f), overture=tuple(range(o, o + 2)), p_overture=0.0, with_returns=False)
check("dropping the lidar leaves the lines (the returns' slots are theirs here)", np.array_equal(dl[o:o + 2], eo[o:o + 2]) and not dl[list(LIDAR) + [i, f]].any())
check("told the returns are off, their slots are left alone even without the lines' indices",
      np.array_equal(drop_sources(eo, np.random.default_rng(5), 1.0, 0.0, more_lidar=(i, f), with_returns=False)[o:o + 2], eo[o:o + 2]))

print(f"\nAll {passed} checks passed.")
