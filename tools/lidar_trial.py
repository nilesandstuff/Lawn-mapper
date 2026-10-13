"""
THE LIDAR TRIALS (owner, 2026-10-13: "go ahead with all three") -- the same
reader as tools/lidar_frame.py, with one thing changed, for workflow 14's
`lidar_trial` input. Never served: the live model reads lidar_frame.py, which
this leaves byte for byte as it was, so nothing here reaches the site until a
trial is measured and adopted.

  datum   (S35) every octree point moved by the NAD83 -> WGS84 correction
          at the frame, for the flight's epoch. The features session found
          the USGS octrees on AWS are NAD83 coordinates labelled EPSG:3857,
          0.2-0.8 m east and 0.7-1.2 m south of the photo on four lots; the
          published ITRF2008 -> NAD83(2011) transformation (Pearson & Snay
          2013) predicted the move to 0.1-0.4 m. A Python port of its
          public/shade/datum.js, checked against it in lidar_trial_test.py.

  newest  (H94) the newest flight USGS has over the frame, by its own index
          (tools/lidar-newest.js writes the plan): an octree dated by WESM
          rather than by its name, or -- where USGS has published a newer
          flight as LAZ tiles on rockyweb.usgs.gov that is not on AWS yet --
          those tiles, downloaded whole, reprojected from their own CRS
          (state plane or UTM, often in US survey feet) to Web Mercator, and
          cropped to the frame. The tiles get the SAME null NAD83 -> WGS84
          treatment the octrees were built with, so the trial changes only
          the flight, not the datum. Points classed noise (7 low, 18 high)
          are dropped in this trial, from tiles and octrees alike: a 2024 QL1
          tile carried 405 high-noise points up to 50 m over one 120 m frame
          (Will County IL), where the octrees read 0-1 a frame, and the
          baseline reader keeps them as height.

HOW. lidar_frame.main() reads every frame through lidar_frame.points_over;
this replaces that one function and calls main() unchanged, so the classes,
layers, masks and files are exactly the ones the baseline writes. A plan
entry for tiles carries the url "tiles://<lot id>/ept.json", which main()
hands back here as the base "tiles://<lot id>".

    LIDAR_TRIAL=datum|newest FRAMES=frames CANOPY=canopy PLAN=lidar-plan.json OUT=lidar python3 tools/lidar_trial.py
"""

import concurrent.futures
import json
import math
import os
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np

# ------------------------------------------------------------- the datum (S35)

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


# ------------------------------------------------------------ the tiles (H94)

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


def fetch_ranged(url, path, parts=16, timeout=120):
    """A whole file in `parts` parallel byte ranges (rockyweb gives one connection ~0.2 MB/s)."""
    path = Path(path)
    if path.exists() and path.stat().st_size > 0:
        return path
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        size = int(r.headers["Content-Length"])
    step = max(1, math.ceil(size / parts))
    ranges = [(s, min(size, s + step) - 1) for s in range(0, size, step)]
    tmp = path.with_suffix(".part")

    def get(rng):
        for attempt in range(4):
            try:
                q = urllib.request.Request(url, headers={"Range": f"bytes={rng[0]}-{rng[1]}"})
                with urllib.request.urlopen(q, timeout=timeout) as r:
                    data = r.read()
                if len(data) != rng[1] - rng[0] + 1:
                    raise IOError(f"short range {len(data)}")
                return rng[0], data
            except Exception:  # noqa: BLE001 - retried, then raised
                if attempt == 3:
                    raise
        return None

    with open(tmp, "wb") as f:
        f.truncate(size)
        with concurrent.futures.ThreadPoolExecutor(parts) as ex:
            for start, data in ex.map(get, ranges):
                f.seek(start)
                f.write(data)
    tmp.rename(path)
    return path


def tile_points(path, bbox3857):
    """Points of one tile inside bbox (Web Mercator), as (x, y, z m, intensity, class)."""
    import laspy
    from rasterio.crs import CRS
    from rasterio.warp import transform
    with laspy.open(str(path)) as f:
        wkt = wkt_of(f.header)
        if not wkt:
            raise RuntimeError(f"{Path(path).name} carries no WKT; refusing to guess its coordinates")
        crs = CRS.from_wkt(wkt)
        zf = vertical_factor(wkt)
        # The frame in the tile's own coordinates (corners and edge midpoints, a margin for the bend).
        bx = [bbox3857[0], bbox3857[2], bbox3857[0], bbox3857[2], (bbox3857[0] + bbox3857[2]) / 2, (bbox3857[0] + bbox3857[2]) / 2]
        by = [bbox3857[1], bbox3857[1], bbox3857[3], bbox3857[3], bbox3857[1], bbox3857[3]]
        nx, ny = transform("EPSG:3857", crs, bx, by)
        pad = 0.02 * max(max(nx) - min(nx), max(ny) - min(ny)) + 10
        lo_x, hi_x, lo_y, hi_y = min(nx) - pad, max(nx) + pad, min(ny) - pad, max(ny) + pad
        parts = []
        for chunk in f.chunk_iterator(2_000_000):
            x, y = np.asarray(chunk.x), np.asarray(chunk.y)
            m = (x >= lo_x) & (x <= hi_x) & (y >= lo_y) & (y <= hi_y)
            if m.any():
                parts.append(np.column_stack([x[m], y[m], np.asarray(chunk.z)[m] * zf,
                                              np.asarray(chunk.intensity)[m].astype(np.float64),
                                              np.asarray(chunk.classification)[m].astype(np.float64)]))
    if not parts:
        return np.zeros((0, 5))
    pts = np.vstack(parts)
    mx, my = transform(crs, "EPSG:3857", pts[:, 0].tolist(), pts[:, 1].tolist())
    pts[:, 0], pts[:, 1] = mx, my
    keep = (pts[:, 0] >= bbox3857[0]) & (pts[:, 0] <= bbox3857[2]) & (pts[:, 1] >= bbox3857[1]) & (pts[:, 1] <= bbox3857[3])
    return pts[keep]


NOISE = (7, 18)


def drop_noise(pts):
    """Without the points classed low (7) or high (18) noise."""
    return pts[~np.isin(pts[:, 4], NOISE)] if len(pts) else pts


# ---------------------------------------------------------------- the reader

def install(plan, mode, tile_dir):
    """Replace lidar_frame.points_over for this run. Returns the module."""
    import lidar_frame
    original = lidar_frame.points_over
    by_base = {}
    for lawn_id, p in plan.items():
        if p and p.get("url"):
            by_base.setdefault(p["url"].rsplit("/", 1)[0], []).append((lawn_id, p))

    def entry_for(base, bbox):
        cands = by_base.get(base) or []
        if len(cands) == 1:
            return cands[0][1]
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        for _, p in cands:  # several frames on one octree: the plan's box says which
            b = p.get("box")
            if b and b[0] <= cx <= b[2] and b[1] <= cy <= b[3]:
                return p
        return cands[0][1] if cands else {}

    def points_over(base, bbox, limit_nodes=400):
        p = entry_for(base, bbox)
        if base.startswith("tiles://"):
            parts, mb = [], 0.0
            for url in p.get("tiles") or []:
                path = fetch_ranged(url, Path(tile_dir) / url.rsplit("/", 1)[-1])
                mb += path.stat().st_size / 1e6
                parts.append(tile_points(path, bbox))
            pts = drop_noise(np.vstack(parts) if parts else np.zeros((0, 5)))
            # The keys lidar_frame.main() records for an octree read; "nodes" counts tiles here.
            return pts, {"nodes": len(p.get("tiles") or []), "tiles": True, "mb": mb, "points": int(len(pts))}
        if mode == "datum":
            lng, lat = merc_to_lnglat((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
            epoch = p.get("epoch") or ((p.get("year") or 2015) + 0.5)
            dx, dy = mercator_shift(lat, lng, epoch)
            pts, got = original(base, grow(bbox, 5), limit_nodes)
            pts = pts.copy()
            pts[:, 0] += dx
            pts[:, 1] += dy
            keep = (pts[:, 0] >= bbox[0]) & (pts[:, 0] <= bbox[2]) & (pts[:, 1] >= bbox[1]) & (pts[:, 1] <= bbox[3])
            got = dict(got, shift_m=[round(v * math.cos(math.radians(lat)), 3) for v in (dx, dy)], epoch=epoch)
            return pts[keep], got
        pts, got = original(base, bbox, limit_nodes)
        return drop_noise(pts), got

    lidar_frame.points_over = points_over
    return lidar_frame


def main():
    mode = os.environ.get("LIDAR_TRIAL", "")
    if mode not in ("datum", "newest"):
        print(f"LIDAR_TRIAL={mode!r}: say datum or newest.")
        sys.exit(1)
    plan_file = Path(os.environ.get("PLAN", "lidar-plan.json"))
    plan = json.loads(plan_file.read_text())
    tile_dir = Path(os.environ.get("TILE_DIR", "lidar-tiles"))
    tile_dir.mkdir(parents=True, exist_ok=True)
    # Frames sharing one octree are told apart by their boxes.
    scale = json.loads((Path(os.environ.get("FRAMES", "frames")) / "scale.json").read_text())
    for lawn_id, p in plan.items():
        if p and lawn_id in (scale.get("boxes") or {}):
            p["box"] = scale["boxes"][lawn_id]
    if mode == "datum":
        moves = []
        for lawn_id, p in plan.items():
            b = p and p.get("box")
            if b and p.get("url"):
                lng, lat = merc_to_lnglat((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
                e, n = nad83_correction(lat, lng, p.get("epoch") or ((p.get("year") or 2015) + 0.5))
                moves.append((e, n))
        if moves:
            e = np.array(moves)
            print(f"S35 DATUM TRIAL: {len(moves)} frames moved; east {np.median(e[:, 0]):+.2f} m "
                  f"(range {e[:, 0].min():+.2f} to {e[:, 0].max():+.2f}), north {np.median(e[:, 1]):+.2f} m "
                  f"(range {e[:, 1].min():+.2f} to {e[:, 1].max():+.2f}), median.\n")
    else:
        tiles = [p for p in plan.values() if p and str(p.get("url", "")).startswith("tiles://")]
        print(f"H94 NEWEST TRIAL: {len(tiles)} frames read from USGS's newer LAZ tiles, the rest from octrees.\n")
    install(plan, mode, tile_dir).main()


if __name__ == "__main__":
    main()
