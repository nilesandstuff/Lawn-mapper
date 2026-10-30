"""The tile stitch of alpha_sources (a press of a big lot, 2026-10-22).

    python3 alpha_sources_test.py
"""
import os
import sys

from PIL import Image

sys.path.insert(0, ".")
from alpha_sources import stitch_tiles, fetch_photo, _looks_like_image  # noqa: E402
import io  # noqa: E402

ok = True


def check(name, cond):
    global ok
    print(f"{'PASS' if cond else 'FAIL'}  {name}")
    ok = ok and cond


tiles = []
for row in range(2):
    for col in range(3):
        img = Image.new("RGB", (4, 2), (col * 50, row * 100, 7))
        tiles.append((col, row, img))
out = stitch_tiles(tiles, 3, 2)
check("the stitched picture is cols x px by rows x py", out.size == (12, 4))
check("each tile lands at (col * px, row * py)",
      out.getpixel((0, 0)) == (0, 0, 7) and out.getpixel((11, 3)) == (100, 100, 7) and out.getpixel((5, 1)) == (50, 0, 7))
check("the order of the tiles does not matter", stitch_tiles(list(reversed(tiles)), 3, 2).tobytes() == out.tobytes())

try:
    stitch_tiles([(0, 0, Image.new("RGB", (4, 2))), (1, 0, Image.new("RGB", (3, 2)))], 2, 1)
    check("a tile of another size is refused", False)
except ValueError as e:
    check("a tile of another size is refused", "3x2" in str(e))
try:
    stitch_tiles([(0, 0, Image.new("RGB", (4, 2))), (2, 0, Image.new("RGB", (4, 2)))], 2, 1)
    check("a tile outside the grid is refused", False)
except ValueError:
    check("a tile outside the grid is refused", True)


# fetch_photo: retried, and a plain error (Kent County, 2026-10-23)
png = io.BytesIO(); Image.new("RGB", (2, 2)).save(png, format="PNG"); png = png.getvalue()


class Answer:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return self.data


def opener_of(answers):
    calls = []
    def opener(req, timeout=60):
        calls.append(req.full_url)
        a = answers[min(len(calls), len(answers)) - 1]
        if isinstance(a, Exception):
            raise a
        return Answer(a)
    return opener, calls


op, calls = opener_of([b"<html>busy</html>", TimeoutError("slow"), png])
check("an error page and a timeout are tried again, and the picture kept", fetch_photo("http://x/p", pause_s=0, opener=op) == png and len(calls) == 3)
op, calls = opener_of([b'{"error":{"code":500}}'])
try:
    fetch_photo("http://x/p", tries=2, pause_s=0, opener=op)
    check("three failures end in a plain error naming what came back", False)
except RuntimeError as e:
    check("three failures end in a plain error naming what came back", "not a picture" in str(e) and "error" in str(e) and len(calls) == 2)
check("a PNG and a JPEG look like pictures, an error page does not",
      _looks_like_image(png) and _looks_like_image(b"\xff\xd8\xff\xe0rest") and not _looks_like_image(b"<html>"))

# THE TILES AND THE ADDRESS'S AREA (2026-10-29): a press waits on the fetch the
# warm-up started instead of downloading again, and reads the kept area when it
# holds the frame.
def _tiles_and_area():
    import tempfile
    from pathlib import Path
    import alpha_sources
    import lidar_frame
    import lidar_sources
    import naip_bands
    import lidar_sources_test as lt
    read, asked = [], []
    real_for, real_naip = lidar_frame.lidar_for, naip_bands.naip_for
    lidar_frame.lidar_for = lambda url, bbox, epoch=None, tiles=None: read.append(list(tiles or [])) or None
    naip_bands.naip_for = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no NAIP in a test"))
    try:
        with tempfile.TemporaryDirectory() as d:
            os.environ["LIDAR_TILE_DIR"] = d
            url = "https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/X/LAZ/USGS_LPC_X_1_2.laz"
            prep = {"bbox": [-9_799_950.0, 5_120_050.0, -9_799_850.0, 5_120_150.0], "lidarTiles": [url], "lidarTilesMb": 1}

            def fetch(urls, say):
                asked.append(list(urls))
                return list(urls)                       # still being fetched elsewhere: not there yet
            out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep, tile_fetch=fetch)
            check("a missing tile goes to the shared fetch, not a second download", asked == [[url]])
            check("and the press reads on without it, saying so", out["rec"].get("tilesPending") == [url] and not read)

            # ONLY THE PART UNDER THE LOT (2026-10-30): asked first, read when it comes, the whole tile left pending.
            parted = []
            part_file = str(Path(d) / "part.3857.laz")
            out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep, tile_fetch=fetch,
                                               area_fetch=lambda tiles, box, say: parted.append((list(tiles), box)) or part_file)
            check("a missing tile's part under the frame is asked for first, with the frame grown 5 m",
                  parted and parted[0][0] == [url] and abs(parted[0][1][0] - (prep["bbox"][0] - 5)) < 1e-6)
            check("and read, without waiting on the whole tile",
                  read and read[-1] == [part_file] and len(asked) == 1 and out["rec"].get("tilesPart")
                  and out["rec"].get("lidarSource") == "area" and out["rec"].get("tilesPending") == [url])
            read.clear()
            out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep, tile_fetch=fetch,
                                               area_fetch=lambda tiles, box, say: None)
            check("a part that cannot be read leaves the press to the whole tile, as before",
                  len(asked) == 2 and not read and out["rec"].get("tilesPending") == [url] and not out["rec"].get("tilesPart"))

            lt._synthetic_tile(Path(d) / "USGS_LPC_X_1_2.laz", n=2000)
            alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep, tile_fetch=fetch)
            check("a tile on the volume is read whole when no area holds the frame", read[-1] == [str(Path(d) / "USGS_LPC_X_1_2.laz")])

            area = lidar_sources.write_area(d, [url], (-9_799_990.0, 5_120_010.0, -9_799_810.0, 5_120_190.0))
            out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep, tile_fetch=fetch)
            check("the address's area is read when it holds the frame", read[-1] == [str(area)] and out["rec"].get("lidarSource") == "area")
    finally:
        lidar_frame.lidar_for, naip_bands.naip_for = real_for, real_naip
        os.environ.pop("LIDAR_TILE_DIR", None)


# The lidar reader (laspy) is installed later in workflow 14 than the window
# check that first runs this file; the second run, beside lidar_test.py, has it.
try:
    import laspy  # noqa: F401
    _tiles_and_area()
except ImportError:
    print("SKIP  tiles and areas: no laspy here (workflow 14 runs this file again once the lidar reader is in)")


# NAIP BESIDE THE LIDAR, AND SKIPPED WHEN LATE (owner, 2026-10-29).
def _naip_beside_lidar():
    import time as _t
    import alpha_sources
    import lidar_frame
    import naip_bands
    real_for, real_naip, real_wait = lidar_frame.lidar_for, naip_bands.naip_for, alpha_sources.NAIP_WAIT_S
    try:
        lidar_frame.lidar_for = lambda *a, **k: _t.sleep(0.4)
        prep = {"bbox": [0.0, 0.0, 100.0, 100.0], "lidarUrl": "https://x/ept.json"}
        import numpy as _np

        def quick(*a, **k):
            _t.sleep(0.4)
            return _np.zeros((4, 4, 3), dtype=_np.uint8), {}
        naip_bands.naip_for = quick
        t0 = _t.time()
        out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep)
        took = _t.time() - t0
        check("NAIP is read while the lidar is, not after it", out["naip"] is not None and took < 0.75)

        def slow(*a, **k):
            _t.sleep(2.0)
            return _np.zeros((4, 4, 3), dtype=_np.uint8), {}
        naip_bands.naip_for = slow
        alpha_sources.NAIP_WAIT_S = 0.6
        t0 = _t.time()
        out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep)
        took = _t.time() - t0
        check("a NAIP that does not answer in time is skipped, and the press goes on", out["naip"] is None and out["rec"].get("naipSkipped") and took < 1.2)

        def refused(*a, **k):
            raise OSError("timed out")
        naip_bands.naip_for = refused
        out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), prep)
        check("and one that fails is skipped the same way", out["naip"] is None and out["rec"].get("naipSkipped"))
    finally:
        lidar_frame.lidar_for, naip_bands.naip_for, alpha_sources.NAIP_WAIT_S = real_for, real_naip, real_wait


_naip_beside_lidar()


# A LEAF-ON READ IS FLAGGED (S68); a leaf-off or undated one is not.
def _leaf_flag():
    import alpha_sources
    import lidar_frame
    import naip_bands
    real_for, real_naip = lidar_frame.lidar_for, naip_bands.naip_for
    naip_bands.naip_for = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no NAIP in a test"))
    z = lambda: __import__("numpy").zeros((4, 4))  # noqa: E731
    try:
        for share, want in ((0.9, True), (0.1, None), (float("nan"), None)):
            layers = {"height": z(), "n_ground": z(), "n_all": z(), "intensity": z(), "leaf_on_share": __import__("numpy").array(share)}
            masks = {"roof": z().astype(bool), "void": z().astype(bool)}
            lidar_frame.lidar_for = lambda *a, **k: (layers, masks)
            out = alpha_sources.gather_sources(Image.new("RGB", (8, 8)), {"bbox": [0.0, 0.0, 10.0, 10.0], "lidarUrl": "https://x/ept.json"})
            check(f"a read {share} in leaf is {'flagged' if want else 'not flagged'} leaf-on", out["rec"].get("lidarLeafOn") is want and out["lidar"] is not None)
    finally:
        lidar_frame.lidar_for, naip_bands.naip_for = real_for, real_naip


_leaf_flag()

print("alpha_sources: ok" if ok else "alpha_sources: FAILED")
sys.exit(0 if ok else 1)

