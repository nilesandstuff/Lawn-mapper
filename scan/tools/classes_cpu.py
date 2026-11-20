"""
A WALK'S PICTURES GIVEN THEIR CLASSES ON THE FREE RUNNER, NO GPU (core session, 2026-11-20).

The vote (studies.voted, docs/SCAN-PLAN.md 36) needs only a class at every pixel of every photo. On Modal's GPU
that is 0.5 s a picture, but three of four such runs on 2026-11-20 sat in the GPU step until cancelled, for reasons
not found. The same model runs here on the CPU: slower, free, and it cannot hang on somebody else's queue.

    python scan/tools/classes_cpu.py twin [most pictures]

Writes twin/segments-masks.npz as the GPU job does (pan, names, pics; obj = pan, part empty: no Segment Anything).
Counts only.
"""

import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402


def main():
    from PIL import Image
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
    _, _, keys = S.read_twin(d)
    if len(keys) < 8:
        print(f"Only {len(keys)} pictures: nothing to class.")
        sys.exit(1)
    pick = np.unique(np.linspace(0, len(keys) - 1, num=min(cap, len(keys))).astype(int))
    imgs = [Image.open(os.path.join(d, keys[i]["name"])).convert("RGB") for i in pick]
    if len({im.size for im in imgs}) != 1:
        print("The pictures are not all one size: no classes.")
        sys.exit(1)
    t0 = time.time()
    pan, names = S.panoptic_maps(imgs, "cpu", print)
    pan = np.stack(pan)
    np.savez_compressed(os.path.join(d, "segments-masks.npz"), obj=pan, part=np.zeros_like(pan), pan=pan, names=json.dumps(names), pics=pick)
    print(f"CLASSES {len(imgs)} pictures {imgs[0].width}x{imgs[0].height}, {np.mean([len(n) for n in names]):.1f} shapes a picture, {time.time() - t0:.0f} s on the CPU.")


if __name__ == "__main__":
    main()
