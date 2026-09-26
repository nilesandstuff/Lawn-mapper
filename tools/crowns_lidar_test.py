"""
The crown count and the clump bookkeeping, offline, on made-up heights.

    python3 tools/crowns_lidar_test.py
"""

import numpy as np

from crowns_lidar import clump_stats, crown_width_m, rule_trade, tree_tops

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

print(f"\nAll {passed} checks passed.")
