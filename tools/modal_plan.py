"""
Workflow 14's backbone and decoder steps, as a plan for tools/modal_gpu.py.

The same environment each step gets on GitHub (train-backbone.yml), built
from the dispatch inputs, so a run on Modal's GPU is the same run as one on
the CPU runner in everything but where the arithmetic happens. If a decoder
or extraction setting changes in the workflow, it changes here too --
modal_plan_test.py pins the two to each other.

    WINDOWS, CANOPY, DECODER, SEED, LAWNS, MODEL, SIZE, RELEASE: the dispatch inputs
    RUN: the run's folder on the volume
    SEND: comma-separated local paths to send first
    OUT: where to write the plan (default plan.json)
"""

import json
import os


def folds(lawns):
    return "place" if lawns == "all" else ("10" if lawns == "benchmark, 10 folds" else "")


def plan(inputs, run, send):
    windows = inputs["windows"]
    canopy = inputs["canopy"]
    decoder = inputs["decoder"]
    seed = inputs["seed"]
    fused = "1" if decoder == "fused" else ""
    whole = "feats-whole" if windows == "both" else ""

    steps = []
    base = {"IMAGES": "frames", "MODEL": inputs["model"], "SIZE": inputs["size"]}
    if windows == "both":
        steps.append({"script": "extract_features.py", "env": {**base, "OUT": "feats-whole", "TARGET_MPP": "9"}})
    tile = "0.06" if windows in ("tiles", "both") else ("0.10" if windows == "tiles 10 cm" else "")
    steps.append({"script": "extract_features.py", "env": {
        **base, "OUT": "feats",
        "TARGET_MPP": "9" if windows == "off" else "0.10",
        "TILE_MPP": tile,
    }})

    common = {
        "FEATURES": "feats", "FEATURES_WHOLE": whole, "FRAMES": "frames",
        "SEED": seed, "FUSE": fused, "FUSE_LIDAR": "lidar", "FUSE_NAIP": "naip",
        "FOLDS": folds(inputs["lawns"]),
    }
    outs = []
    if inputs.get("release") and inputs["release"] != "off":
        # THE RELEASE (workflow 14 `release: alpha`): THE PLAN's decoder and
        # edge refiner trained once on every lot, the env the GitHub step
        # "Train the release model on every lot" sets. No folds, no scoring.
        steps.append({"script": "train_decoder.py", "env": {
            "FEATURES": "feats", "FEATURES_WHOLE": whole, "FRAMES": "frames",
            "CANOPY": "canopy", "CANOPY_MODE": "all" if canopy == "everywhere" else "lawn",
            "SEED": seed, "FUSE": "1", "FUSE_LIDAR": "lidar", "FUSE_NAIP": "naip",
            "FUSE_CANOPY": "1" if canopy == "everywhere" else "0",
            "REFINE": "1", "OUT": "preds-release", "RELEASE_OUT": "release",
        }})
        outs = ["release"]
    elif decoder != "off":
        if canopy != "compare":
            steps.append({"script": "train_decoder.py", "env": {
                **common, "OUT": "preds",
                "CANOPY": "canopy" if canopy != "off" else "",
                "CANOPY_MODE": "all" if canopy == "everywhere" else "lawn",
                "FUSE_CANOPY": "1" if canopy == "everywhere" else "0",
            }})
            outs = ["preds"]
        else:
            steps.append({"script": "train_decoder.py", "env": {**common, "OUT": "preds-none"}})
            steps.append({"script": "train_decoder.py", "env": {
                **common, "OUT": "preds-lawn", "CANOPY": "canopy", "CANOPY_MODE": "lawn", "FUSE_CANOPY": "0"}})
            steps.append({"script": "train_decoder.py", "env": {
                **common, "OUT": "preds-all", "CANOPY": "canopy", "CANOPY_MODE": "all"}})
            outs = ["preds-none", "preds-lawn", "preds-all"]

    return {
        "run": run,
        "send": [s for s in send if s],
        "steps": steps,
        "fetch": ["feats"] + ([whole] if whole else []) + outs,
        "cleanup": True,
    }


def main():
    e = os.environ
    inputs = {k: e.get(k.upper(), "") for k in ("windows", "canopy", "decoder", "seed", "lawns", "model", "size", "release")}
    p = plan(inputs, e["RUN"], (e.get("SEND") or "").split(","))
    with open(e.get("OUT") or "plan.json", "w") as f:
        json.dump(p, f, indent=1)
    print(json.dumps(p, indent=1))


if __name__ == "__main__":
    main()
