"""
WHICH OF THE PHONE'S DEPTH POINTS ARE REAL (core session, 2026-11-08; the owner, after SCAN-H25: "That points to the
issue being recognizing which depth points are real and which aren't... I was facing the main west facing wall of the
house, on the southern 1/3. Staring at the wall straight on, the cursor jumped forward to be only a few feet away").
Run by workflow "S. Yard AR tool", task `place`, after scan/tools/view_study.py.

Two judges, independent of each other:
  1. THE WALK ITSELF. Every depth point is a sight line from where the camera stood to what it saw. A point is a
     PHANTOM when, from other places along the walk, the camera's lines passed THROUGH its spot (0.3 m cubes) more
     than twice as often as anything was seen there: something real stops the lines that cross it. No model needed.
  2. THE MODEL, under the walk's placement (the check points' own fit when there are check points, else the
     placement after the walk): a line the model says runs on to a building or the ground well beyond where the
     phone stopped (the phone saw something much nearer than the model's first hard surface).
Then the moments where near readings cluster in front of a building (seconds into the walk, feet walked, which way
the camera faced), and the view study's variant C again with the phantom lines left out.

NUMBERS ONLY in the log (times, distances, compass directions; never a place).

    python scan/tools/depth_audit.py twin
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
CUBE = 0.3
STEP = 0.15
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def carve(lines, cube=CUBE, step=STEP, keep=60000):
    """free and seen counts per cube from the walk's own lines (cam -> point), and each line's endpoint cube's
    counts. -> (free_at_end, seen_at_end) per line."""
    L = lines if len(lines) <= keep else lines[np.linspace(0, len(lines) - 1, keep).astype(np.int64)]
    lo = np.minimum(L[:, 0:3].min(0), L[:, 3:6].min(0)) - 1.0
    hi = np.maximum(L[:, 0:3].max(0), L[:, 3:6].max(0)) + 1.0
    dims = np.ceil((hi - lo) / cube).astype(np.int64)
    def key(p):
        i = np.floor((p - lo) / cube).astype(np.int64)
        i = np.clip(i, 0, dims - 1)
        return (i[..., 0] * dims[1] + i[..., 1]) * dims[2] + i[..., 2]
    nvox = int(dims.prod())
    seen = np.bincount(key(L[:, 3:6]), minlength=nvox)
    free = np.zeros(nvox, np.int64)
    d = L[:, 3:6] - L[:, 0:3]; r = np.linalg.norm(d, axis=1); u = d / r[:, None]
    for a in range(0, len(L), 8000):
        b = min(len(L), a + 8000)
        nS = int(math.ceil(r[a:b].max() / step))
        ts = (np.arange(1, nS + 1) * step)[None, :]
        ok = ts < (r[a:b, None] - cube)            # stop short of the point's own cube
        P = L[a:b, None, 0:3] + u[a:b, None, :] * ts[..., None]
        k = key(P)[ok]
        free += np.bincount(k, minlength=nvox)
    ke = key(lines[:, 3:6])
    return free[ke], seen[ke]


def spikes(lines, by_label=False, radius_deg=5.0, min_nb=4, alone=0.25, stats=None):
    """A reading much nearer than the readings round it in the same depth picture (the owner, 2026-11-08: "that wall
    ... had correct depth readings for most of it, it was just one spot"). Neighbours are the picture's other points
    within radius_deg of its line of sight (the page reads 16 x 28 cells, about 3 degrees apart). A spike: at least
    min_nb neighbours, nearer than 60% of their median and by 1 m or more, the neighbours agreeing with each other (60%
    within 15% of their median: a surface) and few of them as near as it (a quarter at most: not a post or a branch).
    by_label: neighbours only of the same ARCore label, when the walk has labels. -> bool per line."""
    out = np.zeros(len(lines), bool)
    nbs = np.zeros(len(lines), np.int64)
    t = lines[:, 10]
    d = lines[:, 3:6] - lines[:, 0:3]
    r = np.linalg.norm(d, axis=1)
    u = d / r[:, None]
    cosr = math.cos(math.radians(radius_deg))
    order = np.argsort(t, kind="stable")
    ts = t[order]
    cuts = np.flatnonzero(np.diff(ts)) + 1
    for g in np.split(order, cuts):
        if len(g) < min_nb + 1:
            continue
        C = u[g] @ u[g].T
        nb = C > cosr
        np.fill_diagonal(nb, False)
        if by_label:
            lab = lines[g, 7]
            nb &= (lab[:, None] == lab[None, :]) & (lab[:, None] > 0)
        rg = r[g]
        nbs[g] = nb.sum(1)
        for i in np.flatnonzero(nb.sum(1) >= min_nb):
            rn = rg[nb[i]]
            med = np.median(rn)
            if rg[i] < 0.6 * med and rg[i] < med - 1.0 and np.mean(np.abs(rn - med) < 0.15 * med) >= 0.6 and np.mean(rn < rg[i] * 1.3) <= alone:
                out[g[i]] = True
    if stats is not None:
        sizes = np.diff(np.concatenate([[0], cuts, [len(order)]]))
        stats.update(per_picture=float(np.median(sizes)), with_nb=float(np.mean(nbs >= min_nb)))
    return out


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    lines = vs.sight_lines(d)
    if lines is None or len(lines) < 500:
        print("Depth audit: too few depth points.")
        return
    cam, pt = lines[:, 0:3], lines[:, 3:6]
    r = np.linalg.norm(pt - cam, axis=1)
    isg = lines[:, 6] > 0.5
    free, seen = carve(lines)
    phantom = (free >= 3) & (free > 2 * seen)
    bins = [(0, 2), (2, 4), (4, 6), (6, 9)]
    def share(mask, sel):
        return f"{mask[sel].mean():.0%} of {int(sel.sum()):,}" if sel.any() else "-"
    print(f"Depth audit: {len(lines):,} depth points ({int(isg.sum()):,} on the ground). PHANTOMS by the walk's own lines (seen through from elsewhere more than twice as often as seen): {share(phantom, np.ones(len(lines), bool))}; standing points {share(phantom, ~isg)}; ground points {share(phantom, isg)}.")
    print("  standing points by how far off: " + "; ".join(f"{a * FT:.0f}-{b * FT:.0f} ft {share(phantom, (~isg) & (r >= a) & (r < b))}" for a, b in bins))
    # ARCore's own label on each point (labels-NNNN.bin, app bridge 2 from 2026-11-08)
    lab = lines[:, 7].astype(np.int64)
    sure = lines[:, 8] >= 0.5
    has_labels = (lab > 0).mean() > 0.2
    def lname(k):
        return vs.LABELS[k - 1] if 0 < k <= len(vs.LABELS) else "none"
    if has_labels:
        rows = []
        for k in np.argsort(-np.bincount(lab[~isg], minlength=13))[:7]:
            sel = (~isg) & (lab == k)
            if sel.sum() >= 200:
                rows.append(f"{lname(k)} {share(phantom, sel)}")
        print(f"  ARCore's labels on {(lab > 0).mean():.0%} of the points ({sure[lab > 0].mean():.0%} of those sure). Phantoms among standing points, by label: " + "; ".join(rows))
    else:
        print("  No labels saved with this walk's points (they are kept from the scan site of 2026-11-08 on).")
    # the depth's own confidence on each point (same part): are the phantoms the weak readings? (the cut was lowered
    # from 0.4 to 0.2 on 2026-11-07; the owner's cursor jumps were seen on the walks after)
    dc = lines[:, 9]
    has_conf = (dc > 0).mean() > 0.2
    if has_conf:
        cb = [(0.0, 0.3), (0.3, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]
        print("  Phantoms among standing points by the depth's own confidence: " + "; ".join(f"{a:.1f}-{min(b, 1):.1f} {share(phantom, (~isg) & (dc >= a) & (dc < b))}" for a, b in cb))

    # THE NEIGHBOUR CHECK (spikes): one spot reading near on a surface the rest of the picture reads far
    st_ = {}
    spike = spikes(lines, stats=st_)
    patch = spikes(lines, radius_deg=12.0, min_nb=8, alone=0.45)   # a fake patch a few cells wide
    spike_l = spikes(lines, by_label=True) if has_labels else None
    def overlap(a, b):
        return f"{(a & b).sum() / max(1, a.sum()):.0%}"
    print(f"  The saved points per depth picture: median {st_['per_picture']:.0f} (the page reads 448 cells; the twin keeps a point only in a 5 cm cube not seen before); points with 4+ neighbours within 5 degrees: {st_['with_nb']:.0%}.")
    print(f"  PATCHES (the same check 12 degrees round, up to 45% of the neighbours as near): {share(patch, ~isg)} of standing points; phantoms among them {overlap(patch & ~isg, phantom)}; of the standing phantoms, patches {overlap(phantom & ~isg, patch)}.")
    print(f"  SPIKES (a reading nearer than 60% of its neighbours in the same depth picture, on a surface they agree on): {share(spike, ~isg)} of standing points, {share(spike, isg)} of ground points; of the standing spikes, phantoms by the walk's own lines {overlap(spike & ~isg, phantom)}; of the standing phantoms, spikes {overlap(phantom & ~isg, spike)}." + (f" Neighbours of the same label only: {share(spike_l, ~isg)} of standing points, phantoms among them {overlap(spike_l & ~isg, phantom)}." if spike_l is not None else ""))

    # the model, under the truth (check points) or the placement after the walk
    checks = list({c["id"]: c for c in inp.get("checks") or []}.values())
    T, src = None, None
    if len(checks) >= 2:
        T, src = vs.fit_rigid([(c["ar"], c["map"]) for c in checks]), "the check points' own fit"
    elif os.path.exists(os.path.join(d, "placement.json")):
        q = json.load(open(os.path.join(d, "placement.json"))); T, src = (q["theta"], q["tx"], q["ty"]), "the placement after the walk"
    if T is None:
        print("  No placement to judge against the model.")
        return
    M = vs.Model(d, inp["grid"], fine=0.25)
    gl = vs.pick(lines, 3000, True)
    tz = vs.height_offset(M, T, gl)
    S = ~isg
    Ls = lines[S]
    c_, p_ = Ls[:, 0:3], Ls[:, 3:6]
    dv = p_ - c_; rs = np.linalg.norm(dv, axis=1); u = dv / rs[:, None]
    ds = (np.arange(1, int(40 / 0.25) + 1) * 0.25)[None, :]           # run each line on to 40 m
    X = c_[:, 0:1] + u[:, 0:1] * ds; Y = c_[:, 1:2] + u[:, 1:2] * ds + tz; Z = c_[:, 2:3] + u[:, 2:3] * ds
    e, n = vs.to_map(T, X, Z)
    rr, cc, ok = M.cells(e, n)
    solid = M.hard[rr, cc] & (Y < M.S[rr, cc])
    if M.roof_low is not None:
        solid &= Y > np.minimum(M.roof_low[rr, cc], M.S[rr, cc])
    hit = ok & ((Y < M.G[rr, cc]) | solid)
    first = np.where(hit.any(1), hit.argmax(1), -1)
    R = np.where(first >= 0, (first + 1) * 0.25, np.inf)
    hitbld = np.zeros(len(Ls), bool)
    j = first >= 0
    hitbld[j] = M.K[rr[j, first[j]], cc[j, first[j]]] == 1
    near = (R - rs > 2.0) & (rs < 0.6 * R)          # the phone stopped well short of the model's first surface
    print(f"  Against the model under {src}: standing points stopped well short of the model's first hard surface (2 m+ and under 60% of its distance): {near.mean():.0%}; of those, in front of a BUILDING {np.mean(hitbld[near]) if near.any() else 0:.0%}; of those, phantoms by the walk's own lines {np.mean(phantom[S][near & hitbld]) if (near & hitbld).any() else 0:.0%}.")
    if has_labels and (near & hitbld).any():
        lk = Ls[:, 7].astype(np.int64)[near & hitbld]
        cnt = np.bincount(lk, minlength=13)
        print("  ARCore's labels on the points short of a building: " + "; ".join(f"{lname(k)} {cnt[k] / len(lk):.0%}" for k in np.argsort(-cnt)[:5] if cnt[k]))
    match = np.abs(R - rs) <= 0.5                      # the phone and the model agree on the first surface
    sp = spike[S]
    pa = patch[S]
    print(f"  Patches against the model: short of the model's first hard surface {np.mean(near[pa]) if pa.any() else 0:.0%}, agreeing with the model {np.mean(match[pa]) if pa.any() else 0:.0%}; of all standing points agreeing with the model, patches {np.mean(pa[match]) if match.any() else 0:.1%}.")
    print(f"  Spikes against the model: of the standing spikes, short of the model's first hard surface {np.mean(near[sp]) if sp.any() else 0:.0%}, agreeing with the model (within 0.5 m) {np.mean(match[sp]) if sp.any() else 0:.0%} (those would be good points thrown away); of all standing points agreeing with the model, spikes {np.mean(sp[match]) if match.any() else 0:.1%}.")
    print("  short of a building, by how far the phone said: " + "; ".join(f"{a * FT:.0f}-{b * FT:.0f} ft {int(((near & hitbld) & (rs >= a) & (rs < b)).sum()):,}" for a, b in bins))

    # the moments: per second, standing points well short of a building at least 5 m off
    tcol = None
    cloud = vs.read_parts(d, "cloud-*.bin", 6)
    # sight_lines kept rows of the cloud in order with a filter; recover each line's time and odometer by matching
    # the points (exact floats) back to the cloud
    keyc = {tuple(np.round(row[2:5], 4)): (row[0], row[1]) for row in cloud}
    tt = np.array([keyc.get(tuple(np.round(p, 4)), (np.nan, np.nan)) for p in p_])
    tcol, odo = tt[:, 0], tt[:, 1]
    ev = near & hitbld & (R > 5)
    if ev.any() and np.isfinite(tcol[ev]).any():
        sec = np.floor(tcol[ev]).astype(np.int64)
        cnt = np.bincount(sec - sec.min())
        top = np.argsort(-cnt)[:6]
        print("  Moments with the most near readings in front of a building (time into the walk, walked, facing, readings, phone said / model said, phantoms by the walk's own lines):")
        for k in top:
            if cnt[k] < 3:
                break
            s0 = k + sec.min()
            m = ev & (np.floor(tcol) == s0)
            fwd = u[m].mean(0)
            fe, fn = vs.to_map(T, np.array([fwd[0]]), np.array([fwd[2]]))
            ce, cn = vs.to_map(T, np.array([0.0]), np.array([0.0]))
            ang = math.degrees(math.atan2(fe[0] - ce[0], fn[0] - cn[0])) % 360
            face = COMPASS[int(((ang + 22.5) % 360) // 45)]
            pitch = math.degrees(math.asin(max(-1, min(1, fwd[1] / max(1e-9, np.linalg.norm(fwd))))))
            lm = f", spikes {np.mean(sp[m]):.0%}, patches {np.mean(patch[S][m]):.0%}"
            if has_conf:
                lm += f", depth confidence {np.median(Ls[m, 9]):.2f}"
            if has_labels:
                lk = np.bincount(Ls[m, 7].astype(np.int64), minlength=13)
                lm += f", ARCore said {lname(int(lk.argmax()))} ({lk.max() / m.sum():.0%})"
            print(f"    {int(s0 // 60)}:{int(s0 % 60):02d}, {np.nanmedian(odo[m]) * FT:.0f} ft walked, facing {face} ({ang:.0f} deg), camera {pitch:+.0f} deg: {int(m.sum())} readings, phone {np.median(rs[m]) * FT:.1f} ft / model {np.median(R[m]) * FT:.1f} ft, phantoms {np.mean(phantom[S][m]):.0%}{lm}")
    else:
        print("  No moments with near readings in front of a building.")

    # the view study's variant C without the phantoms; with labels, also with only the standing points ARCore was sure
    # were a building or a structure (the model's hard kinds)
    rerun(d, inp, M, T, checks, gl, lines[~phantom], f"without the phantoms ({int(phantom.sum()):,} left out)")
    rerun(d, inp, M, T, checks, gl, lines[~spike], f"without the spikes ({int(spike.sum()):,} left out)")
    if has_labels:
        hard = isg | (sure & np.isin(lab, [vs.LABELS.index("building") + 1, vs.LABELS.index("structure") + 1]))
        rerun(d, inp, M, T, checks, gl, lines[hard & ~phantom], f"on ARCore's buildings and structures only ({int((hard & ~isg).sum()):,} standing points)")
    print(f"Done in {int(time.time() - t0)} s.")


def rerun(d, inp, M, T, checks, gl, clean, what):
    if len(checks) >= 2 and len(clean) > 1000 and (clean[:, 6] < 0.5).sum() > 300:
        name, fine, P = vs.VARIANTS[2]
        L = np.concatenate([vs.pick(clean, vs.RAYS, False), vs.pick(clean, vs.GROUND_RAYS, True)])
        f = lambda T_: vs.cost(M, T_, L, gl, P=P)[0]
        truth = T
        def med(T_):
            return float(np.median([math.hypot(math.cos(T_[0]) * c["ar"][0] - math.sin(T_[0]) * c["ar"][1] + T_[1] - c["map"][0], math.sin(T_[0]) * c["ar"][0] + math.cos(T_[0]) * c["ar"][1] + T_[2] - c["map"][1]) for c in checks]) * FT)
        starts = []
        sk = os.path.join(d, "skyline.json")
        if os.path.exists(sk):
            starts += [((q["theta"], q["tx"], q["ty"]), f"the skyline's {i + 1}") for i, q in enumerate(json.load(open(sk)).get("placements", [])[:3])]
        if os.path.exists(os.path.join(d, "placement.json")):
            q = json.load(open(os.path.join(d, "placement.json"))); starts.append(((q["theta"], q["tx"], q["ty"]), "the placement kept"))
        if inp.get("gps"):
            q = inp["gps"]; starts.append(((q["theta"], q["tx"], q["ty"]), "the GPS / Street View trail"))
        res = sorted((vs.refine(f, T0) + (nm,) for T0, nm in starts), key=lambda x: x[0])
        cT, TT = vs.refine(f, truth)
        ct, _, parts = vs.cost(M, truth, L, gl, detail=True, P=P)
        print(f"  View study C {what}: best from {res[0][2]}, median {med(res[0][1]):.1f} ft at the check points (starts end at {sorted({round(med(x[1]), 1) for x in res})} ft); at the truth: cost {ct:.4f} against the best {res[0][0]:.4f}, open air {parts['free']:.0%}; refined from the truth it moves to median {med(TT):.1f} ft.")


if __name__ == "__main__":
    main()
