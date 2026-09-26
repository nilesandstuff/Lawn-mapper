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
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

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


def main():
    from PIL import Image
    frames = Path(os.environ.get("FRAMES", "frames"))
    out = Path(os.environ.get("OUT", "naip"))
    out.mkdir(parents=True, exist_ok=True)
    boxes = json.loads((frames / "scale.json").read_text()).get("boxes") or {}
    if not boxes:
        print("scale.json carries no frame boxes.")
        return 1
    got = 0
    t0 = time.time()
    for lawn_id in sorted(boxes):
        try:
            img = Image.open(io.BytesIO(fetch(export_url(boxes[lawn_id])))).convert("RGB")
        except Exception as e:  # noqa: BLE001 - one frame failing is reported, not fatal
            print(f"  {lawn_id[:40]:40} no NAIP: {str(e)[:80]}")
            continue
        img.save(out / f"{lawn_id}-naip.png")
        got += 1
    print(f"NAIP near-infrared over {got} of {len(boxes)} frames in {time.time() - t0:.0f} s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
