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

    for lawn_id in ids:
        label = lawn_id[:28].ljust(30)
        p = plan.get(lawn_id)
        if not p or not p.get("url"):
            print(f"  {label} no lidar project over it")
            summary["lawns"][lawn_id] = {"skipped": "no lidar"}
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
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        rec = {
            "project": p["name"], "year": p.get("year"), "nodes": got["nodes"], "mb": round(got["mb"], 1),
            "points": got["points"], "points_per_m2": round(got["points"] / area, 2),
            "ground_per_m2": round(float(raster["n_ground"].sum()) / area, 2),
            "classes": rows, "separation": seps, "seconds": round(time.time() - t0, 1),
        }
        summary["lawns"][lawn_id] = rec
        for k in pooled:
            for lab_name, a, b in (("under canopy", 1, 2), ("visible", 0, 3)):
                pooled[k][lab_name][0].extend(layers[k][classes == a].tolist())
                pooled[k][lab_name][1].extend(layers[k][classes == b].tolist())

        np.savez_compressed(out / f"{lawn_id}.npz", classes=classes, **layers)
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
    print("UNDERSTORY (H36): the woods rule needs 'under canopy' to read well BELOW 0.5 on")
    print("the understory columns -- lawn under a tree has none, not-lawn under canopy has")
    print("shrubs -- and height (H34) read 0.23 pooled here yet failed as a rule, so a")
    print("column is only a candidate until stage 3 scores it.")
    print("The gap between the lidar's year and the photograph's cannot be measured (H16).")


def fmt(v):
    return "  --" if v is None else f"{v:4.2f}"


if __name__ == "__main__":
    main()
