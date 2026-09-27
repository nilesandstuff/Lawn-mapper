"""
Public "certainly not lawn" outlines for a lot: buildings, water, pools, roads,
driveways, parking, sidewalks and railways that somebody has already drawn.

A PROTOTYPE, not wired into anything. The idea (owner, 2026-09-27) is negative
training labels that cost nothing to draw -- but only after the owner has looked
at them and tweaked them, because every source below is wrong somewhere and a
confident wrong negative teaches the detector that a lawn is not a lawn.

    python3 tools/public_negatives.py -97.0 46.87 80
    python3 tools/public_negatives.py -85.6 42.9 80 --no-msbf --out=kent.geojson

Three sources, all free and keyless:

  osm   OpenStreetMap through the Overpass API. The only source with roads,
        driveways, parking, sidewalks and pools. ODbL: attribution required.
  nhd   USGS National Hydrography Dataset (large-scale waterbodies and river
        areas) from hydro.nationalmap.gov. Public domain.
  msbf  Microsoft's ML building footprints, one z9 quadkey tile at a time. Fills
        the rural gaps where nobody has traced the houses in OSM. ODbL.

Every feature comes out as a Polygon or MultiPolygon in lon/lat with
properties {class, source, source_id}. Features are returned WHOLE, not clipped
to the box: the owner reviews an outline, and half a house is harder to judge.

NO SHAPELY. It is not in tools/requirements.txt (torchgeo drags it in
transitively, which is not the same as being chosen), so lines are buffered
here by hand: each segment becomes a rectangle and each vertex a small disc,
all as separate parts of one MultiPolygon. The parts OVERLAP. That is harmless
for a mask -- fill each part and the union is what you get -- but it is not a
valid OGC geometry, and anything that fills a MultiPolygon as one even-odd path
would punch holes where parts cross. Fill part by part.

Tests, offline: python3 tools/public_negatives_test.py
"""

import gzip
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

UA = "lawn-mapper/0.1 (public negatives prototype)"

# Overpass mirrors, tried in order. The main instance is the one its operators
# prefer people use; the mail.ru mirror is there because a shared runner IP can
# be refused or rate limited (and overpass-api.de reset every connection from
# the sandbox this was written in, while mail.ru answered).
OVERPASS_URLS = [
    u for u in [os.environ.get("OVERPASS_URL")] if u
] + [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer"
MSBF_INDEX = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"

# HALF-widths in metres for things OSM draws as a centreline. DELIBERATELY
# NARROW. A US residential street is 8-11 m curb to curb, but the centreline is
# itself a couple of metres off in places and the verge beside it is very often
# mowed grass -- the one place a too-wide negative does real damage. A buffer
# that covers the middle of the pavement and stops short of the curb costs a
# little coverage; one that spills onto the terrace teaches "grass is road".
# A way's own width=* tag wins over these when present.
HIGHWAY_HALF_WIDTH = {
    # One OSM way per direction on divided roads, so these are one side's lanes.
    "motorway": 5.5, "trunk": 5.0, "primary": 5.0, "secondary": 4.5,
    "tertiary": 4.0,
    "motorway_link": 3.0, "trunk_link": 3.0, "primary_link": 3.0,
    "secondary_link": 3.0, "tertiary_link": 3.0,
    "residential": 3.5, "unclassified": 3.0, "living_street": 3.0,
    "road": 3.0, "busway": 3.0,
    "service": 2.0,
    "footway": 0.75, "pedestrian": 1.5, "cycleway": 1.0, "steps": 0.75,
}
SERVICE_HALF_WIDTH = {"driveway": 1.5, "parking_aisle": 2.5, "alley": 2.0,
                      "drive-through": 1.5}
RAIL_HALF_WIDTH = 2.0      # 1.44 m gauge plus sleepers and ballast
WATERWAY_HALF_WIDTH = {"river": 4.0, "canal": 3.0, "stream": 1.0}

# Not certain enough to call "not lawn". Paths and tracks are very often a worn
# line across grass; ditches and drains in the prairie counties are mowed
# swales; abandoned rail is a trail at best.
SKIP_HIGHWAY = {"path", "track", "bridleway", "proposed", "construction",
                "abandoned", "raceway", "corridor", "elevator", "platform",
                "bus_stop", "street_lamp", "crossing", "turning_circle"}
LIVE_RAIL = {"rail", "light_rail", "tram", "narrow_gauge", "subway", "monorail",
             "funicular", "preserved"}
# A surface tag that means the thing may well be grass or bare ground.
SOFT_SURFACE = {"grass", "grass_paver", "dirt", "earth", "ground", "mud",
                "sand", "woodchips", "soil"}


def classify(tags):
    """(class, half_width_m) for an OSM element's tags, or None to leave it
    out. half_width_m is None for things drawn as areas."""
    t = tags or {}
    # Underneath the ground something else is on top, and the top may be lawn.
    if t.get("tunnel") not in (None, "no") or t.get("location") in ("underground", "indoor"):
        return None
    if t.get("layer", "0").lstrip("-").isdigit() and int(t.get("layer", "0")) < 0 \
            and "building" in t:
        return None
    if t.get("surface") in SOFT_SURFACE:
        return None
    if t.get("intermittent") == "yes" or t.get("seasonal") == "yes":
        return None   # a dry detention basin is, most of the year, grass
    if t.get("building", "no") != "no":
        return ("building", None)
    if t.get("leisure") == "swimming_pool":
        return ("pool", None)
    if (t.get("natural") == "water" and t.get("water") != "basin") \
            or t.get("waterway") == "riverbank" or t.get("landuse") == "reservoir":
        return ("water", None)
    if t.get("waterway") in WATERWAY_HALF_WIDTH:
        return ("water", WATERWAY_HALF_WIDTH[t["waterway"]])
    if t.get("amenity") == "parking" and t.get("parking") != "underground":
        return ("parking", None)
    if "area:highway" in t:
        return ("road", None)
    hw = t.get("highway")
    if hw and hw not in SKIP_HIGHWAY and hw in HIGHWAY_HALF_WIDTH:
        area = t.get("area") == "yes"
        if hw in ("footway", "pedestrian", "cycleway", "steps"):
            cls = "sidewalk"
        elif hw == "service" and t.get("service") == "driveway":
            cls = "driveway"
        else:
            cls = "road"
        if area:
            return (cls, None)
        half = HIGHWAY_HALF_WIDTH[hw]
        if hw == "service":
            half = SERVICE_HALF_WIDTH.get(t.get("service"), half)
        w = tag_width_m(t.get("width"))
        return (cls, w / 2 if w else half)
    if t.get("railway") in LIVE_RAIL:
        return ("rail", RAIL_HALF_WIDTH)
    return None


def tag_width_m(v):
    """OSM width=* in metres: "7", "7.5 m", "24'", "24 ft". None if unreadable
    or implausible (someone's width=1000 is not a road)."""
    if not v:
        return None
    s = v.strip().lower().replace(",", ".")
    feet = s.endswith("'") or s.endswith("ft")
    s = s.rstrip("'").replace("ft", "").replace("m", "").strip()
    try:
        w = float(s) * (0.3048 if feet else 1.0)
    except ValueError:
        return None
    return w if 0.5 <= w <= 40 else None


# --- geometry, in a local metre frame -------------------------------------

class Local:
    """Equirectangular metres about a centre. At a few hundred metres the error
    is well under a centimetre, which is below anything the sources claim."""

    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110540.0

    def fwd(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def inv(self, x, y):
        return (round(self.lon0 + x / self.kx, 7), round(self.lat0 + y / self.ky, 7))


def disc(cx, cy, r, n=12):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def buffer_line(coords, half, frame):
    """A lon/lat polyline buffered by `half` metres, as MultiPolygon coordinates
    (overlapping parts; see the module note). Round joins and ends."""
    pts = [frame.fwd(*c) for c in coords]
    parts = []
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        d = math.hypot(x2 - x1, y2 - y1)
        if d == 0:
            continue
        nx, ny = -(y2 - y1) / d * half, (x2 - x1) / d * half
        parts.append([(x1 + nx, y1 + ny), (x2 + nx, y2 + ny), (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)])
    for x, y in pts:
        parts.append(disc(x, y, half))
    out = []
    for ring in parts:
        ll = [list(frame.inv(x, y)) for x, y in ring]
        out.append([ll + [ll[0]]])
    return out


def point_in_ring(x, y, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def ring_area(ring):
    """Signed shoelace area; the sign is all that is used, for orientation."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def assemble_rings(ways):
    """Join a relation's member ways end to end into closed rings. OSM splits a
    big lake's shore into many ways, and they need not point the same way.
    Anything that never closes is dropped rather than guessed at."""
    open_ = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while open_:
        cur = open_.pop(0)
        progress = True
        while cur[0] != cur[-1] and progress:
            progress = False
            for i, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                open_.pop(i)
                progress = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def polygon_from_rings(outers, inners):
    """GeoJSON geometry: each inner ring goes to the outer it sits in."""
    if not outers:
        return None
    polys = [[o] for o in outers]
    for r in inners:
        for p in polys:
            if point_in_ring(r[0][0], r[0][1], [tuple(c) for c in p[0][:-1]]):
                p.append(r)
                break
    if len(polys) == 1:
        return {"type": "Polygon", "coordinates": polys[0]}
    return {"type": "MultiPolygon", "coordinates": polys}


def feature(geom, cls, source, source_id):
    return {"type": "Feature", "geometry": geom,
            "properties": {"class": cls, "source": source, "source_id": str(source_id)}}


# --- OpenStreetMap ---------------------------------------------------------

def overpass_query(bbox):
    w, s, e, n = bbox
    b = f"({s},{w},{n},{e})"
    sel = [
        'nwr["building"]', 'nwr["natural"="water"]', 'nwr["waterway"="riverbank"]',
        'way["waterway"~"^(river|canal|stream)$"]', 'nwr["landuse"="reservoir"]',
        'nwr["leisure"="swimming_pool"]', 'way["highway"]', 'nwr["area:highway"]',
        'nwr["amenity"="parking"]', 'way["railway"]',
    ]
    # `out geom` with no bbox: a clipped way loses its closing node and a house
    # on the edge would come back as a line.
    return "[out:json][timeout:60];(" + "".join(f"{q}{b};" for q in sel) + ");out geom;"


def http(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_overpass(bbox, urls=None):
    q = urllib.parse.urlencode({"data": overpass_query(bbox)}).encode()
    errors = []
    for url in urls or OVERPASS_URLS:
        for attempt in range(2):
            try:
                return json.loads(http(url, q)), url
            except Exception as e:  # 429, 504, reset: next try, then next mirror
                errors.append(f"{url}: {e}")
                time.sleep(2 + 3 * attempt)
    raise RuntimeError("every Overpass mirror failed:\n  " + "\n  ".join(errors))


def parse_overpass(data, frame):
    """Overpass JSON (from `out geom`) -> features. Nodes are skipped: a pool or
    a house drawn as a point has no outline to lend."""
    out = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        c = classify(tags)
        if not c:
            continue
        cls, half = c
        sid = f"{el['type']}/{el['id']}"
        if el["type"] == "way":
            coords = [[p["lon"], p["lat"]] for p in el.get("geometry") or [] if p]
            if len(coords) < 2:
                continue
            closed = coords[0] == coords[-1] and len(coords) >= 4
            if half is None:
                if not closed:
                    continue   # an "area" that does not close is broken data
                out.append(feature({"type": "Polygon", "coordinates": [coords]}, cls, "osm", sid))
            else:
                out.append(feature({"type": "MultiPolygon",
                                    "coordinates": buffer_line(coords, half, frame)}, cls, "osm", sid))
        elif el["type"] == "relation":
            if tags.get("type") not in ("multipolygon", "building") or half is not None:
                continue
            ways = {"outer": [], "inner": []}
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("geometry"):
                    role = "inner" if m.get("role") == "inner" else "outer"
                    ways[role].append([[p["lon"], p["lat"]] for p in m["geometry"] if p])
            geom = polygon_from_rings(assemble_rings(ways["outer"]), assemble_rings(ways["inner"]))
            if geom:
                out.append(feature(geom, cls, "osm", sid))
    return out


# --- USGS NHD --------------------------------------------------------------

# Layer 12 is Waterbody (large scale), layer 9 is Area (large scale: rivers too
# wide to be a line). FType codes: 390 lake/pond, 436 reservoir, 493 estuary,
# 460 stream/river. LEFT OUT: 466 swamp/marsh (a wet meadow is green and flat
# and looks like lawn from above; not "certainly" anything), 361 playa, and the
# intermittent FCodes, which are grass or mud for much of the year.
NHD_LAYERS = {12: {390, 436, 493}, 9: {460}}
NHD_INTERMITTENT = {39001, 39005, 39006, 46003, 46007}


def fetch_nhd(bbox):
    w, s, e, n = bbox
    out = []
    for layer, ftypes in NHD_LAYERS.items():
        q = urllib.parse.urlencode({
            "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "outFields": "permanent_identifier,ftype,fcode", "returnGeometry": "true",
            "outSR": 4326, "f": "geojson"})
        data = json.loads(http(f"{NHD}/{layer}/query?{q}"))
        out += parse_nhd(data, ftypes)
    return out


def parse_nhd(data, ftypes):
    out = []
    for f in data.get("features", []):
        # The service returns field names in upper case whatever was asked for.
        p = {k.lower(): v for k, v in (f.get("properties") or {}).items()}
        if p.get("ftype") not in ftypes or p.get("fcode") in NHD_INTERMITTENT:
            continue
        if f.get("geometry"):
            out.append(feature(f["geometry"], "water", "nhd", p.get("permanent_identifier")))
    return out


# --- Microsoft building footprints ----------------------------------------

def quadkey(lon, lat, z=9):
    n = 2 ** z
    x = min(n - 1, int((lon + 180) / 360 * n))
    s = math.sin(math.radians(lat))
    y = min(n - 1, int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n))
    return "".join(str(((x >> i) & 1) + 2 * ((y >> i) & 1)) for i in range(z - 1, -1, -1))


def cache_dir():
    d = os.environ.get("PUBLIC_NEGATIVES_CACHE", os.path.expanduser("~/.cache/lawn-mapper/msbf"))
    os.makedirs(d, exist_ok=True)
    return d


def cached(url, name):
    """Download once. The index is ~7 MB and a US tile 5-120 MB, and a CI job
    working through many lots in one county would otherwise fetch the same
    tile for every one of them."""
    path = os.path.join(cache_dir(), name)
    if not os.path.exists(path):
        tmp = path + ".part"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(tmp, path)
    return path


def fetch_msbf(bbox):
    w, s, e, n = bbox
    keys = {quadkey(x, y) for x in (w, e) for y in (s, n)}
    urls = {}
    with open(cached(MSBF_INDEX, "dataset-links.csv")) as f:
        for line in f:
            parts = line.split(",")
            if len(parts) >= 3 and parts[0] == "UnitedStates" and parts[1] in keys:
                urls[parts[1]] = parts[2]
    out = []
    for k, url in sorted(urls.items()):
        with gzip.open(cached(url, f"us-{k}.geojsonl.gz"), "rt") as f:
            out += parse_msbf_lines(f, bbox, k)
    return out


def parse_msbf_lines(lines, bbox, key):
    """The tile's rows are in no spatial order, so every row is read; the
    bbox test on the first ring is what keeps it to a few seconds a tile.
    The rows carry no id, so the id is the tile and the row number."""
    w, s, e, n = bbox
    out = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        f = json.loads(line)
        ring = f["geometry"]["coordinates"][0]
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        if max(xs) < w or min(xs) > e or max(ys) < s or min(ys) > n:
            continue
        out.append(feature(f["geometry"], "building", "msbf", f"{key}:{i}"))
    return out


def centroid(geom):
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    pts = ring[:-1] or ring
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def drop_duplicate_buildings(osm, msbf):
    """MSBF only where OSM has no house: a Microsoft footprint whose centre sits
    inside an OSM building is the same house drawn twice, and OSM's is usually
    the hand-traced one."""
    rings = [[tuple(c) for c in f["geometry"]["coordinates"][0]]
             for f in osm if f["properties"]["class"] == "building"
             and f["geometry"]["type"] == "Polygon"]
    keep = []
    for f in msbf:
        x, y = centroid(f["geometry"])
        if not any(point_in_ring(x, y, r) for r in rings):
            keep.append(f)
    return keep


# --- together --------------------------------------------------------------

def bbox_around(lon, lat, radius_m):
    k = 111320.0 * math.cos(math.radians(lat))
    return (lon - radius_m / k, lat - radius_m / 110540.0,
            lon + radius_m / k, lat + radius_m / 110540.0)


def fetch_negatives(bbox_lonlat, sources=("osm", "nhd", "msbf"), log=None):
    """bbox (west, south, east, north) in degrees -> GeoJSON FeatureCollection.
    A source that fails is reported in the collection's "errors" and the rest
    still come back: no water from NHD is not a reason to lose the roads."""
    w, s, e, n = bbox_lonlat
    frame = Local((w + e) / 2, (s + n) / 2)
    feats, errors, osm = [], {}, []
    if "osm" in sources:
        try:
            data, url = fetch_overpass(bbox_lonlat)
            osm = parse_overpass(data, frame)
            feats += osm
            if log:
                log(f"osm: {len(osm)} features from {url}")
        except Exception as ex:
            errors["osm"] = str(ex)
    if "nhd" in sources:
        try:
            got = fetch_nhd(bbox_lonlat)
            feats += got
            if log:
                log(f"nhd: {len(got)} waterbodies")
        except Exception as ex:
            errors["nhd"] = str(ex)
    if "msbf" in sources:
        try:
            got = fetch_msbf(bbox_lonlat)
            kept = drop_duplicate_buildings(osm, got)
            feats += kept
            if log:
                log(f"msbf: {len(got)} footprints, {len(kept)} not already in OSM")
        except Exception as ex:
            errors["msbf"] = str(ex)
    fc = {"type": "FeatureCollection", "bbox": list(bbox_lonlat), "features": feats,
          "attribution": "Map data (c) OpenStreetMap contributors, ODbL; "
                         "USGS National Hydrography Dataset (public domain); "
                         "Microsoft Building Footprints, ODbL"}
    if errors:
        fc["errors"] = errors
    return fc


def summary(fc):
    counts = {}
    for f in fc["features"]:
        k = (f["properties"]["class"], f["properties"]["source"])
        counts[k] = counts.get(k, 0) + 1
    lines = [f"  {c:9s} {s:5s} {n}" for (c, s), n in sorted(counts.items())]
    for src, err in (fc.get("errors") or {}).items():
        lines.append(f"  ERROR {src}: {err.splitlines()[0][:200]}")
    return "\n".join(lines) or "  nothing"


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    lon, lat = float(args[0]), float(args[1])
    radius = float(args[2]) if len(args) > 2 else 80.0
    sources = ["osm", "nhd", "msbf"]
    for f in flags:
        if f.startswith("--no-"):
            sources.remove(f[5:])
    out = next((f.split("=", 1)[1] for f in flags if f.startswith("--out=")),
               f"negatives_{lon:.5f}_{lat:.5f}_{int(radius)}m.geojson")
    fc = fetch_negatives(bbox_around(lon, lat, radius), sources, log=print)
    with open(out, "w") as f:
        json.dump(fc, f)
    print(f"{len(fc['features'])} features within {radius:.0f} m of {lon},{lat}:")
    print(summary(fc))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
