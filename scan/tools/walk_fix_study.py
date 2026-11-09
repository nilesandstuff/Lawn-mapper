"""
A WALK PLACED BY AN EARLIER WALK: PICTURES AGAINST SHAPES (core session, 2026-11-09). The owner, on the next phase
(a first walk as the reference that places later ones without marks): "The issue I believe we were having with shape
to lidar alignment is that we were comparing 2 very different sets of 3d points taken from very different
perspectives. In contrast, it should be much easier to match the 3d points taken from a phone to the 3d points taken
on the same phone. So lets try both photos and shapes. If they're about equal, i say let's go with the shapes."

Each walk given takes its turn as the REFERENCE: placed on the map by its own marks (checks and references fitted as
one turn and shift, the way a walk is placed today). Every other walk is then placed from it twice, never looking at
its own marks:

  PICTURES: SIFT points in each of its pictures matched to the reference's pictures (each picture's likeliest partners
            first, by a small vocabulary of the points), checked by the two cameras' geometry (RANSAC on the
            fundamental matrix); each matched point lifted to 3D on both sides by the walk's own depth points seen in
            that picture; then one turn and shift for the whole walk from all those 3D pairs (RANSAC, two at a time).
  SHAPES:   the things standing on the ground (0.3-4 m over the phone's ground: walls, shrubs, trunks, fences) drawn
            as a plan on both sides, matched over every turn (every 2 degrees, by correlation: no start needed), the
            three best refined by small_gicp's GICP in 3D with the ground, four degrees of freedom; the one that lands
            the most points within 0.3 m of the reference's kept (the eight best turns refined). Also with only the
            points ARCore labels building or structure (walls, fences), where both walks have labels.

Scored on the placed walk's own check marks (held out: neither method sees them), against two yardsticks: the walk
fitted to its own marks (the best any placement can do, ARCore's bending and the marking themselves), and its
after-the-walk placement from the lidar (placement.json, when task place kept one).

Each walk's twin is a folder made by twin-r2.mjs get and skyline-prep.mjs (pictures, depth points, sky-input.json).
Prints distances and counts only.

    python scan/tools/walk_fix_study.py w1 w2 [w3 ...]
"""
import json
import math
import os
import sys
import time

import cv2
import numpy as np
from scipy.cluster.vq import kmeans2
from scipy.signal import fftconvolve
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
import view_study as vs  # noqa: E402  (read_cloud, fit_rigid)

FT = 3.28084
WIDTH = 640               # pictures are matched at this width
FEATURES = 1500
TOP = 6                   # reference pictures tried for each picture
PX = 12                   # px: a matched point takes the depth of the nearest surface among depth points this near it
RANGE = (0.5, 25.0)       # m from the camera
DROP = {2, 10, 11}        # label + 1: sky, vehicle, person
CELL = 0.3                # m: the shape plan's cells
STAND = (0.3, 4.0)        # m over the phone's ground: standing things
LAND = 0.3                # m: a point this near the reference's has landed


def place(T, uv):
    th, tx, ty = T[:3]
    c, s = math.cos(th), math.sin(th)
    return np.stack([c * uv[:, 0] - s * uv[:, 1] + tx, s * uv[:, 0] + c * uv[:, 1] + ty], 1)


def load(d):
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    meta = json.load(open(os.path.join(d, "meta.json"))) if os.path.exists(os.path.join(d, "meta.json")) else {}
    C = vs.read_cloud(d)
    if len(C) and C.shape[1] > 9:
        C = C[C[:, 9] == 0]                                  # the page's spikes out
    if len(C):
        C = C[~np.isin(C[:, 6].astype(int), list(DROP))]
    pl = None
    if os.path.exists(os.path.join(d, "placement.json")):
        q = json.load(open(os.path.join(d, "placement.json")))
        if all(math.isfinite(q.get(k, float("nan"))) for k in ("theta", "tx", "ty")):
            pl = (q["theta"], q["tx"], q["ty"])
    checks = inp.get("checks") or []
    refs = inp.get("refs") or []
    return {
        "dir": d, "name": str(meta.get("walk") or os.path.basename(d.rstrip("/"))), "map": meta.get("map"),
        "cloud": C, "pics": inp.get("pictures") or [], "checks": checks, "refs": refs, "placement": pl,
    }


def marks_fit(w, use_refs=True):
    marks = w["checks"] + (w["refs"] if use_refs else [])
    if len(marks) < 3:
        return None
    return vs.fit_rigid([(m["ar"], m["map"]) for m in marks])


def check_errs(w, T):
    if T is None:
        return []
    return [math.hypot(*(place(T, np.array([c["ar"]], float))[0] - np.array(c["map"], float))) * FT for c in w["checks"]]


def med(a):
    return float(np.median(a)) if len(a) else float("nan")


# ------------------------------------------------------------------ pictures
def picture_points(w):
    """Per picture: SIFT keypoints (px at WIDTH), descriptors, and each keypoint's 3D point in the session plan
    [u, v, height] (NaN where no depth point is near)."""
    sift = cv2.SIFT_create(nfeatures=FEATURES)
    # every depth point of the walk, through each picture's camera (the twin keeps one point per small cube, the
    # first seen, so the points of the picture's own moment are too few: run 217 lifted 156 of a walk's points)
    C = w["cloud"]
    xyz1 = np.concatenate([C[:, 2:5], np.ones((len(C), 1))], 1) if len(C) else np.zeros((0, 4))
    out = []
    for p in w["pics"]:
        img = cv2.imread(os.path.join(w["dir"], p["name"]), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        H = int(round(img.shape[0] * WIDTH / img.shape[1]))
        img = cv2.resize(img, (WIDTH, H), interpolation=cv2.INTER_AREA)
        kps, des = sift.detectAndCompute(img, None)
        if des is None or len(kps) < 30:
            continue
        uv = np.array([k.pt for k in kps], np.float64)
        # the depth points of this moment, through this picture's camera
        V = np.asarray(p["view"], float).reshape(4, 4).T      # camera -> session
        P = np.asarray(p["proj"], float).reshape(4, 4).T
        pts3 = np.full((len(kps), 3), np.nan)
        dpath = os.path.join(w["dir"], p["name"].replace(".jpg", ".depth"))
        if os.path.exists(dpath):
            # the depth grid kept with the picture (app.js keyDepth, from 2026-11-09): every keypoint its own distance
            a = np.fromfile(dpath, dtype="<u2")
            nx, ny = int(a[0]), int(a[1])
            if len(a) >= 2 + nx * ny:
                D = a[2:2 + nx * ny].reshape(ny, nx).astype(np.float64) / 1000.0
                Pi = np.linalg.inv(P)
                for i, (u, v) in enumerate(uv):
                    d = D[min(ny - 1, int(v / H * ny)), min(nx - 1, int(u / WIDTH * nx))]
                    if d <= 0:
                        continue
                    nx_, ny_ = 2 * u / WIDTH - 1, 1 - 2 * v / H
                    a0 = Pi @ np.array([nx_, ny_, -1.0, 1.0]); a0 = a0[:3] / a0[3]
                    a1 = Pi @ np.array([nx_, ny_, 1.0, 1.0]); a1 = a1[:3] / a1[3]
                    ray = a1 - a0
                    ray = ray / np.linalg.norm(ray)
                    q = V[:3, 3] + V[:3, :3] @ ray * d
                    pts3[i] = [q[0], -q[2], q[1]]
                out.append({"name": p["name"], "des": des.astype(np.float32), "uv": uv, "xyz": pts3, "W": WIDTH, "H": H, "V": V, "P": P, "dense": True})
                continue
        if len(C):
            cam = (np.linalg.inv(V) @ xyz1.T)
            front = (cam[2] < -RANGE[0]) & (cam[2] > -RANGE[1])
            clip = P @ cam
            ndc = clip[:3] / np.where(np.abs(clip[3]) < 1e-9, 1e-9, clip[3])
            ok = front & (np.abs(ndc[0]) <= 1) & (np.abs(ndc[1]) <= 1)
            if ok.sum() >= 10:
                px = np.stack([(ndc[0, ok] + 1) / 2 * WIDTH, (1 - ndc[1, ok]) / 2 * H], 1)
                depth = -cam[2, ok]
                tree = cKDTree(px)
                Pi = np.linalg.inv(P)
                for i, nb in enumerate(tree.query_ball_point(uv, PX)):
                    if nb:
                        # the nearest surface under the point: its distance, along the point's own line of sight
                        d = float(depth[nb][int(np.argmin(depth[nb]))])
                        nx, ny = 2 * uv[i, 0] / WIDTH - 1, 1 - 2 * uv[i, 1] / H
                        a0 = Pi @ np.array([nx, ny, -1.0, 1.0]); a0 = a0[:3] / a0[3]
                        a1 = Pi @ np.array([nx, ny, 1.0, 1.0]); a1 = a1[:3] / a1[3]
                        ray = a1 - a0
                        if ray[2] >= 0:
                            continue
                        q = V @ np.array([*(ray / -ray[2] * d), 1.0])
                        pts3[i] = [q[0], -q[2], q[1]]
        out.append({"name": p["name"], "des": des.astype(np.float32), "uv": uv, "xyz": pts3, "W": WIDTH, "H": H, "V": V, "P": P})
    return out


def vocabulary(*walks, k=200, per=150, seed=0):
    rng = np.random.default_rng(seed)
    sample = [f["des"][rng.choice(len(f["des"]), min(per, len(f["des"])), replace=False)] for w in walks for f in w]
    words, _ = kmeans2(np.concatenate(sample), k, minit="++", seed=seed)
    return cKDTree(words)


def bag(f, voc, k):
    _, idx = voc.query(f["des"])
    h = np.bincount(idx, minlength=k).astype(np.float64)
    return h


def fit4(a, b, iters=3000, tol=0.6, seed=0):
    """One turn and shift (and height) taking b (session plan + height) onto a (map + height), RANSAC two at a time."""
    rng = np.random.default_rng(seed)
    n = len(a)
    if n < 6:
        return None, 0
    best, best_in = None, None
    for _ in range(iters):
        i, j = rng.choice(n, 2, replace=False)
        va, vb = a[j, :2] - a[i, :2], b[j, :2] - b[i, :2]
        if np.linalg.norm(vb) < 1.0 or abs(np.linalg.norm(va) - np.linalg.norm(vb)) > 0.5:
            continue
        th = math.atan2(va[1], va[0]) - math.atan2(vb[1], vb[0])
        c, s = math.cos(th), math.sin(th)
        tx, ty = a[i, 0] - (c * b[i, 0] - s * b[i, 1]), a[i, 1] - (s * b[i, 0] + c * b[i, 1])
        inl = np.linalg.norm(place((th, tx, ty), b[:, :2]) - a[:, :2], axis=1) < tol
        if best_in is None or inl.sum() > best_in.sum():
            best, best_in = (th, tx, ty), inl
    if best is None or best_in.sum() < 4:
        return None, 0
    T = vs.fit_rigid([(b[k, :2], a[k, :2]) for k in np.nonzero(best_in)[0]])
    return T, int(best_in.sum())


def by_pictures(ref, w, TA, fref, fw):
    t0 = time.time()
    k = 200
    voc = vocabulary(fref, fw, k=k)
    BA = np.array([bag(f, voc, k) for f in fref]); BW = np.array([bag(f, voc, k) for f in fw])
    idf = np.log((len(BA) + len(BW)) / (1 + ((BA > 0).sum(0) + (BW > 0).sum(0))))
    BA, BW = BA * idf, BW * idf
    BA /= np.linalg.norm(BA, axis=1, keepdims=True) + 1e-9
    BW /= np.linalg.norm(BW, axis=1, keepdims=True) + 1e-9
    sim = BW @ BA.T
    bf = cv2.BFMatcher(cv2.NORM_L2)
    A3, W3, pairs_ok, poses = [], [], 0, []
    for i, f in enumerate(fw):
        for j in np.argsort(-sim[i])[:TOP]:
            g = fref[j]
            m = bf.knnMatch(f["des"], g["des"], k=2)
            good = [x[0] for x in m if len(x) == 2 and x[0].distance < 0.8 * x[1].distance]
            if len(good) < 20:
                continue
            p1 = np.float32([f["uv"][x.queryIdx] for x in good]); p2 = np.float32([g["uv"][x.trainIdx] for x in good])
            F, mask = cv2.findFundamentalMat(p1, p2, cv2.FM_RANSAC, 2.0, 0.99)
            if F is None or mask is None or mask.sum() < 15:
                continue
            pairs_ok += 1
            obj, img = [], []
            for x, keep in zip(good, mask.ravel()):
                if not keep:
                    continue
                pw, pa = f["xyz"][x.queryIdx], g["xyz"][x.trainIdx]
                if np.isfinite(pa).all():
                    # the reference's point on the map, and where this walk's picture sees it (run 218: depth on both
                    # sides at once left 0-13 pairs; the camera from 2D needs it on the reference's side only)
                    obj.append([*place(TA, pa[None, :2])[0], pa[2]])
                    img.append(f["uv"][x.queryIdx])
                    if np.isfinite(pw).all():
                        W3.append(pw)
                        A3.append(obj[-1])
            if len(obj) >= 8:
                T = camera_place(f, np.array(obj, np.float64), np.array(img, np.float64))
                if T is not None:
                    poses.append(T)
    a, b = np.array(A3), np.array(W3)
    T3, n3 = fit4(a, b) if len(a) >= 6 else (None, 0)
    ctr = np.mean([[g["V"][0, 3], -g["V"][2, 3]] for g in fw], 0) if fw else np.zeros(2)
    T, n = consensus(poses, ctr)
    if T is None and T3 is not None:
        T, n = T3, n3
    return T, {"picture pairs": pairs_ok, "cameras placed": len(poses), "agreeing cameras": n, "3D pairs": len(a), "s": round(time.time() - t0)}


def camera_place(f, obj, img):
    """This walk's picture placed on the map from the reference's points it sees (PnP, RANSAC), turned into the walk's
    turn and shift (the camera's place and heading on the map against its place and heading in the walk's own
    session). None when it does not hold."""
    W, H, P, V = f["W"], f["H"], f["P"], f["V"]
    K = np.array([[P[0, 0] * W / 2, 0, (1 - P[0, 2]) * W / 2], [0, P[1, 1] * H / 2, (1 + P[1, 2]) * H / 2], [0, 0, 1]])
    ok, rvec, tvec, inl = cv2.solvePnPRansac(obj, img, K, None, iterationsCount=300, reprojectionError=8.0,
                                             confidence=0.99, flags=cv2.SOLVEPNP_EPNP)
    if not ok or inl is None or len(inl) < 8:
        return None
    R, _ = cv2.Rodrigues(rvec)
    Cm = (-R.T @ tvec).ravel()                    # the camera on the map (east, north, up)
    fwd_m = R.T[:, 2]                             # the camera's forward (OpenCV +z) on the map
    if math.hypot(fwd_m[0], fwd_m[1]) < 0.3:
        return None                               # looking straight up or down: no heading
    Cs = V[:3, 3]                                 # the camera in the walk's session (x, y up, z)
    fwd_s = V[:3, :3] @ np.array([0.0, 0.0, -1.0])
    plan_c, plan_f = np.array([Cs[0], -Cs[2]]), np.array([fwd_s[0], -fwd_s[2]])
    th = math.atan2(fwd_m[1], fwd_m[0]) - math.atan2(plan_f[1], plan_f[0])
    c, s = math.cos(th), math.sin(th)
    return (th, Cm[0] - (c * plan_c[0] - s * plan_c[1]), Cm[1] - (s * plan_c[0] + c * plan_c[1]))


def consensus(poses, ctr, m=1.0, deg=4.0):
    """The turn and shift most of the placed cameras agree on: within deg degrees and m metres where they put the middle
    of the walk (ctr, in its session), averaged."""
    if len(poses) < 3:
        return None, len(poses)
    A = np.array(poses)
    at = np.array([place(T, ctr[None, :])[0] for T in A])
    best = None
    for i in range(len(A)):
        dth = np.abs(((A[:, 0] - A[i, 0] + math.pi) % (2 * math.pi)) - math.pi)
        near = (dth < math.radians(deg)) & (np.hypot(*(at - at[i]).T) < m)
        if best is None or near.sum() > best.sum():
            best = near
    if best.sum() < 3:
        return None, int(best.sum())
    S, P = A[best], at[best]
    th = math.atan2(np.sin(S[:, 0]).mean(), np.cos(S[:, 0]).mean())
    c, s = math.cos(th), math.sin(th)
    mid = P.mean(0)                                    # the middle of the walk where the agreeing cameras put it
    return (th, mid[0] - (c * ctr[0] - s * ctr[1]), mid[1] - (s * ctr[0] + c * ctr[1])), int(best.sum())


# --------------------------------------------------------------------- shapes
BUILT = {3, 8}             # label + 1: building, structure (fences, walls)


def labelled(w):
    C = w["cloud"]
    return len(C) and C.shape[1] > 6 and (C[:, 6] > 0).mean() > 0.3


def standing(w, built=False):
    C = w["cloud"]
    if not len(C):
        return np.zeros((0, 3)), np.zeros((0, 3))
    if built:
        C = C[np.isin(C[:, 6].astype(int), list(BUILT)) | (np.abs(C[:, 3] - C[:, 5]) < 0.15)]
    h = C[:, 3] - C[:, 5]
    ok = np.isfinite(h)
    C, h = C[ok], h[ok]
    P = np.stack([C[:, 2], -C[:, 4], C[:, 3]], 1)
    return P[(h >= STAND[0]) & (h <= STAND[1])], P[np.abs(h) < 0.15]


def grid(xy, x0, y0, nx, ny):
    g = np.zeros((ny, nx))
    c = np.floor((xy[:, 0] - x0) / CELL).astype(int); r = np.floor((xy[:, 1] - y0) / CELL).astype(int)
    ok = (c >= 0) & (r >= 0) & (c < nx) & (r < ny)
    np.add.at(g, (r[ok], c[ok]), 1.0)
    return np.log1p(g)


def thin(P, n, seed=0):
    if len(P) <= n:
        return P
    return P[np.random.default_rng(seed).choice(len(P), n, replace=False)]


def by_shapes(ref, w, TA, built=False):
    import small_gicp
    t0 = time.time()
    if built and not (labelled(ref) and labelled(w)):
        return None, {"why": "a walk without labels"}
    sa, ga = standing(ref, built)
    sw, gw = standing(w, built)
    if len(sa) < 500 or len(sw) < 500:
        return None, {"why": "too few standing points"}
    A = np.concatenate([place(TA, sa[:, :2]), sa[:, 2:]], 1)
    AG = np.concatenate([place(TA, ga[:, :2]), ga[:, 2:]], 1)
    tz0 = float(np.median(AG[:, 2]) - np.median(gw[:, 2])) if len(AG) and len(gw) else 0.0
    # the reference's plan, with room round it for the walk to fall anywhere
    lo, hi = A[:, :2].min(0) - 40, A[:, :2].max(0) + 40
    nx, ny = int((hi[0] - lo[0]) / CELL) + 1, int((hi[1] - lo[1]) / CELL) + 1
    GA = grid(A[:, :2], lo[0], lo[1], nx, ny)
    GA -= GA.mean()
    sw2 = thin(sw, 60000)
    cands = []
    for deg in range(0, 360, 2):
        th = math.radians(deg)
        Q = place((th, 0.0, 0.0), sw2[:, :2])
        qlo = Q.min(0)
        qn = (Q.max(0) - qlo) / CELL
        GW = grid(Q, qlo[0], qlo[1], int(qn[0]) + 1, int(qn[1]) + 1)
        GW -= GW.mean()
        corr = fftconvolve(GA, GW[::-1, ::-1], mode="full")
        r, c = np.unravel_index(int(np.argmax(corr)), corr.shape)
        # the walk's grid corner lands at A's cell (r - (GW rows - 1), c - (GW cols - 1))
        dy = lo[1] + (r - (GW.shape[0] - 1)) * CELL - qlo[1]
        dx = lo[0] + (c - (GW.shape[1] - 1)) * CELL - qlo[0]
        cands.append((float(corr[r, c]), th, dx, dy))
    cands.sort(key=lambda x: -x[0])
    picked = []
    for cnd in cands:
        if all(abs(((cnd[1] - p[1] + math.pi) % (2 * math.pi)) - math.pi) > math.radians(10) or math.hypot(cnd[2] - p[2], cnd[3] - p[3]) > 3 for p in picked):
            picked.append(cnd)
        if len(picked) == 8:
            break
    tgt = np.concatenate([thin(A, 80000), thin(AG, 40000)])
    src = np.concatenate([thin(sw, 60000), thin(gw, 30000)])
    tree = cKDTree(tgt)

    def landed(T):
        th, tx, ty, tz = T
        q = np.concatenate([place((th, tx, ty), src[:, :2]), src[:, 2:] + tz], 1)
        return float((tree.query(q, distance_upper_bound=LAND)[0] < LAND).mean())

    def gicp(T, rounds=5):
        for dist in (1.5, 0.8, 0.5, 0.4, 0.3)[:rounds]:
            th, tx, ty, tz = T
            q = np.concatenate([place((th, tx, ty), src[:, :2]), src[:, 2:] + tz], 1)
            r = small_gicp.align(tgt, q, registration_type="GICP", downsampling_resolution=0.2,
                                 max_correspondence_distance=dist, num_threads=os.cpu_count() or 2, max_iterations=20)
            M = r.T_target_source
            dth = math.atan2(M[1, 0], M[0, 0])
            c, s = math.cos(dth), math.sin(dth)
            T = (th + dth, c * tx - s * ty + M[0, 3], s * tx + c * ty + M[1, 3], tz + M[2, 3])
        return T

    best = None
    for score, th, dx, dy in picked:
        T = gicp((th, dx, dy, tz0))
        L = landed(T)
        if best is None or L > best[0]:
            best = (L, T, score)
    return best[1][:3], {"landed": round(best[0], 3), "turns tried": len(cands), "s": round(time.time() - t0)}


def main(dirs):
    walks = [load(d) for d in dirs]
    walks = [w for w in walks if len(w["cloud"]) and len(w["checks"]) >= 3]
    if len(walks) < 2:
        raise SystemExit("Walk fix: give two walks or more with three check marks each.")
    print(f"A walk placed by an earlier walk, by pictures and by shapes; {len(walks)} walks. Each placement is scored on "
          "the placed walk's own check marks, which neither method sees (median, and each).")
    feats = {}
    for w in walks:
        t0 = time.time()
        feats[w["name"]] = picture_points(w)
        lifted = sum(int(np.isfinite(f["xyz"]).all(1).sum()) for f in feats[w["name"]])
        print(f"  walk {w['name']}: {len(w['pics'])} pictures ({len(feats[w['name']])} with points), {lifted:,} picture points "
              f"with depth; {len(w['cloud']):,} depth points; {len(w['checks'])} check marks ({round(time.time() - t0)} s)")
    rows = []
    for ref in walks:
        TA = marks_fit(ref)
        if TA is None:
            continue
        for w in walks:
            if w is ref:
                continue
            if ref.get("map") and w.get("map") and ref["map"] != w["map"]:
                print(f"  {ref['name']} -> {w['name']}: different maps, left out")
                continue
            own = check_errs(w, marks_fit(w, use_refs=False))
            after = check_errs(w, w["placement"])
            Tp, ip = by_pictures(ref, w, TA, feats[ref["name"]], feats[w["name"]])
            Ts, is_ = by_shapes(ref, w, TA)
            Tb, ib = by_shapes(ref, w, TA, built=True)
            ep, es, eb = check_errs(w, Tp), check_errs(w, Ts), check_errs(w, Tb)
            fmt = lambda e: f"{med(e):.1f} ft ({', '.join(f'{x:.1f}' for x in e)})" if e else "no placement"
            print(f"  {w['name']} placed by {ref['name']}:")
            print(f"    pictures: {fmt(ep)}  [{', '.join(f'{k} {v}' for k, v in ip.items())}]")
            print(f"    shapes:   {fmt(es)}  [{', '.join(f'{k} {v}' for k, v in is_.items())}]")
            print(f"    shapes, buildings and structures only: {fmt(eb)}  [{', '.join(f'{k} {v}' for k, v in ib.items())}]")
            print(f"    its own marks' fit (the best possible): {fmt(own)}; after the walk, from the lidar: {fmt(after)}")
            rows.append((med(ep), med(es), med(eb), med(own), med(after)))
    if rows:
        R = np.array(rows, float)
        names = ("pictures", "shapes", "shapes (built only)", "own marks' fit", "after the walk")
        print("Over every pair, the median of the medians: " + "; ".join(
            f"{n} {np.nanmedian(R[:, i]):.1f} ft ({int(np.isfinite(R[:, i]).sum())} of {len(R)} placed)" for i, n in enumerate(names)))


if __name__ == "__main__":
    main(sys.argv[1:])
