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


# RATE-LIMITED (2026-10-29): rockyweb answered 429 Too Many Requests to the
# 16-way download on all 18 tile lots of three runs in a row (S67, runs 266,
# 267, 268), the HEAD included, while one connection at a time was served.
# Fewer ranges at once, and a 429 is waited out (Retry-After when given, else
# a wait that doubles from 15 s) rather than counted as a failure.
#
# STILL REFUSED AT FOUR (run 271, 2026-10-29): through the model server, 6 of
# the 20 tiles it was asked for ended "HTTP Error 429" after seven tries
# (about ten minutes), four of them the only tile being fetched; each threw
# away every range already in hand. And four ranges bought no speed: the
# fourteen that arrived came at 0.05 to 0.43 MB/s for the whole tile, the
# same as the one connection (~0.2 to 0.36) measured before. So: two ranges;
# a range that breaks carries on from the byte it reached; and a 429 is
# waited out until `patient_until` (RATE_PATIENCE_S from the start unless
# the caller says), not for seven tries. Other errors still have seven.
RANGE_PARTS = 2
RANGE_STAGGER_S = 0.5  # the ranges start half a second apart: the refusal page refreshes after one second, a per-second limit
RATE_WAIT_S = 15
RATE_WAIT_MAX_S = 180
RATE_TRIES = 7
RATE_PATIENCE_S = 1800
ERROR_WAIT_S = 5
PROGRESS_EVERY_S = 3


def _refused(e):
    import urllib.error
    return isinstance(e, urllib.error.HTTPError) and e.code == 429


def _wait_for(e, attempt):
    """How long to wait after `e` on `attempt`: a 429's Retry-After, a doubling wait for a 429 without one, ERROR_WAIT_S steps otherwise."""
    if _refused(e):
        try:
            ra = float(e.headers.get("Retry-After") or 0)
        except (TypeError, ValueError):
            ra = 0
        return min(RATE_WAIT_MAX_S, max(ra, RATE_WAIT_S * 2 ** min(attempt, 12)))
    return ERROR_WAIT_S * (attempt + 1)


class _Patience:
    """One request's retries: a 429 waits until `until` without spending a
    try (it is USGS asking us to slow down, not a fault); anything else has
    `tries`. `again(e)` sleeps and returns, or raises `e` when out."""

    def __init__(self, tries, until):
        self.tries, self.until, self.errors, self.refusals = tries, until, 0, 0

    def again(self, e):
        import time
        if _refused(e):
            wait = _wait_for(e, self.refusals)
            self.refusals += 1
            if time.time() + wait > self.until:
                raise e
        else:
            self.errors += 1
            if self.errors >= self.tries:
                raise e
            wait = _wait_for(e, self.errors - 1)
        time.sleep(wait)


def fetch_ranged(url, path, parts=RANGE_PARTS, timeout=120, tries=RATE_TRIES, progress=None, patient_until=None):
    """A whole file in `parts` parallel byte ranges.
    The folder is made if it is not there: the first release run on this reader
    lost 12 of 18 tile frames to a missing folder (2026-10-13).
    `progress(done_bytes, size_bytes)` is told as the bytes arrive, about
    every PROGRESS_EVERY_S, so a person waiting on a press can be told how far
    the download has got (tools/modal_serve.py). A range cut short carries on
    from where it stopped; USGS's 429s are waited out until `patient_until`
    (a time.time(); default RATE_PATIENCE_S from now)."""
    import threading
    import time
    path = Path(path)
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    until = patient_until if patient_until is not None else time.time() + RATE_PATIENCE_S
    size = None
    head = _Patience(tries, until)
    while size is None:  # rockyweb times out now and then; the HEAD is retried as the ranges are
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                size = int(r.headers["Content-Length"])
        except Exception as e:  # noqa: BLE001 - retried, then raised
            head.again(e)
    step = max(1, math.ceil(size / parts))
    ranges = [(s, min(size, s + step) - 1) for s in range(0, size, step)]
    tmp = path.with_suffix(".part")
    lock = threading.Lock()
    done = [0, 0.0]  # bytes in hand, when progress was last told

    def tell(n, force=False):
        if progress is None:
            return
        with lock:
            done[0] += n
            now = time.time()
            if not force and now - done[1] < PROGRESS_EVERY_S:
                return
            done[1] = now
            got = done[0]
        try:
            progress(got, size)
        except Exception:  # noqa: BLE001 - a courtesy, never the download
            pass

    tell(0, force=True)

    def get(rng):
        time.sleep(RANGE_STAGGER_S * (ranges.index(rng) % parts))
        buf = bytearray()
        want = rng[1] - rng[0] + 1
        patience = _Patience(tries, until)
        while len(buf) < want:
            start = rng[0] + len(buf)
            try:
                q = urllib.request.Request(url, headers={"Range": f"bytes={start}-{rng[1]}"})
                with urllib.request.urlopen(q, timeout=timeout) as r:
                    if getattr(r, "status", 206) != 206 and not (start == 0 and rng[1] == size - 1):
                        raise IOError(f"range ignored (HTTP {r.status})")
                    while True:
                        b = r.read(1 << 16)  # small reads: a break loses at most this much
                        if not b:
                            break
                        b = b[:want - len(buf)]
                        buf += b
                        tell(len(b))
                if len(buf) < want:
                    raise IOError(f"short range {len(buf)} of {want}")
            except Exception as e:  # noqa: BLE001 - carried on from len(buf), then raised
                patience.again(e)
        return rng[0], bytes(buf)

    with open(tmp, "wb") as f:
        f.truncate(size)
        with concurrent.futures.ThreadPoolExecutor(parts) as ex:
            for start, data in ex.map(get, ranges):
                f.seek(start)
                f.write(data)
    tmp.rename(path)
    return path


def _tile_crs(f, path=None):
    """The tile's CRS (rasterio) and metres per unit of z, from its WKT. One of
    our own crops (CROP_SUFFIX, written by records_laz) carries none: it is
    Web Mercator metres by construction, and named so."""
    from rasterio.crs import CRS
    wkt = wkt_of(f.header)
    if not wkt and path is not None and str(path).endswith(CROP_SUFFIX):
        return CRS.from_epsg(3857), 1.0
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
        crs, zf = _tile_crs(f, path)
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


def _points_of(r):
    """tile_records' arrays as (x, y, z m, intensity, class) rows."""
    if not len(r["x"]):
        return np.zeros((0, 5))
    return np.column_stack([r["x"], r["y"], r["z"], r["intensity"].astype(np.float64), r["cls"].astype(np.float64)])


def tile_points(path, bbox3857):
    """Points of one tile inside bbox (Web Mercator), as (x, y, z m, intensity, class)."""
    return _points_of(tile_records(path, bbox3857))


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


# ------------------------------------------------------------- the areas

# ONE CROP AN ADDRESS, KEPT ON THE SERVER'S VOLUME (owner, 2026-10-29: "when a
# user enters an address into lawn map: we should initiate the download, crop
# it to the sizes needed by the shade map and water map, save it to a cache so
# it's available to the shade map, water map, and ai detector").
#
# USGS's tiles are 1.5 km squares of 30-130 MB; a lot needs a few hundred
# metres of one or two. The model server fetches the tiles once (they stay on
# its volume), then cuts the square around the address at full density into
# areas/<the tiles' key>/<w>_<s>_<e>_<n>.3857.laz. Every later read whose box
# lies inside an area -- the shade map's (full density), the water map's
# (thinned to 1.8 m), the detector's frame -- is cut from that small file
# instead of decompressing whole tiles. The name carries the box, so finding
# one needs no index and two writers cannot corrupt one (each writes its own
# .part and renames it).
CROP_SUFFIX = ".3857.laz"
AREA_DIR = "areas"


def tiles_key(urls):
    """A short, stable name for a set of tiles, whatever order they come in."""
    import hashlib
    names = sorted(str(u).rsplit("/", 1)[-1] for u in urls)
    return hashlib.sha1("|".join(names).encode()).hexdigest()[:16]


def _box_name(box):
    return "_".join(str(int(v)) for v in box)


def area_box_of(path):
    """The box an area file covers, from its name; None for any other file."""
    name = Path(path).name
    if not name.endswith(CROP_SUFFIX):
        return None
    try:
        b = [float(v) for v in name[: -len(CROP_SUFFIX)].split("_")]
    except ValueError:
        return None
    return b if len(b) == 4 and b[0] < b[2] and b[1] < b[3] else None


def area_covering(tile_dir, urls, box):
    """The smallest kept area of these tiles that holds `box`, or None."""
    d = Path(tile_dir) / AREA_DIR / tiles_key(urls)
    if not d.is_dir():
        return None
    best, best_m2 = None, None
    for p in d.glob("*" + CROP_SUFFIX):
        b = area_box_of(p)
        if b and b[0] <= box[0] and b[1] <= box[1] and b[2] >= box[2] and b[3] >= box[3] and p.stat().st_size > 0:
            m2 = (b[2] - b[0]) * (b[3] - b[1])
            if best is None or m2 < best_m2:
                best, best_m2 = p, m2
    return best


def write_area(tile_dir, urls, box):
    """Cut the tiles (already in tile_dir) to `box`, rounded out to whole
    metres, at full density, and keep it as an area. Returns its path."""
    box = [math.floor(box[0]), math.floor(box[1]), math.ceil(box[2]), math.ceil(box[3])]
    out = Path(tile_dir) / AREA_DIR / tiles_key(urls) / (_box_name(box) + CROP_SUFFIX)
    if out.exists() and out.stat().st_size > 0:
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    paths = [str(Path(tile_dir) / str(u).rsplit("/", 1)[-1]) for u in urls]
    tmp = out.with_name(out.name + ".part")
    tmp.write_bytes(crop_tiles_laz(paths, box))
    tmp.rename(out)
    return out


# THROUGH THE MODEL SERVER (owner, 2026-10-29: "yes do it"). The training
# runner's own downloads from rockyweb were refused (429) or stalled on 15 of
# the 18 tile lots in every S67 run, so they read older flights. The model
# server's network is served; its volume keeps every tile it has fetched, for
# the live site too. So the runner asks the server for its frame's crop
# (crop_tiles, a few MB) and has the server fetch whatever tiles are missing
# (fetch_tiles) -- once, ever.
SERVER_APP = "lawn-mapper-alpha"


def crop_from_server(urls, box, out_dir, app=SERVER_APP, say=print):
    """The points of these tiles inside `box`, cut by the model server, kept in
    out_dir as one of our crops. Raises when the server cannot fetch them."""
    out = Path(out_dir) / f"{tiles_key(urls)}-{_box_name([math.floor(box[0]), math.floor(box[1]), math.ceil(box[2]), math.ceil(box[3])])}{CROP_SUFFIX}"
    if out.exists() and out.stat().st_size > 0:
        return out
    import modal
    crop = modal.Function.from_name(app, "crop_tiles")
    got = crop.remote(list(urls), list(box), 0.0)
    if got.get("missing"):
        say(f"    the server is fetching {len(got['missing'])} tile(s) from USGS (once; kept on its volume)")
        modal.Function.from_name(app, "fetch_tiles").remote(list(got["missing"]))
        got = crop.remote(list(urls), list(box), 0.0)
    if got.get("missing"):
        raise RuntimeError(f"the model server could not fetch {len(got['missing'])} tile(s)")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    tmp.write_bytes(got["laz"])
    tmp.rename(out)
    return out


# ------------------------------------------------------------- the season

# WHETHER THE LIDAR WAS FLOWN IN LEAF, POINT BY POINT (owner, 2026-10-29,
# S68: on a leaf-on flight a live press hides the lidar from the decoder,
# which has seen little summer lidar, and keeps the veto and the woods rule).
# Each point is dated by its own GPS time exactly as the shade map does
# (public/shade/las.js gpsMs and leafOfMs): by the value, not the header's
# bit -- under a week is time-of-week and says nothing of the date; up to
# 2001's raw count it is adjusted standard time (less 1e9); above, raw. A day
# from 1 November to 10 May is leaf-off, the rest in leaf. USGS's own
# collection window would call Ketchum's summer-and-summer survey "mixed".
GPS_EPOCH_UNIX = 315964800        # 1980-01-06
GPS_WEEK_S = 604800
RAW_GPS_2001_S = 6.6e8
LEAF_SAMPLE = 5000


def leaf_on_share(gps):
    """(share of dated points flown in leaf, how many were dated) from GPS
    times; (None, 0) when none can be dated."""
    if gps is None:
        return None, 0
    g = np.asarray(gps, dtype=np.float64)
    if len(g) > LEAF_SAMPLE:
        g = g[np.linspace(0, len(g) - 1, LEAF_SAMPLE).astype(np.int64)]
    g = g[np.isfinite(g) & (np.abs(g) >= GPS_WEEK_S)]
    unix = GPS_EPOCH_UNIX + np.where(g >= RAW_GPS_2001_S, g, g + 1e9)
    import time as _time
    unix = unix[(unix > 788918400) & (unix < _time.time() + 366 * 86400)]   # 1995 to a year ahead
    if not len(unix):
        return None, 0
    day = unix.astype("datetime64[s]").astype("datetime64[D]")
    month = (day.astype("datetime64[M]").astype(np.int64) % 12) + 1
    dom = (day - day.astype("datetime64[M]")).astype(np.int64) + 1
    off = (month >= 11) | (month <= 4) | ((month == 5) & (dom <= 10))
    return float((~off).mean()), int(len(unix))


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


def read_points(read_octree, bbox, epoch, tiles=None, tile_dir=None, extra_m=None, raw_cache=None, key=None, server_crop=None):
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
    `server_crop(urls, box)`, when given, cuts tiles named by URL to the box and
    returns the path of the crop (crop_from_server): the training runner's
    way to the newest flight without downloading whole tiles itself.
    Returns (points, info) with the keys lidar_frame.main() records.
    """
    wide = grow(bbox, 5)
    pts, info = raw_cached(raw_cache, key)
    if pts is None:
        if tiles and server_crop is not None and all(str(t).startswith("http") for t in tiles):
            path = Path(server_crop(list(tiles), wide))
            r = tile_records(path, wide)
            pts = _points_of(r)
            info = {"nodes": len(tiles), "tiles": True, "mb": path.stat().st_size / 1e6, "via": "server"}
            info["leafOnShare"], info["dated"] = leaf_on_share(r["gps"])
        elif tiles:
            parts, gps, mb = [], [], 0.0
            for t in tiles:
                path = Path(t) if not str(t).startswith("http") else fetch_ranged(t, Path(tile_dir) / str(t).rsplit("/", 1)[-1])
                mb += path.stat().st_size / 1e6
                r = tile_records(path, wide)
                parts.append(_points_of(r))
                if r["gps"] is not None:
                    gps.append(r["gps"])
            pts = np.vstack(parts) if parts else np.zeros((0, 5))
            info = {"nodes": len(tiles), "tiles": True, "mb": mb}
            info["leafOnShare"], info["dated"] = leaf_on_share(np.concatenate(gps) if gps else None)
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
