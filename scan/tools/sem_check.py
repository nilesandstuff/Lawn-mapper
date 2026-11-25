"""
DO THE PHONE'S LABEL PICTURES SIT ON THE CAMERA PICTURES? (core session, 2026-11-25). The first walk that kept them
(key-NNNN.sem, SCAN-PLAN 69) gave a weak sky signal and plain-sky controls that never read as sky: "Either the labels
aren't lined up with the pictures the way I assume, or the test spots are flawed" -- the owner: "Look into that."

Three checks that need no lidar and no fit:
  1. WHERE THE SKY IS IN THE LABEL PICTURE: the share of cells labelled sky in each quarter of the picture's height,
     top to bottom, and in each quarter of its width. Sky belongs at the top. If it sits at a side, the label picture is
     turned against the camera picture.
  2. THE WALK'S OWN POINTS AGAINST IT: every depth point carries the phone's label from the moment it was taken. The
     points taken within 0.3 s of a picture, put into that picture's label grid as kept, upside down, mirrored, turned
     right and turned left: the share whose own label is the grid's label there. The right way is the highest, and
     how high it is says how well the two sit together.
  3. HOW SURE THE SKY IS: the confidence of the cells labelled sky (the study took 0.5 and up).

  python scan/tools/sem_check.py <twin dir>     Counts and shares only.
"""
import json
import os
import re
import sys

import numpy as np

NAMES = ['unlabeled', 'sky', 'building', 'tree', 'road', 'sidewalk', 'terrain', 'structure', 'object', 'vehicle', 'person', 'water']


def main():
    d = sys.argv[1]
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    recs, labs = [], []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        a = np.fromfile(os.path.join(d, n), dtype="<f4"); a = a[: len(a) // 6 * 6].reshape(-1, 6)
        lp = os.path.join(d, n.replace("cloud-", "labels-"))
        lb = np.fromfile(lp, dtype=np.uint8) if os.path.exists(lp) else np.zeros(0, np.uint8)
        recs.append(a); labs.append(lb.reshape(-1, 4)[:, 0] if len(lb) == 4 * len(a) else np.zeros(len(a), np.uint8))
    recs, labs = np.concatenate(recs), np.concatenate(labs)
    order = np.argsort(recs[:, 0]); T = recs[order, 0]
    P4 = np.c_[recs[:, 2:5].astype(np.float64), np.ones(len(recs))]
    WAYS = ("as kept", "upside down", "mirrored", "turned right", "turned left")
    agree = np.zeros((len(WAYS), 2)); per = {}
    rows = np.zeros((4, 2)); cols = np.zeros((4, 2)); confs = []; n_sem = 0; shapes = set(); total = np.zeros(12)
    for k in keys:
        f = os.path.join(d, k["name"].replace(".jpg", ".sem"))
        if not os.path.exists(f):
            continue
        b = np.fromfile(f, dtype=np.uint8)
        nx, ny = int(b[0]) | (int(b[1]) << 8), int(b[2]) | (int(b[3]) << 8)
        if len(b) < 4 + 2 * nx * ny:
            continue
        lab = b[4:4 + nx * ny].reshape(ny, nx); conf = b[4 + nx * ny:4 + 2 * nx * ny].reshape(ny, nx)
        n_sem += 1; shapes.add((nx, ny, k.get("w"), k.get("h")))
        total += np.bincount(lab[lab < 12], minlength=12)
        sky = lab == 1
        for q in range(4):
            r = sky[q * ny // 4:(q + 1) * ny // 4]; rows[q] += (r.sum(), r.size)
            c = sky[:, q * nx // 4:(q + 1) * nx // 4]; cols[q] += (c.sum(), c.size)
        confs.append(conf[sky])
        a_, b_ = np.searchsorted(T, k["t"] - 0.3), np.searchsorted(T, k["t"] + 0.3)
        sel = order[a_:b_]; sel = sel[labs[sel] > 0]
        if not len(sel):
            continue
        V = np.asarray(k["view"], np.float64).reshape(4, 4).T; Pm = np.asarray(k["proj"], np.float64).reshape(4, 4).T
        cam = P4[sel] @ np.linalg.inv(V).T; clip = cam @ Pm.T
        w = np.where(np.abs(clip[:, 3]) < 1e-9, 1e-9, clip[:, 3])
        u, v = (clip[:, 0] / w + 1) / 2, (1 - clip[:, 1] / w) / 2
        inn = (-cam[:, 2] > 0.3) & (u > 0.02) & (u < 0.98) & (v > 0.02) & (v < 0.98)
        u, v, own = u[inn], v[inn], labs[sel][inn].astype(int) - 1
        for wi, (cu, cv) in enumerate(((u, v), (u, 1 - v), (1 - u, v), (1 - v, u), (v, 1 - u))):
            g = lab[np.clip((cv * ny).astype(int), 0, ny - 1), np.clip((cu * nx).astype(int), 0, nx - 1)]
            agree[wi] += ((g == own).sum(), len(own))
            if wi == 0:
                for L in (2, 3, 6, 4):
                    m = own == L
                    o = per.setdefault(L, [0, 0, np.zeros(12)]); o[0] += int((g[m] == L).sum()); o[1] += int(m.sum()); o[2] += np.bincount(g[m][g[m] < 12], minlength=12)
    print(f"\nDO THE PHONE'S LABEL PICTURES SIT ON THE CAMERA PICTURES? (sem_check.py; {n_sem} of {len(keys)} pictures kept one; label grid x camera picture sizes: {sorted(shapes)})")
    if not n_sem:
        print("  None kept: a walk made since 2026-11-24 19:36 UTC has them.")
        return 0
    tt = total.sum()
    print("  What the label pictures hold: " + ", ".join(f"{NAMES[i]} {100 * total[i] / tt:.0f}%" for i in np.argsort(-total) if total[i] / tt >= 0.01) + ".")
    print("  1. WHERE THE SKY IS: of each quarter of the picture's HEIGHT, top to bottom, labelled sky: " + " / ".join(f"{100 * a / max(1, b):.0f}%" for a, b in rows)
          + "; of each quarter of its WIDTH, left to right: " + " / ".join(f"{100 * a / max(1, b):.0f}%" for a, b in cols) + ". (Sky belongs at the top.)")
    print(f"  2. THE WALK'S OWN LABELLED POINTS AGAINST THE LABEL PICTURE ({int(agree[0, 1]):,} landings): the same label, the picture " + "; ".join(f"{WAYS[i]} {100 * agree[i, 0] / max(1, agree[i, 1]):.0f}%" for i in range(5)) + ".")
    for L, (a, b, hist) in per.items():
        if b:
            top = np.argsort(-hist)[:3]
            print(f"     points the phone called {NAMES[L]} ({b:,}), as kept: {100 * a / b:.0f}% land on {NAMES[L]}; they land on " + ", ".join(f"{NAMES[i]} {100 * hist[i] / hist.sum():.0f}%" for i in top) + ".")
    c = np.concatenate(confs) if confs else np.zeros(0)
    if len(c):
        print(f"  3. HOW SURE THE SKY IS: confidence of the {len(c):,} sky cells (0-255): a quarter under {int(np.percentile(c, 25))}, the middle {int(np.percentile(c, 50))}, three quarters under {int(np.percentile(c, 75))}; {100 * (c >= 128).mean():.0f}% at 128 (0.5) or more.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
