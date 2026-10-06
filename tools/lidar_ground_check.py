"""
IS THE LIDAR'S GROUND WHERE THE GROUND IS? (owner, 2026-10-06: "times when
the lidar isn't zero-ing at ground, so the detector is confused about where
the ground actually is").

Every height the detector is given is "highest return minus the ground
surface", and the ground surface comes from the survey's own ground-classed
returns (class 2), filled between them (lidar_frame.py fill_surface). Where
that surface is wrong, every height on the lot is wrong with it, and nothing
says so.

The test needs no truth beyond the tracing: on ground the tracer called
VISIBLE LAWN (class 0 in lidar_frame.py's `classes`), grass is a few
centimetres tall, so the height above ground should be about zero and nearly
every cell should have a ground return of its own. Per lot:

    median height over visible lawn          should be ~0
    share of visible lawn over 1 m           some, from branches overhanging
                                             the lawn's edge -- not most
    share of visible lawn under -0.3 m       a ground surface ABOVE the lawn
    share of visible lawn with a ground hit  open grass nearly always has one

and a flag when any is far off. Reads lidar/<id>.npz and lidar/summary.json.

    LIDAR=lidar OUT=lidar-ground.json python3 tools/lidar_ground_check.py
"""

import json
import os
import sys
from pathlib import Path

import numpy as np

MEDIAN_OFF_M = 0.5        # visible lawn's median height further than this from 0
TALL_SHARE = 0.25         # more than this share of visible lawn over 1 m
SUNK_SHARE = 0.25         # more than this under -0.3 m
GROUND_HIT_MIN = 0.6      # fewer than this share of visible-lawn cells with a ground return
MIN_CELLS = 20


def check(classes, height, n_ground):
    """The four figures and the reasons, for one lot. Pure."""
    lawn = (classes == 0) & np.isfinite(height)
    n = int(lawn.sum())
    if n < MIN_CELLS:
        return {"cells": n, "flag": None}
    h = height[lawn]
    out = {
        "cells": n,
        "median_m": round(float(np.median(h)), 2),
        "tall_share": round(float((h > 1.0).mean()), 3),
        "sunk_share": round(float((h < -0.3).mean()), 3),
        "ground_hit_share": round(float((n_ground[lawn] > 0).mean()), 3),
    }
    why = []
    if abs(out["median_m"]) > MEDIAN_OFF_M:
        why.append(f"lawn sits {out['median_m']:+.1f} m off the ground")
    if out["tall_share"] > TALL_SHARE:
        why.append(f"{out['tall_share'] * 100:.0f}% of lawn reads over 1 m")
    if out["sunk_share"] > SUNK_SHARE:
        why.append(f"{out['sunk_share'] * 100:.0f}% of lawn reads below the ground")
    if out["ground_hit_share"] < GROUND_HIT_MIN:
        why.append(f"only {out['ground_hit_share'] * 100:.0f}% of lawn has a ground return")
    out["flag"] = "; ".join(why) or None
    return out


def main():
    lidar = Path(os.environ.get("LIDAR", "lidar"))
    summary = json.loads((lidar / "summary.json").read_text()) if (lidar / "summary.json").exists() else {"lawns": {}}
    names = {}
    frames = Path(os.environ.get("FRAMES", "frames"))
    if (frames / "scale.json").exists():
        names = json.loads((frames / "scale.json").read_text()).get("tags") or {}
    rows = {}
    for f in sorted(lidar.glob("*.npz")):
        z = np.load(f)
        if "classes" not in z or "height" not in z:
            continue
        lawn_id = f.stem
        r = check(z["classes"], z["height"], z["n_ground"] if "n_ground" in z else np.ones_like(z["height"]))
        r["project"] = (summary["lawns"].get(lawn_id) or {}).get("project")
        r["name"] = names.get(lawn_id) or lawn_id[:28]
        rows[lawn_id] = r
    read = {k: r for k, r in rows.items() if r.get("flag") is not None or "median_m" in r}
    flagged = {k: r for k, r in read.items() if r.get("flag")}
    print(f"\nTHE LIDAR'S GROUND UNDER THE VISIBLE LAWN: {len(read)} lots read, {len(flagged)} flagged.")
    print("  (grass is ~0 m over the ground; a lot whose lawn is not is a lot whose every height is off)\n")
    print(f"  {'lot':30} {'median':>7} {'>1 m':>6} {'<-0.3':>6} {'ground hit':>10}  project")
    for k, r in sorted(read.items(), key=lambda kv: -abs(kv[1]['median_m'])):
        mark = "  <-- " + r["flag"] if r.get("flag") else ""
        print(f"  {r['name'][:30]:30} {r['median_m']:+6.2f}m {r['tall_share'] * 100:5.0f}% {r['sunk_share'] * 100:5.0f}%"
              f" {r['ground_hit_share'] * 100:9.0f}%  {str(r['project'])[:34]}{mark}")
    by_project = {}
    for r in read.values():
        by_project.setdefault(r["project"], []).append(bool(r.get("flag")))
    bad = {p: v for p, v in by_project.items() if any(v)}
    if bad:
        print("\n  Flagged lots by survey: " + ", ".join(f"{p} {sum(v)} of {len(v)}" for p, v in sorted(bad.items(), key=str)))
    out = os.environ.get("OUT")
    if out:
        Path(out).write_text(json.dumps(rows, indent=1))
        print(f"\nEvery lot in {out}.")


if __name__ == "__main__":
    sys.exit(main())
