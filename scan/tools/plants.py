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
CROWN_PATCH = 3        # coarse cells that touch, at the least, for what is seen up high to be a crown
MIN_CELLS = 3          # cells in a shape, at the least (3 sq ft)
MIN_SHAPE_PTS = 40     # points in a shape, at the least
TOP = 20.0             # m over the ground: above this is a stray
OTHER = ("built", "fence", "paved", "movable", "grass", "bare ground", "water")   # what outvotes a plant in a cubic foot
WANT = ("tree", "plant")
# BUILT THINGS AT FACE VALUE (2026-11-23, the walk's next part of the fused model: the owner's "best possible
# representation of reality"). The lidar draws a wall 2 ft in from a roof's edge by rule (structures.js wallsOf) and
# hardly sees a porch, a pillar or a low wall; a walk sees them where they stand. The same rules as the plants, on
# the points voted built or fence, outvoted by plant and the rest, from BUILT_MIN_TOP up (a 2 ft porch slab counts).
BUILT = ("built", "fence")
BUILT_OTHER = ("tree", "plant", "paved", "movable", "grass", "bare ground", "water")
BUILT_MIN_TOP = 0.45   # m: a foot and a half


def shapes_of(recs, kind, flags, cut_s=0.0, fit=None, want=WANT, other_kinds=OTHER, min_top=MIN_TOP):
    """-> (shapes, stats). recs (n, 6) [t, odo, x, y, z, ground]; kind the voted kinds; flags the labels' flags byte.
    fit: { theta, tx, ty, s } (the walk's corners' one fit, scan/lib/align.js: the walk's level [x, -z] to the map's
    [east, north], with the phone's scale s): when given, the points are put on the map FIRST and gridded there, so
    the cells are the map's own square feet; a cell's [x, z] is then [east, north] in the map's metres, and the
    heights are stretched by s as the distances are (the phone's scale read on the level; taken to hold upward)."""
    st = {"points": int(len(recs)), "kinds": kind is not None}
    if kind is None or not len(recs):
        return [], st
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    h_ = y_ - g_
    if fit:
        k_ = float(fit.get("s") or 1.0)
        c_, s_ = np.cos(fit["theta"]) * k_, np.sin(fit["theta"]) * k_
        u_, v_ = x_, -z_
        x_, z_ = c_ * u_ - s_ * v_ + fit["tx"], s_ * u_ + c_ * v_ + fit["ty"]
        h_ = h_ * k_
    veg = np.isin(kind, [TR.KINDS.index(k) for k in want])   # "veg": the kinds asked for (plants by default; built things: BUILT)
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
    other = base & np.isin(kind, [TR.KINDS.index(k) for k in other_kinds])
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
    good = (rn >= MIN_PTS) & (rhi >= min_top)
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
        # A CROWN IS BROAD: a crown run stays only in a patch of CROWN_PATCH coarse cells or more that touch (27 sq ft).
        # One or two alone are what the too-tall columns over the shrubs were, three feet wide this time.
        if g2.any():
            from scipy import ndimage as _nd
            W3 = W // COARSE + 1
            cg = np.zeros((W3, H3), bool)
            cg[k2[s2[g2]] // H3, k2[s2[g2]] % H3] = True
            cl, _ = _nd.label(cg, structure=np.ones((3, 3), int))
            size = np.bincount(cl.reshape(-1))
            patch = size[cl[k2[s2] // H3, k2[s2] % H3]] >= CROWN_PATCH
            st["crownAlone"] = int((g2 & ~patch).sum())
            g2 &= patch
        crown_runs = int(g2.sum())
        used_pt[idx_hi[o2]] = g2[np.cumsum(nr2) - 1]
        for a, b in zip(s2[g2], e2[g2]):
            I, J = int(k2[a]) // H3, int(k2[a]) % H3
            ii, jj = np.meshgrid(np.arange(I * COARSE, min(W, (I + 1) * COARSE)), np.arange(J * COARSE, min(H, (J + 1) * COARSE)), indexing="ij")
            cells_ = (ii * H + jj).reshape(-1)
            box_cell.append(cells_); box_lo.append(np.full(len(cells_), h2[a])); box_hi.append(np.full(len(cells_), h2[b - 1]))
    box_cell, box_lo, box_hi = np.concatenate(box_cell), np.concatenate(box_lo), np.concatenate(box_hi)
    st.update({"cells": int(len(np.unique(ks))), "runs": int(len(rs)), "runsKept": int(good.sum()), "cellsOver": int(len(np.unique(rcell[good]))), "crownRuns": crown_runs,
               "crownPts": int(used_pt.sum() - good[run_of].sum()), "strays": int((~used_pt & (h >= min_top)).sum()), "low": int(rn[rhi < min_top].sum())})
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


SEEN_CELL = 0.6096     # m: 2 ft, the plan grid of where the walk saw open air
SEEN_TOP_FT = 8        # ft: open air is claimed only this far up (where the phone is near what it looks at)
SEEN_REACH = 8.0       # m: only the sight lines this short are used
SEEN_PASSES = 6        # samples of sight lines through a cubic cell (a quarter metre apart), at the least


def read_track(d):
    """-> (M, 4) [t, x, y, z] by time: where the camera was (track-NNNN.bin; segment_study.read_track, kept here so
    this tool needs numpy and scipy only)."""
    import re
    tr = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"track-\d+\.bin", x)):
        a = np.fromfile(os.path.join(d, n), dtype="<f4")
        tr.append(a[: len(a) // 10 * 10].reshape(-1, 10)[:, [0, 2, 3, 4]])
    if not tr:
        return np.zeros((0, 4))
    tr = np.concatenate(tr).astype(np.float64)
    return tr[np.argsort(tr[:, 0])]


def seen_of(recs, flags, track, cut_s, fit):
    """WHERE THE WALK LOOKED AND SAW NOTHING (the features session's ask, 2026-11-23: `plants` "says where plant WAS
    seen, not where the phone's depth passed through empty air. Without that I... can't trim a lidar crown that
    sticks out past where the walk saw open air"). Every kept point was seen along a line from the camera: the air
    along that line, short of the point, was open. Per 2 ft square of the map: how high the air was seen OPEN from
    the ground up without a break, in decimetres, up to SEEN_TOP_FT.

    WHAT IT CLAIMS, AND WHAT IT DOES NOT. Only sight lines SEEN_REACH long or less, and only to SEEN_TOP_FT up: near
    the phone, where its depth is good. A cubic cell is open when SEEN_PASSES samples of sight lines crossed it and
    fewer than three points were seen IN it (a foot or more up: the ground's own points do not count). Above SEEN_TOP_FT nothing is claimed either way: in leaf-off months the
    phone sees straight THROUGH a bare crown to the sky, and "the phone saw through it" is not "nothing is there".
    -> { cellM, i0, j0, w, h, capDm, notSeen, enc, clearTo (zlib then base64; one byte a square, rows south to north) } or None."""
    import base64
    import zlib
    if len(track) < 10 or not fit:
        return None, {}
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    ok = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & (t_ >= cut_s) & ((flags & 3) == 0)
    if ok.sum() < 1000:
        return None, {}
    P = np.stack([x_[ok], y_[ok], z_[ok]], 1)
    gp = g_[ok]
    i_ = np.clip(np.searchsorted(track[:, 0], t_[ok]), 1, len(track) - 1)
    i_ = np.where(np.abs(track[i_ - 1, 0] - t_[ok]) < np.abs(track[i_, 0] - t_[ok]), i_ - 1, i_)
    C = track[i_, 1:4]
    # the ground under any place: the middle ground height of the points in its 1 m square, the nearest square with one
    from scipy.spatial import cKDTree
    gij = np.floor(P[:, [0, 2]]).astype(np.int64)
    o = np.lexsort((gij[:, 1], gij[:, 0]))
    gs, gy = gij[o], gp[o]
    brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
    gcell = gs[brk].astype(np.float64)
    gmed = np.array([np.median(gy[a:b]) for a, b in zip(brk, np.r_[brk[1:], len(gy)])])
    gtree = cKDTree(gcell)
    k_ = float(fit.get("s") or 1.0)
    cth, sth = np.cos(fit["theta"]) * k_, np.sin(fit["theta"]) * k_

    def on_map(X, Z):
        return cth * X - sth * (-Z) + fit["tx"], sth * X + cth * (-Z) + fit["ty"]
    band = 0.3048
    nb = SEEN_TOP_FT
    # what was seen IN each cubic cell: every kept point 6 in or more over its own ground
    he = (P[:, 1] - gp) * k_
    ee, en = on_map(P[:, 0], P[:, 2])
    D = P - C
    L = np.linalg.norm(D, axis=1)
    use = (L >= 0.8) & (L <= SEEN_REACH)
    # samples along the short sight lines, from half a metre out to 0.4 m short of the point
    S_e, S_n, S_h = [], [], []
    for s_ in np.arange(0.5, SEEN_REACH, 0.25):
        m = use & (s_ < L - 0.4)
        if not m.any():
            break
        q = C[m] + D[m] * (s_ / L[m])[:, None]
        _, near = gtree.query(np.floor(q[:, [0, 2]]))
        e_, n_ = on_map(q[:, 0], q[:, 2])
        S_e.append(e_); S_n.append(n_); S_h.append((q[:, 1] - gmed[near]) * k_)
    if not S_e:
        return None, {}
    S_e, S_n, S_h = np.concatenate(S_e), np.concatenate(S_n), np.concatenate(S_h)
    i0 = int(np.floor(min(S_e.min(), ee.min()) / SEEN_CELL)); j0 = int(np.floor(min(S_n.min(), en.min()) / SEEN_CELL))
    w = int(np.floor(max(S_e.max(), ee.max()) / SEEN_CELL)) - i0 + 1; h = int(np.floor(max(S_n.max(), en.max()) / SEEN_CELL)) - j0 + 1
    if w * h > 60000:
        return None, {"why": "the walk covers too wide a square to keep"}

    def vox(e_, n_, hh):
        b = np.floor(hh / band).astype(np.int64)
        inb = (b >= 0) & (b < nb)
        return ((np.floor(n_[inb] / SEEN_CELL).astype(np.int64) - j0) * w + (np.floor(e_[inb] / SEEN_CELL).astype(np.int64) - i0)) * nb + b[inb]
    passes = np.bincount(vox(S_e, S_n, S_h), minlength=w * h * nb).reshape(w * h, nb)
    # what stands in a cubic cell: points a foot or more up (the ground's own points scatter a few inches over it:
    # run 535 read 6,412 of 8,397 squares as "something from the ground up", which was the lawn itself)
    solid = he >= 0.3048
    inside = np.bincount(vox(ee[solid], en[solid], he[solid]), minlength=w * h * nb).reshape(w * h, nb)
    anyp = np.bincount((np.floor(en / SEEN_CELL).astype(np.int64) - j0) * w + (np.floor(ee / SEEN_CELL).astype(np.int64) - i0), minlength=w * h)
    open_ = (passes >= SEEN_PASSES) & (inside < 3)
    # THE LOWEST FOOT IS OPEN WHERE THE GROUND WAS SEEN: a sight line to the ground is only under a foot up for its
    # last few inches, which are left out as too near the point, so the lowest foot was hardly ever "crossed". Three
    # ground points seen in a square, from near, say its lowest foot of air is open there.
    low = use & (he < 0.3048)
    ground_seen = np.bincount((np.floor(en[low] / SEEN_CELL).astype(np.int64) - j0) * w + (np.floor(ee[low] / SEEN_CELL).astype(np.int64) - i0), minlength=w * h)
    open_[:, 0] = ground_seen >= 3
    run = np.cumprod(open_, axis=1).sum(1)                      # open cubic cells from the ground up without a break
    covered = (passes.sum(1) > 0) | (anyp > 0)
    val = np.where(covered, np.minimum(np.round(run * band * 10), SEEN_TOP_FT * 3), 255).astype(np.uint8)
    st = {"squares": int(covered.sum()), "openTop": int((covered & (run >= nb)).sum()), "openNone": int((covered & (run == 0)).sum()), "lines": int(use.sum())}
    return {"cellM": SEEN_CELL, "i0": i0, "j0": j0, "w": w, "h": h, "capDm": SEEN_TOP_FT * 3, "notSeen": 255,
            "what": "decimetres of open air seen from the ground up without a break, one byte a square, rows south to north; nothing is claimed above capDm",
            "enc": "zlib+base64", "clearTo": base64.b64encode(zlib.compress(val.tobytes(), 9)).decode()}, st


def phone_kinds(d, n):
    """The kinds by the phone's own labels alone (labels-NNNN.bin, byte 0 = ARCore's label + 1; studies.py PHONE_KIND),
    in the cloud parts' order; None when the labels do not match the points."""
    import re
    PHONE = {3: "built", 8: "built", 4: "tree", 5: "paved", 6: "paved", 7: "grass", 9: "movable", 10: "movable", 12: "water", 2: "sky"}
    lut = np.zeros(256, np.uint8)
    for k_, v_ in PHONE.items():
        lut[k_] = TR.KINDS.index(v_)
    parts = []
    for name in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        m_ = os.path.getsize(os.path.join(d, name)) // 24
        lp = os.path.join(d, name.replace("cloud-", "labels-"))
        lab = np.fromfile(lp, dtype=np.uint8) if os.path.exists(lp) else np.zeros(0, np.uint8)
        parts.append(lut[lab.reshape(-1, 4)[:, 0]] if len(lab) == 4 * m_ else np.zeros(m_, np.uint8))
    if not parts:
        return None
    out = np.concatenate(parts)
    return out if len(out) == n else None


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
          f"up high ({HIGH_FT:.0f} ft or more), of the {st.get('highLeft', 0):,} points no run took, {st.get('crownPts', 0):,} made {st.get('crownRuns', 0):,} crown runs on {COARSE} ft cells (a break of over {HIGH_GAP_FT:.0f} ft ending one, {HIGH_PTS} points or more, in a patch of {CROWN_PATCH} such cells or more; {st.get('crownAlone', 0)} runs stood alone and were dropped); "
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
    # THE SAME FROM THE PHONE'S OWN LABELS ALONE (ARCore's Scene Semantics, kept with every point as the walk goes;
    # studies.py PHONE_KIND), against the kinds voted afterwards from the pictures by a model on a server (21 minutes
    # of CPU a walk). The roadmap (2026-11-22): "Doing as much processing and storage on the user's device as
    # possible." If the two draw the same plants, the phone can draw them by itself at a walk's end.
    pk = phone_kinds(d, len(recs))
    if pk is not None:
        shapes_p, st_p = shapes_of(recs, pk, flags, cut)
        cell = lambda ss: {(int(np.floor(c[0] / CELL)), int(np.floor(c[1] / CELL))) for s_ in ss for c in s_["cells"]}  # noqa: E731
        A, B = cell(shapes), cell(shapes_p)
        print(f"  BY THE PHONE'S OWN LABELS ALONE: {st_p.get('plant', 0):,} points labelled tree, {len(shapes_p)} shapes, {len(B):,} sq ft. Against the voted kinds' {len(A):,} sq ft: {len(A & B):,} in both, {len(A - B):,} only by the vote, {len(B - A):,} only by the phone"
              + (f" ({100 * len(A & B) / max(1, len(A | B)):.0f}% the same of all either drew)." if A or B else "."))
        if own:
            print(f"    The owner's {len(own)} trunks: {sum(1 for p in own if in_shape(shapes_p, p[0], p[2]))} stand in a shape by the phone's labels.")
        # kept beside the vote's, for the owner's eyes in the 3D view (its "Plant shapes" button goes round both)
        with open(os.path.join(d, "plants-phone.json"), "w") as f:
            json.dump({"v": 1, "from": "the walk's own points the PHONE labelled tree, over 3 ft, at face value", "frame": "the walk's own (ARCore session), metres; y up", "cellM": CELL, "startCutS": cut,
                       "shapes": shapes_p}, f, separators=(",", ":"))
    # THE BUILT THINGS THE WALK SAW, the same way (BUILT above): for the owner's eyes in the 3D view first. Nothing is
    # kept with the map from this yet.
    built, bst = shapes_of(recs, kind, flags, cut, want=BUILT, other_kinds=BUILT_OTHER, min_top=BUILT_MIN_TOP)
    if built:
        ar = sorted(s_["areaM2"] * FT * FT for s_ in built); tp = sorted(s_["top"] * FT for s_ in built)
        print(f"  BUILT THINGS AS THE WALK SAW THEM: {bst.get('plant', 0):,} points voted built or fence, {bst.get('outvoted', 0):,} outvoted by plant or the ground's kinds in their cubic foot; {len(built)} shapes, {sum(ar):,.0f} sq ft on the ground "
              f"({ar[0]:.0f} / {ar[len(ar) // 2]:.0f} / {ar[-1]:.0f} least / middle / most), seen up to {tp[0]:.0f} / {tp[len(tp) // 2]:.0f} / {tp[-1]:.0f} ft; {sum(len(s_['cells']) for s_ in built):,} boxes.")
        with open(os.path.join(d, "built.json"), "w") as f:
            json.dump({"v": 1, "from": "the walk's own points voted built or fence, a foot and a half up or more, at face value", "frame": "the walk's own (ARCore session), metres; y up", "cellM": CELL, "startCutS": cut,
                       "shapes": built}, f, separators=(",", ":"))
    else:
        print("  Built things as the walk saw them: none kept.")
    out = a[1] if len(a) > 1 else os.path.join(d, "plants.json")
    with open(out, "w") as f:
        json.dump({"v": 1, "from": "the walk's own points voted tree or plant, over 3 ft, at face value", "frame": "the walk's own (ARCore session), metres; y up", "cellM": CELL, "startCutS": cut,
                   "shapes": shapes, "stats": st}, f, separators=(",", ":"))
    print(f"  Kept: {os.path.basename(out)} ({len(shapes)} shapes, {os.path.getsize(out) / 1e6:.2f} MB; each cell [x, z, lowest, highest plant over the ground]; places not printed).")
    # ON THE MAP (fit.json, scan/tools/walk-fit.mjs: the walk's corners' one fit, kept only when three corners agree
    # and the walk is not known to have slid): the same, gridded in the map's own square feet. The roadmap's fused
    # model begins here: what a walk saw of the plants, where the map is: one of the fused model's two sources.
    try:
        fit = json.load(open(os.path.join(d, "fit.json")))
    except Exception:
        fit = None
    if fit and fit.get("ok") and fit.get("T"):
        ms, mst = shapes_of(recs, kind, flags, cut, fit["T"])
        boxes = sorted({(int(np.floor(c[0] / CELL)), int(np.floor(c[1] / CELL)), int(round(c[2] * 10)), int(round(c[3] * 10))) for s_ in ms for c in s_["cells"]})
        mo = os.path.join(d, "plants-map.json")
        seen, sst = seen_of(recs, flags, read_track(d), cut, fit["T"])
        doc = {"v": 1, "cellM": CELL, "from": "a walk's points the phone or the vote called tree or plant, 3 ft up or more", "heights": "decimetres over the ground under each",
               "fit": {"corners": fit.get("n"), "worstM": fit.get("worstM"), "scale": fit["T"].get("s", 1)}, "boxes": [list(b) for b in boxes]}
        if seen:
            doc["seen"] = seen
            print(f"  WHERE IT LOOKED AND SAW OPEN AIR: {sst['lines']:,} sight lines of {SEEN_REACH * FT:.0f} ft or less; {sst['squares']:,} squares of 2 ft covered ({sst['squares'] * 4:,} sq ft); open all the way to {SEEN_TOP_FT} ft in {sst['openTop']:,}, not seen open from the ground in {sst['openNone']:,} (something there, or the ground not seen from near); {len(seen['clearTo']) / 1e3:.0f} KB.")
        else:
            print(f"  Where it looked and saw open air: NOT kept ({sst.get('why') or 'no camera track beside the twin, or too few points'}).")
        with open(mo, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        print(f"  ON THE MAP, by its {fit.get('n')} corners' one fit (within {(fit.get('worstM') or 0) * 39.37:.0f} in, the phone's distances scaled {((fit['T'].get('s', 1)) - 1) * 100:.1f}%): {len(ms)} shapes, {len({(b[0], b[1]) for b in boxes}):,} sq ft, {len(boxes):,} boxes, seen up to {max((b[3] for b in boxes), default=0) / 10 * FT:.0f} ft. Kept: plants-map.json ({os.path.getsize(mo) / 1e3:.0f} KB).")
    else:
        print(f"  NOT put on the map: {(fit or {}).get('why') or 'the walk has no fit kept beside it (fit.json)'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
