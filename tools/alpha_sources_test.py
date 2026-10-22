"""The tile stitch of alpha_sources (a press of a big lot, 2026-10-22).

    python3 alpha_sources_test.py
"""
import sys

from PIL import Image

sys.path.insert(0, ".")
from alpha_sources import stitch_tiles  # noqa: E402

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

print("alpha_sources: ok" if ok else "alpha_sources: FAILED")
sys.exit(0 if ok else 1)
