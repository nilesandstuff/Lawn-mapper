"""
The lidar's sources, offline (tools/lidar_sources.py): the datum move, the
tiles' units, the noise, and one read.

A datum move with its sign flipped, or z left in feet, does not fail: it
reads as "the trial made no difference" or "the trees are three times
taller", and either is a finding about the wrong thing.

    python3 tools/lidar_sources_test.py
"""

import math
import re

import numpy as np

import lidar_sources as t

# public/shade/datum.js's nad83Correction at these points (node, 2026-10-13).
JS = [
    (42.8622, -87.95621, 2017.3, -0.8434, 0.8986),
    (42.5, -71.1, 2021.4, -0.4628, 1.1470),
    (40.6, -75.5, 2019.2, -0.5321, 1.0342),
    (40.58577, -111.93092, 2013.5, -1.2473, 0.5182),
    (30.6, -96.3, 2018.5, -0.9927, 0.5296),
]

IL_WKT = ('COMPD_CS["NAD83(2011) / Illinois East (ftUS) + NAVD88 height (ftUS)",PROJCS["NAD83(2011) / Illinois East (ftUS)",'
          'GEOGCS["NAD83(2011)",DATUM["NAD83",SPHEROID["GRS 1980",6378137,298.257222101]],UNIT["Degree",0.0174532925199433]],'
          'PROJECTION["Transverse_Mercator"],UNIT["US Survey Foot",0.304800609601222]],'
          'VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988"],UNIT["US Survey Foot",0.304800609601222]]]')
UTM_WKT = ('COMPD_CS["NAD83(2011) / UTM zone 12N + NAVD88 height",PROJCS["NAD83(2011) / UTM zone 12N",GEOGCS["NAD83(2011)",'
           'UNIT["Degree",0.0174532925199433]],UNIT["metre",1]],VERT_CS["NAVD88 height",UNIT["metre",1]]]')


def check_datum_matches_the_shade_map():
    for lat, lng, ep, e, n in JS:
        pe, pn = t.nad83_correction(lat, lng, ep)
        assert abs(pe - e) < 0.002 and abs(pn - n) < 0.002, (lat, lng, pe, pn, e, n)
    print("datum: the Python port gives datum.js's move to 2 mm at five places")


def check_mercator_shift():
    lat, lng, ep = 42.8622, -87.95621, 2017.3
    dx, dy = t.mercator_shift(lat, lng, ep)
    e, n = t.nad83_correction(lat, lng, ep)
    k = 1 / math.cos(math.radians(lat))
    # Web Mercator stretches ground metres by 1/cos(lat), both ways (6378 km sphere against 6371 km).
    assert abs(dx - e * k * 6378137 / 6371000) < 0.005 and abs(dy - n * k * 6378137 / 6371000) < 0.01, (dx, dy, e * k, n * k)
    assert dx < 0 < dy, "the cloud moves west and north (S35)"
    print("mercator: the move in the cloud's own units, west and north")


def check_units():
    assert abs(t.vertical_factor(IL_WKT) - 0.3048006096) < 1e-9, "z in US survey feet"
    assert t.vertical_factor(UTM_WKT) == 1.0
    assert abs(t.vertical_factor(IL_WKT.split("VERT_CS")[0] + "]") - 0.3048006096) < 1e-9, "no vertical part: the horizontal unit"
    assert t.vertical_factor("") == 1.0
    print("units: feet are converted, metres left alone")


def check_one_read():
    box = [-9791000.0, 5291000.0, -9790900.0, 5291100.0]
    asked = {}

    def octree(b):
        asked["bbox"] = b
        # One just inside the west edge (moved out), one in the middle, one in
        # the margin east of the frame (moved in), and two noise points.
        xs = np.array([box[0] + 0.5, (box[0] + box[2]) / 2, box[2] + 1.0, (box[0] + box[2]) / 2, (box[0] + box[2]) / 2])
        cls = np.array([2.0, 1.0, 2.0, 18.0, 7.0])
        return np.column_stack([xs, np.full(5, (box[1] + box[3]) / 2), np.zeros(5), np.zeros(5), cls]), {"nodes": 3, "mb": 1.0}
    pts, info = t.read_points(octree, box, 2017.3)
    assert asked["bbox"][0] < box[0], "read a margin wider, so moved points still fill the frame"
    assert (pts[:, 0] >= box[0]).all() and (pts[:, 0] <= box[2]).all(), "cropped back to the frame"
    assert len(pts) == 2 and not np.isin(pts[:, 4], t.NOISE).any(), "the west point moved out, the margin one in, noise gone"
    assert info["shift_m"][0] < 0 < info["shift_m"][1] and info["points"] == 2 and info["nodes"] == 3
    # The lot's own ground move (LIDAR_SHIFTS, 2026-10-20): 1 m east and 0.5 m
    # south in ground metres, on top of the datum move, recorded as given.
    pts2, info2 = t.read_points(octree, box, 2017.3, extra_m=(1.0, -0.5))
    assert abs((info2["shift_m"][0] - info["shift_m"][0]) - 1.0) < 0.01 and abs((info2["shift_m"][1] - info["shift_m"][1]) + 0.5) < 0.01, (info["shift_m"], info2["shift_m"])
    assert info2["ground_shift_m"] == [1.0, -0.5] and "ground_shift_m" not in info
    mid = (box[0] + box[2]) / 2
    assert abs((pts2[pts2[:, 4] == 1.0][0, 0] - pts[pts[:, 4] == 1.0][0, 0]) * math.cos(math.radians(t.merc_to_lnglat(mid, (box[1] + box[3]) / 2)[1])) - 1.0) < 0.01, "the middle point moved 1 ground metre east"
    # Whatever a read returns must carry what lidar_frame.main() records
    # (the first CI run of the newest trial died on a missing "nodes").
    import inspect
    import lidar_frame
    wanted = set(re.findall(r'got\["(\w+)"\]', inspect.getsource(lidar_frame.main)))
    assert wanted <= set(info), f"main() reads {wanted}, a read gives {set(info)}"
    assert t.epoch_of({"epoch": 2021.05}) == 2021.05 and t.epoch_of({"year": 2016}) == 2016.5
    assert t.epoch_of({}) == t.epoch_of(None) == t.DEFAULT_EPOCH
    print("one read: wider, noise dropped, moved, cropped; the keys main() records; epochs from the plan")


def check_ranged_download_makes_its_folder():
    """fetch_ranged against a local server that answers HEAD and byte ranges,
    into a folder that does not exist yet (the release run of 2026-10-13 lost
    12 of 18 tile frames to exactly that)."""
    import http.server
    import tempfile
    import threading
    from pathlib import Path
    body = bytes(range(256)) * 400  # 102,400 bytes

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()

        def do_GET(self):
            a, b = self.headers["Range"].split("=")[1].split("-")
            chunk = body[int(a):int(b) + 1]
            self.send_response(206)
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "not" / "yet" / "tile.laz"
            got = t.fetch_ranged(f"http://127.0.0.1:{srv.server_port}/tile.laz", out, parts=7)
            assert got == out and out.read_bytes() == body, "every range in its place"
            assert not out.with_suffix(".part").exists()
            told = []
            every = t.PROGRESS_EVERY_S
            t.PROGRESS_EVERY_S = 0
            try:
                t.fetch_ranged(f"http://127.0.0.1:{srv.server_port}/tile.laz", Path(d) / "again.laz", parts=3,
                               progress=lambda done, size: told.append((done, size)))
            finally:
                t.PROGRESS_EVERY_S = every
            assert told[0] == (0, len(body)), f"told the size first: {told[:2]}"
            assert told[-1] == (len(body), len(body)), f"and the whole at the end: {told[-1]}"
            assert all(a[0] <= b[0] for a, b in zip(told, told[1:])), "never going backwards on a good download"
    finally:
        srv.shutdown()
    print("download: the folder is made, seven ranges land in order, no half file left, progress told")


def check_ranged_download_waits_and_resumes():
    """Run 271 (2026-10-29): rockyweb's 429s ended 6 of 20 tiles after seven
    tries, and a broken range began again from its first byte. A 429 is now
    waited out (no try spent) until patient_until, and a range cut short
    carries on from the byte it reached."""
    import http.server
    import tempfile
    import threading
    import time
    import urllib.error
    from pathlib import Path
    body = bytes(range(256)) * 1600  # 409,600 bytes
    asked = []
    state = {"refuse": 9, "cut": 1, "always": False}

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *a):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()

        def do_GET(self):
            a, b = self.headers["Range"].split("=")[1].split("-")
            asked.append(int(a))
            if state["always"] or state["refuse"] > 0:
                state["refuse"] -= 1
                self.send_response(429)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            chunk = body[int(a):int(b) + 1]
            self.send_response(206)
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            if state["cut"] > 0 and len(chunk) > 300000:
                state["cut"] -= 1
                self.wfile.write(chunk[:200000])  # the connection drops part way
                return
            self.wfile.write(chunk)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    keep = (t.RATE_WAIT_S, t.RANGE_STAGGER_S, t.ERROR_WAIT_S)
    t.RATE_WAIT_S, t.RANGE_STAGGER_S, t.ERROR_WAIT_S = 0.001, 0.0, 0.001
    url = f"http://127.0.0.1:{srv.server_port}/tile.laz"
    try:
        with tempfile.TemporaryDirectory() as d:
            out = t.fetch_ranged(url, Path(d) / "tile.laz", parts=1, patient_until=time.time() + 30)
            assert out.read_bytes() == body, "whole and in order after nine 429s and a break"
            assert asked.count(0) == 10, f"nine refusals did not spend the seven tries: {asked}"
            resumed = [a for a in asked if a != 0]
            assert resumed and 0 < resumed[0] <= 200000, f"carried on from the byte it reached: {asked}"
            state["always"] = True
            t0 = time.time()
            try:
                t.fetch_ranged(url, Path(d) / "never.laz", parts=1, patient_until=time.time() + 0.5)
                raise AssertionError("refused for ever, it should give up")
            except urllib.error.HTTPError as e:
                assert e.code == 429
            assert time.time() - t0 < 5, "and gives up at patient_until"
            assert not (Path(d) / "never.laz").exists()
    finally:
        t.RATE_WAIT_S, t.RANGE_STAGGER_S, t.ERROR_WAIT_S = keep
        srv.shutdown()
    print("download: 429s waited out without spending tries, a broken range carried on, given up at patient_until")


def check_raw_points_cache():
    """The raw points saved once are read back for the same key and re-read for another."""
    import tempfile
    from pathlib import Path
    calls = []
    pts0 = np.array([[0.0, 0.0, 10.0, 50.0, 2.0], [1.0, 1.0, 12.0, 60.0, 1.0]])

    def read_octree(wide):
        calls.append(wide)
        return pts0, {"nodes": 1, "mb": 0.1}
    bbox = (-10.0, -10.0, 10.0, 10.0)
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "deep" / "frame.npz"
        a, ia = t.read_points(read_octree, bbox, 2020.5, raw_cache=f, key="X|")
        assert f.exists() and ia["from_cache"] is False and len(calls) == 1, "saved on the first read"
        b, ib = t.read_points(read_octree, bbox, 2020.5, raw_cache=f, key="X|")
        assert ib["from_cache"] is True and len(calls) == 1, "the second read asks nothing"
        assert np.allclose(a, b) and ib["shift_m"] == ia["shift_m"], "and gives the same moved points"
        c, ic = t.read_points(read_octree, bbox, 2020.5, raw_cache=f, key="Y|")
        assert ic["from_cache"] is False and len(calls) == 2, "another flight's key reads afresh"
        _, i2 = t.read_points(read_octree, bbox, 2020.5, raw_cache=f, key="Y|", extra_m=(1.0, 0.0))
        assert i2["from_cache"] is True and i2["ground_shift_m"] == [1.0, 0.0], "a ground move applies on top of the cached raw points"
    print("raw points cache: saved once, read back by key, re-read for another flight, moves applied on top")


def _synthetic_tile(path, n=400, seed=1):
    """A LAZ tile in a state-plane CRS (US survey feet, as USGS delivers), with GPS time."""
    import laspy
    from laspy.vlrs.known import WktCoordinateSystemVlr
    rng = np.random.default_rng(seed)
    # Web Mercator points round a box, then into the tile's own CRS (Illinois East ftUS) via rasterio
    from rasterio.warp import transform
    mx = rng.uniform(-9_800_000, -9_799_800, n)
    my = rng.uniform(5_120_000, 5_120_200, n)
    crs = IL_WKT
    tx, ty = transform("EPSG:3857", crs, mx.tolist(), my.tolist())
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.array([np.floor(min(tx)), np.floor(min(ty)), 0.0])
    header.vlrs.append(WktCoordinateSystemVlr(IL_WKT))
    las = laspy.LasData(header)
    las.x, las.y = np.asarray(tx), np.asarray(ty)
    las.z = rng.uniform(600, 700, n)  # feet
    las.intensity = rng.integers(0, 5000, n).astype(np.uint16)
    las.return_number = rng.integers(1, 4, n).astype(np.uint8)
    las.number_of_returns = np.full(n, 3, dtype=np.uint8)
    las.classification = rng.choice([1, 2, 5, 6, 7], n).astype(np.uint8)
    las.gps_time = np.linspace(2.0e8, 2.0e8 + 60, n)
    las.write(str(path), do_compress=True)
    return mx, my


def check_tile_crop_for_the_pages():
    """crop_tiles_laz: the tiles' points inside the box, in Web Mercator metres, as a LAZ a page decodes; thinning keeps one a cell."""
    import io
    import tempfile
    from pathlib import Path
    import laspy
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_X_1_2.laz"
        mx, my = _synthetic_tile(tile)
        box = (-9_799_950.0, 5_120_050.0, -9_799_850.0, 5_120_150.0)
        inside = int(((mx >= box[0]) & (mx <= box[2]) & (my >= box[1]) & (my <= box[3])).sum())
        rec = t.tile_records(tile, box)
        assert abs(len(rec["x"]) - inside) <= 2, f"{len(rec['x'])} records for {inside} points inside"
        assert rec["gps"] is not None and rec["ret"].max() <= 3 and rec["nret"].min() == 3, "returns and time carried"
        assert 180 < float(np.median(rec["z"])) < 215, f"z in metres, not feet: median {np.median(rec['z']):.1f}"
        laz = t.crop_tiles_laz([tile], box)
        got = laspy.read(io.BytesIO(laz))
        assert len(got.points) == len(rec["x"]), "every record written"
        assert got.header.point_format.id == 6 and got.header.version.minor == 4, "LAS 1.4, point format 6, as an octree node"
        assert np.allclose(np.asarray(got.x), rec["x"], atol=0.011) and np.allclose(np.asarray(got.y), rec["y"], atol=0.011), "Web Mercator metres to the centimetre"
        assert np.allclose(np.asarray(got.gps_time), rec["gps"]), "the flight's clock kept (the pages read the season from it)"
        assert set(np.unique(np.asarray(got.classification))) <= {1, 2, 5, 6, 7}, "classes kept, noise included: the pages drop their own"
        thin = laspy.read(io.BytesIO(t.crop_tiles_laz([tile], box, spacing_m=10.0)))
        assert 0 < len(thin.points) < len(got.points), f"thinned: {len(thin.points)} of {len(got.points)}"
        empty = laspy.read(io.BytesIO(t.crop_tiles_laz([tile], (0.0, 0.0, 10.0, 10.0))))
        assert len(empty.points) == 0, "a box with nothing in it is an empty LAZ, not an error"
    print("tile crop for the pages: records in metres, LAZ 1.4 pf6 round trip, time and classes kept, thinning, empty box")


def check_areas_and_the_server_crop():
    """An address's area is cut once and found again by box; a crop read back
    gives the same points as the tile; read_points takes a server crop."""
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as d:
        url = "https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/X/LAZ/USGS_LPC_X_1_2.laz"
        tile = Path(d) / "USGS_LPC_X_1_2.laz"
        _synthetic_tile(tile, n=2000)
        area_box = (-9_799_990.0, 5_120_010.0, -9_799_810.0, 5_120_190.0)
        inner = (-9_799_950.0, 5_120_050.0, -9_799_850.0, 5_120_150.0)
        assert t.area_covering(d, [url], inner) is None, "nothing kept yet"
        a = t.write_area(d, [url], area_box)
        assert a.name.endswith(t.CROP_SUFFIX) and t.area_box_of(a) == [-9799990.0, 5120010.0, -9799810.0, 5120190.0], a.name
        assert t.area_covering(d, [url], inner) == a, "found for a box inside it"
        assert t.area_covering(d, [url.replace("1_2", "1_3")], inner) is None, "not for other tiles"
        assert t.area_covering(d, [url], (inner[0] - 100, inner[1], inner[2], inner[3])) is None, "not for a box reaching outside it"
        from_tile = t.tile_records(tile, inner)
        from_area = t.tile_records(a, inner)
        assert abs(len(from_area["x"]) - len(from_tile["x"])) <= 2, f"{len(from_area['x'])} from the area, {len(from_tile['x'])} from the tile"
        assert abs(float(np.median(from_area["z"])) - float(np.median(from_tile["z"]))) < 0.5, "z already metres in a crop, not scaled again"
        assert t.write_area(d, [url], area_box) == a, "a second ask finds the one kept"

        asked = []

        def crop(urls, box):
            asked.append(box)
            return t.write_area(d, urls, box)
        pts, info = t.read_points(lambda b: (_ for _ in ()).throw(AssertionError("no octree")), inner, 2020.5, tiles=[url], server_crop=crop)
        direct, _ = t.read_points(None, inner, 2020.5, tiles=[str(tile)])
        assert info.get("via") == "server" and len(asked) == 1, "tiles by URL go through the crop"
        assert abs(len(pts) - len(direct)) <= 2, f"{len(pts)} through the server, {len(direct)} from the tile"
    print("areas: cut once, found by box, read back in metres; read_points takes the server's crop")


def check_leaf_season():
    """Each point dated by its own GPS time, as the shade map dates it (S68)."""
    import calendar
    def adj(y, m, d):  # adjusted standard GPS time for a UTC day
        return calendar.timegm((y, m, d, 12, 0, 0)) - t.GPS_EPOCH_UNIX - 1e9
    summer = [adj(2023, 9, 16)] * 30 + [adj(2024, 8, 24)] * 30
    assert t.leaf_on_share(summer) == (1.0, 60), t.leaf_on_share(summer)
    winter = [adj(2018, 1, 14)] * 10 + [adj(2018, 5, 10)] * 10
    assert t.leaf_on_share(winter) == (0.0, 20), "1 November to 10 May is leaf-off"
    share, n = t.leaf_on_share([adj(2020, 5, 11)] * 3 + [adj(2020, 4, 30)])
    assert (share, n) == (0.75, 4), "11 May is in leaf"
    assert t.leaf_on_share([100.0, 5000.0]) == (None, 0), "time-of-week says nothing of the date"
    assert t.leaf_on_share(None) == (None, 0)
    raw = calendar.timegm((2010, 7, 1, 0, 0, 0)) - t.GPS_EPOCH_UNIX   # raw standard time, above 2001's count
    assert t.leaf_on_share([raw]) == (1.0, 1), "raw standard time read as such"
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_X_1_2.laz"
        _synthetic_tile(tile, n=500)                     # GPS 2.0e8: January 2018, leaf-off
        _, info = t.read_points(None, (-9_799_950.0, 5_120_050.0, -9_799_850.0, 5_120_150.0), 2020.5, tiles=[str(tile)])
        assert info["leafOnShare"] == 0.0 and info["dated"] > 0, info
    print("leaf season: points dated by their own GPS day, 1 November to 10 May leaf-off; a read says its share in leaf")


if __name__ == "__main__":
    check_datum_matches_the_shade_map()
    check_mercator_shift()
    check_units()
    check_one_read()
    check_ranged_download_makes_its_folder()
    check_ranged_download_waits_and_resumes()
    check_raw_points_cache()
    check_tile_crop_for_the_pages()
    check_areas_and_the_server_crop()
    check_leaf_season()
    print("lidar sources: ok")
