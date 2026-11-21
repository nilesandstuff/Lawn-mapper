"""
A WALK MENDED BY ITSELF, IN ALL THREE DIRECTIONS (core session, 2026-11-21; docs/SCAN-PLAN.md 44, item 1).

The owner, on the walk of 2026-11-20: "at one point i looked at the corner of the garage... twice. As a result,
there's 2 separate walls being shown there. So that's a drift issue." scan/lib/pin.js already takes a walk's
height drift out of itself (one height offset for each stretch, columns of ground seen from two stretches tied).
This is the same in three directions, from what STANDS as well as the ground:

  - the walk is cut into stretches of STRETCH metres of walking; each photo's own measured depth is put into space
    (as dense_prep.py does) and belongs to its photo's stretch;
  - where two stretches walked well apart both saw the same place, the second is slid over the first (to and fro,
    sideways, up and down, within REACH) to where the most of its points land in cubes the first filled; a slide is
    believed only when its best place stands clear of the others;
  - every stretch gets one offset; the believed slides tie pairs of them, neighbours in the walk are held together
    loosely, and the whole is solved by least squares.

THE PROOF IS THE WALK'S OWN: half the slides solve, the other half are judged -- how far apart the two sightings of
a place lie before and after. No lidar. Numbers only.

    python scan/tools/mend_study.py twin [--write]     --write keeps mend.json (the offsets) beside the twin
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402
import studies as T        # noqa: E402
import dense_prep as DP    # noqa: E402

STRETCH = 6.0     # m of walking that share one offset
APART = 4         # stretches apart (walking) before two sightings count as two visits
FAR = 9.0         # m: only depth this near is used (the phone's depth worsens with distance)
VOX = 0.15        # m: the cubes the sliding counts in
REACH = 1.8       # m: how far a stretch may be slid, flat
REACH_UP = 0.6    # m: ... and in height
CLEAR = 1.25      # the best slide must hold this many times the points of the best one elsewhere
LEAST = 250       # points of the second stretch that must land in the first's cubes


def odo_at(track, t):
    seg = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(track[:, 1:4], axis=0), axis=1))])
    return np.interp(t, track[:, 0], seg)


def slide(A, B, rng):
    """Where B lands best on A: -> (d (3,), points landing, the same at no slide, the best elsewhere) or None."""
    lo = np.minimum(A.min(0), B.min(0)) - REACH - 1
    ga = np.floor((A - lo) / VOX).astype(np.int64)
    shape = ga.max(0) + int(2 * (REACH + 1) / VOX) + 4
    if np.prod(shape.astype(np.float64)) > 6e7:
        return None
    occ = np.zeros(shape, bool)
    occ[ga[:, 0], ga[:, 1], ga[:, 2]] = True
    # a cube's neighbours up and down count too: the sliding is in whole cubes
    if len(B) > 6000:
        B = B[rng.choice(len(B), 6000, replace=False)]
    xs = np.arange(-REACH, REACH + 1e-9, VOX)
    ys = np.arange(-REACH_UP, REACH_UP + 1e-9, VOX)
    score = np.zeros((len(xs), len(ys), len(xs)), np.int32)
    for i, dx in enumerate(xs):
        for j, dy in enumerate(ys):
            for k, dz in enumerate(xs):
                g = np.floor((B + (dx, dy, dz) - lo) / VOX).astype(np.int64)
                ok = (g >= 0).all(1) & (g < shape).all(1)
                score[i, j, k] = occ[g[ok, 0], g[ok, 1], g[ok, 2]].sum()
    i, j, k = np.unravel_index(score.argmax(), score.shape)
    best = int(score[i, j, k])
    zero = int(score[len(xs) // 2, len(ys) // 2, len(xs) // 2])
    far = score.copy()
    r = int(round(0.45 / VOX))
    far[max(0, i - r):i + r + 1, :, max(0, k - r):k + r + 1] = 0
    return np.array([xs[i], ys[j], xs[k]]), best, zero, int(far.max())


def solve(n, ties, smooth=0.5):
    """Offsets c (n, 3) with c[b] - c[a] = d for each tie (a, b, d, w); neighbours held together by `smooth`."""
    A = np.zeros((n, n))
    b = np.zeros((n, 3))
    def tie(i, j, d, w):
        A[i, i] += w; A[j, j] += w; A[i, j] -= w; A[j, i] -= w
        b[j] += w * d; b[i] -= w * d
    for a_, b_, d, w in ties:
        tie(a_, b_, d, w)
    for i in range(n - 1):
        tie(i, i + 1, np.zeros(3), smooth)
    A += np.eye(n) * 1e-6
    return np.linalg.solve(A, b)


def main():
    args = sys.argv[1:]
    d = next((a for a in args if not a.startswith("--")), "twin")
    w = T.load(d)
    keys, track = w["keys"], w["track"]
    if len(track) < 10:
        print("No track: nothing to mend.")
        return
    kind_maps = {}
    mf = os.path.join(d, "segments-masks.npz")
    if os.path.exists(mf):
        z = np.load(mf, allow_pickle=False)
        if "pan" in z and "names" in z:
            for i, m, nm in zip(z["pics"], z["pan"], json.loads(str(z["names"]))):
                lut = np.zeros(int(m.max()) + 1, np.uint8)
                for j, name in nm.items():
                    kk = "tree" if name in T.TREE_NAMES else T.KIND.get(name)
                    if kk in T.VOTE_KINDS and int(j) < len(lut):
                        lut[int(j)] = T.VOTE_KINDS.index(kk)
                kind_maps[int(i)] = lut[m]
    SKY = T.VOTE_KINDS.index("sky")
    GROUND = [T.VOTE_KINDS.index(k) for k in ("grass", "bare ground", "paved")]
    pts = {}
    stand = {}
    for i, k in enumerate(keys):
        f = os.path.join(d, k["name"].replace(".jpg", ".depth"))
        dg = T.read_depth(f) if os.path.exists(f) else None
        if dg is None or "c2w" not in k:
            continue
        dg = np.where(dg <= FAR, dg, 0)
        if not (dg > 0).any():
            continue
        km = kind_maps.get(i)
        H, W = (km.shape if km is not None else (k.get("h", 640), k.get("w", 480)))
        xyz, px, py, _ = DP.cells(k, dg, W, H)
        kd = km[py, px] if km is not None else np.zeros(len(px), np.uint8)
        ok = kd != SKY
        s = int(odo_at(track, k["t"]) // STRETCH)
        pts.setdefault(s, []).append(xyz[ok])
        stand.setdefault(s, []).append(~np.isin(kd[ok], GROUND))
    if len(pts) < 4:
        print("Too few stretches with depth: nothing to mend.")
        return
    n = max(pts) + 1
    P = {s: np.concatenate(v) for s, v in pts.items()}
    ST = {s: np.concatenate(v) for s, v in stand.items()}
    print(f"MENDING: {sum(len(v) for v in P.values()):,} measured depth cells within {FAR * S.FT:.0f} ft, in {len(P)} stretches of {STRETCH * S.FT:.0f} ft; {100 * np.mean(np.concatenate(list(ST.values()))):.0f}% of them on things that stand.")
    rng = np.random.default_rng(3)
    coarse = {s: set(map(tuple, np.unique(np.floor(v / 1.0).astype(np.int64), axis=0))) for s, v in P.items()}
    ties, tried, weak = [], 0, 0
    for a in sorted(P):
        # of the later stretches that saw the same place, the eight sharing most of it (a walk of 50 stretches would
        # otherwise ask for a thousand slidings)
        later = sorted((b_ for b_ in P if b_ - a >= APART and len(coarse[a] & coarse[b_]) >= 12), key=lambda b_: -len(coarse[a] & coarse[b_]))[:8]
        for b_ in sorted(later):
            tried += 1
            # the place both saw: each stretch's points within the other's reach
            both = coarse[a] & coarse[b_]
            def near(v):
                c = np.floor(v / 1.0).astype(np.int64)
                keep = np.fromiter(((x, y, z_) in both for x, y, z_ in c), bool, len(c))
                return v[keep]
            A, B = near(P[a]), near(P[b_])
            if len(A) < 800 or len(B) < 800:
                continue
            r = slide(A, B, rng)
            if r is None:
                continue
            dd, best, zero, elsewhere = r
            if best < LEAST or best < CLEAR * max(1, elsewhere):
                weak += 1
                continue
            ties.append((a, b_, dd, min(1.0, best / 2000), best, zero))
    print(f"  Pairs of stretches walked {APART * STRETCH * S.FT:.0f} ft or more apart that saw one place: {tried}; believed slides {len(ties)} (not clear enough: {weak}).")
    if len(ties) < 4:
        print("  Too few believed slides to mend the walk or to judge a mending.")
        return
    mag = np.array([np.linalg.norm(t[2]) for t in ties])
    flat = np.array([np.hypot(t[2][0], t[2][2]) for t in ties])
    up = np.array([abs(t[2][1]) for t in ties])
    gain = np.array([t[4] / max(1, t[5]) for t in ties])
    print(f"  THE TWO SIGHTINGS OF A PLACE, AS WALKED: apart by {np.median(mag) * 39.37:.0f} in in the middle (a quarter over {np.percentile(mag, 75) * 39.37:.0f} in, the most {mag.max() * 39.37:.0f} in); flat {np.median(flat) * 39.37:.0f} in, in height {np.median(up) * 39.37:.0f} in. Slid to its best place a stretch lands {np.median(gain):.1f} times the points on the other.")
    # half solve, half judge
    use = [t for i, t in enumerate(ties) if i % 2 == 0]
    held = [t for i, t in enumerate(ties) if i % 2 == 1]
    c = solve(n, [(a, b_, dd, wt) for a, b_, dd, wt, _, _ in use])
    left = np.array([np.linalg.norm(dd - (c[b_] - c[a])) for a, b_, dd, _, _, _ in held])
    was = np.array([np.linalg.norm(dd) for a, b_, dd, _, _, _ in held])
    print(f"  JUDGED ON THE {len(held)} SLIDES LEFT OUT: the two sightings lie {np.median(was) * 39.37:.0f} in apart as walked, {np.median(left) * 39.37:.0f} in apart mended (a quarter over {np.percentile(was, 75) * 39.37:.0f} -> {np.percentile(left, 75) * 39.37:.0f} in); better for {100 * (left < was).mean():.0f}% of them.")
    c = solve(n, [(a, b_, dd, wt) for a, b_, dd, wt, _, _ in ties])
    span = np.linalg.norm(c - c.mean(0), axis=1)
    print(f"  Solved on every slide: a stretch is moved {np.median(span) * 39.37:.0f} in in the middle, the most {span.max() * 39.37:.0f} in; the walk's whole drift found {np.linalg.norm(c.max(0) - c.min(0)) * 39.37:.0f} in.")
    if "--write" in args:
        with open(os.path.join(d, "mend.json"), "w") as f:
            json.dump({"stretchM": STRETCH, "offsets": np.round(c, 4).tolist(), "ties": len(ties)}, f)
        print("  Offsets kept (mend.json).")


if __name__ == "__main__":
    main()
