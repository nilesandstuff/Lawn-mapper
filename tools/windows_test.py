"""
That a windowed read puts every patch where the photograph had it.

The bug this guards is the quiet one: a stitch that is off by a patch, or
that keeps a window's margin instead of its core, does not fail. It produces a
feature grid that describes ground slightly away from where it is used, and
the head trains on a picture subtly out of register with its own labels --
which reads as a disappointing result rather than a bug.

So the photograph here IS its own coordinates: the red channel is x / w and
the green is y / h, and the fake eye reports each patch's mean colour. After
stitching, every kept patch must report the coordinates of the patch it is
supposed to describe, in the photograph's own pixels, through every window
boundary. Any off-by-one, any kept margin, any dropped row, shows up as a
wrong number.

    python3 tools/windows_test.py
"""

import numpy as np

from windows import padded_side_metres, window_plan, windowed


def coords(w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.stack([x / w, y / h, np.zeros_like(x)], axis=-1)


def mean_eye(patch):
    def look(win):
        s = win.shape[0] // patch
        return win.reshape(s, patch, s, patch, 3).mean(axis=(1, 3))
    return look


def check_registration(w, h, size, patch):
    arr = coords(w, h)
    grid, (cx, cy), windows = windowed(arr, size, patch, mean_eye(patch))
    margin, core, nx, ny = window_plan(w, h, size, patch)

    assert grid.shape[0] == ny * (core // patch), grid.shape
    assert grid.shape[1] == nx * (core // patch), grid.shape
    assert windows == nx * ny
    assert abs(cx - nx * core / w) < 1e-9 and abs(cy - ny * core / h) < 1e-9

    # Every patch wholly inside the photograph reports its own centre.
    for gy in range(grid.shape[0]):
        for gx in range(grid.shape[1]):
            if (gx + 1) * patch > w or (gy + 1) * patch > h:
                continue  # in the padding: reflected context, not an answer
            want_x = (gx * patch + (patch - 1) / 2) / w
            want_y = (gy * patch + (patch - 1) / 2) / h
            got_x, got_y = grid[gy, gx, 0], grid[gy, gx, 1]
            assert abs(got_x - want_x) < 1e-5, (
                f"{w}x{h} at {size}: patch ({gx},{gy}) reports x={got_x:.4f}, "
                f"the photograph has {want_x:.4f} there")
            assert abs(got_y - want_y) < 1e-5, (
                f"{w}x{h} at {size}: patch ({gx},{gy}) reports y={got_y:.4f}, "
                f"the photograph has {want_y:.4f} there")

    # And the consumer's mapping lands a photograph pixel on its own patch:
    # column = (x / w) * gridW / coverX.
    for x in [0, patch, w // 2, w - 1]:
        col = (x / w) * grid.shape[1] / cx
        assert abs(col - x / patch) < 1e-9, (x, col)


# The real shapes: 896 windows of 16 px patches over the sizes the corpus
# holds after the 10 cm re-bank, plus the other window sizes on offer.
for w, h, size in [(1300, 1300, 896), (1720, 1720, 896), (3192, 3192, 896),
                   (1720, 1720, 1280), (1300, 1300, 672), (1000, 1000, 448)]:
    check_registration(w, h, size, 16)

# Not square, and smaller than one window in one direction.
check_registration(1500, 700, 896, 16)

# A tiny picture, where reflection padding would be wider than the picture.
check_registration(200, 200, 128, 16)

# The margins are what the plan says they are.
assert window_plan(1720, 1720, 896, 16)[:2] == (112, 672)
assert window_plan(1720, 1720, 1280, 16)[:2] == (160, 960)
assert window_plan(1720, 1720, 672, 16)[:2] == (80, 512)
assert window_plan(1720, 1720, 448, 16)[:2] == (48, 352)
# A patch that is kept always had a margin's worth of real picture around it.
assert window_plan(1720, 1720, 896, 16)[0] >= 7 * 16

# THE SCALE OF A PADDED RECTANGLE. The extractor pads a rectangle to a square
# and tells a scale-aware model the metres a pixel covers, from the metres
# ACROSS the photograph. On a wide lot the square's side is the width, so the
# scale is unchanged; on a tall one it is the height. max(cover) got the wide
# case wrong by the aspect ratio (run 35927228827: 98 cm/px for a 34 cm lot).
wide_cover = (3004 / 3004, 3004 / 1028)      # 319 m across, 109 m down
assert abs(padded_side_metres(319.0, wide_cover) - 319.0) < 1e-9
tall_cover = (1520 / 544, 1520 / 1520)       # 54 m across, 152 m down
assert abs(padded_side_metres(54.4, tall_cover) - 152.0) < 1e-6
assert padded_side_metres(80.0, (1.0, 1.0)) == 80.0

print("windows: ok")
