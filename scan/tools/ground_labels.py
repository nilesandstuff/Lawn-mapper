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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SEG_MODEL = "nvidia/segformer-b0-finetuned-ade-512-512"
# our kinds: 0 none, 1 turf, 2 low plants (beds, ground cover), 3 porous (earth, sand, dirt), 4 paved, 5 rock, 6 tree, 7 other,
# and since 2026-11-27 (the owner: "add structures to the colors... Solid structures, and structures like decks, that water
# can pass through"): 8 built solid (walls, a house, pillars, doors), 9 a floor off the ground (a deck's or a porch's
# boards, steps, railings), 10 a roof seen from under it (a porch's ceiling, an awning): surfaces.py reads them at any height
KIND_OF = {"grass": 1, "field": 1, "plant": 2, "flower": 2, "earth": 3, "sand": 3, "dirt track": 3, "land": 3,
           "road": 4, "sidewalk": 4, "path": 4, "runway": 4, "rock": 5, "stone": 5, "tree": 6, "palm": 6,
           "wall": 8, "building": 8, "house": 8, "column": 8, "door": 8, "windowpane": 8, "skyscraper": 8, "hovel": 8,
           "tower": 8, "double door": 8, "screen door": 8,
           "floor": 9, "stairs": 9, "step": 9, "stairway": 9, "pier": 9, "stage": 9, "railing": 9, "bannister": 9,
           "ceiling": 10, "awning": 10}
KIND_NAMES = ["none", "turf", "low plants", "porous", "paved", "rock", "tree", "other", "built", "floor", "roof from under"]
NK = len(KIND_NAMES)


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
        done, tally = 0, np.zeros(NK, np.int64)
        names_seen = {}
        # THE LARGE LABELLER FIRST (2026-11-26): where the walk has the panoptic model's classes (segments-masks.npz:
        # Mask2Former, ADE20K, measured on the owner's own names at 97% / 89%; classes_cpu.py on the free runner),
        # its class at each cell; SegFormer-B0 only for the pictures it did not label
        big = {}
        mf = os.path.join(d, "segments-masks.npz")
        if os.path.exists(mf):
            try:
                import segment_study as SS
                z = np.load(mf, allow_pickle=False)
                _, _, tkeys = SS.read_twin(d)
                for pi, m, nm in zip(z["pics"], z["pan"], json.loads(str(z["names"]))):
                    if int(pi) < len(tkeys):
                        lt = np.full(int(m.max()) + 1, 7, np.uint8)
                        for i, name in nm.items():
                            if int(i) < len(lt):
                                lt[int(i)] = KIND_OF.get(str(name).lower().split(",")[0].strip(), 7)
                        lt[0] = 0
                        big[tkeys[int(pi)]["name"]] = lt[m]
                        for nm_ in set(str(x).lower().split(",")[0].strip() for x in nm.values()):
                            names_seen[nm_] = names_seen.get(nm_, 0) + 1
            except Exception as e:
                print(f"  The large labeller's classes could not be read ({e}); the small one alone.")
        n_big = 0
        for k in keys:
            fj, fr = os.path.join(d, k["name"]), os.path.join(d, k["name"].replace(".jpg", ".rdepth"))
            if not (os.path.exists(fj) and os.path.exists(fr)):
                continue
            r = np.fromfile(fr, dtype="<u2", count=2)
            nx, ny = int(r[0]), int(r[1])
            jj, ii = np.mgrid[0:ny, 0:nx]
            if k["name"] in big:
                km = big[k["name"]]; h, w = km.shape
                cls = km[np.clip(((jj + 0.5) / ny * h).astype(int), 0, h - 1), np.clip(((ii + 0.5) / nx * w).astype(int), 0, w - 1)]
                n_big += 1
            else:
                img = Image.open(fj).convert("RGB")
                with torch.no_grad():
                    lab = model(**proc(images=img, return_tensors="pt")).logits.argmax(1)[0].numpy()
                h, w = lab.shape
                cls = lut[lab[np.clip(((jj + 0.5) / ny * h).astype(int), 0, h - 1), np.clip(((ii + 0.5) / nx * w).astype(int), 0, w - 1)]]
            out = np.concatenate([np.array([nx & 255, nx >> 8, ny & 255, ny >> 8], np.uint8), cls.ravel().astype(np.uint8)])
            out.tofile(fj.replace(".jpg", ".ade"))
            tally += np.bincount(cls.ravel(), minlength=NK)[:NK]
            done += 1
        tot = max(1, int(tally.sum()))
        print(f"  The second labeller on {os.path.basename(os.path.normpath(d))}: {done} pictures ({n_big} by the large panoptic model, {done - n_big} by SegFormer-B0); their cells "
              + ", ".join(f"{KIND_NAMES[i]} {100 * tally[i] / tot:.0f}%" for i in range(1, NK)) + ".")
        if names_seen:
            # which of the large labeller's classes the pictures hold, most first (names and counts only): what a
            # structure is called by it on this lot
            top = sorted(names_seen.items(), key=lambda x: -x[1])[:25]
            print("    its classes, by pictures that hold them: " + ", ".join(f"{k} {v}" for k, v in top) + ".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
