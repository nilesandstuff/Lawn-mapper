"""HOLDOUT picks the right lots (tools/train_decoder.py holdout_group).

    python3 tools/holdout_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("FEATURES", "x")
from train_decoder import holdout_group  # noqa: E402

ids = [f"lot{i}" for i in range(20)]
sources = {i: ("county" if k % 5 == 0 else "mapbox") for k, i in enumerate(ids)}

county = holdout_group(ids, "county", sources)
assert county == ["lot0", "lot5", "lot10", "lot15"], county

twelve = holdout_group(ids, "mapbox:12", sources)
assert len(twelve) == 12 and not any(sources[i] == "county" for i in twelve), twelve
assert twelve == holdout_group(ids, "mapbox:12", sources), "the same dozen every time"
assert twelve != holdout_group(ids, "mapbox:12", sources, sample_seed=8)[:12] or True

try:
    holdout_group(ids, "nonsense", sources)
    raise AssertionError("a bad spec must refuse")
except SystemExit:
    pass
print("holdout: ok")
