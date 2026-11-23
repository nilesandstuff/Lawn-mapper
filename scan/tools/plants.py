"""
THE PLANTS A WALK SAW, TAKEN AT FACE VALUE (core session, 2026-11-23).

The owner, after marking 11 trunks and looking at the four the trunk finder had wrong (two evergreen shrubs, a shrub
hydrangea, and a phantom 16 in from a real tree): "Maybe marking trunks specifically is attempting to get too
precise... Maybe we should just mark trees in general and take their shapes at face value (but clean up the noise).
And I'm noticing that the arcore scene semantics labels basically all vegetation as tree... But for the purposes of
calculating shade, I guess that's actually not a big deal. So maybe anything over 3 feet that the phone calls a tree,
is a tree."

So: no judging what a thing IS beyond "a plant that stands over 3 ft". The walk's own kept points voted tree or plant
(studies.py VOTE_KINDS; view-kind.bin), after the start cut and without the flagged spikes, are gathered on a 1 ft
plan grid; each cell keeps how low and how high plant was seen in it (its 5th and 95th height over its own ground, so
one stray point does not set either). What stays:

  - a plant point only where plant outvotes everything else seen in the same cubic foot (the owner's look,
    2026-11-23: plant "creeped up the walls of the house and consumed part of my front porch");
  - a cell with MIN_PTS points or more whose top is MIN_TOP (3 ft) or more over the ground;
  - joined to its neighbours into a shape; a shape of under MIN_CELLS cells, under MIN_SHAPE_PTS points, or seen in
    fewer than two separate seconds of the walk, is noise and is dropped.

What it does NOT do: tell a trunk from a shrub (trunks.py still does, for a landmark; nothing is judged by it here),
see a crown (the phone's depth reaches about 13 ft and gets almost nothing from bare branches: the lidar has the
crown), or take out a shape drawn twice by a walk that slid (it is drawn a little fat instead).

    python scan/tools/plants.py <twin dir> [out plants.json]

Kept: plants.json, { v, frame, cellM, startCutS, shapes: [{ id, y, top, areaM2, points, cells: [[x, z, bottom, top]] }] }
in the walk's own frame (ARCore session, metres, y up; bottom and top over the shape's ground y). Prints counts and
sizes only: no places.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trunks as TR  # noqa: E402

FT = 3.28084
CELL = 0.3048          # m: the plan grid, 1 ft
MIN_TOP = 0.9144       # m: 3 ft, the owner's line ("anything over 3 feet that the phone calls a tree, is a tree")
MIN_PTS = 5            # points in a cell, at the least
MIN_CELLS = 3          # cells in a shape, at the least (3 sq ft)
MIN_SHAPE_PTS = 40     # points in a shape, at the least
TOP = 20.0             # m over the ground: above this is a stray
OTHER = ("built", "fence", "paved", "movable", "grass", "bare ground", "water")   # what outvotes a plant in a cubic foot


def shapes_of(recs, kind, flags, cut_s=0.0):
    """-> (shapes, stats). recs (n, 6) [t, odo, x, y, z, ground]; kind the voted kinds; flags the labels' flags byte."""
    st = {"points": int(len(recs)), "kinds": kind is not None}
    if kind is None or not len(recs):
        return [], st
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    h_ = y_ - g_
    veg = np.isin(kind, [TR.KINDS.index("tree"), TR.KINDS.index("plant")])
    base = np.isfinite(h_) & np.isfinite(x_) & np.isfinite(z_) & (t_ >= cut_s) & ((flags & 3) == 0) & (h_ >= 0.15) & (h_ <= TOP)
    ok = veg & base
    st.update({"plant": int(veg.sum()), "used": int(ok.sum())})
    if ok.sum() < MIN_SHAPE_PTS:
        return [], st
    # NOT WHERE THE WALK SAW SOMETHING BUILT (the owner's look, 2026-11-23: "a couple plant columns that creeped up the
    # walls of the house and consumed part of my front porch (a 2 foot high concrete slab and light tan
    # pillars/columns)"). The phone calls a good deal that is not a plant "tree". So a plant point counts only where
    # plant OUTVOTES everything else the walk saw in the same cubic foot (and half of the most in a cubic foot beside
    # it on the level: a wall's points scatter across a cell's edge). By the cubic foot and not by the whole column,
    # so a shrub against a wall keeps its own height (the wall behind it is hidden there) and loses only what was
    # "plant" up the wall above it.
    other = base & np.isin(kind, [TR.KINDS.index(k) for k in OTHER])
    vi = np.stack([np.floor(x_ / CELL), np.floor(z_ / CELL), np.floor(h_ / CELL)], 1).astype(np.int64)
    lo3 = vi[base].min(0)
    vi -= lo3
    d1, d2 = int(vi[base][:, 1].max()) + 3, int(vi[base][:, 2].max()) + 1
    vkey = ((vi[:, 0] + 1) * d1 + (vi[:, 1] + 1)) * d2 + vi[:, 2]
    ok_keys, ok_n = np.unique(vkey[ok], return_counts=True)
    ot_keys, ot_n = np.unique(vkey[other], return_counts=True)

    def others_at(keys):
        if not len(ot_keys):
            return np.zeros(len(keys))
        j_ = np.clip(np.searchsorted(ot_keys, keys), 0, len(ot_keys) - 1)
        return np.where(ot_keys[j_] == keys, ot_n[j_], 0).astype(np.float64)
    beside = np.max(np.stack([others_at(ok_keys + dk) for dk in (d1 * d2, -d1 * d2, d2, -d2)]), axis=0)
    wins = ok_n > others_at(ok_keys) + 0.5 * beside
    won = np.zeros(len(recs), bool)
    won[ok] = wins[np.searchsorted(ok_keys, vkey[ok])]
    st.update({"outvoted": int(ok.sum() - won.sum()), "cubes": int(len(ok_keys)), "cubesOutvoted": int((~wins).sum())})
    ok = won
    if ok.sum() < MIN_SHAPE_PTS:
        return [], st
    x, z, h, g, t = x_[ok], z_[ok], h_[ok], g_[ok], t_[ok]
    ci, cj = np.floor(x / CELL).astype(np.int64), np.floor(z / CELL).astype(np.int64)
    i0, j0 = ci.min(), cj.min()
    ci -= i0; cj -= j0
    W, H = int(ci.max()) + 1, int(cj.max()) + 1
    key = ci * H + cj
    o = np.argsort(key, kind="stable")
    ks, hs = key[o], h[o]
    brk = np.flatnonzero(np.r_[True, np.diff(ks) != 0])
    ends = np.r_[brk[1:], len(ks)]
    cells = ks[brk]
    n = ends - brk
    lo = np.array([np.percentile(hs[a:b], 5) for a, b in zip(brk, ends)])
    hi = np.array([np.percentile(hs[a:b], 95) for a, b in zip(brk, ends)])
    keep = (n >= MIN_PTS) & (hi >= MIN_TOP)
    st.update({"cells": int(len(cells)), "cellsOver": int(keep.sum())})
    if not keep.any():
        return [], st
    from scipy import ndimage
    grid = np.zeros(W * H, bool); grid[cells[keep]] = True
    lab, ng = ndimage.label(grid.reshape(W, H), structure=np.ones((3, 3), int))
    lab = lab.reshape(-1)
    of_pt = lab[key]                                        # each point's shape, 0 for none
    cell_n = np.zeros(W * H, np.int64); cell_n[cells] = n
    cell_lo = np.zeros(W * H); cell_lo[cells] = lo
    cell_hi = np.zeros(W * H); cell_hi[cells] = hi
    out, small, thin, once = [], 0, 0, 0
    for k in range(1, ng + 1):
        cs = np.flatnonzero(lab == k)
        m = of_pt == k
        if len(cs) < MIN_CELLS:
            small += 1
            continue
        if int(m.sum()) < MIN_SHAPE_PTS:
            thin += 1
            continue
        if len(np.unique(np.floor(t[m]))) < 2:
            once += 1
            continue
        gy = float(np.median(g[m]))
        cx, cz = (cs // H + i0 + 0.5) * CELL, (cs % H + j0 + 0.5) * CELL
        out.append({"id": len(out) + 1, "y": round(gy, 2), "top": round(float(cell_hi[cs].max()), 2), "areaM2": round(len(cs) * CELL * CELL, 2), "points": int(m.sum()),
                    "cells": [[round(float(a), 2), round(float(b), 2), round(float(c), 2), round(float(d), 2)] for a, b, c, d in zip(cx, cz, cell_lo[cs], cell_hi[cs])]})
    st.update({"groups": int(ng), "small": small, "thin": thin, "once": once, "kept": int(sum(s["points"] for s in out))})
    return out, st


def in_shape(shapes, x, z, reach=CELL):
    """Is the place (x, z) in a shape, or within `reach` of one of its cells' middles? -> the shape or None."""
    for s in shapes:
        c = np.array(s["cells"])
        if (np.hypot(c[:, 0] - x, c[:, 1] - z) <= reach + CELL / 2).any():
            return s
    return None


def main():
    a = sys.argv[1:]
    if not a or not os.path.isdir(a[0]):
        print("usage: plants.py <twin dir> [out plants.json]")
        return 1
    d = a[0]
    recs, kind, flags = TR.read_walk(d)
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    shapes, st = shapes_of(recs, kind, flags, cut)
    if not st["kinds"]:
        print("PLANTS: this walk has no voted kinds (view-kind.bin): run the classes task first. Nothing kept.")
        return 0
    print(f"PLANTS AS THE WALK SAW THEM: {st['points']:,} kept points, {st.get('plant', 0):,} voted tree or plant, {st.get('used', 0):,} of them used (after the start cut of {cut / 60:.1f} min, no flagged spikes, 6 in to {TOP * FT:.0f} ft over their own ground).")
    print(f"  Outvoted by something built, paved or the like in the same cubic foot (or beside it): {st.get('outvoted', 0):,} of those points, in {st.get('cubesOutvoted', 0):,} of {st.get('cubes', 0):,} cubic feet with plant in them. Not counted as plant.")
    print(f"  1 ft cells with plant in them: {st.get('cells', 0):,}; with {MIN_PTS} points or more and a top {MIN_TOP * FT:.0f} ft or more up: {st.get('cellsOver', 0):,}; joined into {st.get('groups', 0)} shapes: "
          f"under {MIN_CELLS} cells {st.get('small', 0)}, under {MIN_SHAPE_PTS} points {st.get('thin', 0)}, seen in one second only {st.get('once', 0)}; KEPT {len(shapes)}, holding {st.get('kept', 0):,} points ({100 * st.get('kept', 0) / max(1, st.get('used', 1)):.0f}% of those used).")
    if shapes:
        ar = sorted(s["areaM2"] * FT * FT for s in shapes); tp = sorted(s["top"] * FT for s in shapes); mid = len(shapes) // 2
        tall = sum(1 for s in shapes if s["top"] >= 2.4384)
        print(f"  The shapes: {ar[0]:.0f} / {ar[mid]:.0f} / {ar[-1]:.0f} sq ft on the ground (least / middle / most), {sum(ar):,.0f} sq ft in all; seen up to {tp[0]:.0f} / {tp[mid]:.0f} / {tp[-1]:.0f} ft; "
              f"{tall} seen 8 ft up or more, {len(shapes) - tall} between 3 and 8 ft; {sum(len(s['cells']) for s in shapes):,} cells in all.")
    # AGAINST WHAT IS KNOWN OF THIS WALK: the owner's own trunks (a tree stands at each), and the trunk finder's
    of, tf = os.path.join(d, "owner-trunks.json"), os.path.join(d, "trunks.json")
    own = []
    if os.path.exists(of):
        try:
            own = [p for p in (json.load(open(of)).get("trunks") or []) if len(p) == 3]
        except Exception:
            own = []
    if own:
        hit = [in_shape(shapes, p[0], p[2]) for p in own]
        print(f"  THE OWNER'S OWN {len(own)} TRUNKS: {sum(1 for s in hit if s)} stand in a kept shape (or within a foot of one), {sum(1 for s in hit if not s)} in none."
              + (" Those in a shape: seen up to " + ", ".join(f"{s['top'] * FT:.0f}" for s in hit if s) + " ft." if any(hit) else ""))
    if os.path.exists(tf):
        try:
            found = json.load(open(tf)).get("trunks") or []
        except Exception:
            found = []
        if found:
            fh = [in_shape(shapes, t_["x"], t_["z"]) for t_ in found]
            print(f"  The trunk finder's {len(found)}: {sum(1 for s in fh if s)} stand in a kept shape, {sum(1 for s in fh if not s)} in none.")
    out = a[1] if len(a) > 1 else os.path.join(d, "plants.json")
    with open(out, "w") as f:
        json.dump({"v": 1, "from": "the walk's own points voted tree or plant, over 3 ft, at face value", "frame": "the walk's own (ARCore session), metres; y up", "cellM": CELL, "startCutS": cut,
                   "shapes": shapes, "stats": st}, f, separators=(",", ":"))
    print(f"  Kept: {os.path.basename(out)} ({len(shapes)} shapes, {os.path.getsize(out) / 1e6:.2f} MB; each cell [x, z, lowest, highest plant over the ground]; places not printed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
