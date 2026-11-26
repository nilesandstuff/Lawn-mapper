"""
A SECOND LABELLER FOR THE PHONE'S "TERRAIN" (core session, 2026-11-26; a STUDY). The owner: "I wonder if there's any
substitute for the native arcore scene semantics that can run live on the user's phone and get more granular labels...
While still being lightweight? Possibly in conjunction with scene semantics, as in scene semantics gives broad labels
like terrain, and another labeler breaks up that terrain label into grass, paving, bare, etc?... maybe that 'substitute'
labeler could run on the user's phone after a walk?" -- and colour fails on dormant turf, leaves of every colour, and low
green ground cover that is not turf.

SegFormer-B0 (ADE20K, 3.7 M weights: small enough for a phone after a walk, the model studies here already use) on each
picture the walk kept; for every cell of the picture's 72 x 128 depth grid, the class at its middle, mapped to a few kinds
(KIND below), written beside the picture as key-NNNN.ade (Uint8 [nx lo, nx hi, ny lo, ny hi, kinds]) in the runner's
folder only. surfaces.py --ade reads them for the cells the phone called terrain.

    python scan/tools/ground_labels.py <twin dir> [more twin dirs...]
Counts only.
"""
import json
import os
import re
import sys

import numpy as np
from PIL import Image

SEG_MODEL = "nvidia/segformer-b0-finetuned-ade-512-512"
# our kinds: 0 none, 1 turf, 2 low plants (beds, ground cover), 3 porous (earth, sand, dirt), 4 paved, 5 rock, 6 tree, 7 other
KIND_OF = {"grass": 1, "field": 1, "plant": 2, "flower": 2, "earth": 3, "sand": 3, "dirt track": 3, "land": 3,
           "road": 4, "sidewalk": 4, "path": 4, "runway": 4, "rock": 5, "stone": 5, "tree": 6, "palm": 6}
KIND_NAMES = ["none", "turf", "low plants", "porous", "paved", "rock", "tree", "other"]


def main():
    dirs = [x for x in sys.argv[1:] if os.path.isdir(x)]
    import torch
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
    torch.set_num_threads(os.cpu_count() or 2)
    proc = SegformerImageProcessor.from_pretrained(SEG_MODEL)
    model = SegformerForSemanticSegmentation.from_pretrained(SEG_MODEL).eval()
    names = {int(k): v.lower().split(",")[0].strip() for k, v in model.config.id2label.items()}
    lut = np.full(max(names) + 1, 7, np.uint8)
    for k, v in names.items():
        lut[k] = KIND_OF.get(v, 7)
    for d in dirs:
        keys = []
        for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
            keys += json.load(open(os.path.join(d, n)))
        done, tally = 0, np.zeros(8, np.int64)
        for k in keys:
            fj, fr = os.path.join(d, k["name"]), os.path.join(d, k["name"].replace(".jpg", ".rdepth"))
            if not (os.path.exists(fj) and os.path.exists(fr)):
                continue
            r = np.fromfile(fr, dtype="<u2", count=2)
            nx, ny = int(r[0]), int(r[1])
            img = Image.open(fj).convert("RGB")
            with torch.no_grad():
                lab = model(**proc(images=img, return_tensors="pt")).logits.argmax(1)[0].numpy()
            h, w = lab.shape
            jj, ii = np.mgrid[0:ny, 0:nx]
            cls = lut[lab[np.clip(((jj + 0.5) / ny * h).astype(int), 0, h - 1), np.clip(((ii + 0.5) / nx * w).astype(int), 0, w - 1)]]
            out = np.concatenate([np.array([nx & 255, nx >> 8, ny & 255, ny >> 8], np.uint8), cls.ravel().astype(np.uint8)])
            out.tofile(fj.replace(".jpg", ".ade"))
            tally += np.bincount(cls.ravel(), minlength=8)
            done += 1
        tot = max(1, int(tally.sum()))
        print(f"  The second labeller (SegFormer-B0, ADE20K) on {os.path.basename(os.path.normpath(d))}: {done} pictures; their cells "
              + ", ".join(f"{KIND_NAMES[i]} {100 * tally[i] / tot:.0f}%" for i in range(1, 8)) + ".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
