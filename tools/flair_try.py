"""
FLAIR, out of the box, on our locked lots (owner, 2026-10-18: "How about you
try it, since it may have usefulness for the lawnmap"; E13 in
docs/DETECTOR-FINDINGS.md).

IGNF's FLAIR U-Nets were trained on French aerial photos at 0.2 m to tell 15
kinds of ground apart -- building, impervious surface, herbaceous and the
rest. Three of them are run here exactly as published, nothing trained:

    rgb     the photo alone
    rgbi    the photo + NAIP's near-infrared (about 1 m, stretched to 0.2 m)
    rgbie   the photo + near-infrared + height above ground from our lidar

Each lot's photo is resampled to 0.2 m, the model is run in overlapping 512 px
windows, and its classes are brought back to the scoring grid (the same
labels the decoder is scored on, train-detector.js labelsPng). The lawn it
finds is scored the way the detector is: missed + extra over the traced lawn,
inside the property line only (train-detector.js compare).

What counts as lawn, two ways, both reported:
    herb        "herbaceous" only
    herb+agri   herbaceous or agricultural land (a big mown lawn can look
                like a field from above)

Against the traced lawn two ways too: what the photo shows ("seen") and the
seen lawn plus what the tracer marked as under trees ("all").

    FRAMES=frames LIDAR=lidar NAIP=naip WEIGHTS=flair OUT=flair-out python3 tools/flair_try.py

A lot with no near-infrared or no lidar is skipped by the variants that need
them and said so; the medians are printed over the lots every variant read,
so the rows compare.
"""

import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import segmentation_models_pytorch as smp

CELL = 0.2  # metres a pixel, FLAIR's training scale
TILE = 512
STRIDE = 448
NAMES = ["building", "pervious", "impervious", "bare soil", "water", "coniferous", "deciduous", "brushwood",
         "vineyard", "herbaceous", "agricultural", "plowed", "pool", "snow", "clear cut", "mixed", "ligneous",
         "greenhouse", "other"]
OFF = [14, 15, 16, 18]  # disabled in training (model card); never argmax
HERB, AGRI, BUILDING, IMPERVIOUS = 9, 10, 0, 2
MEAN = np.array([105.08, 110.87, 101.82, 106.38, 53.26], dtype=np.float32)
STD = np.array([52.17, 45.38, 44.0, 39.69, 79.3], dtype=np.float32)
VARIANTS = {"rgb": 3, "rgbi": 4, "rgbie": 5}
PALETTE = np.array([[219, 14, 154], [147, 142, 123], [248, 12, 0], [169, 113, 1], [21, 83, 174], [25, 74, 38],
                    [70, 228, 131], [243, 166, 13], [102, 0, 130], [85, 255, 0], [255, 243, 13], [228, 223, 124],
                    [61, 230, 235], [255, 255, 255], [138, 179, 160], [107, 113, 79], [197, 220, 66],
                    [153, 153, 255], [0, 0, 0]], dtype=np.uint8)


def load(name, weights):
    sd = torch.load(weights / f"{name}.pth", map_location="cpu", weights_only=True)
    sd = {k.replace("model.seg_model.", ""): v for k, v in sd.items() if k.startswith("model.")}
    m = smp.Unet(encoder_name="resnet34", encoder_weights=None, in_channels=VARIANTS[name], classes=19)
    m.load_state_dict(sd)
    return m.eval()


def resize(a, w, h, nearest=False):
    """A 2-D float array to w x h."""
    im = Image.fromarray(a.astype(np.float32), mode="F")
    return np.asarray(im.resize((w, h), Image.NEAREST if nearest else Image.BILINEAR), dtype=np.float32)


def classify(model, x):
    """x: C x H x W, already normalised. Overlapping windows, logits averaged."""
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


def score(got, want, within):
    """train-detector.js compare(): missed + extra over the traced lawn, inside the line."""
    g, t = got[within], want[within]
    truth = int(t.sum())
    wrong = int((g & ~t).sum() + (~g & t).sum())
    return None if truth == 0 else 100.0 * wrong / truth


def main():
    frames = Path(os.environ.get("FRAMES", "frames"))
    lidar = Path(os.environ.get("LIDAR", "lidar"))
    naip = Path(os.environ.get("NAIP", "naip"))
    weights = Path(os.environ.get("WEIGHTS", "flair"))
    out = Path(os.environ.get("OUT", "flair-out"))
    out.mkdir(parents=True, exist_ok=True)
    scale = json.loads((frames / "scale.json").read_text())
    tags = scale.get("tags", {})
    models = {k: load(k, weights) for k in VARIANTS}
    ids = sorted(i for i in scale["frames"] if ":example:" not in i and (frames / f"{i}.png").exists())
    print(f"{len(ids)} lots; models {', '.join(models)}")

    rows = []
    shown = 0
    for lot in ids:
        across = float(scale["frames"][lot])
        down = float(scale.get("downs", {}).get(lot, across))
        W, H = max(32, round(across / CELL)), max(32, round(down / CELL))
        photo = np.asarray(Image.open(frames / f"{lot}.png").convert("RGB").resize((W, H), Image.BILINEAR), np.float32)
        lab = np.asarray(Image.open(frames / f"{lot}-labels.png").convert("RGB"))
        seen, within, inferred = lab[:, :, 0] >= 128, lab[:, :, 1] >= 128, lab[:, :, 2] >= 128
        GH, G = seen.shape

        nir = None
        nf = naip / f"{lot}-naip.png"
        if nf.exists():
            nir = resize(np.asarray(Image.open(nf).convert("RGB"))[:, :, 0].astype(np.float32), W, H)
        hag = None
        lf = lidar / f"{lot}.npz"
        if lf.exists():
            with np.load(lf) as z:
                if "height" in z:
                    h = np.nan_to_num(z["height"].astype(np.float32), nan=0.0)
                    hag = np.clip(resize(h, W, H), 0, 51) / 0.2

        chans = {"rgb": [photo[:, :, 0], photo[:, :, 1], photo[:, :, 2]]}
        if nir is not None:
            chans["rgbi"] = chans["rgb"] + [nir]
            if hag is not None:
                chans["rgbie"] = chans["rgbi"] + [hag]
        row = {"id": lot, "tag": tags.get(lot), "metres": round(across), "nir": nir is not None, "lidar": hag is not None}
        maps = {}
        for name, cs in chans.items():
            x = np.stack(cs).astype(np.float32)
            k = x.shape[0]
            x = (x - MEAN[:k, None, None]) / STD[:k, None, None]
            cls = classify(models[name], x)
            maps[name] = cls
            grid = resize(cls.astype(np.float32), G, GH, nearest=True).astype(np.int64)
            herb = grid == HERB
            herbagri = herb | (grid == AGRI)
            row[name] = {
                "herb_seen": score(herb, seen, within), "herb_all": score(herb, seen | inferred, within),
                "herbagri_seen": score(herbagri, seen, within), "herbagri_all": score(herbagri, seen | inferred, within),
                "building_share": round(float((grid[within] == BUILDING).mean()), 3),
                "impervious_share": round(float((grid[within] == IMPERVIOUS).mean()), 3),
            }
        rows.append(row)
        if shown < 16:
            shown += 1
            panes = [photo.astype(np.uint8)] + [(0.45 * photo + 0.55 * PALETTE[maps[n]]).astype(np.uint8) for n in maps]
            Image.fromarray(np.concatenate(panes, 1)).save(out / f"{shown:02d}-{lot.replace(':', '_').replace(',', '_')}.jpg", quality=80)
        done = " ".join(f"{n} {row[n]['herb_seen']:.0f}%" for n in maps if row[n]["herb_seen"] is not None)
        print(f"  {row['tag'] or '   '} {lot[:40]:40s} {row['metres']:4d} m  {done}", flush=True)

    (out / "lots.json").write_text(json.dumps(rows, indent=1))
    common = [r for r in rows if all(n in r for n in VARIANTS)]
    print(f"\nMEDIAN LAWN ERROR (missed + extra over the traced lawn, inside the property line)")
    print(f"over the {len(common)} lots every variant read (of {len(rows)}; "
          f"{sum(not r['nir'] for r in rows)} had no near-infrared, {sum(not r['lidar'] for r in rows)} no lidar):")
    for d in ("herb_seen", "herb_all", "herbagri_seen", "herbagri_all"):
        cells = []
        for n in VARIANTS:
            v = [r[n][d] for r in common if r[n][d] is not None]
            cells.append(f"{n} {np.median(v):5.1f}%" if v else f"{n}   -  ")
        print(f"  {d:14s} " + "   ".join(cells))
    for n in VARIANTS:
        v = [r[n]["herb_seen"] for r in rows if n in r and r[n]["herb_seen"] is not None]
        if v:
            print(f"  {n}: herb_seen over all {len(v)} lots it read: median {np.median(v):.1f}%, "
                  f"quartiles {np.percentile(v, 25):.1f}-{np.percentile(v, 75):.1f}%")


if __name__ == "__main__":
    sys.exit(main())
