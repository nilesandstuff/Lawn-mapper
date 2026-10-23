"""
Meta's Canopy Height Maps v2 (CHMv2), out of the box, on our locked lots
(S53, 2026-10-23; owner: "try everything that makes sense to try").

CHMv2 is a DPT head on the DINOv3 satellite ViT-L (the eye S51 is trying),
trained against airborne lidar to give canopy height in metres a pixel from
a Maxar photograph at about 0.6 m (facebook/dinov3-vitl16-chmv2-dpt-head,
March 2026). Nothing is trained here; each lot's photo is resampled to the
model's scale and read whole, and the heights it returns are measured
against what we already have:

    the lidar's height surface (lidar_frame.py at 1 m): how well CHMv2 reads
        tree height from the picture alone -- MAE where the lidar has trees,
        and AUC of its height for the lidar's 2.5 m+ cells against the rest;
    the tree model's canopy mask (tree-canopy.py): IoU of CHM >= 2 m with it;
    ROOF AGAINST TREE: of the lidar's 2.5 m+ cells, the ones the tree model
        calls canopy against the ones it does not (roofs, mostly). A canopy
        model trained on lidar canopy heights has seen buildings as zero
        height, so a low CHM over a tall lidar cell says roof -- a second
        opinion the detector's roof mask never had;
    the traced lawn: how much of the SEEN lawn CHM calls 2 m+ (what a veto
        would wrongly erase), and how much of the ground the tracer marked
        "under trees" it sees as canopy.

Two scales, since the model's own is coarse for us: 0.6 m (its training
scale) and 0.3 m (twice finer, in case it generalises down).

    FRAMES=frames LIDAR=lidar CANOPY=canopy OUT=chm-out HF_TOKEN=... python3 tools/chm_try.py

Every lot's heights are kept (OUT/maps/<id>.npz, both scales) so a later
question is a re-score, not a re-run; the first 16 lots get a picture
(photo | CHM | lidar height).
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

MODEL = os.environ.get("CHM_MODEL", "facebook/dinov3-vitl16-chmv2-dpt-head")
SCALES = [float(v) for v in (os.environ.get("CHM_SCALES") or "0.6,0.3").split(",")]
# SAT-493M's own pixel statistics (the DINOv3 README), used when the
# checkpoint's processor does not say.
SAT_MEAN = np.array([0.430, 0.411, 0.296], dtype=np.float32)
SAT_STD = np.array([0.213, 0.156, 0.143], dtype=np.float32)
TREE_M = 2.0      # CHM at or above this is canopy
LIDAR_TALL_M = 2.5  # the lidar's tall mask (lidar_frame's roof/crown threshold)
PATCH = 16


def resize(a, w, h, nearest=False):
    im = Image.fromarray(np.asarray(a, dtype=np.float32), mode="F")
    return np.asarray(im.resize((w, h), Image.NEAREST if nearest else Image.BILINEAR), dtype=np.float32)


def auc(score, positive):
    """Area under the ROC: a positive cell outscoring a negative one. 0.5 is a coin toss."""
    s, p = np.asarray(score, dtype=np.float64).ravel(), np.asarray(positive, dtype=bool).ravel()
    n_pos, n_neg = int(p.sum()), int((~p).sum())
    if n_pos == 0 or n_neg == 0:
        return None
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), dtype=np.float64)
    # Average ranks for ties.
    sorted_s = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return float((ranks[p].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def iou(a, b):
    a, b = np.asarray(a, bool), np.asarray(b, bool)
    u = int((a | b).sum())
    return None if u == 0 else float((a & b).sum()) / u


def open_model():
    """The CHMv2 head and its backbone, and how to normalise for it."""
    import torch
    from transformers import AutoModelForDepthEstimation
    try:
        model = AutoModelForDepthEstimation.from_pretrained(MODEL)
    except Exception as e:  # noqa: BLE001 - one message worth having
        if "gated" in str(e).lower() or "401" in str(e) or "403" in str(e):
            raise SystemExit(f"{MODEL} is gated: accept its licence on the hub and set HF_TOKEN.") from e
        raise
    model.eval()
    mean, std = SAT_MEAN, SAT_STD
    try:
        from transformers import AutoImageProcessor
        proc = AutoImageProcessor.from_pretrained(MODEL)
        if getattr(proc, "image_mean", None) and getattr(proc, "image_std", None):
            mean = np.array([float(v) for v in proc.image_mean], dtype=np.float32)
            std = np.array([float(v) for v in proc.image_std], dtype=np.float32)
    except Exception as e:  # noqa: BLE001
        print(f"no processor config ({str(e)[:80]}); SAT-493M's published mean and sd", flush=True)
    print(f"{MODEL}: {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M weights; "
          f"pixels normalised with mean {mean.round(3).tolist()} sd {std.round(3).tolist()}", flush=True)
    return model, mean, std, torch


def heights(model, torch, photo, mean, std):
    """CHMv2's height, metres, for an (h, w, 3) uint8 photo at the model's scale."""
    h, w = photo.shape[:2]
    ph, pw = -(-h // PATCH) * PATCH, -(-w // PATCH) * PATCH
    x = (photo.astype(np.float32) / 255.0 - mean) / std
    x = np.pad(x, ((0, ph - h), (0, pw - w), (0, 0)), mode="reflect" if min(h, w) > max(ph - h, pw - w) else "edge")
    t = torch.from_numpy(np.ascontiguousarray(x)).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        out = model(pixel_values=t)
    d = out.predicted_depth if hasattr(out, "predicted_depth") else out[0]
    d = d.squeeze().float().cpu().numpy()
    if d.shape != (ph, pw):
        d = resize(d, pw, ph)
    return np.clip(d[:h, :w], 0, None)


def main():
    frames = Path(os.environ.get("FRAMES", "frames"))
    lidar = Path(os.environ.get("LIDAR", "lidar"))
    canopy = Path(os.environ.get("CANOPY", "canopy"))
    out = Path(os.environ.get("OUT", "chm-out"))
    (out / "maps").mkdir(parents=True, exist_ok=True)
    scale = json.loads((frames / "scale.json").read_text())
    tags = scale.get("tags", {})
    ids = sorted(i for i in scale["frames"] if ":example:" not in i and (frames / f"{i}.png").exists())
    model, mean, std, torch = open_model()
    print(f"{len(ids)} lots at {', '.join(f'{s:g} m' for s in SCALES)} a pixel", flush=True)

    rows = []
    shown = 0
    for lot in ids:
        across = float(scale["frames"][lot])
        down = float(scale.get("downs", {}).get(lot, across))
        photo_full = Image.open(frames / f"{lot}.png").convert("RGB")
        lab = np.asarray(Image.open(frames / f"{lot}-labels.png").convert("RGB"))
        seen, within, inferred = lab[:, :, 0] >= 128, lab[:, :, 1] >= 128, lab[:, :, 2] >= 128
        GH, G = seen.shape
        # Everything is compared on a 0.5 m grid: fine enough for the lidar's
        # 1 m cells and the model's 0.6 m pixels, coarse enough to be fair to both.
        W, H = max(16, round(across / 0.5)), max(16, round(down / 0.5))
        seen_g = resize(seen.astype(np.float32), W, H) >= 0.5
        within_g = resize(within.astype(np.float32), W, H) >= 0.5
        inferred_g = resize(inferred.astype(np.float32), W, H) >= 0.5

        lid = None
        lf = lidar / f"{lot}.npz"
        if lf.exists():
            with np.load(lf) as z:
                if "height" in z:
                    hh = z["height"].astype(np.float32)
                    ok = ~np.isnan(hh)
                    lid = (resize(np.nan_to_num(hh, nan=0.0), W, H), resize(ok.astype(np.float32), W, H) >= 0.5)
        tree = None
        cf = canopy / f"{lot}-mask.png"
        if cf.exists():
            tree = resize(np.asarray(Image.open(cf).convert("L"), dtype=np.float32) / 255.0, W, H) >= 0.5

        row = {"id": lot, "tag": tags.get(lot), "metres": round(across), "lidar": lid is not None, "tree": tree is not None}
        maps = {}
        for s in SCALES:
            w_s, h_s = max(PATCH, round(across / s)), max(PATCH, round(down / s))
            photo = np.asarray(photo_full.resize((w_s, h_s), Image.BILINEAR))
            chm = heights(model, torch, photo, mean, std)
            chm_g = resize(chm, W, H)
            maps[f"{s:g}"] = chm.astype(np.float16)
            r = {"max_m": round(float(chm_g.max()), 1),
                 "canopy_share_in_line": round(float((chm_g[within_g] >= TREE_M).mean()), 3) if within_g.any() else None,
                 # What a veto on CHM canopy would erase of the traced visible lawn.
                 "seen_lawn_called_tree": round(float((chm_g[seen_g & within_g] >= TREE_M).mean()), 3) if (seen_g & within_g).any() else None,
                 # Does it see the trees the tracer traced lawn under?
                 "inferred_called_tree": round(float((chm_g[inferred_g & within_g] >= TREE_M).mean()), 3) if (inferred_g & within_g).any() else None}
            if lid is not None:
                lh, lok = lid
                tall = (lh >= LIDAR_TALL_M) & lok
                r["auc_lidar_tall"] = auc(chm_g[lok], tall[lok])
                r["iou_lidar_tall"] = iou(chm_g >= TREE_M, tall) if lok.any() else None
                if tall.any():
                    r["mae_on_lidar_tall_m"] = round(float(np.abs(chm_g[tall] - lh[tall]).mean()), 2)
                    r["bias_on_lidar_tall_m"] = round(float((chm_g[tall] - lh[tall]).mean()), 2)
                if tree is not None:
                    # ROOF AGAINST TREE inside the lidar's tall cells.
                    t_cells, r_cells = tall & tree, tall & ~tree
                    if t_cells.sum() >= 20 and r_cells.sum() >= 20:
                        r["chm_on_tree_m"] = round(float(np.median(chm_g[t_cells])), 1)
                        r["chm_on_roof_m"] = round(float(np.median(chm_g[r_cells])), 1)
                        r["auc_tree_vs_roof"] = auc(chm_g[tall], tree[tall])
            if tree is not None:
                r["iou_tree_mask"] = iou(chm_g >= TREE_M, tree)
            row[f"{s:g}"] = r
        np.savez_compressed(out / "maps" / f"{lot.replace(':', '_').replace(',', '_')}.npz", **maps)
        rows.append(row)
        if shown < 16:
            shown += 1
            key = f"{SCALES[0]:g}"
            pic = np.asarray(photo_full.resize((W * 2, H * 2), Image.BILINEAR))
            def heat(a):
                v = np.clip(resize(a, W * 2, H * 2) / 20.0, 0, 1)
                rgb = np.stack([v * 255, (1 - np.abs(v - 0.5) * 2) * 200, (1 - v) * 180], -1)
                return rgb.astype(np.uint8)
            panes = [pic, heat(resize(maps[key].astype(np.float32), W, H))]
            if lid is not None:
                panes.append(heat(lid[0]))
            Image.fromarray(np.concatenate(panes, 1)).save(out / f"{shown:02d}-{lot.replace(':', '_').replace(',', '_')}.jpg", quality=80)
        first = row[f"{SCALES[0]:g}"]
        print(f"  {row['tag'] or '   '} {lot[:40]:40s} {row['metres']:4d} m  max {first['max_m']:5.1f} m"
              + (f"  AUC tall {first['auc_lidar_tall']:.2f}" if first.get("auc_lidar_tall") is not None else "")
              + (f"  tree {first['chm_on_tree_m']} m / roof {first['chm_on_roof_m']} m" if "chm_on_roof_m" in first else ""),
              flush=True)

    (out / "lots.json").write_text(json.dumps(rows, indent=1))

    def med(key, field, where=None):
        v = [r[key][field] for r in rows if (where is None or where(r)) and r[key].get(field) is not None]
        return (np.median(v), len(v)) if v else (None, 0)

    print(f"\nCHMv2 ON {len(rows)} LOTS ({sum(r['lidar'] for r in rows)} with lidar, {sum(r['tree'] for r in rows)} with a tree mask).")
    for s in SCALES:
        k = f"{s:g}"
        print(f"\n  AT {s:g} m A PIXEL (median over lots):")
        for field, label in [("auc_lidar_tall", "AUC: CHM height for the lidar's 2.5 m+ cells against the rest (0.5 coin toss)"),
                             ("iou_lidar_tall", "IoU: CHM >= 2 m against the lidar's 2.5 m+"),
                             ("mae_on_lidar_tall_m", "MAE in metres on the lidar's tall cells"),
                             ("bias_on_lidar_tall_m", "bias in metres on the lidar's tall cells (negative = CHM reads lower)"),
                             ("iou_tree_mask", "IoU: CHM >= 2 m against the tree model's canopy"),
                             ("auc_tree_vs_roof", "ROOF AGAINST TREE: AUC of CHM height, tree-mask cells vs the rest, inside the lidar's tall cells"),
                             ("chm_on_tree_m", "  median CHM on tree cells (m)"),
                             ("chm_on_roof_m", "  median CHM on roof cells (m)"),
                             ("seen_lawn_called_tree", "share of the traced VISIBLE lawn CHM calls 2 m+ (a veto would erase it)"),
                             ("inferred_called_tree", "share of the ground traced 'under trees' CHM calls 2 m+")]:
            m, n = med(k, field)
            if m is not None:
                print(f"    {label:100s} {m:7.3f}  ({n} lots)")
    print("\n  The bar, written before the run: a tree-vs-roof AUC past 0.8 inside the lidar's tall cells makes CHMv2 a roof")
    print("  separator worth a trial as a stage 3 / veto input; a lidar-tall AUC past 0.9 makes it a canopy source where")
    print("  the lidar is old or missing. Below those it is a curiosity.")


if __name__ == "__main__":
    sys.exit(main())
