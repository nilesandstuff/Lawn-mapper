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
    print(f"Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
