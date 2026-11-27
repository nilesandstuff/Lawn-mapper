"""name_prep.py and the sky rule it uses, tested without a walk (core session, 2026-11-27).
    python scan/tools/name_prep_selftest.py"""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import name_prep as N        # noqa: E402
import segment_study as S    # noqa: E402

# THE CHAIN (the owner's mulch and grass): photo 0 cut mulch (node 1) and grass (node 2) apart; photo 1 took both in
# one shape (node 4). Mulch meets it strongly, grass a little less: grass must NOT join mulch through it.
photo_of = np.array([0, 0, 0, 1, 1, 2, 2])
comp, refused = N.join_things(photo_of, [(0.8, 1, 4), (0.6, 2, 4), (0.9, 2, 6)])
assert comp[1] == comp[4] and comp[1] != comp[2], comp
assert comp[2] == comp[6] and refused == 1, (comp, refused)
# a plain run of one thing through three photos still joins
comp, refused = N.join_things(np.array([0, 1, 2]), [(0.7, 0, 1), (0.7, 1, 2)])
assert len(set(comp)) == 1 and refused == 0

# THE OWNER'S WALL: a shape the whole-picture model calls sky but the photo's own depth measured is not sky
m = np.zeros((40, 40), np.int32)
m[:20, :20] = 1        # the pale wall
m[:20, 20:] = 2        # the real sky
m[20:, :] = 3          # the ground
pan = np.zeros_like(m)
pan[:20, :] = 7        # the model: all of the top is sky
dg = np.zeros((8, 8))
dg[:4, :4] = 2.5       # the phone measured the wall, 2.5 m off
dg[4:, :] = 1.5
near = S.near_mask(dg, m.shape)
t, sky, _ = S.tidy_shapes(m, pan, {7: "sky"}, near)
assert (t[:20, :20] == 1).all(), "the wall keeps its shape"
assert sky and (t[:20, 20:] == sky).all(), "the sky is still sky"
t0, sky0, _ = S.tidy_shapes(m, pan, {7: "sky"})
assert (t0[:20, :20] == sky0).all(), "without depth, as before"

# THE NAMES CARRIED OVER: old thing 10 held photo 0's shapes 1 and 2 (the chain), thing 20 held shape 3 alone
d = tempfile.mkdtemp()
old_seg = {"pictures": [{"shapes": {"1": [10, 5, 9], "2": [10, 5, 9], "3": [20, 5, 9]}}]}
new_pics = [{"shapes": {"1": [100, 5, 9], "2": [200, 5, 9], "3": [300, 5, 9]}}]
N.carry_names(d, old_seg, {"names": {"10": "grass", "20": "tree"}, "shapes": {"0:3": ""}, "words": ["grass"]}, new_pics)
out = json.load(open(os.path.join(d, "seg-names.json")))
assert out["names"] == {"300": "tree"}, out      # the split thing's name is dropped; the unchanged one kept
assert out["shapes"] == {"0:3": ""} and out["words"] == ["grass"]
N.carry_names(d, old_seg, {"names": {"10": "mulch"}, "picked": {"0:1": "mulch"}}, new_pics)
out = json.load(open(os.path.join(d, "seg-names.json")))
assert out["names"] == {"100": "mulch"}, out     # a tapped shape's name follows it
print("name_prep selftest: ok")
