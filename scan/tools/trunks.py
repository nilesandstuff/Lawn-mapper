"""TREE TRUNKS FROM A WALK'S JOINED CLOUD (core session, 2026-11-22). The goal (CLAUDE.md): later walks "automatically
place fences, trees (atleast the trunks, but ideally the branches as well...)".

What there is to work with: the joined cloud the 3D view shows (dense_prep.py: one point to a cell of about 11 in, each
with the kind the photos voted and how many photos saw it). A trunk in it is a NARROW COLUMN OF TREE: tree-kind cells
stacked from near the ground to chest height and above, in a footprint no wider than a trunk. A hedge is wide; a
drooping branch does not reach the ground; a fence post is not tree.

    python scan/tools/trunks.py <view-dense.bin> [view.json] [out trunks.json]

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


def main():
    a = sys.argv[1:]
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
