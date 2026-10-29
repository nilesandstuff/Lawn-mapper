"""
WHERE THE LIDAR'S POINTS COME FROM, AND WHERE THEY BELONG (2026-10-13).

Three things every lidar read here does, in training (lidar_frame.main) and
on the live server (lidar_frame.lidar_for) alike, so the two cannot drift:

  THE NEWEST FLIGHT (H94, H96). The plan (tools/lidar-newest.js) picks the
  newest flight USGS has over a frame by USGS's own dates. Usually that is an
  Entwine octree on AWS; where USGS has published a newer flight only as LAZ
  tiles on rockyweb.usgs.gov, it is those tiles, downloaded whole (16
  parallel ranges: one connection gives ~0.2 MB/s), reprojected from their
  own CRS -- state plane or UTM, often US survey feet -- to Web Mercator, and
  cropped. Training reads them into a scratch folder; the live server keeps
  them on a Modal volume (tools/modal_serve.py) and reads the octree until
  they are there. H96: on the 20 locked lots it changes, 10 better, 1 worse.

  THE DATUM (S35, H95). USGS lidar is surveyed in NAD83; the octrees on AWS
  and a plain reprojection of the tiles both treat NAD83 coordinates as
  WGS84's, which puts the cloud 0.5-1.2 m east and south of the photo. Every
  point is moved by the published ITRF2008 -> NAD83(2011) transformation
  (Pearson & Snay 2013) at the flight's epoch -- a port of the shade map's
  public/shade/datum.js, checked against it to 2 mm (lidar_sources_test.py).
  Measured as nothing either way on THE PLAN's score (H95); adopted because
  it is correct (owner, 2026-10-13).

  NOISE. Points the survey classed as noise (7 low, 18 high) are dropped: a
  2025 tile carried 405 high-noise points up to 50 m over one 120 m frame,
  and every reader here would have kept them as height.
"""

import concurrent.futures
import json
import math
import re
import urllib.request
from pathlib import Path

import numpy as np

# ------------------------------------------------------------- the datum

A = 6378137.0
F = 1 / 298.257222101  # GRS80
E2 = F * (2 - F)
MAS = math.pi / 180 / 3600 / 1000
# ITRF2008 -> NAD83(2011) at epoch 1997.0, with rates a year (Pearson & Snay 2013, Table 7).
T0, TD = (0.99343, -1.90331, -0.52655), (0.00079, -0.00060, -0.00134)
R0, RD = (25.91467, 9.42645, 11.59935), (0.06667, -0.75744, -0.05133)
S0, SD = 1.71504e-9, -0.10201e-9
R_MERC = 6378137.0


def to_xyz(lat, lng, h=0.0):
    la, lo = math.radians(lat), math.radians(lng)
    n = A / math.sqrt(1 - E2 * math.sin(la) ** 2)
    return ((n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo),
            (n * (1 - E2) + h) * math.sin(la))


def to_geo(xyz):
    x, y, z = xyz
    lo = math.atan2(y, x)
    p = math.hypot(x, y)
    la = math.atan2(z, p * (1 - E2))
    for _ in range(8):
        n = A / math.sqrt(1 - E2 * math.sin(la) ** 2)
        h = p / math.cos(la) - n
        la = math.atan2(z, p * (1 - E2 * n / (n + h)))
    return math.degrees(la), math.degrees(lo)


def itrf_to_nad83(xyz, epoch):
    dt = epoch - 1997
    t = [T0[i] + TD[i] * dt for i in range(3)]
    rx, ry, rz = ((R0[i] + RD[i] * dt) * MAS for i in range(3))
    s = S0 + SD * dt
    x, y, z = xyz
    return (t[0] + (1 + s) * x + rz * y - ry * z,
            t[1] - rz * x + (1 + s) * y + rx * z,
            t[2] + ry * x - rx * y + (1 + s) * z)


def nad83_shift_deg(lat, lng, epoch):
    """
    Degrees (north, east) to ADD to a NAD83 coordinate that was read as WGS84,
    to put it on WGS84's ground, near (lat, lng), for a flight at `epoch`.
    """
    la2, lo2 = to_geo(itrf_to_nad83(to_xyz(lat, lng), epoch))
    return -(la2 - lat), -(lo2 - lng)


def nad83_correction(lat, lng, epoch):
    """The same move in metres east and north, as datum.js's nad83Correction (6371 km sphere)."""
    dn, de = nad83_shift_deg(lat, lng, epoch)
    return (math.radians(de) * 6371000 * math.cos(math.radians(lat)), math.radians(dn) * 6371000)


def mercator_shift(lat, lng, epoch):
    """The move in Web Mercator metres (dx, dy), which is what the octree's points are in."""
    dn, de = nad83_shift_deg(lat, lng, epoch)
    return R_MERC * math.radians(de), R_MERC * math.radians(dn) / math.cos(math.radians(lat))


def merc_to_lnglat(x, y):
    return math.degrees(x / R_MERC), math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)


def grow(bbox, m):
    return (bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m)


# ------------------------------------------------------------ the tiles

def wkt_of(header):
    """The OGC WKT a LAS 1.4 file carries (record 2112, often in the EVLRs), or None."""
    for v in list(header.vlrs) + list(getattr(header, "evlrs", None) or []):
        if getattr(v, "record_id", None) == 2112:
            s = v.string if isinstance(v.string, str) else bytes(v.string).decode("utf-8", "replace")
            return s.strip("\x00 ")
    return None


UNIT_RE = re.compile(r'UNIT\["[^"]*",\s*([0-9.eE+-]+)')


def vertical_factor(wkt):
    """
    Metres per unit of z. From the vertical part of a compound WKT (VERT_CS /
    VERTCRS); without one, the horizontal unit's factor, since a USGS delivery
    in US survey feet is in feet both ways. 1.0 when nothing says.
    """
    s = wkt or ""
    i = max(s.find("VERT_CS"), s.find("VERTCRS"))
    if i >= 0:
        m = UNIT_RE.search(s, i)
        if m:
            return float(m.group(1))
    i = max(s.find("PROJCS"), s.find("PROJCRS"))
    if i >= 0:
        units = UNIT_RE.findall(s[i:])
        if units:
            return float(units[-1]) if len(units) > 1 else float(units[0])
    return 1.0


def fetch_ranged(url, path, parts=16, timeout=120, tries=4):
    """A whole file in `parts` parallel byte ranges (rockyweb gives one connection ~0.2 MB/s).
    The folder is made if it is not there: the first release run on this reader
    lost 12 of 18 tile frames to a missing folder (2026-10-13)."""
    import time
    path = Path(path)
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    size = None
    for attempt in range(tries):  # rockyweb times out now and then; the HEAD is retried as the ranges are
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                size = int(r.headers["Content-Length"])
            break
        except Exception:  # noqa: BLE001 - retried, then raised
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    step = max(1, math.ceil(size / parts))
    ranges = [(s, min(size, s + step) - 1) for s in range(0, size, step)]
    tmp = path.with_suffix(".part")

    def get(rng):
        for attempt in range(tries):
            try:
                q = urllib.request.Request(url, headers={"Range": f"bytes={rng[0]}-{rng[1]}"})
                with urllib.request.urlopen(q, timeout=timeout) as r:
                    data = r.read()
                if len(data) != rng[1] - rng[0] + 1:
                    raise IOError(f"short range {len(data)}")
                return rng[0], data
            except Exception:  # noqa: BLE001 - retried, then raised
                if attempt == tries - 1:
                    raise
                time.sleep(5 * (attempt + 1))
        return None

    with open(tmp, "wb") as f:
        f.truncate(size)
        with concurrent.futures.ThreadPoolExecutor(parts) as ex:
            for start, data in ex.map(get, ranges):
                f.seek(start)
                f.write(data)
    tmp.rename(path)
    return path


def _tile_crs(f):
    """The tile's CRS (rasterio) and metres per unit of z, from its WKT."""
    from rasterio.crs import CRS
    wkt = wkt_of(f.header)
    if not wkt:
        raise RuntimeError("tile carries no WKT; refusing to guess its coordinates")
    return CRS.from_wkt(wkt), vertical_factor(wkt)


def tile_records(path, bbox3857):
    """
    The records of one tile inside bbox (Web Mercator), as a dict of arrays:
    x, y (3857 metres), z (metres), intensity, ret, nret, cls, gps (None when
    the format keeps no time). Everything a page's reader gets from an octree
    node (public/shade/las.js makeColumns), so a crop of tiles can stand in
    for one (crop_tiles_laz).
    """
    import laspy
    from rasterio.warp import transform
    with laspy.open(str(path)) as f:
        crs, zf = _tile_crs(f)
        # The frame in the tile's own coordinates (corners and edge midpoints, a margin for the bend).
        bx = [bbox3857[0], bbox3857[2], bbox3857[0], bbox3857[2], (bbox3857[0] + bbox3857[2]) / 2, (bbox3857[0] + bbox3857[2]) / 2]
        by = [bbox3857[1], bbox3857[1], bbox3857[3], bbox3857[3], bbox3857[1], bbox3857[3]]
        nx, ny = transform("EPSG:3857", crs, bx, by)
        pad = 0.02 * max(max(nx) - min(nx), max(ny) - min(ny)) + 10
        lo_x, hi_x, lo_y, hi_y = min(nx) - pad, max(nx) + pad, min(ny) - pad, max(ny) + pad
        has_gps = "gps_time" in f.header.point_format.dimension_names
        parts = {k: [] for k in ("x", "y", "z", "intensity", "ret", "nret", "cls", "gps")}
        for chunk in f.chunk_iterator(2_000_000):
            x, y = np.asarray(chunk.x), np.asarray(chunk.y)
            m = (x >= lo_x) & (x <= hi_x) & (y >= lo_y) & (y <= hi_y)
            if not m.any():
                continue
            parts["x"].append(x[m])
            parts["y"].append(y[m])
            parts["z"].append(np.asarray(chunk.z)[m] * zf)
            parts["intensity"].append(np.asarray(chunk.intensity)[m].astype(np.uint16))
            parts["ret"].append(np.asarray(chunk.return_number)[m].astype(np.uint8))
            parts["nret"].append(np.asarray(chunk.number_of_returns)[m].astype(np.uint8))
            parts["cls"].append(np.asarray(chunk.classification)[m].astype(np.uint8))
            if has_gps:
                parts["gps"].append(np.asarray(chunk.gps_time)[m].astype(np.float64))
    if not parts["x"]:
        return {k: np.zeros(0, dtype=np.float64 if k in ("x", "y", "z", "gps") else np.uint16) for k in parts if k != "gps" or has_gps} | {"gps": None if not has_gps else np.zeros(0)}
    rec = {k: np.concatenate(v) for k, v in parts.items() if v}
    if not has_gps:
        rec["gps"] = None
    mx, my = transform(crs, "EPSG:3857", rec["x"].tolist(), rec["y"].tolist())
    rec["x"], rec["y"] = np.asarray(mx, dtype=np.float64), np.asarray(my, dtype=np.float64)
    keep = (rec["x"] >= bbox3857[0]) & (rec["x"] <= bbox3857[2]) & (rec["y"] >= bbox3857[1]) & (rec["y"] <= bbox3857[3])
    return {k: (v[keep] if v is not None else None) for k, v in rec.items()}


def tile_points(path, bbox3857):
    """Points of one tile inside bbox (Web Mercator), as (x, y, z m, intensity, class)."""
    r = tile_records(path, bbox3857)
    if not len(r["x"]):
        return np.zeros((0, 5))
    return np.column_stack([r["x"], r["y"], r["z"], r["intensity"].astype(np.float64), r["cls"].astype(np.float64)])


def thin_records(rec, spacing_merc):
    """At most one record per spacing x spacing cell (the first met), as an octree's coarse levels give a few points a cell."""
    if not spacing_merc or spacing_merc <= 0 or not len(rec["x"]):
        return rec
    ix = np.floor(rec["x"] / spacing_merc).astype(np.int64)
    iy = np.floor(rec["y"] / spacing_merc).astype(np.int64)
    _, first = np.unique(ix * 4_000_003 + iy, return_index=True)
    first.sort()
    return {k: (v[first] if v is not None else None) for k, v in rec.items()}


def records_laz(rec):
    """One LAZ (LAS 1.4, point format 6, EPSG:3857 metres, 1 cm) of the records, as bytes: what a page's reader decodes."""
    import io
    import laspy
    n = int(len(rec["x"]))
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.array([math.floor(float(rec["x"].min())) if n else 0.0,
                               math.floor(float(rec["y"].min())) if n else 0.0,
                               math.floor(float(rec["z"].min())) if n else 0.0])
    las = laspy.LasData(header)
    las.x = rec["x"]
    las.y = rec["y"]
    las.z = rec["z"]
    las.intensity = np.asarray(rec["intensity"], dtype=np.uint16)
    las.return_number = np.clip(np.asarray(rec["ret"], dtype=np.uint8), 0, 15)
    las.number_of_returns = np.clip(np.asarray(rec["nret"], dtype=np.uint8), 0, 15)
    las.classification = np.asarray(rec["cls"], dtype=np.uint8)
    las.gps_time = np.asarray(rec["gps"], dtype=np.float64) if rec.get("gps") is not None else np.zeros(n)
    buf = io.BytesIO()
    las.write(buf, do_compress=True)
    return buf.getvalue()


def crop_tiles_laz(paths, bbox3857, spacing_m=0.0):
    """
    THE PAGES' READ OF A TILE-ONLY FLIGHT (public/lib/lidar-tiles.js,
    2026-10-29): the points of these tiles inside bbox, raw -- no datum move,
    no noise drop, the pages do their own as they do for an octree -- as one
    LAZ. `spacing_m`, ground metres, thins to about one point per cell (the
    water map's wide look round a lot).
    """
    recs = [tile_records(p, bbox3857) for p in paths]
    recs = [r for r in recs if len(r["x"])]
    if not recs:
        rec = {"x": np.zeros(0), "y": np.zeros(0), "z": np.zeros(0), "intensity": np.zeros(0, np.uint16),
               "ret": np.zeros(0, np.uint8), "nret": np.zeros(0, np.uint8), "cls": np.zeros(0, np.uint8), "gps": None}
    else:
        gps = None if any(r["gps"] is None for r in recs) else np.concatenate([r["gps"] for r in recs])
        rec = {k: np.concatenate([r[k] for r in recs]) for k in ("x", "y", "z", "intensity", "ret", "nret", "cls")}
        rec["gps"] = gps
    if spacing_m and spacing_m > 0:
        _, lat = merc_to_lnglat((bbox3857[0] + bbox3857[2]) / 2, (bbox3857[1] + bbox3857[3]) / 2)
        rec = thin_records(rec, float(spacing_m) / math.cos(math.radians(lat)))
    return records_laz(rec)


# ------------------------------------------------------------- one read

NOISE = (7, 18)


def drop_noise(pts):
    """Without the points classed low (7) or high (18) noise."""
    return pts[~np.isin(pts[:, 4], NOISE)] if len(pts) else pts


DEFAULT_EPOCH = 2015.5  # a flight with no date anywhere: the middle of 3DEP's years; the move changes ~1 cm a year


def epoch_of(entry):
    """The flight's epoch from a plan entry: USGS's own dates, else the name's year, else DEFAULT_EPOCH."""
    if not entry:
        return DEFAULT_EPOCH
    if entry.get("epoch"):
        return float(entry["epoch"])
    if entry.get("year"):
        return float(entry["year"]) + 0.5
    return DEFAULT_EPOCH


def crop(pts, bbox):
    keep = (pts[:, 0] >= bbox[0]) & (pts[:, 0] <= bbox[2]) & (pts[:, 1] >= bbox[1]) & (pts[:, 1] <= bbox[3])
    return pts[keep]


def raw_cached(raw_cache, key):
    """The raw points saved under `raw_cache` for this `key`, or (None, None)."""
    if raw_cache is None or not Path(raw_cache).exists():
        return None, None
    try:
        with np.load(raw_cache, allow_pickle=False) as z:
            if str(z["key"]) != str(key):
                return None, None
            return np.asarray(z["pts"]), json.loads(str(z["info"]))
    except Exception:  # noqa: BLE001 - a bad file is a cache miss, not a failure
        return None, None


def read_points(read_octree, bbox, epoch, tiles=None, tile_dir=None, extra_m=None, raw_cache=None, key=None):
    """
    One frame's points, (x, y, z, intensity, class) in Web Mercator, with
    noise dropped and the datum move applied. From `tiles` (paths or URLs;
    URLs are fetched into tile_dir) when given, else `read_octree(bbox)`, which
    is lidar_frame.points_over for the frame's octree. Read 5 m wider, moved,
    then cropped, so the frame's edge is filled from the margin.
    `extra_m`, (east, north) in GROUND metres, is one more move after the
    datum's: the lot's own, measured against its photo's ground (H107/H108,
    tools/lidar-roof-fit.js, LIDAR_SHIFTS) -- the owner's "above all else,
    lidar needs to line up with the ground".
    `raw_cache`, a .npz path, keeps the frame's raw points (before the noise
    drop and the moves) so a later run with the same `key` (the flight's
    name and tiles) reads nothing from USGS: workflow 14 saves the folder
    between runs (owner, 2026-10-21: "shouldn't we just be caching
    everything related to the training corpus anyways?"). A different key
    reads afresh and overwrites.
    Returns (points, info) with the keys lidar_frame.main() records.
    """
    wide = grow(bbox, 5)
    pts, info = raw_cached(raw_cache, key)
    if pts is None:
        if tiles:
            parts, mb = [], 0.0
            for t in tiles:
                path = Path(t) if not str(t).startswith("http") else fetch_ranged(t, Path(tile_dir) / str(t).rsplit("/", 1)[-1])
                mb += path.stat().st_size / 1e6
                parts.append(tile_points(path, wide))
            pts = np.vstack(parts) if parts else np.zeros((0, 5))
            info = {"nodes": len(tiles), "tiles": True, "mb": mb}
        else:
            pts, info = read_octree(wide)
            info = dict(info)
        if raw_cache is not None:
            Path(raw_cache).parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(raw_cache, pts=np.asarray(pts, dtype=np.float64), key=np.array(str(key)), info=np.array(json.dumps(info)))
        info["from_cache"] = False
    else:
        info["from_cache"] = True
    pts = drop_noise(pts)
    if len(pts):
        lng, lat = merc_to_lnglat((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
        dx, dy = mercator_shift(lat, lng, epoch)
        if extra_m:
            k = math.cos(math.radians(lat))
            dx += float(extra_m[0]) / k
            dy += float(extra_m[1]) / k
            info["ground_shift_m"] = [round(float(v), 3) for v in extra_m]
        pts = pts.copy()
        pts[:, 0] += dx
        pts[:, 1] += dy
        info["shift_m"] = [round(v * math.cos(math.radians(lat)), 3) for v in (dx, dy)]
    pts = crop(pts, bbox) if len(pts) else pts
    info["points"] = int(len(pts))
    info["epoch"] = epoch
    return pts, info
