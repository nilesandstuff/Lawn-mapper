"""
Stage 4, phase two: what the LiDAR actually says under our lawns.

THE QUESTION, and only the question. Stage 3 (tools/stage3.js) puts lawn back
under the canopy by geometry, and H33 measured it as right where visible lawn
lies on both sides of a tree and blind where it lies on one -- the traced
wood-edge strip, the lawn along a house, and the case the plan names: a
driveway running under a tree, which the camera cannot see and stage 3 will
pave with grass. LiDAR is the one instrument here whose pulses reach the
ground between leaves (E8). So before any of it becomes a rule, this measures
whether what comes back from under the canopy DIFFERS between the ground the
tracer called lawn and the ground they did not.

WHAT IT READS. For every dumped frame with a 3DEP project over it
(lidar-plan.json, from tools/lidar-plan.js), the public Entwine octree is
walked and every node touching the frame's rectangle is downloaded -- a few
MB and a few seconds a lawn, measured on the Kent County project. The points
are rasterised on a COARSE grid, CELL_M metres a cell (2 by default), because
a QL2 collection is about two points a square metre and under one ground
return, so at the detector's 15 cm there is nothing in most cells to read.

THREE LAYERS PER CELL, all from the points and nothing inferred:

    ground returns per m²   how many pulses reached the ground -- under dense
                            canopy, few; over pavement or lawn, most
    ground intensity        how strongly the ground returned, on the project's
                            own scale; asphalt is dark, concrete bright, grass
                            in between, and only a measurement says which
    height above ground     the highest return over the lowest ground return,
                            which is the canopy height model; ~0 on open ground
    understory              of the returns that came back from below 3 m, the
                            share from 0.5 to 3 m above the ground (H36): the
                            layer UNDER a crown. Mown grass under a lawn tree
                            has almost nothing there; a wood's floor has
                            shrubs and saplings. Also over a 6 m square
                            (understory_6m), because a 2 m cell holds a
                            handful of returns and the woods rule decides on
                            an area, not a cell -- H35's lesson was a layer
                            that read well per cell and failed per clump.

THE MEASUREMENT. Each coarse cell is classed from the labels the frame dump
wrote (traced lawn, property line, inferred) and the tree model's canopy mask:

    visible lawn            lawn, no canopy
    lawn under canopy       lawn (traced or inferred), canopy over it
    not lawn, under canopy  canopy, the tracer did not call it lawn
    not lawn, visible       everything else inside the line

and each layer is summarised per class. Then the one number stage 4 turns on:
for cells UNDER CANOPY, how well does each layer tell lawn from not-lawn
(an AUC, 0.5 is a coin toss, 1.0 is perfect), per lawn and pooled -- with the
same figure on VISIBLE ground as the sanity check, because a layer that cannot
tell a lawn from a driveway in the open will not do it under a tree either.

WHAT IT WRITES. lidar/<id>.npz with the layers and the class grid, a grey
picture of the ground intensity beside each, and lidar/summary.json. Nothing
goes to the site; the log's last lines are the answer.

    FRAMES=frames CANOPY=canopy PLAN=lidar-plan.json OUT=lidar python3 tools/lidar_frame.py
"""

import io
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

# The pure functions below take arrays; laspy and PIL are only needed to run.


# ----------------------------------------------------------------- the octree

def node_box(bounds, key):
    """The [west, south, east, north] of one octree node, from its D-X-Y-Z key."""
    d, xi, yi, _ = (int(v) for v in key.split("-"))
    size = (bounds[3] - bounds[0]) / 2 ** d
    return (bounds[0] + xi * size, bounds[1] + yi * size,
            bounds[0] + (xi + 1) * size, bounds[1] + (yi + 1) * size)


def touches(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def walk(hierarchy, bounds, bbox):
    """
    Every node whose box touches bbox, root down, in EPT's own hierarchy.

    `hierarchy(key)` answers the point count of a node, or None when there is
    no such node. EPT stores a subtree's counts in a separate file under the
    subtree's root; the caller's `hierarchy` handles that, and a negative
    count (Entwine's marker for "look in my own file") is resolved there too.
    Points sit at EVERY depth, coarse to fine, so every touching node is
    wanted, not only the leaves.
    """
    wanted = []
    stack = ["0-0-0-0"]
    while stack:
        key = stack.pop()
        count = hierarchy(key)
        if not count or count <= 0:
            continue
        if not touches(node_box(bounds, key), bbox):
            continue
        wanted.append(key)
        d, xi, yi, zi = (int(v) for v in key.split("-"))
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    stack.append(f"{d + 1}-{2 * xi + dx}-{2 * yi + dy}-{2 * zi + dz}")
    return wanted


# --------------------------------------------------------------- the rasters

def rasterise(points, bbox, cell):
    """
    Points (columns x, y, z, intensity, classification) onto a grid of `cell`
    metres over bbox, rows from the NORTH down so it lines up with the frame's
    pixels. Returns the per-cell layers; NaN where a cell has nothing.
    """
    w, s, e, n = bbox
    gw = max(1, int(round((e - w) / cell)))
    gh = max(1, int(round((n - s) / cell)))
    out = {
        "n_all": np.zeros((gh, gw), dtype=np.int32),
        "n_ground": np.zeros((gh, gw), dtype=np.int32),
        "i_ground": np.full((gh, gw), np.nan, dtype=np.float32),
        "z_ground": np.full((gh, gw), np.nan, dtype=np.float32),
        "z_max": np.full((gh, gw), np.nan, dtype=np.float32),
        "z_min": np.full((gh, gw), np.nan, dtype=np.float32),
        "n_water": np.zeros((gh, gw), dtype=np.int32),
    }
    if points is None or len(points) == 0:
        return out
    x, y, z, inten, cls = (points[:, k] for k in range(5))
    keep = (x >= w) & (x < e) & (y > s) & (y <= n)
    x, y, z, inten, cls = x[keep], y[keep], z[keep], inten[keep], cls[keep]
    col = np.minimum(gw - 1, ((x - w) / (e - w) * gw).astype(np.int64))
    row = np.minimum(gh - 1, ((n - y) / (n - s) * gh).astype(np.int64))
    flat = row * gw + col
    out["n_all"] = np.bincount(flat, minlength=gw * gh).reshape(gh, gw).astype(np.int32)
    zmax = np.full(gw * gh, -np.inf)
    np.maximum.at(zmax, flat, z)
    out["z_max"] = np.where(np.isfinite(zmax), zmax, np.nan).reshape(gh, gw).astype(np.float32)
    zmin_all = np.full(gw * gh, np.inf)
    np.minimum.at(zmin_all, flat, z)
    out["z_min"] = np.where(np.isfinite(zmin_all), zmin_all, np.nan).reshape(gh, gw).astype(np.float32)
    out["n_water"] = np.bincount(flat[cls == 9], minlength=gw * gh).reshape(gh, gw).astype(np.int32)
    ground = cls == 2
    if ground.any():
        gf = flat[ground]
        ng = np.bincount(gf, minlength=gw * gh)
        out["n_ground"] = ng.reshape(gh, gw).astype(np.int32)
        isum = np.bincount(gf, weights=inten[ground], minlength=gw * gh)
        with np.errstate(invalid="ignore", divide="ignore"):
            out["i_ground"] = np.where(ng > 0, isum / np.maximum(ng, 1), np.nan).reshape(gh, gw).astype(np.float32)
        zmin = np.full(gw * gh, np.inf)
        np.minimum.at(zmin, gf, z[ground])
        out["z_ground"] = np.where(np.isfinite(zmin), zmin, np.nan).reshape(gh, gw).astype(np.float32)
    return out


def fill_surface(z, rounds=50):
    """
    A ground surface everywhere, from the cells that have a ground return:
    each empty cell takes the mean of its filled 3x3 neighbours, repeated
    until nothing is empty or `rounds` is up. Ground is smooth at 2 m, so a
    neighbour's height is a fair guess; under a dense crown this is the guess
    the canopy height is measured against, and it is only ever a few cells
    from a real return.
    """
    z = z.astype(np.float32).copy()
    for _ in range(rounds):
        empty = np.isnan(z)
        if not empty.any():
            break
        padded = np.pad(z, 1, mode="edge")
        acc = np.zeros_like(z)
        cnt = np.zeros_like(z)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                v = padded[dy:dy + z.shape[0], dx:dx + z.shape[1]]
                ok = ~np.isnan(v)
                acc[ok] += v[ok]
                cnt[ok] += 1
        fillable = empty & (cnt > 0)
        z[fillable] = acc[fillable] / cnt[fillable]
    return z


def layers_from(raster, cell):
    """The three layers stage 4 reads, from the raw raster."""
    ground = fill_surface(raster["z_ground"])
    height = raster["z_max"] - ground
    height = np.where(np.isnan(height), 0.0, np.maximum(0.0, height)).astype(np.float32)
    return {
        "ground_per_m2": (raster["n_ground"] / (cell * cell)).astype(np.float32),
        "intensity": raster["i_ground"],
        "height": height,
        "ground_z": ground,
        "n_ground": raster["n_ground"],
        "n_all": raster["n_all"],
    }


UNDER_LO, UNDER_HI = 0.5, 3.0


def understory_counts(points, bbox, cell, ground_z, lo=UNDER_LO, hi=UNDER_HI):
    """
    Per cell, on the same grid as rasterise(): how many returns came back
    from below `hi` metres above the ground surface (`ground_z`, filled),
    and how many of those from `lo` to `hi`. Ground-classified points count
    as below `lo` whatever their height; everything else is sorted by its
    own height over its cell's ground.
    """
    gh, gw = ground_z.shape
    below = np.zeros((gh, gw), dtype=np.int32)
    mid = np.zeros((gh, gw), dtype=np.int32)
    if points is None or len(points) == 0:
        return below, mid
    w, s, e, n = bbox
    x, y, z, cls = points[:, 0], points[:, 1], points[:, 2], points[:, 4]
    keep = (x >= w) & (x < e) & (y > s) & (y <= n)
    x, y, z, cls = x[keep], y[keep], z[keep], cls[keep]
    col = np.minimum(gw - 1, ((x - w) / (e - w) * gw).astype(np.int64))
    row = np.minimum(gh - 1, ((n - y) / (n - s) * gh).astype(np.int64))
    g = ground_z[row, col]
    ok = ~np.isnan(g)
    hag = np.where(ok, z - np.nan_to_num(g), np.nan)
    hag = np.where(cls == 2, 0.0, hag)
    is_below = ok & (hag < hi)
    is_mid = is_below & (hag >= lo) & (cls != 2)
    flat = row * gw + col
    below = np.bincount(flat[is_below], minlength=gw * gh).reshape(gh, gw).astype(np.int32)
    mid = np.bincount(flat[is_mid], minlength=gw * gh).reshape(gh, gw).astype(np.int32)
    return below, mid


def box_sum(a, r=1):
    """Sum over the (2r+1)-square around each cell, zero beyond the edge."""
    a = a.astype(np.float64)
    p = np.pad(a, r)
    out = np.zeros_like(a)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            out += p[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return out


def understory_layers(below, mid):
    """The share per cell and over the 3-cell square (6 m at 2 m cells); NaN where nothing came back low."""
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(below > 0, mid / np.maximum(below, 1), np.nan).astype(np.float32)
        b6, m6 = box_sum(below), box_sum(mid)
        share6 = np.where(b6 > 0, m6 / np.maximum(b6, 1), np.nan).astype(np.float32)
    return {"understory": share, "understory_6m": share6}


# ---------------------------------------------------------------- the masks
#
# THREE THINGS THE LIDAR MAY SAY OUTRIGHT, each a yes/no per cell, with the
# thresholds fixed on 2026-09-25 before any of them was read on real frames:
#
#   roof          no pulse reached the ground, the top is 2.5 m or more up,
#                 and every return in the cell is within 1.5 m of the others:
#                 a flat-ish solid thing above head height. A crown lets some
#                 pulses through (H34: 95-100% of canopy cells have ground)
#                 and spreads its returns down through the branches. Three
#                 returns at least, or two hits on one crown top would pass.
#   void          nothing came back over the 6 m square, or most of what did
#                 is classed water (9): open water swallows the pulse. For
#                 the pond the detector reads as lawn (owner, 2026-09-25).
#   lidar canopy  2 m or more above ground and not a roof: the canopy height
#                 model's own canopy, flown leaf-off, blind to shadow, and
#                 years older than the photograph (H16). For the tree strips
#                 the tree model misses (owner, 2026-09-25: Kent 8,626).

ROOF_MIN_M, ROOF_SPREAD_M, ROOF_MIN_RETURNS = 2.5, 1.5, 3
CANOPY_MIN_M = 2.0


# Below this share of cells with any return, a frame has no lidar (see main).
MIN_COVERED = 0.5
# "Nothing came back" means water only where the lidar otherwise covers the
# frame; in a patchy one it means a gap in the data.
VOID_NEEDS_COVERED = 0.9


def masks_from(raster, layers):
    n_all, n_ground = raster["n_all"], raster["n_ground"]
    spread = np.nan_to_num(raster["z_max"] - raster["z_min"], nan=99.0)
    roof = (n_ground == 0) & (n_all >= ROOF_MIN_RETURNS) & (layers["height"] >= ROOF_MIN_M) & (spread <= ROOF_SPREAD_M)
    n6, w6 = box_sum(n_all), box_sum(raster["n_water"])
    empty = (n6 == 0) if float((n_all > 0).mean()) >= VOID_NEEDS_COVERED else np.zeros(n_all.shape, dtype=bool)
    void = empty | (w6 * 2 > n6)
    lidar_canopy = (layers["height"] >= CANOPY_MIN_M) & ~roof
    return {"roof": roof, "void": void, "lidar_canopy": lidar_canopy}


MASKS = ("roof", "void", "lidar_canopy")


def mask_shares(classes, masks):
    """Per class, the share of its cells under each mask."""
    out = {}
    for k, name in enumerate(CLASSES):
        m = classes == k
        n = int(m.sum())
        out[name] = {"cells": n, **{mk: (float(masks[mk][m].mean()) if n else None) for mk in masks}}
    return out


def canopy_agreement(within, restor, lidar_canopy):
    """
    Inside the line: cells both call canopy, cells only the lidar does (the
    tree model missed a tree -- or it grew since), cells only the tree model
    does (the lidar says under 2 m: a bed, dark grass, or a tree newer than
    the flight).
    """
    a, b = restor & within, lidar_canopy & within
    both, only_lidar, only_restor = int((a & b).sum()), int((b & ~a).sum()), int((a & ~b).sum())
    union = both + only_lidar + only_restor
    return {"both": both, "only_lidar": only_lidar, "only_restor": only_restor,
            "iou": (both / union) if union else None}


def web_mercator_lat(y):
    return math.degrees(math.atan(math.sinh(y / 6378137.0)))


# --------------------------------------------------------------- the classes

CLASSES = ["visible lawn", "lawn under canopy", "not lawn, under canopy", "not lawn, visible"]


def classify(truth, within, canopy):
    """
    One class code per cell, 0..3 in CLASSES order, -1 outside the line.
    `truth` here is the traced lawn INCLUDING the inferred marks, so lawn the
    tracer knew was under a tree is "lawn under canopy" whether or not the
    tree model found the tree.
    """
    out = np.full(truth.shape, -1, dtype=np.int8)
    inside = within
    out[inside & truth & ~canopy] = 0
    out[inside & truth & canopy] = 1
    out[inside & ~truth & canopy] = 2
    out[inside & ~truth & ~canopy] = 3
    return out


def shrink_mask(mask, gw, gh):
    """A boolean mask at frame pixels onto the coarse grid: majority of the block."""
    from PIL import Image
    im = Image.fromarray((mask.astype(np.uint8) * 255)).resize((gw, gh), Image.BOX)
    return np.asarray(im) >= 128


def height_png(height):
    """Height in metres to bytes, a tenth of a metre a level, clamped at 25.5 m."""
    return np.clip(np.round(np.nan_to_num(height, nan=0.0) * 10), 0, 255).astype(np.uint8)


def auc(pos, neg):
    """
    Mann-Whitney AUC: the chance a random positive scores above a random
    negative, ties counting half. None when either side is empty.
    """
    pos = np.asarray(pos, dtype=np.float64)
    neg = np.asarray(neg, dtype=np.float64)
    pos = pos[~np.isnan(pos)]
    neg = neg[~np.isnan(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return None
    from scipy.stats import rankdata
    ranks = rankdata(np.concatenate([pos, neg]))
    rp = ranks[:len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def summarise(classes, layers):
    """Per class: cells, ground/m², all/m² (from counts), intensity median, height median."""
    rows = {}
    cell_area = None
    for k, name in enumerate(CLASSES):
        m = classes == k
        n = int(m.sum())
        if not n:
            rows[name] = {"cells": 0}
            continue
        inten = layers["intensity"][m]
        rows[name] = {
            "cells": n,
            "ground_per_m2": float(layers["ground_per_m2"][m].mean()),
            "with_ground": float((layers["n_ground"][m] > 0).mean()),
            "intensity_p50": float(np.nanmedian(inten)) if np.isfinite(inten).any() else None,
            "height_p50": float(np.median(layers["height"][m])),
            "understory_p50": _nanmedian(layers["understory"][m]) if "understory" in layers else None,
        }
    return rows


def _nanmedian(v):
    return float(np.nanmedian(v)) if np.isfinite(v).any() else None


SEPARATED = ("ground_per_m2", "intensity", "height", "understory", "understory_6m")


def separations(classes, layers):
    """
    The AUCs: under canopy (lawn vs not) and visible (lawn vs not), for each
    layer. Intensity is compared on cells that have a ground return; density
    and height on every cell. Higher = more lawn-like for density; the sign
    of intensity and height is whatever the data says, so both directions are
    reported as one number above or below 0.5.
    """
    out = {}
    for label, a, b in (("under canopy", 1, 2), ("visible", 0, 3)):
        pa, pb = classes == a, classes == b
        out[label] = {"cells": [int(pa.sum()), int(pb.sum())]}
        for k in SEPARATED:
            out[label][k] = auc(layers[k][pa], layers[k][pb]) if k in layers else None
    return out


# ------------------------------------------------------------------- the run

def fetch(url, tries=3, timeout=90):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network error is retried
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def points_over(base, bbox, limit_nodes=400):
    """Every point of the project inside bbox, as (x, y, z, intensity, class)."""
    import laspy
    ept = json.loads(fetch(f"{base}/ept.json"))
    bounds = ept["bounds"]
    srs = (ept.get("srs") or {}).get("horizontal")
    if str(srs) != "3857":
        raise RuntimeError(f"point cloud is EPSG:{srs}, not 3857; the frame boxes would not line up")
    cache = {}

    def hierarchy(key):
        # The root file holds the top of the tree. A key it does not mention
        # is a node that does not exist, NOT a file to go looking for -- the
        # walk asks about every child of every node it keeps, and most of
        # those are empty. Only a negative count (Entwine's marker that the
        # subtree lives in its own file, named for the node) fetches more.
        if not cache:
            cache.update(json.loads(fetch(f"{base}/ept-hierarchy/0-0-0-0.json")))
        v = cache.get(key)
        if v is not None and v < 0:
            cache.update(json.loads(fetch(f"{base}/ept-hierarchy/{key}.json")))
            v = cache.get(key)
        return v

    nodes = walk(hierarchy, bounds, bbox)
    if len(nodes) > limit_nodes:
        raise RuntimeError(f"{len(nodes)} nodes over one frame; refusing to download a county")
    parts = []
    nbytes = 0
    for key in nodes:
        raw = fetch(f"{base}/ept-data/{key}.laz")
        nbytes += len(raw)
        las = laspy.read(io.BytesIO(raw))
        x, y = np.asarray(las.x), np.asarray(las.y)
        m = (x >= bbox[0]) & (x <= bbox[2]) & (y >= bbox[1]) & (y <= bbox[3])
        if m.any():
            parts.append(np.column_stack([
                x[m], y[m], np.asarray(las.z)[m],
                np.asarray(las.intensity)[m].astype(np.float64),
                np.asarray(las.classification)[m].astype(np.float64),
            ]))
    pts = np.vstack(parts) if parts else np.zeros((0, 5))
    return pts, {"nodes": len(nodes), "mb": nbytes / 1e6, "points": int(len(pts)),
                 "ept_points": ept.get("points")}


def lidar_for(url, bbox, cell=2.0):
    """One frame's lidar for the live server: (layers, masks), or None when
    the project has too few points over the frame (MIN_COVERED), exactly as
    main() treats it. `url` is the EPT url tools/lidar-plan.js picks."""
    base = url.rsplit("/", 1)[0]
    pts, _ = points_over(base, bbox)
    raster = rasterise(pts, bbox, cell)
    if float((raster["n_all"] > 0).mean()) < MIN_COVERED:
        return None
    layers = layers_from(raster, cell)
    return layers, masks_from(raster, layers)


def main():
    from PIL import Image

    frames = Path(os.environ.get("FRAMES", "frames"))
    canopy_dir = Path(os.environ.get("CANOPY", "canopy"))
    plan_file = Path(os.environ.get("PLAN", "lidar-plan.json"))
    out = Path(os.environ.get("OUT", "lidar"))
    cell = float(os.environ.get("CELL_M", "2"))
    limit = int(os.environ.get("LIMIT", "0") or 0)

    scale = json.loads((frames / "scale.json").read_text())
    boxes = scale.get("boxes") or {}
    TAGS.update(scale.get("tags") or {})
    plan = json.loads(plan_file.read_text()) if plan_file.exists() else {}
    if not boxes:
        print("scale.json carries no frame boxes; the dump step writes them since 2026-09-25.")
        sys.exit(1)
    out.mkdir(parents=True, exist_ok=True)

    ids = sorted(boxes)
    if limit:
        ids = ids[:limit]
    print(f"{len(ids)} frames, {cell:g} m cells\n")
    summary = {"cell_m": cell, "lawns": {}}
    pooled = {k: {"under canopy": [[], []], "visible": [[], []]} for k in SEPARATED}
    t_all = time.time()
    # NAIP-CHM (E9), when asked: the index once, then a windowed read a frame.
    naip_files = {}
    if os.environ.get("NAIP_CHM") == "1":
        import naip_chm
        t_ix = time.time()
        try:
            naip_files = naip_chm.read_index({k: boxes[k] for k in ids})
            print(f"NAIP-CHM index read in {time.time() - t_ix:.0f} s: files over "
                  f"{sum(1 for v in naip_files.values() if v)} of {len(ids)} frames.\n")
        except Exception as e:  # noqa: BLE001 - the lidar part still runs
            print(f"NAIP-CHM index could not be read ({str(e)[:80]}); the lidar part runs without it.\n")
    summary["naip_only"] = {}

    for lawn_id in ids:
        label = tagged(lawn_id)[:28].ljust(30)
        p = plan.get(lawn_id)
        if not p or not p.get("url"):
            print(f"  {label} no lidar project over it")
            summary["lawns"][lawn_id] = {"skipped": "no lidar"}
            if naip_files.get(lawn_id):
                rec = naip_without_lidar(lawn_id, boxes[lawn_id], cell, frames, canopy_dir, naip_files[lawn_id], out)
                if rec:
                    summary["naip_only"][lawn_id] = rec
            continue
        labels_file = frames / f"{lawn_id}-labels.png"
        if not labels_file.exists():
            print(f"  {label} no labels beside the frame")
            continue
        bbox = boxes[lawn_id]
        base = p["url"].rsplit("/", 1)[0]
        t0 = time.time()
        try:
            pts, got = points_over(base, bbox)
        except Exception as e:  # noqa: BLE001 - one lawn's failure is reported, not fatal
            print(f"  {label} FAILED: {str(e)[:70]}")
            summary["lawns"][lawn_id] = {"skipped": str(e)[:200]}
            continue

        raster = rasterise(pts, bbox, cell)
        # A PROJECT THAT CLAIMS THE FRAME AND HAS NO POINTS IN IT (Peach
        # County, GA, 2026-09-27: GA_Central_5_2018's footprint covers two lots,
        # twelve nodes are read, zero points fall inside the box). "Nothing came
        # back" everywhere then read as void everywhere, and the veto deleted
        # both lawns whole. A frame whose cells are mostly empty has no lidar,
        # and is written as such: no layers, no masks.
        covered = float((raster["n_all"] > 0).mean())
        if covered < MIN_COVERED:
            print(f"  {label} {p['name']}: points in only {100 * covered:.0f}% of the frame's cells -- treated as no lidar")
            summary["lawns"][lawn_id] = {"skipped": f"points in {100 * covered:.0f}% of cells", "project": p["name"]}
            continue
        layers = layers_from(raster, cell)
        layers.update(understory_layers(*understory_counts(pts, bbox, cell, layers["ground_z"])))
        gh, gw = raster["n_all"].shape

        lab = np.asarray(Image.open(labels_file).convert("RGB"))
        truth = lab[:, :, 0] >= 128
        within = lab[:, :, 1] >= 128
        inferred = lab[:, :, 2] >= 128
        can_file = canopy_dir / f"{lawn_id}-mask.png"
        canopy = (np.asarray(Image.open(can_file).convert("L")) >= 128) if can_file.exists() else np.zeros_like(truth)
        if canopy.shape != truth.shape:
            canopy = np.asarray(Image.fromarray(canopy.astype(np.uint8) * 255).resize((truth.shape[1], truth.shape[0]), Image.NEAREST)) >= 128
        classes = classify(shrink_mask(truth | inferred, gw, gh), shrink_mask(within, gw, gh), shrink_mask(canopy, gw, gh))

        rows = summarise(classes, layers)
        seps = separations(classes, layers)
        masks = masks_from(raster, layers)
        within_c = shrink_mask(within, gw, gh)
        restor_c = shrink_mask(canopy, gw, gh)
        agree = canopy_agreement(within_c, restor_c, masks["lidar_canopy"])
        # S9: crowns per canopy clump from the lidar's CHM (tools/crowns_lidar.py).
        import crowns_lidar
        lawn_c = (classes == 0) | (classes == 1)
        tops_c = crowns_lidar.tree_tops(layers["height"], cell)
        k1 = math.cos(math.radians(web_mercator_lat((bbox[1] + bbox[3]) / 2)))
        clumps_here = crowns_lidar.clump_stats(restor_c & within_c, lawn_c, classes == 0, tops_c,
                                               cell * cell * k1 * k1, chm=layers["height"])
        # H47: the same canopy cut into one segment per crown, each judged as itself.
        segs_here = crowns_lidar.crown_segments(restor_c & within_c, tops_c, lawn_c, classes == 0,
                                                cell * k1, chm=layers["height"])
        naip_rec = None
        if naip_files.get(lawn_id):
            try:
                naip_h, naip_cover = naip_chm.read_height(bbox, gw, gh, naip_files[lawn_id])
                masks["naip_canopy"] = (np.nan_to_num(naip_cover) >= naip_chm.COVER_MIN) & ~masks["roof"]
                layers["naip_height"] = naip_h
                Image.fromarray(height_png(naip_h)).save(out / f"{lawn_id}-naip-height.png")
                k2 = math.cos(math.radians(web_mercator_lat((bbox[1] + bbox[3]) / 2)))
                naip_rec = {"year": naip_files[lawn_id][0][0],
                            "three_way": naip_chm.three_way(within_c, restor_c, masks["lidar_canopy"], masks["naip_canopy"]),
                            "sweep": naip_chm.sweep_counts(
                                dict(naip_chm.READ_COVERS), ~masks["roof"], within_c, restor_c, masks["lidar_canopy"],
                                classes == 0, (layers["height"] >= 4.0) & ~masks["roof"], cell * cell * k2 * k2)}
            except Exception as e:  # noqa: BLE001 - one frame's read failing is reported, not fatal
                naip_rec = {"error": str(e)[:200]}
        # Web Mercator stretches distance by 1/cos(latitude); the frame box is
        # in it, so a coarse cell's true area is cell² × cos².
        k = math.cos(math.radians(web_mercator_lat((bbox[1] + bbox[3]) / 2)))
        true_m2 = cell * cell * k * k
        lawn_sqft = float((truth | inferred).sum()) * ((bbox[2] - bbox[0]) / truth.shape[1]) ** 2 * k * k / 0.09290304
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        rec = {
            "project": p["name"], "year": p.get("year"), "nodes": got["nodes"], "mb": round(got["mb"], 1),
            "points": got["points"], "points_per_m2": round(got["points"] / area, 2),
            "ground_per_m2": round(float(raster["n_ground"].sum()) / area, 2),
            "classes": rows, "separation": seps, "seconds": round(time.time() - t0, 1),
            "lawn_sqft": round(lawn_sqft), "cell_true_m2": true_m2,
            "masks": mask_shares(classes, masks), "canopy_agreement": agree,
            "naip": naip_rec,
            "clumps": clumps_here,
            "segments": segs_here,
        }
        summary["lawns"][lawn_id] = rec
        for k in pooled:
            for lab_name, a, b in (("under canopy", 1, 2), ("visible", 0, 3)):
                pooled[k][lab_name][0].extend(layers[k][classes == a].tolist())
                pooled[k][lab_name][1].extend(layers[k][classes == b].tolist())

        np.savez_compressed(out / f"{lawn_id}.npz", classes=classes, **layers, **masks)
        for mk in masks:  # roof, void, lidar-canopy, and naip-canopy where it was read
            Image.fromarray(masks[mk].astype(np.uint8) * 255).save(out / f"{lawn_id}-{mk.replace('_', '-')}.png")
        # THE HEIGHT, FOR STAGE 3 (H34): a grey PNG on the coarse grid, a tenth
        # of a metre a level, so the JavaScript scorer can read the canopy's
        # height the way it reads the tree model's mask. 25.5 m is the top.
        Image.fromarray(height_png(layers["height"])).save(out / f"{lawn_id}-height.png")
        inten = layers["intensity"]
        if np.isfinite(inten).any():
            lo, hi = np.nanpercentile(inten, [2, 98])
            pic = np.where(np.isnan(inten), 0, np.clip((inten - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)
            Image.fromarray(pic).save(out / f"{lawn_id}-intensity.png")

        uc = seps["under canopy"]
        print(f"  {label} {str(p.get('year') or '—'):>4}  {rec['points_per_m2']:5.1f} pts/m²  "
              f"{rec['ground_per_m2']:4.2f} ground/m²  under canopy {uc['cells'][0]:4d} lawn / {uc['cells'][1]:4d} not:  "
              f"AUC dens {fmt(uc['ground_per_m2'])}  int {fmt(uc['intensity'])}  hgt {fmt(uc['height'])}  "
              f"und {fmt(uc['understory'])}  und6 {fmt(uc['understory_6m'])}  "
              f"{rec['seconds']:4.0f}s")

    (out / "summary.json").write_text(json.dumps(summary, indent=1))

    # -------------------------------------------------------- the end of the log
    done = [r for r in summary["lawns"].values() if "skipped" not in r]
    print(f"\n{'=' * 64}\n")
    print(f"{len(done)} of {len(ids)} frames read from the point clouds in {(time.time() - t_all) / 60:.0f} min.")
    if not done:
        print("Nothing to summarise.")
        return
    years = [r["year"] for r in done if r.get("year")]
    dens = sorted(r["points_per_m2"] for r in done)
    grd = sorted(r["ground_per_m2"] for r in done)
    print(f"Flown {min(years) if years else '—'} to {max(years) if years else '—'}; "
          f"{dens[0]:.1f} to {dens[-1]:.1f} points/m² (middle {dens[len(dens) // 2]:.1f}), "
          f"{grd[0]:.2f} to {grd[-1]:.2f} ground returns/m² (middle {grd[len(grd) // 2]:.2f}).")
    print(f"At {cell:g} m cells that is about {grd[len(grd) // 2] * cell * cell:.1f} ground returns a cell on the middle lawn.\n")

    print("Per class, middle lawn (ground returns/m², share of cells with any ground return, ground intensity, height m, understory share):\n")
    for name in CLASSES:
        vals = [r["classes"][name] for r in done if r["classes"].get(name, {}).get("cells")]
        if not vals:
            continue
        med = lambda key: np.median([v[key] for v in vals if v.get(key) is not None])  # noqa: E731
        print(f"  {name:24} {med('ground_per_m2'):5.2f}   {100 * med('with_ground'):3.0f}%   {med('intensity_p50'):8.0f}   {med('height_p50'):5.1f}   {med('understory_p50'):5.2f}")

    print("\nCAN THE LIDAR TELL LAWN FROM NOT-LAWN? AUC, 0.5 is a coin toss; pooled over every cell, then the middle lawn:\n")
    print(f"  {'':16}{'ground density':>16}{'intensity':>12}{'height':>10}{'understory':>12}{'over 6 m':>10}")
    for lab_name in ("under canopy", "visible"):
        pooled_auc = {k: auc(pooled[k][lab_name][0], pooled[k][lab_name][1]) for k in pooled}
        per = {k: [r["separation"][lab_name][k] for r in done
                   if r["separation"][lab_name][k] is not None and min(r["separation"][lab_name]["cells"]) >= 20]
               for k in pooled}
        mid = {k: (float(np.median(v)) if v else None) for k, v in per.items()}
        cols = lambda d: f"{fmt(d['ground_per_m2']):>16}{fmt(d['intensity']):>12}{fmt(d['height']):>10}{fmt(d['understory']):>12}{fmt(d['understory_6m']):>10}"  # noqa: E731
        print(f"  {lab_name:16}{cols(pooled_auc)}   pooled")
        print(f"  {'':16}{cols(mid)}   middle lawn, of {len(per['intensity'])} with 20+ cells each side")
    print("\nRead 'under canopy' against 'visible': a layer that cannot tell lawn from")
    print("pavement in the open will not do it under a tree. Direction is in the number:")
    print("above 0.5 means lawn reads HIGHER on that layer, below means lower.")
    print_masks([(k, r) for k, r in summary["lawns"].items() if "skipped" not in r], cell)
    print_crowns([r for k, r in summary["lawns"].items() if "skipped" not in r])
    print_segments([r for k, r in summary["lawns"].items() if "skipped" not in r])
    if naip_files:
        print_naip([(k, r) for k, r in summary["lawns"].items() if "skipped" not in r], summary["naip_only"])
    print("UNDERSTORY (H36): the woods rule needs 'under canopy' to read well BELOW 0.5 on")
    print("the understory columns -- lawn under a tree has none, not-lawn under canopy has")
    print("shrubs -- and height (H34) read 0.23 pooled here yet failed as a rule, so a")
    print("column is only a candidate until stage 3 scores it.")
    print("The gap between the lidar's year and the photograph's cannot be measured (H16).")


def print_masks(items, cell):
    """What the three masks say, per class and per lot. The part stage 4 turns on."""
    done = [r for _, r in items]
    print("\nWHAT THE LIDAR SAYS OUTRIGHT: share of each class under each mask, pooled over every cell")
    print("(roof = no ground return, 2.5 m+, flat within 1.5 m; void = nothing back over 6 m, or water;")
    print(" lidar canopy = 2 m+ and not roof):\n")
    print(f"  {'':24}{'cells':>8}{'roof':>8}{'void':>8}{'lidar canopy':>14}")
    for name in CLASSES:
        n = sum(r["masks"][name]["cells"] for r in done)
        if not n:
            continue
        pooled = {mk: sum((r["masks"][name][mk] or 0) * r["masks"][name]["cells"] for r in done) / n for mk in MASKS}
        print(f"  {name:24}{n:8d}{100 * pooled['roof']:7.1f}%{100 * pooled['void']:7.1f}%{100 * pooled['lidar_canopy']:13.1f}%")
    print("\nRead: a mask worth using is near 0% on both lawn rows and well above 0 on a not-lawn row.")
    print("Roof on 'not lawn, visible' is the houses it finds; on 'lawn under canopy' it is lawn a roof rule would cost.")

    tot = {k: sum(r["canopy_agreement"][k] for r in done) for k in ("both", "only_lidar", "only_restor")}
    union = sum(tot.values())
    print(f"\nTHE TREE MODEL AGAINST THE LIDAR'S CANOPY, inside the line: agree on {tot['both']} cells, "
          f"lidar only {tot['only_lidar']}, tree model only {tot['only_restor']}"
          + (f" (IoU {tot['both'] / union:.2f})." if union else "."))
    print("Lidar only = a tree the model missed, or one grown since the flight; tree model only = the lidar")
    print("says under 2 m there: a bed or dark grass the model took for a tree, or a tree newer than the flight.\n")

    print(f"  {'lot':34}{'lawn':>10}{'flown':>7}{'roof in':>9}{'roof in':>9}{'void in':>9}{'void in':>9}{'lidar-only':>12}{'model-only':>12}")
    print(f"  {'':34}{'sq ft':>10}{'':>7}{'lawn':>9}{'not-lawn':>9}{'lawn':>9}{'not-lawn':>9}{'canopy m²':>12}{'canopy m²':>12}")
    for lawn_id, r in sorted(items, key=lambda kv: -kv[1]["canopy_agreement"]["only_lidar"] * kv[1]["cell_true_m2"]):
        m = r["masks"]

        def cells_of(names, mk):
            return sum((m[nm][mk] or 0) * m[nm]["cells"] for nm in names)
        lawn_rows, not_rows = ("visible lawn", "lawn under canopy"), ("not lawn, under canopy", "not lawn, visible")
        a = r["canopy_agreement"]
        print(f"  {tagged(lawn_id)[:34]:34}{r['lawn_sqft']:>10,}{str(r.get('year') or '—'):>7}"
              f"{cells_of(lawn_rows, 'roof'):9.0f}{cells_of(not_rows, 'roof'):9.0f}"
              f"{cells_of(lawn_rows, 'void'):9.0f}{cells_of(not_rows, 'void'):9.0f}"
              f"{a['only_lidar'] * r['cell_true_m2']:12.0f}{a['only_restor'] * r['cell_true_m2']:12.0f}")
    print(f"\n  (roof and void columns are {cell:g} m cells; worst lidar-only canopy first)\n")


def print_crowns(done):
    """S9: does the crown count per clump tell woods from lawn trees? (The owner's rule.)"""
    import crowns_lidar
    cl = [c for r in done for c in r.get("clumps", [])]
    if not cl:
        return
    lawn_cl = [c for c in cl if c["lawn"] >= 0.5 * c["area"]]
    wood_cl = [c for c in cl if c["lawn"] < 0.5 * c["area"]]
    print(f"\nS9, CROWNS PER CANOPY CLUMP (lidar CHM, Popescu & Wynne variable window, tops {crowns_lidar.MIN_TOP_M:g} m+):")
    print(f"  {len(cl)} clumps of the tree model's canopy inside the lines: {len(lawn_cl)} mostly lawn under them, {len(wood_cl)} mostly not.")
    if not lawn_cl or not wood_cl:
        return
    med = lambda xs: float(np.median(xs)) if xs else float("nan")  # noqa: E731
    print(f"  median crowns: lawn clumps {med([c['crowns'] for c in lawn_cl]):.0f}, others {med([c['crowns'] for c in wood_cl]):.0f};"
          f" median area {med([c['area'] for c in lawn_cl]):.0f} m² against {med([c['area'] for c in wood_cl]):.0f} m²;"
          f" median border lawn {100 * med([c['border'] for c in lawn_cl]):.0f}% against {100 * med([c['border'] for c in wood_cl]):.0f}%.")
    feats = {
        "crowns": lambda c: c["crowns"],
        "crowns per 100 m²": lambda c: 100 * c["crowns"] / c["area"],
        "border lawn share": lambda c: c["border"],
        "median height": lambda c: c["height"],
        "area": lambda c: c["area"],
    }
    print("\n  AUC, a clump that is mostly NOT lawn scoring higher than one that is (0.5 = coin toss; below 0.5 = lower):")
    for k, f in feats.items():
        print(f"    {k:20} {fmt(auc([f(c) for c in wood_cl], [f(c) for c in lawn_cl]))}")
    rules = [
        ("2+ crowns", lambda c: c["crowns"] >= 2),
        ("3+ crowns", lambda c: c["crowns"] >= 3),
        ("4+ crowns", lambda c: c["crowns"] >= 4),
        ("6+ crowns", lambda c: c["crowns"] >= 6),
        ("border lawn < 25%", lambda c: c["border"] < 0.25),
        ("3+ crowns and border < 25%", lambda c: c["crowns"] >= 3 and c["border"] < 0.25),
        ("2+ crowns and border < 10%", lambda c: c["crowns"] >= 2 and c["border"] < 0.10),
        ("height 6 m+ (H35)", lambda c: c["height"] >= 6),
        ("height 12 m+ (H35)", lambda c: c["height"] >= 12),
    ]
    print("\n  A rule calling a clump woods, pooled by area (bar: finds half the woods, costs a tenth of the lawn):\n")
    print(f"  {'rule':30}{'lawn it would lose':>22}{'woods it finds':>20}")
    for name_, rule in rules:
        cost, lawn_all, found, woods_all = crowns_lidar.rule_trade(cl, rule)
        print(f"  {name_:30}{cost:10.0f} m² {100 * cost / max(lawn_all, 1):5.1f}%{found:10.0f} m² {100 * found / max(woods_all, 1):5.1f}%")
    print()


def print_segments(done):
    """H47: the unit below the clump -- each crown's own segment, judged by its own border."""
    import crowns_lidar
    sg = [c for r in done for c in r.get("segments", [])]
    if not sg:
        return
    lawn_s = [c for c in sg if c["lawn"] >= 0.5 * c["area"]]
    wood_s = [c for c in sg if c["lawn"] < 0.5 * c["area"]]
    print("\nH47, ONE SEGMENT PER CROWN (canopy cells to their nearest top in the same clump):")
    print(f"  {len(sg)} segments: {len(lawn_s)} mostly lawn under them, {len(wood_s)} mostly not.")
    if not lawn_s or not wood_s:
        return
    feats = {
        "border lawn share": lambda c: c["border"],
        "distance to lawn": lambda c: c["dist"],
        "crowding (tops in 10 m)": lambda c: c["crowding"],
        "height": lambda c: c["height"],
        "area": lambda c: c["area"],
    }
    print("\n  AUC, a segment that is mostly NOT lawn scoring higher than one that is (0.5 = coin toss; below 0.5 = lower):")
    for k, f in feats.items():
        print(f"    {k:24} {fmt(auc([f(c) for c in wood_s], [f(c) for c in lawn_s]))}")
    rules = [
        ("border lawn 0%", lambda c: c["border"] == 0),
        ("border lawn < 10%", lambda c: c["border"] < 0.10),
        ("border lawn < 25%", lambda c: c["border"] < 0.25),
        ("distance 4 m+", lambda c: c["dist"] >= 4),
        ("distance 6 m+", lambda c: c["dist"] >= 6),
        ("distance 10 m+", lambda c: c["dist"] >= 10),
        ("crowding 2+", lambda c: c["crowding"] >= 2),
        ("crowding 4+", lambda c: c["crowding"] >= 4),
        ("crowding 2+ and border 0%", lambda c: c["crowding"] >= 2 and c["border"] == 0),
        ("crowding 2+ and distance 6 m+", lambda c: c["crowding"] >= 2 and c["dist"] >= 6),
        ("height 12 m+ and distance 6 m+", lambda c: c["height"] >= 12 and c["dist"] >= 6),
    ]
    print("\n  A rule calling a segment woods, pooled by area (bar: finds half the woods, costs a tenth of the lawn):\n")
    print(f"  {'rule':34}{'lawn it would lose':>22}{'woods it finds':>20}")
    for name_, rule in rules:
        cost, lawn_all, found, woods_all = crowns_lidar.rule_trade(sg, rule)
        print(f"  {name_:34}{cost:10.0f} m² {100 * cost / max(lawn_all, 1):5.1f}%{found:10.0f} m² {100 * found / max(woods_all, 1):5.1f}%")
    print()


def naip_without_lidar(lawn_id, bbox, cell, frames, canopy_dir, files, out):
    """A frame with no point cloud: the tree model against NAIP-CHM on the same coarse grid."""
    import naip_chm
    from PIL import Image
    labels_file = frames / f"{lawn_id}-labels.png"
    if not labels_file.exists():
        return None
    gw = max(1, int(round((bbox[2] - bbox[0]) / cell)))
    gh = max(1, int(round((bbox[3] - bbox[1]) / cell)))
    lab = np.asarray(Image.open(labels_file).convert("RGB"))
    within = shrink_mask(lab[:, :, 1] >= 128, gw, gh)
    can_file = canopy_dir / f"{lawn_id}-mask.png"
    canopy = (np.asarray(Image.open(can_file).convert("L")) >= 128) if can_file.exists() else np.zeros(lab.shape[:2], dtype=bool)
    try:
        h, cover = naip_chm.read_height(bbox, gw, gh, files)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}
    Image.fromarray(height_png(h)).save(out / f"{lawn_id}-naip-height.png")
    Image.fromarray(((np.nan_to_num(cover) >= naip_chm.COVER_MIN).astype(np.uint8) * 255)).save(out / f"{lawn_id}-naip-canopy.png")
    k = math.cos(math.radians(web_mercator_lat((bbox[1] + bbox[3]) / 2)))
    return {"year": files[0][0], "cell_true_m2": cell * cell * k * k,
            "two_way": naip_chm.two_way(within, shrink_mask(canopy, gw, gh), np.nan_to_num(cover) >= naip_chm.COVER_MIN)}


def print_naip(items, naip_only):
    """The tie-breaker (H38's open question): where the tree model and the lidar disagree, what does NAIP-CHM say?"""
    have = [(k, r) for k, r in items if r.get("naip") and "three_way" in r["naip"]]
    failed = [k for k, r in items if r.get("naip") and "error" in r["naip"]]
    print("\nNAIP-CHM (E9), half the 2 m cell's pixels 2 m or more (H41) and not roof, against the tree model and the lidar's canopy, inside the line:")
    if not have:
        print("  nothing read." + (f" {len(failed)} frames failed, e.g. {failed[:3]}" if failed else ""))
        return
    years = sorted(r["naip"]["year"] for _, r in have)
    print(f"  {len(have)} frames with lidar and NAIP-CHM (NAIP {years[0]} to {years[-1]}); {len(failed)} reads failed.\n")
    tot = {c: [0, 0] for c in ("both", "lidar only", "model only", "neither")}
    for _, r in have:
        for c, (n, yes) in r["naip"]["three_way"].items():
            tot[c][0] += n
            tot[c][1] += yes
    print(f"  {'class':24}{'cells':>8}{'NAIP canopy':>13}{'lidar canopy':>14}")
    for name in CLASSES:
        rows = [r["masks"][name] for _, r in have if r["masks"][name].get("naip_canopy") is not None]
        n = sum(x["cells"] for x in rows)
        if n:
            nc = sum(x["naip_canopy"] * x["cells"] for x in rows) / n
            lc = sum(x["lidar_canopy"] * x["cells"] for x in rows) / n
            print(f"  {name:24}{n:8d}{100 * nc:12.1f}%{100 * lc:13.1f}%")
    print()
    print(f"  {'tree model / lidar':22}{'cells':>8}{'NAIP says canopy':>18}")
    for c, (n, yes) in tot.items():
        print(f"  {c:22}{n:8d}{(100 * yes / n if n else 0):17.1f}%")
    sweeps = [r["naip"]["sweep"] for _, r in have if r["naip"].get("sweep")]
    if sweeps:
        print("\n  H45, NAIP-CHM used better? Cover at H m (half the 2 m cell), not roof, objects at least A m²:\n")
        print(f"  {'H / A':10}{'both (>80)':>12}{'neither (<10)':>15}{'lawn called canopy':>20}{'lidar 4 m trees found':>23}")
        for key in sweeps[0]:
            tot = {c: [sum(sw[key][c][0] for sw in sweeps), sum(sw[key][c][1] for sw in sweeps)] for c in ("both", "neither", "lawn", "trees")}
            pc = {c: (100 * y / n if n else 0) for c, (n, y) in tot.items()}
            h, a = key.split("/")
            print(f"  {h + ' m / ' + a:10}{pc['both']:11.1f}%{pc['neither']:14.1f}%{pc['lawn']:19.1f}%{pc['trees']:22.1f}%")
    print("\n  Read: 'lidar only' high = trees the tree model misses (still there in 2022-23);")
    print("  low = trees gone since the flight, or the lidar's 2 m cells catching an edge.")
    print("  'model only' high = the tree model is right and the lidar is old; low = the model's false trees.")
    print("  'both' and 'neither' are the calibration: how often NAIP-CHM agrees when the other two do.\n")

    print(f"  {'lot':34}{'lawn':>10}{'lidar':>7}{'NAIP':>6}{'lidar-only m²':>15}{'NAIP agrees':>13}{'model-only m²':>15}{'NAIP agrees':>13}")
    for k, r in sorted(have, key=lambda kv: -kv[1]["naip"]["three_way"]["lidar only"][0] * kv[1]["cell_true_m2"]):
        tw, a = r["naip"]["three_way"], r["cell_true_m2"]
        lo, mo = tw["lidar only"], tw["model only"]
        print(f"  {tagged(k)[:34]:34}{r['lawn_sqft']:>10,}{str(r.get('year') or '—'):>7}{r['naip']['year']:>6}"
              f"{lo[0] * a:15.0f}{(100 * lo[1] / lo[0] if lo[0] else 0):12.0f}%"
              f"{mo[0] * a:15.0f}{(100 * mo[1] / mo[0] if mo[0] else 0):12.0f}%")
    if naip_only:
        print("\n  Frames with no lidar, the tree model against NAIP-CHM alone (m²):\n")
        print(f"  {'lot':34}{'NAIP':>6}{'both':>8}{'model only':>12}{'NAIP only':>11}")
        for k, r in naip_only.items():
            if "two_way" not in r:
                print(f"  {tagged(k)[:34]:34}  read failed: {r.get('error', '')[:60]}")
                continue
            t, a = r["two_way"], r["cell_true_m2"]
            print(f"  {tagged(k)[:34]:34}{r['year']:>6}{t['both'] * a:8.0f}{t['model only'] * a:12.0f}{t['naip only'] * a:11.0f}")
    print()


TAGS = {}  # B01..B32 from scale.json (worker/src/benchmark-ids.js)


def tagged(lawn_id):
    """The benchmark tag before the id, so the tables read "B06 -85.61014,43.03520"."""
    t = TAGS.get(lawn_id)
    return f"{t} {lawn_id}" if t else lawn_id


def fmt(v):
    return "  --" if v is None else f"{v:4.2f}"


if __name__ == "__main__":
    main()
