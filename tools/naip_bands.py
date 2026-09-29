"""
NAIP's near-infrared over every dumped frame, as NDVI, for the fused-inputs
test (tools/fuse_layers.py).

One exportImage per frame from USGS's NAIPPlus ImageServer, bands 3,0,1
(near-infrared, red, green) with no rendering rule, about a metre a pixel --
NAIP is 0.6-1 m native, so asking for finer would only upsample. Written as
<OUT>/<id>-naip.png holding those three bands untouched; fuse_layers turns
them into NDVI, so what was fetched can be looked at.

    FRAMES=frames OUT=naip python3 tools/naip_bands.py

A frame the server answers with nothing is reported and skipped; the decoder
reads that lot as "no NAIP" (flag 0), which training has seen through dropout.
"""

import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer"
CELL_M = 1.0
MAX_PX = 1024


def export_url(bbox, cell=CELL_M):
    w = max(8, min(MAX_PX, round((bbox[2] - bbox[0]) / cell)))
    h = max(8, min(MAX_PX, round((bbox[3] - bbox[1]) / cell)))
    q = {
        "bbox": ",".join(str(v) for v in bbox), "bboxSR": "3857", "imageSR": "3857",
        "size": f"{w},{h}", "format": "png", "bandIds": "3,0,1",
        "renderingRule": json.dumps({"rasterFunction": "None"}), "f": "image",
    }
    return f"{ROOT}/exportImage?{urllib.parse.urlencode(q)}"


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return None


# LINED UP WITH THE PHOTOGRAPH FIRST (owner, 2026-09-27: NAIP is sometimes
# shifted or a little off in scale against Mapbox, and Mapbox is the one to
# trust). NAIP is fetched with MARGIN_M to spare on every side so a shift has
# real pixels to move into, then moved: by the alignment set in the editor
# when the map carries one, otherwise by tools/naip_align.py against the
# frame's own photograph. The shift used is printed per frame and written to
# <OUT>/naip-align.json.
MARGIN_M = 8.0
R_EARTH = 6378137.0


def lat_of(box):
    y = (box[1] + box[3]) / 2
    return math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)


def grey(arr, naip=False):
    a = np.asarray(arr, dtype=np.float32)
    if naip:
        # Bands here are NIR, red, green: red and green carry the edges.
        return 0.5 * a[..., 1] + 0.5 * a[..., 2]
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def naip_for(box, photo=None, stored=None):
    """NAIP (bands 3,0,1 -> near-infrared, red, green) over one frame, lined up
    with its photograph.

    `box` is the frame in EPSG:3857; `photo` the frame's photograph (a PIL
    image) for the automatic alignment; `stored` an editor-set {east, north,
    scale}, which wins. Returns (uint8 h x w x 3 array, record). Raises when
    NAIP cannot be read. Shared by main() and the live server
    (tools/alpha_infer.py), so a lot served is read exactly as a lot trained.
    """
    from PIL import Image
    from naip_align import align_images, resample

    w = max(8, min(MAX_PX, round((box[2] - box[0]) / CELL_M)))
    h = max(8, min(MAX_PX, round((box[3] - box[1]) / CELL_M)))
    cell = (box[2] - box[0]) / w            # Mercator metres a pixel
    pad = int(math.ceil(MARGIN_M / cell))
    big = [box[0] - pad * cell, box[1] - pad * cell, box[2] + pad * cell, box[3] + pad * cell]
    img = Image.open(io.BytesIO(fetch(export_url(big)))).convert("RGB")
    arr = np.asarray(img.resize((w + 2 * pad, h + 2 * pad), Image.BILINEAR), dtype=np.float32)
    ground = cell * math.cos(math.radians(lat_of(box)))   # ground metres a pixel

    how = "none"
    dx = dy = 0.0
    sc = 1.0
    a = stored
    if a and all(k in a for k in ("east", "north")):
        dx, dy, sc = a["east"] / ground, -a["north"] / ground, float(a.get("scale", 1.0))
        how = "editor"
    elif photo is not None:
        small = photo.convert("RGB").resize((w, h), Image.BOX)
        inner = arr[pad:pad + h, pad:pad + w]
        r = align_images(grey(small), grey(inner, naip=True),
                         max_shift=max(2, min(pad, int(round(6.0 / ground)))))
        if r["moved"]:
            dx, dy, sc, how = r["dx"], r["dy"], r["scale"], f"auto (edges {r['ncc0']:.2f} -> {r['ncc']:.2f})"
        else:
            how = f"auto, left alone (edges {r['ncc0']:.2f})"
    moved = resample(arr, dx, dy, sc, offset=(pad, pad), out_shape=(h, w))
    out = np.clip(np.round(moved), 0, 255).astype(np.uint8)
    east, north = dx * ground, -dy * ground
    return out, {"east": round(east, 2), "north": round(north, 2), "scale": sc, "how": how}


def main():
    from PIL import Image
    from naip_align import align_images, resample

    frames = Path(os.environ.get("FRAMES", "frames"))
    out = Path(os.environ.get("OUT", "naip"))
    out.mkdir(parents=True, exist_ok=True)
    scale = json.loads((frames / "scale.json").read_text())
    boxes = scale.get("boxes") or {}
    stored = scale.get("naipAlign") or {}
    if not boxes:
        print("scale.json carries no frame boxes.")
        return 1
    got = 0
    record = {}
    t0 = time.time()
    for lawn_id in sorted(boxes):
        photo_path = frames / f"{lawn_id}.png"
        photo = Image.open(photo_path).convert("RGB") if photo_path.exists() else None
        try:
            moved, rec = naip_for(boxes[lawn_id], photo=photo, stored=stored.get(lawn_id))
        except Exception as e:  # noqa: BLE001 - one frame failing is reported, not fatal
            print(f"  {lawn_id[:40]:40} no NAIP: {str(e)[:80]}")
            continue
        Image.fromarray(moved).save(out / f"{lawn_id}-naip.png")
        record[lawn_id] = rec
        print(f"  {lawn_id[:40]:40} NAIP moved {rec['east']:+5.1f} m east, {rec['north']:+5.1f} m north, "
              f"scale {rec['scale']:.3f} -- {rec['how']}")
        got += 1
    (out / "naip-align.json").write_text(json.dumps(record, indent=1))
    shifts = [math.hypot(v["east"], v["north"]) for v in record.values()]
    if shifts:
        print(f"NAIP lined up with the photograph on {got} of {len(boxes)} frames in {time.time() - t0:.0f} s; "
              f"median move {sorted(shifts)[len(shifts) // 2]:.1f} m, largest {max(shifts):.1f} m.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
