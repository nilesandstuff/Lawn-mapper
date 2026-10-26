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
# Only the weights are under test; the step this runs in has the refiner on.
td.REFINE = False
td.FUSE = False

td.UNDER_TREES = False
plain = td.read_lawn(d, d, "lot", shape)
td.UNDER_TREES = True
taught = td.read_lawn(d, d, "lot", shape)
td.UNDER_TREES = False

wp, wt, t = plain["w"][0].numpy(), taught["w"][0].numpy(), taught["t"][0].numpy()
check("as before: the inferred quarter carries no weight", wp[:2, :2].max() == 0 and wp[2:, :].min() == 1)
check("taught under trees: it carries full weight", wt.min() == 1)
check("and its target is lawn", t[:2, :2].min() == 1 and t[:, 2:].max() == 0)
# S21: where the live model's outline (lot-detected.png) disagrees with the
# finished lawn, the weight rises; elsewhere it does not.
det = np.zeros((16, 16), np.uint8)
det[:, :12] = 255                         # the model drew 4 columns too far right
Image.fromarray(det).save(os.path.join(d, "lot-detected.png"))
td.CORRECTIONS_WEIGHT = 2.0
corr = td.read_lawn(d, d, "lot", shape)
td.CORRECTIONS_WEIGHT = 0.0
wc, w0 = corr["w"][0].numpy(), plain["w"][0].numpy()
check("cells where the model was corrected weigh 3x", abs(wc[2, 2] - 3 * w0[2, 2]) < 1e-6 and wc[2, 2] > 0)
check("cells it got right are unchanged", abs(wc[2, 0] - w0[2, 0]) < 1e-6 and abs(wc[2, 3] - w0[2, 3]) < 1e-6)
check("and the lot says it was corrected", corr["corrected"] and not plain["corrected"])

# S66, TAUGHT ONLY WHAT WAS TRACED (UNDER_TREES=traced): the tree model's
# canopy over the bottom-left quarter (traced lawn, not marked) and the
# top-right one (no lawn traced). The top-left quarter is still marked.
can = np.zeros((16, 16), np.uint8)
can[8:, :8] = 255
can[:8, 8:] = 255
Image.fromarray(can).save(os.path.join(d, "lot-mask.png"))
td.CANOPY = d
td.CANOPY_MODE = "lawn"


def weights(under, traced, doubted=()):
    td.UNDER_TREES, td.TRACED_ONLY, td.DOUBTED = under, traced, set(doubted)
    L = td.read_lawn(d, d, "lot", shape)
    td.UNDER_TREES, td.TRACED_ONLY, td.DOUBTED = False, False, set()
    return L["w"][0].numpy(), L["t"][0].numpy()


wn, _ = weights(False, False)
check("untaught: the marks and the canopy over traced lawn carry no weight",
      wn[:2, :2].max() == 0 and wn[2:, :2].max() == 0)
check("untaught: canopy the tracer drew no lawn under stays weighted", wn[:2, 2:].min() == 1)
w1, _ = weights(True, False)
check("taught (THE PLAN): everything carries weight", w1.min() == 1)
wt, tt = weights(True, True)
check("traced only: the inferred marks carry no weight", wt[:2, :2].max() == 0)
check("traced only: lawn traced under the canopy is graded, as lawn",
      wt[2:, :2].min() == 1 and tt[2:, :2].min() == 1)
check("traced only: canopy with no lawn traced stays a weighted zero",
      wt[:2, 2:].min() == 1 and tt[:2, 2:].max() == 0)
wd, _ = weights(True, True, doubted=["lot"])
check("traced only: a doubted lot is taught its traced lawn under the canopy too",
      wd[2:, :2].min() == 1 and wd[:2, :2].max() == 0)
wdp, _ = weights(True, False, doubted=["lot"])
check("taught (THE PLAN): a doubted lot is graded on seen ground only, as before",
      wdp[2:, :2].max() == 0 and wdp[:2, :2].max() == 0)
td.CANOPY = ""

print(f"\nAll {passed} checks passed.")
