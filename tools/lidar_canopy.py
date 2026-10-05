"""
TREES FROM THE LIDAR ALONE, in place of the tree model (owner, 2026-10-05:
"the restor/tcd model misses a lot of trees, especially narrow trees ... Next
I'd like to see an attempt to use lidar to replace the tree canopy model all
together").

Reads the per-frame layers tools/tree_lidar.py writes (1 m cells, from every
return of every pulse) and calls a cell TREE when

    it stands at least MIN_H_M over the ground         (height)
    and something says vegetation, on the 3x3 around it:
        pulses split there (multi >= MIN_MULTI)        a crown, leaf-on or bare
        or the survey classed it vegetation            where the survey did
        or first and last returns are far apart        (spread >= MIN_SPREAD_M)
    and the survey did not class it building.

Not the old stage 4 layer. That one was height alone (a DSM over the ground),
which cannot tell a tree from a roof, and filled roofs in as canopy. A roof
returns one echo per pulse; a crown, bare or in leaf, splits them.

DENSE is the part of the tree where few last returns reach the ground (the
3x3 mean of penetration under DENSE_PEN). In a leaf-off flight that is an
evergreen, or foliage so dense and low that grass will not be under it -- the
owner's reading of the crowns it flagged (2026-10-05): "very likely an
evergreen and/or the foliage was so dense and low that there's no way that
grass would be growing under it". In a leaf-on flight a broadleaf is dense
too; the flight's season is shown beside it.

Out: lidar-canopy/<id>.json, the same shape tools/tree-canopy.py writes
(framePx, framePy, metresAcross, clumps of polygon + holes in the photo's
pixels), plus per clump its dense share and height, and `dense`, the dense
patches as outlines of their own.

    FRAMES=frames LIDAR=tree-lidar OUT=lidar-canopy python3 tools/lidar_canopy.py
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from clumps import clumps_for, outlines_for  # noqa: E402

MIN_H_M = float(os.environ.get("MIN_H_M", "2.0"))
MIN_MULTI = float(os.environ.get("MIN_MULTI", "0.15"))
MIN_VEG = 0.5
MIN_SPREAD_M = 1.0
DENSE_PEN = float(os.environ.get("DENSE_PEN", "0.8"))
MIN_CLUMP_M2 = float(os.environ.get("MIN_CLUMP_M2", "2"))
SIMPLIFY_M = 0.3


def _mean3(a, fill):
    """3x3 mean of a layer, its gaps (no points) taken as `fill`."""
    return ndimage.uniform_filter(np.where(np.isfinite(a), a, fill).astype(np.float64), size=3, mode="nearest")


def lidar_canopy(L, cell_m2, min_h=MIN_H_M, min_clump_m2=MIN_CLUMP_M2):
    """(tree, dense) boolean masks on the lidar grid. Pure."""
    h = np.nan_to_num(L["height"], nan=0.0)
    tall = h >= min_h
    vegetation = (_mean3(L["multi"], 0) >= MIN_MULTI) | (_mean3(L["veg_class"], 0) >= MIN_VEG) \
        | (np.nan_to_num(L["spread"], nan=0.0) >= MIN_SPREAD_M)
    roof = _mean3(L["building_class"], 0) >= 0.5
    tree = tall & vegetation & ~roof
    # Close one-cell gaps a sparse cloud leaves inside a crown; NOT an opening,
    # which would delete exactly the narrow trees this is for.
    tree = ndimage.binary_closing(tree, structure=np.ones((3, 3)), border_value=0) & ~roof
    min_cells = max(1, int(round(min_clump_m2 / cell_m2)))
    labels, count = clumps_for(tree)
    if count:
        sizes = np.bincount(labels.ravel())
        small = sizes < min_cells
        small[0] = False
        tree[small[labels]] = False
    # Clearings smaller than a clump are gaps between branches.
    holes = ndimage.binary_fill_holes(tree) & ~tree
    hl, hn = ndimage.label(holes)
    if hn:
        hs = np.bincount(hl.ravel())
        fill = hs < min_cells
        fill[0] = False
        tree |= fill[hl]
    dense = tree & (_mean3(L["penetration"], 1) < DENSE_PEN)
    return tree, dense


def to_photo(mask, fw, fh):
    """A grid mask stretched to the photo's pixels, smoothly (bilinear, half)."""
    gh, gw = mask.shape
    ys = (np.arange(fh) + 0.5) * gh / fh - 0.5
    xs = (np.arange(fw) + 0.5) * gw / fw - 0.5
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    return ndimage.map_coordinates(mask.astype(np.float32), [yy, xx], order=1, mode="nearest") >= 0.5


def outlines(mask, mpp, min_m2):
    """Clumps of a photo-pixel mask as {polygon, holes, areaSqM, px} in [x, y]."""
    labels, count = clumps_for(mask)
    min_px = min_m2 / (mpp * mpp)
    tol = max(1.0, SIMPLIFY_M / mpp)
    out = []
    for k in range(1, count + 1):
        blob = labels == k
        n = int(blob.sum())
        if n < min_px:
            continue
        outer, holes = outlines_for(blob, tol, min_px)
        if outer is None:
            continue
        xy = lambda ring: [[round(float(x), 1), round(float(y), 1)] for y, x in ring]
        out.append({"areaSqM": round(n * mpp * mpp, 1), "polygon": xy(outer), "holes": [xy(r) for r in holes], "blob": blob})
    return out


def main():
    from PIL import Image
    frames = Path(os.environ.get("FRAMES", "frames"))
    lidar = Path(os.environ.get("LIDAR", "tree-lidar"))
    out = Path(os.environ.get("OUT", "lidar-canopy"))
    out.mkdir(parents=True, exist_ok=True)
    scale = json.loads((frames / "scale.json").read_text())
    spans, downs = scale["frames"], scale.get("downs") or {}
    done = 0
    for meta_path in sorted(lidar.glob("*.json")):
        meta = json.loads(meta_path.read_text())
        lawn_id = meta["id"]
        photo = frames / f"{lawn_id}.png"
        across = spans.get(lawn_id)
        if not photo.exists() or not across:
            continue
        gw, gh, names = meta["gw"], meta["gh"], meta["layers"]
        raw = np.fromfile(lidar / f"{meta_path.stem}.f32", dtype="<f4")
        if raw.size != len(names) * gw * gh:
            print(f"  {lawn_id[:28]:30} layers the wrong size, skipped")
            continue
        L = {k: raw[i * gw * gh:(i + 1) * gw * gh].reshape(gh, gw) for i, k in enumerate(names)}
        with Image.open(photo) as im:
            fw, fh = im.size
        down = downs.get(lawn_id) or across * fh / fw
        cell_m2 = (across / gw) * (down / gh)
        tree, dense = lidar_canopy(L, cell_m2)
        mpp = across / fw
        tree_px, dense_px = to_photo(tree, fw, fh), to_photo(dense, fw, fh)
        hgt = to_photo_values(np.nan_to_num(L["height"], nan=0.0), fw, fh)
        clumps = []
        for c in outlines(tree_px, mpp, MIN_CLUMP_M2):
            blob = c.pop("blob")
            ys, xs = np.nonzero(blob)
            c["centre"] = [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]
            c["denseShare"] = round(float(dense_px[blob].mean()), 2)
            c["heightM"] = round(float(np.percentile(hgt[blob], 90)), 1)
            clumps.append(c)
        dense_rings = []
        for c in outlines(dense_px, mpp, MIN_CLUMP_M2):
            c.pop("blob")
            dense_rings.append(c)
        clumps.sort(key=lambda c: -c["areaSqM"])
        (out / f"{meta_path.stem}.json").write_text(json.dumps({
            "id": lawn_id, "model": "lidar", "framePx": fw, "framePy": fh, "metresAcross": round(across, 1),
            "project": meta.get("project"), "year": meta.get("year"),
            "canopySqM": round(float(tree.sum()) * cell_m2, 1), "denseSqM": round(float(dense.sum()) * cell_m2, 1),
            "clumps": clumps, "dense": dense_rings,
        }))
        done += 1
        print(f"  {lawn_id[:28]:30} {len(clumps):3} tree patches, {float(tree.sum()) * cell_m2:6.0f} m² tree,"
              f" {float(dense.sum()) * cell_m2:6.0f} m² dense  {meta.get('project')}")
    print(f"\nLidar trees for {done} frames in {out}/.")


def to_photo_values(a, fw, fh):
    """A grid layer sampled at each photo pixel (nearest cell)."""
    gh, gw = a.shape
    ys = np.minimum(gh - 1, (np.arange(fh) * gh / fh).astype(int))
    xs = np.minimum(gw - 1, (np.arange(fw) * gw / fw).astype(int))
    return a[np.ix_(ys, xs)]


if __name__ == "__main__":
    main()
