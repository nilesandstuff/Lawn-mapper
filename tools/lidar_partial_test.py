"""Checks for lidar_partial.py: a tile read in part gives exactly the points a whole read gives.

The fake tile is laid out as USGS's are (lidar_partial.py's header): points
in the order four flight lines flew them, north then south then north, each
line its own point source id, packed by LASzip into 50,000-point chunks.
Run: python3 tools/lidar_partial_test.py (needs laspy, lazrs, rasterio)."""
import http.server
import sys
import tempfile
import threading
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lidar_partial as p  # noqa: E402
import lidar_sources as s  # noqa: E402

# A UTM zone in metres, as most recent USGS projects are delivered.
UTM_WKT = ('PROJCS["NAD83(2011) / UTM zone 15N",GEOGCS["NAD83(2011)",DATUM["NAD83_National_Spatial_Reference_System_2011",'
           'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],'
           'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-93],'
           'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],'
           'UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","6344"]]')
X0, Y0 = 544000.0, 4028000.0   # the tile's south-west corner, 1 km a side


def flight_tile(path, per_line=1_200_000, lines=4, seed=3, cross=False):
    """A 1 km tile flown in `lines` north-south passes 350 m wide (overlapping), stored in flight order.
    1.2 million points a line makes each 50,000-point chunk about 40 m of it, as on USGS's tiles."""
    import laspy
    from laspy.vlrs.known import WktCoordinateSystemVlr
    rng = np.random.default_rng(seed)
    xs, ys, src, gps = [], [], [], []
    t = 3.0e8
    for i in range(lines):
        centre = X0 + 125 + i * 250
        y = np.sort(rng.uniform(0, 1000, per_line))
        if i % 2:
            y = y[::-1]
        x = centre + rng.uniform(-175, 175, per_line)
        keep = (x >= X0) & (x < X0 + 1000)
        xs.append(x[keep]); ys.append(Y0 + y[keep]); src.append(np.full(keep.sum(), 100 + i))
        gps.append(t + np.arange(keep.sum()) * 1e-4); t += 1000
    if cross:  # one short cross line at the end, east-west, a few chunks long
        n = 400_000
        x = X0 + np.sort(rng.uniform(0, 1000, n)); y = Y0 + 600 + rng.uniform(-150, 150, n)
        xs.append(x); ys.append(y); src.append(np.full(n, 900)); gps.append(t + np.arange(n) * 1e-4)
    x, y, sid, g = (np.concatenate(v) for v in (xs, ys, src, gps))
    n = len(x)
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.array([X0, Y0, 0.0])
    header.vlrs.append(WktCoordinateSystemVlr(UTM_WKT))
    las = laspy.LasData(header)
    las.x, las.y = x, y
    las.z = 200 + rng.uniform(0, 30, n)
    las.intensity = rng.integers(0, 5000, n).astype(np.uint16)
    las.return_number = rng.integers(1, 4, n).astype(np.uint8)
    las.number_of_returns = np.full(n, 3, dtype=np.uint8)
    las.classification = rng.choice([1, 2, 5, 6], n).astype(np.uint8)
    las.point_source_id = sid.astype(np.uint16)
    las.gps_time = g
    las.write(str(path), do_compress=True)
    return n


def crs_of_header(h):
    return s._tile_crs(types.SimpleNamespace(header=h))


def merc_box(cx, cy, half):
    """A Web Mercator box of about `half` ground metres each way round a UTM point."""
    from rasterio.warp import transform
    (mx,), (my,) = transform(UTM_WKT, "EPSG:3857", [cx], [cy])
    import math
    lat = math.degrees(2 * math.atan(math.exp(my / 6378137.0)) - math.pi / 2)
    k = 1 / math.cos(math.radians(lat))
    return (mx - half * k, my - half * k, mx + half * k, my + half * k)


def check_parts_match_the_whole():
    """Every box, small or large, anywhere on the tile: the same points, from part of the file."""
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_TEST_1.laz"
        n = flight_tile(tile)
        shares = []
        rng = np.random.default_rng(1)
        boxes = [(X0 + 500, Y0 + 500, 60), (X0 + 20, Y0 + 20, 40), (X0 + 990, Y0 + 980, 50),
                 (X0 + 250, Y0 + 500, 100), (X0 + 375, Y0 + 100, 30)]
        boxes += [(X0 + rng.uniform(0, 1000), Y0 + rng.uniform(0, 1000), rng.uniform(20, 150)) for _ in range(7)]
        for cx, cy, half in boxes:
            box = merc_box(cx, cy, half)
            whole = s.tile_records(tile, box)
            src = p.FileSource(tile)
            part = p.read_box(src, box, crs_of_header)
            same, words = p.same_records(part, whole)
            assert same, f"box round ({cx - X0:.0f}, {cy - Y0:.0f}) +-{half:.0f} m: {words}"
            assert len(whole["x"]) > 0, "each box has points"
            shares.append(part["stats"]["share"])
            assert part["stats"]["requests"] <= 12, f"{part['stats']['requests']} requests"
        small = [sh for (cx, cy, half), sh in zip(boxes, shares) if half <= 60]
        assert max(small) < 0.6, f"a small box read {max(small):.0%} of the tile"
        print(f"partial read: {len(boxes)} boxes, identical to the whole tile ({n:,} points); "
              f"share read {min(shares):.0%}-{max(shares):.0%}, small boxes at most {max(small):.0%}")


def check_a_short_cross_line():
    """A cross line too short to measure its swath is judged by the widest line's: still nothing missed."""
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_TEST_2.laz"
        flight_tile(tile, per_line=900_000, cross=True)
        for cx, cy in ((X0 + 300, Y0 + 600), (X0 + 800, Y0 + 640), (X0 + 500, Y0 + 300)):
            box = merc_box(cx, cy, 50)
            part = p.read_box(p.FileSource(tile), box, crs_of_header)
            same, words = p.same_records(part, s.tile_records(tile, box))
            assert same, f"with a cross line, box at ({cx - X0:.0f}, {cy - Y0:.0f}): {words}"
    print("partial read: a short cross line is read too")


def check_whole_box_is_refused():
    """A box over most of the tile is not worth it: Unsupported, so the caller fetches it whole."""
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_TEST_3.laz"
        flight_tile(tile, per_line=600_000)
        try:
            p.read_box(p.FileSource(tile), merc_box(X0 + 500, Y0 + 500, 600), crs_of_header)
            raise AssertionError("a box over the whole tile should be refused")
        except p.Unsupported as e:
            assert "of the tile" in str(e), str(e)
    print("partial read: a box over most of the tile is left to the whole download")


def check_selection_rules():
    """select_chunks on a line it can measure, and on lines it cannot."""
    a = np.arange(20, dtype=float)
    xs = np.concatenate([100 + 50 * np.sin(a * 2.1), 400 + 50 * np.sin(a * 1.7)])
    ys = np.concatenate([a * 25, 500 - a * 25])
    srcs = np.array([1] * 20 + [2] * 20)
    got, why = p.select_chunks(xs, ys, srcs, [80, 240, 120, 260])
    assert why is None and 9 in got and 10 in got and not any(k >= 20 for k in got), f"{got}"
    got, why = p.select_chunks(np.array([1.0, 2.0]), np.array([1.0, 2.0]), np.array([1, 2]), [0, 0, 5, 5])
    assert why and got == [0, 1], "no measurable line: everything, and a reason"
    assert p.runs_of([1, 2, 3, 6, 10, 11]) == [(1, 6), (10, 11)]
    assert p.runs_of([1, 2, 3, 6, 10, 11], gap=0) == [(1, 3), (6, 6), (10, 11)]
    print("chunk choice: a line's strip and its neighbours; unmeasurable lines read whole; runs merged")


class _Ranges(http.server.BaseHTTPRequestHandler):
    """Serves one file with single and multi-range answers, as nginx does; `multi` False ignores multi-range."""
    body = b""
    multi = True
    asked = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        spec = self.headers["Range"].split("=")[1]
        self.asked.append(spec)
        rs = [tuple(int(v) for v in part.split("-")) for part in spec.split(",")]
        size = len(self.body)
        if len(rs) == 1:
            a, b = rs[0]
            b = min(b, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
            self.send_header("Content-Length", str(b - a + 1))
            self.end_headers()
            self.wfile.write(self.body[a:b + 1])
            return
        if not self.multi:
            self.send_response(200)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            try:
                self.wfile.write(self.body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        out = b""
        for a, b in rs:
            out += (b"--XYZ\r\nContent-Type: application/octet-stream\r\n"
                    + f"Content-Range: bytes {a}-{b}/{size}\r\n\r\n".encode() + self.body[a:b + 1] + b"\r\n")
        out += b"--XYZ--\r\n"
        self.send_response(206)
        self.send_header("Content-Type", "multipart/byteranges; boundary=XYZ")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def check_over_http():
    """Through a web server: multi-range answers parsed, and a server without them refused cleanly."""
    with tempfile.TemporaryDirectory() as d:
        tile = Path(d) / "USGS_LPC_TEST_4.laz"
        flight_tile(tile, per_line=800_000)
        _Ranges.body = tile.read_bytes()
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Ranges)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/USGS_LPC_TEST_4.laz"
        try:
            box = merc_box(X0 + 600, Y0 + 300, 50)
            _Ranges.multi, _Ranges.asked = True, []
            part = p.read_box(p.HttpSource(url), box, crs_of_header)
            same, words = p.same_records(part, s.tile_records(tile, box))
            assert same, f"over http: {words}"
            assert any("," in a for a in _Ranges.asked), "the first points were asked for in one request"
            assert part["stats"]["bytesRead"] < 0.6 * len(_Ranges.body)
            _Ranges.multi = False
            try:
                p.read_box(p.HttpSource(url), box, crs_of_header)
                raise AssertionError("a server without multi-range should be refused")
            except p.Unsupported as e:
                assert "multi-range" in str(e), str(e)
        finally:
            srv.shutdown()
    print("over http: multi-range parsed, the same points; a server without it refused (the whole tile instead)")


def check_partial_area():
    """lidar_sources.write_partial_area over http: the same area, point for point, as one cut from the whole tile."""
    import laspy
    with tempfile.TemporaryDirectory() as d:
        whole_dir, part_dir = Path(d) / "whole", Path(d) / "part"
        whole_dir.mkdir(); part_dir.mkdir()
        tile = whole_dir / "USGS_LPC_TEST_5.laz"
        flight_tile(tile, per_line=800_000)
        _Ranges.body, _Ranges.multi = tile.read_bytes(), True
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Ranges)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/USGS_LPC_TEST_5.laz"
        try:
            box = merc_box(X0 + 420, Y0 + 610, 2)
            # This fake tile's lines overlap more than USGS's (four 350 m swaths in 1 km), so a smaller
            # square than the live one; the real tiles' shares are workflow 47's to measure.
            sq = s.square_round(box, 80)
            said = []
            assert s.write_partial_area(str(part_dir), [url], sq) is None or s.PARTIAL_ON, "switched off: nothing read"
            on, s.PARTIAL_ON = s.PARTIAL_ON, True
            try:
                a = s.write_partial_area(str(part_dir), [url], sq, say=said.append)
            finally:
                s.PARTIAL_ON = on
            b = s.write_area(str(whole_dir), [url], sq)
            assert a is not None and a.name == b.name, f"{a} against {b}"
            assert not (part_dir / tile.name).exists(), "the whole tile was not downloaded"
            def recs(path):
                las = laspy.read(str(path))
                return {"x": np.asarray(las.x), "y": np.asarray(las.y), "z": np.asarray(las.z), "intensity": np.asarray(las.intensity),
                        "ret": np.asarray(las.return_number), "nret": np.asarray(las.number_of_returns),
                        "cls": np.asarray(las.classification), "gps": np.asarray(las.gps_time)}
            same, words = p.same_records(recs(a), recs(b))
            assert same, f"partial area: {words}"
            assert s.area_covering(str(part_dir), [url], box) == a, "and found as an area"
            assert any("MB read" in w for w in said), said
        finally:
            srv.shutdown()
    print(f"partial area: a square round a lot, the same points as from the whole tile ({said[-1].split(': ', 1)[1]})")


def check_multipart_parsing():
    body = (b"--B\r\nContent-Range: bytes 0-3/100\r\n\r\nabcd\r\n--B\r\nContent-Range: bytes 10-11/100\r\n\r\nxy\r\n--B--\r\n")
    parts = p.parse_multipart(body, 'multipart/byteranges; boundary="B"')
    assert parts == {(0, 3): b"abcd", (10, 11): b"xy"}, parts
    assert p.pick_ranges(parts, [(1, 2), (10, 11)]) == [b"bc", b"xy"]
    try:
        p.pick_ranges(parts, [(5, 6)])
        raise AssertionError("a range not in the answer")
    except p.Unsupported:
        pass
    print("multipart: parts found by their ranges, merged parts cut, a missing one refused")


if __name__ == "__main__":
    check_multipart_parsing()
    check_selection_rules()
    check_parts_match_the_whole()
    check_a_short_cross_line()
    check_whole_box_is_refused()
    check_over_http()
    check_partial_area()
    print("lidar partial: ok")
