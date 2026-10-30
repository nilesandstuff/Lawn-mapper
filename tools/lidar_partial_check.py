"""
THE PARTIAL DOWNLOAD, PROVED BEFORE THE LIVE SITE USES IT (owner, 2026-10-30:
"make sure it works well before putting it on the live site").

A Modal app of its own (lawn-mapper-lidar-check), so nothing here touches the
live server's code. Run by workflow 47.

  simulate  Every USGS tile already on the server's volume, read in part for
            boxes of 100-250 m round random points (FileSource: the same code
            the network path runs, reading the file instead) and compared
            point for point with the whole tile's read (tile_records). Any
            difference is a failure. Reports the share of each file read.
  live      Real requests to rockyweb from Modal's network, for tiles not on
            the volume: does it answer multi-range; how long a part takes;
            then the whole tile, compared point for point with the part, and
            kept on the volume (as fetch_tiles would).
"""
import os
import sys

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
app = modal.App("lawn-mapper-lidar-check")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy", "laspy[lazrs]", "rasterio")
    .add_local_dir(HERE, "/root/tools", ignore=["**/__pycache__/**", "**/*.test.*"])
)
tiles = modal.Volume.from_name("lawn-lidar-tiles")
HALVES = (100, 150, 200, 250)


def _tools():
    if "/root/tools" not in sys.path:
        sys.path.insert(0, "/root/tools")
    import types
    import lidar_partial
    import lidar_sources
    return lidar_partial, lidar_sources, (lambda h: lidar_sources._tile_crs(types.SimpleNamespace(header=h)))


def _boxes(path, n, seed):
    """n boxes in Web Mercator round random points well inside the tile, cycling HALVES."""
    import math
    import laspy
    import numpy as np
    from rasterio.warp import transform
    _, s, crs_of = _tools()
    with laspy.open(path) as f:
        h = f.header
        crs, _ = crs_of(h)
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n):
        fx = h.mins[0] + (h.maxs[0] - h.mins[0]) * rng.uniform(0.1, 0.9)
        fy = h.mins[1] + (h.maxs[1] - h.mins[1]) * rng.uniform(0.1, 0.9)
        (mx,), (my,) = transform(crs, "EPSG:3857", [fx], [fy])
        lat = math.degrees(2 * math.atan(math.exp(my / 6378137.0)) - math.pi / 2)
        half = HALVES[i % len(HALVES)]
        k = half / math.cos(math.radians(lat))
        out.append((half, (mx - k, my - k, mx + k, my + k)))
    return out


@app.function(image=image, volumes={"/tiles": tiles}, timeout=3000, cpu=2.0, memory=8192)
def simulate_one(name, per_tile=8):
    import time
    p, s, crs_of = _tools()
    path = f"/tiles/{name}"
    rows = []
    for i, (half, box) in enumerate(_boxes(path, per_tile, seed=__import__('zlib').crc32(name.encode()) % 10000)):
        t0 = time.time()
        whole = s.tile_records(path, box)
        t_whole = time.time() - t0
        src = p.FileSource(path)
        try:
            part = p.read_box(src, box, crs_of)
        except p.Unsupported as e:
            rows.append({"tile": name, "half": half, "unsupported": str(e)[:120], "points": int(len(whole["x"]))})
            continue
        except Exception as e:  # noqa: BLE001 - a failure of the reader is a failure of the check
            rows.append({"tile": name, "half": half, "error": f"{type(e).__name__}: {str(e)[:160]}"})
            continue
        same, words = p.same_records(part, whole)
        st = part["stats"]
        rows.append({"tile": name, "half": half, "same": same, "words": words, "points": int(len(whole["x"])),
                     "share": st["share"], "requests": st["requests"], "chunks": st["chunks"],
                     "chunksRead": st["chunksRead"], "mb": round(st["fileBytes"] / 1e6), "wholeS": round(t_whole, 1)})
    return rows


@app.function(image=image, volumes={"/tiles": tiles}, timeout=600)
def tile_names():
    import os as _os
    return sorted(n for n in _os.listdir("/tiles") if n.endswith(".laz") and _os.path.isfile(f"/tiles/{n}"))


@app.function(image=image, volumes={"/tiles": tiles}, timeout=3500, cpu=2.0, memory=8192)
def live_one(url, lng, lat, half=150, keep_whole=True):
    import math
    import time
    import urllib.request
    from pathlib import Path
    p, s, crs_of = _tools()
    name = url.rsplit("/", 1)[-1]
    out = {"tile": name, "half": half}
    # 1. Does rockyweb answer a multi-range request? Three small ranges.
    src = p.HttpSource(url, patient_until=time.time() + 1200)
    try:
        t0 = time.time()
        got = src.get_many([(0, 3), (100, 103), (1000, 1003)])
        out["multiRange"] = got[0] == b"LASF" and all(len(g) == 4 for g in got)
        out["multiRangeS"] = round(time.time() - t0, 1)
    except p.Unsupported as e:
        out["multiRange"] = False
        out["multiRangeWhy"] = str(e)[:160]
        return out
    # 2. The part over the box round the lot.
    x = lng * math.pi / 180 * 6378137.0
    y = math.log(math.tan(math.pi / 4 + lat * math.pi / 360)) * 6378137.0
    k = half / math.cos(math.radians(lat))
    box = (x - k, y - k, x + k, y + k)
    src = p.HttpSource(url, patient_until=time.time() + 1800)
    t0 = time.time()
    try:
        part = p.read_box(src, box, crs_of)
    except p.Unsupported as e:
        out["unsupported"] = str(e)[:160]
        return out
    out.update({"partS": round(time.time() - t0, 1), "partMb": round(part["stats"]["bytesRead"] / 1e6, 1),
                "fileMb": round(part["stats"]["fileBytes"] / 1e6, 1), "share": part["stats"]["share"],
                "requests": src.requests, "points": int(len(part["x"]))})
    if not keep_whole:
        return out
    # 3. The whole tile (onto the volume, as fetch_tiles does), and the two reads compared.
    path = Path("/tiles") / name
    t0 = time.time()
    if not path.exists():
        s.fetch_ranged(url, path)
        tiles.commit()
    out["wholeS"] = round(time.time() - t0, 1)
    same, words = p.same_records(part, s.tile_records(path, box))
    out["same"], out["words"] = same, words
    return out


LIVE = [
    # Tiles USGS refused the model server on 2026-10-29 (run 271), so not on the volume; each round a corpus lot.
    ("https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/MD_Central_Processing_D24/MD_Central_Processing_3_D24/LAZ/USGS_LPC_MD_Central_Processing_D24_228NW11.laz", -77.23724, 39.19168),
    ("https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/GA_Central_2019_B19/GA_Central_1_2019/LAZ/USGS_LPC_GA_Central_2019_B19_e1100n1294.laz", -83.95454, 34.08553),
]


@app.local_entrypoint()
def main(what: str = "both", per_tile: int = 8, max_tiles: int = 60):
    import json
    import statistics
    failures = 0
    report = {}
    if what in ("simulate", "both"):
        names = tile_names.remote()[:max_tiles]
        print(f"SIMULATE: {len(names)} tiles on the volume, {per_tile} boxes each")
        rows = [r for rs in simulate_one.map(names, kwargs={"per_tile": per_tile}, return_exceptions=True)
                for r in (rs if isinstance(rs, list) else [{"error": f"{type(rs).__name__}: {str(rs)[:160]}"}])]
        compared = [r for r in rows if "same" in r]
        wrong = [r for r in compared if not r["same"]]
        errors = [r for r in rows if "error" in r]
        unsup = [r for r in rows if "unsupported" in r]
        for r in wrong + errors:
            print("  FAIL", json.dumps(r))
        failures += len(wrong) + len(errors)
        print(f"  compared {len(compared)} boxes: {len(compared) - len(wrong)} identical, {len(wrong)} different; "
              f"{len(errors)} errors; {len(unsup)} left to the whole download")
        reasons = {}
        for r in unsup:
            reasons[r["unsupported"][:60]] = reasons.get(r["unsupported"][:60], 0) + 1
        for why, c in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"    whole download x{c}: {why}")
        for half in HALVES:
            sh = [r["share"] for r in compared if r["half"] == half]
            if sh:
                print(f"  box +-{half} m: median {statistics.median(sh):.0%} of the file read "
                      f"(range {min(sh):.0%}-{max(sh):.0%}, {len(sh)} boxes)")
        rq = [r["requests"] for r in compared]
        if rq:
            print(f"  requests per read: median {statistics.median(rq)}, most {max(rq)}")
        report["simulate"] = {"compared": len(compared), "different": len(wrong), "errors": len(errors), "unsupported": len(unsup)}
    if what in ("live", "both"):
        print("LIVE: rockyweb from Modal's network")
        for url, lng, lat in LIVE:
            try:
                r = live_one.remote(url, lng, lat)
            except Exception as e:  # noqa: BLE001
                r = {"tile": url.rsplit("/", 1)[-1], "error": f"{type(e).__name__}: {str(e)[:200]}"}
            print("  " + json.dumps(r))
            if r.get("same") is False or "error" in r:
                failures += 1
        report["live"] = True
    print(f"CHECK {'PASSED' if failures == 0 else f'FAILED ({failures})'}")
    if failures:
        raise SystemExit(1)
