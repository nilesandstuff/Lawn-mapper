"""
What the lidar says about each TREE (owner, 2026-10-05: "we were just using
DSM only. But we should've looked at the difference between first lidar return
and later returns to determine if an object is a tree. And then ... to see if
it's an evergreen").

The stage 4 reader (lidar_frame.py) kept heights and ground returns per 2 m
cell and threw away which return of its pulse each point was. This keeps it.
A pulse that meets a tree splits: its first return comes back from the top of
the crown and its later ones from inside, below, or the ground. So, per 1 m
cell:

    height          highest return over the ground surface (the old layer)
    first_h         mean height of FIRST returns over the ground
    last_h          mean height of LAST returns over the ground. Through a
                    bare crown (leaf-off flight) pulses reach the ground and
                    this is low; an evergreen stops them and it stays high;
                    a roof's last return is the roof
    spread          first_h - last_h: big in a tree a pulse goes into, ~0 on
                    a roof or bare ground, where one return is all there is
    penetration     share of last returns within 0.5 m of the ground
    multi           share of points from pulses that split (number of
                    returns > 1): vegetation does that, roofs and ground do not
    veg_class       share of points the survey itself classed as vegetation
                    (classes 3-5), where it did
    building_class  share classed as building (6)

and the counts behind them. Written per frame as tree-lidar/<id>.json (meta)
plus <id>.f32 (the layers, float32, in the order the meta lists), over the
frame's own box, rows from the north -- the same box the photo covers, so a
photo pixel at (x, y) is cell (x * gw / W, y * gh / H).

    FRAMES=frames PLAN=lidar-plan.json OUT=tree-lidar python3 tools/tree_lidar.py
"""

import io
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from lidar_frame import fetch, walk, fill_surface  # noqa: E402

CELL_M = float(os.environ.get("CELL_M", "1.0"))
LAYERS = ["height", "first_h", "last_h", "spread", "penetration", "multi", "veg_class", "building_class", "n_all"]


def points_with_returns(base, bbox, limit_nodes=400):
    """Every point inside bbox as columns x, y, z, class, return_number, number_of_returns."""
    import laspy
    ept = json.loads(fetch(f"{base}/ept.json"))
    if str((ept.get("srs") or {}).get("horizontal")) != "3857":
        raise RuntimeError("point cloud is not EPSG:3857")
    cache = {}

    def hierarchy(key):
        if not cache:
            cache.update(json.loads(fetch(f"{base}/ept-hierarchy/0-0-0-0.json")))
        v = cache.get(key)
        if v is not None and v < 0:
            cache.update(json.loads(fetch(f"{base}/ept-hierarchy/{key}.json")))
            v = cache.get(key)
        return v

    nodes = walk(hierarchy, ept["bounds"], bbox)
    if len(nodes) > limit_nodes:
        raise RuntimeError(f"{len(nodes)} nodes over one frame")
    parts = []
    for key in nodes:
        las = laspy.read(io.BytesIO(fetch(f"{base}/ept-data/{key}.laz")))
        x, y = np.asarray(las.x), np.asarray(las.y)
        m = (x >= bbox[0]) & (x <= bbox[2]) & (y >= bbox[1]) & (y <= bbox[3])
        if m.any():
            parts.append(np.column_stack([
                x[m], y[m], np.asarray(las.z)[m],
                np.asarray(las.classification)[m].astype(np.float64),
                np.asarray(las.return_number)[m].astype(np.float64),
                np.asarray(las.number_of_returns)[m].astype(np.float64),
            ]))
    return np.vstack(parts) if parts else np.zeros((0, 6))


def tree_layers(points, bbox, cell=CELL_M):
    """The layers above on a grid of `cell` metres over bbox, rows from the north. Pure."""
    w, s, e, n = bbox
    gw = max(1, int(round((e - w) / cell)))
    gh = max(1, int(round((n - s) / cell)))
    size = gw * gh
    out = {k: np.full((gh, gw), np.nan, dtype=np.float32) for k in LAYERS}
    out["n_all"] = np.zeros((gh, gw), dtype=np.float32)
    if points is None or len(points) == 0:
        return out, gw, gh
    x, y, z, cls, rn, nr = (points[:, k] for k in range(6))
    keep = (x >= w) & (x < e) & (y > s) & (y <= n)
    x, y, z, cls, rn, nr = x[keep], y[keep], z[keep], cls[keep], rn[keep], nr[keep]
    col = np.minimum(gw - 1, ((x - w) / (e - w) * gw).astype(np.int64))
    row = np.minimum(gh - 1, ((n - y) / (n - s) * gh).astype(np.int64))
    flat = row * gw + col

    # The ground surface: lowest ground-classed return per cell, filled.
    zg = np.full(size, np.inf)
    g = cls == 2
    np.minimum.at(zg, flat[g], z[g])
    ground = fill_surface(np.where(np.isfinite(zg), zg, np.nan).reshape(gh, gw)).reshape(-1)
    hag = z - ground[flat]                     # height above ground, per point
    ok = np.isfinite(hag)

    def mean_where(mask, values):
        num = np.bincount(flat[mask & ok], weights=values[mask & ok], minlength=size)
        den = np.bincount(flat[mask & ok], minlength=size)
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(den > 0, num / np.maximum(den, 1), np.nan), den

    n_all = np.bincount(flat, minlength=size).astype(np.float64)
    hmax = np.full(size, -np.inf)
    np.maximum.at(hmax, flat[ok], hag[ok])
    first = rn == 1
    last = rn == nr
    first_h, _ = mean_where(first, hag)
    last_h, n_last = mean_where(last, hag)
    pen_num = np.bincount(flat[last & ok & (hag < 0.5)], minlength=size)
    multi = np.bincount(flat[nr > 1], minlength=size)
    veg = np.bincount(flat[(cls >= 3) & (cls <= 5)], minlength=size)
    bld = np.bincount(flat[cls == 6], minlength=size)
    with np.errstate(invalid="ignore", divide="ignore"):
        layers = {
            "height": np.where(np.isfinite(hmax), np.maximum(0, hmax), np.nan),
            "first_h": first_h,
            "last_h": last_h,
            "spread": first_h - last_h,
            "penetration": np.where(n_last > 0, pen_num / np.maximum(n_last, 1), np.nan),
            "multi": np.where(n_all > 0, multi / np.maximum(n_all, 1), np.nan),
            "veg_class": np.where(n_all > 0, veg / np.maximum(n_all, 1), np.nan),
            "building_class": np.where(n_all > 0, bld / np.maximum(n_all, 1), np.nan),
            "n_all": n_all,
        }
    for k in LAYERS:
        out[k] = layers[k].reshape(gh, gw).astype(np.float32)
    return out, gw, gh


def main():
    frames = Path(os.environ.get("FRAMES", "frames"))
    plan = json.loads(Path(os.environ.get("PLAN", "lidar-plan.json")).read_text())
    out = Path(os.environ.get("OUT", "tree-lidar"))
    out.mkdir(parents=True, exist_ok=True)
    boxes = json.loads((frames / "scale.json").read_text()).get("boxes") or {}
    only = set(filter(None, os.environ.get("ONLY", "").split(",")))
    done = 0
    for lawn_id, box in boxes.items():
        if only and lawn_id not in only:
            continue
        p = plan.get(lawn_id)
        if not p or not p.get("url"):
            print(f"  {lawn_id[:28]:30} no lidar")
            continue
        base = p["url"].rsplit("/", 1)[0]
        try:
            pts = points_with_returns(base, box)
        except Exception as e:  # noqa: BLE001 - one lot's failure is reported, not fatal
            print(f"  {lawn_id[:28]:30} failed: {str(e)[:80]}")
            continue
        layers, gw, gh = tree_layers(pts, box)
        multi_pulses = float(np.mean(pts[:, 5] > 1)) if len(pts) else 0.0
        safe = lawn_id.replace("/", "_")
        np.stack([layers[k] for k in LAYERS]).astype("<f4").tofile(out / f"{safe}.f32")
        (out / f"{safe}.json").write_text(json.dumps({
            "id": lawn_id, "bbox": box, "cell": CELL_M, "gw": gw, "gh": gh, "layers": LAYERS,
            "project": p.get("name"), "year": p.get("year"), "points": int(len(pts)),
            "multiReturnShare": round(multi_pulses, 3),
        }))
        done += 1
        print(f"  {lawn_id[:28]:30} {len(pts):8} points, {gw}x{gh} cells, {multi_pulses * 100:4.0f}% from split pulses  {p.get('name')}")
    print(f"\nTree lidar for {done} frames in {out}/.")


if __name__ == "__main__":
    main()
