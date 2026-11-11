"""Offline checks of tools/intensity_canopy.py: python3 intensity_canopy_test.py"""
import numpy as np

import intensity_canopy as ic

rng = np.random.default_rng(3)
BBOX = (0.0, 0.0, 40.0, 40.0)
CELL = 2.0


def scene(timed=True):
    """A 40 m square: lawn (reflects 100) west, pavement (60) east; a crown over the north half takes 60% of each pulse it meets."""
    rows = []
    t = 1000.0
    for _ in range(20000):
        x, y = rng.uniform(0, 40), rng.uniform(0.01, 40)
        refl = 100.0 if x < 20 else 60.0
        t += 0.001
        gps = t if timed else 0.0
        if y > 20:  # under the crown: a first return in the leaves, the rest on the ground
            lost = 0.6
            rows.append([x, y, 12.0, 80.0 * lost + rng.normal(0, 2), 5, 1, 2, gps])
            rows.append([x, y, 0.0, refl * (1 - lost) + rng.normal(0, 2), 2, 2, 2, gps])
        else:
            rows.append([x, y, 0.0, refl + rng.normal(0, 2), 2, 1, 1, gps])
    return np.array(rows)


def classes():
    c = np.zeros((20, 20), dtype=np.int8)
    yy, xx = np.mgrid[0:20, 0:20]
    north = yy < 10  # rows run from the north down
    lawn = xx < 10
    c[lawn & ~north] = 0
    c[lawn & north] = 1
    c[~lawn & north] = 2
    c[~lawn & ~north] = 3
    return c


def raw_layer(pts):
    g = pts[pts[:, 4] == 2]
    col = np.minimum(19, (g[:, 0] / 2).astype(int))
    row = np.minimum(19, ((40 - g[:, 1]) / 2).astype(int))
    s = np.zeros((20, 20)); n = np.zeros((20, 20))
    np.add.at(s, (row, col), g[:, 3]); np.add.at(n, (row, col), 1)
    return np.where(n > 0, s / np.maximum(n, 1), np.nan)


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        raise SystemExit(1)


pts = scene()
lay, info = ic.layers(pts, BBOX, CELL)
lay["intensity"] = raw_layer(pts)
sc = ic.lot_scores(classes(), lay)
check("every layer is on the frame's grid", all(lay[k].shape == (20, 20) for k in ic.LAYERS))
check("raw: lawn and pavement told apart in the open and under the crown", sc["intensity"]["visible"][0] > 0.95 and sc["intensity"]["under canopy"][0] > 0.95)
check("raw: the crown shows in the lawn (covered lawn darker than open lawn)", sc["intensity"]["crown shows"][0] < 0.05, str(sc["intensity"]["crown shows"][0]))
check("raw: one rank over the whole lot is confused by the crown", sc["intensity"]["whole lot"][0] < 0.8, str(sc["intensity"]["whole lot"][0]))
for k in ("intensity_lang", "intensity_pulse", "intensity_group"):
    check(f"{k}: the whole lot is told apart again", sc[k]["whole lot"][0] > 0.9, str(sc[k]["whole lot"][0]))
    check(f"{k}: nothing lost in the open", sc[k]["visible"][0] > 0.95, str(sc[k]["visible"][0]))
check("ranked by return count: the crown is out of the lawn", sc["intensity_group"]["crown shows"][0] > 0.25, str(sc["intensity_group"]["crown shows"][0]))
c = classes()
gap = lambda L: float(np.nanmean(L[c == 0]) - np.nanmean(L[c == 1])) / float(np.nanmean(L[c == 0]))  # noqa: E731
# the pulse sum mixes the leaves' own reflectance in (80 against the lawn's 100), so it narrows the gap and does not close it
check("pulse sum and the Lang form: covered lawn much nearer open lawn than raw", gap(lay["intensity"]) > 0.5 and gap(lay["intensity_pulse"]) < 0.2 and gap(lay["intensity_lang"]) < 0.2,
      f"{gap(lay['intensity']):.2f} {gap(lay['intensity_pulse']):.2f} {gap(lay['intensity_lang']):.2f}")
check("the pulses were put together, whole", info["pulses_timed"] and info["pulse_whole_share"] > 0.99)
check("C is found from the frame, no labels", 0 < info["c"] < ic.MAX_C, str(info["c"]))

lay2, info2 = ic.layers(scene(timed=False), BBOX, CELL)
check("no GPS time: the pulse layer is empty, the others stand", not info2["pulses_timed"] and not np.isfinite(lay2["intensity_pulse"]).any() and np.isfinite(lay2["intensity_group"]).any())
# times shared between pulses (some flights): the open ground must come out exactly as the raw
shared = pts.copy()
shared[:, 7] = np.round(shared[:, 7], 1)  # a hundred pulses to a time
lay4, info4 = ic.layers(shared, BBOX, CELL)
open_cells = (c == 0) | (c == 3)
check("shared times: a single return in the open is its own sum, to the digit",
      np.allclose(lay4["intensity_pulse"][open_cells], raw_layer(shared)[open_cells], equal_nan=True) and info4["time_shared_share"] > 0.5,
      str(info4))
check("unshared times: the open is the raw there too", np.allclose(lay["intensity_pulse"][open_cells], lay["intensity"][open_cells], rtol=1e-5, equal_nan=True))
lay3, _ = ic.layers(pts[:, :5], BBOX, CELL)
check("narrow points: nothing is made up", not any(np.isfinite(v).any() for v in lay3.values()))
check("auc: perfect, reversed, tied", ic.auc([2, 3], [0, 1]) == 1.0 and ic.auc([0, 1], [2, 3]) == 0.0 and ic.auc([1, 1], [1, 1]) == 0.5)
table = ic.print_table([sc, sc], [info, info])
check("the table pools and counts lots", table["intensity"]["visible"]["lots"] == 2 and table["intensity_group"]["whole lot"]["above"] == 2)
print("intensity_canopy: ok")
