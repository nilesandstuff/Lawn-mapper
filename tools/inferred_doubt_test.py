"""A doubted lot is graded on seen ground only; the rest are taught (train_decoder.py).

    python3 tools/inferred_doubt_test.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("FEATURES", "x")
os.environ["UNDER_TREES"] = "1"
d = tempfile.mkdtemp()
path = os.path.join(d, "inferred-doubt.json")
with open(path, "w") as f:
    json.dump({"ids": ["-1,1:alpha:find"]}, f)
os.environ["INFERRED_DOUBT"] = path
from train_decoder import taught_for, DOUBTED  # noqa: E402

assert DOUBTED == {"-1,1:alpha:find"}, DOUBTED
assert not taught_for("-1,1:alpha:find"), "a doubted lot is not taught under trees"
assert taught_for("-2,2:alpha:find"), "any other lot is"
assert not taught_for("-3,3:example:water-001"), "an example frame never is"
print("inferred doubt: ok")
