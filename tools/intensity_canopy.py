"""
S69: THE GROUND'S BRIGHTNESS UNDER A CROWN, CORRECTED THREE WAYS (owner,
2026-11-11: "Even with the trees removed, the tree canopy was very visible.
By the way it alters the brightness of the ground returns... can we, and
should we do something to extract the 'true' intensity from the ground
return?" -- then "I suppose try all 3").

A pulse that meets a crown leaves part of its energy there, so the ground
return under a tree is dimmer than the same ground in the open. H34 measured
the symptom (ground intensity tells lawn from not-lawn at 0.77-0.79 in the
open and 0.45 under canopy) and H97 feeds the decoder the UNCORRECTED
intensity ranked within its frame. Three corrections, each from fields every
3DEP point carries (intensity, return number, number of returns, GPS time):

  lang    Lang et al. 2020: ground + C x the first-of-many intensity above
          it. C is fitted per frame with no labels, as the slope that takes
          the canopy out of the ground picture (least squares of the ground
          intensity on the first-of-many intensity, over cells with both a
          ground return; never negative).
  pulse   the pulse put back together: every return of a pulse (the same GPS
          time) added up, and the sum given to its ground return. NaN
          everywhere when the flight keeps no time.
  group   no physics: each ground return ranked among the frame's ground
          returns with the same number of returns (1, 2, 3+), so a return
          that came through a crown is compared with others that did.

`layers(points, bbox, cell)` wants the WIDE points (lidar_sources.WIDE: x, y,
z, intensity, class, return number, number of returns, gps time) and returns
the three as per-cell means over the ground returns, NaN where a cell has
none, on rasterise()'s grid. It measures; nothing in the model reads it.

`score(...)` is the table: for the raw intensity and each correction, read as
each cell's rank within its own frame (what a model input would be),
  under canopy   lawn against not-lawn where the tree model sees canopy
  visible        the same in the open (the sanity check)
  whole lot      lawn against not-lawn, every cell with a ground return
  crown shows    covered lawn against open lawn: 0.5 means the crown no
                 longer shows in the lawn's brightness (the owner's picture)
"""

import numpy as np

LAYERS = ("intensity", "intensity_lang", "intensity_pulse", "intensity_group")
NAMES = {"intensity": "raw (control)", "intensity_lang": "ground + C x first return",
         "intensity_pulse": "pulse sum", "intensity_group": "ranked by return count"}
MIN_CELLS = 20
MAX_C = 5.0


def _rank01(v):
    """Average ranks 0..1 of a 1-d array (ties share a rank)."""
    n = len(v)
    if n == 0:
        return np.zeros(0)
    u, inv, c = np.unique(v, return_inverse=True, return_counts=True)
    avg = np.cumsum(c) - (c - 1) / 2.0
    return (avg[inv] - 1) / max(1, n - 1)


def lang_c(ground, first):
    """The share of the first-return intensity to add back: -slope of ground on first, over cells with a ground return."""
    ok = ~np.isnan(ground)
    if ok.sum() < 10:
        return 0.0
    g, f = ground[ok].astype(np.float64), first[ok].astype(np.float64)
    var = float(f.var())
    if var <= 0:
        return 0.0
    c = -float(((g - g.mean()) * (f - f.mean())).mean()) / var
    return float(min(MAX_C, max(0.0, c)))


def layers(points, bbox, cell):
    """The three corrected ground-intensity layers, and what was found on the way (info)."""
    w, s, e, n = bbox
    gw = max(1, int(round((e - w) / cell)))
    gh = max(1, int(round((n - s) / cell)))
    nan = lambda: np.full((gh, gw), np.nan, dtype=np.float32)  # noqa: E731
    out = {"intensity_lang": nan(), "intensity_pulse": nan(), "intensity_group": nan()}
    info = {"c": None, "pulses_timed": False, "ground_multi_share": None, "pulse_whole_share": None}
    if points is None or len(points) == 0 or points.shape[1] < 8:
        return out, info
    x, y, inten, cls, ret, nret, gps = (points[:, k] for k in (0, 1, 3, 4, 5, 6, 7))
    keep = (x >= w) & (x < e) & (y > s) & (y <= n)
    x, y, inten, cls, ret, nret, gps = (a[keep] for a in (x, y, inten, cls, ret, nret, gps))
    col = np.minimum(gw - 1, ((x - w) / (e - w) * gw).astype(np.int64))
    row = np.minimum(gh - 1, ((n - y) / (n - s) * gh).astype(np.int64))
    flat = row * gw + col
    size = gw * gh
    ground = cls == 2
    if not ground.any():
        return out, info
    gf = flat[ground]
    ng = np.bincount(gf, minlength=size)
    has = ng > 0

    def cell_mean(values):
        s_ = np.bincount(gf, weights=values, minlength=size)
        return np.where(has, s_ / np.maximum(ng, 1), np.nan).reshape(gh, gw).astype(np.float32)

    g_mean = cell_mean(inten[ground])
    info["ground_multi_share"] = float((nret[ground] > 1).mean())

    # lang: the first-of-many returns that are not themselves ground, a mean per cell (0 where none)
    fom = (ret == 1) & (nret > 1) & ~ground
    nf = np.bincount(flat[fom], minlength=size)
    f_mean = (np.bincount(flat[fom], weights=inten[fom], minlength=size) / np.maximum(nf, 1)).reshape(gh, gw)
    c = lang_c(g_mean, f_mean)
    info["c"] = c
    out["intensity_lang"] = (g_mean + c * f_mean).astype(np.float32)

    # pulse: every return of the pulse added up (the same GPS time), given to its ground return
    if len(gps) and float(np.ptp(gps)) > 0:
        _, inv, counts = np.unique(gps, return_inverse=True, return_counts=True)
        total = np.bincount(inv, weights=inten)
        out["intensity_pulse"] = cell_mean(total[inv[ground]])
        info["pulses_timed"] = True
        info["pulse_whole_share"] = float((counts[inv[ground]] >= nret[ground]).mean())

    # group: ranked among the frame's ground returns with the same number of returns
    grp = np.clip(nret[ground], 1, 3).astype(np.int64)
    r = np.zeros(int(ground.sum()))
    gi = inten[ground]
    for k in (1, 2, 3):
        m = grp == k
        if m.any():
            r[m] = _rank01(gi[m])
    out["intensity_group"] = cell_mean(r)
    return out, info


def frame_rank(v):
    """Each cell's rank among the frame's cells that have a value, 0..1; NaN stays NaN (fuse_layers.frame_rank)."""
    v = np.asarray(v, dtype=np.float64)
    out = np.full(v.shape, np.nan)
    ok = ~np.isnan(v)
    if ok.any():
        out[ok] = _rank01(v[ok])
    return out


def auc(pos, neg):
    """Mann-Whitney AUC, ties half; None when a side is empty (lidar_frame.auc, without scipy)."""
    pos = np.asarray(pos, dtype=np.float64)
    neg = np.asarray(neg, dtype=np.float64)
    pos, neg = pos[~np.isnan(pos)], neg[~np.isnan(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return None
    r = _rank01(np.concatenate([pos, neg])) * (len(pos) + len(neg) - 1) + 1
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


# (name, positive classes, negative classes) in lidar_frame.CLASSES' codes:
# 0 visible lawn, 1 lawn under canopy, 2 not lawn under canopy, 3 not lawn visible
QUESTIONS = (
    ("under canopy", (1,), (2,)),
    ("visible", (0,), (3,)),
    ("whole lot", (0, 1), (2, 3)),
    ("crown shows", (1,), (0,)),
)


def lot_scores(classes, lot_layers):
    """One lot: {layer: {question: (auc, cells+, cells-, ranks+, ranks-)}}, intensity read as its rank in the frame."""
    out = {}
    for k in LAYERS:
        if k not in lot_layers or not np.isfinite(lot_layers[k]).any():
            continue
        r = frame_rank(lot_layers[k])
        out[k] = {}
        for q, pos, neg in QUESTIONS:
            a, b = r[np.isin(classes, pos)], r[np.isin(classes, neg)]
            a, b = a[~np.isnan(a)], b[~np.isnan(b)]
            out[k][q] = (auc(a, b), len(a), len(b), a, b)
    return out


def summarise(lots):
    """Every lot's scores into the table's numbers: pooled AUC, the middle lot, how many lots read above 0.5."""
    table = {}
    for k in LAYERS:
        table[k] = {}
        for q, _, _ in QUESTIONS:
            have = [s[k][q] for s in lots if k in s]
            pos = np.concatenate([h[3] for h in have]) if have else np.zeros(0)
            neg = np.concatenate([h[4] for h in have]) if have else np.zeros(0)
            per = [h[0] for h in have if h[0] is not None and min(h[1], h[2]) >= MIN_CELLS]
            table[k][q] = {
                "pooled": auc(pos, neg), "cells": [int(len(pos)), int(len(neg))],
                "median": float(np.median(per)) if per else None,
                "lots": len(per), "above": int(sum(1 for v in per if v > 0.5)),
                "per_lot": per,
            }
    return table


def paired(table, lots, question="under canopy"):
    """Against the raw control, lot by lot: how many lots a correction moved further from 0.5 in the raw's direction of 'lawn brighter' (above 0.5)."""
    out = {}
    for k in LAYERS[1:]:
        better = worse = level = 0
        diffs = []
        for s in lots:
            if "intensity" not in s or k not in s:
                continue
            a, b = s["intensity"][question], s[k][question]
            if a[0] is None or b[0] is None or min(a[1], a[2], b[1], b[2]) < MIN_CELLS:
                continue
            d = b[0] - a[0]
            diffs.append(d)
            if d > 0.01:
                better += 1
            elif d < -0.01:
                worse += 1
            else:
                level += 1
        out[k] = {"better": better, "worse": worse, "level": level,
                  "median_change": float(np.median(diffs)) if diffs else None}
    return out


def fmt(v):
    return "  -  " if v is None else f"{v:.2f}"


def print_table(lots, infos):
    table = summarise(lots)
    print("\nS69: THE GROUND'S BRIGHTNESS UNDER A CROWN, RAW AND CORRECTED THREE WAYS")
    print("AUC, 0.5 is a coin toss; each cell read as its rank within its own frame.")
    print("Pooled over every cell | the middle lot | lots above 0.5 of those with 20+ cells a side.\n")
    for q, _, _ in QUESTIONS:
        note = {"under canopy": "lawn vs not-lawn under the trees (H34: 0.45 raw). Higher = the signal is back.",
                "visible": "lawn vs not-lawn in the open (H34: 0.77-0.79). A correction should not cost this.",
                "whole lot": "lawn vs not-lawn, every cell with a ground return: what one ranked input sees.",
                "crown shows": "covered lawn vs open lawn. 0.5 = the crown no longer shows; below = covered lawn is darker."}[q]
        print(f"  {q.upper()}: {note}")
        for k in LAYERS:
            t = table[k][q]
            print(f"    {NAMES[k]:28} {fmt(t['pooled'])} pooled ({t['cells'][0]} / {t['cells'][1]} cells)   "
                  f"{fmt(t['median'])} middle   {t['above']} of {t['lots']} lots above 0.5")
        print()
    for q in ("under canopy", "whole lot"):
        p = paired(table, lots, q)
        print(f"  AGAINST THE RAW CONTROL, LOT BY LOT ({q}; better = AUC up by more than 0.01):")
        for k in LAYERS[1:]:
            v = p[k]
            print(f"    {NAMES[k]:28} {v['better']} better / {v['worse']} worse / {v['level']} level   "
                  f"median change {'  -  ' if v['median_change'] is None else format(v['median_change'], '+.3f')}")
        print()
    timed = sum(1 for i in infos if i.get("pulses_timed"))
    cs = [i["c"] for i in infos if i.get("c") is not None]
    multi = [i["ground_multi_share"] for i in infos if i.get("ground_multi_share") is not None]
    whole = [i["pulse_whole_share"] for i in infos if i.get("pulse_whole_share") is not None]
    print(f"  {len(infos)} lots read wide; pulses could be put together (GPS time) on {timed}.")
    if cs:
        print(f"  The share of first-return intensity added back (C): middle {np.median(cs):.2f}, "
              f"{sum(1 for c in cs if c == 0)} lots at 0 (no canopy slope to remove), {sum(1 for c in cs if c >= MAX_C)} at the cap.")
    if multi:
        print(f"  Ground returns that shared their pulse with another return: middle lot {100 * np.median(multi):.0f}%.")
    if whole:
        print(f"  Ground returns whose whole pulse was inside the frame: middle lot {100 * np.median(whole):.0f}%.")
    return table
