"""FLIPS=0 trains every grid as drawn, with the same random draws (train_decoder.py).

    python3 tools/flips_test.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("FEATURES", "x")
import train_decoder  # noqa: E402

a, b = np.random.default_rng(3), np.random.default_rng(3)
train_decoder.FLIPS = True
on = [train_decoder.orientation(a) for _ in range(40)]
train_decoder.FLIPS = False
off = [train_decoder.orientation(b) for _ in range(40)]
assert len(set(on)) > 4, on
assert set(off) == {(0, False)}, off
assert a.integers(1000) == b.integers(1000), "the same number of draws either way"
print("flips: ok")
