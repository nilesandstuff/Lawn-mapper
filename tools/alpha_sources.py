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
import time
import urllib.request

import numpy as np
from PIL import Image


def fetch_photo(url):
    req = urllib.request.Request(url, headers={"User-Agent": "lawn-mapper-alpha"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def gather_sources(photo, prep, naip_align=None):
    """Lidar and NAIP for one lot. Returns plain arrays and a record:

        lidar       {height, n_ground, n_all} on lidar_frame's 2 m grid, or None
        height_png  the height picture stage 3 reads, or None
        roof, void  boolean masks for the lidar veto, or None
        naip        NAIP's RGB-as-NIR array, lined up with the photograph, or None
        rec         {lidar: bool, naip: bool, lidarError?, naipError?}
        seconds     {lidar, naip}
    """
    import lidar_frame
    import naip_bands

    out = {"lidar": None, "height_png": None, "roof": None, "void": None, "naip": None,
           "rec": {"lidar": False, "naip": False}, "seconds": {}}

    if prep.get("lidarUrl"):
        t0 = time.time()
        try:
            got = lidar_frame.lidar_for(prep["lidarUrl"], prep["bbox"])
            if got:
                layers, masks = got
                out["lidar"] = {k: layers[k] for k in ("height", "n_ground", "n_all")}
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
