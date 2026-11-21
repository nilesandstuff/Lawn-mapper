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
APART = 3         # stretches apart (walking) before two sightings count as two visits
FAR = 12.0        # m: only depth this near is used (the phone's depth worsens with distance)
VOX = 0.15        # m: the cubes the sliding counts in
REACH = 2.4       # m: how far a stretch may be slid, flat (1.8 in run 463: one slide at the limit; 3.0 in run 465: one believed, the rest unclear)
REACH_UP = 0.9    # m: ... and in height
CLEAR = 1.15      # the best slide must hold this many times the points of the best one elsewhere
LEAST = 150       # points of the second stretch that must land in the first's cubes


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
    # DID THE PHONE'S OWN PLACE JUMP? (the owner, 2026-11-21: the garage was first seen "between checking r2 and r3. So
    # maybe... it's not actual drift, it's a total change in the fix.") The fix on the map does not move a point in
    # this frame, but ARCore itself can jump when it thinks it knows a place again. Every step between two poses
    # taken within half a second, against how far a person walks in that time.
    dt = np.diff(track[:, 0])
    stp = np.linalg.norm(np.diff(track[:, 1:4], axis=0), axis=1)
    near = (dt > 0) & (dt < 0.5)
    if not near.any():
        near = dt > 0
    # a walker covers 16-22 in between two poses, so the bar is 30 in; the LARGEST are printed, not the first by time
    # (run 467 printed twelve ordinary steps and not the 39 in one)
    big = np.flatnonzero(near & (stp > 0.76))
    big = big[np.argsort(-stp[big])]
    seg0 = np.concatenate([[0], np.cumsum(stp)])
    print(f"JUMPS: {len(track):,} poses; a step between two poses half a second apart or less is {np.median(stp[near]) * 39.37:.1f} in in the middle, 99 in 100 under {np.percentile(stp[near], 99) * 39.37:.0f} in, the most {stp[near].max() * 39.37:.0f} in. Steps over 30 in: {len(big)}.")
    for i in big[:12]:
        dv = track[i + 1, 1:4] - track[i, 1:4]
        print(f"    a jump of {stp[i] * 39.37:.0f} in ({np.hypot(dv[0], dv[2]) * 39.37:.0f} flat, {dv[1] * 39.37:+.0f} in height) at {track[i, 0] / 60:.1f} min, {seg0[i] * S.FT:.0f} ft walked.")
    # a step OUT OF LINE with the walking round it (a walker's steps follow each other; a jump does not): each step
    # against the mean of the two before and the two after
    if len(stp) > 8:
        v = np.diff(track[:, 1:4], axis=0)
        around = (np.roll(v, 1, 0) + np.roll(v, 2, 0) + np.roll(v, -1, 0) + np.roll(v, -2, 0)) / 4
        off = np.linalg.norm(v - around, axis=1)
        off[:2] = 0; off[-2:] = 0
        odd = np.argsort(-off)[:6]
        print("    the steps most out of line with the walking round them: " + ", ".join(f"{off[i] * 39.37:.0f} in at {track[i, 0] / 60:.1f} min" for i in odd if off[i] > 0.3) + ".")
    # THE JUMPS AS STEPS TO TAKE BACK (2026-11-21, the walk of that day: the page logged the phone's tracking jumping
    # 1.5 m and 4.1 m in one frame, and the poses show both). Where a step lies more than JUMP_M out of line with
    # the walking round it, the part out of line is the jump; everything seen AFTER it is moved back by it, so the
    # walk runs on unbroken. Whether the phone was right before the jump or after it is not known from this: the
    # judge is the places seen twice.
    JUMP_M = 0.9
    steps = []
    if len(stp) > 8:
        v = np.diff(track[:, 1:4], axis=0)
        # the MIDDLE of the four steps round it, not their mean: a jump must not colour its neighbours' ordinary steps
        around = np.median(np.stack([np.roll(v, 1, 0), np.roll(v, 2, 0), np.roll(v, -1, 0), np.roll(v, -2, 0)]), axis=0)
        out = v - around
        offn = np.linalg.norm(out, axis=1)
        offn[:2] = 0; offn[-2:] = 0
        for i in np.flatnonzero(offn > JUMP_M):
            if steps and track[i, 0] - steps[-1]["t"] < 2.0:      # one jump seen over two or three poses
                steps[-1]["d"] = (np.array(steps[-1]["d"]) + out[i]).tolist()
            else:
                steps.append({"t": float(track[i, 0]), "d": out[i].tolist()})
        for st in steps:
            dj = np.array(st["d"])
            print(f"    A JUMP TO TAKE BACK: {np.linalg.norm(dj) * 39.37:.0f} in ({np.hypot(dj[0], dj[2]) * 39.37:.0f} flat, {dj[1] * 39.37:+.0f} in height) at {st['t'] / 60:.1f} min.")
    def jump_shift(t):
        """What to add to a point seen at time t: the jumps before it, taken back."""
        c = np.zeros(3)
        for st in steps:
            if st["t"] < t:
                c -= np.array(st["d"])
        return c
    # gaps in the poses themselves (the phone's tracking lost, or the page stalled)
    gaps = np.flatnonzero(dt > 1.5)
    if len(gaps):
        print("    gaps in the poses: " + ", ".join(f"{dt[i]:.1f} s at {track[i, 0] / 60:.1f} min (moved {stp[i] * 39.37:.0f} in across it)" for i in gaps[:10]) + ".")
    if "--jumps" in args:
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
    # WHAT STANDS says where a stretch lies flat (a lawn slides over itself anywhere; a wall does not): the sliding is
    # done on the standing points, and the height then taken from the ground both saw (run 462: sliding everything,
    # 8 of 10 slides were not clear, and the classes had not been read, so nothing was known to be ground).
    have_kinds = bool(kind_maps)
    PS = {s: (P[s][ST[s]] if have_kinds else P[s]) for s in P}
    PG = {s: (P[s][~ST[s]] if have_kinds else P[s][:0]) for s in P}
    coarse = {s: set(map(tuple, np.unique(np.floor(v / 1.0).astype(np.int64), axis=0))) for s, v in PS.items() if len(v)}
    for s in P:
        coarse.setdefault(s, set())
    print(f"  Classes read for {len(kind_maps)} photos; the sliding uses {'the standing points only' if have_kinds else 'every point (no classes)'}: {sum(len(v) for v in PS.values()):,}.")
    ties, tried, weak, thin, unclear = [], 0, 0, 0, []
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
            A, B = near(PS[a]), near(PS[b_])
            if len(A) < 400 or len(B) < 400:
                thin += 1
                continue
            r = slide(A, B, rng)
            if r is None:
                continue
            dd, best, zero, elsewhere = r
            if best < LEAST or best < CLEAR * max(1, elsewhere):
                weak += 1
                unclear.append(float(np.hypot(dd[0], dd[2])))
                continue
            # the height from the ground both saw, once slid flat
            if len(PG[a]) > 200 and len(PG[b_]) > 200:
                ca = {}
                for x, y, z_ in PG[a]:
                    ca.setdefault((int(x // 0.5), int(z_ // 0.5)), []).append(y)
                cb = {}
                for x, y, z_ in PG[b_] + (dd[0], 0, dd[2]):
                    cb.setdefault((int(x // 0.5), int(z_ // 0.5)), []).append(y)
                dif = [np.median(ca[k]) - np.median(cb[k]) for k in ca.keys() & cb.keys() if len(ca[k]) >= 8 and len(cb[k]) >= 8]
                if len(dif) >= 15:
                    dd = np.array([dd[0], float(np.median(dif)), dd[2]])
            ties.append((a, b_, dd, min(1.0, best / 2000), best, zero))
    print(f"  Pairs of stretches walked {APART * STRETCH * S.FT:.0f} ft or more apart that saw one place: {tried}; too little of it standing: {thin}; believed slides {len(ties)}; not clear enough: {weak}.")
    for a_, b__, dd, _, best, zero in ties:
        print(f"    a believed slide, stretches {b__ - a_} apart ({(b__ - a_) * STRETCH * S.FT:.0f} ft of walking): {np.hypot(dd[0], dd[2]) * 39.37:.0f} in flat, {dd[1] * 39.37:+.0f} in in height; {best:,} points land, {zero:,} did before sliding.")
    if unclear:
        print(f"    the unclear ones' best slides were {', '.join(f'{u * 39.37:.0f}' for u in sorted(unclear))} in flat.")
    # ARCORE'S OWN RECORD OF ITS DRIFT (2026-11-21). The app drops an anchor every 10 m of walking and at the walk's end
    # keeps where ARCore then holds each (live.json crumbs: at0 when dropped, at at the end; scan/lib/semantics.js).
    # ARCore moves an anchor when it corrects its map, so at - at0 is its own answer to "how far has this stretch of
    # the walk drifted". Used here as the mending, and checked against the slides this study found by itself.
    # THE JUMPS TAKEN BACK, judged at the places seen twice: for each believed slide, what is left of it
    if steps:
        seg_o = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(track[:, 1:4], axis=0), axis=1))])
        t_of = lambda s_: float(np.interp((s_ + 0.5) * STRETCH, seg_o, track[:, 0]))  # noqa: E731
        print(f"  THE JUMPS TAKEN BACK ({len(steps)}), judged by the slides this study found by itself:")
        for a_, b__, dd, _, best, zero in ties:
            pr = jump_shift(t_of(b__)) - jump_shift(t_of(a_))
            n_between = sum(1 for st in steps if t_of(a_) < st["t"] < t_of(b__))
            print(f"    a slide of {np.hypot(dd[0], dd[2]) * 39.37:.0f} in flat, {dd[1] * 39.37:+.0f} in height ({n_between} jump{'s' if n_between != 1 else ''} between its two sightings, at {t_of(a_) / 60:.1f} and {t_of(b__) / 60:.1f} min): taking the jumps back leaves {np.linalg.norm(dd - pr) * 39.37:.0f} in of its {np.linalg.norm(dd) * 39.37:.0f}.")
        if "--write" in args:
            with open(os.path.join(d, "mend.json"), "w") as f:
                json.dump({"steps": steps, "from": "the jumps in the poses, taken back", "judged": False}, f)
            print("  Kept (mend.json): the jumps, to be taken back.")
    crumbs = None
    try:
        crumbs = (json.load(open(os.path.join(d, "live.json"))) or {}).get("crumbs")
    except Exception:
        crumbs = None
    if crumbs:
        co = np.array([c["odo"] for c in crumbs], dtype=np.float64)
        cm = np.array([[c["at"][k] - c["at0"][k] for k in "xyz"] for c in crumbs], dtype=np.float64)
        order = np.argsort(co)
        co, cm = co[order], cm[order]
        flatm, upm = np.hypot(cm[:, 0], cm[:, 2]), cm[:, 1]
        print(f"  ARCORE'S OWN ANCHORS: {len(co)} along the walk (one each 33 ft); it moved them {np.median(np.linalg.norm(cm, axis=1)) * 39.37:.0f} in in the middle, the most {np.linalg.norm(cm, axis=1).max() * 39.37:.0f} in; flat the most {flatm.max() * 39.37:.0f} in; in height {upm.min() * 39.37:+.0f} to {upm.max() * 39.37:+.0f} in.")
        centre = (np.arange(n) + 0.5) * STRETCH
        c_arc = np.stack([np.interp(centre, co, cm[:, k]) for k in range(3)], 1)
        for a_, b__, dd, _, best, zero in ties:
            pr = c_arc[b__] - c_arc[a_]
            print(f"    a believed slide of {np.hypot(dd[0], dd[2]) * 39.37:.0f} in flat, {dd[1] * 39.37:+.0f} in height: ARCore's anchors say {np.hypot(pr[0], pr[2]) * 39.37:.0f} in flat, {pr[1] * 39.37:+.0f} in height; what they leave of it {np.linalg.norm(dd - pr) * 39.37:.0f} in (of {np.linalg.norm(dd) * 39.37:.0f}).")
        if "--write" in args and not steps:
            with open(os.path.join(d, "mend.json"), "w") as f:
                json.dump({"stretchM": STRETCH, "offsets": np.round(c_arc, 4).tolist(), "ties": 0, "from": "ARCore's own anchors", "judged": False}, f)
            print("  Offsets kept (mend.json), from ARCore's anchors.")
        return
    print("  No anchors kept with this walk (live.json crumbs).")
    if len(ties) < 2:
        print("  Too few believed slides to mend the walk.")
        return
    if len(ties) < 6:
        # too few to hold half back and judge: mended from all of them, and the judge is the owner's eyes on the
        # places seen twice (the 3D view's mended cloud)
        c = solve(n, [(a, b_, dd, wt) for a, b_, dd, wt, _, _ in ties])
        left = np.array([np.linalg.norm(dd - (c[b_] - c[a])) for a, b_, dd, _, _, _ in ties])
        print(f"  Too few believed slides to hold half back and judge. MENDED FROM ALL {len(ties)} (not judged here): what is left of each slide after mending {', '.join(f'{x * 39.37:.0f}' for x in left)} in; the walk's whole drift found {np.linalg.norm(c.max(0) - c.min(0)) * 39.37:.0f} in ({(c[:, 1].max() - c[:, 1].min()) * 39.37:.0f} in of it height).")
        if "--write" in args:
            with open(os.path.join(d, "mend.json"), "w") as f:
                json.dump({"stretchM": STRETCH, "offsets": np.round(c, 4).tolist(), "ties": len(ties), "judged": False}, f)
            print("  Offsets kept (mend.json).")
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
