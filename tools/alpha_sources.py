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
import json
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


def _lidar_cache_file(cache_dir, prep, local):
    """Where this frame's lidar layers live on the volume, or None."""
    if not cache_dir:
        return None
    import hashlib
    key = json.dumps({"bbox": [round(float(v), 2) for v in prep["bbox"]], "url": prep.get("lidarUrl"),
                      "epoch": prep.get("lidarEpoch"), "tiles": sorted(local or [])}, sort_keys=True)
    return Path(cache_dir) / f"{hashlib.sha1(key.encode()).hexdigest()}.npz"


def _lidar_cached(path, max_age_s=7 * 86400):
    """The (layers, masks) saved for this frame, or None."""
    try:
        if not path or not path.exists() or time.time() - path.stat().st_mtime > max_age_s:
            return None
        with np.load(path, allow_pickle=False) as z:
            layers = {k[2:]: z[k] for k in z.files if k.startswith("l_")}
            masks = {k[2:]: z[k].astype(bool) for k in z.files if k.startswith("m_")}
        return (layers, masks) if layers else None
    except Exception:  # noqa: BLE001 - a bad file is a miss
        return None


def _lidar_save(path, got):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        layers, masks = got
        np.savez_compressed(path, **{f"l_{k}": np.asarray(v) for k, v in layers.items()},
                            **{f"m_{k}": np.asarray(v, dtype=np.uint8) for k, v in masks.items()})
    except Exception:  # noqa: BLE001 - the next press reads USGS again, as before
        pass


def gather_sources(photo, prep, naip_align=None, progress=None, cache_dir=None):
    """Lidar and NAIP for one lot. Returns plain arrays and a record:

        lidar       {height, n_ground, n_all, intensity} on lidar_frame's 2 m grid, or None
        height_png  the height picture stage 3 reads, or None
        roof, void  boolean masks for the lidar veto, or None
        naip        NAIP's RGB-as-NIR array, lined up with the photograph, or None
        rec         {lidar: bool, naip: bool, lidarSource?, tilesPending?, lidarError?, naipError?}
        seconds     {lidar, naip}

    `progress(stage)` is told each step as it starts (the model server shows
    it to the app). `cache_dir` keeps each frame's lidar layers for a week,
    so a press sent again for the same lot (the app restarting one, or a
    person pressing twice) reads nothing from USGS: on a 10-acre lot the
    lidar alone was three minutes (owner, 2026-10-21).
    """
    import lidar_frame
    import naip_bands

    say = progress or (lambda stage, **more: None)

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
        cache_file = _lidar_cache_file(cache_dir, prep, local)
        try:
            got = _lidar_cached(cache_file)
            if got:
                out["rec"]["lidarSource"] = "cache"
                say("Reading the lidar kept from the last press")
            else:
                span = max(prep["bbox"][2] - prep["bbox"][0], prep["bbox"][3] - prep["bbox"][1])
                say(f"Separating USGS lidar point clouds over {span:.0f} m of ground"
                    + (" (a big lot: this is the slow part)" if span > 200 else ""))
            if got is None and local:
                try:
                    got = lidar_frame.lidar_for(None, prep["bbox"], epoch=prep.get("lidarTilesEpoch"), tiles=local)
                    out["rec"]["lidarSource"] = "tiles"
                except Exception as e:  # noqa: BLE001 - the octree is still there
                    out["rec"]["tilesError"] = str(e)[:200]
            if got is None and prep.get("lidarUrl"):
                got = lidar_frame.lidar_for(prep["lidarUrl"], prep["bbox"], epoch=prep.get("lidarEpoch"))
                out["rec"]["lidarSource"] = "octree"
            if got:
                if out["rec"].get("lidarSource") != "cache" and cache_file:
                    _lidar_save(cache_file, got)
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
    span = max(prep["bbox"][2] - prep["bbox"][0], prep["bbox"][3] - prep["bbox"][1])
    # The slow step on a big lot (workflow 32, 2026-10-22: 103 s of a 275 m
    # lot's 116 s of downloads was this; the lidar was 10 s).
    say("Aligning the near-infrared imagery" + (f" over {span:.0f} m of ground (a big lot: this takes a minute or two)" if span > 200 else ""))
    try:
        naip, _ = naip_bands.naip_for(prep["bbox"], photo=photo, stored=naip_align)
        out["naip"] = np.asarray(naip)
    except Exception as e:  # noqa: BLE001 - served without it, as trained
        out["rec"]["naipError"] = str(e)[:200]
    out["seconds"]["naip"] = round(time.time() - t0, 1)
    return out


def gather(payload, prepare, progress=None, cache_dir=None):
    """Everything a lot needs before the GPU: where it is (`prepare`, the
    scorer's own grid via serve-alpha.mjs), the photograph, and its sources."""
    t0 = time.time()
    say = progress or (lambda stage, **more: None)
    say("Working out the lot's grid")
    prep = prepare({"frame": payload["frame"]})
    say("Fetching the aerial photograph of your lot")
    photo_bytes = fetch_photo(payload["imageUrl"])
    photo = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
    sources = gather_sources(photo, prep, payload.get("naipAlign"), progress=progress, cache_dir=cache_dir)
    sources["seconds"]["gather"] = round(time.time() - t0, 1)
    return {"prep": prep, "photo": photo_bytes, "sources": sources}
