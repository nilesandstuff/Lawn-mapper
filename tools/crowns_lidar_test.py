"""
The crown count and the clump bookkeeping, offline, on made-up heights.

    python3 tools/crowns_lidar_test.py
"""

import numpy as np

from crowns_lidar import clump_stats, crown_segments, crown_width_m, rule_trade, tree_tops

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


check("crown width grows with height", crown_width_m(20) > crown_width_m(10) > crown_width_m(5))


def cone(H, W, cy, cx, h, r):
    y, x = np.ogrid[:H, :W]
    d = np.sqrt((y - cy) ** 2 + (x - cx) ** 2)
    return np.clip(h * (1 - d / r), 0, None)


# A lone 15 m tree, and a wood of four 18 m crowns 8 m (4 cells) apart, on 2 m cells.
chm = np.zeros((30, 40))
chm = np.maximum(chm, cone(30, 40, 8, 8, 15, 5))
for cy, cx in ((10, 24), (10, 29), (15, 24), (15, 29)):
    chm = np.maximum(chm, cone(30, 40, cy, cx, 18, 4))
tops = tree_tops(chm, 2.0)
lone = tops[3:14, 3:14].sum()
wood = tops[5:21, 19:35].sum()
check("one top on the lone tree", lone == 1, str(lone))
check("several tops in the wood (3 to 4 at 2 m cells)", 3 <= wood <= 4, str(wood))
check("nothing on bare ground", tops[25:, :].sum() == 0)

canopy = chm >= 2
lawn = np.zeros_like(canopy)
lawn[:, :17] = True              # the lone tree stands in the lawn
visible = lawn & ~canopy
cl = clump_stats(canopy, lawn, visible, tops, 4.0)
cl.sort(key=lambda c: c["area"])
check("two clumps", len(cl) == 2, str(len(cl)))
small, big = cl
check("the lawn tree: one crown, all lawn under it, a lawn border", small["crowns"] == 1 and small["lawn"] == small["area"] and small["border"] > 0.9, str(small))
check("the wood: several crowns, no lawn, no lawn border", big["crowns"] >= 3 and big["lawn"] == 0 and big["border"] == 0, str(big))
cost, lawn_all, found, woods_all = rule_trade(cl, lambda c: c["crowns"] >= 3)
check("'3+ crowns is woods' finds the wood and costs no lawn", cost == 0 and found == woods_all and lawn_all == small["area"])

# H47: a lawn tree whose crown touches the wood is one clump, but its own segment.
chm2 = np.zeros((30, 50))
for cy, cx in ((10, 24), (10, 29), (15, 24), (15, 29), (12, 34)):
    chm2 = np.maximum(chm2, cone(30, 50, cy, cx, 18, 4))
chm2 = np.maximum(chm2, cone(30, 50, 12, 41, 14, 4))     # the lawn tree, touching the wood's edge
tops2 = tree_tops(chm2, 2.0)
can2 = chm2 >= 2
lawn2 = np.zeros_like(can2)
lawn2[:, 39:] = True                                    # lawn east of the wood, under the lawn tree
vis2 = lawn2 & ~can2
from scipy.ndimage import label as _label
check("the lawn tree and the wood are ONE clump", _label(can2, structure=np.ones((3, 3)))[1] == 1)
segs = crown_segments(can2, tops2, lawn2, vis2, 2.0, chm=chm2)
lawny = [c for c in segs if c["lawn"] >= 0.5 * c["area"]]
woody = [c for c in segs if c["lawn"] < 0.5 * c["area"]]
check("but the lawn tree is a segment of its own, mostly lawn", len(lawny) >= 1, str(segs))
check("with more lawn border than any wood segment", min(c["border"] for c in lawny) > max(c["border"] for c in woody), str(segs))
check("and nearer the visible lawn", max(c["dist"] for c in lawny) < min(c["dist"] for c in woody) or min(c["dist"] for c in lawny) == 0)

# segments_pred: the detector's edge, when it equals the tracer's, gives the same segments;
# a detector that saw no lawn at all gives every segment a zero border.
import segments_pred as sp
cls3 = np.full((20, 20), 3)
cls3[:, :8] = 0
cls3[5:15, 6:12] = 1
cls3[5:15, 12:18] = 2
h3 = np.zeros((20, 20))
h3[5:15, 6:18] = 10
h3[10, 9] = 14
h3[10, 15] = 15
z3 = {"classes": cls3, "height": h3}
t3, d3 = sp.segments_for(z3, (cls3 == 0) | (cls3 == 1), 2.0, 1.0)
check("detector edge = tracer edge gives the same borders", [c["border"] for c in t3] == [c["border"] for c in d3])
_, d4 = sp.segments_for(z3, np.zeros((20, 20), dtype=bool), 2.0, 1.0)
check("a detector that saw no lawn leaves every border at 0", all(c["border"] == 0 for c in d4))
check("map ids give their latitude", sp.lat_of("-85.61,43.03:sam3:find") == 43.03 and sp.lat_of("nonsense") is None)

print(f"\nAll {passed} checks passed.")
