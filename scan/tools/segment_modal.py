"""
A WALK'S PICTURES THROUGH SEGMENT ANYTHING, ON MODAL'S GPU (core session, 2026-11-18; scan/tools/segment_study.py says
why). PAID: the owner says yes first, every time, with the number of runs and a rough cost (asked and answered
2026-11-18: three runs, about $1-2).

    modal run scan/tools/segment_modal.py --src twin --out out

Sends the walk's pictures (nothing else: no pose, no point, no place) and brings back, for each picture, three maps of
shape ids at the picture's own size:

  obj    Segment Anything's shapes, the LARGEST at each pixel (a shed, not its door); shapes over half the picture
         are left out, so the ground does not swallow what stands on it
  part   the same shapes, the SMALLEST at each pixel
  pan    the panoptic model's shapes (segment_study.py panoptic_maps), each with its name

out/masks.npz, which segment_study.py --masks lifts onto the walk's points on the runner. The log carries counts and
seconds only.
"""

import io
import json
import os
import sys
import time

import modal

GPU = os.environ.get("MODAL_GPU", "L4")
SAM_MODEL = "facebook/sam-vit-huge"
PAN_MODEL = "facebook/mask2former-swin-large-ade-panoptic"
HERE = os.path.dirname(os.path.abspath(__file__))


def fetch():
    from huggingface_hub import snapshot_download
    for m in (SAM_MODEL, PAN_MODEL):
        snapshot_download(m, allow_patterns=["*.json", "*.safetensors", "*.txt"])


app = modal.App("lawn-scan-segment")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.4.1", "torchvision==0.19.1", "transformers==4.46.3", "numpy<2", "pillow", "scipy", "huggingface_hub")
    .run_function(fetch)
    .add_local_file(os.path.join(HERE, "segment_study.py"), "/root/segment_study.py")
)


@app.function(image=image, gpu=GPU, timeout=45 * 60)
def segment(pictures: list) -> dict:
    import numpy as np
    import torch
    from PIL import Image
    from transformers import pipeline
    sys.path.insert(0, "/root")
    from segment_study import panoptic_maps

    t0 = time.time()
    imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in pictures]
    notes = []
    pan, names = panoptic_maps(imgs, "cuda", notes.append)
    t_pan = time.time() - t0

    gen = pipeline("mask-generation", model=SAM_MODEL, device=0)
    obj, part, counts = [], [], []
    for im in imgs:
        with torch.no_grad():
            masks = gen(im, points_per_batch=64, pred_iou_thresh=0.88, stability_score_thresh=0.92)["masks"]
        masks = [np.asarray(m, bool) for m in masks]
        area = np.array([m.sum() for m in masks]) if masks else np.zeros(0)
        o = np.zeros((im.height, im.width), np.uint16)
        p = np.zeros((im.height, im.width), np.uint16)
        for j in np.argsort(-area):          # largest first: the smallest is painted last
            p[masks[j]] = j + 1
        for j in np.argsort(area):           # smallest first: the largest is painted last
            if area[j] <= 0.5 * im.height * im.width:
                o[masks[j]] = j + 1
        obj.append(o)
        part.append(p)
        counts.append(len(masks))
    buf = io.BytesIO()
    same = len({m.shape for m in obj}) == 1
    if not same:
        return {"error": "the pictures are not all one size"}
    np.savez_compressed(buf, obj=np.stack(obj), part=np.stack(part), pan=np.stack(pan), names=json.dumps(names))
    return {"npz": buf.getvalue(), "numbers": {"pictures": len(imgs), "size": [imgs[0].width, imgs[0].height], "samShapesAPicture": round(float(np.mean(counts)), 1),
                                                 "panopticShapesAPicture": round(float(np.mean([len(n) for n in names])), 1), "panopticSeconds": round(t_pan),
                                                 "seconds": round(time.time() - t0), "gpu": GPU, "notes": notes}}


@app.local_entrypoint()
def main(src: str = "twin", out: str = "out"):
    import numpy as np
    sys.path.insert(0, HERE)
    from segment_study import read_twin
    _, _, keys = read_twin(src)
    if len(keys) < 8:
        print(f"Only {len(keys)} pictures: nothing to segment.")
        sys.exit(1)
    pictures = []
    for k in keys:
        with open(os.path.join(src, k["name"]), "rb") as f:
            pictures.append(f.read())
    print(f"Sending {len(pictures)} pictures ({sum(len(b) for b in pictures) / 1e6:.1f} MB) to the GPU ({GPU}).")
    r = segment.remote(pictures)
    os.makedirs(out, exist_ok=True)
    if r.get("error"):
        print(f"No shapes: {r['error']}")
        sys.exit(1)
    z = np.load(io.BytesIO(r["npz"]), allow_pickle=False)
    np.savez_compressed(os.path.join(out, "masks.npz"), obj=z["obj"], part=z["part"], pan=z["pan"], names=z["names"], pics=np.arange(len(keys)))
    print("SEGMENT " + json.dumps(r["numbers"]))
