"""
CAN A LEAF-OFF WALK TAKE LIDAR BRANCHES AWAY? (core session, 2026-11-24). The owner: "right now, we are only adding
branches that are missing from lidar because bare branches are harder to see... Is there any path to removing lidar
branches during bare branch walks?"

The fusing trims a lidar crown by the air a walk saw open above 8 ft only when the walk was IN LEAF (the owner,
2026-11-23: sky seen through a bare crown "should not be a signal that there's no tree there"). That rule is right
for ONE sight line: a line through a bare crown usually misses every twig. It need not be right for MANY lines: a
bare crown still stops some of the lines through it (the phone's depth lands on a branch), so a place that many lines
crossed without one stopping is not a bare crown, it is air. How many is "many" is a property of bare crowns as THIS
phone sees them, and is measured here from the walk itself:

  1. THE BARE CROWNS THE WALK DID SEE (8 ft up or more, the phone's own "tree" label): how often a sight line inside
     one ends on something there. A rate per metre of line, `mu`. A line crossing two metres of such a crown stops in
     it 1 - exp(-2 mu) of the time.
  2. THE WALK AGAINST ITSELF (the owner, 2026-11-20: prove a lidar-based step "by the walk agreeing with itself"):
     the walk cut in two by time (alternate ten-second stretches, so the halves look from different places). Half A's
     sight lines say which 2 ft x 2 ft x half-metre blocks of air were crossed by at least so many metres of line with
     nothing seen in them. Half B says where crowns are. A rule that would carve away a block where half B saw a crown
     is wrong that often; the blocks it clears that half B saw nothing in are what it would give.

No lidar is read: this is whether the WALK can say "nothing is here" in leaf-off months, and how far, before it is
put against the lidar. Counts, rates and heights only.

  python scan/tools/bare_study.py <twin dir>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plants as PL  # noqa: E402
import trunks as TR  # noqa: E402

FT = 3.28084
LOW = 8 / FT          # m: 8 ft, where the walk's open air stops being claimed in leaf-off months
TOPM = 20.0           # m over the ground: no higher
COL = 0.6096          # m: 2 ft columns
SLAB = 0.5            # m: blocks of air half a metre high
STEP = 0.1            # m between samples along a sight line
CROWN_PTS = 6         # tree points 8 ft up or more in a column for it to hold a crown
BLOCK_S = 10.0        # s: the stretches of the walk dealt alternately to the two halves
NEEDS = (1.0, 2.0, 4.0, 8.0, 16.0)   # metres of line through a block with nothing seen in it


def main():
    a = sys.argv[1:]
    if not a or not os.path.isdir(a[0]):
        print("usage: bare_study.py <twin dir>")
        return 1
    d = a[0]
    recs, kind, flags = TR.read_walk(d)
    pk = PL.phone_kinds(d, len(recs))
    lab, by = (pk, "the phone's own labels") if pk is not None else (kind, "the pictures' vote")
    track = PL.read_track(d)
    if lab is None or len(track) < 10:
        print("BARE CROWNS: the walk has no labels or no camera track. Nothing measured.")
        return 0
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            import json
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    ok = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & (t_ >= cut) & ((flags & 3) == 0)
    P = np.stack([x_[ok], y_[ok], z_[ok]], 1)
    gp, tt, L_ = g_[ok], t_[ok], lab[ok]
    tree = TR.KINDS.index("tree")
    isTree = np.isin(L_, [tree, TR.KINDS.index("plant")])
    i_ = np.clip(np.searchsorted(track[:, 0], tt), 1, len(track) - 1)
    i_ = np.where(np.abs(track[i_ - 1, 0] - tt) < np.abs(track[i_, 0] - tt), i_ - 1, i_)
    C = track[i_, 1:4]
    half = (np.floor(tt / BLOCK_S).astype(np.int64) % 2)          # 0: half A, 1: half B
    # the ground under any place (the middle ground of the points in its 1 m square, the nearest square with one)
    from scipy.spatial import cKDTree
    gij = np.floor(P[:, [0, 2]]).astype(np.int64)
    o = np.lexsort((gij[:, 1], gij[:, 0]))
    gs, gy = gij[o], gp[o]
    brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
    gmed = np.array([np.median(gy[s:e]) for s, e in zip(brk, np.r_[brk[1:], len(gy)])])
    gtree = cKDTree(gs[brk].astype(np.float64))
    # the blocks: 2 ft columns over the walk's extent, half-metre slabs from 8 ft to 20 m
    x0, z0 = P[:, 0].min() - 1, P[:, 2].min() - 1
    nx, nz = int((P[:, 0].max() + 1 - x0) / COL) + 1, int((P[:, 2].max() + 1 - z0) / COL) + 1
    ns = int((TOPM - LOW) / SLAB) + 1
    nb = nx * nz * ns

    def key(x, z, h):
        ci, cj, k = ((x - x0) / COL).astype(np.int64), ((z - z0) / COL).astype(np.int64), np.floor((h - LOW) / SLAB).astype(np.int64)
        good = (h >= LOW) & (h < TOPM) & (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < nz)
        return np.where(good, (ci * nz + cj) * ns + np.clip(k, 0, ns - 1), -1)
    he = P[:, 1] - gp
    kp = key(P[:, 0], P[:, 2], he)
    # what was SEEN in each block, by each half: every point (stops), and the tree points
    stops = [np.bincount(kp[(kp >= 0) & (half == h)], minlength=nb) for h in (0, 1)]
    trees = [np.bincount(kp[(kp >= 0) & (half == h) & isTree], minlength=nb) for h in (0, 1)]
    # the metres of sight line through each block, by each half: all of it short of the point (for the crowns' rate),
    # and the part a claim may rest on (short of the last 15% and 0.4 m: the depth's error, range_study.py)
    D = P - C
    L = np.linalg.norm(D, axis=1)
    use = (L >= 0.8) & (L <= PL.SEEN_REACH)
    path_all = [np.zeros(nb), np.zeros(nb)]
    path_ok = [np.zeros(nb), np.zeros(nb)]
    for s_ in np.arange(0.5, float(L[use].max()) if use.any() else 0.0, STEP):
        m = use & (s_ < L)
        if not m.any():
            break
        q = C[m] + D[m] * (s_ / L[m])[:, None]
        _, near = gtree.query(np.floor(q[:, [0, 2]]))
        kq = key(q[:, 0], q[:, 2], q[:, 1] - gmed[near])
        claim = s_ < (L[m] - np.maximum(0.4, PL.SEEN_SHORT * L[m]))
        hm = half[m]
        for h in (0, 1):
            sel = (kq >= 0) & (hm == h)
            if sel.any():
                path_all[h] += np.bincount(kq[sel], minlength=nb) * STEP
                sel2 = sel & claim
                if sel2.any():
                    path_ok[h] += np.bincount(kq[sel2], minlength=nb) * STEP
    print(f"\nCAN A LEAF-OFF WALK TAKE LIDAR BRANCHES AWAY? (bare_study.py; labels: {by}; blocks 2 ft x 2 ft x half a metre, 8 ft to {TOPM * FT:.0f} ft up)")
    print(f"  {ok.sum():,} points, {use.sum():,} sight lines of 0.8 to {PL.SEEN_REACH:.0f} m; the walk cut into alternate {BLOCK_S:.0f} s stretches: half A {int((half == 0).sum()):,} points, half B {int((half == 1).sum()):,}.")
    looked = ((path_ok[0] + path_ok[1]) > 0).reshape(-1, ns)
    hb = lambda lo, hi: slice(int((lo / FT - LOW) / SLAB), int((hi / FT - LOW) / SLAB))  # noqa: E731
    BANDS = ((8, 16), (16, 30), (30, 50), (50, 65))
    print(f"  Blocks of air 8 ft up or more that any sight line crossed (short of its last 15%): {int(looked.sum()):,}; the ground under them, by height: "
          + ", ".join(f"{lo}-{hi} ft {int(looked[:, hb(lo, hi)].any(1).sum()) * 4:,} sq ft" for lo, hi in BANDS) + ".")
    # 1. THE CROWNS THE WALK SAW, AND HOW OFTEN A LINE INSIDE ONE STOPS
    col_tree = (trees[0] + trees[1]).reshape(-1, ns)
    crown_col = col_tree.sum(1) >= CROWN_PTS
    band = np.zeros((nx * nz, ns), bool)
    for c in np.flatnonzero(crown_col):
        ks = np.flatnonzero(col_tree[c])
        band[c, ks.min():ks.max() + 1] = True
    band = band.reshape(-1)
    st_all = (stops[0] + stops[1])
    ex_all = (path_all[0] + path_all[1])
    cols = []
    for c in np.flatnonzero(crown_col):
        sl = slice(c * ns, (c + 1) * ns)
        b_ = band[sl]
        ex, sp = ex_all[sl][b_].sum(), st_all[sl][b_].sum()
        if ex >= 5:
            cols.append((sp / ex, ex, sp))
    if not cols:
        print("  THE CROWNS THE WALK SAW: too few lines through them to measure. Nothing more.")
        return 0
    mu = np.array([c[0] for c in cols])
    q25, q50, q75 = np.percentile(mu, [25, 50, 75])
    print(f"  1. THE CROWNS THE WALK SAW 8 ft up or more ({int(crown_col.sum()):,} columns of 2 ft with {CROWN_PTS} tree points or more; {len(cols):,} crossed by 5 m of line or more): "
          f"a sight line inside one ends on something there at {q25:.2f} / {q50:.2f} / {q75:.2f} per metre (a quarter / the middle / three quarters of the crowns). "
          f"So a line crossing 2 m of the sparsest quarter of them is stopped {100 * (1 - np.exp(-2 * q25)):.0f}% of the time, of the middle {100 * (1 - np.exp(-2 * q50)):.0f}%; "
          f"to see NOTHING in a block that is such a crown, 1 time in 20, takes {3 / max(q25, 1e-6):.1f} m of line through it (the sparse quarter) or {3 / max(q50, 1e-6):.1f} m (the middle).")
    # 2. THE WALK AGAINST ITSELF: half A clears, half B says where crowns are (and the other way round)
    print("  2. THE WALK AGAINST ITSELF (one half's lines clear a block when that many metres of them crossed it and they saw nothing in it; the other half says where crowns are):")
    for need in NEEDS:
        fc, cr, cleared, hit = 0, 0, 0, 0
        for A, B in ((0, 1), (1, 0)):
            colB = trees[B].reshape(-1, ns)
            cB = colB.sum(1) >= CROWN_PTS
            bandB = np.zeros((nx * nz, ns), bool)
            for c in np.flatnonzero(cB):
                ks = np.flatnonzero(colB[c])
                bandB[c, ks.min():ks.max() + 1] = True
            bandB = bandB.reshape(-1)
            clear = (path_ok[A] >= need) & (stops[A] == 0)
            # a crown block of B's, crossed by A's lines (at the least 0.5 m of them) and cleared by them: carved wrongly
            seenB = bandB & (path_ok[A] >= 0.5)
            fc += int((clear & bandB).sum()); cr += int(seenB.sum())
            nb_ = clear & ~bandB
            cleared += int(nb_.sum()); hit += int((nb_ & (stops[B] > 0)).sum())
            if A == 0:
                cb = nb_.reshape(-1, ns)
                where = ", ".join(f"{lo}-{hi} ft {int(cb[:, hb(lo, hi)].any(1).sum()) * 4:,}" for lo, hi in BANDS)
        print(f"     {need:>4.0f} m of line, nothing seen: of the crown blocks the other half saw (and this half's lines crossed), {fc:,} of {cr:,} cleared WRONGLY ({100 * fc / max(1, cr):.1f}%); "
              f"elsewhere {cleared:,} blocks cleared, and in {hit:,} of them ({100 * hit / max(1, cleared):.1f}%) the other half saw something. Half A's cleared air over the ground, sq ft by height: {where}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
