"""
The trained model's downloads, apart from its GPU work (owner, 2026-09-30).

The 3DEP lidar and NAIP's near-infrared are network reads plus light
arithmetic. On the GPU machine they were billed at GPU rates while the GPU
sat idle -- lidar alone was 6.5 of a lot's 12 seconds. So tools/modal_serve.py
runs `gather` on a small CPU machine, started at the same moment as the GPU
one, and on a cold start the downloads finish while the GPU is still waking.

No torch, no transformers: this module has to import on the CPU image.
Everything here is what alpha_infer.Detector.run did before, moved, not
changed -- the same readers (lidar_frame.lidar_for, naip_bands.naip_for) with
the same failure rule: a source that cannot be read is left out, as training
left it out.
"""

import io
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image


def fetch_photo(url):
    req = urllib.request.Request(url, headers={"User-Agent": "lawn-mapper-alpha"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def gather_sources(photo, prep, naip_align=None):
    """Lidar and NAIP for one lot. Returns plain arrays and a record:

        lidar       {height, n_ground, n_all, intensity} on lidar_frame's 2 m grid, or None
        height_png  the height picture stage 3 reads, or None
        roof, void  boolean masks for the lidar veto, or None
        naip        NAIP's RGB-as-NIR array, lined up with the photograph, or None
        rec         {lidar: bool, naip: bool, lidarSource?, tilesPending?, lidarError?, naipError?}
        seconds     {lidar, naip}
    """
    import lidar_frame
    import naip_bands

    out = {"lidar": None, "height_png": None, "roof": None, "void": None, "naip": None,
           "rec": {"lidar": False, "naip": False}, "seconds": {}}

    # THE NEWEST FLIGHT (H96): when it is only USGS's LAZ tiles, they are read
    # from the server's volume (LIDAR_TILE_DIR) once they are there; until
    # then the newest octree is, and the tiles are named for the server to
    # fetch in the background (tools/modal_serve.py, fetch_tiles).
    tiles = prep.get("lidarTiles") or []
    tile_dir = os.environ.get("LIDAR_TILE_DIR")
    local = None
    if tiles and tile_dir:
        paths = [Path(tile_dir) / u.rsplit("/", 1)[-1] for u in tiles]
        if all(p.exists() for p in paths):
            local = [str(p) for p in paths]
        else:
            out["rec"]["tilesPending"] = [u for u, p in zip(tiles, paths) if not p.exists()]

    if prep.get("lidarUrl") or local:
        t0 = time.time()
        try:
            got = None
            if local:
                try:
                    got = lidar_frame.lidar_for(None, prep["bbox"], epoch=prep.get("lidarTilesEpoch"), tiles=local)
                    out["rec"]["lidarSource"] = "tiles"
                except Exception as e:  # noqa: BLE001 - the octree is still there
                    out["rec"]["tilesError"] = str(e)[:200]
            if got is None and prep.get("lidarUrl"):
                got = lidar_frame.lidar_for(prep["lidarUrl"], prep["bbox"], epoch=prep.get("lidarEpoch"))
                out["rec"]["lidarSource"] = "octree"
            if got:
                layers, masks = got
                out["lidar"] = {k: layers[k] for k in ("height", "n_ground", "n_all", "intensity")}
                out["height_png"] = lidar_frame.height_png(layers["height"])
                out["roof"] = np.asarray(masks["roof"], dtype=bool)
                out["void"] = np.asarray(masks["void"], dtype=bool)
                out["rec"]["lidar"] = True
        except Exception as e:  # noqa: BLE001 - served without it, as trained
            out["rec"]["lidarError"] = str(e)[:200]
        out["seconds"]["lidar"] = round(time.time() - t0, 1)

    t0 = time.time()
    try:
        naip, _ = naip_bands.naip_for(prep["bbox"], photo=photo, stored=naip_align)
        out["naip"] = np.asarray(naip)
    except Exception as e:  # noqa: BLE001 - served without it, as trained
        out["rec"]["naipError"] = str(e)[:200]
    out["seconds"]["naip"] = round(time.time() - t0, 1)
    return out


def gather(payload, prepare):
    """Everything a lot needs before the GPU: where it is (`prepare`, the
    scorer's own grid via serve-alpha.mjs), the photograph, and its sources."""
    t0 = time.time()
    prep = prepare({"frame": payload["frame"]})
    photo_bytes = fetch_photo(payload["imageUrl"])
    photo = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
    sources = gather_sources(photo, prep, payload.get("naipAlign"))
    sources["seconds"]["gather"] = round(time.time() - t0, 1)
    return {"prep": prep, "photo": photo_bytes, "sources": sources}
