"""
H47's fair half. Workflow 23 judged each crown segment by its distance to,
and border of, VISIBLE LAWN -- and the visible lawn it used was the tracer's.
The pipeline never has that. This re-runs the same segments with the
detector's held-out answer outside the canopy as the visible lawn, beside the
tracer's version, on the same lots, so the difference is the leak.

Run in workflow 14 after tools/train-detector.js, which writes PRED_OUT.

    LIDAR=lidar PRED=preds-out python3 tools/segments_pred.py
"""

import math
import os
from pathlib import Path

import numpy as np

import crowns_lidar
from lidar_frame import print_segments, shrink_mask


def lat_of(lawn_id):
    """Map ids are 'lng,lat:...'."""
    try:
        return float(lawn_id.split(",")[1].split(":")[0])
    except (IndexError, ValueError):
        return None


def segments_for(z, pred, cell, k):
    """Truth-edge and detector-edge segments for one lot's npz arrays."""
    cls = z["classes"]
    h = z["height"]
    can = (cls == 1) | (cls == 2)
    lawn = (cls == 0) | (cls == 1)
    within = cls >= 0
    tops = crowns_lidar.tree_tops(h, cell)
    truth = crowns_lidar.crown_segments(can, tops, lawn, cls == 0, cell * k, chm=h)
    seen = pred & within & ~can
    det = crowns_lidar.crown_segments(can, tops, lawn, seen, cell * k, chm=h)
    return truth, det


def main():
    from PIL import Image
    lidar = Path(os.environ.get("LIDAR", "lidar"))
    preds = Path(os.environ.get("PRED", "preds-out"))
    cell = float(os.environ.get("CELL_M", "2"))
    truth_all, det_all, n = [], [], 0
    for f in sorted(lidar.glob("*.npz")):
        lawn_id = f.stem
        p = preds / f"{lawn_id}-pred.png"
        lat = lat_of(lawn_id)
        if not p.exists() or lat is None:
            continue
        z = np.load(f)
        gh, gw = z["classes"].shape
        pred = shrink_mask(np.asarray(Image.open(p).convert("L")) >= 128, gw, gh)
        t, d = segments_for(z, pred, cell, math.cos(math.radians(lat)))
        truth_all.append({"segments": t})
        det_all.append({"segments": d})
        n += 1
    print(f"\nH47 ON {n} LOTS WITH BOTH A POINT CLOUD AND A HELD-OUT MASK.")
    if not n:
        print("  Nothing to compare: no lot had both. (Is PRED_OUT set on the detector step?)")
        return
    print("\n--- (a) VISIBLE LAWN = THE TRACER'S (what workflow 23 measured; the pipeline never has this) ---")
    print_segments(truth_all)
    print("--- (b) VISIBLE LAWN = THE DETECTOR'S HELD-OUT ANSWER OUTSIDE THE CANOPY (the fair one) ---")
    print_segments(det_all)


if __name__ == "__main__":
    main()
