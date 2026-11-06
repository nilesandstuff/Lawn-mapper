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
FT = 3.28084


def load(d):
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    g = inp["grid"]
    surf = np.fromfile(os.path.join(d, "sky-surface.bin"), dtype="<f4").reshape(g["h"], g["w"])
    gr = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"])
    return inp, surf, gr


class Surface:
    def __init__(self, g, surf, gr):
        self.g, self.s, self.gr = g, surf, gr
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

    def height(self, e, n, grid=None):
        a = self.s if grid is None else grid
        r, c, ok = self.idx(e, n)
        v = a[r, c]
        return np.where(ok & np.isfinite(v), v, np.nan)

    def ground(self, e, n):
        v = self.height(e, n, self.gr)
        return np.where(np.isfinite(v), v, self.gmed)


RADII = np.geomspace(0.75, 220.0, 110)


def skyline_elev(S, e, n, eye_abs, az):
    """The model's skyline from (e, n) at eye height eye_abs, looking along map azimuth az (atan2 of north, east):
    the highest elevation angle along that direction. All arrays the same shape (flattened inside)."""
    shp = np.shape(e)
    e, n, eye_abs, az = (np.ravel(x).astype(np.float64) for x in (e, n, eye_abs, az))
    out = np.full(e.shape, -np.pi / 2)
    step = max(1, 400000 // len(RADII))
    for i in range(0, len(e), step):
        sl = slice(i, i + step)
        pe = e[sl, None] + RADII[None, :] * np.cos(az[sl, None])
        pn = n[sl, None] + RADII[None, :] * np.sin(az[sl, None])
        h = S.height(pe, pn)
        el = np.arctan2(h - eye_abs[sl, None], RADII[None, :])
        el = np.where(np.isfinite(el), el, -np.pi / 2)
        out[sl] = el.max(axis=1)
    return out.reshape(shp)


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


def score_from(pred, el, kind):
    d = pred - el
    exact = np.exp(-(d / SIGMA) ** 2)
    lower = np.where(d >= -math.radians(1), 1.0, np.exp(-((d + math.radians(1)) / SIGMA) ** 2))
    return np.where(kind == 0, exact, 0.5 * lower)


def exact_score(S, cams, eyes, obs, theta, tx, ty):
    """The score of one placement against the exact model: each picture's spot on the map, its own eye height."""
    c, s = math.cos(theta), math.sin(theta)
    pi = obs[:, 0].astype(int)
    u, v = cams[pi, 0], cams[pi, 1]
    e, n = c * u - s * v + tx, s * u + c * v + ty
    eye = S.ground(e, n) + eyes[pi]
    pred = skyline_elev(S, e, n, eye, obs[:, 1] + theta)
    return float(score_from(pred, obs[:, 2], obs[:, 3]).sum()), pred


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
    inp, surf, gr = load(d)
    S = Surface(inp["grid"], surf, gr)
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
    if truth:
        sc, pred = exact_score(S, cams, eyes, obs, *truth)
        ex = obs[:, 3] == 0
        res = np.degrees(np.abs(pred[ex] - obs[ex, 2]))
        print(f"At the check points' own placement: score {sc:.1f} of {len(obs)}; the skyline samples sit a median {np.median(res):.1f} deg from the model's ({np.mean(res < 2):.0%} within 2 deg, {np.mean(res < 5):.0%} within 5).")

    # COARSE: the model's skyline from every lattice spot, every 2 degrees, at the median eye height
    m = COARSE_M
    ge = np.arange(S.e0 + 5, S.e1 - 5, m); gn = np.arange(S.n0 + 5, S.n1 - 5, m)
    EE, NN = np.meshgrid(ge, gn)
    azs = np.linspace(-np.pi, np.pi, AZ_BINS, endpoint=False)
    prof = np.empty((len(gn), len(ge), AZ_BINS), np.float32)
    eye_grid = S.ground(EE, NN) + eye_med
    for a_i, az in enumerate(azs):
        prof[:, :, a_i] = skyline_elev(S, EE, NN, eye_grid, np.full(EE.shape, az))
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
        for i, oi in enumerate(by_pic):
            if not len(oi):
                continue
            bx = max(0, int(round((q[i, 0] + te[0] - ge[0]) / m))); bn = max(0, int(round((q[i, 1] + tn[0] - gn[0]) / m)))
            bins = np.round(((obs[oi, 1] + th + np.pi) % (2 * np.pi)) / (2 * np.pi) * AZ_BINS).astype(int) % AZ_BINS
            sl = prof[bn:bn + len(tn), bx:bx + len(te)][:, :, bins]
            sl = sl[: acc.shape[0], : acc.shape[1]]
            acc[: sl.shape[0], : sl.shape[1]] += score_from(sl, obs[oi, 2][None, None, :], obs[oi, 3][None, None, :]).sum(2)
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
    if truth:
        tsc = exact_score(S, cams, eyes, obs, *truth)[0]
        good = np.median(check_errs(out[0][1], uniq)) < 1.5
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
        print(f"The best different placement scores {far[0][0] / max(out[0][0], 1e-9):.0%} of the best (lower is surer).")
    json.dump({"placements": [{"score": s, "theta": T[0], "tx": T[1], "ty": T[2]} for s, T in out]}, open(os.path.join(d, "skyline.json"), "w"))
    print(f"Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
