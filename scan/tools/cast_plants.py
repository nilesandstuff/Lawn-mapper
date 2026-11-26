"""
THE PICTURES' OWN PLANTS, ADDED TO A DOWNLOADED WALK BEFORE plants.py (core session, 2026-11-26). The owner: "find out
how we can get more ground/plants/trees/grass on the map from the walks we already have mapped."

The walk's kept points are thinned to one a small cube, so a crown seen well from below leaves few of them. Each picture
also keeps its raw depth (key-NNNN.rdepth), ARCore's smoothed depth (key-NNNN.sdepth, no holes) and the phone's own label
(key-NNNN.sem) on one 72 x 128 grid. For the GROUND, casting those cells to 12 m with the smoothed depth in the raw one's
holes gave three and a half times the ground the walks both call, and the walks agreed more (SCAN-PLAN 74). Here the same
cells the phone labelled TREE are put into space and written beside the walk's own points as two extra parts
(cloud-9000.bin, labels-9000.bin: the same record, [t, odo, x, y, z, ground], label byte 4 = tree), one to a 10 cm cube,
so plants.py makes its boxes, open air and the rest from them unchanged. The ground under each is the walk's own
nearest ground. ONLY IN THE RUNNER'S FOLDER: nothing is sent back. `--undo` takes the two parts away again (surfaces.py
reads the walk's own points by order with view-rgb.bin and view-kind.bin, which the extra parts would put out of step).

    python scan/tools/cast_plants.py <twin dir> [--reach 12] [--raw-only]
    python scan/tools/cast_plants.py <twin dir> --undo
Counts only.
"""
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trunks as TR  # noqa: E402

TREE = 3            # ARCore's label (not + 1) for tree
CONF = 0.3          # the least raw depth confidence for a raw cell
VOX = 0.10          # m: one point a cube this size


def main():
    a = sys.argv[1:]
    d = a[0]
    extra = [os.path.join(d, "cloud-9000.bin"), os.path.join(d, "labels-9000.bin")]
    if "--undo" in a:
        for f in extra:
            if os.path.exists(f):
                os.remove(f)
        return 0
    reach = float(a[a.index("--reach") + 1]) if "--reach" in a else 12.0
    smooth = "--raw-only" not in a
    try:
        fit = json.load(open(os.path.join(d, "fit.json")))
    except Exception:
        fit = {}
    scale = float(fit.get("castScale") or 1.0)
    recs, _, flags = TR.read_walk(d)
    if not len(recs):
        print("  The pictures' plants: the walk has no points.")
        return 0
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    fin = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & ((flags & 3) == 0)
    from scipy.spatial import cKDTree
    gij = np.floor(np.stack([x_[fin], z_[fin]], 1)).astype(np.int64)
    o = np.lexsort((gij[:, 1], gij[:, 0])); gs, gy = gij[o], g_[fin][o]
    brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
    gmed = np.array([np.median(gy[p:q]) for p, q in zip(brk, np.r_[brk[1:], len(gy)])])
    gtree = cKDTree(gs[brk].astype(np.float64))
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    import segment_study as SS
    SS.pose_keys(keys, SS.read_track(d))
    out, used, raw_n, sm_n = [], 0, 0, 0
    for k in keys:
        fs, fr = os.path.join(d, k["name"].replace(".jpg", ".sem")), os.path.join(d, k["name"].replace(".jpg", ".rdepth"))
        if not (os.path.exists(fs) and os.path.exists(fr)) or k.get("view") is None:
            continue
        b = np.fromfile(fs, dtype=np.uint8); r = np.fromfile(fr, dtype="<u2")
        nx, ny = int(r[0]), int(r[1])
        if len(r) < 2 + 2 * nx * ny or len(b) < 4 + nx * ny or (int(b[0]) | (int(b[1]) << 8)) != nx:
            continue
        dist = r[2:2 + nx * ny].astype(np.float64) / 1000.0 * scale
        conf = r[2 + nx * ny:2 + 2 * nx * ny].astype(np.float64) / 255.0
        lab = b[4:4 + nx * ny].astype(np.int64)
        sure = b[4 + nx * ny:4 + 2 * nx * ny] >= 128 if len(b) >= 4 + 2 * nx * ny else np.ones(nx * ny, bool)
        rawok = (dist > 0.4) & (dist <= reach) & (conf >= CONF)
        m = rawok & (lab == TREE) & sure
        raw_n += int(m.sum())
        fsd = os.path.join(d, k["name"].replace(".jpg", ".sdepth"))
        if smooth and os.path.exists(fsd):
            sd = np.fromfile(fsd, dtype="<u2")
            if len(sd) >= 2 + nx * ny and int(sd[0]) == nx and int(sd[1]) == ny:
                sdist = sd[2:2 + nx * ny].astype(np.float64) / 1000.0 * scale
                hole = ~rawok & (sdist > 0.4) & (sdist <= reach) & (lab == TREE) & sure
                dist = np.where(hole, sdist, dist); m = m | hole; sm_n += int(hole.sum())
        if not m.any():
            continue
        V = k["c2w"]
        Pi = np.linalg.inv(np.asarray(k["proj"], np.float64).reshape(4, 4).T)
        jj, ii = np.divmod(np.flatnonzero(m), nx)
        u, v = 2 * (ii + 0.5) / nx - 1, 1 - 2 * (jj + 0.5) / ny
        a4 = np.stack([u, v, -np.ones_like(u), np.ones_like(u)], 1) @ Pi.T
        b4 = np.stack([u, v, np.ones_like(u), np.ones_like(u)], 1) @ Pi.T
        dc = b4[:, :3] / b4[:, 3:4] - a4[:, :3] / a4[:, 3:4]
        dw = dc @ V[:3, :3].T
        dw /= np.linalg.norm(dw, axis=1, keepdims=True)
        P = V[:3, 3][None, :] + dw * dist[m][:, None]
        _, near = gtree.query(np.floor(P[:, [0, 2]]))
        g = gmed[near]
        odo = float(k.get("odo") or 0.0)
        out.append(np.column_stack([np.full(len(P), float(k.get("t", 0))), np.full(len(P), odo), P[:, 0], P[:, 1], P[:, 2], g]))
        used += 1
    if not out:
        print("  The pictures' plants: no picture kept a tree cell within reach.")
        return 0
    A = np.concatenate(out)
    q = np.floor(A[:, 2:5] / VOX).astype(np.int64)
    _, first = np.unique(q, axis=0, return_index=True)
    A = A[np.sort(first)].astype("<f4")
    A.tofile(extra[0])
    L = np.zeros((len(A), 4), np.uint8); L[:, 0] = TREE + 1; L[:, 1] = 200; L[:, 2] = 255
    L.tofile(extra[1])
    print(f"  The pictures' plants: {used} pictures, {raw_n:,} raw and {sm_n:,} smoothed cells the phone called tree within {reach * 3.281:.0f} ft; "
          f"{len(A):,} points, one a 4 in cube, added beside the walk's own {len(recs):,}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
