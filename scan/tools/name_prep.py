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
    vis, ms = T.lift_by_depth(w["xyz0"], sel, obj, depths, 24.4) if by_depth else S.lift(w["xyz0"], sel, obj)
    off, comp, joined = S.merge(vis, ms, cams)
    pictures, things = [], {}
    for p, (k, m) in enumerate(zip(sel, obj)):
        ids, px = np.unique(m[m > 0], return_counts=True)
        pts = np.bincount(ms[p], minlength=int(m.max()) + 1) if len(ms[p]) else np.zeros(int(m.max()) + 1, int)
        shapes = {}
        for i, n in zip(ids, px):
            i = int(i)
            # a shape no point fell in was never lifted (its id may lie past this picture's nodes): a thing of its own
            th = int(comp[off[p] + i]) if off[p] + i < off[p + 1] else int(off[-1] + p * 100000 + i)
            shapes[str(i)] = [th, int(n), int(pts[i]) if i < len(pts) else 0]
            t = things.setdefault(th, {"photos": 0, "points": 0, "pixels": 0})
            t["photos"] += 1
            t["points"] += shapes[str(i)][2]
            t["pixels"] += int(n)
        rg = np.zeros((*m.shape, 3), np.uint8)
        rg[..., 0], rg[..., 1] = m >> 8, m & 255
        Image.fromarray(rg).save(os.path.join(d, f"seg-{p:04d}.png"), optimize=True)
        pictures.append({"photo": k["name"], "t": k["t"], "shapes": shapes})
    with open(os.path.join(d, "seg.json"), "w") as f:
        json.dump({"pictures": pictures, "things": {str(k): v for k, v in things.items()}, "lift": "each picture's own depth, 80 ft" if by_depth else "26 ft"}, f)
    many = sum(1 for t in things.values() if t["photos"] > 1)
    print(f"Ready to name: {len(pictures)} photos, {sum(len(p['shapes']) for p in pictures):,} shapes, {len(things):,} things ({many:,} seen in more than one photo; {100 * joined:.0f}% of shapes joined another photo's). The lift: {'by depth, 80 ft' if by_depth else '26 ft'}.")


if __name__ == "__main__":
    main()
