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
import random
import sys
import time

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


def pick(seeds, rng, log=print, max_searches=160):
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
    for s in order:
        if len(chosen["water"]) >= QUOTA["water"]:
            break
        try:
            got = fetch_nhd(bbox_around(s["lng"], s["lat"], 3000))
        except Exception as e:  # noqa: BLE001 - one region failing is not the run failing
            log(f"  nhd near {s['lng']:.4f},{s['lat']:.4f}: {str(e)[:80]}")
            continue
        n = 0
        for f in got:
            if n < PER_PLACE and suitable(f, "water", seeds) and take(f, "water"):
                n += 1
        log(f"  nhd near {s['lng']:.4f},{s['lat']:.4f}: {len(got)} waterbodies, took {n}")

    # Everything else (and water NHD did not supply) from OSM, in small boxes
    # a short drive from our lots.
    searches = 0
    while searches < max_searches and any(len(chosen[c]) < QUOTA[c] for c in QUOTA):
        s = rng.choice(seeds)
        lon, lat = offset(s["lng"], s["lat"], rng)
        searches += 1
        try:
            data, _ = fetch_overpass(bbox_around(lon, lat, 250))
        except Exception as e:  # noqa: BLE001
            log(f"  osm search {searches}: {str(e).splitlines()[0][:80]}")
            continue
        feats = parse_overpass(data, Local(lon, lat))
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


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    seeds = json.load(open(argv[0]))
    rng = random.Random(7)
    chosen = pick(seeds, rng)
    out = []
    for cls, feats in chosen.items():
        for i, f in enumerate(feats, 1):
            box = frame_box(f["geometry"])
            # Every public outline in the frame, so the owner sees the whole
            # picture and a house beside the pond is taught too.
            try:
                fc = fetch_negatives(tuple(box), sources=("osm", "nhd"))
                others = fc["features"]
                errors = fc.get("errors")
            except Exception as e:  # noqa: BLE001
                others, errors = [], {"all": str(e)}
            tid = (f["properties"]["source"], f["properties"]["source_id"])
            features = [g for g in others if (g["properties"]["source"], g["properties"]["source_id"]) != tid]
            f["properties"]["target"] = True
            features.insert(0, f)
            out.append({"id": f"{cls}-{i:03d}", "target": f["properties"], "bbox": box,
                        "features": features, **({"errors": errors} if errors else {})})
            print(f"{len(out):3d}  {cls}-{i:03d}  {len(features)} outlines in a "
                  f"{(box[2] - box[0]) * 111320 * math.cos(math.radians(box[1])):.0f} m frame", flush=True)
            time.sleep(1.0)
    json.dump(out, open(argv[1], "w"))
    counts = {c: len(v) for c, v in chosen.items()}
    print("Candidates by class: " + ", ".join(f"{k} {v}/{QUOTA[k]}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
