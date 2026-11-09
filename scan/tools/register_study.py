"""
THE WALK'S POINTS REGISTERED TO THE LIDAR, GROUND FIRST (core session, 2026-11-09). The owner pointed at the research
report's tools (2026-11-08): small_gicp, TEASER++, Open3D (MIT) line up one point cloud against another, which is what
the studies so far have built by hand. The report's recipe for ground-to-aerial lidar (Paired-CSLiDAR, May 2026, 86%
of 12,683 pairs within 0.75 m): the two views "share mainly the terrain surface", so fit the GROUND first, then add
bands by height, and accept a stage only if it makes the fit better ("accept-if-better"); it also warns that a
better-looking fit can be a worse pose, so the answer is judged on held-out checks (the check marks; task repeat).

Here, with small_gicp's GICP:
  stage 1, the ground: the phone's ground points against the lidar's ground returns (class 2);
  stage 2, ground and low things together: the phone's points 0.3-2.5 m over its ground (shrubs, fences, the hot tub,
           trunks, walls' feet) against the lidar's returns at the same heights over the lidar's ground, each band kept
           to itself (the bands are stacked 100 m apart, so no point matches across them, and a tilt cannot pay);
  each stage accepted only if more of the walk's points land within 0.4 m of a lidar point of their own band.
Four degrees of freedom only (turn, east, north, height): gravity is known on both sides, so any tilt GICP finds is
taken out after each round. Run from every start the other studies use (the skyline's best, the GPS trail, the
placement kept, the best fit overall); the one with the most points landed is kept. ARCore's labels drop sky,
people and cars when the walk has them.

Writes registration.json { T: [theta, tx, ty], tz, landed, from }. Prints distances and counts only.

  python scan/tools/register_study.py twin
"""
import json
import math
import os
import sys
import time

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
import view_study as vs  # noqa: E402  (read_cloud)

FT = 3.281
GROUND_TOL = 0.15        # m: a phone point this near its ground is ground
LOW = (0.3, 2.5)         # m over the ground: the low band
STACK = 100.0            # m between the bands in the stacked clouds
LAND = 0.4               # m: a point within this of a lidar point of its band has landed
DROP_LABELS = {2, 10, 11}  # label + 1: sky, vehicle, person


def ground_grid(d, inp):
    g = inp["grid"]
    gr = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"])

    def at(e, n):
        c = np.floor((e - g["x0"]) / g["cell"]).astype(int)
        r = np.floor((g["y1"] - n) / g["cellY"]).astype(int)
        ok = (c >= 0) & (r >= 0) & (c < g["w"]) & (r < g["h"])
        out = np.full(np.shape(e), np.nan)
        out[ok] = gr[r[ok], c[ok]]
        return out
    return at


def T4(th, tx, ty, tz):
    c, s = math.cos(th), math.sin(th)
    return np.array([[c, -s, 0, tx], [s, c, 0, ty], [0, 0, 1, tz], [0, 0, 0, 1.0]])


def to4(M):
    """The 4-DoF part of a rigid transform: its turn about the vertical, and its shift."""
    th = math.atan2(M[1, 0], M[0, 0])
    return th, float(M[0, 3]), float(M[1, 3]), float(M[2, 3])


def main(d):
    import small_gicp
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    checks = inp.get("checks") or []
    gat = ground_grid(d, inp)
    # the lidar: ground returns, and returns 0.3-2.5 m over the lidar's ground
    L = np.fromfile(os.path.join(d, "sky-points.bin"), dtype="<f4").reshape(-1, 6).astype(np.float64)
    hag = L[:, 2] - gat(L[:, 0], L[:, 1])
    lg = L[(L[:, 4] == 2) & np.isfinite(hag)][:, :3]
    ll = L[(hag >= LOW[0]) & (hag <= LOW[1]) & (L[:, 4] != 2)][:, :3]
    # the walk: session [x, y, z] -> plan (u, v) = (x, -z), height y; its ground the page's then
    C = vs.read_cloud(d)
    if len(C) < 1000:
        raise SystemExit("Registration: the walk has too few points.")
    if C.shape[1] > 6:
        C = C[~np.isin(C[:, 6].astype(int), list(DROP_LABELS))]
    h = C[:, 3] - C[:, 5]
    ok = np.isfinite(h)
    C, h = C[ok], h[ok]
    pg = np.stack([C[:, 2], -C[:, 4], C[:, 3]], 1)[np.abs(h) < GROUND_TOL]
    pl = np.stack([C[:, 2], -C[:, 4], C[:, 3]], 1)[(h >= LOW[0]) & (h <= LOW[1])]
    rng = np.random.default_rng(0)
    if len(pg) > 40000:
        pg = pg[rng.choice(len(pg), 40000, replace=False)]
    if len(pl) > 40000:
        pl = pl[rng.choice(len(pl), 40000, replace=False)]
    print(f"Registration (small_gicp GICP, ground first, then the low band, accept-if-better; 4 degrees of freedom): "
          f"lidar {len(lg):,} ground and {len(ll):,} low returns; the walk {len(pg):,} ground and {len(pl):,} low points.")

    stacked_target = np.concatenate([lg, ll + [0, 0, STACK]])
    tree_g, tree_l = cKDTree(lg), cKDTree(ll)

    def place(T, P):
        th, tx, ty, tz = T
        c, s = math.cos(th), math.sin(th)
        return np.stack([c * P[:, 0] - s * P[:, 1] + tx, s * P[:, 0] + c * P[:, 1] + ty, P[:, 2] + tz], 1)

    def landed(T):
        a = (tree_g.query(place(T, pg), distance_upper_bound=LAND)[0] < LAND).sum()
        b = (tree_l.query(place(T, pl), distance_upper_bound=LAND)[0] < LAND).sum() if len(pl) else 0
        return int(a + b), int(a), int(b)

    def height_for(th, tx, ty):
        q = place((th, tx, ty, 0.0), pg)
        z = gat(q[:, 0], q[:, 1])
        dz = z - q[:, 2]
        dz = dz[np.isfinite(dz)]
        return float(np.median(dz)) if len(dz) else 0.0

    def gicp(T, src, tgt, rounds=4, dist=1.0):
        for _ in range(rounds):
            moved = place(T, src)
            r = small_gicp.align(tgt, moved, registration_type="GICP", downsampling_resolution=0.25,
                                 max_correspondence_distance=dist, num_threads=os.cpu_count() or 2, max_iterations=15)
            dth, dx, dy, dz = to4(r.T_target_source)
            th, tx, ty, tz = T
            c, s = math.cos(dth), math.sin(dth)
            T = (th + dth, c * tx - s * ty + dx, s * tx + c * ty + dy, tz + dz)
        return T

    def med(T):
        if not checks:
            return float("nan")
        th, tx, ty = T[:3]
        c, s = math.cos(th), math.sin(th)
        return float(np.median([math.hypot(c * k["ar"][0] - s * k["ar"][1] + tx - k["map"][0], s * k["ar"][0] + c * k["ar"][1] + ty - k["map"][1]) for k in checks]) * FT)

    starts = []
    sk = os.path.join(d, "skyline.json")
    if os.path.exists(sk):
        starts += [((q["theta"], q["tx"], q["ty"]), f"the skyline's {i + 1}") for i, q in enumerate(json.load(open(sk)).get("placements", [])[:3])]
    if os.path.exists(os.path.join(d, "placement.json")):
        q = json.load(open(os.path.join(d, "placement.json")))
        starts.append(((q["theta"], q["tx"], q["ty"]), "the placement kept"))
    if inp.get("gps"):
        q = inp["gps"]
        starts.append(((q["theta"], q["tx"], q["ty"]), "the GPS / Street View trail"))
    cs = os.path.join(d, "consensus.json")
    if os.path.exists(cs):
        w = json.load(open(cs)).get("weights", {}).get("all")
        if w:
            starts.append((tuple(w["T"]), "the best fit overall"))
    truth = None
    if len(checks) >= 3:
        from view_study import fit_rigid
        try:
            truth = fit_rigid([(k["ar"], k["map"]) for k in checks])
        except Exception:
            truth = None
    if truth is not None:
        T = (*truth, height_for(*truth))
        n, a, b = landed(T)
        print(f"  at the check marks' own fit: {n:,} points landed (ground {a:,}, low {b:,})")
    if not starts:
        raise SystemExit("Registration: no start (run the skyline or the GPS trail first).")

    results = []
    for (th, tx, ty), name in starts:
        T = (th, tx, ty, height_for(th, tx, ty))
        n0 = landed(T)[0]
        # stage 1: the ground alone
        T1 = gicp(T, pg, lg, rounds=4, dist=1.5)
        n1 = landed(T1)[0]
        if n1 <= n0:
            T1, n1 = T, n0
        # stage 2: the ground and the low band together, each to its own (stacked)
        src = np.concatenate([pg, pl + [0, 0, STACK]])
        T2 = gicp(T1, src, stacked_target, rounds=4, dist=1.0)
        n2 = landed(T2)[0]
        kept, nk, which = (T2, n2, "ground, then the low band") if n2 > n1 else (T1, n1, "ground only (the low band did not help)")
        results.append((nk, kept, name, which))
        print(f"  from {name} ({med((th, tx, ty)):.1f} ft): landed {n0:,} -> ground {n1:,} -> both {n2:,}; kept {which}; "
              f"checks median {med(kept):.1f} ft")
    results.sort(key=lambda r: -r[0])
    best = results[0]
    second = next((r for r in results[1:] if math.hypot(r[1][1] - best[1][1], r[1][2] - best[1][2]) > 0.5), None)
    margin = (best[0] - second[0]) / max(1, best[0]) if second else None
    print(f"Registration: from {best[2]}, {best[0]:,} points landed; checks median {med(best[1]):.1f} ft"
          f"{f'; the best different answer lands {margin:.1%} fewer' if margin is not None else ''}. ({time.time() - t0:.0f} s)")
    th, tx, ty, tz = best[1]
    json.dump({"T": [th, tx, ty], "tz": tz, "landed": best[0], "from": best[2], "stages": best[3], "margin": margin},
              open(os.path.join(d, "registration.json"), "w"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "twin")
