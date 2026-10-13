"""
S38: IS THE LIDAR'S BRIGHTNESS RIGHT WHERE THE DETECTOR IS WRONG? (owner,
2026-10-13: "Could lidar brightness provide more clarity about ground cover
type?")

H34 already measured ground intensity in the open: it tells lawn from
not-lawn moderately (AUC 0.77-0.79, lawn brighter) -- but so does the photo,
and NAIP's near-infrared, a better-behaved version of the same kind of
signal, added nothing measurable on top of it (H50). So the question is not
"can intensity tell lawn from pavement" but "does it know anything the
detector does not". The honest form: among the cells the detector's
HELD-OUT answer calls lawn, does intensity tell the true lawn from the false;
and among the cells it calls not-lawn, does it tell the missed lawn from the
true not-lawn. Coin tosses there (0.5) mean intensity repeats what the photo
already said, and an input made of it has nothing to teach.

WHAT IT READS. Workflow 14's own layers, after tools/train-detector.js:
lidar/<id>.npz (lidar_frame.py: per 2 m cell, the class from the tracer's
labels and the tree model -- 0 visible lawn, 3 not lawn in the open -- and
the mean intensity of the GROUND returns, NaN where none came back) and
preds-out/<id>-pred.png (THE PLAN row's held-out mask; outside the canopy it
is stage 1's own answer). Only cells in the open, inside the line: under the
trees H34 already found intensity a coin toss.

INTENSITY RELATIVE TO ITS FLIGHT. 3DEP intensity is on each project's own
scale (gain, range, wavelength: most fly 1064 nm, some 1550 nm), so a raw
number means nothing across lots. Each cell is read as its RANK among every
cell of the same frame with a ground return (0 darkest, 1 brightest); a frame
is one project. A model input would have to be the same.

THE BAR, written before the run (docs/DETECTOR-FINDINGS.md S38). Intensity
earns the input trial (six runs of workflow 14) only if, in both seeds, one
of the two conditional AUCs reads 0.60 or more pooled (or 0.40 or less), the
lots with 20+ cells a side agree on its direction two times in three, and
the hardest third of lots reads at least as far from 0.5. Under 0.55 pooled
on both, S38 is closed.

    LIDAR=lidar PRED=preds-out python3 tools/intensity_errors.py
"""

import json
import os
from pathlib import Path

import numpy as np

from lidar_frame import auc, shrink_mask

OPEN_LAWN, OPEN_NOT = 0, 3
MIN_CELLS = 20
QUESTIONS = (
    ("all", "lawn vs not, every open cell (H34's sanity check)"),
    ("said_lawn", "called lawn: true lawn vs false lawn"),
    ("said_not", "called not-lawn: missed lawn vs true not-lawn"),
)


def scene_rank(intensity):
    """Each cell's rank among the frame's cells with a ground return, 0..1; NaN stays NaN."""
    v = np.asarray(intensity, dtype=np.float64)
    out = np.full(v.shape, np.nan)
    ok = ~np.isnan(v)
    n = int(ok.sum())
    if n == 0:
        return out
    from scipy.stats import rankdata
    r = rankdata(v[ok])
    out[ok] = (r - 1) / max(1, n - 1)
    return out


def lot_sides(classes, rank, pred):
    """
    The open cells inside the line, split three ways, each as (lawn ranks,
    not-lawn ranks). Cells with no ground return have no intensity and sit
    out; how many of the detector's errors that leaves silent is counted.
    """
    open_ = (classes == OPEN_LAWN) | (classes == OPEN_NOT)
    lawn = classes == OPEN_LAWN
    has = ~np.isnan(rank)
    wrong = open_ & (lawn != pred)
    sides = {
        "all": (rank[open_ & lawn & has], rank[open_ & ~lawn & has]),
        "said_lawn": (rank[open_ & pred & lawn & has], rank[open_ & pred & ~lawn & has]),
        "said_not": (rank[open_ & ~pred & lawn & has], rank[open_ & ~pred & ~lawn & has]),
    }
    counts = {
        "open": int(open_.sum()),
        "wrong": int(wrong.sum()),
        "wrong_silent": int((wrong & ~has).sum()),
        "false_lawn": int((open_ & pred & ~lawn).sum()),
        "missed_lawn": int((open_ & ~pred & lawn).sum()),
    }
    return sides, counts


def summarise(lots):
    """
    lots: [{"id", "sides", "counts"}]. Per question: the pooled AUC over every
    lot's ranks, the median of per-lot AUCs over lots with MIN_CELLS a side,
    how many of those read above 0.5, and the same for the hardest third of
    lots by their open-cell error rate.
    """
    def err_rate(l):
        return l["counts"]["wrong"] / max(1, l["counts"]["open"])

    ranked = sorted(lots, key=err_rate)
    hard = ranked[len(ranked) - len(ranked) // 3:] if len(ranked) >= 3 else ranked
    hard_ids = {l["id"] for l in hard}
    out = {}
    for q, _ in QUESTIONS:
        row = {}
        for name, group in (("every lot", lots), ("hardest third", [l for l in lots if l["id"] in hard_ids])):
            pos = np.concatenate([l["sides"][q][0] for l in group]) if group else np.array([])
            neg = np.concatenate([l["sides"][q][1] for l in group]) if group else np.array([])
            per = [auc(*l["sides"][q]) for l in group
                   if len(l["sides"][q][0]) >= MIN_CELLS and len(l["sides"][q][1]) >= MIN_CELLS]
            per = [a for a in per if a is not None]
            row[name] = {
                "pooled": auc(pos, neg),
                "cells": [int(len(pos)), int(len(neg))],
                "lots": len(per),
                "median": float(np.median(per)) if per else None,
                "above_half": sum(a > 0.5 for a in per),
            }
        out[q] = row
    return out


def verdict(summary):
    """The bar, as written in S38. 'trial', 'closed' or 'weak'."""
    def clears(r):
        p, m = r["every lot"]["pooled"], r["every lot"]
        h = r["hardest third"]["pooled"]
        if p is None or not m["lots"] or h is None:
            return False
        far = abs(p - 0.5)
        agree = max(m["above_half"], m["lots"] - m["above_half"]) / m["lots"]
        same_way = (p - 0.5) * (h - 0.5) > 0
        return far >= 0.10 and agree >= 2 / 3 and same_way and abs(h - 0.5) >= far
    qs = [summary[q] for q in ("said_lawn", "said_not")]
    if any(clears(r) for r in qs):
        return "trial"
    if all(r["every lot"]["pooled"] is None or abs(r["every lot"]["pooled"] - 0.5) < 0.05 for r in qs):
        return "closed"
    return "weak"


def fmt(a):
    return "  -  " if a is None else f"{a:.2f}"


def main():
    from PIL import Image
    lidar = Path(os.environ.get("LIDAR", "lidar"))
    preds = Path(os.environ.get("PRED", "preds-out"))
    lots = []
    totals = {"open": 0, "wrong": 0, "wrong_silent": 0, "false_lawn": 0, "missed_lawn": 0}
    for f in sorted(lidar.glob("*.npz")):
        lawn_id = f.stem
        p = preds / f"{lawn_id}-pred.png"
        if not p.exists():
            continue
        z = np.load(f)
        if "intensity" not in z.files:
            continue
        classes = z["classes"]
        gh, gw = classes.shape
        pred = shrink_mask(np.asarray(Image.open(p).convert("L")) >= 128, gw, gh)
        sides, counts = lot_sides(classes, scene_rank(z["intensity"]), pred)
        lots.append({"id": lawn_id, "sides": sides, "counts": counts})
        for k in totals:
            totals[k] += counts[k]

    print(f"\nS38 ON {len(lots)} LOTS WITH BOTH A POINT CLOUD AND A HELD-OUT MASK (2 m cells, in the open, inside the line).")
    if not lots:
        print("  Nothing to measure: no lot had both. (Is PRED_OUT set on the detector step?)")
        return
    print(f"  Open cells {totals['open']:,}; the detector wrong on {totals['wrong']:,} "
          f"({totals['false_lawn']:,} false lawn, {totals['missed_lawn']:,} missed lawn); "
          f"{totals['wrong_silent']:,} of the wrong ones have no ground return, so no intensity to say anything.")
    s = summarise(lots)
    print("\n  Ground intensity, ranked within its own frame. AUC: 0.5 is a coin toss; above 0.5 lawn is brighter.\n")
    print(f"  {'':48}{'pooled':>8}{'median':>8}{'lots >0.5':>12}   cells lawn / not")
    for q, label in QUESTIONS:
        for name in ("every lot", "hardest third"):
            r = s[q][name]
            tag = label if name == "every lot" else "   ... hardest third of lots"
            print(f"  {tag:48}{fmt(r['pooled']):>8}{fmt(r['median']):>8}"
                  f"{(str(r['above_half']) + ' of ' + str(r['lots'])):>12}   {r['cells'][0]:,} / {r['cells'][1]:,}")
    v = verdict(s)
    print("\n  S38's bar (written before the run): "
          + {"trial": "MET -- intensity knows something where the detector is wrong; the input trial is next.",
             "closed": "NOT MET, and both questions read within 0.05 of a coin toss -- S38 closed.",
             "weak": "NOT MET -- a signal short of the bar; not worth six runs on this reading."}[v])
    out = os.environ.get("OUT")
    if out:
        Path(out).write_text(json.dumps({"lots": len(lots), "totals": totals, "summary": s, "verdict": v}, indent=1))


if __name__ == "__main__":
    main()
