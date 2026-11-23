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
NARROW, LONG = 1.2, 1.6   # m: the footprint of ALL its sightings together, the short way and the long way, at the most
TALL = 2.4                # m over the ground: something stands this tall at a tree; a shrub does not
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
    """THE THIRD PASS (2026-11-22, after the owner's eyes on the second: one false match, "a shrub"; "more real trees
    were marked"; "a handful of real trees that were given a very good look from multiple angles were missed"; and
    "I've got trees that are as small as 4 inches in diameter, some that are close to 2 foot... Tree trunks can be even
    bigger than those, by a lot").
      - A trunk seen from several sides at several moments is SMEARED by the walk's own drift (two sightings of one
        place lie 6-20 in apart, section 48), and a 2 ft trunk so seen is 3 ft across: the second pass threw it out as
        too wide. The footprint may now be 4 ft by 5 ft, and the trunk's shape is taken from its ONE BEST SIGHTING
        (the moment with the most points), so the slices are a trunk as it was seen once, not a smear.
      - A SHRUB IS SHORT: something must stand 8 ft or more over the ground at the trunk (its own stem, or its crown).
      - STANDING FREE is asked of what is round it that is NOT itself a column: a row of young trees 3 ft apart are
        each other's neighbours, not a thicket.
    -> the trunks, and the counts."""
    NOT = [KINDS.index(k) for k in ("built", "fence", "grass", "bare ground", "paved", "movable", "water", "sky")]
    t_, x_, y_, z_, g_ = recs[:, 0].astype(np.float64), recs[:, 2].astype(np.float64), recs[:, 3].astype(np.float64), recs[:, 4].astype(np.float64), recs[:, 5].astype(np.float64)
    h_ = y_ - g_
    base = np.isfinite(h_) & np.isfinite(x_) & np.isfinite(z_) & (t_ >= cut_s) & ((flags & 3) == 0)
    if kind is not None:
        base &= ~np.isin(kind, NOT)
    ok = base & (h_ >= 0.2) & (h_ <= TOP)
    up = base & (h_ >= TALL) & (h_ <= 20)                      # what stands tall: a stem's upper part, a crown
    st = {"points": int(len(recs)), "standing": int(ok.sum()), "kinds": kind is not None}
    if ok.sum() < 50:
        return [], st
    ux, uz = x_[up], z_[up]
    x, z, h, g, t = x_[ok], z_[ok], h_[ok], g_[ok], t_[ok]
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
    in_col = grid.reshape(-1)[key]
    out, wide, crowded, short, thin = [], 0, 0, 0, 0
    turned = []   # every group turned away: where (the walk's frame), by which rule, with the rule's own numbers
    for k in range(1, n + 1):
        m = of == k
        if m.sum() < 12:
            thin += 1
            turned.append({"x": float(np.median(x[m])), "z": float(np.median(z[m])), "why": f"too few points ({int(m.sum())}, 12 needed)"})
            continue
        px, pz, ph, pt = x[m], z[m], h[m], t[m]
        c0 = np.array([np.median(px), np.median(pz)])
        q = np.stack([px, pz], 1) - c0
        _, v_ = np.linalg.eigh(np.cov(q.T) + 1e-9 * np.eye(2))
        ext = np.sort(np.ptp(q @ v_, axis=0))
        if ext[0] > NARROW or ext[1] > LONG:
            wide += 1
            turned.append({"x": float(c0[0]), "z": float(c0[1]), "why": f"too wide ({ext[0] * 39.37:.0f} by {ext[1] * 39.37:.0f} in; {NARROW * 39.37:.0f} by {LONG * 39.37:.0f} allowed)"})
            continue
        # a shrub is short: something stands TALL or more over the ground within a metre of it
        if not ((np.hypot(ux - c0[0], uz - c0[1]) < 1.0).sum() >= 3):
            short += 1
            turned.append({"x": float(c0[0]), "z": float(c0[1]), "why": f"nothing standing {TALL * FT:.0f} ft within a metre ({int((np.hypot(ux - c0[0], uz - c0[1]) < 1.0).sum())} points, 3 needed; its own top {float(ph.max()) * FT:.1f} ft)"})
            continue
        # its sightings: the group's points in time, a new sighting after 20 s without one; the best has the most points
        o = np.argsort(pt)
        brk = np.flatnonzero(np.diff(pt[o]) > 20)
        seg = np.split(o, brk + 1)
        best = max(seg, key=len)
        if len(best) < 8:
            thin += 1
            turned.append({"x": float(c0[0]), "z": float(c0[1]), "why": f"its best sighting too thin ({len(best)} points of {int(m.sum())}, 8 needed)"})
            continue
        t0, t1 = pt[best].min() - 3, pt[best].max() + 3
        lowb = best[ph[best] < 1.2] if (ph[best] < 1.2).any() else best
        c = np.median(np.stack([px[lowb], pz[lowb]], 1), axis=0)
        cents = [np.median(np.stack([px[sg], pz[sg]], 1), axis=0) for sg in seg if len(sg) >= 8]
        apart = float(max(np.hypot(*(cc - c)) for cc in cents)) if len(cents) > 1 else 0.0
        # standing free: at stem height, what is round it that is not itself a column is less than the trunk itself
        r_own = max(0.35, ext[0] / 2 + 0.1)
        dd = np.hypot(x - c0[0], z - c0[1])
        stem = (h >= 0.3) & (h <= 1.2)
        own, ring = int((stem & (dd < r_own)).sum()), int((stem & ~in_col & (dd >= r_own + 0.15) & (dd < r_own + 0.6)).sum())
        if ring > own:
            crowded += 1
            turned.append({"x": float(c0[0]), "z": float(c0[1]), "why": f"not standing free ({ring} points in the ring round it at stem height against its own {own}; {ext[0] * 39.37:.0f} by {ext[1] * 39.37:.0f} in)"})
            continue
        # the trunk as its best sighting saw it: every point of that moment within 0.5 m of the line, slice by slice
        now = (t >= t0) & (t <= t1)
        slices, cc = [], c.copy()
        for s0 in np.arange(0.2, TOP, SLICE):
            near = now & (h >= s0) & (h < s0 + SLICE) & (np.hypot(x - cc[0], z - cc[1]) < 0.5)
            if near.sum() < 3:
                if s0 > 0.9 and slices and s0 - slices[-1][0] > 2 * SLICE:
                    break
                continue
            cc = np.median(np.stack([x[near], z[near]], 1), axis=0)
            r = float(np.percentile(np.hypot(x[near] - cc[0], z[near] - cc[1]), 80))
            slices.append([round(float(s0), 2), round(float(cc[0]), 2), round(float(cc[1]), 2), round(max(0.02, r), 2)])
        if len(slices) < LEVELS - 1:
            thin += 1
            turned.append({"x": float(c0[0]), "z": float(c0[1]), "why": f"its best sighting followed over too few levels ({len(slices)}, {LEVELS - 1} needed)"})
            continue
        lean = float(np.hypot(slices[-1][1] - slices[0][1], slices[-1][2] - slices[0][2]))
        out.append({"y": round(float(np.median(g[m])), 2), "x": slices[0][1], "z": slices[0][2], "slices": slices, "seenTo": round(float(slices[-1][0] + SLICE), 2),
                    "across": round(float(2 * np.median([s_[3] for s_ in slices[: max(3, len(slices) // 2)]])), 2), "lean": round(lean, 2),
                    "points": int(m.sum()), "sightings": int(len(cents) or 1), "apart": round(apart, 2), "footprint": round(float(ext[1]), 2)})
    st.update({"groups": int(n), "tooWide": wide, "crowded": crowded, "short": short, "thin": thin, "_turned": turned})
    return out, st


def main_walk_why(recs, kind, flags, cut_s, at):
    """For each place (x, z) the owner marked and the finder missed: how many of the walk's kept points stand within
    2 ft of it at stem height, and of what voted kinds, in words. -> { reason: count }"""
    NOT = [KINDS.index(k) for k in ("built", "fence", "grass", "bare ground", "paved", "movable", "water", "sky")]
    t, x, y, z, g = recs[:, 0], recs[:, 2].astype(np.float64), recs[:, 3].astype(np.float64), recs[:, 4].astype(np.float64), recs[:, 5].astype(np.float64)
    h = y - g
    fin = np.isfinite(h) & np.isfinite(x) & np.isfinite(z)
    out = {}
    for px, pz in at:
        near = fin & (np.hypot(x - px, z - pz) < 0.6) & (h >= 0.2) & (h <= TOP)
        n = int(near.sum())
        if n < 12:
            r = "under 12 points there at all"
        elif int((near & (t < cut_s)).sum()) > 0.6 * n:
            r = "seen only before the start cut"
        elif kind is not None and int((near & np.isin(kind, NOT)).sum()) > 0.6 * n:
            ks = kind[near & np.isin(kind, NOT)]
            r = f"voted {KINDS[int(np.bincount(ks).argmax())]}, not tree"
        elif int((near & ((flags & 3) != 0)).sum()) > 0.6 * n:
            r = "flagged as spikes"
        else:
            span = float(h[near].max() - h[near].min())
            r = "points there, but not a column (under 4 ft of height)" if span < SPAN else "a column there that a rule turned away (too wide, not free, too few points or short)"
        out[r] = out.get(r, 0) + 1
    return out


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
    print(f"  Plan cells (6 in) that are a column, {SPAN * FT:.0f} ft of height in {LEVELS} levels or more: {st.get('columnCells', 0):,}; groups of them {st.get('groups', 0)}: "
          f"too few points {st.get('thin', 0)}; too wide even for a trunk seen from all sides {st.get('tooWide', 0)}; nothing standing {TALL * FT:.0f} ft at it (a shrub) {st.get('short', 0)}; "
          f"not standing free {st.get('crowded', 0)}; TRUNKS {len(trunks)}.")
    if trunks:
        mid = len(trunks) // 2
        acr = sorted(t["across"] for t in trunks); tops = sorted(t["seenTo"] for t in trunks); sg = sorted(t["sightings"] for t in trunks)
        ap = sorted(t["apart"] for t in trunks if t["sightings"] > 1); fp = sorted(t["footprint"] for t in trunks)
        print(f"  The trunks, each as its best sighting saw it: across {acr[0] * 39.37:.0f} / {acr[mid] * 39.37:.0f} / {acr[-1] * 39.37:.0f} in (least / middle / most); followed up to {tops[0] * FT:.0f} / {tops[mid] * FT:.0f} / {tops[-1] * FT:.0f} ft; "
              f"seen at {sg[0]} / {sg[mid]} / {sg[-1]} separate times; all their sightings together {fp[0] * 39.37:.0f} / {fp[mid] * 39.37:.0f} / {fp[-1] * 39.37:.0f} in across"
              + (f"; one trunk's sightings lie up to {ap[0] * 39.37:.0f} / {ap[len(ap) // 2] * 39.37:.0f} / {ap[-1] * 39.37:.0f} in apart (the walk's own drift at a trunk)" if ap else "") + f"; {sum(len(t['slices']) for t in trunks)} slices in all.")
    # AGAINST THE OWNER'S OWN TRUNKS (owner-trunks.json: where the owner tapped "a tree trunk is here" in the 3D view,
    # the walk's own frame). A found trunk within 2.5 ft on the level of a tapped one is that tree. Counts only.
    of = os.path.join(d, "owner-trunks.json")
    if os.path.exists(of):
        try:
            own = [p for p in (json.load(open(of)).get("trunks") or []) if len(p) == 3]
        except Exception:
            own = []
        if own:
            O = np.array([[p[0], p[2]] for p in own])
            Fd = np.array([[t["x"], t["z"]] for t in trunks]) if trunks else np.zeros((0, 2))
            dm = np.hypot(O[:, None, 0] - Fd[None, :, 0], O[:, None, 1] - Fd[None, :, 1]) if len(Fd) else np.zeros((len(O), 0))
            hit_o = (dm.min(1) <= 0.75) if len(Fd) else np.zeros(len(O), bool)
            hit_f = (dm.min(0) <= 0.75) if len(Fd) else np.zeros(0, bool)
            near = sorted(float(x) for x in dm.min(1)[hit_o]) if hit_o.any() else []
            print(f"  AGAINST THE OWNER'S OWN {len(own)} TRUNKS: found {int(hit_o.sum())} of them, missed {int((~hit_o).sum())}; of the {len(trunks)} found, {int((~hit_f).sum())} are at no trunk the owner marked."
                  + (f" Where found, {near[len(near) // 2] * 39.37:.0f} in from the owner's tap in the middle, {near[-1] * 39.37:.0f} at the most." if near else ""))
            # why each missed one was missed: what the finder had at that place
            if (~hit_o).any():
                why = main_walk_why(recs, kind, flags, cut, O[~hit_o])
                print("  The missed ones, by what stood at the owner's tap: " + ", ".join(f"{k} {v}" for k, v in sorted(why.items(), key=lambda kv: -kv[1])) + ".")
                # WHICH RULE, with its numbers (2026-11-23: "a rule turned away" named four rules at once): the group
                # turned away nearest each missed tap, within 3 ft
                tn = st.get("_turned") or []
                for i in np.flatnonzero(~hit_o):
                    dd = [float(np.hypot(O[i, 0] - g_["x"], O[i, 1] - g_["z"])) for g_ in tn]
                    j = int(np.argmin(dd)) if dd else -1
                    print("    a missed one: " + (f"{tn[j]['why']}, {dd[j] * 39.37:.0f} in from the tap." if j >= 0 and dd[j] <= 0.9 else "no group of column cells within 3 ft of the tap."))
            # each trunk found, with what it was found by: the ones at one of the owner's and the ones at none
            for i, t_ in enumerate(trunks):
                print(f"    found, {'at one the owner marked' if hit_f[i] else 'AT NONE the owner marked'}: {t_['across'] * 39.37:.0f} in across, followed to {t_['seenTo'] * FT:.0f} ft over {len(t_['slices'])} slices, {t_['points']} points, seen {t_['sightings']} time{'s' if t_['sightings'] != 1 else ''}, all sightings {t_['footprint'] * 39.37:.0f} in across, leaning {t_['lean'] * 39.37:.0f} in.")
    out = out or os.path.join(d, "trunks.json")
    with open(out, "w") as f:
        json.dump({"v": 3, "from": "the walk's own points, each trunk as its best sighting saw it", "frame": "the walk's own (ARCore session), metres; y up", "startCutS": cut, "sliceM": SLICE, "trunks": trunks, "stats": {k_: v_ for k_, v_ in st.items() if not k_.startswith("_")}}, f)
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
