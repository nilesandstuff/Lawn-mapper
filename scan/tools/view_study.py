"""
WHAT THE CAMERA SHOULD SEE (core session, 2026-11-07; docs/SCAN-PLAN.md section 12; the owner: "The matching isn't
considering the things that the camera should actually be able to see... loosen the match on individual features
while putting more emphasis on the overall arrangement of features"). Run by workflow "S. Yard AR tool", task `place`,
after scan/tools/skyline-prep.mjs (and the skyline and pavement studies, whose placements it starts from).

Every depth point the phone kept is a sight line: from where the camera stood then (the twin's track) to the first
surface it saw, r metres off. Under a candidate placement the same line is run through the shade map's model (the
ground, and each column's top: buildings and low structures hard, trees and the unknown soft, as the model's own
`kind` says), and the first hard surface the model puts on it is compared with what the phone measured:
  - the model's surface where the phone's was (within TOL): good, charged its difference;
  - a hard surface well before it (the model says the camera could not have seen that far): charged, up to CAP;
  - nothing hard by then: the phone saw something the model lacks, or saw it in a tree's crown (soft, little cost),
    or the placement is wrong (a flat charge, the same wherever the placement puts it).
Occlusion comes free (the far side of a house is never asked about: the camera's line stops at the near side), and so
does the arrangement: the whole walk's lines are scored at once, not each point against its nearest outline. Leafless
crowns are seen through, so a tree before the phone's point costs nothing.

The vertical: the session's height plus the offset that puts ARCore's ground points on the model's ground (their
median difference), found for each placement.

NUMBERS ONLY in the log. Writes view.json (the best placement and its score) beside the twin; placement.json is not
changed until this has been measured against the check points (SCAN-PLAN section 12).

    python scan/tools/view_study.py twin
"""
import glob
import json
import math
import os
import sys
import time

import numpy as np

FT = 3.28084
STEP = 0.25            # metres between samples along a sight line
TOL = 0.35             # the model's surface this near the phone's counts as the same surface
CAP = 2.0              # a line blocked this early or earlier costs no more
FREE = 0.6             # the cost of a point in the model's open air (squared metres, as a 0.77 m miss)
SOFT = 0.05            # the cost of a point inside a crown or an unknown column
RAYS = int(os.environ.get("VIEW_RAYS", 4000))
GROUND_RAYS = int(os.environ.get("VIEW_GROUND_RAYS", 1200))
HARD = (1, 4)          # structures.js BUILDING, STRUCTURE
SOFT_KINDS = (2, 3, 5)  # TREE, SOLID_TREE, UNKNOWN


def read_parts(d, pattern, rec):
    parts = sorted(glob.glob(os.path.join(d, pattern)))
    if not parts:
        return np.zeros((0, rec), np.float64)
    a = np.concatenate([np.fromfile(p, dtype="<f4") for p in parts])
    return a[: len(a) // rec * rec].reshape(-1, rec).astype(np.float64)


def sight_lines(d):
    """[cam x, y, z, point x, y, z, ground?] per depth point, the camera from the track (nearest pose in time, within
    0.4 s; poses every 0.2 s), in the session frame."""
    cloud = read_parts(d, "cloud-*.bin", 6)       # t, odo, x, y, z, ground
    track = read_parts(d, "track-*.bin", 10)      # t, odo, x, y, z, qx, qy, qz, qw, tracking
    if not len(cloud) or not len(track):
        return None
    track = track[track[:, 9] == 0]
    track = track[np.argsort(track[:, 0])]
    i = np.clip(np.searchsorted(track[:, 0], cloud[:, 0]), 1, len(track) - 1)
    near = np.where(np.abs(track[i, 0] - cloud[:, 0]) < np.abs(track[i - 1, 0] - cloud[:, 0]), i, i - 1)
    ok = np.abs(track[near, 0] - cloud[:, 0]) < 0.4
    cam = track[near, 2:5]
    gnd = np.isfinite(cloud[:, 5]) & (np.abs(cloud[:, 3] - cloud[:, 5]) < 0.15)
    out = np.concatenate([cam, cloud[:, 2:5], gnd[:, None].astype(np.float64)], 1)[ok]
    r = np.linalg.norm(out[:, 3:6] - out[:, 0:3], axis=1)
    return out[(r > 0.5) & (r < 9.0)]


def pick(lines, n, ground):
    """n lines spread over the walk (every k-th, in time order)."""
    a = lines[(lines[:, 6] > 0.5) == ground]
    if len(a) > n:
        a = a[np.linspace(0, len(a) - 1, n).astype(np.int64)]
    return a


class Model:
    """The shade map's model as hard and soft columns. fine > 0: resampled to `fine` metre cells, with the band within
    OVERHANG of a building's edge solid only in its roof (the walls stand about 2 ft in from the eaves: structures.js
    wallsOf, the owner's number), so a line under the eaves to the wall is not stopped at the roof's edge."""
    def __init__(self, d, g, fine=0.0, overhang=0.6):
        S = np.fromfile(os.path.join(d, "sky-surface.bin"), dtype="<f4").reshape(g["h"], g["w"]).astype(np.float64)
        G = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"]).astype(np.float64)
        kp = os.path.join(d, "sky-kind.bin")
        K = np.fromfile(kp, dtype="<u1").reshape(g["h"], g["w"]) if os.path.exists(kp) else np.zeros((g["h"], g["w"]), np.uint8)
        G = np.where(np.isfinite(G), G, S)
        self.roof_low = None
        if fine and fine < g["cell"]:
            f = int(round(g["cell"] / fine))
            S = np.repeat(np.repeat(S, f, 0), f, 1); G = np.repeat(np.repeat(G, f, 0), f, 1); K = np.repeat(np.repeat(K, f, 0), f, 1)
            g = dict(g, w=g["w"] * f, h=g["h"] * f, cell=g["cell"] / f, cellY=g["cellY"] / f)
            bld = K == 1
            if overhang > 0 and bld.any():
                from scipy.ndimage import distance_transform_edt
                inside = distance_transform_edt(bld) * g["cell"]
                eave = bld & (inside <= overhang)
                # under the eaves: open below the roof's own bottom (the edge column's top less a roof's thickness)
                self.roof_low = np.where(eave, S - 0.6, -np.inf)
        self.g, self.S, self.G, self.K = g, S, G, K
        self.hard = np.isin(K, HARD)
        self.soft = np.isin(K, SOFT_KINDS)

    def cells(self, e, n):
        g = self.g
        c = np.floor((e - g["x0"]) / g["cell"]).astype(np.int64); r = np.floor((g["y1"] - n) / g["cellY"]).astype(np.int64)
        ok = (c >= 0) & (r >= 0) & (c < g["w"]) & (r < g["h"])
        return np.where(ok, r, 0), np.where(ok, c, 0), ok


def to_map(T, x, z):
    """session (x, z) -> map (e, n): u = x, v = -z, then the rigid turn and shift."""
    th, tx, ty = T; c, s = math.cos(th), math.sin(th)
    u, v = x, -z
    return c * u - s * v + tx, s * u + c * v + ty


def height_offset(M, T, gl):
    """the offset that puts ARCore's ground points on the model's ground (median), or None."""
    e, n = to_map(T, gl[:, 3], gl[:, 5])
    r, c, ok = M.cells(e, n)
    z = np.where(ok, M.G[r, c], np.nan)
    dz = z - gl[:, 4]; dz = dz[np.isfinite(dz)]
    return float(np.median(dz)) if len(dz) >= 30 else None


DEFAULT = {"tol": TOL, "soft": SOFT, "free": FREE, "blockedW": 1.0, "groundZ": False, "groundW": 1.0}


def cost(M, T, lines, gl, detail=False, P=DEFAULT):
    """P: tol (m), soft and free (the costs of a point in a crown and in open air), blockedW (the weight of a line the
    model stops early), groundZ (ground points judged by their height over the model's ground, |dz| to 0.3 m, rather
    than along their line, where a few cm of height is a metre of range at a glancing angle), groundW."""
    tz = height_offset(M, T, gl)
    if tz is None:
        return (9.0, None) if not detail else (9.0, None, {})
    tol = P["tol"]
    isg = lines[:, 6] > 0.5
    L = lines[~isg] if P["groundZ"] else lines
    cam, pt = L[:, 0:3], L[:, 3:6]
    dvec = pt - cam
    r = np.linalg.norm(dvec, axis=1); u = dvec / r[:, None]
    nS = int(math.ceil((r.max() + tol + STEP) / STEP))
    ds = (np.arange(1, nS + 1) * STEP)[None, :]
    X = cam[:, 0:1] + u[:, 0:1] * ds; Y = cam[:, 1:2] + u[:, 1:2] * ds + tz; Z = cam[:, 2:3] + u[:, 2:3] * ds
    e, n = to_map(T, X, Z)
    rr, cc, ok = M.cells(e, n)
    within = ds <= (r[:, None] + tol)
    solid = M.hard[rr, cc] & (Y < M.S[rr, cc])
    if M.roof_low is not None:
        solid &= Y > np.minimum(M.roof_low[rr, cc], M.S[rr, cc])
    hit = ok & within & ((Y < M.G[rr, cc]) | solid)
    first = np.where(hit.any(1), hit.argmax(1), -1)
    R = np.where(first >= 0, (first + 1) * STEP, np.inf)
    pe, pn = to_map(T, pt[:, 0], pt[:, 2])
    pr, pc, pok = M.cells(pe, pn)
    pz = pt[:, 1] + tz
    in_soft = pok & M.soft[pr, pc] & (pz < M.S[pr, pc] + tol) & (pz > M.G[pr, pc] - tol)
    blocked = R < r - tol
    same = np.abs(R - r) <= tol
    c_ = np.where(blocked, P["blockedW"] * np.minimum(r - R, CAP) ** 2,
         np.where(same, (R - r) ** 2,
         np.where(in_soft, P["soft"], P["free"])))
    total = float(c_.mean())
    gz = None
    if P["groundZ"] and isg.any():
        G_ = lines[isg]
        ge, gn = to_map(T, G_[:, 3], G_[:, 5])
        gr, gc, gok = M.cells(ge, gn)
        dz = np.where(gok, M.G[gr, gc], np.nan) - (G_[:, 4] + tz)
        dz = np.where(np.isfinite(dz), np.minimum(np.abs(dz), 0.3), 0.3)
        gz = float((dz ** 2).mean())
        total = (total * len(L) + P["groundW"] * gz / 0.09 * P["free"] * len(G_)) / (len(L) + len(G_))
    if not detail:
        return total, tz
    return total, tz, {"blocked": float(blocked.mean()), "same": float(same.mean()), "soft": float((~blocked & ~same & in_soft).mean()), "free": float((~blocked & ~same & ~in_soft).mean())}


VARIANTS = [
    ("A: as first built (1 m columns, crowns cheap)", 0.0, DEFAULT),
    ("B: 0.25 m, open under the eaves, crowns say nothing", 0.25, dict(DEFAULT, tol=0.4, soft=FREE)),
    ("C: B, and the ground judged by its height", 0.25, dict(DEFAULT, tol=0.4, soft=FREE, groundZ=True)),
    ("D: C, a line stopped early weighs double", 0.25, dict(DEFAULT, tol=0.4, soft=FREE, groundZ=True, blockedW=2.0)),
]


def fit_rigid(pairs):
    a = np.array([p[0] for p in pairs], float); b = np.array([p[1] for p in pairs], float)
    am, bm = a.mean(0), b.mean(0); A, B = a - am, b - bm
    sxx = (A * B).sum(); sxy = (A[:, 0] * B[:, 1] - A[:, 1] * B[:, 0]).sum()
    th = math.atan2(sxy, sxx); c, s = math.cos(th), math.sin(th)
    return th, bm[0] - (c * am[0] - s * am[1]), bm[1] - (s * am[0] + c * am[1])


def refine(f, T, steps=((2.0, 1.0), (1.0, 0.5), (0.5, 0.25), (0.25, 0.1))):
    best = f(T)
    for dd, mm in steps:
        improved = True
        while improved:
            improved = False
            cands = [(T[0] + math.radians(a * dd), T[1] + x * mm, T[2] + y * mm) for a in (-2, -1, 0, 1, 2) for x in (-2, -1, 0, 1, 2) for y in (-2, -1, 0, 1, 2)]
            scs = [f(C) for C in cands]
            j = int(np.argmin(scs))
            if scs[j] < best - 1e-9:
                best, T, improved = scs[j], cands[j], True
    return best, T


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    g = inp["grid"]
    if not os.path.exists(os.path.join(d, "sky-surface.bin")):
        print("View study: no model surface (sky-surface.bin); nothing to do.")
        return
    lines = sight_lines(d)
    if lines is None or len(lines) < 200:
        print(f"View study: {0 if lines is None else len(lines)} sight lines; too few.")
        return
    L = np.concatenate([pick(lines, RAYS, False), pick(lines, GROUND_RAYS, True)])
    gl = pick(lines, 3000, True)
    checks = list({c["id"]: c for c in inp.get("checks") or []}.values())
    truth = fit_rigid([(c["ar"], c["map"]) for c in checks]) if len(checks) >= 2 else None
    def errs(T):
        return [math.hypot(math.cos(T[0]) * c["ar"][0] - math.sin(T[0]) * c["ar"][1] + T[1] - c["map"][0], math.sin(T[0]) * c["ar"][0] + math.cos(T[0]) * c["ar"][1] + T[2] - c["map"][1]) for c in checks]
    def said(T):
        if not truth:
            return ""
        e_ = errs(T)
        return f"; checks {', '.join(f'{x * FT:.1f}' for x in e_)} ft (median {np.median(e_) * FT:.1f}); {math.degrees((T[0] - truth[0] + math.pi) % (2 * math.pi) - math.pi):+.1f} deg from the truth"
    def med(T):
        return float(np.median(errs(T)) * FT) if truth else float("nan")
    starts = []
    sk = os.path.join(d, "skyline.json")
    if os.path.exists(sk):
        for i, q in enumerate(json.load(open(sk)).get("placements", [])[:3]):
            starts.append(((q["theta"], q["tx"], q["ty"]), f"the skyline's {i + 1}"))
    pl = os.path.join(d, "placement.json")
    if os.path.exists(pl):
        q = json.load(open(pl)); starts.append(((q["theta"], q["tx"], q["ty"]), "the placement kept"))
    if inp.get("gps"):
        q = inp["gps"]; starts.append(((q["theta"], q["tx"], q["ty"]), "the GPS / Street View trail"))
    if not starts:
        print("View study: no placement to start from (skyline, pavement or GPS); nothing to search round.")
        return
    print(f"View study: {len(lines):,} sight lines from the walk's depth points ({int((lines[:, 6] > 0.5).sum()):,} on the ground); {len(L):,} used, {len(gl):,} ground points for the height. Starts: {', '.join(nm + (f' ({med(T):.1f} ft)' if truth else '') for T, nm in starts)}.")
    only = os.environ.get("VIEW_VARIANT")
    summary, kept = [], None
    for name, fine, P in VARIANTS:
        if only and not name.startswith(only):
            continue
        t1 = time.time()
        M = Model(d, g, fine=fine)
        f = lambda T: cost(M, T, L, gl, P=P)[0]
        res = []
        for T0, nm in starts:
            c1, T1 = refine(f, T0)
            res.append((c1, T1, nm))
        res.sort(key=lambda x: x[0])
        best = res[0]
        line = f"  [{name}] best from {best[2]}: cost {best[0]:.4f}{said(best[1])}"
        if truth:
            ct, _, parts = cost(M, truth, L, gl, detail=True, P=P)
            cT, TT = refine(f, truth)
            line += f". At the truth: cost {ct:.4f} (meeting the model {parts['same']:.0%}, blocked early {parts['blocked']:.0%}, crown {parts['soft']:.0%}, open air {parts['free']:.0%}); refined from the truth it moves to median {med(TT):.1f} ft"
            summary.append((name[:1], med(best[1]), ct <= best[0] + 1e-9))
        others = sorted({round(med(T1), 1) for c1, T1, nm in res}) if truth else []
        print(line + (f"; all starts end at medians {others} ft" if others else "") + f" ({int(time.time() - t1)} s)")
        if kept is None or name.startswith("C"):
            kept = (best, name)
    if summary:
        print("View study, the variants' medians at the check points: " + ", ".join(f"{k} {v:.1f} ft{' (truth is its minimum)' if m else ''}" for k, v, m in summary) + ".")
    (best, name) = kept
    json.dump({"theta": best[1][0], "tx": best[1][1], "ty": best[1][2], "cost": best[0], "from": best[2], "variant": name}, open(os.path.join(d, "view.json"), "w"))
    print(f"Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
