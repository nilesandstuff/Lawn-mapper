"""
PAVEMENT FROM THE PICTURES, ONTO THE GROUND (core session, 2026-11-06; the owner: "have we tried lidar brightness
for driveways/roads? I feel like we could get a lot from that"). Run by workflow "S. Yard AR tool", task `pavement`,
after scan/tools/skyline-prep.mjs, on GitHub's free runner.

The picture half of the pavement signal, and its test:
  1. each picture through the same public segmentation model the skyline uses (SegFormer-b0, ADE20K): the classes
     road, sidewalk, path, floor and earth count as pavement; grass, field and plant as grass;
  2. every pixel below the horizon, cast onto the ground: the phone's height over its own ground then (eye), the
     ground taken level around the phone; kept out to GROUND_REACH_M (the cast gets long and shallow beyond);
  3. the result: points in the SESSION frame (u, v) labelled pavement or grass, one per 20 cm cell, with how many
     pixels agreed; written as pavement.json beside the twin for the match.

THE TEST, with no lidar brightness yet: at the truth (the check points' own fit), how many pavement points fall
inside the traced lawn, and how many grass points do. The lawn trace is NOT a fix signal (the owner, 2026-11-04);
here it only says whether the cast is right. Once the model carries `intensity`, the match scores these points
against it instead. NUMBERS ONLY in the log.

    python scan/tools/pavement_study.py twin
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

SEG_MODEL = "nvidia/segformer-b0-finetuned-ade-512-512"
MAX_PICS = int(os.environ.get("PAVE_PICS", 400))  # segmentation is cheap: every picture the twin kept
GROUND_REACH_M = 8.0
CELL = 0.2
PAVE = {"road", "sidewalk", "path"}  # not earth or floor: November lawn reads as earth (57% of "pavement" fell in the lawn)
GRASS = {"grass", "field", "plant", "flower"}
FT = 3.28084
GROUND_TOL_M = 0.15
GROUND_W = float(os.environ.get("PLACE_GROUND_W", 0.5))
PAVE_ENOUGH = int(os.environ.get("PLACE_PAVE_ENOUGH", 1000))  # pavement cells below which brightness is not trusted (SCAN-H19)


def ground_points(d, keep=6000):
    """ARCore's ground points in the session's level frame: [u, v, y]. From the twin's cloud parts (t, odo, x, y, z,
    ground: the page's ground height then); a point within 15 cm of it is ground."""
    import glob
    parts = sorted(glob.glob(os.path.join(d, "cloud-*.bin")))
    if not parts:
        return np.zeros((0, 3))
    a = np.concatenate([np.fromfile(p_, dtype="<f4") for p_ in parts]); a = a[: len(a) // 6 * 6].reshape(-1, 6)
    a = a[np.isfinite(a[:, 5]) & (np.abs(a[:, 3] - a[:, 5]) < 0.15)]
    if len(a) > keep:
        a = a[:: len(a) // keep]
    return np.stack([a[:, 2], -a[:, 4], a[:, 3]], 1).astype(np.float64)


def labels(d, pics):
    labels.seen = []
    import torch
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
    torch.set_num_threads(os.cpu_count() or 2)
    proc = SegformerImageProcessor.from_pretrained(SEG_MODEL)
    model = SegformerForSemanticSegmentation.from_pretrained(SEG_MODEL).eval()
    names = {int(k): v.lower().split(",")[0].strip() for k, v in model.config.id2label.items()}
    pave_ids = {k for k, v in names.items() if v in PAVE}
    grass_ids = {k for k, v in names.items() if v in GRASS}
    out = []
    for p in pics:
        img = Image.open(os.path.join(d, p["name"])).convert("RGB")
        with torch.no_grad():
            lab = model(**proc(images=img, return_tensors="pt")).logits.argmax(1)[0].numpy()
        mh, mw = max(8, img.height // 4), max(8, img.width // 4)
        lab = np.asarray(Image.fromarray(lab.astype(np.uint8)).resize((mw, mh), Image.NEAREST))
        for k in pave_ids:
            n_ = int((lab == k).sum())
            if n_:
                labels.seen.append({names[k]: n_})
        cls = np.zeros(lab.shape, np.int8)
        cls[np.isin(lab, list(pave_ids))] = 1
        cls[np.isin(lab, list(grass_ids))] = 2
        out.append(cls)
    return out


def cast(pics, labs):
    """Pixels labelled pavement or grass, cast onto the level ground under the phone. -> dict cell -> [pave, grass]."""
    cells = {}
    for p, cls in zip(pics, labs):
        V = np.asarray(p["view"], dtype=np.float64).reshape(4, 4).T
        Pi = np.linalg.inv(np.asarray(p["proj"], dtype=np.float64).reshape(4, 4).T)
        cam = V[:3, 3]; ground_y = cam[1] - p["eye"]
        mh, mw = cls.shape
        ys, xs = np.nonzero(cls)
        if not len(ys):
            continue
        step = max(1, len(ys) // 4000)
        ys, xs = ys[::step], xs[::step]
        nx = 2 * (xs + 0.5) / mw - 1; ny = 1 - 2 * (ys + 0.5) / mh
        a = Pi @ np.stack([nx, ny, -np.ones_like(nx), np.ones_like(nx)]); a = a[:3] / a[3]
        b = Pi @ np.stack([nx, ny, np.ones_like(nx), np.ones_like(nx)]); b = b[:3] / b[3]
        dw = V[:3, :3] @ (b - a)
        down = dw[1] < -1e-3
        t = (ground_y - cam[1]) / np.where(down, dw[1], -1)
        gx = cam[0] + dw[0] * t; gz = cam[2] + dw[2] * t
        reach = np.hypot(gx - cam[0], gz - cam[2])
        ok = down & (reach > 0.8) & (reach < GROUND_REACH_M)
        for u, v, c in zip(gx[ok], -gz[ok], cls[ys[ok], xs[ok]]):
            k = (int(math.floor(u / CELL)), int(math.floor(v / CELL)))
            e = cells.setdefault(k, [0, 0])
            e[0 if c == 1 else 1] += 1
    return cells


def inside(ring, e, n):
    x, y = ring[:, 0], ring[:, 1]
    j = np.roll(np.arange(len(ring)), 1)
    cond = ((y > n) != (y[j] > n))
    xi = x[j] + (n - y[j]) * (x - x[j]) / np.where(y - y[j] == 0, 1e-9, y - y[j])
    return (cond & (e < xi)).sum() % 2 == 1


def fit_rigid(pairs):
    a = np.array([p[0] for p in pairs], float); b = np.array([p[1] for p in pairs], float)
    am, bm = a.mean(0), b.mean(0); A, B = a - am, b - bm
    sxx = (A * B).sum(); sxy = (A[:, 0] * B[:, 1] - A[:, 1] * B[:, 0]).sum()
    th = math.atan2(sxy, sxx); c, s = math.cos(th), math.sin(th)
    return th, bm[0] - (c * am[0] - s * am[1]), bm[1] - (s * am[0] + c * am[1])


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    pics = [p for p in inp["pictures"] if p.get("eye") is not None and 0.5 < p["eye"] < 2.5]
    if len(pics) > MAX_PICS:
        pics = [pics[int(i)] for i in np.linspace(0, len(pics) - 1, MAX_PICS)]
    labs = labels(d, pics)
    share = [(c == 1).mean() for c in labs]
    # which classes the pavement came from, for the record
    from collections import Counter
    cnt = Counter()
    for lab_names in getattr(labels, "seen", []):
        cnt.update(lab_names)
    if cnt:
        print("  pavement classes seen (pixels): " + ", ".join(f"{k} {v:,}" for k, v in cnt.most_common(6)))
    print(f"Pavement study: {len(pics)} pictures; pavement in a median {np.median(share):.0%} of a picture's pixels, {sum(1 for s_ in share if s_ > 0.05)} pictures with more than 5%. ({int(time.time() - t0)} s)")
    cells = cast(pics, labs)
    pts = [(k[0] * CELL + CELL / 2, k[1] * CELL + CELL / 2, v[0], v[1]) for k, v in cells.items()]
    pave = [(u, v) for u, v, a, b in pts if a >= 3 and a > 2 * b]
    grass = [(u, v) for u, v, a, b in pts if b >= 3 and b > 2 * a]
    print(f"On the ground within {GROUND_REACH_M:.0f} m: {len(pave):,} pavement cells of {CELL} m, {len(grass):,} grass cells.")
    json.dump({"cell": CELL, "reach": GROUND_REACH_M, "pavement": [[round(u, 2), round(v, 2)] for u, v in pave], "grass": [[round(u, 2), round(v, 2)] for u, v in grass]}, open(os.path.join(d, "pavement.json"), "w"))
    checks = list({c["id"]: c for c in inp.get("checks") or []}.values())
    lawn = [np.array(r, float) for r in inp.get("lawn") or [] if len(r) >= 3]
    if len(checks) >= 2 and lawn and pave and grass:
        th, tx, ty = fit_rigid([(c["ar"], c["map"]) for c in checks]); c_, s_ = math.cos(th), math.sin(th)
        def in_lawn(u, v):
            e, n = c_ * u - s_ * v + tx, s_ * u + c_ * v + ty
            return any(inside(r, e, n) for r in lawn)
        pin = np.mean([in_lawn(u, v) for u, v in pave]); gin = np.mean([in_lawn(u, v) for u, v in grass])
        print(f"At the check points' own placement: {pin:.0%} of the pavement cells fall inside the traced lawn, {gin:.0%} of the grass cells do (the cast is right when the first is small and the second large).")
    else:
        print("No check points, lawn trace or pavement to test the cast against.")
    # THE MATCH AGAINST THE LIDAR'S BRIGHTNESS (the model's `intensity`, the shade map 2026-11-06): pavement is dark,
    # grass bright. P(pavement | I) = sigmoid((median - I) / scale) with the lot's own ground median; the log-likelihood
    # of every cast point, searched round each of the skyline's placements (skyline.json) and round the truth.
    ip = os.path.join(d, "sky-intensity.bin")
    if os.path.exists(ip) and pave and grass:
        g = inp["grid"]
        I = np.fromfile(ip, dtype="<u2").reshape(g["h"], g["w"]).astype(np.float64)
        has = I > 0
        med = float(inp.get("intensityMedian") or np.median(I[has]))
        scale = float(np.percentile(I[has], 75) - np.percentile(I[has], 25)) / 2 or 1.0
        def look(e, n):
            c = np.floor((e - g["x0"]) / g["cell"]).astype(np.int64); r = np.floor((g["y1"] - n) / g["cellY"]).astype(np.int64)
            ok = (c >= 0) & (r >= 0) & (c < g["w"]) & (r < g["h"])
            v = I[np.where(ok, r, 0), np.where(ok, c, 0)]
            return np.where(ok & (v > 0), v, np.nan)
        P = np.array(pave); G = np.array(grass)
        def under(T, pts):
            th, tx, ty = T; c_, s_ = math.cos(th), math.sin(th)
            e = c_ * pts[:, 0] - s_ * pts[:, 1] + tx; n = s_ * pts[:, 0] + c_ * pts[:, 1] + ty
            return look(e, n)
        def score(T):
            # the two classes weighed alike (grass cells outnumber pavement 15 to 1); cells with no ground return
            # (under roofs and crowns) say nothing
            def ll(pts, want_pave):
                v = under(T, pts); ok = np.isfinite(v)
                if ok.sum() < 10:
                    return 0.0
                z = (med - v[ok]) / scale; pp = 1 / (1 + np.exp(-z))
                return np.log(np.clip(pp if want_pave else 1 - pp, 0.02, 1)).mean() * 1000
            return ll(P, True) + ll(G, False)
        # THE GROUND'S SHAPE (the owner, 2026-11-06: "we should at least be able to inform the placement based on the
        # position and shape of the ground"): ARCore's ground points against the lidar's ground (the model's `ground`,
        # its class-2 returns per metre), once their height offset is taken out: the share within GROUND_TOL_M. Broad
        # (SCAN-H11: a few metres, not inches), so a light weight beside the brightness; its own answer is printed.
        gp = ground_points(d)
        gg = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"]) if os.path.exists(os.path.join(d, "sky-ground.bin")) else None
        def gscore(T):
            if gg is None or not len(gp):
                return 0.0
            th, tx, ty = T; c_, s_ = math.cos(th), math.sin(th)
            e = c_ * gp[:, 0] - s_ * gp[:, 1] + tx; n = s_ * gp[:, 0] + c_ * gp[:, 1] + ty
            c = np.floor((e - g["x0"]) / g["cell"]).astype(np.int64); r = np.floor((g["y1"] - n) / g["cellY"]).astype(np.int64)
            ok = (c >= 0) & (r >= 0) & (c < g["w"]) & (r < g["h"])
            z = np.where(ok, gg[np.where(ok, r, 0), np.where(ok, c, 0)], np.nan)
            dz = z - gp[:, 2]; dz = dz[np.isfinite(dz)]
            if len(dz) < 50:
                return 0.0
            tz = np.median(dz)
            return float(np.exp(-0.5 * ((dz - tz) / GROUND_TOL_M) ** 2).mean() * 1000)
        def total(T):
            return score(T) + GROUND_W * gscore(T)
        def refine(T, f, steps=((2.0, 1.0), (0.5, 0.3), (0.25, 0.1))):
            sc = f(T)
            for dd, mm in steps:
                cands = [(T[0] + math.radians(a), T[1] + x, T[2] + y) for a in np.arange(-3, 3.01, 1) * dd for x in np.arange(-4, 4.01, 1) * mm for y in np.arange(-4, 4.01, 1) * mm]
                scs = [f(C) for C in cands]; j_ = int(np.argmax(scs))
                if scs[j_] > sc:
                    sc, T = scs[j_], cands[j_]
            return sc, T
        truth = fit_rigid([(c["ar"], c["map"]) for c in checks]) if len(checks) >= 2 else None
        def errs_of(T):
            return [math.hypot(*np.subtract((math.cos(T[0]) * c["ar"][0] - math.sin(T[0]) * c["ar"][1] + T[1], math.sin(T[0]) * c["ar"][0] + math.cos(T[0]) * c["ar"][1] + T[2]), c["map"])) for c in checks]
        def described(T):
            if not truth:
                return ""
            e_ = errs_of(T)
            return f"; checks {', '.join(f'{x * FT:.1f}' for x in e_)} ft (median {np.median(e_) * FT:.1f}); {math.degrees((T[0] - truth[0] + np.pi) % (2 * np.pi) - np.pi):+.1f} deg from the truth"
        sky_starts = []
        sk = os.path.join(d, "skyline.json")
        if os.path.exists(sk):
            sky_starts = [(q["theta"], q["tx"], q["ty"]) for q in json.load(open(sk)).get("placements", [])[:3]]
        else:
            print("  (no skyline.json beside the twin: the skyline's placements were not tried as starts)")
        if truth:
            vp, vg = under(truth, P), under(truth, G)
            okp, okg = np.isfinite(vp), np.isfinite(vg)
            print(f"Brightness at the truth: score {score(truth):.1f}; {len(P)} pavement cells ({okp.mean():.0%} over a lidar ground return, median brightness {np.median(vp[okp]) if okp.any() else float('nan'):.0f}) and {len(G)} grass cells ({okg.mean():.0%}, median {np.median(vg[okg]) if okg.any() else float('nan'):.0f}); the lot's ground median {med:.0f}, scale {scale:.0f}. Pavement should be the darker.")
            print(f"Ground shape at the truth: {gscore(truth) / 10:.0f}% of {len(gp):,} ARCore ground points within {GROUND_TOL_M * 100:.0f} cm of the lidar's ground (weight {GROUND_W}).")
        # each signal alone and the two together, from every skyline start (and, for the record, from the truth)
        named = [(T0, f"the skyline's {i + 1}") for i, T0 in enumerate(sky_starts)] + ([(truth, "the truth (study only)")] if truth else [])
        for label, f in (("brightness", score), ("ground", gscore), ("both", total)):
            res = sorted(((*refine(T0, f), nm) for T0, nm in named), key=lambda x: -x[0])
            for rank, (sc, T, nm) in enumerate(res[:3], 1):
                print(f"  {label} {rank} (from {nm}): score {sc:.1f}{described(T)}")
        # THE PLACEMENT (the after-the-walk fix reads it): both signals together, from the skyline's starts only
        if sky_starts:
            best = sorted((refine(T0, total) for T0 in sky_starts), key=lambda x: -x[0])
            sc, T = best[0]
            enough = len(P) >= PAVE_ENOUGH
            if not enough:
                T = sky_starts[0]
            out_ = {"theta": float(T[0]), "tx": float(T[1]), "ty": float(T[2]), "score": float(sc),
                    "from": "skyline, then brightness and ground" if enough else f"skyline alone (only {len(P)} pavement cells seen; {PAVE_ENOUGH} wanted)",
                    "pavementCells": len(P), "groundPoints": int(len(gp))}
            json.dump(out_, open(os.path.join(d, "placement.json"), "w"))
            print(f"Placement kept (placement.json): {out_['from']}{described(T)}")
    else:
        print("No intensity in the model yet (the shade map writes it on the lot's next save): the brightness match waits.")
        sk = os.path.join(d, "skyline.json")
        if os.path.exists(sk):
            q = json.load(open(sk)).get("placements", [])
            if q:
                json.dump({"theta": q[0]["theta"], "tx": q[0]["tx"], "ty": q[0]["ty"], "score": q[0]["score"], "from": "skyline alone (no brightness in the model)"}, open(os.path.join(d, "placement.json"), "w"))
                print("Placement kept (placement.json): skyline alone.")
    print(f"Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
