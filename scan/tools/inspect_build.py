"""
THE WALK INSPECTOR'S DATA (core session, 2026-11-08; the owner: "I'd like to get eyes on some of this myself. Like a
visualization of the depth readings, the semantic labels, the mesh, the things that match vs. don't (and this new
point system), and just whatever else is going on. Kind of in the same spirit as the /predictions page").
Run by workflow "S. Yard AR tool", task `place`, after scan/tools/consensus_study.py; read by scan/public/inspect.html.

Writes, beside the twin, into the PRIVATE bucket (map metres; nothing of this is printed):
  inspect.json         the placements (each with its error at the check points), the one the verdicts are scored
                       under, the lidar grid (kinds, heights, brightness at 1 m), the credits per thing (each metre of
                       building edge, each lidar thing, each 2 m of ground), sight lines through a house, the check
                       points, the track on the map, and the counts
  inspect-points.bin   every depth point (at most MAX_POINTS, spread over the walk): Float32 x 8 [session x, y, z, t,
                       map e, n, height over the lidar's ground, grade], then Uint8 x 8 [ground?, ARCore label + 1,
                       depth confidence x 255, spike, phantom, verdict, 0, 0]

Verdicts (under the scored placement): 0 ground on the lidar's ground (within 15 cm), 1 ground off it, 2 on a wall
the camera could see (graded), 3 on a wall it could not have seen (through the house), 4 on a lidar thing (shrub,
tree, boulder, low structure; any height), 5 standing on nothing the lidar has (planted since, moved, a car, or a
phantom: no credit and no loss), 6 off the lidar.

    python scan/tools/inspect_build.py twin
"""
import base64
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import consensus_study as cs  # noqa: E402
import depth_audit as da  # noqa: E402
import view_study as vs  # noqa: E402

MAX_POINTS = 80000
FT = 3.28084


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    lines = vs.sight_lines(d)
    if lines is None or len(lines) < 500:
        print("Inspector: too few depth points.")
        return
    checks = list({c["id"]: c for c in inp.get("checks") or []}.values())
    con = json.load(open(os.path.join(d, "consensus.json"))) if os.path.exists(os.path.join(d, "consensus.json")) else {}

    def med(T):
        return float(np.median([math.hypot(math.cos(T[0]) * c["ar"][0] - math.sin(T[0]) * c["ar"][1] + T[1] - c["map"][0], math.sin(T[0]) * c["ar"][0] + math.cos(T[0]) * c["ar"][1] + T[2] - c["map"][1]) for c in checks]) * FT) if checks else None

    # the placements to compare
    places = []
    if len(checks) >= 2:
        places.append({"name": "the check points' own fit (the truth)", "T": list(vs.fit_rigid([(c["ar"], c["map"]) for c in checks]))})
    if os.path.exists(os.path.join(d, "placement.json")):
        q = json.load(open(os.path.join(d, "placement.json"))); places.append({"name": "after the walk (kept)", "T": [q["theta"], q["tx"], q["ty"]]})
    for nm, w in (con.get("weights") or {}).items():
        if nm in ("all", "ground + buildings + things", "ground only"):
            places.append({"name": f"best fit overall: {nm}", "T": w["T"], "margin": w.get("margin")})
    if inp.get("gps"):
        q = inp["gps"]; places.append({"name": "the GPS / Street View trail", "T": [q["theta"], q["tx"], q["ty"]]})
    sk = os.path.join(d, "skyline.json")
    if os.path.exists(sk):
        for i, q in enumerate(json.load(open(sk)).get("placements", [])[:1]):
            places.append({"name": "the skyline's best", "T": [q["theta"], q["tx"], q["ty"]]})
    if not places:
        print("Inspector: no placement to show the walk under.")
        return
    for p in places:
        p["med"] = med(p["T"])
    scored = places[0]
    T = tuple(scored["T"])

    sc = cs.Scene(d, inp, lines)
    M = sc.M
    tz = vs.height_offset(M, T, sc.ground) or 0.0

    # the points, spread over the walk
    L = lines if len(lines) <= MAX_POINTS else lines[np.linspace(0, len(lines) - 1, MAX_POINTS).astype(np.int64)]
    free, seen = da.carve(L)
    phantom = (free >= 3) & (free > 2 * seen)
    e, n = vs.to_map(T, L[:, 3], L[:, 5])
    r, c, ok = sc.cells(e, n)
    gnd = np.where(ok, M.G[r, c], np.nan)
    y = L[:, 4] + tz
    h = y - gnd
    isg = L[:, 6] > 0.5
    verdict = np.full(len(L), 6, np.uint8)
    grade = np.zeros(len(L), np.float32)
    gq = np.exp(-0.5 * (h / cs.GROUND_TOL) ** 2)
    verdict[ok & isg & (np.abs(h) < cs.GROUND_TOL)] = 0
    verdict[ok & isg & ~(np.abs(h) < cs.GROUND_TOL)] = 1
    grade[isg] = np.nan_to_num(gq[isg])
    st = ok & ~isg
    lab = L[:, 7].astype(np.int64)
    Lb = {k: vs.LABELS.index(k) + 1 for k in vs.LABELS}
    for_b = (lab == 0) | np.isin(lab, [Lb["building"], Lb["structure"]])
    for_o = (lab == 0) | np.isin(lab, [Lb["tree"], Lb["structure"], Lb["object"]])
    onb = st & for_b & sc.on_bld[r, c] & (y > gnd + 0.3) & (y < sc.bld_top[r, c] + 0.5)
    idx = np.flatnonzero(onb)
    hidden = np.zeros(len(L), bool)
    for a in range(0, len(idx), 5000):
        j = idx[a:a + 5000]
        hidden[j] = sc.blocked(T, tz, L[j])
    sd = sc.inset[r, c]
    q = np.maximum(np.exp(-0.5 * ((sd - 0.6) / 0.3) ** 2), np.exp(-0.5 * (sd / 0.3) ** 2))
    verdict[onb & ~hidden] = 2
    grade[onb & ~hidden] = q[onb & ~hidden]
    verdict[onb & hidden] = 3
    tid = np.where(st & for_o & ~onb & (h > 0.15) & (h < 8), sc.thing[r, c], 0)
    verdict[(tid > 0)] = 4
    verdict[st & ~onb & (tid == 0)] = 5

    F = np.stack([L[:, 3], L[:, 4], L[:, 5], L[:, 10], e, n, np.nan_to_num(h, nan=-99), grade], 1).astype("<f4")
    U = np.stack([isg.astype(np.uint8), np.clip(lab, 0, 255).astype(np.uint8), np.clip(np.round(L[:, 9] * 255), 0, 255).astype(np.uint8),
                  (L[:, 12] > 0.5).astype(np.uint8), phantom.astype(np.uint8), verdict, np.where(ok & ~isg, np.clip(np.round((sd + 2) * 50), 1, 255), 0).astype(np.uint8), np.zeros(len(L), np.uint8)], 1)
    with open(os.path.join(d, "inspect-points.bin"), "wb") as fh:
        fh.write(F.tobytes()); fh.write(U.tobytes())

    # credits per thing under the scored placement
    def agg(keys, vals, ee, nn, minc, mean=True):
        if not len(keys):
            return []
        u, inv = np.unique(keys, return_inverse=True)
        cnt = np.bincount(inv)
        s = np.bincount(inv, weights=vals)
        ce = np.bincount(inv, weights=ee) / cnt; cn = np.bincount(inv, weights=nn) / cnt
        cr = s / cnt if mean else np.minimum(1, cnt / minc)
        keep = cnt >= (minc if mean else 1)
        return [[round(float(a), 2), round(float(b), 2), round(float(v), 3), int(k)] for a, b, v, k, kk in zip(ce, cn, cr, cnt, keep) if kk]
    wall = np.flatnonzero(verdict == 2)
    edges = agg(sc.edge_key[r[wall], c[wall]], q[wall], e[wall], n[wall], 2)
    th = np.flatnonzero(verdict == 4)
    things_hit = agg(tid[th], np.ones(len(th)), e[th], n[th], 5, mean=False)
    # every lidar thing, hit or not: its cells (0.25 m, as the study saw it), what kind, how tall, the points that
    # fell on it and its credit. The same labelling as the study's (consensus_study.Scene), so ids agree.
    from scipy.ndimage import find_objects, label
    thing_raw = np.isin(M.K, cs.THING_KINDS) & (M.S - M.G > cs.THING_MIN_H)
    comp, nc = label(thing_raw, structure=np.ones((3, 3)))
    g = M.g
    hits = np.bincount(tid[th], minlength=nc + 1) if len(th) else np.zeros(nc + 1, np.int64)
    KIND = {2: "tree", 3: "tree (solid)", 4: "low structure", 5: "unknown"}
    allthings = []
    for i, sl in enumerate(find_objects(comp)):
        if sl is None:
            continue
        m = comp[sl] == i + 1
        if m.sum() < 2:
            continue
        r0, c0 = sl[0].start, sl[1].start
        kinds = M.K[sl][m]
        allthings.append({"id": i + 1, "e0": round(g["x0"] + c0 * g["cell"], 3), "n1": round(g["y1"] - r0 * g["cellY"], 3), "w": int(m.shape[1]), "h": int(m.shape[0]),
                          "bits": b64(np.packbits(m.astype(np.uint8).ravel())), "kind": KIND.get(int(np.bincount(kinds).argmax()), "thing"),
                          "top": round(float(np.nanmax((M.S - M.G)[sl][m])), 1), "area": round(float(m.sum()) * g["cell"] * g["cellY"], 1),
                          "points": int(hits[i + 1]), "credit": round(min(1.0, hits[i + 1] / 5), 2)})
    gidx = np.flatnonzero(isg & ok)
    k2 = np.floor(e[gidx] / 2).astype(np.int64) * 100003 + np.floor(n[gidx] / 2).astype(np.int64)
    ground_cells = agg(k2, gq[gidx], e[gidx], n[gidx], 5)

    # sight lines through a house (the only loss)
    X = sc.through_lines
    blk = sc.blocked(T, tz, X)
    ce_, cn_ = vs.to_map(T, X[blk, 0], X[blk, 2]); pe_, pn_ = vs.to_map(T, X[blk, 3], X[blk, 5])
    through = [[round(float(a), 2), round(float(b), 2), round(float(c_), 2), round(float(d_), 2)] for a, b, c_, d_ in zip(ce_, cn_, pe_, pn_)][:400]

    # the track on the map
    track = vs.read_parts(d, "track-*.bin", 10)
    track = track[np.argsort(track[:, 0])] if len(track) else track
    tr = []
    last = -1e9
    for row in track:
        if row[0] - last < 1.0:
            continue
        last = row[0]
        te, tn = vs.to_map(T, np.array([row[2]]), np.array([row[4]]))
        tr.append([round(float(row[0]), 1), round(float(te[0]), 2), round(float(tn[0]), 2), round(float(row[1]), 1)])

    # the lidar grid at 1 m (the inspector's ground layer)
    gi = inp["grid"]
    S = np.fromfile(os.path.join(d, "sky-surface.bin"), dtype="<f4").reshape(gi["h"], gi["w"])
    G = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(gi["h"], gi["w"])
    G = np.where(np.isfinite(G), G, S)
    kp = os.path.join(d, "sky-kind.bin")
    K = np.fromfile(kp, dtype="<u1").reshape(gi["h"], gi["w"]) if os.path.exists(kp) else np.zeros((gi["h"], gi["w"]), np.uint8)
    hgt = np.clip(np.round(np.nan_to_num(S - G) * 10), 0, 255).astype(np.uint8)
    grid = {**gi, "kind": b64(K.astype(np.uint8)), "height": b64(hgt), "groundZ": float(np.nanmedian(G))}
    ip = os.path.join(d, "sky-intensity.bin")
    if os.path.exists(ip):
        I = np.fromfile(ip, dtype="<u2").reshape(gi["h"], gi["w"]).astype(np.float64)
        has = I > 0
        if has.any():
            lo, hi = np.percentile(I[has], 2), np.percentile(I[has], 98)
            grid["bright"] = b64(np.where(has, np.clip((I - lo) / max(1, hi - lo) * 254 + 1, 1, 255), 0).astype(np.uint8))

    out = {
        "v": 1, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "walk": os.environ.get("WALK"),
        "scored": scored["name"], "heightOffset": tz, "placements": places, "consensus": con,
        "checks": [{"id": c_["id"], "map": c_["map"], "ar": c_["ar"]} for c_ in checks],
        "grid": grid, "edges": edges, "thingsHit": things_hit, "things": allthings, "thingCell": [g["cell"], g["cellY"]], "groundCells": ground_cells, "through": through, "track": tr,
        "points": {"n": int(len(L)), "of": int(len(lines)), "float": ["x", "y", "z", "t", "e", "n", "h", "grade"], "byte": ["ground", "label", "depthConf", "spike", "phantom", "verdict", "inset: (m inside the lidar's roof edge + 2) x 50, 0 none", "0"]},
        "labels": vs.LABELS,
        "verdicts": ["ground on the lidar's ground", "ground off it", "on a wall the camera could see", "on a wall it could not have seen", "on a lidar thing (any height)", "standing on nothing the lidar has", "off the lidar"],
        "counts": {k: int((verdict == i).sum()) for i, k in enumerate(["groundOn", "groundOff", "wall", "wallHidden", "thing", "nothing", "off"])} | {"phantoms": int(phantom.sum()), "spikes": int((L[:, 12] > 0.5).sum())},
    }
    wi = sd[verdict == 2]
    out["wallInset"] = {"median": float(np.median(wi)) if len(wi) else None, "q25": float(np.percentile(wi, 25)) if len(wi) else None, "q75": float(np.percentile(wi, 75)) if len(wi) else None}
    json.dump(out, open(os.path.join(d, "inspect.json"), "w"))
    sz = os.path.getsize(os.path.join(d, "inspect.json")) + os.path.getsize(os.path.join(d, "inspect-points.bin"))
    print(f"Inspector: {len(L):,} points, {len(edges)} metres of building edge credited, {sum(1 for t in allthings if t['points'])} of {len(allthings)} lidar things, {len(ground_cells)} ground cells, {len(through)} lines through a house; wall points sit a median {(out['wallInset']['median'] or 0) * FT:.1f} ft inside the lidar's roof edge (walls stand about 2 ft in); scored under {scored['name']}; {sz / 1e6:.1f} MB. Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
