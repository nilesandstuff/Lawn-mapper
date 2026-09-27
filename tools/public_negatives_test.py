"""
Public negatives, offline: a hand-made Overpass answer, an NHD answer and two
Microsoft rows, no network.

    python3 tools/public_negatives_test.py
"""

import io
import json
import math

from public_negatives import (
    Local, assemble_rings, bbox_around, buffer_line, classify, drop_duplicate_buildings,
    overpass_query, parse_msbf_lines, parse_nhd, parse_overpass, point_in_ring, quadkey,
    tag_width_m,
)

passed = 0


def check(name, cond, detail=""):
    global passed
    assert cond, f"{name} {detail}"
    passed += 1
    print(f"PASS  {name}")


def g(*pts):
    return [{"lat": la, "lon": lo} for lo, la in pts]


# A block in the Kent County style: a house, a pool, a street, a driveway, a
# sidewalk, a pond drawn as a relation in two halves with an island, and the
# things that must NOT come back.
LON, LAT = -85.6, 42.9
d = 0.0001   # about 8 m east-west, 11 m north-south here
FIXTURE = {"elements": [
    {"type": "way", "id": 1, "tags": {"building": "house"},
     "geometry": g((LON, LAT), (LON + d, LAT), (LON + d, LAT + d), (LON, LAT + d), (LON, LAT))},
    {"type": "way", "id": 2, "tags": {"leisure": "swimming_pool"},
     "geometry": g((LON + 2*d, LAT), (LON + 3*d, LAT), (LON + 3*d, LAT + d), (LON + 2*d, LAT))},
    {"type": "way", "id": 3, "tags": {"highway": "residential"},
     "geometry": g((LON - 5*d, LAT - 3*d), (LON + 5*d, LAT - 3*d))},
    {"type": "way", "id": 4, "tags": {"highway": "service", "service": "driveway"},
     "geometry": g((LON + d, LAT - 3*d), (LON + d, LAT))},
    {"type": "way", "id": 5, "tags": {"highway": "footway", "footway": "sidewalk"},
     "geometry": g((LON - 5*d, LAT - 2*d), (LON + 5*d, LAT - 2*d))},
    {"type": "way", "id": 6, "tags": {"highway": "residential", "width": "12"},
     "geometry": g((LON, LAT + 5*d), (LON + 5*d, LAT + 5*d))},
    {"type": "relation", "id": 7, "tags": {"type": "multipolygon", "natural": "water"},
     "members": [
         # The shore in two ways, the second drawn backwards, as OSM allows.
         {"type": "way", "role": "outer",
          "geometry": g((LON + 10*d, LAT), (LON + 20*d, LAT), (LON + 20*d, LAT + 10*d))},
         {"type": "way", "role": "outer",
          "geometry": g((LON + 10*d, LAT), (LON + 10*d, LAT + 10*d), (LON + 20*d, LAT + 10*d))},
         {"type": "way", "role": "inner",
          "geometry": g((LON + 14*d, LAT + 4*d), (LON + 16*d, LAT + 4*d),
                        (LON + 16*d, LAT + 6*d), (LON + 14*d, LAT + 4*d))},
     ]},
    # Must not come back:
    {"type": "way", "id": 8, "tags": {"highway": "path"},
     "geometry": g((LON, LAT), (LON + d, LAT + d))},
    {"type": "way", "id": 9, "tags": {"amenity": "parking", "surface": "grass"},
     "geometry": g((LON, LAT), (LON + d, LAT), (LON + d, LAT + d), (LON, LAT))},
    {"type": "way", "id": 10, "tags": {"highway": "primary", "tunnel": "yes"},
     "geometry": g((LON, LAT), (LON + d, LAT))},
    {"type": "way", "id": 11, "tags": {"natural": "water", "intermittent": "yes"},
     "geometry": g((LON, LAT), (LON + d, LAT), (LON + d, LAT + d), (LON, LAT))},
    {"type": "way", "id": 12, "tags": {"building": "yes"},       # broken: never closes
     "geometry": g((LON, LAT), (LON + d, LAT), (LON + d, LAT + d))},
    {"type": "node", "id": 13, "lat": LAT, "lon": LON, "tags": {"leisure": "swimming_pool"}},
    {"type": "way", "id": 14, "tags": {"railway": "abandoned"},
     "geometry": g((LON, LAT), (LON + d, LAT))},
    {"type": "way", "id": 15, "tags": {"waterway": "ditch"},
     "geometry": g((LON, LAT), (LON + d, LAT))},
]}

# --- class mapping ---
check("a house is a building", classify({"building": "house"}) == ("building", None))
check("building=no is not", classify({"building": "no"}) is None)
check("a pool is a pool", classify({"leisure": "swimming_pool"}) == ("pool", None))
check("an indoor pool is left to its building", classify({"leisure": "swimming_pool", "location": "indoor"}) is None)
check("a pond, a riverbank and a reservoir are water",
      all(classify(t) == ("water", None) for t in
          ({"natural": "water"}, {"waterway": "riverbank"}, {"landuse": "reservoir"})))
check("a stormwater basin is not certainly water", classify({"natural": "water", "water": "basin"}) is None)
check("a stream is a narrow water line", classify({"waterway": "stream"}) == ("water", 1.0))
check("a ditch is left out (mowed swales)", classify({"waterway": "ditch"}) is None)
check("a residential street is road, 3.5 m either side", classify({"highway": "residential"}) == ("road", 3.5))
check("a driveway is a driveway, 1.5 m", classify({"highway": "service", "service": "driveway"}) == ("driveway", 1.5))
check("a parking aisle is road, 2.5 m", classify({"highway": "service", "service": "parking_aisle"}) == ("road", 2.5))
check("a sidewalk is a sidewalk, 0.75 m", classify({"highway": "footway", "footway": "sidewalk"}) == ("sidewalk", 0.75))
check("a pedestrian area is a sidewalk polygon", classify({"highway": "pedestrian", "area": "yes"}) == ("sidewalk", None))
check("a path or track is left out", classify({"highway": "path"}) is None and classify({"highway": "track"}) is None)
check("a gravel driveway still counts; a grass one does not",
      classify({"highway": "service", "service": "driveway", "surface": "gravel"}) is not None
      and classify({"highway": "service", "service": "driveway", "surface": "grass"}) is None)
check("surface parking is parking; underground is not",
      classify({"amenity": "parking"}) == ("parking", None)
      and classify({"amenity": "parking", "parking": "underground"}) is None)
check("live rail is rail; abandoned is not",
      classify({"railway": "rail"}) == ("rail", 2.0) and classify({"railway": "abandoned"}) is None)
check("a tunnel is left out", classify({"highway": "primary", "tunnel": "yes"}) is None)
check("a bridge is kept", classify({"highway": "primary", "bridge": "yes"}) == ("road", 5.0))
check("a width tag wins", classify({"highway": "residential", "width": "9"}) == ("road", 4.5))
check("widths read in metres and feet; nonsense is None",
      tag_width_m("7.5 m") == 7.5 and abs(tag_width_m("24'") - 7.3152) < 1e-6
      and tag_width_m("wide") is None and tag_width_m("1000") is None)

# --- buffering ---
frame = Local(LON, LAT)
line = [[LON, LAT], [LON + 0.001, LAT]]          # ~81.6 m due east
parts = buffer_line(line, 3.5, frame)
check("a two-point line is one rectangle and two end discs", len(parts) == 3)
rect = [frame.fwd(*c) for c in parts[0][0]]
# Coordinates are written to 7 decimals (about a centimetre), so compare to that.
ys = [y for _, y in rect]
check("the rectangle is 3.5 m either side of the line",
      abs(min(ys) + 3.5) < 0.01 and abs(max(ys) - 3.5) < 0.01, str(ys))
xs = [x for x, _ in rect]
check("and as long as the line", abs(max(xs) - min(xs) - 0.001 * frame.kx) < 0.01)
disc_pts = [frame.fwd(*c) for c in parts[1][0]]
r = [math.hypot(x, y) for x, y in disc_pts]
check("the end disc has the same radius", all(abs(v - 3.5) < 0.01 for v in r), str(r[:3]))
check("every part is a closed ring", all(p[0][0] == p[0][-1] for p in parts))
bent = buffer_line([[LON, LAT], [LON + 0.001, LAT], [LON + 0.001, LAT + 0.001]], 1.5, frame)
check("a bent line gets a disc at the bend, so the corner has no notch", len(bent) == 2 + 3)
check("a repeated point does not make a zero-length rectangle",
      len(buffer_line([[LON, LAT], [LON, LAT], [LON + 0.001, LAT]], 1, frame)) == 1 + 3)

# --- ring assembly ---
a, b, c, e = (0, 0), (1, 0), (1, 1), (0, 1)
rings = assemble_rings([[a, b, c], [a, e, c]])
check("two halves of a shore, one reversed, make one closed ring",
      len(rings) == 1 and rings[0][0] == rings[0][-1] and len(rings[0]) == 5, str(rings))
check("a shore that never closes is dropped, not guessed", assemble_rings([[a, b, c]]) == [])
check("point in ring", point_in_ring(0.5, 0.5, [a, b, c, e]) and not point_in_ring(2, 0.5, [a, b, c, e]))

# --- the whole Overpass answer ---
feats = parse_overpass(FIXTURE, frame)
by = {f["properties"]["source_id"]: f for f in feats}
check("exactly the seven good elements come back", sorted(by) ==
      ["relation/7", "way/1", "way/2", "way/3", "way/4", "way/5", "way/6"], str(sorted(by)))
check("classes are right", [by[k]["properties"]["class"] for k in
      ("way/1", "way/2", "way/3", "way/4", "way/5", "relation/7")] ==
      ["building", "pool", "road", "driveway", "sidewalk", "water"])
check("areas are Polygons, lines are buffered MultiPolygons",
      by["way/1"]["geometry"]["type"] == "Polygon" and by["way/3"]["geometry"]["type"] == "MultiPolygon")
check("every feature says where it came from",
      all(f["properties"]["source"] == "osm" for f in feats))
w6 = [frame.fwd(*p) for p in by["way/6"]["geometry"]["coordinates"][0][0]]
check("width=12 buffers 6 m either side", abs(max(y for _, y in w6) - min(y for _, y in w6) - 12) < 0.02)
pond = by["relation/7"]["geometry"]
check("the pond is one polygon with its island as a hole",
      pond["type"] == "Polygon" and len(pond["coordinates"]) == 2, str(pond)[:200])
check("the output is plain JSON", json.loads(json.dumps(feats)) == feats)
q = overpass_query(bbox_around(LON, LAT, 80))
check("the query asks for whole geometry, unclipped", q.endswith("out geom;") and "[out:json]" in q)

# --- NHD ---
nhd = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"PERMANENT_IDENTIFIER": "152708026", "FTYPE": 390, "FCODE": 39004},
     "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}},
    {"type": "Feature", "properties": {"PERMANENT_IDENTIFIER": "x", "FTYPE": 390, "FCODE": 39001},
     "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}},
    {"type": "Feature", "properties": {"PERMANENT_IDENTIFIER": "y", "FTYPE": 466, "FCODE": 46600},
     "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}},
]}
got = parse_nhd(nhd, {390, 436, 493})
check("NHD: a perennial pond is water; intermittent ponds and marsh are not",
      [f["properties"]["source_id"] for f in got] == ["152708026"]
      and got[0]["properties"] == {"class": "water", "source": "nhd", "source_id": "152708026"})

# --- Microsoft ---
check("quadkeys match the Microsoft index for both test points",
      quadkey(-85.6, 42.9) == "030222310" and quadkey(-97.0, 46.87) == "021330310")
def ms_row(lon, lat):
    return json.dumps({"type": "Feature", "properties": {"height": 4.7, "confidence": -1},
                       "geometry": {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat],
                                                                        [lon + d, lat + d], [lon, lat]]]}})


row_in, row_out = ms_row(LON, LAT), ms_row(-80.0, LAT)
ms = parse_msbf_lines(io.StringIO(row_out + "\n" + row_in + "\n\n"), bbox_around(LON, LAT, 80), "030222310")
check("MSBF: only rows in the box, id is tile and row",
      len(ms) == 1 and ms[0]["properties"]["source_id"] == "030222310:1", str(ms))
check("MSBF: a footprint already drawn in OSM is dropped",
      drop_duplicate_buildings(feats, ms) == [])
far = parse_msbf_lines(io.StringIO(ms_row(LON, LAT + 3*d)), bbox_around(LON, LAT, 80), "k")
check("MSBF: one OSM missed is kept", len(drop_duplicate_buildings(feats, far)) == 1)

print(f"\nAll {passed} checks passed.")
