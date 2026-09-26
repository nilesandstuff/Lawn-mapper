"""
NAIP-CHM over the frames: a second, newer opinion on where the trees are.

E9 in docs/DETECTOR-FINDINGS.md. Morford et al. 2026 ran a U-Net trained on
lidar canopy height models over every NAIP quarter-quad in CONUS: 0.6 m,
centimetres as uint16, 96% of it from 2022-2023 photographs. It is served as
tiled GeoTIFFs that answer byte ranges, so one frame is a windowed read of a
few hundred KB -- measured at 1.4 s a lot including the connection, with no
model run at all.

THE QUESTION IT ANSWERS FIRST (H38 left it open). The lidar calls 8,759 cells
canopy inside the benchmark lines that the tree model does not, and there
were three explanations nobody could separate: a tree the model missed, a
tree felled since the flight (2011-2020), or a 2 m cell catching the edge of
a crown or an eave. NAIP-CHM is a decade newer than the lidar and knows
nothing of either the lidar or the tree model, so on each of those cells it
can say "a tree is still there" or "not any more". The same for the cells
only the tree model calls canopy.

WHAT IT IS NOT: a surface from a photograph cannot see under a crown, and
0.6 m with 2.3 m RMSE is not a shrub-height instrument. Buildings are in it,
so the lidar's roof mask is taken out where there is one.

Pure functions first (tested in naip_chm_test.py); the reads need rasterio.
"""

import csv
import io
import math
import re
import time
import urllib.request

import numpy as np

INDEX_URL = "https://rangeland.ntsg.umt.edu/data/naip-chm/index.csv"
CANOPY_M = 2.0  # the lidar canopy's threshold (H38), so the two are comparable
R = 6378137.0
_NUM = re.compile(r"-?\d+(?:\.\d+)?(?:[eE]-?\d+)?")


def mercator_to_lonlat(x, y):
    return math.degrees(x / R), math.degrees(math.atan(math.sinh(y / R)))


def lonlat_box(bbox):
    """A Web Mercator (w, s, e, n) box as (lon_w, lat_s, lon_e, lat_n)."""
    w, s = mercator_to_lonlat(bbox[0], bbox[1])
    e, n = mercator_to_lonlat(bbox[2], bbox[3])
    return (w, s, e, n)


def geo_bounds(geo):
    """The lon/lat bounds of the index's GeoJSON polygon string, without a JSON parse."""
    v = [float(t) for t in _NUM.findall(geo)]
    xs, ys = v[0::2], v[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def match_index(rows, boxes):
    """
    rows: iterable of (bounds, year, date, url). boxes: {id: lon/lat box}.
    Returns {id: [(year, date, url), ...]} of every file touching the box,
    newest first. A frame on a quad edge touches two files; both are read.
    """
    out = {k: [] for k in boxes}
    items = list(boxes.items())
    for bounds, year, date, url in rows:
        for k, box in items:
            if overlaps(bounds, box):
                out[k].append((year, date, url))
    for k in out:
        out[k].sort(key=lambda r: (r[0], r[1]), reverse=True)
    return out


def newest_only(files):
    """The files of the newest year only: two years over one frame would mix trees and felled trees."""
    if not files:
        return []
    top = files[0][0]
    return [f for f in files if f[0] == top]


def three_way(within, restor, lidar_canopy, naip_canopy):
    """
    Inside the line, the four ways the tree model and the lidar can agree or
    not, and in each how many cells NAIP-CHM calls canopy. Returned as
    {name: [cells, of which NAIP canopy]}.
    """
    w = within
    cases = {
        "both": restor & lidar_canopy,
        "lidar only": ~restor & lidar_canopy,
        "model only": restor & ~lidar_canopy,
        "neither": ~restor & ~lidar_canopy,
    }
    return {k: [int((m & w).sum()), int((m & w & naip_canopy).sum())] for k, m in cases.items()}


def two_way(within, restor, naip_canopy):
    """For a frame with no point cloud: the tree model against NAIP-CHM alone."""
    w = within
    return {
        "both": int((restor & naip_canopy & w).sum()),
        "model only": int((restor & ~naip_canopy & w).sum()),
        "naip only": int((~restor & naip_canopy & w).sum()),
    }


# ------------------------------------------------------------------ the reads

def read_index(boxes, url=INDEX_URL, tries=3):
    """Stream the 256 MB index once and keep the rows over our frames (about 10 s)."""
    lonlat = {k: lonlat_box(b) for k, b in boxes.items()}
    for attempt in range(tries):
        try:
            res = urllib.request.urlopen(url, timeout=120)
            rd = csv.reader(io.TextIOWrapper(res, encoding="utf-8"))
            hdr = next(rd)
            gi, ui, yi, di = hdr.index(".geo"), hdr.index("chm_url"), hdr.index("year"), hdr.index("acquisition_date")

            def rows():
                for r in rd:
                    try:
                        yield geo_bounds(r[gi]), int(float(r[yi])), r[di], r[ui]
                    except (ValueError, IndexError):
                        continue
            return match_index(rows(), lonlat)
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return {}


COVER_MIN = 0.5  # H41: half the cell's NAIP pixels at CANOPY_M or more
READ_COVERS = {}  # the last read's cover at each SWEEP_M height (H45), beside its return value


SWEEP_M = (2.0, 3.0, 4.0, 5.0)       # H45: cover at each height
SWEEP_AREA_M2 = (0, 20, 50)          # and a least object size, in m²


def objects_at_least(mask, min_cells):
    """The mask with connected objects (8-neighbour) under `min_cells` cells removed."""
    if min_cells <= 1 or not mask.any():
        return mask
    from scipy.ndimage import label
    lab, n = label(mask, structure=np.ones((3, 3), dtype=bool))
    if not n:
        return mask
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_cells
    keep[0] = False
    return keep[lab]


def sweep_counts(covers, not_roof, within, restor, lidar_canopy, visible_lawn, tall_trees, cell_m2):
    """
    H45, the owner's "use it better" test: for every height in SWEEP_M and
    least object size in SWEEP_AREA_M2, NAIP canopy = half the cell at that
    height or more, not roof, in objects at least that big. Counted inside the
    line against the same bars as H41 (where the tree model and lidar agree
    there is / is not canopy), plus the traced visible lawn it would call
    canopy and the lidar's 4 m trees it still finds. {"thr/area": {k: [n, yes]}}.
    """
    out = {}
    w = within
    cases = {
        "both": restor & lidar_canopy & w,
        "neither": ~restor & ~lidar_canopy & w,
        "lawn": visible_lawn,
        "trees": tall_trees & w,
    }
    for thr in SWEEP_M:
        cov = covers.get(thr)
        if cov is None:
            continue
        base = (np.nan_to_num(cov) >= 0.5) & not_roof
        for area in SWEEP_AREA_M2:
            v = objects_at_least(base, int(np.ceil(area / cell_m2)) if area else 0)
            out[f"{thr:g}/{area}"] = {k: [int(m.sum()), int((m & v).sum())] for k, m in cases.items()}
    return out


def read_height(bbox, gw, gh, files):
    """
    NAIP-CHM on the (gw x gh) Web Mercator grid over bbox, as two layers:
    `height`, the TALLEST reading in each cell (as the lidar's z_max is), and
    `cover`, the share of the cell's NAIP pixels at CANOPY_M or more. NaN
    where no file covers it. Files of the newest year only; where two
    overlap, the larger of each.

    WHY COVER (H40): the tallest of ~11 pixels decided a 2 m cell, so a
    crown's edge or an eave flagged it, and NAIP-CHM called 13.7% of the
    cells neither the tree model nor the lidar calls canopy. Cover asks for
    half the cell.
    """
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject, transform_bounds

    out = np.full((gh, gw), np.nan, dtype=np.float32)
    cover = np.full((gh, gw), np.nan, dtype=np.float32)
    covers = {thr: np.full((gh, gw), np.nan, dtype=np.float32) for thr in SWEEP_M}
    dst_t = from_bounds(*bbox, gw, gh)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                      GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2"):
        for _, _, url in newest_only(files):
            with rasterio.open("/vsicurl/" + url) as src:
                l, b, r, t = transform_bounds("EPSG:3857", src.crs, *bbox, densify_pts=21)
                pad = 3 * max(src.res)
                win = src.window(l - pad, b - pad, r + pad, t + pad).round_offsets().round_lengths()
                raw = src.read(1, window=win, boundless=True, fill_value=src.nodata if src.nodata is not None else 65535)
                m = raw.astype(np.float32) / 100.0
                m[raw == (src.nodata if src.nodata is not None else 65535)] = np.nan
                dst = np.full((gh, gw), np.nan, dtype=np.float32)
                reproject(m, dst, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.max)
                out = np.where(np.isnan(out), dst, np.fmax(out, dst))
                tall = np.where(np.isnan(m), np.nan, (m >= CANOPY_M).astype(np.float32))
                dc = np.full((gh, gw), np.nan, dtype=np.float32)
                reproject(tall, dc, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.average)
                cover = np.where(np.isnan(cover), dc, np.fmax(cover, dc))
                for thr in SWEEP_M:
                    t2 = np.where(np.isnan(m), np.nan, (m >= thr).astype(np.float32))
                    d2 = np.full((gh, gw), np.nan, dtype=np.float32)
                    reproject(t2, d2, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=np.nan,
                              dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.average)
                    covers[thr] = np.where(np.isnan(covers[thr]), d2, np.fmax(covers[thr], d2))
    READ_COVERS.clear()
    READ_COVERS.update(covers)
    return out, cover
