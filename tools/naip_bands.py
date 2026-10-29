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


def fetch(url, tries=3, timeout=60):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
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


def naip_for(box, photo=None, stored=None, keep_raw=False, raw_file=None, timeout=60, tries=3):
    """NAIP (bands 3,0,1 -> near-infrared, red, green) over one frame, lined up
    with its photograph.

    `box` is the frame in EPSG:3857; `photo` the frame's photograph (a PIL
    image) for the automatic alignment; `stored` an editor-set {east, north,
    scale}, which wins. Returns (uint8 h x w x 3 array, record). Raises when
    NAIP cannot be read. Shared by main() and the live server
    (tools/alpha_infer.py), so a lot served is read exactly as a lot trained.
    `raw_file`, a .png path: USGS's answer for this box, kept beside a .json
    naming the box (training's bank, NAIP_RAW in main): read from there when
    the box is the same, fetched and kept when not -- so a map trains on the
    NAIP it was first read with, whatever USGS publishes later.
    `timeout` and `tries` bound the download: training waits for it, a live
    press does not (tools/alpha_sources.py NAIP_TIMEOUT_S).
    """
    from PIL import Image
    from naip_align import align_images, resample

    w = max(8, min(MAX_PX, round((box[2] - box[0]) / CELL_M)))
    h = max(8, min(MAX_PX, round((box[3] - box[1]) / CELL_M)))
    cell = (box[2] - box[0]) / w            # Mercator metres a pixel
    pad = int(math.ceil(MARGIN_M / cell))
    big = [box[0] - pad * cell, box[1] - pad * cell, box[2] + pad * cell, box[3] + pad * cell]
    blob = None
    meta = Path(raw_file).with_suffix(".json") if raw_file else None
    want = [round(float(v), 2) for v in big]
    if raw_file and Path(raw_file).exists() and meta.exists():
        try:
            if json.loads(meta.read_text()).get("box") == want:
                blob = Path(raw_file).read_bytes()
        except (OSError, ValueError):
            blob = None
    if blob is None:
        blob = fetch(export_url(big), tries=tries, timeout=timeout)
        if raw_file:
            Path(raw_file).parent.mkdir(parents=True, exist_ok=True)
            Path(raw_file).write_bytes(blob)
            meta.write_text(json.dumps({"box": want, "fetched": time.strftime("%Y-%m-%d", time.gmtime())}))
    img = Image.open(io.BytesIO(blob)).convert("RGB")
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
    raw = np.clip(np.round(arr[pad:pad + h, pad:pad + w]), 0, 255).astype(np.uint8) if keep_raw else None
    east, north = dx * ground, -dy * ground
    rec = {"east": round(east, 2), "north": round(north, 2), "scale": sc, "how": how}
    if keep_raw:
        rec["_raw"] = raw
    return out, rec


# THE ALIGNMENT, VISIBLE (owner, 2026-10-28: "that alignment is very hidden
# from my eyes"). One picture a frame, two panels: the photograph with NDVI
# tinted over it as NAIP came (left) and as it was lined up (right), the move
# written on it. Green where NDVI says vegetation, magenta where it says
# bare: a roof or a road under green, or grass under magenta, is a NAIP that
# is off. Published by workflow 14 to a pictures branch.
PICTURE_W = 640


def picture(photo, raw, moved, rec, lawn_id):
    from PIL import Image, ImageDraw
    from fuse_layers import ndvi_from_png

    w = PICTURE_W
    h = max(8, round(photo.height * w / photo.width))
    base = np.asarray(photo.convert("RGB").resize((w, h), Image.BOX), dtype=np.float32)

    def tinted(naip):
        ndvi, valid = ndvi_from_png(naip)
        n = np.asarray(Image.fromarray(((ndvi + 1) * 127.5).astype(np.uint8)).resize((w, h), Image.BILINEAR), dtype=np.float32) / 127.5 - 1
        v = np.asarray(Image.fromarray(valid.astype(np.uint8) * 255).resize((w, h), Image.NEAREST)) >= 128
        img = base.copy()
        green = (n > 0.35) & v
        bare = (n < 0.12) & v
        img[green] = img[green] * 0.55 + np.array([40, 220, 60]) * 0.45
        img[bare] = img[bare] * 0.7 + np.array([220, 40, 200]) * 0.3
        return img

    left = tinted(raw)
    right = tinted(moved)
    gap = 6
    sheet = np.full((h + 22, 2 * w + gap, 3), 20, np.float32)
    sheet[22:, :w] = left
    sheet[22:, w + gap:] = right
    im = Image.fromarray(np.clip(sheet, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    d.text((4, 4), f"{lawn_id[:34]}  NAIP as fetched", fill=(255, 255, 255))
    d.text((w + gap + 4, 4), f"lined up: {rec['east']:+.1f} m E, {rec['north']:+.1f} m N, scale {rec['scale']:.3f}  ({rec['how']})", fill=(255, 255, 255))
    return im


def main():
    from PIL import Image
    from naip_align import align_images, resample

    frames = Path(os.environ.get("FRAMES", "frames"))
    out = Path(os.environ.get("OUT", "naip"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "pictures").mkdir(exist_ok=True)
    scale = json.loads((frames / "scale.json").read_text())
    boxes = scale.get("boxes") or {}
    stored = scale.get("naipAlign") or {}
    # THE BANK (owner, 2026-10-29: "cache bank everything for the training
    # maps, we don't need to be redownloading layers"): USGS's NAIP answer for
    # each frame, kept in NAIP_RAW and in R2 by workflow 14 (tools/bank.js).
    raw_dir = os.environ.get("NAIP_RAW", "")
    banked = 0
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
            raw_file = Path(raw_dir) / f"{lawn_id}.png" if raw_dir else None
            had = bool(raw_file and raw_file.exists())
            moved, rec = naip_for(boxes[lawn_id], photo=photo, stored=stored.get(lawn_id), keep_raw=photo is not None,
                                  raw_file=raw_file)
            banked += had and raw_file.stat().st_mtime < t0
        except Exception as e:  # noqa: BLE001 - one frame failing is reported, not fatal
            print(f"  {lawn_id[:40]:40} no NAIP: {str(e)[:80]}")
            continue
        Image.fromarray(moved).save(out / f"{lawn_id}-naip.png")
        raw = rec.pop("_raw", None)
        if photo is not None and raw is not None:
            try:
                picture(photo, raw, moved, rec, lawn_id).save(out / "pictures" / f"{lawn_id}.png")
            except Exception as e:  # noqa: BLE001 - a picture is for looking at, never the run
                print(f"  {lawn_id[:40]:40} no picture: {str(e)[:80]}")
        record[lawn_id] = rec
        print(f"  {lawn_id[:40]:40} NAIP moved {rec['east']:+5.1f} m east, {rec['north']:+5.1f} m north, "
              f"scale {rec['scale']:.3f} -- {rec['how']}")
        got += 1
    (out / "naip-align.json").write_text(json.dumps(record, indent=1))
    shifts = [math.hypot(v["east"], v["north"]) for v in record.values()]
    if shifts:
        print(f"NAIP lined up with the photograph on {got} of {len(boxes)} frames in {time.time() - t0:.0f} s; "
              f"median move {sorted(shifts)[len(shifts) // 2]:.1f} m, largest {max(shifts):.1f} m.")
    if raw_dir:
        print(f"NAIP read from the bank for {banked} of {got} frames; the rest fetched from USGS and kept.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
