"""
One map through the live model's own path, on this machine (workflow 14
`also_draw`, 2026-10-22).

What tools/modal_serve.py does for a press, without Modal: the lot's grid from
serve-alpha.mjs `prepare`, the photograph from the site, the lidar and NAIP
as alpha_sources gathers them, the decoder in RELEASE_DIR (trained on every
lot this run, never shipped) over the backbone, and the pieces the Node half
finishes and draws (tools/draw-map.mjs). Nothing here reads the map's own
shapes: the owner's Byron Center map carries a placeholder triangle, and the
point of the drawing is what the detector says, not how it compares.

    OUT=drawn RELEASE_DIR=release-local python3 tools/draw_map.py

reads OUT/payload.json ({imageUrl, frame, parcel, naipAlign}) and writes into
OUT: photo-full.png, prob.png, canopy.png, roof.png, void.png, height.png,
photo.png (on the grid), prep.json and rec.json.
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _node(cmd, payload):
    """serve-alpha.mjs, as the model server calls it."""
    r = subprocess.run(["node", os.path.join(HERE, "serve-alpha.mjs"), cmd], input=json.dumps(payload),
                       capture_output=True, text=True, cwd=ROOT, timeout=600, env=dict(os.environ))
    if r.returncode:
        raise RuntimeError(f"serve-alpha {cmd}: {r.stderr[-600:]}")
    return json.loads(r.stdout)


def main():
    import io

    import numpy as np
    from PIL import Image

    import alpha_infer
    import alpha_sources

    out = os.environ.get("OUT", "drawn")
    release = os.path.join(os.environ.get("RELEASE_DIR", "release-local"), "model.pt")
    if not os.path.exists(release):
        raise SystemExit(f"no decoder at {release}: the step before this one did not save one")
    with open(os.path.join(out, "payload.json")) as f:
        payload = json.load(f)

    t0 = time.time()
    say = lambda stage, **more: print(f"  {stage}", flush=True)  # noqa: E731
    got = alpha_sources.gather(payload, _node, progress=say)
    prep = got["prep"]
    photo = Image.open(io.BytesIO(got["photo"])).convert("RGB")
    photo.save(os.path.join(out, "photo-full.png"))
    print(f"photo {photo.size[0]}x{photo.size[1]} px over {prep['span']:.0f} m; grid {prep['w']}x{prep['h']} "
          f"at {prep['mpp'] * 100:.1f} cm; lidar {'read' if got['sources'].get('lidar') is not None else 'none'}, "
          f"NAIP {'read' if got['sources'].get('naip') is not None else 'none'}; {time.time() - t0:.0f}s", flush=True)

    t0 = time.time()
    det = alpha_infer.Detector(release_path=release)
    meta = det.release.meta
    print(f"decoder: trained {meta.get('trainedAt')} on {meta.get('lawns')} lots, windowed {meta.get('windowed')}, "
          f"both scales {bool(meta.get('bothScales'))}; models loaded in {time.time() - t0:.0f}s", flush=True)

    t0 = time.time()
    rec = det.run(photo, prep, out, naip_align=payload.get("naipAlign"), sources=got["sources"])
    photo.resize((prep["w"], prep["h"]), Image.BOX).save(os.path.join(out, "photo.png"))
    with open(os.path.join(out, "prep.json"), "w") as f:
        json.dump(prep, f)
    with open(os.path.join(out, "rec.json"), "w") as f:
        json.dump(rec, f)
    prob = np.asarray(Image.open(os.path.join(out, "prob.png")))
    print(f"read in {rec.get('windows', 1)} window(s): backbone {rec['seconds'].get('backbone')}s, canopy "
          f"{rec['seconds'].get('canopy')}s, decoder {rec['seconds'].get('decoder')}s; "
          f"{(prob >= 128).mean() * 100:.1f}% of the grid called lawn before the property line and stage 3; "
          f"{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
