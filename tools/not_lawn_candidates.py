"""
Pick places with a public outline of something CERTAINLY NOT LAWN, away from
our own maps, for new training examples (owner, 2026-09-27).

The owner's idea, done right this time: not outlines over the maps we have
(inside a lot line the tracing already says everything), but NEW frames
centred on a pond, a house, a pool, a driveway, a car park or a road
somewhere near our corpus -- same regions, same kind of photography -- where
only the outlined ground will be taught as "not lawn" and the rest of the
frame is ignored, exactly as ground outside a lot line is today. The owner
reviews every one before the detector sees it.

    python3 tools/not_lawn_candidates.py seeds.json candidates.json

seeds.json is the corpus's lot centres (tools/not-lawn-examples.js seeds).
Writes about 150 candidates: QUOTA per class, each with its frame's box and
every public outline inside that box (the target flagged), for
tools/not-lawn-examples.js to photograph.
"""

import json
import math
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from public_negatives import (Local, bbox_around, centroid, fetch_negatives, fetch_nhd,
                              fetch_overpass, parse_overpass, ring_area)

# Half water: the one class our corpus has almost none of (one pond in 55
# maps, and not in any public dataset). The rest spread over what a detector
# confuses with grass or bleeds lawn onto.
QUOTA = {"water": 75, "building": 20, "pool": 15, "driveway": 15, "parking": 15,
         "road": 5, "sidewalk": 5}
# Sizes a photograph of about 110 m or less can show whole, with room around it.
AREA_M2 = {"water": (150, 15000), "building": (60, 900), "pool": (15, 250),
           "driveway": (20, 500), "parking": (150, 5000), "road": (60, 3000),
           "sidewalk": (10, 800)}
MIN_FROM_LOT_M = 400     # never near a map we score: a held-out lot must not appear
FRAME_MARGIN_M = 12
MIN_SIDE_M, MAX_SIDE_M = 40, 110
PER_PLACE = 3            # at most this many of one class from one search box


def metres(lon1, lat1, lon2, lat2):
    k = 111320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * k, (lat2 - lat1) * 110540.0)


def parts(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def bbox_of(geom):
    xs = [p[0] for poly in parts(geom) for ring in poly for p in ring]
    ys = [p[1] for poly in parts(geom) for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def area_m2(geom):
    """Outer rings only; a buffered road's overlapping parts overcount a little,
    which only matters to the size filter."""
    lon, lat = centroid(geom)
    loc = Local(lon, lat)
    return sum(abs(ring_area([loc.fwd(*p) for p in poly[0]])) for poly in parts(geom) if poly)


def frame_box(geom):
    """The target plus a margin, at least MIN_SIDE_M a side, or None if too big."""
    w, s, e, n = bbox_of(geom)
    lat = (s + n) / 2
    kx = 111320.0 * math.cos(math.radians(lat))
    ky = 110540.0
    wm, hm = (e - w) * kx, (n - s) * ky
    if max(wm, hm) + 2 * FRAME_MARGIN_M > MAX_SIDE_M:
        return None
    padx = (max(MIN_SIDE_M, wm + 2 * FRAME_MARGIN_M) - wm) / 2 / kx
    pady = (max(MIN_SIDE_M, hm + 2 * FRAME_MARGIN_M) - hm) / 2 / ky
    return [w - padx, s - pady, e + padx, n + pady]


def far_from_lots(geom, lots):
    lon, lat = centroid(geom)
    return all(metres(lon, lat, s["lng"], s["lat"]) >= MIN_FROM_LOT_M for s in lots)


def suitable(f, cls, lots):
    lo, hi = AREA_M2[cls]
    a = area_m2(f["geometry"])
    return lo <= a <= hi and far_from_lots(f["geometry"], lots) and frame_box(f["geometry"]) is not None


def offset(lon, lat, rng, lo_m=600, hi_m=3000):
    d = rng.uniform(lo_m, hi_m)
    b = rng.uniform(0, 2 * math.pi)
    return (lon + d * math.cos(b) / (111320.0 * math.cos(math.radians(lat))),
            lat + d * math.sin(b) / 110540.0)


def say(*a):
    print(*a, flush=True)   # a pipe buffers; the log was empty for 45 minutes


def pick(seeds, rng, log=say, max_searches=160, searched=None, batch=4, deadline=None):
    """Fills the quotas. Every box searched is appended to `searched` as
    (source, box, features), so a frame inside one needs no second query.
    Past `deadline` (time.time()) it stops searching and keeps what it has:
    fewer examples beat a run the 3-hour limit kills with none."""
    searched = [] if searched is None else searched
    chosen = {c: [] for c in QUOTA}
    seen = set()

    def take(f, cls):
        sid = f["properties"]["source"] + ":" + f["properties"]["source_id"]
        if sid in seen or len(chosen[cls]) >= QUOTA[cls]:
            return False
        seen.add(sid)
        chosen[cls].append(f)
        return True

    # Water from NHD first: one query covers kilometres, and it is the class
    # the corpus lacks.
    order = seeds[:]
    rng.shuffle(order)
    late = lambda: deadline is not None and time.time() > deadline  # noqa: E731
    for s in order:
        if len(chosen["water"]) >= QUOTA["water"] or late():
            break
        box = bbox_around(s["lng"], s["lat"], 3000)
        try:
            got = fetch_nhd(box)
        except Exception as e:  # noqa: BLE001 - one region failing is not the run failing
            log(f"  nhd near {s['lng']:.4f},{s['lat']:.4f}: {str(e)[:80]}")
            continue
        searched.append(("nhd", box, got))
        n = 0
        for f in got:
            if n < PER_PLACE and suitable(f, "water", seeds) and take(f, "water"):
                n += 1
        log(f"  nhd near {s['lng']:.4f},{s['lat']:.4f}: {len(got)} waterbodies, took {n}")

    # Everything else (and water NHD did not supply) from OSM, in small boxes
    # a short drive from our lots.
    # A few queries at a time: the one public mirror that answers from CI can
    # take half a minute each. Picking still goes in order, so it is repeatable.
    def query(box):
        try:
            return fetch_overpass(box)[0], None
        except Exception as e:  # noqa: BLE001
            return None, e

    searches = 0
    with ThreadPoolExecutor(batch) as pool:
        while searches < max_searches and any(len(chosen[c]) < QUOTA[c] for c in QUOTA) and not late():
            spots = []
            for _ in range(min(batch, max_searches - searches)):
                s = rng.choice(seeds)
                spots.append(offset(s["lng"], s["lat"], rng))
            boxes = [bbox_around(lon, lat, 250) for lon, lat in spots]
            for (lon, lat), box, (data, err) in zip(spots, boxes, pool.map(query, boxes)):
                searches += 1
                if err is not None:
                    log(f"  osm search {searches}: {str(err).splitlines()[0][:80]}")
                    continue
                feats = parse_overpass(data, Local(lon, lat))
                searched.append(("osm", box, feats))
                took = {}
                for f in feats:
                    cls = f["properties"]["class"]
                    if cls not in QUOTA or took.get(cls, 0) >= PER_PLACE:
                        continue
                    if suitable(f, cls, seeds) and take(f, cls):
                        took[cls] = took.get(cls, 0) + 1
                log(f"  osm search {searches}: {len(feats)} outlines, took "
                    + (", ".join(f"{k} {v}" for k, v in took.items()) or "nothing"))
            time.sleep(1.0)   # the public Overpass servers ask for restraint
    return chosen


def inside(inner, outer):
    return outer[0] <= inner[0] and outer[1] <= inner[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def frame_contents(box, searched, fetch=fetch_negatives, may_fetch=True):
    """Every public outline in a frame: from a box already searched that holds
    the whole frame (both queries return anything touching their box, so
    nothing in the frame is missed), else fetched. Returns (features, errors,
    how many sources were fetched)."""
    feats, need = [], []
    for source in ("osm", "nhd"):
        hit = next((f for s, b, f in searched if s == source and inside(box, b)), None)
        if hit is None:
            need.append(source)
        else:
            feats += [g for g in hit if overlaps(bbox_of(g["geometry"]), box)]
    errors = None
    if need and not may_fetch:
        # Out of time: whatever the searches already hold that touches the
        # frame, and a note for the review page that it may be incomplete.
        for source in need:
            feats += [g for s, b, f in searched if s == source for g in f
                      if overlaps(bbox_of(g["geometry"]), box)]
        return feats, {s: "not fetched (time budget): outlines here may be incomplete" for s in need}, 0
    if need:
        try:
            fc = fetch(tuple(box), sources=tuple(need))
            feats += fc["features"]
            errors = fc.get("errors")
        except Exception as e:  # noqa: BLE001
            errors = {"all": str(e)}
    return feats, errors, len(need)


def main(argv, workers=4):
    if len(argv) < 2:
        print(__doc__)
        return 2
    seeds = json.load(open(argv[0]))
    rng = random.Random(7)
    searched = []
    start = time.time()
    pick_s = float(os.environ.get("PICK_BUDGET_MIN", "50")) * 60
    frame_s = float(os.environ.get("FRAME_BUDGET_MIN", "25")) * 60
    chosen = pick(seeds, rng, searched=searched, deadline=start + pick_s)
    say(f"Picking took {(time.time() - start) / 60:.0f} min.")
    frame_deadline = time.time() + frame_s
    todo = [(cls, i, f, frame_box(f["geometry"]))
            for cls, feats in chosen.items() for i, f in enumerate(feats, 1)]
    say(f"Framing {len(todo)} candidates ({workers} at a time where a query is needed).")

    def one(job):
        cls, i, f, box = job
        # Every public outline in the frame, so the owner sees the whole
        # picture and a house beside the pond is taught too.
        others, errors, fetched = frame_contents(box, searched, may_fetch=time.time() < frame_deadline)
        tid = (f["properties"]["source"], f["properties"]["source_id"])
        features = [g for g in others if (g["properties"]["source"], g["properties"]["source_id"]) != tid]
        f["properties"]["target"] = True
        features.insert(0, f)
        say(f"  {cls}-{i:03d}  {len(features)} outlines in a "
            f"{(box[2] - box[0]) * 111320 * math.cos(math.radians(box[1])):.0f} m frame"
            + (f" ({fetched} fetched)" if fetched else " (from the search)"))
        return {"id": f"{cls}-{i:03d}", "target": f["properties"], "bbox": box,
                "features": features, **({"errors": errors} if errors else {})}

    with ThreadPoolExecutor(workers) as pool:
        out = list(pool.map(one, todo))
    json.dump(out, open(argv[1], "w"))
    counts = {c: len(v) for c, v in chosen.items()}
    say("Candidates by class: " + ", ".join(f"{k} {v}/{QUOTA[k]}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
