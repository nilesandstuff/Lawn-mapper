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

FOR THE WATER MAP (owner, 2026-10-18: it "needs something that segments
concrete/blacktop and roofs ... ideally ... roofs apart from concrete"): where
the Chesapeake Bay 1 m land use covers a lot (E7), FLAIR's building and
impervious classes are scored against its Structures (22) and Roads + Other
Impervious (21, 23), at 1 m, exactly and within one cell. Cells it marks as
tree canopy over impervious (24-26) are left out: nothing says what is under.

AS A VETO FOR THE LAWN MAP ("veto lawn traces that end up creeping onto
pavements or roofs"): inside the property line, how much of the TRACED lawn
FLAIR calls building or impervious (what a veto would wrongly erase), and how
much of what it calls building or impervious is not lawn (its precision).

Every lot's classes are kept (OUT/maps/<id>.npz) so a later question is a
re-score, not a re-run.

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

import io
import urllib.parse
import urllib.request

import segmentation_models_pytorch as smp
from scipy import ndimage

CHESAPEAKE = "https://cicgis.org/arcgis/rest/services/LULC/bay_lu_tif/ImageServer/exportImage"
CB_BUILDING, CB_PAVING, CB_UNSEEN = (22,), (21, 23), (24, 25, 26)

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


def chesapeake(box, lat):
    """The Chesapeake classes over a Web Mercator box at about 1 m, or None outside it."""
    k = math.cos(math.radians(lat))
    w = max(8, min(2000, round((box[2] - box[0]) * k)))
    h = max(8, min(2000, round((box[3] - box[1]) * k)))
    q = {"bbox": ",".join(str(v) for v in box), "bboxSR": "3857", "imageSR": "3857", "size": f"{w},{h}",
         "format": "tiff", "pixelType": "U8", "interpolation": "RSP_NearestNeighbor",
         "renderingRule": json.dumps({"rasterFunction": "None"}), "f": "image"}
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"{CHESAPEAKE}?{urllib.parse.urlencode(q)}", timeout=90) as r:
                a = np.asarray(Image.open(io.BytesIO(r.read())))
            if a.ndim == 3:
                a = a[:, :, 0]
            return a if (a > 0).mean() > 0.5 else None
        except OSError:
            continue
    return None


def agree(f, c, keep):
    """Counts for one class pair, exactly and within one cell."""
    f, c = f & keep, c & keep
    fd = ndimage.binary_dilation(f)
    cd = ndimage.binary_dilation(c)
    return {"f": int(f.sum()), "c": int(c.sum()), "both": int((f & c).sum()),
            "c_found_1": int((c & fd).sum()), "f_right_1": int((f & cd).sum()), "union": int((f | c).sum())}


def lat_of(box):
    y = (box[1] + box[3]) / 2
    return math.degrees(2 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2)


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
        box = scale.get("boxes", {}).get(lot)
        cb = chesapeake(box, lat_of(box)) if box else None
        row["chesapeake"] = cb is not None
        for name, cls in maps.items():
            grid = resize(cls.astype(np.float32), G, GH, nearest=True).astype(np.int64)
            lawn = (seen | inferred) & within
            hard = ((grid == BUILDING) | (grid == IMPERVIOUS)) & within
            row[name]["veto"] = {"lawn": int(lawn.sum()), "hard": int(hard.sum()),
                                 "hard_on_lawn": int((hard & lawn).sum()),
                                 "hard_off_lawn": int((hard & ~lawn).sum()),
                                 "not_lawn": int((within & ~lawn).sum())}
            if cb is not None:
                f = resize(cls.astype(np.float32), cb.shape[1], cb.shape[0], nearest=True).astype(np.int64)
                keep = (cb > 0) & ~np.isin(cb, CB_UNSEEN)
                row[name]["cb"] = {
                    "building": agree(f == BUILDING, np.isin(cb, CB_BUILDING), keep),
                    "paving": agree(f == IMPERVIOUS, np.isin(cb, CB_PAVING), keep),
                    "hard": agree((f == BUILDING) | (f == IMPERVIOUS), np.isin(cb, CB_BUILDING + CB_PAVING), keep),
                    # A roof called pavement, or pavement called roof: the water map needs them apart.
                    "roof_as_paving": int(((f == IMPERVIOUS) & np.isin(cb, CB_BUILDING) & keep).sum()),
                    "paving_as_roof": int(((f == BUILDING) & np.isin(cb, CB_PAVING) & keep).sum()),
                }
        (out / "maps").mkdir(exist_ok=True)
        np.savez_compressed(out / "maps" / f"{lot.replace(':', '_').replace(',', '_')}.npz",
                            **{n: maps[n].astype(np.uint8) for n in maps}, **({"chesapeake": cb} if cb is not None else {}))
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
    print("\nAS A VETO ON LAWN (inside the property line, pooled over every lot it read):")
    for n in VARIANTS:
        vs = [r[n]["veto"] for r in rows if n in r]
        if not vs:
            continue
        lawn = sum(v["lawn"] for v in vs); hard = sum(v["hard"] for v in vs)
        on = sum(v["hard_on_lawn"] for v in vs); off = sum(v["hard_off_lawn"] for v in vs)
        notl = sum(v["not_lawn"] for v in vs)
        per = [100 * v["hard_on_lawn"] / v["lawn"] for v in vs if v["lawn"]]
        print(f"  {n:6s} building+impervious would erase {100 * on / max(1, lawn):4.1f}% of the traced lawn "
              f"(median lot {np.median(per):.1f}%, worst {max(per):.1f}%); "
              f"{100 * off / max(1, hard):4.1f}% of what it calls building+impervious is not lawn; "
              f"it covers {100 * off / max(1, notl):4.1f}% of the not-lawn")
    cbrows = [r for r in rows if r.get("chesapeake")]
    print(f"\nAGAINST THE CHESAPEAKE 1 m LAND USE, {len(cbrows)} lots it covers (pooled cells; "
          "exact, then within one cell):")
    for n in VARIANTS:
        rs = [r[n]["cb"] for r in cbrows if n in r and "cb" in r[n]]
        if not rs:
            continue
        for kind in ("building", "paving", "hard"):
            t = {k: sum(r[kind][k] for r in rs) for k in rs[0][kind]}
            rec = 100 * t["both"] / max(1, t["c"]); pre = 100 * t["both"] / max(1, t["f"])
            rec1 = 100 * t["c_found_1"] / max(1, t["c"]); pre1 = 100 * t["f_right_1"] / max(1, t["f"])
            iou = 100 * t["both"] / max(1, t["union"])
            print(f"  {n:6s} {kind:8s} found {rec:4.1f}% / {rec1:4.1f}%   right {pre:4.1f}% / {pre1:4.1f}%   IoU {iou:4.1f}%")
        ra = sum(r["roof_as_paving"] for r in rs); pa = sum(r["paving_as_roof"] for r in rs)
        tb = sum(r["building"]["c"] for r in rs); tp = sum(r["paving"]["c"] for r in rs)
        print(f"  {n:6s} mixed up: {100 * ra / max(1, tb):.1f}% of roof called pavement, "
              f"{100 * pa / max(1, tp):.1f}% of pavement called roof")
    for n in VARIANTS:
        v = [r[n]["herb_seen"] for r in rows if n in r and r[n]["herb_seen"] is not None]
        if v:
            print(f"  {n}: herb_seen over all {len(v)} lots it read: median {np.median(v):.1f}%, "
                  f"quartiles {np.percentile(v, 25):.1f}-{np.percentile(v, 75):.1f}%")


if __name__ == "__main__":
    sys.exit(main())
