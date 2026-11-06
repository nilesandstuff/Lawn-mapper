"""
CAN THE SKYLINE PLACE A WALK? (core session, 2026-11-06; the owner chose this of SCAN-H11's three: "Yea let's try
#1"). Run by workflow "S. Yard AR tool", task `skyline`, on a twin fetched WITH its pictures, after
scan/tools/skyline-prep.mjs; GitHub's free runner, CPU only.

SCAN-H13: ARCore held the walk of 2026-11-05 21:56 to about a foot over 1,106 ft. What is missing is ONE placement
on the map (a turn and a shift). This tries to find it from the pictures alone, with no phone depth:

  1. the sky in each picture (SegFormer-b0 trained on ADE20K, public, small; its "sky" class), and where it ends in
     each column: the skyline, as an elevation angle and a direction in the session (ARCore's pose and the
     picture's projection give every pixel's ray);
  2. the shade map's model as one surface (ground + the highest return per column), and from any spot on the map
     the skyline it would show in any direction (the highest elevation angle along that direction);
  3. every placement (turn every 2 degrees, shift every 1.5 m) scored on how well the model's skyline at each
     picture's spot matches the picture's own, all pictures at once (ARCore says where each was, relative to the
     others); the best few refined against the exact model.

Scored against the check points (their own fit is the truth, SCAN-H13), and the truth's own score and rank printed,
so a "no" says whether the signal is missing or the search missed it. NUMBERS ONLY in the log: errors and offsets,
no coordinates (the repository is public).

    python scan/tools/skyline_study.py twin
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

SEG_MODEL = "nvidia/segformer-b0-finetuned-ade-512-512"
MAX_PICS = int(os.environ.get("SKY_PICS", 90))
COLS = 24                 # columns sampled across each picture
SIGMA = math.radians(2.0) # how close a skyline must come to count
COARSE_M, COARSE_DEG = 1.5, 2.0
AZ_BINS = 180
TREE_SLACK = math.radians(float(os.environ.get("SKY_TREE_SLACK", 0)))  # degrees a tree top may stand above the model's
FT = 3.28084
LEAN = os.environ.get("SKY_LEAN") == "1"  # the placement step: the search alone, no studies


def load(d):
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    g = inp["grid"]
    surf = np.fromfile(os.path.join(d, "sky-surface.bin"), dtype="<f4").reshape(g["h"], g["w"])
    gr = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"])
    kp = os.path.join(d, "sky-kind.bin")
    kind = np.fromfile(kp, dtype=np.uint8).reshape(g["h"], g["w"]) if os.path.exists(kp) else None
    return inp, surf, gr, kind


class Surface:
    def __init__(self, g, surf, gr, kind=None, surround=None):
        self.g, self.s, self.gr = g, surf, gr
        # THE SURROUND (the shade map, 2026-11-06): ground and top 100 m out at 2 m cells, read where a ray leaves the lot
        self.sur = surround  # (grid, surface, ground) or None
        # the roofs alone (structures.js BUILDING 1), every tree as bare ground: what the picture can never see sky below
        self.sr = np.where(kind == 1, surf, gr).astype(np.float32) if kind is not None else surf
        self.e0, self.n1 = g["x0"], g["y1"]
        self.ce, self.cn = g["cell"], g["cellY"]
        self.e1 = self.e0 + g["w"] * self.ce
        self.n0 = self.n1 - g["h"] * self.cn
        gz = gr[np.isfinite(gr)]
        self.gmed = float(np.median(gz)) if gz.size else 0.0

    def idx(self, e, n):
        c = np.floor((e - self.e0) / self.ce).astype(np.int64)
        r = np.floor((self.n1 - n) / self.cn).astype(np.int64)
        ok = (c >= 0) & (r >= 0) & (c < self.g["w"]) & (r < self.g["h"])
        return np.where(ok, r, 0), np.where(ok, c, 0), ok

    def sidx(self, e, n):
        sg = self.sur[0]
        c = np.floor((e - sg["x0"]) / sg["cell"]).astype(np.int64)
        r = np.floor((sg["y1"] - n) / sg["cellY"]).astype(np.int64)
        ok = (c >= 0) & (r >= 0) & (c < sg["w"]) & (r < sg["h"])
        return np.where(ok, r, 0), np.where(ok, c, 0), ok

    def height(self, e, n, grid=None):
        a = self.s if grid is None else grid
        r, c, ok = self.idx(e, n)
        v = np.where(ok & np.isfinite(a[r, c]), a[r, c], np.nan)
        if self.sur is not None:
            sr, sc, sok = self.sidx(e, n)
            sa = self.sur[1] if grid is None or grid is self.s else self.sur[2]
            sv = sa[sr, sc]
            v = np.where(np.isnan(v) & sok & np.isfinite(sv), sv, v)
        return v

    def ground(self, e, n):
        v = self.height(e, n, self.gr)
        return np.where(np.isfinite(v), v, self.gmed)


RADII = np.geomspace(0.75, 220.0, 110)


def skyline_both(S, e, n, eye_abs, az):
    """The model's skyline from (e, n) at eye height eye_abs, looking along map azimuth az (atan2 of north, east):
    the highest elevation angle along that direction, with trees (A) and of the roofs alone (R). Same shapes in."""
    shp = np.shape(e)
    e, n, eye_abs, az = (np.ravel(x).astype(np.float64) for x in (e, n, eye_abs, az))
    A = np.full(e.shape, -np.pi / 2); R = np.full(e.shape, -np.pi / 2)
    step = max(1, 400000 // len(RADII))
    for i in range(0, len(e), step):
        sl = slice(i, i + step)
        pe = e[sl, None] + RADII[None, :] * np.cos(az[sl, None])
        pn = n[sl, None] + RADII[None, :] * np.sin(az[sl, None])
        for grid, out in ((S.s, A), (S.sr, R)):
            h = S.height(pe, pn, grid)
            if grid is S.sr and S.sur is not None:
                # the surround has no kinds: outside the lot its surface counts as roof-free ground for the lower bound
                r_, c_, ok_ = S.idx(pe, pn)
                h = np.where(ok_, h, S.height(pe, pn, S.gr))
            el = np.arctan2(h - eye_abs[sl, None], RADII[None, :])
            out[sl] = np.where(np.isfinite(el), el, -np.pi / 2).max(axis=1)
    return A.reshape(shp), np.minimum(R, A).reshape(shp)


def skyline_elev(S, e, n, eye_abs, az):
    return skyline_both(S, e, n, eye_abs, az)[0]


def sky_masks(d, pics):
    import torch
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
    torch.set_num_threads(os.cpu_count() or 2)
    proc = SegformerImageProcessor.from_pretrained(SEG_MODEL)
    model = SegformerForSemanticSegmentation.from_pretrained(SEG_MODEL).eval()
    sky_id = [int(k) for k, v in model.config.id2label.items() if v.lower() == "sky"][0]
    masks = []
    for p in pics:
        img = Image.open(os.path.join(d, p["name"])).convert("RGB")
        with torch.no_grad():
            logits = model(**proc(images=img, return_tensors="pt")).logits  # 1 x C x h/4 x w/4 of the 512 input
        lab = logits.argmax(1)[0].numpy()
        # back to the picture's aspect, at a quarter of its size
        mh, mw = max(8, img.height // 4), max(8, img.width // 4)
        m = np.asarray(Image.fromarray((lab == sky_id).astype(np.uint8) * 255).resize((mw, mh), Image.NEAREST)) > 127
        masks.append(m)
    return masks


def observations(pics, masks):
    """Per picture, the skyline in COLS columns: (picture, session azimuth, elevation, kind 0 = the sky ends here,
    1 = no sky at the top: the skyline is at least this high)."""
    obs = []
    for i, (p, m) in enumerate(zip(pics, masks)):
        V = np.asarray(p["view"], dtype=np.float64).reshape(4, 4).T  # camera -> session
        P = np.asarray(p["proj"], dtype=np.float64).reshape(4, 4).T
        Pi = np.linalg.inv(P)
        mh, mw = m.shape
        for jj in np.linspace(0.04, 0.96, COLS):
            j = min(mw - 1, int(jj * mw))
            col = m[:, j]
            if col[0]:
                nonsky = ~col
                run = np.convolve(nonsky.astype(int), np.ones(3, int), "valid") == 3
                hits = np.nonzero(run)[0]
                if not hits.size:
                    continue  # sky to the bottom: says little
                row, kind = hits[0], 0
            else:
                row, kind = 0, 1
            nx = 2 * (j + 0.5) / mw - 1
            ny = 1 - 2 * (row + 0.5) / mh
            a = Pi @ np.array([nx, ny, -1.0, 1.0]); a = a[:3] / a[3]
            b = Pi @ np.array([nx, ny, 1.0, 1.0]); b = b[:3] / b[3]
            dc = b - a
            dw = V[:3, :3] @ dc
            el = math.atan2(dw[1], math.hypot(dw[0], dw[2]))
            if kind == 1 and el < math.radians(1):
                continue  # the picture's top is below the horizon: any placement satisfies it
            az = math.atan2(-dw[2], dw[0])  # the session's level plane: u = x, v = -z
            obs.append((i, az, el, kind))
    return np.array(obs, dtype=np.float64).reshape(-1, 4)


def _phi(x):
    return 0.5 * (1 + np.tanh(0.7978845608 * (x + 0.044715 * x ** 3)))


def score_from(A, R, el, kind):
    """THE BAND (2026-11-06, the second round): the picture's skyline can be no lower than the roofs' (R: sky is
    never seen through a roof) and no higher than the model's tallest (A); November's bare crowns let sky through
    anywhere between. A skyline inside a narrow band (a roof edge, open sky) says much; inside a wide one (under a
    crown) little. Log-likelihood of a band uniform from R to A blurred by SIGMA, with a floor for what the model
    cannot know (things off its edge, grown since the flight, a sky misread). 'At least this high' samples: the
    share of the band above them."""
    lo = R
    hi = np.maximum(A, R)
    # LEAF-OFF SLACK (the owner, 2026-11-06: "tree canopies from leaf off flights are generally read by the lidar as
    # being shorter than they really are"): where a tree makes the top of the band, allow it TREE_SLACK higher
    hi = np.where(A > R + 1e-6, hi + TREE_SLACK, hi)
    p = (_phi((el - lo) / SIGMA + 1.25) - _phi((el - hi) / SIGMA - 1.25)) / (hi - lo + 2.5 * SIGMA)
    exact = np.log(p + 0.3)
    up = np.clip((hi + SIGMA - el) / (hi - lo + 2 * SIGMA), 0, 1)
    lower = 0.5 * np.log(up + 0.05)
    return np.where(kind == 0, exact, lower)


def exact_score(S, cams, eyes, obs, theta, tx, ty, daz=0.0, delv=0.0):
    """The score of one placement against the exact model: each picture's spot on the map, its own eye height.
    daz, delv: a turn and a tilt added to every picture's rays (the camera's aim against ARCore's pose)."""
    if daz or delv:
        obs = obs.copy(); obs[:, 1] += daz; obs[:, 2] += delv
    c, s = math.cos(theta), math.sin(theta)
    pi = obs[:, 0].astype(int)
    u, v = cams[pi, 0], cams[pi, 1]
    e, n = c * u - s * v + tx, s * u + c * v + ty
    eye = S.ground(e, n) + eyes[pi]
    A, R = skyline_both(S, e, n, eye, obs[:, 1] + theta)
    return float(score_from(A, R, obs[:, 2], obs[:, 3]).sum()), (A, R)


def diagnose(S, cams, eyes, obs, T, pred):
    """Where the pictures' skyline and the model's part, at the truth: which way, and why it might."""
    ex = obs[:, 3] == 0
    d = np.degrees(obs[ex, 2] - pred[ex])  # + : the picture's skyline is higher than the model's
    th, tx, ty = T; c, s = math.cos(th), math.sin(th)
    pi = obs[ex, 0].astype(int)
    e = c * cams[pi, 0] - s * cams[pi, 1] + tx; n = s * cams[pi, 0] + c * cams[pi, 1] + ty
    az = obs[ex, 1] + th
    # how far each ray runs before it leaves the model, and how far away the thing that makes the model's skyline is
    pe = e[:, None] + RADII[None, :] * np.cos(az[:, None]); pn = n[:, None] + RADII[None, :] * np.sin(az[:, None])
    _, _, ok = S.idx(pe, pn)
    edge = np.where(ok.all(1), RADII[-1], RADII[np.argmin(ok, axis=1)])
    h = S.height(pe, pn); eye = S.ground(e, n) + eyes[pi]
    el = np.where(np.isfinite(h), np.arctan2(h - eye[:, None], RADII[None, :]), -9)
    near = RADII[np.argmax(el, axis=1)]
    q = np.percentile(d, [25, 50, 75])
    print(f"  the picture's skyline minus the model's: quartiles {q[0]:+.1f} / {q[1]:+.1f} / {q[2]:+.1f} deg; higher by 3+ deg {np.mean(d > 3):.0%}, lower by 3+ {np.mean(d < -3):.0%}")
    short = edge < 100
    if short.any():
        print(f"  rays leaving the model within 100 m: {short.mean():.0%} of samples, median difference there {np.median(d[short]):+.1f} deg (elsewhere {np.median(d[~short]) if (~short).any() else float('nan'):+.1f})")
    for lo, hi in ((0, 15), (15, 40), (40, 300)):
        sel = (near >= lo) & (near < hi)
        if sel.sum() >= 10:
            print(f"  model's skyline made {lo}-{hi} m away: {sel.sum()} samples, median |difference| {np.median(np.abs(d[sel])):.1f} deg, signed {np.median(d[sel]):+.1f}")


def fit_rigid(pairs):
    a = np.array([p[0] for p in pairs], float); b = np.array([p[1] for p in pairs], float)
    am, bm = a.mean(0), b.mean(0); A, B = a - am, b - bm
    sxx = (A * B).sum(); sxy = (A[:, 0] * B[:, 1] - A[:, 1] * B[:, 0]).sum()
    th = math.atan2(sxy, sxx); c, s = math.cos(th), math.sin(th)
    return th, bm[0] - (c * am[0] - s * am[1]), bm[1] - (s * am[0] + c * am[1])


def place(T, uv):
    th, tx, ty = T; c, s = math.cos(th), math.sin(th)
    return c * uv[0] - s * uv[1] + tx, s * uv[0] + c * uv[1] + ty


def check_errs(T, checks):
    return [math.hypot(*(np.subtract(place(T, c["ar"]), c["map"]))) for c in checks]


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp, surf, gr, kind = load(d)
    surround = None
    if inp.get("surround") and os.path.exists(os.path.join(d, "sky-surround-surface.bin")):
        sg = inp["surround"]
        ss = np.fromfile(os.path.join(d, "sky-surround-surface.bin"), dtype="<f4").reshape(sg["h"], sg["w"])
        sgr = np.fromfile(os.path.join(d, "sky-surround-ground.bin"), dtype="<f4").reshape(sg["h"], sg["w"])
        surround = (sg, ss, sgr)
        print(f"Surround in use: {sg['w']} x {sg['h']} cells of {sg['cell']:.1f} m.")
    S = Surface(inp["grid"], surf, gr, kind, surround)
    pics = [p for p in inp["pictures"] if p.get("eye") is not None and 0.5 < p["eye"] < 2.5]
    if len(pics) > MAX_PICS:
        pics = [pics[int(i)] for i in np.linspace(0, len(pics) - 1, MAX_PICS)]
    print(f"Pictures used: {len(pics)} of {len(inp['pictures'])}; model {S.e1 - S.e0:.0f} x {S.n1 - S.n0:.0f} m.")
    if len(pics) < 5:
        print("Too few pictures with the phone's height known."); return
    masks = sky_masks(d, pics)
    withsky = sum(1 for m in masks if m[: max(1, m.shape[0] // 6)].mean() > 0.2)
    obs = observations(pics, masks)
    if not len(obs):
        print("No skyline found in any picture."); return
    print(f"Sky found: {withsky} of {len(pics)} pictures show sky in their top sixth; {int((obs[:, 3] == 0).sum())} skyline samples, {int((obs[:, 3] == 1).sum())} 'at least this high'. ({int(time.time() - t0)} s)")
    # THE PHONE'S CALIBRATION (2026-11-06): a turn and tilt added to every ray, measured on another walk's check
    # points (the camera's aim against ARCore's pose: about 3 degrees of tilt on the S21)
    cal = [float(x) for x in (os.environ.get("SKY_CAL") or "0,0").split(",")[:2]] + [0.0, 0.0]
    cal_az, cal_el = cal[0], cal[1]
    if cal_az or cal_el:
        obs[:, 1] += math.radians(cal_az); obs[:, 2] += math.radians(cal_el)
        print(f"Calibration applied: rays turned {cal_az:+.2f} deg, tilted {cal_el:+.2f} deg.")
    lag_ms = float(os.environ.get("SKY_LAG", 0) or 0)
    if lag_ms:
        rates_ = np.array([p.get("yawRate") or 0.0 for p in pics])
        obs[:, 1] -= np.radians(rates_[obs[:, 0].astype(int)]) * (lag_ms / 1000)
        print(f"Picture lag applied: {lag_ms:+.0f} ms of each picture's turn rate.")
    cams = np.array([[np.asarray(p["view"])[12], -np.asarray(p["view"])[14]] for p in pics])
    eyes = np.array([p["eye"] for p in pics])
    eye_med = float(np.median(eyes))

    # THE TRUTH (SCAN-H13): the check points' own fit
    checks = inp.get("checks") or []
    uniq = list({c["id"]: c for c in checks}.values())
    truth = fit_rigid([(c["ar"], c["map"]) for c in uniq]) if len(uniq) >= 2 else None
    refsT = None
    refs = list({r["id"]: r for r in inp.get("refs") or []}.values())
    if len(refs) >= 2:
        refsT = fit_rigid([(r["ar"], r["map"]) for r in refs])
    if truth and refsT:
        d_rt = math.degrees((refsT[0] - truth[0] + np.pi) % (2 * np.pi) - np.pi)
        print(f"The references' placement against the check points' own: {d_rt:+.2f} deg turned, checks median {np.median(check_errs(refsT, uniq)) * FT:.1f} ft by the references (their own fit {np.median(check_errs(truth, uniq)) * FT:.1f} ft).")
        if os.environ.get("SKY_TRUTH") == "refs":
            truth = refsT
            print("Truth for this run: the references' placement.")
    if truth:
        sc, (A, R) = exact_score(S, cams, eyes, obs, *truth)
        ex = obs[:, 3] == 0
        el, a, r = obs[ex, 2], A[ex], R[ex]
        tol = math.radians(2)
        below, above = el < r - tol, el > a + tol
        narrow = (a - r) < math.radians(3)
        print(f"At the check points' own placement: score {sc:.1f}. Skyline samples between the roofs' and the model's tallest (2 deg slack): {np.mean(~below & ~above):.0%}; below a roof {np.mean(below):.0%}; above everything {np.mean(above):.0%}. Where the band is narrow (under 3 deg: roof edges, open sky): {narrow.sum()} samples, {np.mean(~below[narrow] & ~above[narrow]) if narrow.any() else float('nan'):.0%} inside.")
        diagnose(S, cams, eyes, obs, truth, A)
        if os.environ.get("SKY_NARROW") == "1":
            keepn = ((np.maximum(A, R) - R) < math.radians(3)) & (obs[:, 3] == 0)
            obs = obs[keepn]
            print(f"Narrow-band samples alone from here: {len(obs)} (roof edges, open sky, judged at the truth).")
        if not LEAN:
            # THE CAMERA'S AIM (2026-11-06: on two walks the best placement sat 5.1 and 5.3 degrees turned from the truth,
            # the same way): at the truth, the turn and tilt of every picture's rays that the skyline likes best
            cal = [(exact_score(S, cams, eyes, obs, *truth, daz=math.radians(a), delv=math.radians(b))[0], a, b)
                   for a in np.arange(-10, 10.01, 1.0) for b in np.arange(-3, 3.01, 1.0)]
            c0 = max(cal)
            cal2 = [(exact_score(S, cams, eyes, obs, *truth, daz=math.radians(a), delv=math.radians(b))[0], a, b)
                    for a in np.arange(c0[1] - 1, c0[1] + 1.01, 0.25) for b in np.arange(c0[2] - 1, c0[2] + 1.01, 0.25)]
            c1 = max(cal2)
            print(f"  the camera's aim at the truth: the skyline fits best with the rays turned {c1[1]:+.2f} deg and tilted {c1[2]:+.2f} deg (score {c1[0]:.1f}, against {sc:.1f} as recorded)")
            # THE PICTURE'S LAG (2026-11-06): if the picture is a frame or two older than its pose, each ray is turned by
            # the phone's turn rate then x the lag. At the truth, which lag the skyline likes; applied when SKY_LAG says so.
            rates = np.array([p.get("yawRate") or 0.0 for p in pics])
            pi_all = obs[:, 0].astype(int)
            lags = []
            for lag_ms in range(-150, 301, 25):
                o2 = obs.copy(); o2[:, 1] -= np.radians(rates[pi_all]) * (lag_ms / 1000)
                lags.append((exact_score(S, cams, eyes, o2, *truth)[0], lag_ms))
            bl = max(lags)
            turning = np.mean(np.abs(rates) > 10)
            print(f"  the picture's lag behind its pose, at the truth: best {bl[1]:+d} ms (score {bl[0]:.1f}; 0 ms {dict((l, s_) for s_, l in lags)[0]:.1f}); {turning:.0%} of pictures taken turning faster than 10 deg/s, median |rate| {np.median(np.abs(rates)):.1f} deg/s")

    # COARSE: the model's skyline from every lattice spot, every 2 degrees, at the median eye height
    m = COARSE_M
    ge = np.arange(S.e0 + 5, S.e1 - 5, m); gn = np.arange(S.n0 + 5, S.n1 - 5, m)
    EE, NN = np.meshgrid(ge, gn)
    azs = np.linspace(-np.pi, np.pi, AZ_BINS, endpoint=False)
    prof = np.empty((len(gn), len(ge), AZ_BINS), np.float32)
    profR = np.empty((len(gn), len(ge), AZ_BINS), np.float32)
    eye_grid = S.ground(EE, NN) + eye_med
    for a_i, az in enumerate(azs):
        prof[:, :, a_i], profR[:, :, a_i] = skyline_both(S, EE, NN, eye_grid, np.full(EE.shape, az))
    print(f"Coarse skylines: {len(ge)} x {len(gn)} spots x {AZ_BINS} directions ({int(time.time() - t0)} s).")
    pi = obs[:, 0].astype(int)
    by_pic = [np.nonzero(pi == i)[0] for i in range(len(pics))]
    best = []
    for th in np.radians(np.arange(0, 360, COARSE_DEG)):
        c, s = math.cos(th), math.sin(th)
        q = np.stack([c * cams[:, 0] - s * cams[:, 1], s * cams[:, 0] + c * cams[:, 1]], 1)
        # shifts that keep every picture's spot on the lattice
        lo_e, hi_e = ge[0] - q[:, 0].min(), ge[-1] - q[:, 0].max()
        lo_n, hi_n = gn[0] - q[:, 1].min(), gn[-1] - q[:, 1].max()
        if hi_e < lo_e or hi_n < lo_n:
            continue
        te = np.arange(lo_e, hi_e + 1e-9, m); tn = np.arange(lo_n, hi_n + 1e-9, m)
        acc = np.zeros((len(tn), len(te)), np.float32)
        cnt = np.zeros((len(tn), len(te)), np.int32)  # a shift scored on fewer pictures (the lattice's edge) is not a shift
        for i, oi in enumerate(by_pic):
            if not len(oi):
                continue
            bx = max(0, int(round((q[i, 0] + te[0] - ge[0]) / m))); bn = max(0, int(round((q[i, 1] + tn[0] - gn[0]) / m)))
            bins = np.round(((obs[oi, 1] + th + np.pi) % (2 * np.pi)) / (2 * np.pi) * AZ_BINS).astype(int) % AZ_BINS
            sl = prof[bn:bn + len(tn), bx:bx + len(te)][:, :, bins][: acc.shape[0], : acc.shape[1]]
            slr = profR[bn:bn + len(tn), bx:bx + len(te)][:, :, bins][: acc.shape[0], : acc.shape[1]]
            acc[: sl.shape[0], : sl.shape[1]] += score_from(sl, slr, obs[oi, 2][None, None, :], obs[oi, 3][None, None, :]).sum(2)
            cnt[: sl.shape[0], : sl.shape[1]] += 1
        acc[cnt < sum(1 for oi in by_pic if len(oi))] = -1e9
        k = np.argsort(acc, axis=None)[-6:]
        for f in k:
            r_, c_ = np.unravel_index(f, acc.shape)
            best.append((float(acc[r_, c_]), th, te[c_], tn[r_]))
    best.sort(key=lambda x: -x[0])
    # the distinct best few (3 m or 10 degrees apart)
    picks = []
    for b in best:
        if all(math.hypot(b[2] - p[2], b[3] - p[3]) > 3 or abs((b[1] - p[1] + np.pi) % (2 * np.pi) - np.pi) > math.radians(10) for p in picks):
            picks.append(b)
        if len(picks) >= 6:
            break
    if truth:
        tsc0 = exact_score(S, cams, eyes, obs, *truth)[0]
        ahead = sum(1 for b in best if b[0] > tsc0)
        print(f"Coarse search: {len(best)} kept; {ahead} score above the truth's exact score.")

    # REFINE the best few against the exact model
    out = []
    for b in picks[:5]:
        T = (b[1], b[2], b[3]); sc = exact_score(S, cams, eyes, obs, *T)[0]
        for dd, mm in ((1.0, 0.5), (0.25, 0.2)):
            cands = [(T[0] + math.radians(a), T[1] + x, T[2] + y) for a in (-2 * dd, -dd, 0, dd, 2 * dd) for x in np.arange(-3, 3.01, 1) * mm for y in np.arange(-3, 3.01, 1) * mm]
            scs = [exact_score(S, cams, eyes, obs, *C)[0] for C in cands]
            j = int(np.argmax(scs))
            if scs[j] > sc:
                sc, T = scs[j], cands[j]
        out.append((sc, T))
    out.sort(key=lambda x: -x[0])
    print(f"Refined ({int(time.time() - t0)} s). The best placements, against the check points:")
    for rank, (sc, T) in enumerate(out, 1):
        line = f"  {rank}. score {sc:.1f}"
        if truth:
            errs = check_errs(T, uniq)
            dth = math.degrees((T[0] - truth[0] + np.pi) % (2 * np.pi) - np.pi)
            line += f"; checks {', '.join(f'{x * FT:.1f}' for x in errs)} ft (median {np.median(errs) * FT:.1f}); {dth:+.1f} deg from the truth"
        print(line)
    if truth and not LEAN:
        # WHO PREFERS THE TWIST: the same two placements scored on the narrow-band samples alone (roof edges, open
        # sky) and on the wide-band ones (under crowns, the model's edge)
        def split(T):
            sc_, (A, R) = exact_score(S, cams, eyes, obs, *T)
            band = np.maximum(A, R) - R
            narrow = (band < math.radians(3)) & (obs[:, 3] == 0)
            wide = (~narrow) & (obs[:, 3] == 0)
            v = score_from(A, R, obs[:, 2], obs[:, 3])
            return float(v[narrow].sum()), int(narrow.sum()), float(v[wide].sum()), int(wide.sum())
        tn_, nn_, tw_, nw_ = split(truth); bn_, _, bw_, _ = split(out[0][1])
        print(f"Narrow-band samples ({nn_}: roof edges, open sky): truth {tn_:.1f}, best found {bn_:.1f}. Wide-band ({nw_}: under crowns, the edge): truth {tw_:.1f}, best found {bw_:.1f}.")
        # HALVES (the owner, 2026-11-06: ARCore's "occasional little shifts... maybe each discrete arcore alignment
        # needs its own fit"): the first and second half of the pictures, each refined from the best found
        odo_mid = float(np.median([p["odo"] for p in pics]))
        for name, keep in (("first half", np.array([pics[int(i)]["odo"] <= odo_mid for i in obs[:, 0]])), ("second half", np.array([pics[int(i)]["odo"] > odo_mid for i in obs[:, 0]]))):
            o2 = obs[keep]
            if len(o2) < 40:
                continue
            T = out[0][1]; sc = exact_score(S, cams, eyes, o2, *T)[0]
            for dd, mm in ((1.0, 0.5), (0.25, 0.2)):
                cands = [(T[0] + math.radians(a), T[1] + x, T[2] + y) for a in (-3 * dd, -2 * dd, -dd, 0, dd, 2 * dd, 3 * dd) for x in np.arange(-3, 3.01, 1) * mm for y in np.arange(-3, 3.01, 1) * mm]
                scs = [exact_score(S, cams, eyes, o2, *C)[0] for C in cands]
                j = int(np.argmax(scs))
                if scs[j] > sc:
                    sc, T = scs[j], cands[j]
            cks = [c for c in uniq if (c.get("odo") is not None and ((c["odo"] <= odo_mid) == (name == "first half")))] or uniq
            errs = check_errs(T, cks)
            print(f"  {name} alone ({int(keep.sum())} samples): {math.degrees((T[0] - truth[0] + np.pi) % (2 * np.pi) - np.pi):+.1f} deg from the truth, its own checks {', '.join(f'{x * FT:.1f}' for x in errs)} ft")
        tsc = exact_score(S, cams, eyes, obs, *truth)[0]
        good = np.median(check_errs(out[0][1], uniq)) * FT < 1.5
        verdict = ('the best placement IS the truth (within 1.5 ft): the skyline can place this walk' if good else
                   'the truth scores higher than anything found: the signal is there, the search missed it' if tsc > out[0][0] else
                   'the skyline scores another placement at least as high as the truth: on this walk it cannot place it')
        print(f"The truth's own score: {tsc:.1f} (best found {out[0][0]:.1f}): {verdict}.")
        if refsT:
            print(f"  (the references' own placement: checks median {np.median(check_errs(refsT, uniq)) * FT:.1f} ft)")
    # how sure: the best placement more than 2 m away (at the walk's middle) or 5 degrees off
    mid = cams.mean(0)
    far = [o for o in out[1:] if math.hypot(*np.subtract(place(o[1], mid), place(out[0][1], mid))) > 2 or abs(math.degrees((o[1][0] - out[0][1][0] + np.pi) % (2 * np.pi) - np.pi)) > 5]
    if far:
        print(f"The best different placement scores {out[0][0] - far[0][0]:.1f} below the best (log-likelihood over {len(obs)} samples; higher is surer, under ~10 is a toss-up).")
    if not LEAN:
        # STEP 3 (the owner, 2026-11-06: "maybe each discrete arcore alignment needs its own fit"): windows of WINDOW_M of
        # walking every STEP_M, each refined from the best whole-walk placement on its own pictures, kept when it holds
        # enough samples and sits within 3 m and 6 degrees of its neighbours' mean; each check scored by the window
        # nearest it, else by the whole-walk placement.
        WINDOW_M, STEP_M = 60.0, 20.0
        odos = np.array([p["odo"] for p in pics]); o_pi = odos[obs[:, 0].astype(int)]
        T0 = out[0][1]; wins = []
        for c0 in np.arange(odos.min(), odos.max() + 1e-6, STEP_M):
            keep = (o_pi >= c0 - WINDOW_M / 2) & (o_pi < c0 + WINDOW_M / 2)
            o2 = obs[keep]
            if len(o2) < 60:
                continue
            T = T0; sc = exact_score(S, cams, eyes, o2, *T)[0]
            for dd, mm in ((1.0, 0.5), (0.25, 0.2)):
                cands = [(T[0] + math.radians(a), T[1] + x, T[2] + y) for a in (-3 * dd, -2 * dd, -dd, 0, dd, 2 * dd, 3 * dd) for x in np.arange(-3, 3.01, 1) * mm for y in np.arange(-3, 3.01, 1) * mm]
                scs = [exact_score(S, cams, eyes, o2, *C)[0] for C in cands]
                j = int(np.argmax(scs))
                if scs[j] > sc:
                    sc, T = scs[j], cands[j]
            wins.append({"odo": float(c0), "T": T, "n": int(keep.sum()), "score": sc})
        mid = cams.mean(0)
        for w_ in wins:
            others = [o for o in wins if o is not w_ and abs(o["odo"] - w_["odo"]) <= STEP_M * 1.01]
            if not others:
                w_["kept"] = True; continue
            dth = np.mean([math.degrees((o["T"][0] - w_["T"][0] + np.pi) % (2 * np.pi) - np.pi) for o in others])
            dpos = np.mean([math.hypot(*np.subtract(place(o["T"], mid), place(w_["T"], mid))) for o in others])
            w_["kept"] = abs(dth) <= 6 and dpos <= 3
        kept = [w_ for w_ in wins if w_["kept"]]
        def place_at(odo):
            if not kept:
                return T0
            w_ = min(kept, key=lambda w__: abs(w__["odo"] - odo))
            return w_["T"] if abs(w_["odo"] - odo) <= WINDOW_M / 2 else T0
        print(f"Windows of {WINDOW_M:.0f} m every {STEP_M:.0f} m: {len(wins)} fitted, {len(kept)} kept (agreeing with their neighbours within 3 m and 6 degrees).")
        if truth and uniq:
            errs_w = [math.hypot(*np.subtract(place(place_at(c.get("odo") or 0), c["ar"]), c["map"])) for c in uniq]
            errs_g = check_errs(T0, uniq)
            turns = [math.degrees((w_["T"][0] - truth[0] + np.pi) % (2 * np.pi) - np.pi) for w_ in kept]
            print(f"  checks by their window: {', '.join(f'{x * FT:.1f}' for x in errs_w)} ft (median {np.median(errs_w) * FT:.1f}); by the one placement {np.median(errs_g) * FT:.1f} ft; the kept windows' turn from the truth {', '.join(f'{t:+.1f}' for t in turns)} deg")
        # HEADING DRIFT (2026-11-06: the windows' twist grew from -0.1 to -6.3 degrees along the 22:02 walk, about a degree
        # a minute): one placement whose heading turns steadily with the distance walked, theta(odo) = theta0 + k * odo,
        # the position carried along. k searched, the rest re-refined; each check scored at its own odo.
        def drift_score(T, k_):
            th0, tx, ty = T; sc = 0.0
            # pictures grouped by odo so each gets its own turn about the walk's middle
            for i0 in range(0, len(obs), 400):
                o2 = obs[i0:i0 + 400]
                pi2 = o2[:, 0].astype(int); dth = k_ * (odos[pi2] - odo_ref)
                # rotate each picture's camera about the reference point by its own dth
                c_, s_ = np.cos(dth), np.sin(dth)
                u, v = cams[pi2, 0] - cam_ref[0], cams[pi2, 1] - cam_ref[1]
                u2, v2 = c_ * u - s_ * v + cam_ref[0], s_ * u + c_ * v + cam_ref[1]
                th = th0; c0, s0 = math.cos(th), math.sin(th)
                e, n = c0 * u2 - s0 * v2 + tx, s0 * u2 + c0 * v2 + ty
                eye = S.ground(e, n) + eyes[pi2]
                A, R = skyline_both(S, e, n, eye, o2[:, 1] + th + dth)
                sc += float(score_from(A, R, o2[:, 2], o2[:, 3]).sum())
            return sc
        odo_ref = float(np.median(odos)); i_ref = int(np.argmin(np.abs(odos - odo_ref))); cam_ref = cams[i_ref]
        def drift_place(T, k_, odo, uv):
            dth = k_ * (odo - odo_ref); c_, s_ = math.cos(dth), math.sin(dth)
            u, v = uv[0] - cam_ref[0], uv[1] - cam_ref[1]
            return place(T, (c_ * u - s_ * v + cam_ref[0], s_ * u + c_ * v + cam_ref[1]))
        ks = np.radians(np.arange(-0.10, 0.101, 0.01))  # degrees per metre walked
        best_k = max(((drift_score(T0, k_), k_) for k_ in ks), key=lambda x: x[0])
        Tk, kk, sck = T0, best_k[1], best_k[0]
        for dd, mm in ((1.0, 0.5), (0.25, 0.2)):
            cands = [(Tk[0] + math.radians(a), Tk[1] + x, Tk[2] + y) for a in (-2 * dd, -dd, 0, dd, 2 * dd) for x in np.arange(-2, 2.01, 1) * mm for y in np.arange(-2, 2.01, 1) * mm]
            scs = [drift_score(C, kk) for C in cands]; j = int(np.argmax(scs))
            if scs[j] > sck:
                sck, Tk = scs[j], cands[j]
        print(f"Heading drift: best {math.degrees(kk):+.3f} deg per metre walked ({math.degrees(kk) * 60:+.1f} deg per 60 m); score {sck:.1f} against {out[0][0]:.1f} with none.")
        if truth and uniq:
            errs_k = [math.hypot(*np.subtract(drift_place(Tk, kk, c.get("odo") or 0, c["ar"]), c["map"])) for c in uniq]
            print(f"  checks with the drift: {', '.join(f'{x * FT:.1f}' for x in errs_k)} ft (median {np.median(errs_k) * FT:.1f}); heading at the walk's middle {math.degrees((Tk[0] - truth[0] + np.pi) % (2 * np.pi) - np.pi):+.1f} deg from the truth")
    if LEAN:
        wins = []
    f_ = float
    json.dump({"placements": [{"score": f_(s), "theta": f_(T[0]), "tx": f_(T[1]), "ty": f_(T[2])} for s, T in out], "windows": [{"odo": f_(w_["odo"]), "theta": f_(w_["T"][0]), "tx": f_(w_["T"][1]), "ty": f_(w_["T"][2]), "n": int(w_["n"]), "kept": bool(w_["kept"])} for w_ in wins]}, open(os.path.join(d, "skyline.json"), "w"))
    print(f"Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
