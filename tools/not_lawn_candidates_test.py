"""Offline: the picker keeps its quotas, stays away from our lots, and frames fit."""
import random

import not_lawn_candidates as nl


def square(lon, lat, side_m):
    k = 111320.0 * nl.math.cos(nl.math.radians(lat))
    dx, dy = side_m / 2 / k, side_m / 2 / 110540.0
    ring = [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]
    return {"type": "Polygon", "coordinates": [ring]}


def feat(geom, cls, sid):
    return {"type": "Feature", "geometry": geom, "properties": {"class": cls, "source": "t", "source_id": sid}}


seeds = [{"lng": -85.6, "lat": 42.9}, {"lng": -85.6, "lat": 42.9}]  # two places searched, three a place
n = [0]

def fake_nhd(bbox):
    n[0] += 1
    return [feat(square(-85.6 + 0.01 * i, 42.9 + 0.01, 40), "water", f"w{n[0]}-{i}") for i in range(6)] + \
           [feat(square(-85.6, 42.9, 40), "water", "too-close")] + \
           [feat(square(-85.63, 42.93, 400), "water", "too-big")]

def fake_overpass(bbox):
    lon, lat = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return {"elements": []}, "fake"

nl.fetch_nhd = fake_nhd
nl.fetch_overpass = fake_overpass
nl.parse_overpass = lambda data, frame: [feat(square(-85.62 + random.random() * 0.01, 42.92, 15), "building", f"b{random.random()}")]
nl.QUOTA = {"water": 5, "building": 4, "pool": 0, "driveway": 0, "parking": 0, "road": 0, "sidewalk": 0}
nl.time.sleep = lambda s: None

chosen = nl.pick(seeds, random.Random(1), log=lambda *a: None, max_searches=20)
assert len(chosen["water"]) == 5, len(chosen["water"])
ids = [f["properties"]["source_id"] for f in chosen["water"]]
assert "too-close" not in ids and "too-big" not in ids, ids
print("PASS  water quota met, nothing near a lot, nothing too big to frame")

assert len(chosen["building"]) == 4, len(chosen["building"])
print("PASS  the building quota fills from the OSM searches and stops there")
for f in chosen["water"] + chosen["building"]:
    box = nl.frame_box(f["geometry"])
    wm = (box[2] - box[0]) * 111320 * nl.math.cos(nl.math.radians(box[1]))
    assert nl.MIN_SIDE_M - 0.5 <= wm <= nl.MAX_SIDE_M + 0.5, wm
print("PASS  every frame is between 40 and 110 m across")

assert nl.area_m2(square(-85.6, 42.9, 20)) > 390 and nl.area_m2(square(-85.6, 42.9, 20)) < 410
print("PASS  a 20 m square measures 400 m2")

# A frame inside a box already searched is filled from that search, not fetched.
searched = [("osm", [-85.7, 42.8, -85.5, 43.0], [feat(square(-85.6, 42.9, 10), "building", "in"),
                                                  feat(square(-85.52, 42.98, 10), "building", "out")]),
            ("nhd", [-85.7, 42.8, -85.5, 43.0], [])]
calls = []
def no_fetch(box, sources):
    calls.append(sources)
    return {"features": []}
frame = nl.frame_box(square(-85.6, 42.9, 10))
got, errs, fetched = nl.frame_contents(frame, searched, fetch=no_fetch)
assert fetched == 0 and not calls, calls
assert [g["properties"]["source_id"] for g in got] == ["in"], got
print("PASS  a frame inside a searched box is filled from it, only with what touches the frame")

got, errs, fetched = nl.frame_contents([-80.0, 40.0, -79.999, 40.001], searched, fetch=no_fetch)
assert fetched == 2 and calls == [("osm", "nhd")], calls
print("PASS  a frame outside every searched box is fetched")

# Out of time: no fetch, what the searches hold, and a note that it may be incomplete.
calls.clear()
got, errs, fetched = nl.frame_contents([-80.0, 40.0, -79.999, 40.001], searched, fetch=no_fetch, may_fetch=False)
assert not calls and fetched == 0 and set(errs) == {"osm", "nhd"}, (calls, errs)
print("PASS  past the time budget a frame is not fetched, and says it may be incomplete")

# A deadline already passed: pick stops before searching anything.
n[0] = 0
chosen = nl.pick(seeds, random.Random(1), log=lambda *a: None, max_searches=20, deadline=0)
assert n[0] == 0 and sum(len(v) for v in chosen.values()) == 0, n[0]
print("PASS  past its deadline the picker stops and keeps what it has")
