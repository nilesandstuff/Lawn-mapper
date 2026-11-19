"""
A WALK'S SHAPES MADE READY FOR THE OWNER TO NAME (core session, 2026-11-19).

The owner: "you let me name all of the segments. I'll name them in the terms that actually put things into categories
that are useful to us and you can see how everything matches and how to rectify the lift from different distances."

The page (scan/public/name.html) shows each photo with its shapes; a name given to a shape goes to the THING the lift
made of it, so it appears on that thing in every other photo, and where it lands wrongly the owner says so on that
one shape: each such correction is a place the lift joined what it should not have, at that distance.

    python scan/tools/name_prep.py twin

From the kept shapes (segments-masks.npz, SAM objects, tidied as segment_study.tidy_shapes), lifted where each
picture's own depth saw (studies.lift_by_depth, 80 ft; the 26 ft lift when the pictures kept no depth). Writes beside
the twin (private):
    seg-NNNN.png   one a photo, in the photos' order: the shape id at each pixel (red = id / 256, green = id % 256)
    seg.json       { pictures: [{ photo, t, shapes: { shape id: [thing, pixels, points] } }], things: { thing:
                     { photos, points } }, lift }
The names the owner gives are kept by the page as seg-names.json. Counts only in the log.
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402
import studies as T        # noqa: E402


REACH = 6        # photos before and after that a photo's shapes are matched against
CELLS_MIN = 8    # depth cells two shapes must share to be one thing
SHARE = 0.5      # ... and this share of what both show of each other


def dense_match(sel, obj, depths):
    """WHICH SHAPES OF DIFFERENT PHOTOS ARE ONE THING, BY THE PHOTOS' OWN DEPTH (2026-11-19). The first matching
    went by the walk's kept points: on the two app walks only 17 and 22 things were found in more than one photo,
    of 5,400 and 6,300, because most shapes hold too few kept points. But every photo keeps a depth grid of its own
    (72 x 128 cells, key-NNNN.depth): each cell is a point in space with a shape under it. A photo's cells are put
    into each of the REACH photos before and after it; where the other photo's depth agrees the cell is seen in
    both, and two shapes sharing SHARE of such cells (CELLS_MIN or more) are one thing.
    -> (off, comp, cells): each photo's first node, node -> thing, depth cells in each node."""
    K = [int(m.max()) + 1 for m in obj]
    off = np.concatenate([[0], np.cumsum(K)])
    parent = np.arange(off[-1])

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    cells = np.zeros(off[-1], np.int64)
    pts, ids = [], []
    # what the matching met, for the log: a walk whose shapes will not match should say why
    D = {"cells": 0, "shaped": 0, "framed": 0, "agree": 0, "both": 0, "pairs": 0}
    best = np.zeros(off[-1])            # each shape's best share with any shape of another photo
    hold = np.zeros(off[-1])            # ... and the most of it that lies inside one
    for p, (k, m, dg) in enumerate(zip(sel, obj, depths)):
        if dg is None:
            pts.append(None)
            ids.append(None)
            continue
        h, w = m.shape
        gy, gx = np.nonzero(dg > 0)
        u, v = (gx + 0.5) * w / dg.shape[1], (gy + 0.5) * h / dg.shape[0]
        ndc = np.stack([u / w * 2 - 1, 1 - v / h * 2, -np.ones(len(u)), np.ones(len(u))], 1)
        cam = ndc @ np.linalg.inv(np.array(k["proj"], dtype=np.float64).reshape(4, 4).T).T
        ray = cam[:, :3] / cam[:, 3:4]
        ray /= np.linalg.norm(ray, axis=1, keepdims=True)
        world = (ray * dg[gy, gx][:, None]) @ k["c2w"][:3, :3].T + k["c2w"][:3, 3]
        sid = m[np.clip(v.astype(int), 0, h - 1), np.clip(u.astype(int), 0, w - 1)].astype(np.int64)
        pts.append(world)
        ids.append(sid)
        cells[off[p]:off[p + 1]] = np.bincount(sid, minlength=K[p])
        D["cells"] += len(sid)
        D["shaped"] += int((sid > 0).sum())
    was = S.RANGE
    S.RANGE = 1e9
    try:
        for p in range(len(sel)):
            if pts[p] is None or not len(pts[p]):
                continue
            x1 = np.concatenate([pts[p], np.ones((len(pts[p]), 1))], 1)
            for q in range(max(0, p - REACH), min(len(sel), p + REACH + 1)):
                if q == p or depths[q] is None:
                    continue
                h, w = obj[q].shape
                dq = depths[q]
                px, py, z, ok = S.project(x1, sel[q], w, h)
                rng = np.linalg.norm(pts[p] - sel[q]["c2w"][:3, 3], axis=1)
                dd = dq[np.clip(py * dq.shape[0] // h, 0, dq.shape[0] - 1), np.clip(px * dq.shape[1] // w, 0, dq.shape[1] - 1)]
                both = ok & (dd > 0) & (np.abs(dd - rng) <= np.maximum(0.25, 0.08 * dd))
                D["pairs"] += 1
                D["framed"] += int(ok.sum())
                D["agree"] += int(both.sum())
                if both.sum() < CELLS_MIN:
                    continue
                a, b = ids[p][both], obj[q][py[both], px[both]].astype(np.int64)
                na, nb = np.bincount(a, minlength=K[p]), np.bincount(b, minlength=K[q])
                on = (a > 0) & (b > 0)
                if not on.any():
                    continue
                D["both"] += int(on.sum())
                uq, c = np.unique(a[on] * K[q] + b[on], return_counts=True)
                ua, ub = uq // K[q], uq % K[q]
                share = c / (na[ua] + nb[ub] - c)
                big = c >= CELLS_MIN
                np.maximum.at(best, off[p] + ua[big], share[big])
                np.maximum.at(hold, off[p] + ua[big], (c / na[ua])[big])
                good = big & (share >= SHARE)
                for x, y in zip(ua[good], ub[good]):
                    rx, ry = find(off[p] + x), find(off[q] + y)
                    if rx != ry:
                        parent[ry] = rx
    finally:
        S.RANGE = was
    present = np.zeros(off[-1], bool)
    for p, m in enumerate(obj):
        present[off[p] + np.unique(m[m > 0])] = True
    has = present & (cells >= CELLS_MIN)
    n = max(1, int(has.sum()))
    print(f"Matching by depth: {D['cells'] / max(1, len(sel)):.0f} depth cells a photo, {100 * D['shaped'] / max(1, D['cells']):.0f}% of them under a shape. Put into a neighbouring photo, "
          f"{100 * D['framed'] / max(1, D['cells'] * 2 * REACH):.0f}% fall inside it and {100 * D['agree'] / max(1, D['framed']):.0f}% of those meet its depth; {100 * D['both'] / max(1, D['agree']):.0f}% of those lie under a shape in both.")
    print(f"  Of the {n:,} shapes with {CELLS_MIN} cells or more: best share with a shape of another photo {SHARE:g} or more: {100 * (best[has] >= SHARE).sum() / n:.0f}%; 0.3-{SHARE:g}: {100 * ((best[has] >= 0.3) & (best[has] < SHARE)).sum() / n:.0f}%; "
          f"under 0.3: {100 * ((best[has] > 0) & (best[has] < 0.3)).sum() / n:.0f}%; met no shape: {100 * (best[has] == 0).sum() / n:.0f}%. Lying 70% or more inside one shape of another photo: {100 * (hold[has] >= 0.7).sum() / n:.0f}%. "
          f"Shapes under {CELLS_MIN} cells (too small or no depth under them): {int((present & ~has).sum()):,}.")
    return off, np.array([find(i) for i in range(off[-1])]), cells


def main():
    from PIL import Image
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    mf = os.path.join(d, "segments-masks.npz")
    if not os.path.exists(mf):
        print("No kept shapes for this walk (workflow S3 makes them): nothing to name.")
        return
    w = T.load(d)
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj = T.tidied(z)
    cams = np.array([k["c2w"][:3, 3] for k in sel])
    depths = [T.read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    by_depth = sum(x is not None for x in depths) >= 0.8 * len(sel)
    if by_depth:
        off, comp, cells = dense_match(sel, obj, depths)
    else:
        vis, ms = S.lift(w["xyz0"], sel, obj)
        off, comp, _ = S.merge(vis, ms, cams)
        cells = np.zeros(off[-1], np.int64)
        for p in range(len(sel)):
            if len(ms[p]):
                c = np.bincount(ms[p])
                cells[off[p]:off[p] + len(c)] = c
    pictures, things = [], {}
    for p, (k, m) in enumerate(zip(sel, obj)):
        ids, px = np.unique(m[m > 0], return_counts=True)
        shapes = {}
        for i, n in zip(ids, px):
            i = int(i)
            # a shape past this photo's nodes (the old lift numbers only the shapes points fell in): a thing of its own
            th = int(comp[off[p] + i]) if off[p] + i < off[p + 1] else int(off[-1] + p * 100000 + i)
            shapes[str(i)] = [th, int(n), int(cells[off[p] + i]) if off[p] + i < off[p + 1] else 0]
            t = things.setdefault(th, {"photos": 0, "points": 0, "pixels": 0})
            t["photos"] += 1
            t["points"] += shapes[str(i)][2]
            t["pixels"] += int(n)
        rg = np.zeros((*m.shape, 3), np.uint8)
        rg[..., 0], rg[..., 1] = m >> 8, m & 255
        Image.fromarray(rg).save(os.path.join(d, f"seg-{p:04d}.png"), optimize=True)
        pictures.append({"photo": k["name"], "t": k["t"], "shapes": shapes})
    with open(os.path.join(d, "seg.json"), "w") as f:
        json.dump({"pictures": pictures, "things": {str(k): v for k, v in things.items()}, "lift": "by each photo's own depth, against the six photos before and after it" if by_depth else "by the walk's kept points, 26 ft"}, f)
    many = [t for t in things.values() if t["photos"] > 1]
    n_shapes = sum(len(p["shapes"]) for p in pictures)
    in_many = sum(t["photos"] for t in many)
    big = sorted((t["photos"] for t in many), reverse=True)[:8]
    print(f"Ready to name: {len(pictures)} photos, {n_shapes:,} shapes, {len(things):,} things; {len(many):,} things are seen in more than one photo and hold {in_many:,} of the shapes ({100 * in_many / max(1, n_shapes):.0f}%); the most-seen are in {', '.join(str(x) for x in big)} photos. Matched {'by each photo own depth' if by_depth else 'by the kept points'}.")


if __name__ == "__main__":
    main()
