"""
ARE THE FAR POINTS WRONG, OR ONLY FEW? AND WHICH "SOLID" POINTS ARE SKY? (core session, 2026-11-23)

The owner, 2026-11-23: "I saw mentions of 13 feet from the shade map and 25 feet from you regarding limiting observed
objects to that distance... I don't think we've demonstrated that the AR is inaccurate to that distance, we've just
demonstrated that it delivers sparse points. I don't think we should be handicapping ourselves by arbitrarily ignoring
distant points, unless you demonstrate that they're just plain wrong." And: "when dots on roof edges are colored by
the photo, there's often a bump there of depth points. So we should be treating sky blue points for what they are,
sky... Not a solid part of the roof".

Both limits (fuse.js PLANT_TRUST_M, plants.py SEEN_REACH) were the core session's caution, not a measurement. This
measures, by THE WALK AGREEING WITH ITSELF (no lidar in it):

  1. BY HOW FAR THE PHONE WAS FROM A POINT WHEN IT SAW IT. What the walk saw from CLOSE (within NEAR_M) is the
     judge: a cubic foot with points seen from close is a SURFACE; a cubic foot that close sight lines crossed again
     and again with nothing seen in it is OPEN AIR. Every point seen from farther off, where the judge has a view, is
     then one of: ON a surface seen from close (within a foot), IN air seen open from close, or neither. A depth that
     is "just plain wrong" puts points in open air; a depth that is only sparse does not. The same for the HEIGHT a
     point stands at.
  2. SKY AMONG THE SOLID. Of the points voted built, fence, tree or plant: how many the PHONE'S OWN label called
     sky, how many are sky-coloured in the photo, by height and by how far off; and of the judged ones, how many
     stood in air seen open from close.

    python scan/tools/range_study.py <twin dir>

Reads cloud-*.bin, labels-*.bin, track-*.bin, view-kind.bin, view-rgb.bin, view.json / start.json. Prints counts and
shares only: no places.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trunks as TR   # noqa: E402
import plants as PL   # noqa: E402

FT = 3.28084
NEAR_M = 3.0           # m: seen from this close is the judge
VOX = 0.3048           # m: a cubic foot
OPEN_PASSES = 8        # samples of close sight lines through a cubic foot, at the least, for it to be open air
BINS = [(0, 3), (3, 5), (5, 8), (8, 12), (12, 18), (18, 30), (30, 65)]


def main():
    a = sys.argv[1:]
    if not a or not os.path.isdir(a[0]):
        print("usage: range_study.py <twin dir>")
        return 1
    d = a[0]
    recs, kind, flags = TR.read_walk(d)
    track = PL.read_track(d)
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    if len(recs) < 1000 or len(track) < 10:
        print("RANGE: too few points or no camera track: nothing measured.")
        return 0
    t, x, y, z, g = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    ok = np.isfinite(x) & np.isfinite(y) & np.isfinite(z) & np.isfinite(g) & (t >= cut) & ((flags & 3) == 0)
    i_ = np.clip(np.searchsorted(track[:, 0], t), 1, len(track) - 1)
    i_ = np.where(np.abs(track[i_ - 1, 0] - t) < np.abs(track[i_, 0] - t), i_ - 1, i_)
    C = track[i_, 1:4]
    P = np.stack([x, y, z], 1)
    D = P - C
    L = np.linalg.norm(D, axis=1)
    h = y - g
    print(f"HOW FAR OFF THE PHONE SAW ITS POINTS (the walk's own kept points after the start cut of {cut / 60:.1f} min, flagged spikes left out): {int(ok.sum()):,} points.")
    print("  By how far the phone was: " + "; ".join(f"{lo * FT:.0f}-{hi * FT:.0f} ft {int((ok & (L >= lo) & (L < hi)).sum()):,}" for lo, hi in BINS) + ".")

    # THE JUDGE: what was seen from close. Cubic feet, keyed.
    lo3 = np.floor(P[ok].min(0) / VOX).astype(np.int64) - 2
    dims = np.floor(P[ok].max(0) / VOX).astype(np.int64) - lo3 + 3

    def key(Q):
        v = np.floor(Q / VOX).astype(np.int64) - lo3
        inb = (v >= 0).all(1) & (v < dims).all(1)
        return (v[:, 0] * dims[1] + v[:, 1]) * dims[2] + v[:, 2], inb
    near = ok & (L <= NEAR_M) & (L >= 0.3)
    kn, inb = key(P[near])
    surf_k, surf_n = np.unique(kn[inb], return_counts=True)
    surf_k = surf_k[surf_n >= 3]
    # a surface, and the cubic feet touching it (a foot's leeway: the walk slides inches between two looks)
    offs = np.array([(i * dims[1] + j) * dims[2] + k_ for i in (-1, 0, 1) for j in (-1, 0, 1) for k_ in (-1, 0, 1)])
    surf_near = np.unique((surf_k[:, None] + offs[None, :]).reshape(-1))
    # open air: close sight lines' samples, a quarter metre apart, from 0.4 m out to 0.45 m short of the point
    samp = []
    for s_ in np.arange(0.4, NEAR_M, 0.25):
        m = near & (s_ < L - 0.45)
        if not m.any():
            break
        kq, ib = key(C[m] + D[m] * (s_ / L[m])[:, None])
        samp.append(kq[ib])
    samp = np.concatenate(samp) if samp else np.zeros(0, np.int64)
    air_k, air_n = np.unique(samp, return_counts=True)
    air_k = air_k[air_n >= OPEN_PASSES]
    air_k = air_k[~np.isin(air_k, surf_near)]                 # not a cubic foot on or beside a surface
    print(f"  THE JUDGE, what the walk saw from {NEAR_M * FT:.0f} ft or less: {int(near.sum()):,} points; {len(surf_k):,} cubic feet with a surface in them; {len(air_k):,} cubic feet of air seen open ({OPEN_PASSES} sight-line samples or more through each, nothing seen in it, none beside a surface).")

    kp, ibp = key(P)
    on_surf = ibp & np.isin(kp, surf_near)
    in_air = ibp & np.isin(kp, air_k)
    judged = on_surf | in_air

    def row(m, name):
        n, j = int(m.sum()), int((m & judged).sum())
        if j < 30:
            return f"    {name}: {n:,} points, {j} where the judge has a view: too few to say."
        s_, a_ = int((m & on_surf).sum()), int((m & in_air).sum())
        return f"    {name}: {n:,} points, {j:,} where the judge has a view: {100 * s_ / j:.0f}% ON a surface seen from close, {100 * a_ / j:.0f}% IN AIR seen open from close."
    print("  1. BY HOW FAR OFF (a point seen from close is its own judge, so the first line is the yardstick, not a finding):")
    for lo, hi in BINS:
        print(row(ok & (L >= lo) & (L < hi), f"seen from {lo * FT:.0f}-{hi * FT:.0f} ft"))
    far = ok & (L > NEAR_M)
    print("     The same for the points seen from over 10 ft, by how HIGH they stand over their own ground:")
    for lo, hi in [(-1, 1), (1, 4), (4, 8), (8, 13), (13, 25), (25, 80)]:
        print(row(far & (h >= lo / FT) & (h < hi / FT), f"{max(lo, 0)}-{hi} ft up"))

    # 1b. THE DEPTH'S OWN ERROR, ALONG THE LINE OF SIGHT. For a point seen from over NEAR_M: walk out along the line
    # from the camera through it; where that line first meets a cubic foot with a surface SEEN FROM CLOSE, that is
    # how far away the thing really was on that line. The phone said L. The difference is the depth's error, with no
    # lidar and no map in it (and with the walk's own slide between the two looks in it, which the nearest lines show).
    surf_set = np.zeros(int(dims[0] * dims[1] * dims[2]), bool) if int(dims[0] * dims[1] * dims[2]) < 4e8 else None
    if surf_set is not None:
        surf_set[surf_k] = True
        cand = np.flatnonzero(ok & (L > NEAR_M))
        if len(cand) > 80000:
            cand = np.random.default_rng(0).choice(cand, 80000, replace=False)
        Lc, Cc, Uc = L[cand], C[cand], D[cand] / L[cand][:, None]
        hit = np.full(len(cand), np.nan)
        s_ = np.maximum(0.3, 0.4 * Lc)
        alive = np.ones(len(cand), bool)
        while alive.any():
            q = Cc[alive] + Uc[alive] * s_[alive][:, None]
            kq, ib = key(q)
            h_ = np.zeros(len(kq), bool); h_[ib] = surf_set[kq[ib]]
            idx = np.flatnonzero(alive)
            hit[idx[h_]] = s_[idx[h_]] + VOX / 2            # the middle of the cubic foot it met, not its near face
            alive[idx[h_]] = False
            s_[alive] += 0.15
            alive &= s_ <= 1.6 * Lc
        got = np.isfinite(hit)
        err = Lc - hit                                           # + : the phone put it FARTHER than the thing seen from close
        print("  1b. THE DEPTH'S OWN ERROR ALONG THE LINE OF SIGHT (the phone's distance to a point, against where that line first meets a surface seen from close; + is the phone too far):")
        for lo, hi in BINS[1:]:
            m = got & (Lc >= lo) & (Lc < hi)
            n_all = int(((Lc >= lo) & (Lc < hi)).sum())
            if m.sum() < 30:
                print(f"    seen from {lo * FT:.0f}-{hi * FT:.0f} ft: {n_all:,} lines, {int(m.sum())} meet a surface seen from close: too few to say.")
                continue
            e = err[m]; ae = np.abs(e); rel = ae / Lc[m]
            print(f"    seen from {lo * FT:.0f}-{hi * FT:.0f} ft: {n_all:,} lines, {int(m.sum()):,} meet a surface seen from close: off by {np.median(ae) * 39.37:.0f} in in the middle, {np.percentile(ae, 90) * 39.37:.0f} in for the worst tenth "
                  f"({100 * np.median(rel):.0f}% and {100 * np.percentile(rel, 90):.0f}% of the distance); within a foot {100 * (ae <= 0.3048).mean():.0f}%, within 3 ft {100 * (ae <= 0.9144).mean():.0f}%; the middle error {np.median(e) * 39.37:+.0f} in.")

    # 2. SKY AMONG THE SOLID
    pk = PL.phone_kinds(d, len(recs))
    rgbf = os.path.join(d, "view-rgb.bin")
    rgb = None
    if os.path.exists(rgbf) and os.path.getsize(rgbf) >= 4 * len(recs):
        rgb = np.fromfile(rgbf, dtype=np.uint8, count=4 * len(recs)).reshape(-1, 4)
    if kind is not None:
        solid = ok & np.isin(kind, [TR.KINDS.index(k_) for k_ in ("built", "fence", "tree", "plant")])
        SKY = TR.KINDS.index("sky")
        print(f"  2. SKY AMONG THE SOLID: {int(solid.sum()):,} points voted built, fence, tree or plant.")
        tests = []
        if pk is not None:
            tests.append(("the PHONE'S OWN label says sky", solid & (pk == SKY)))
        if rgb is not None:
            r_, g_, b_ = (rgb[:, i].astype(np.int32) for i in range(3))
            # sky-coloured: bright, and blue over red by a clear margin (a blue sky), or very bright and even (an overcast one)
            blue = (rgb[:, 3] == 1) & (b_ > 120) & (b_ - r_ > 25) & (b_ >= g_ - 5)
            pale = (rgb[:, 3] == 1) & (r_ > 215) & (g_ > 215) & (b_ > 215)
            tests.append(("the photo's colour there is SKY BLUE", solid & blue))
            tests.append(("the photo's colour there is near white (an overcast sky, or a white wall)", solid & pale))
            if pk is not None:
                tests.append(("BOTH the phone's label and a sky-blue photo", solid & (pk == SKY) & blue))
        for name, m in tests:
            n = int(m.sum())
            j = int((m & judged).sum())
            hi = m & (h >= 8 / FT)
            print(f"    {name}: {n:,} ({100 * n / max(1, int(solid.sum())):.1f}%); {int(hi.sum()):,} of them 8 ft up or more; seen from {np.median(L[m]) * FT if n else 0:.0f} ft in the middle"
                  + (f"; where the judge has a view ({j:,}): {100 * int((m & on_surf).sum()) / j:.0f}% on a surface seen from close, {100 * int((m & in_air).sum()) / j:.0f}% in air seen open" if j >= 30 else "; too few where the judge has a view") + ".")
        j_all = int((solid & judged).sum())
        if j_all >= 30:
            print(f"    Every solid point, for the yardstick: where the judge has a view ({j_all:,}): {100 * int((solid & on_surf).sum()) / j_all:.0f}% on a surface, {100 * int((solid & in_air).sum()) / j_all:.0f}% in air seen open.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
