"""
THE PICTURES AND THE LARGE LABELLER'S ANSWERS, MADE READY FOR distill_modal.py (core session, 2026-11-26). For each walk
directory with segments-masks.npz (classes_cpu.py or the GPU job): every picture it labelled, its JPEG as kept, and the
large model's kind at each cell of a TTW x TTH grid (255 where it named nothing). Also the off-the-shelf B0's 150 classes
mapped to the same kinds, for the yardstick.

    python scan/tools/distill_prep.py data.npz <walk dir> [<walk dir>...]
Counts only.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as SS  # noqa: E402

KINDS = ["other", "turf", "low plants", "porous", "paved", "tree", "built", "sky"]
NAME_KIND = {"grass": 1, "field": 1, "plant": 2, "flower": 2, "earth": 3, "sand": 3, "dirt track": 3, "land": 3,
             "road": 4, "sidewalk": 4, "path": 4, "runway": 4, "tree": 5, "palm": 5,
             "building": 6, "house": 6, "wall": 6, "fence": 6, "roof": 6, "railing": 6, "column": 6, "door": 6, "window": 6,
             "windowpane": 6, "stairs": 6, "step": 6, "skyscraper": 6, "tower": 6, "awning": 6, "sky": 7}
TTW, TTH = 80, 176


def kind_of(name):
    return NAME_KIND.get(str(name).lower().split(",")[0].strip(), 0)


def main():
    out, dirs = sys.argv[1], sys.argv[2:]
    blobs, targets, walk = [], [], []
    for wi, d in enumerate(dirs):
        mf = os.path.join(d, "segments-masks.npz")
        if not os.path.exists(mf):
            print(f"  {os.path.basename(os.path.normpath(d))}: no large labeller's classes; left out.")
            continue
        z = np.load(mf, allow_pickle=False)
        _, _, keys = SS.read_twin(d)
        n0 = len(blobs)
        for pi, m, nm in zip(z["pics"], z["pan"], json.loads(str(z["names"]))):
            if int(pi) >= len(keys):
                continue
            f = os.path.join(d, keys[int(pi)]["name"])
            if not os.path.exists(f):
                continue
            lt = np.full(int(m.max()) + 1, 0, np.uint8)
            for i, name in nm.items():
                if int(i) < len(lt):
                    lt[int(i)] = kind_of(name)
            lt[0] = 255
            h, w = m.shape
            jj, ii = np.mgrid[0:TTH, 0:TTW]
            t = lt[m[np.clip(((jj + 0.5) / TTH * h).astype(int), 0, h - 1), np.clip(((ii + 0.5) / TTW * w).astype(int), 0, w - 1)]]
            blobs.append(open(f, "rb").read()); targets.append(t); walk.append(wi)
        print(f"  {os.path.basename(os.path.normpath(d))}: {len(blobs) - n0} pictures with the large labeller's classes.")
    if not blobs:
        print("Nothing to teach from."); return 1
    cuts = np.cumsum([0] + [len(b) for b in blobs]).astype(np.int64)
    # B0's own classes -> our kinds, by its own names
    from transformers import AutoConfig
    cfg = AutoConfig.from_pretrained("nvidia/segformer-b0-finetuned-ade-512-512")
    base_map = {str(int(k)): kind_of(v) for k, v in cfg.id2label.items()}
    T = np.stack(targets)
    np.savez(out, jpeg=np.frombuffer(b"".join(blobs), np.uint8), cuts=cuts, target=T, walk=np.array(walk, np.int64), base_map=json.dumps(base_map))
    share = {KINDS[k]: f"{100 * (T == k).sum() / max(1, (T != 255).sum()):.0f}%" for k in range(len(KINDS))}
    print(f"Ready: {len(blobs)} pictures, {cuts[-1] / 1e6:.0f} MB of JPEG; the large labeller's kinds: {share}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
