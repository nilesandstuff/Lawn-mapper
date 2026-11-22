"""TREE TRUNKS FROM A WALK'S JOINED CLOUD (core session, 2026-11-22). The goal (CLAUDE.md): later walks "automatically
place fences, trees (atleast the trunks, but ideally the branches as well...)".

What there is to work with: the joined cloud the 3D view shows (dense_prep.py: one point to a cell of about 11 in, each
with the kind the photos voted and how many photos saw it). A trunk in it is a NARROW COLUMN OF TREE: tree-kind cells
stacked from near the ground to chest height and above, in a footprint no wider than a trunk. A hedge is wide; a
drooping branch does not reach the ground; a fence post is not tree.

    python scan/tools/trunks.py <twin dir> [out trunks.json]                    from the walk's own points (the second try)
    python scan/tools/trunks.py <view-dense.bin> [view.json] [out trunks.json]  from the joined cloud (the first try: a miss)

Counts and sizes to the log; the places (the walk's own frame, metres) only into trunks.json beside the twin.
NOT a measurement of anything yet: no trunk here has been checked against a real tree. The owner's eyes on the 3D
view are the first judge.
"""
import json
import os
import sys

import numpy as np

FT = 3.28084
KINDS = ["none", "built", "fence", "grass", "bare ground", "paved", "plant", "movable", "water", "sky", "tree"]  # studies.VOTE_KINDS
TREE = KINDS.index("tree")
GROUND = [KINDS.index(k) for k in ("grass", "bare ground", "paved")]
REC = np.dtype([("p", "<f4", 3), ("t", "<f4"), ("c", "u1", 3), ("kind", "u1"), ("looks", "u1"), ("src", "u1"), ("pad", "u1", 2)])

LOW, HIGH = 0.6, 1.3      # m over the ground: a trunk has tree cells at or under LOW and at or over HIGH
REACH = 2.0               # m over the ground: cells above this are crown, not counted as trunk
WIDE = 0.9                # m: the footprint of the cells under REACH, either way, at the most
LEAST = 4                 # distinct height cells under REACH, at the least
CELL = 0.3                # m: the plan grid the columns are gathered on


def ground_under(p, kind):
    """The ground's height under every point: the middle height of the ground-kind points in its 1 m square, a square
    with none taking the nearest that has one."""
    from scipy.spatial import cKDTree
    g = np.isin(kind, GROUND)
    if g.sum() < 50:
        return None
    ij = np.floor(p[g][:, [0, 2]] / 1.0).astype(np.int64)
    order = np.lexsort((ij[:, 1], ij[:, 0]))
    ij, y = ij[order], p[g][order, 1]
    brk = np.flatnonzero(np.r_[True, (np.diff(ij, axis=0) != 0).any(1)])
    cells = ij[brk]
    med = np.array([np.median(y[a:b]) for a, b in zip(brk, np.r_[brk[1:], len(y)])])
    _, near = cKDTree(cells.astype(np.float64)).query(np.floor(p[:, [0, 2]] / 1.0))
    return med[near]


def find(rec, cut_s=0.0):
    p = rec["p"].astype(np.float64)
    ok = np.isfinite(p).all(1) & (rec["t"] >= cut_s)
    p, kind, looks, src = p[ok], rec["kind"][ok], rec["looks"][ok], rec["src"][ok]
    gy = ground_under(p, kind)
    if gy is None:
        return [], {"points": int(len(p)), "why": "too little ground was named to say how high anything stands"}
    h = p[:, 1] - gy
    tree = kind == TREE
    low = tree & (h > 0.15) & (h <= REACH)
    stats = {"points": int(len(p)), "tree": int(tree.sum()), "treeUnderReach": int(low.sum()), "measured": int((low & (src != 1)).sum())}
    if low.sum() < LEAST:
        return [], stats
    # the plan cells that hold tree under REACH, gathered into touching groups (eight-neighbour)
    q = p[low]
    ij = np.floor(q[:, [0, 2]] / CELL).astype(np.int64)
    ij -= ij.min(0)
    W, H = ij.max(0) + 1
    grid = np.zeros((W, H), bool)
    grid[ij[:, 0], ij[:, 1]] = True
    from scipy import ndimage
    lab, n = ndimage.label(grid, structure=np.ones((3, 3), int))
    of = lab[ij[:, 0], ij[:, 1]]
    out, wide, short, off_ground = [], 0, 0, 0
    for k in range(1, n + 1):
        m = of == k
        pts, hh = q[m], h[low][m]
        ext = max(np.ptp(pts[:, 0]), np.ptp(pts[:, 2]))
        if ext > WIDE:
            wide += 1
            continue
        levels = len(np.unique(np.floor(hh / 0.25)))
        if levels < LEAST or hh.max() < HIGH:
            short += 1
            continue
        if hh.min() > LOW:
            off_ground += 1
            continue
        c = np.median(pts[:, [0, 2]], axis=0)
        r = np.hypot(pts[:, 0] - c[0], pts[:, 2] - c[1])
        # the crown over it: the highest tree cell within 1.5 m of the trunk's middle
        near = tree & (np.hypot(p[:, 0] - c[0], p[:, 2] - c[1]) < 1.5)
        top = float(h[near].max()) if near.any() else float(hh.max())
        out.append({"x": round(float(c[0]), 2), "z": round(float(c[1]), 2), "y": round(float(np.median(gy[low][m])), 2),
                    "seenTo": round(float(hh.max()), 2), "top": round(top, 2), "across": round(float(2 * np.percentile(r, 80) + 0.1), 2),
                    "cells": int(m.sum()), "looks": int(np.median(looks[low][m])), "measured": int((src[low][m] != 1).sum())})
    stats.update({"groups": int(n), "tooWide": wide, "tooShort": short, "notToTheGround": off_ground})
    return out, stats


# ---------------------------------------------------------------- from the walk's own points (2026-11-22, second try)
"""THE FIRST TRY WAS A COMPLETE MISS (the owner's eyes, 2026-11-22: "The brown posts are a complete miss... There's a
handful of true trunks that got a very very good view and they're highly visible when viewing the depth points", and
"Rather than making whole new posts, should we just rasterize the shapes of the actual observed trunks so the[y]
maintain dimensions and orientation?"). The joined cloud was the wrong material: 11 in cells, three quarters of them
smoothed depth. The trunks the owner circled are in THE WALK'S OWN KEPT POINTS (cloud-NNNN.bin: what the camera
measured, each with the ground the phone had under it).

So: of those points, the ones standing 0.2-4 m over their own ground that are not ground, paving or building; on a
6 in plan grid, a cell is a COLUMN when its points span 4 ft or more of height in five or more levels; touching
column cells make a group; a group no wider than a trunk (2.5 ft one way, 3.3 ft the other, so a leaning trunk
passes and a hedge does not) is a trunk. And the trunk is kept AS SEEN: a slice every 10 in of height, each with its
own middle and its own width, so lean, taper and a fork's first split survive. A trunk is about forty numbers."""
PLAN = 0.15               # m: the plan grid
SPAN = 1.2                # m of height a column's points must span
LEVELS = 5                # of 0.25 m, at the least
NARROW, LONG = 0.75, 1.0  # m: a trunk's footprint, the short way and the long way, at the most
SLICE = 0.25              # m of height to a slice
TOP = 4.0                 # m over the ground: as high as a trunk is followed


def read_walk(d):
    """The walk's own kept points (the cloud's, not the weak ones): (n, 6) [t, odo, x, y, z, ground], their voted
    kinds when view-kind.bin is there (else None), and the flags byte of their labels (else zeros)."""
    import re
    recs, flags = [], []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        a = np.fromfile(os.path.join(d, n), dtype="<f4")
        a = a[: len(a) // 6 * 6].reshape(-1, 6)
        recs.append(a)
        lp = os.path.join(d, n.replace("cloud-", "labels-"))
        lab = np.fromfile(lp, dtype=np.uint8) if os.path.exists(lp) else np.zeros(0, np.uint8)
        flags.append(lab.reshape(-1, 4)[:, 3] if len(lab) == 4 * len(a) else np.zeros(len(a), np.uint8))
    if not recs:
        return np.zeros((0, 6), np.float32), None, np.zeros(0, np.uint8)
    recs, flags = np.concatenate(recs), np.concatenate(flags)
    kf = os.path.join(d, "view-kind.bin")
    kind = None
    if os.path.exists(kf) and os.path.getsize(kf) >= len(recs):
        kind = np.fromfile(kf, dtype=np.uint8, count=len(recs))     # view_prep.py: the cloud's records first, by name
    return recs, kind, flags


def find_in_walk(recs, kind, flags, cut_s=0.0):
    NOT = [KINDS.index(k) for k in ("built", "fence", "grass", "bare ground", "paved", "movable", "water", "sky")]
    t, x, y, z, g = recs[:, 0], recs[:, 2].astype(np.float64), recs[:, 3].astype(np.float64), recs[:, 4].astype(np.float64), recs[:, 5].astype(np.float64)
    h = y - g
    ok = np.isfinite(h) & np.isfinite(x) & np.isfinite(z) & (t >= cut_s) & ((flags & 3) == 0) & (h >= 0.2) & (h <= TOP)
    if kind is not None:
        ok &= ~np.isin(kind, NOT)
    st = {"points": int(len(recs)), "standing": int(ok.sum()), "kinds": kind is not None}
    if ok.sum() < 50:
        return [], st
    x, z, h, g, t = x[ok], z[ok], h[ok], g[ok], t[ok]
    ci, cj = np.floor(x / PLAN).astype(np.int64), np.floor(z / PLAN).astype(np.int64)
    ci -= ci.min(); cj -= cj.min()
    W, H = int(ci.max()) + 1, int(cj.max()) + 1
    key = ci * H + cj
    lo = np.full(W * H, np.inf); hi = np.full(W * H, -np.inf)
    np.minimum.at(lo, key, h); np.maximum.at(hi, key, h)
    lv = np.unique(np.stack([key, np.floor(h / 0.25).astype(np.int64)], 1), axis=0)
    nlev = np.bincount(lv[:, 0], minlength=W * H)
    col = ((hi - lo) >= SPAN) & (nlev >= LEVELS) & (lo <= 0.9)
    st["columnCells"] = int(col.sum())
    if not col.any():
        return [], st
    from scipy import ndimage
    # column cells a cell apart are one group (a hedge seen thinly is a row of them, not a row of trunks)
    grid = ndimage.binary_closing(np.pad(col.reshape(W, H), 1), structure=np.ones((3, 3), bool))[1:-1, 1:-1] | col.reshape(W, H)
    lab, n = ndimage.label(grid, structure=np.ones((3, 3), int))
    of = lab.reshape(-1)[key]
    out, wide, crowded = [], 0, 0
    for k in range(1, n + 1):
        m = of == k
        if m.sum() < 12:
            continue
        px, pz, ph = x[m], z[m], h[m]
        # the footprint along its own long way (a leaning trunk is long one way and narrow the other)
        c0 = np.array([px.mean(), pz.mean()])
        q = np.stack([px, pz], 1) - c0
        w_, v_ = np.linalg.eigh(np.cov(q.T) + 1e-9 * np.eye(2))
        a = q @ v_
        ext = np.sort(np.ptp(a, axis=0))
        if ext[0] > NARROW or ext[1] > LONG:
            wide += 1
            continue
        # followed up from the group: every point within 0.5 m of the trunk's line, slice by slice
        slices, c = [], np.median(np.stack([px[ph < 0.9], pz[ph < 0.9]], 1), axis=0) if (ph < 0.9).any() else c0
        for s0 in np.arange(0.2, TOP, SLICE):
            near = (h >= s0) & (h < s0 + SLICE) & (np.hypot(x - c[0], z - c[1]) < 0.5)
            if near.sum() < 3:
                if s0 > 0.9 and slices and s0 - slices[-1][0] > 2 * SLICE:
                    break
                continue
            c = np.median(np.stack([x[near], z[near]], 1), axis=0)
            r = float(np.percentile(np.hypot(x[near] - c[0], z[near] - c[1]), 80))
            slices.append([round(float(s0), 2), round(float(c[0]), 2), round(float(c[1]), 2), round(max(0.02, r), 2)])
        if len(slices) < LEVELS:
            continue
        # A TRUNK STANDS FREE at stem height: round it, 1.5 to 3 ft out, there is less standing than in the trunk itself.
        # A stem inside a hedge or a thicket fails this, and so does a piece of a hedge that passed for narrow.
        b = np.array(slices[0][1:3])
        dd = np.hypot(x - b[0], z - b[1])
        stem = (h >= 0.3) & (h <= 1.2)
        own, ring = int((stem & (dd < 0.35)).sum()), int((stem & (dd >= 0.45) & (dd < 0.9)).sum())
        if ring > own:
            crowded += 1
            continue
        top = slices[-1][0] + SLICE
        lean = float(np.hypot(slices[-1][1] - slices[0][1], slices[-1][2] - slices[0][2]))
        out.append({"y": round(float(np.median(g[m])), 2), "x": slices[0][1], "z": slices[0][2], "slices": slices, "seenTo": round(float(top), 2),
                    "across": round(float(2 * np.median([s[3] for s in slices[: max(3, len(slices) // 2)]])), 2), "lean": round(lean, 2),
                    "points": int(m.sum()), "moments": int(len(np.unique(np.floor(t[m] / 5))))})
    st.update({"groups": int(n), "tooWide": wide, "crowded": crowded})
    return out, st


def main_walk(d, out=None):
    recs, kind, flags = read_walk(d)
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    trunks, st = find_in_walk(recs, kind, flags, cut)
    print(f"TREE TRUNKS in the walk's own points: {st['points']:,} kept points, {st['standing']:,} standing 8 in to 13 ft over their own ground after the start cut ({cut / 60:.1f} min)"
          f"{', ground, paving and building left out by the voted kinds' if st['kinds'] else ' (no voted kinds with this walk: everything standing is tried)'}.")
    print(f"  Plan cells (6 in) that are a column, {SPAN * FT:.0f} ft of height in {LEVELS} levels or more: {st.get('columnCells', 0):,}; groups of them {st.get('groups', 0)}; "
          f"too wide to be a trunk {st.get('tooWide', 0)}; not standing free (in a hedge or thicket) {st.get('crowded', 0)}; TRUNKS {len(trunks)}.")
    if trunks:
        acr = sorted(t["across"] for t in trunks); tops = sorted(t["seenTo"] for t in trunks); mom = sorted(t["moments"] for t in trunks); lean = sorted(t["lean"] for t in trunks)
        mid = len(trunks) // 2
        print(f"  The trunks: across {acr[0] * 39.37:.0f} / {acr[mid] * 39.37:.0f} / {acr[-1] * 39.37:.0f} in (least / middle / most); followed up to {tops[0] * FT:.0f} / {tops[mid] * FT:.0f} / {tops[-1] * FT:.0f} ft; "
              f"leaning {lean[0] * 39.37:.0f} / {lean[mid] * 39.37:.0f} / {lean[-1] * 39.37:.0f} in over that; seen at {mom[0]} / {mom[mid]} / {mom[-1]} moments of the walk (5 s each); "
              f"{sum(len(t['slices']) for t in trunks)} slices in all.")
    out = out or os.path.join(d, "trunks.json")
    with open(out, "w") as f:
        json.dump({"v": 2, "from": "the walk's own points", "frame": "the walk's own (ARCore session), metres; y up", "startCutS": cut, "sliceM": SLICE, "trunks": trunks, "stats": st}, f)
    print(f"  Kept: {os.path.basename(out)} ({len(trunks)} trunks, each as slices [height over the ground, x, z, radius]; places not printed).")


def main():
    a = sys.argv[1:]
    if a and os.path.isdir(a[0]):
        return main_walk(a[0], a[1] if len(a) > 1 else None)
    if not a:
        print("usage: trunks.py <view-dense.bin> [view.json] [out]")
        return
    rec = np.fromfile(a[0], dtype=REC)
    cut = 0.0
    if len(a) > 1 and os.path.exists(a[1]):
        try:
            cut = float(json.load(open(a[1])).get("startCutS") or 0)
        except Exception:
            cut = 0.0
    trunks, st = find(rec, cut)
    print(f"TREE TRUNKS in the joined cloud: {st['points']:,} points after the start cut ({cut / 60:.1f} min); tree {st.get('tree', 0):,}, "
          f"of them under {REACH * FT:.1f} ft over the ground {st.get('treeUnderReach', 0):,} ({st.get('measured', 0):,} measured by the camera, the rest from the smoothed depth).")
    if "why" in st:
        print(f"  None looked for: {st['why']}.")
    else:
        print(f"  Groups of low tree cells: {st.get('groups', 0)}; too wide to be a trunk (over {WIDE * FT:.0f} ft: hedges, shrubs, low crowns) {st.get('tooWide', 0)}; "
              f"too short or too few levels {st.get('tooShort', 0)}; not reaching the ground {st.get('notToTheGround', 0)}; TRUNKS {len(trunks)}.")
    if trunks:
        acr = sorted(t["across"] for t in trunks)
        tops = sorted(t["top"] for t in trunks)
        print(f"  The trunks: across {acr[0] * 39.37:.0f} / {acr[len(acr) // 2] * 39.37:.0f} / {acr[-1] * 39.37:.0f} in (least / middle / most; a cell is about 11 in, so this is coarse); "
              f"the tree seen over them to {tops[0] * FT:.0f} / {tops[len(tops) // 2] * FT:.0f} / {tops[-1] * FT:.0f} ft; "
              f"seen by {sorted(t['looks'] for t in trunks)[len(trunks) // 2]} photos in the middle; {sum(1 for t in trunks if t['measured'] == 0)} of them only in the smoothed depth.")
    out = a[2] if len(a) > 2 else os.path.join(os.path.dirname(a[0]) or ".", "trunks.json")
    with open(out, "w") as f:
        json.dump({"v": 1, "frame": "the walk's own (ARCore session), metres; y up", "startCutS": cut, "trunks": trunks, "stats": st}, f)
    print(f"  Kept: {os.path.basename(out)} ({len(trunks)} trunks; places in the walk's own frame, not printed).")


if __name__ == "__main__":
    main()
