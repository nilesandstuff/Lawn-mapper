"""
The lidar trials' arithmetic, offline (tools/lidar_trial.py).

A datum move with its sign flipped, or z left in feet, does not fail: it
reads as "the trial made no difference" or "the trees are three times
taller", and either is a finding about the wrong thing.

    python3 tools/lidar_trial_test.py
"""

import math

import numpy as np

import lidar_trial as t

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


def check_reader_swap():
    import lidar_frame
    keep = lidar_frame.points_over
    try:
        seen = {}

        def fake(base, bbox, limit_nodes=400):
            seen["bbox"] = bbox
            # One just inside the west edge (moved out), one in the middle, one in
            # the margin east of the frame (moved in) -- the reason to read wider.
            xs = np.array([box[0] + 0.5, (box[0] + box[2]) / 2, box[2] + 1.0])
            return np.column_stack([xs, np.full(3, (bbox[1] + bbox[3]) / 2), np.zeros(3), np.zeros(3), np.full(3, 2.0)]), {}
        lidar_frame.points_over = fake
        box = [-9791000.0, 5291000.0, -9790900.0, 5291100.0]
        plan = {"a": {"url": "https://x/ept.json", "epoch": 2017.3, "box": box}}
        t.install(plan, "datum", "/tmp")
        pts, got = lidar_frame.points_over("https://x", box)
        assert seen["bbox"][0] < box[0], "read a margin wider, so moved points still fill the frame"
        assert (pts[:, 0] >= box[0]).all() and (pts[:, 0] <= box[2]).all(), "cropped back to the frame"
        assert len(pts) == 2, "the point pushed past the west edge is dropped, the one from the margin comes in"
        assert got["shift_m"][0] < 0 < got["shift_m"][1]
        lidar_frame.points_over = fake
        t.install(plan, "newest", "/tmp")
        pts, _ = lidar_frame.points_over("https://x", box)
        assert seen["bbox"] == box and len(pts) == 3, "newest leaves an octree read alone"
        noisy = np.array([[0, 0, 0, 0, 2.0], [0, 0, 50, 0, 18.0], [0, 0, -9, 0, 7.0], [0, 0, 9, 0, 1.0]])
        assert t.drop_noise(noisy)[:, 4].tolist() == [2.0, 1.0], "noise classes 7 and 18 dropped"
    finally:
        lidar_frame.points_over = keep
    print("reader: datum reads wider, moves, crops; newest leaves octrees in place and drops noise")


if __name__ == "__main__":
    check_datum_matches_the_shade_map()
    check_mercator_shift()
    check_units()
    check_reader_swap()
    print("lidar trials: ok")
