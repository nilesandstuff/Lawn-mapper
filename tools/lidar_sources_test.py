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
    finally:
        srv.shutdown()
    print("download: the folder is made, seven ranges land in order, no half file left")


if __name__ == "__main__":
    check_datum_matches_the_shade_map()
    check_mercator_shift()
    check_units()
    check_one_read()
    check_ranged_download_makes_its_folder()
    print("lidar sources: ok")
