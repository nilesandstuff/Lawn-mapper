"""
THE BEST FIT OVERALL, NOT A PERFECT FIT ON ANY ONE THING (core session, 2026-11-08; the owner: "I don't think we should
only be matching buildings. I think we should match ground, permanent structures like a big boulder, driveways (to
lidar brightness), the general positions of things like shrubs, though the size may change ... by going for the best
possible fit overall rather than a perfect fit on any one object" -- an ornamental grass 7-9 ft tall when the lidar
was flown, cut down each spring; three shrubs planted since. "3 partial matches = fit, 1 pretty good match and 1
partial match = fit.") Run by workflow "S. Yard AR tool", task `place`, after scan/tools/depth_audit.py.

A placement earns CREDITS, one per thing that matches, each capped, so no one object and no run of bad depth can
carry or spoil it:
  GROUND     each 2 m cell of the lidar's ground that ARCore's ground points lie on (Gaussian 15 cm about the
             walk's height offset), up to 1 a cell
  BUILDINGS  each 1 m of a building's edge with the phone's standing points on its walls or roof (inside the
             footprint within 1.2 m of the edge, the walls stand under the eaves, or outside within 0.4 m; each
             point counted to the edge nearest it), graded by how near each point is to where a wall (0.6 m in) or the roof's edge should be; each metre of
             edge earns the mean grade of its points, 1 at most
  THINGS     each of the lidar's other standing things (shrubs, trees, boulders, low structures: anything 0.5 m and
             more over the ground that is not a building) with the phone's points anywhere over its footprint grown
             by 0.75 m, at any height: it may have been cut down, grown or shifted; up to 1 a thing for 5 points
  PAVEMENT   each 1 m cell where the pictures' pavement (and grass) agree with the lidar's brightness (pavement
             dark), positive only
and loses only for what cannot change:
  THROUGH    a sight line that passes through a building's solid (more than 0.5 m of it) before reaching what the
             phone saw: you cannot see through a house. Up to 1 a building cell.
NOTHING is lost for what the lidar has and the phone did not see (cut down, removed, out of sight), or for what the
phone saw and the lidar does not have (planted since, a car, a phantom).

Searched round the same starts as the view study; scored at the check points; each weighting printed, with its
margin over the best placement 2 m or 5 degrees off (what the live fix would need to trust it). A study:
placement.json is not changed. NUMBERS ONLY in the log.

    python scan/tools/consensus_study.py twin
"""
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import view_study as vs  # noqa: E402

FT = 3.28084
GROUND_TOL = 0.15
THING_KINDS = (2, 3, 4, 5)      # structures.js TREE, SOLID_TREE, STRUCTURE, UNKNOWN
THING_MIN_H = 0.5
THING_GROW = 0.75
WEIGHTS = {
    "ground only": dict(G=1, B=0, O=0, P=0, X=0),
    "buildings only": dict(G=0, B=1, O=0, P=0, X=0),
    "things only": dict(G=0, B=0, O=1, P=0, X=0),
    "ground + buildings": dict(G=0.2, B=1, O=0, P=0, X=0),
    "ground + buildings + things": dict(G=0.2, B=1, O=0.5, P=0, X=0),
    "all, no see-through": dict(G=0.2, B=1, O=0.5, P=0.3, X=0),
    "all": dict(G=0.2, B=1, O=0.5, P=0.3, X=0.5),
}


class Scene:
    def __init__(self, d, inp, lines):
        from scipy.ndimage import distance_transform_edt, label
        self.M = M = vs.Model(d, inp["grid"], fine=0.25)
        g = M.g
        self.g = g
        bld = M.K == 1
        inside = distance_transform_edt(bld) * g["cell"]
        outside = distance_transform_edt(~bld) * g["cell"]
        self.on_bld = (bld & (inside <= 1.8)) | (~bld & (outside <= 0.6))
        # how far inside the footprint's edge (negative outside): the walls stand about 2 ft (0.6 m) in from the eaves
        # (structures.js wallsOf, the owner's number), the roof's edge on the edge itself
        self.inset = np.where(bld, inside, -outside)
        # each point is credited to the stretch of the building's edge nearest it (1 m of edge), not to where it lands:
        # a placement turned a little smears a wall's points over more ground, never over more wall
        from scipy.ndimage import binary_erosion
        edge = bld & ~binary_erosion(bld)
        if edge.any():
            _, ei = distance_transform_edt(~edge, return_indices=True)
            step = max(1, int(round(1.0 / g["cell"])))
            self.edge_key = (ei[0] // step) * 100003 + (ei[1] // step)
        else:
            self.edge_key = np.zeros(bld.shape, np.int64)
        from scipy.ndimage import maximum_filter
        self.bld_top = maximum_filter(np.where(bld, M.S, -np.inf), size=5)
        thing = np.isin(M.K, THING_KINDS) & (M.S - M.G > THING_MIN_H)
        comp, n = label(thing, structure=np.ones((3, 3)))
        sizes = np.bincount(comp.ravel())
        comp[sizes[comp] < 2] = 0
        dist, idx = distance_transform_edt(comp == 0, return_indices=True)
        grown = comp[idx[0], idx[1]]
        self.thing = np.where(dist * g["cell"] <= THING_GROW, grown, 0)
        self.n_things = int(len(np.unique(comp)) - 1)
        isg = lines[:, 6] > 0.5
        self.ground = vs.pick(lines, 6000, True)
        self.stand = lines[~isg]
        if len(self.stand) > 20000:
            self.stand = self.stand[np.linspace(0, len(self.stand) - 1, 20000).astype(np.int64)]
        self.through_lines = np.concatenate([vs.pick(lines, 1000, False), vs.pick(lines, 300, True)])
        # pavement from the pictures (pavement.json, session level frame u, v) against the lidar's brightness
        self.pave = self.grass = None
        pj, ip = os.path.join(d, "pavement.json"), os.path.join(d, "sky-intensity.bin")
        if os.path.exists(pj) and os.path.exists(ip):
            P = json.load(open(pj))
            gi = inp["grid"]
            I = np.fromfile(ip, dtype="<u2").reshape(gi["h"], gi["w"]).astype(np.float64)
            has = I > 0
            if has.sum() > 100 and len(P.get("pavement", [])) >= 50:
                self.I, self.gi = I, gi
                self.med = float(inp.get("intensityMedian") or np.median(I[has]))
                self.scale = float(np.percentile(I[has], 75) - np.percentile(I[has], 25)) / 2 or 1.0
                self.pave = np.array(P["pavement"], float)
                gr = np.array(P.get("grass", []), float)
                self.grass = gr[np.linspace(0, len(gr) - 1, min(len(gr), 4 * len(self.pave))).astype(np.int64)] if len(gr) else gr

    def cells(self, e, n):
        return self.M.cells(e, n)

    def credits(self, T, want_x=True):
        M, g = self.M, self.g
        tz = vs.height_offset(M, T, self.ground)
        if tz is None:
            return None
        out = {}
        # GROUND: each 2 m cell, the mean Gaussian of its points, cells with 5 or more
        G_ = self.ground
        e, n = vs.to_map(T, G_[:, 3], G_[:, 5])
        r, c, ok = self.cells(e, n)
        dz = np.where(ok, M.G[r, c], np.nan) - (G_[:, 4] + tz)
        w = np.exp(-0.5 * (dz / GROUND_TOL) ** 2)
        k2 = (np.floor(e / 2).astype(np.int64) * 100003 + np.floor(n / 2).astype(np.int64))[np.isfinite(dz)]
        w = w[np.isfinite(dz)]
        if len(k2):
            u, inv = np.unique(k2, return_inverse=True)
            cnt = np.bincount(inv); s = np.bincount(inv, weights=w)
            out["G"] = float((s / np.maximum(cnt, 1))[cnt >= 5].sum())
        else:
            out["G"] = 0.0
        # BUILDINGS and THINGS: the standing points where they land
        S_ = self.stand
        e, n = vs.to_map(T, S_[:, 3], S_[:, 5])
        r, c, ok = self.cells(e, n)
        y = S_[:, 4] + tz
        gnd = np.where(ok, M.G[r, c], np.nan)
        onb = ok & self.on_bld[r, c] & (y > gnd + 0.3) & (y < self.bld_top[r, c] + 0.5)
        # graded: each point by how near it sits to where a wall (0.6 m in) or the roof's edge (on it) should be;
        # each metre of edge earns the mean of its points' grades (2 or more points), so a placement is told from
        # one a little off, and no metre earns more than 1 however many points it has
        k1 = self.edge_key[r[onb], c[onb]]
        if len(k1):
            sdist = self.inset[r[onb], c[onb]]
            q = np.maximum(np.exp(-0.5 * ((sdist - 0.6) / 0.3) ** 2), np.exp(-0.5 * (sdist / 0.3) ** 2))
            u_, inv = np.unique(k1, return_inverse=True)
            cnt = np.bincount(inv); mq = np.bincount(inv, weights=q) / cnt
            out["B"] = float(mq[cnt >= 2].sum())
        else:
            out["B"] = 0.0
        h = y - gnd
        tid = np.where(ok & ~onb & (h > 0.15) & (h < 8), self.thing[r, c], 0)
        cnt = np.bincount(tid[tid > 0])
        out["O"] = float(np.minimum(1, cnt[1:] / 5).sum()) if len(cnt) > 1 else 0.0
        # PAVEMENT: each 1 m cell, positive only
        out["P"] = 0.0
        if self.pave is not None:
            gi = self.gi
            tot = 0.0
            for pts, want in ((self.pave, True), (self.grass, False)):
                if pts is None or not len(pts):
                    continue
                th, tx, ty = T; c_, s_ = math.cos(th), math.sin(th)
                ee = c_ * pts[:, 0] - s_ * pts[:, 1] + tx; nn = s_ * pts[:, 0] + c_ * pts[:, 1] + ty
                cc = np.floor((ee - gi["x0"]) / gi["cell"]).astype(np.int64); rr = np.floor((gi["y1"] - nn) / gi["cellY"]).astype(np.int64)
                okk = (cc >= 0) & (rr >= 0) & (cc < gi["w"]) & (rr < gi["h"])
                v = np.where(okk, self.I[np.where(okk, rr, 0), np.where(okk, cc, 0)], 0)
                m = v > 0
                if m.sum() < 10:
                    continue
                p = 1 / (1 + np.exp(-(self.med - v[m]) / self.scale))
                q = np.maximum(0, 2 * (p if want else 1 - p) - 1)
                kk = rr[m] * gi["w"] + cc[m]
                u, inv = np.unique(kk, return_inverse=True)
                tot += float((np.bincount(inv, weights=q) / np.bincount(inv)).sum())
            out["P"] = tot
        # THROUGH a building: lines that cross more than 0.5 m of solid before their point
        out["X"] = 0.0
        if want_x:
            L = self.through_lines
            cam, pt = L[:, 0:3], L[:, 3:6]
            dv = pt - cam; rl = np.linalg.norm(dv, axis=1); u_ = dv / rl[:, None]
            ds = (np.arange(1, int(9 / 0.25) + 1) * 0.25)[None, :]
            X = cam[:, 0:1] + u_[:, 0:1] * ds; Y = cam[:, 1:2] + u_[:, 1:2] * ds + tz; Z = cam[:, 2:3] + u_[:, 2:3] * ds
            ee, nn = vs.to_map(T, X, Z)
            rr, cc, okk = self.cells(ee, nn)
            solid = okk & (M.K[rr, cc] == 1) & (Y < M.S[rr, cc]) & (Y > M.G[rr, cc] + 0.3) & (ds < rl[:, None] - 0.5)
            if M.roof_low is not None:
                solid &= Y > np.minimum(M.roof_low[rr, cc], M.S[rr, cc])
            thru = solid.sum(1) * 0.25 > 0.5
            if thru.any():
                first = np.where(solid[thru].any(1), solid[thru].argmax(1), 0)
                kc = rr[thru, first] * g["w"] + cc[thru, first]
                _, cnt = np.unique(kc, return_counts=True)
                out["X"] = float(np.minimum(1, cnt / 3).sum())
        return out


def total(cr, W):
    return W["G"] * cr["G"] + W["B"] * cr["B"] + W["O"] * cr["O"] + W["P"] * cr["P"] - W["X"] * cr["X"]


def refine(f, T, steps=((3.0, 1.5), (1.0, 0.5), (0.4, 0.2), (0.15, 0.08))):
    best = f(T)
    for dd, mm in steps:
        improved = True
        guard = 0
        while improved and guard < 6:
            improved = False; guard += 1
            cands = [(T[0] + math.radians(a * dd), T[1] + x * mm, T[2] + y * mm) for a in (-2, -1, 0, 1, 2) for x in (-2, -1, 0, 1, 2) for y in (-2, -1, 0, 1, 2) if a or x or y]
            scs = [f(C) for C in cands]
            j = int(np.argmax(scs))
            if scs[j] > best + 1e-9:
                best, T, improved = scs[j], cands[j], True
    return best, T


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    lines = vs.sight_lines(d)
    if lines is None or len(lines) < 500:
        print("Best fit overall: too few depth points.")
        return
    checks = list({c["id"]: c for c in inp.get("checks") or []}.values())
    sc = Scene(d, inp, lines)
    truth = vs.fit_rigid([(c["ar"], c["map"]) for c in checks]) if len(checks) >= 2 else None

    def med(T):
        return float(np.median([math.hypot(math.cos(T[0]) * c["ar"][0] - math.sin(T[0]) * c["ar"][1] + T[1] - c["map"][0], math.sin(T[0]) * c["ar"][0] + math.cos(T[0]) * c["ar"][1] + T[2] - c["map"][1]) for c in checks]) * FT) if checks else float("nan")

    starts = []
    sk = os.path.join(d, "skyline.json")
    if os.path.exists(sk):
        starts += [((q["theta"], q["tx"], q["ty"]), f"the skyline's {i + 1}") for i, q in enumerate(json.load(open(sk)).get("placements", [])[:3])]
    if os.path.exists(os.path.join(d, "placement.json")):
        q = json.load(open(os.path.join(d, "placement.json"))); starts.append(((q["theta"], q["tx"], q["ty"]), "the placement kept"))
    if inp.get("gps"):
        q = inp["gps"]; starts.append(((q["theta"], q["tx"], q["ty"]), "the GPS / Street View trail"))
    if not starts:
        print("Best fit overall: nowhere to start from.")
        return
    cache = {}

    def cr(T, want_x):
        key = (round(T[0], 6), round(T[1], 4), round(T[2], 4), want_x)
        if key not in cache:
            cache[key] = sc.credits(T, want_x)
        return cache[key]

    print(f"Best fit overall: {len(sc.ground):,} ground points, {len(sc.stand):,} standing points, {sc.n_things} lidar things (shrubs, trees, boulders, low structures), pavement {'yes' if sc.pave is not None else 'no'}; starts: {', '.join(nm + (f' ({med(T):.1f} ft)' if checks else '') for T, nm in starts)}.")
    if truth is not None:
        ct = cr(truth, True)
        print(f"  At the truth (the check points' own fit): ground {ct['G']:.1f} cells, buildings {ct['B']:.1f} cells, things {ct['O']:.1f} of {sc.n_things}, pavement {ct['P']:.1f} cells, through a building {ct['X']:.1f} cells.")
    summary = []
    for name, W in WEIGHTS.items():
        tw = time.time()
        wx = W["X"] > 0
        f = lambda T, W=W, wx=wx: (lambda c: -1e9 if c is None else total(c, W))(cr(T, wx))
        res = sorted((refine(f, T0) + (nm,) for T0, nm in starts), key=lambda x: -x[0])
        best, Tb, frm = res[0]
        # margin: the best of the placements 2-4 m or 5-10 degrees off, refined finely
        other = -1e9
        for a, x, y in ((0, 3, 0), (0, -3, 0), (0, 0, 3), (0, 0, -3), (8, 0, 0), (-8, 0, 0)):
            C = (Tb[0] + math.radians(a), Tb[1] + x, Tb[2] + y)
            q, Tq = refine(f, C, steps=((0.5, 0.25),))
            if math.hypot(Tq[1] - Tb[1], Tq[2] - Tb[2]) > 2 or abs(Tq[0] - Tb[0]) > math.radians(5):
                other = max(other, q)
        margin = (best - other) / abs(best) if best else 0
        cb = cr(Tb, wx)
        line = f"  [{name}] best from {frm}: median {med(Tb):.1f} ft at the check points (starts end at {sorted({round(med(x[1]), 1) for x in res})} ft); margin {margin:.1%}; credits ground {cb['G']:.1f}, buildings {cb['B']:.1f}, things {cb['O']:.1f}, pavement {cb['P']:.1f}, through {cb['X']:.1f}"
        if truth is not None:
            tt = f(truth)
            q, Tt = refine(f, truth)
            line += f"; the truth scores {tt:.1f} against the best {best:.1f}, and refined from it moves to {med(Tt):.1f} ft"
        print(line + f" ({int(time.time() - tw)} s)")
        summary.append(f"{name} {med(Tb):.1f} ft ({margin:.0%})")
    print("Best fit overall, the weightings' medians at the check points (margin): " + "; ".join(summary) + f". Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
