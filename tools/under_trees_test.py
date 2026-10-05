"""Checks that UNDER_TREES grades the inferred lawn instead of leaving it out.
   (cd tools && python3 under_trees_test.py)"""
import os
import tempfile

import numpy as np
from PIL import Image

import train_decoder as td

passed = 0


def check(name, cond):
    global passed
    assert cond, name
    passed += 1
    print(f"PASS  {name}")


d = tempfile.mkdtemp()
gh = gw = 4
dim = 3
np.zeros(gh * gw * dim, np.float32).tofile(os.path.join(d, "lot.f32"))
# 16 x 16 label cells: all inside the line, the left half lawn, its top-left
# quarter marked inferred (lawn under a tree).
lab = np.zeros((16, 16, 3), np.uint8)
lab[:, :8, 0] = 255
lab[:, :, 1] = 255
lab[:8, :8, 2] = 255
Image.fromarray(lab).save(os.path.join(d, "lot-labels.png"))
shape = {"gridH": gh, "gridW": gw, "dim": dim}

td.UNDER_TREES = False
plain = td.read_lawn(d, d, "lot", shape)
td.UNDER_TREES = True
taught = td.read_lawn(d, d, "lot", shape)
td.UNDER_TREES = False

wp, wt, t = plain["w"][0].numpy(), taught["w"][0].numpy(), taught["t"][0].numpy()
check("as before: the inferred quarter carries no weight", wp[:2, :2].max() == 0 and wp[2:, :].min() == 1)
check("taught under trees: it carries full weight", wt.min() == 1)
check("and its target is lawn", t[:2, :2].min() == 1 and t[:, 2:].max() == 0)
print(f"\nAll {passed} checks passed.")
