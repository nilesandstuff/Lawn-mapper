"""modal_plan.py sets what train-backbone.yml sets.

The GPU plan rebuilds the backbone and decoder steps' environment by hand,
so a setting added to the workflow and not to the plan would make a Modal run
quietly different from a GitHub one. This checks the NAMES each step sets
match, for every decoder step, and a few values that decide what is measured.
"""

import os

import yaml

from modal_plan import plan

HERE = os.path.dirname(os.path.abspath(__file__))
WF = yaml.safe_load(open(os.path.join(HERE, "..", ".github", "workflows", "train-backbone.yml")))
STEPS = [s for job in WF["jobs"].values() for s in job["steps"]]


def wf_env(name):
    [step] = [s for s in STEPS if s.get("name") == name]
    return set(step["env"])


def inputs(**over):
    base = {"windows": "off", "canopy": "compare", "decoder": "fused", "seed": "7",
            "lawns": "all", "model": "scalemae-large", "size": "896"}
    base.update(over)
    return base


def check_release():
    p = plan(inputs(canopy="on lawn", decoder="fused + edge", release="alpha"), "r", [])
    dec = [s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"]
    assert len(dec) == 1, "a release trains one decoder and scores nothing"
    assert set(dec[0]) == wf_env("Train the release model on every lot"), \
        set(dec[0]) ^ wf_env("Train the release model on every lot")
    assert dec[0]["FUSE"] == "1" and dec[0]["REFINE"] == "1" and dec[0]["FUSE_CANOPY"] == "0"
    assert "release" in p["fetch"]


def check_names():
    p = plan(inputs(), "r", ["lidar", "naip"])
    dec = [s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"]
    assert set(dec[0]) == wf_env("Train the decoder without the canopy"), \
        set(dec[0]) ^ wf_env("Train the decoder without the canopy")
    assert set(dec[1]) == wf_env("Train the decoder, canopy unseen on lawn"), \
        set(dec[1]) ^ wf_env("Train the decoder, canopy unseen on lawn")
    assert set(dec[2]) == wf_env("Train the decoder, canopy unseen everywhere"), \
        set(dec[2]) ^ wf_env("Train the decoder, canopy unseen everywhere")

    p = plan(inputs(canopy="on lawn", windows="both"), "r", [])
    [one] = [s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"]
    assert set(one) == wf_env("Train the decoder"), set(one) ^ wf_env("Train the decoder")

    ext = [s["env"] for s in p["steps"] if s["script"] == "extract_features.py"]
    assert set(ext[1]) == wf_env("Run the backbone over them"), set(ext[1]) ^ wf_env("Run the backbone over them")
    assert set(ext[0]) == wf_env("Run the backbone over each lot whole (both scales)")


def check_values():
    p = plan(inputs(canopy="on lawn", windows="both"), "r", [])
    ext = [s["env"] for s in p["steps"] if s["script"] == "extract_features.py"]
    assert ext[0]["OUT"] == "feats-whole" and ext[0]["TARGET_MPP"] == "9"
    assert ext[1]["TILE_MPP"] == "0.06"
    [one] = [s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"]
    assert one["FEATURES_WHOLE"] == "feats-whole" and one["CANOPY"] == "canopy"
    assert one["FUSE_CANOPY"] == "0" and one["FOLDS"] == "place" and one["FUSE"] == "1"
    assert p["fetch"] == ["feats", "feats-whole", "preds"]

    p = plan(inputs(), "r", [])
    ext = [s["env"] for s in p["steps"] if s["script"] == "extract_features.py"]
    assert len(ext) == 1 and ext[0]["TARGET_MPP"] == "9" and ext[0]["TILE_MPP"] == ""
    dec = [s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"]
    assert [d["OUT"] for d in dec] == ["preds-none", "preds-lawn", "preds-all"]
    assert "CANOPY" not in dec[0] and dec[2]["CANOPY_MODE"] == "all"
    assert p["fetch"] == ["feats", "preds-none", "preds-lawn", "preds-all"]

    p = plan(inputs(windows="on", decoder="off"), "r", ["", "frames"])
    assert p["send"] == ["frames"]
    assert [s["script"] for s in p["steps"]] == ["extract_features.py"]
    assert p["steps"][0]["env"]["TARGET_MPP"] == "0.10"


def check_trees():
    p = plan(inputs(canopy="on lawn", decoder="fused + edge + trees"), "r", [])
    assert [s["env"]["OUT"] for s in p["steps"] if s["script"] == "train_decoder.py"] == ["preds", "preds-edge", "preds-trees"]
    p = plan(inputs(canopy="on lawn", decoder="fused + edge + trees + returns"), "r", [])
    dec = {s["env"]["OUT"]: s["env"] for s in p["steps"] if s["script"] == "train_decoder.py"}
    assert list(dec) == ["preds", "preds-edge", "preds-trees", "preds-trees-returns"], list(dec)
    for out, step in (("preds", "Train the decoder"), ("preds-edge", "Train the decoder with the edge refiner"),
                      ("preds-trees", "Train the decoder taught under trees"),
                      ("preds-trees-returns", "Train the decoder taught under trees, with the lidar by return")):
        assert set(dec[out]) == wf_env(step), (out, set(dec[out]) ^ wf_env(step))
    assert dec["preds"]["FUSE"] == "1" and dec["preds-edge"]["REFINE"] == "1"
    assert dec["preds-trees"]["UNDER_TREES"] == "1" and "FUSE_RETURNS" not in dec["preds-trees"]
    assert dec["preds-trees-returns"]["FUSE_RETURNS"] == "tree-lidar"
    assert p["fetch"] == ["feats", "preds", "preds-edge", "preds-trees", "preds-trees-returns"]


check_trees()
check_names()
check_release()
check_values()
print("modal plan: ok")
