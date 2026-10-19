"""
IGNF's FLAIR LAND-COVER U-NETS, OUT OF THE BOX, ON THE WATER MAP'S OWN PAVING SQUARES (water session,
2026-10-19).

The owner asked (2026-10-18) for models that take lidar and RGB (and NIR if need be) and segment roofs and
concrete/blacktop with no training on our part. The core session found FLAIR (IGNF/FLAIR-INC_{rgb,rgbi,rgbie}
_15cl_resnet34-unet, Etalab 2.0): trained on French aerial photos at 0.2 m, 15 classes including building
and impervious surface; the "e" variant also takes height above ground from lidar. It scored them on its own
lots (DETECTOR-FINDINGS H100) and suggested the fair test: on the water map's 23 Chesapeake squares
(FINDINGS H17, H18), on the same cells.

Loading, normalisation, the 0.2 m height encoding and the overlapping windows are copied from the core's
tools/flair_try.py (2026-10-18, commit 1d27f37), unchanged in substance.

Input: DUMP (water/tools/impervious.mjs with DUMP=<dir>): per held-out square, the NAIP photo at 0.2 m (four
bands, band sequential), height above ground per 1 m cell, the land use as a simple code (1 roof, 2 paved,
3 pervious, 4 turf, 5 other, 0 not judged), the roof finder's mask, and the open-ground cells the paving
models are scored on with the in-use model's chance. WEIGHTS: the three .pth files.

    DUMP=flair-in WEIGHTS=flair python3 water/tools/flair_score.py
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy import ndimage
import segmentation_models_pytorch as smp

TILE, STRIDE = 512, 448
OFF = [14, 15, 16, 18]  # disabled in FLAIR's training (model card); never argmax
BUILDING, IMPERVIOUS = 0, 2
MEAN = np.array([105.08, 110.87, 101.82, 106.38, 53.26], dtype=np.float32)
STD = np.array([52.17, 45.38, 44.0, 39.69, 79.3], dtype=np.float32)
VARIANTS = {"rgb": 3, "rgbi": 4, "rgbie": 5}


def load(name, weights):
    sd = torch.load(weights / f"{name}.pth", map_location="cpu", weights_only=True)
    sd = {k.replace("model.seg_model.", ""): v for k, v in sd.items() if k.startswith("model.")}
    m = smp.Unet(encoder_name="resnet34", encoder_weights=None, in_channels=VARIANTS[name], classes=19)
    m.load_state_dict(sd)
    return m.eval()


def classify(model, x):
    """x: C x H x W, normalised. Overlapping windows, logits averaged (flair_try.py)."""
    c, h, w = x.shape
    ph, pw = max(h, TILE), max(w, TILE)
    pad = np.pad(x, ((0, 0), (0, ph - h), (0, pw - w)), mode="reflect")
    acc = np.zeros((19, ph, pw), np.float32)
    n = np.zeros((ph, pw), np.float32)
    ys = list(range(0, ph - TILE + 1, STRIDE)) or [0]
    xs = list(range(0, pw - TILE + 1, STRIDE)) or [0]
    if ys[-1] != ph - TILE: ys.append(ph - TILE)
    if xs[-1] != pw - TILE: xs.append(pw - TILE)
    with torch.no_grad():
        for y0 in ys:
            for x0 in xs:
                t = torch.from_numpy(pad[:, y0:y0 + TILE, x0:x0 + TILE][None]).float()
                acc[:, y0:y0 + TILE, x0:x0 + TILE] += model(t)[0].numpy()
                n[y0:y0 + TILE, x0:x0 + TILE] += 1
    acc = acc[:, :h, :w] / n[:h, :w]
    acc[OFF] = -1e9
    return acc.argmax(0)


def to_cells(cls, W, H, up):
    """0.2 m classes -> per 1 m cell, the class most of its pixels have."""
    blocks = cls[:H * up, :W * up].reshape(H, up, W, up).transpose(0, 2, 1, 3).reshape(H, W, up * up)
    counts = np.stack([(blocks == k).sum(-1) for k in range(19)], -1)
    return counts.argmax(-1)


def rate(pred, truth):
    pred, truth = np.asarray(pred, bool), np.asarray(truth, bool)
    tp = int((pred & truth).sum())
    return tp, int(pred.sum()), int(truth.sum()), int((pred == truth).sum()), len(pred)


def main():
    dump = Path(os.environ.get("DUMP", "flair-in"))
    weights = Path(os.environ.get("WEIGHTS", "flair"))
    models = {k: load(k, weights) for k in VARIANTS}
    squares = sorted(p.stem for p in dump.glob("sq*.json"))
    print(f"{len(squares)} held-out squares; FLAIR variants {', '.join(models)}")
    pave = {k: [] for k in ["ours"] + list(VARIANTS)}
    roof = {k: {"tp": 0, "pred": 0, "truth": 0, "found1": 0, "right1": 0} for k in ["ours"] + list(VARIANTS)}
    mixed = {k: [0, 0, 0, 0] for k in VARIANTS}  # roof called paving, roofs, paving called roof, paving
    for sq in squares:
        meta = json.loads((dump / f"{sq}.json").read_text())
        W, H, up = meta["W"], meta["H"], meta["up"]
        bands = np.frombuffer((dump / f"{sq}-naip.bsq").read_bytes(), np.uint8).reshape(4, H * up, W * up).astype(np.float32)
        hag = np.frombuffer((dump / f"{sq}-hag.f32").read_bytes(), np.float32).reshape(H, W)
        truth = np.frombuffer((dump / f"{sq}-truth.u8").read_bytes(), np.uint8).reshape(H, W)
        ourRoof = np.frombuffer((dump / f"{sq}-roof.u8").read_bytes(), np.uint8).reshape(H, W) > 0
        hag_hi = np.asarray(Image.fromarray(np.nan_to_num(hag).astype(np.float32), mode="F").resize((W * up, H * up), Image.BILINEAR), np.float32)
        chans = [bands[0], bands[1], bands[2], bands[3], np.clip(hag_hi, 0, 51) / 0.2]
        cells = meta["cells"]
        idx = np.array([c[0] for c in cells], np.int64)
        isimp = np.array([c[1] == 1 for c in cells])
        pave["ours"].append((np.array([c[2] for c in cells]) > 0.5, isimp))
        judged = truth > 0
        troof = truth == 1
        tpave = truth == 2
        grow = lambda m: ndimage.binary_dilation(m)
        def roofs(name, pred):
            r = roof[name]
            p, t = pred & judged, troof & judged
            r["tp"] += int((p & t).sum()); r["pred"] += int(p.sum()); r["truth"] += int(t.sum())
            r["found1"] += int((t & grow(p)).sum()); r["right1"] += int((p & grow(t)).sum())
        roofs("ours", ourRoof)
        for name, k in VARIANTS.items():
            x = (np.stack(chans[:k]) - MEAN[:k, None, None]) / STD[:k, None, None]
            cls = to_cells(classify(models[name], x), W, H, up)
            flat = cls.reshape(-1)
            pave[name].append((flat[idx] == IMPERVIOUS, isimp))
            roofs(name, cls == BUILDING)
            mixed[name][0] += int(((cls == IMPERVIOUS) & troof).sum()); mixed[name][1] += int(troof.sum())
            mixed[name][2] += int(((cls == BUILDING) & tpave).sum()); mixed[name][3] += int(tpave.sum())
        print(f"  {sq}: {W} x {H} m, {len(cells)} open cells scored", flush=True)

    print("\n==============================================================")
    print(f"FLAIR OUT OF THE BOX ON THE WATER MAP'S {len(squares)} HELD-OUT CHESAPEAKE SQUARES (NAIP photo at 0.2 m)")
    print("  PAVING, on the open-ground cells every model is scored on (H17):")
    label = {"ours": "lidar + photo against the lawn (in use)", "rgb": "FLAIR rgb (photo)", "rgbi": "FLAIR rgbi (photo + NIR)", "rgbie": "FLAIR rgbie (photo + NIR + lidar height)"}
    for name, parts in pave.items():
        pred = np.concatenate([p for p, _ in parts]); truth = np.concatenate([t for _, t in parts])
        tp, npred, ntruth, right, n = rate(pred, truth)
        print(f"    {label[name]:44s} right on {100 * right / max(1, n):5.1f}% of cells, finds {100 * tp / max(1, ntruth):3.0f}% of paving, {100 * tp / max(1, npred):3.0f}% of what it calls paving is paving")
    print("  ROOFS, every judged cell (exact | within 1 m):")
    rl = {"ours": "roof finders, either (in use)", "rgb": "FLAIR rgb building", "rgbi": "FLAIR rgbi building", "rgbie": "FLAIR rgbie building"}
    for name, r in roof.items():
        print(f"    {rl[name]:44s} found {100 * r['tp'] / max(1, r['truth']):3.0f}% | {100 * r['found1'] / max(1, r['truth']):3.0f}%   precise {100 * r['tp'] / max(1, r['pred']):3.0f}% | {100 * r['right1'] / max(1, r['pred']):3.0f}%")
    for name, (ra, tr, pa, tp) in mixed.items():
        print(f"    FLAIR {name}: {100 * ra / max(1, tr):.1f}% of roof called paving, {100 * pa / max(1, tp):.1f}% of paving called roof")


if __name__ == "__main__":
    sys.exit(main())
