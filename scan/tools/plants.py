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
plan grid; each cell keeps how low and how high plant was seen in it WITHOUT A BREAK (a run: read upward, over 2 ft
with no plant point ends it; a cell may hold two, a shrub and a branch over it). What stays:

  - a plant point only where plant outvotes everything else seen in the same cubic foot (the owner's look,
    2026-11-23: plant "creeped up the walls of the house and consumed part of my front porch");
  - a run of MIN_PTS points or more whose top is MIN_TOP (3 ft) or more over the ground;
  - HIGH_FT (8 ft) or more up, where the phone is far from what it sees: the points no run took, read again on 3 ft
    cells with a 6 ft break allowed, a run of HIGH_PTS or more drawn over its whole 3 ft cell (the owner, 2026-11-23:
    "stricter towards the ground... and looser up high and far away");
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
MIN_PTS = 5            # points in a run (a cell's plant seen without a break), at the least
GAP_FT = 2.0           # ft: a break longer than this with no plant point in it ends a run
HIGH_FT = 8.0          # ft: from here up the phone is far from what it sees, and the rule is looser
COARSE = 3             # the cells up high are this many feet square
HIGH_GAP_FT = 6.0      # ft: up high, a break longer than this ends a run
HIGH_PTS = 6           # points in a run up high (in COARSE x COARSE ft), at the least
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
    # EACH CELL'S PLANT, ONLY AS HIGH AND AS LOW AS IT WAS SEEN WITHOUT A BREAK (the owner's second look, 2026-11-23:
    # "There's still 3 or 4 plant columns that are just too tall. Zooming in I'm not really seeing any plant points
    # within the excessive tall columns"). The first cut took a cell's 5th and 95th height; with under twenty points
    # in a cell the 95th IS the highest, so one stray point 30 ft up drew a box from a shrub to it. Now a cell's
    # points are read upward: a break of more than GAP_FT feet with nothing in it ends a RUN, and a run is a box only
    # with MIN_PTS points or more and its top MIN_TOP or more up. So a stray point is no box, and a branch seen over a
    # shrub is its own box with air between them.
    o = np.lexsort((h, key))
    ks, hs = key[o], h[o]
    newrun = np.r_[True, (np.diff(ks) != 0) | (np.diff(hs) > GAP_FT * 0.3048)]
    rs = np.flatnonzero(newrun)
    re_ = np.r_[rs[1:], len(ks)]
    rn = re_ - rs
    rlo, rhi, rcell = hs[rs], hs[re_ - 1], ks[rs]
    good = (rn >= MIN_PTS) & (rhi >= MIN_TOP)
    run_of = np.cumsum(newrun) - 1
    used_pt = np.zeros(len(key), bool); used_pt[o] = good[run_of]
    box_cell, box_lo, box_hi = [rcell[good]], [rlo[good]], [rhi[good]]
    # LOOSER UP HIGH (the owner's third look, 2026-11-23: the false tall columns "are gone. But the sparse trees also
    # lost a lot. Maybe the rule should be stricter towards the ground (and when viewed more directly from up close)
    # and looser up high and far away?"). What is HIGH_FT or more up is far from the phone, where its depth is coarse
    # and a bare crown gives a few points to the square foot. So the points up there that no run took are read again
    # on cells COARSE feet square: upward, a break of over HIGH_GAP_FT ends a run, and a run of HIGH_PTS points or
    # more is crown, drawn over the whole coarse cell. The grain is matched to what the phone can tell that far away;
    # a stray point or two over a shrub is still no box.
    hi_pt = ~used_pt & (h >= HIGH_FT * 0.3048)
    st.update({"highLeft": int(hi_pt.sum())})
    crown_runs = 0
    if hi_pt.sum() >= HIGH_PTS:
        H3 = H // COARSE + 1
        ck = (ci[hi_pt] // COARSE) * H3 + (cj[hi_pt] // COARSE)
        hh = h[hi_pt]
        idx_hi = np.flatnonzero(hi_pt)
        o2 = np.lexsort((hh, ck))
        k2, h2 = ck[o2], hh[o2]
        nr2 = np.r_[True, (np.diff(k2) != 0) | (np.diff(h2) > HIGH_GAP_FT * 0.3048)]
        s2 = np.flatnonzero(nr2); e2 = np.r_[s2[1:], len(k2)]
        g2 = (e2 - s2) >= HIGH_PTS
        crown_runs = int(g2.sum())
        used_pt[idx_hi[o2]] = g2[np.cumsum(nr2) - 1]
        for a, b in zip(s2[g2], e2[g2]):
            I, J = int(k2[a]) // H3, int(k2[a]) % H3
            ii, jj = np.meshgrid(np.arange(I * COARSE, min(W, (I + 1) * COARSE)), np.arange(J * COARSE, min(H, (J + 1) * COARSE)), indexing="ij")
            cells_ = (ii * H + jj).reshape(-1)
            box_cell.append(cells_); box_lo.append(np.full(len(cells_), h2[a])); box_hi.append(np.full(len(cells_), h2[b - 1]))
    box_cell, box_lo, box_hi = np.concatenate(box_cell), np.concatenate(box_lo), np.concatenate(box_hi)
    st.update({"cells": int(len(np.unique(ks))), "runs": int(len(rs)), "runsKept": int(good.sum()), "cellsOver": int(len(np.unique(rcell[good]))), "crownRuns": crown_runs,
               "crownPts": int(used_pt.sum() - good[run_of].sum()), "strays": int((~used_pt & (h >= MIN_TOP)).sum()), "low": int(rn[rhi < MIN_TOP].sum())})
    if not len(box_cell):
        return [], st
    from scipy import ndimage
    grid = np.zeros(W * H, bool); grid[box_cell] = True
    lab, ng = ndimage.label(grid.reshape(W, H), structure=np.ones((3, 3), int))
    lab = lab.reshape(-1)
    of_pt = np.where(used_pt, lab[key], 0)                  # each point's shape, 0 for none
    box_shape = lab[box_cell]
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
        rr = np.flatnonzero(box_shape == k)
        cx, cz = (box_cell[rr] // H + i0 + 0.5) * CELL, (box_cell[rr] % H + j0 + 0.5) * CELL
        out.append({"id": len(out) + 1, "y": round(gy, 2), "top": round(float(box_hi[rr].max()), 2), "areaM2": round(len(cs) * CELL * CELL, 2), "points": int(m.sum()),
                    "cells": [[round(float(a), 2), round(float(b), 2), round(float(c), 2), round(float(d), 2)] for a, b, c, d in zip(cx, cz, box_lo[rr], box_hi[rr])]})
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
    print(f"  1 ft cells with plant in them: {st.get('cells', 0):,}. Read upward, a break of over {GAP_FT:.0f} ft ending a run: {st.get('runs', 0):,} runs; {st.get('runsKept', 0):,} with {MIN_PTS} points or more and a top {MIN_TOP * FT:.0f} ft or more up, in {st.get('cellsOver', 0):,} cells; "
          f"up high ({HIGH_FT:.0f} ft or more), of the {st.get('highLeft', 0):,} points no run took, {st.get('crownPts', 0):,} made {st.get('crownRuns', 0):,} crown runs on {COARSE} ft cells (a break of over {HIGH_GAP_FT:.0f} ft ending one, {HIGH_PTS} points or more); "
          f"{st.get('strays', 0):,} points were strays in the end and {st.get('low', 0):,} were plant under {MIN_TOP * FT:.0f} ft. Joined into {st.get('groups', 0)} shapes: "
          f"under {MIN_CELLS} cells {st.get('small', 0)}, under {MIN_SHAPE_PTS} points {st.get('thin', 0)}, seen in one second only {st.get('once', 0)}; KEPT {len(shapes)}, holding {st.get('kept', 0):,} points ({100 * st.get('kept', 0) / max(1, st.get('used', 1)):.0f}% of those used).")
    if shapes:
        ar = sorted(s["areaM2"] * FT * FT for s in shapes); tp = sorted(s["top"] * FT for s in shapes); mid = len(shapes) // 2
        tall = sum(1 for s in shapes if s["top"] >= 2.4384)
        print(f"  The shapes: {ar[0]:.0f} / {ar[mid]:.0f} / {ar[-1]:.0f} sq ft on the ground (least / middle / most), {sum(ar):,.0f} sq ft in all; seen up to {tp[0]:.0f} / {tp[mid]:.0f} / {tp[-1]:.0f} ft; "
              f"{tall} seen 8 ft up or more, {len(shapes) - tall} between 3 and 8 ft; {sum(len(s['cells']) for s in shapes):,} boxes in all.")
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
