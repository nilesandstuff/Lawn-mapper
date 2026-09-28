"""
That labels land on the right patches, and answers on the right cells.

The failure this guards is the silent one again: a target grid shifted by
half a patch, or a cover applied the wrong way round, does not fail. It
trains the decoder on a picture out of register with its own labels and
reads as a disappointing result. So the checks below are exact.

    python3 tools/decoder_test.py
"""

import numpy as np

from decoder_grid import box_targets, onto_grid, patch_edges, to_photo


def check_edges():
    # 64 patches over a square grid that covers the photograph exactly.
    e = patch_edges(640, 64, 1.0)
    assert e[0] == 0 and abs(e[-1] - 640) < 1e-9 and abs(e[1] - 10) < 1e-9
    # A photograph 640 x 320 padded to a square: the grid covers twice the
    # height, so along y the 64 patches span 640 cells of a 320-cell label.
    e = patch_edges(320, 64, 2.0)
    assert abs(e[-1] - 640) < 1e-9
    assert abs(e[32] - 320) < 1e-9, "patch 32 should start exactly at the photo's bottom edge"


def check_box_means():
    # A label that is lawn on its top half, on a 640 x 320 photo padded to
    # square, read on 64 x 64 patches: patches 0-15 down are lawn (1.0),
    # 16-31 not (0.0), 32-63 are padding (inside 0).
    label = np.zeros((320, 640))
    label[:160, :] = 1.0
    mean, inside = box_targets(label, 64, 64, 1.0, 2.0)
    assert mean.shape == (64, 64)
    assert np.allclose(mean[:16], 1.0) and np.allclose(mean[16:32], 0.0)
    assert np.allclose(inside[:32], 1.0) and np.allclose(inside[32:], 0.0)
    assert np.allclose(mean[32:], 0.0)

    # A boundary that cuts a patch: lawn on the first 165 rows of a 320-row
    # label, 10 cells a patch, so patch row 16 (rows 160-170) is half lawn.
    label[:] = 0
    label[:165, :] = 1.0
    mean, _ = box_targets(label, 64, 64, 1.0, 2.0)
    assert np.allclose(mean[16], 0.5), mean[16, 0]
    assert np.allclose(mean[15], 1.0) and np.allclose(mean[17], 0.0)

    # A vertical boundary at a fractional cell count: a patch is 640/64 = 10
    # cells; lawn on the first 43 columns, so patch 4 (40-50) is 0.3 lawn.
    label[:] = 0
    label[:, :43] = 1.0
    mean, _ = box_targets(label, 64, 64, 1.0, 2.0)
    assert np.allclose(mean[:32, 4], 0.3), mean[0, 4]
    assert np.allclose(mean[:32, 3], 1.0) and np.allclose(mean[:32, 5], 0.0)

    # Patches that are not a whole number of cells: 15 cm cells, 1000 across,
    # 64 patches over cover 1.0 -> 15.625 cells a patch. The mean of a ramp
    # of cell values sits within a cell of the patch's own centre (a cell is
    # a step, not a slope, so it is not exact; the mass check below is).
    g, gh = 1000, 500
    ramp = np.tile(np.arange(g, dtype=np.float64) + 0.5, (gh, 1))
    mean, inside = box_targets(ramp, 64, 64, 1.0, 2.0)
    e = patch_edges(g, 64, 1.0)
    centres = (e[:-1] + e[1:]) / 2
    assert np.allclose(mean[:32], np.tile(centres, (32, 1)), atol=0.5), "box means of a ramp"
    assert np.allclose(inside[:32], 1.0)

    # Windowed cover that is not a clean ratio: 1000 cells, 72 patches over
    # cover 1.152 (as a 1000 px photo read in 896 px windows might give).
    # Total mass is conserved: sum(mean * area) == sum(label).
    label = (np.random.default_rng(3).random((gh, g)) > 0.6).astype(float)
    mean, inside = box_targets(label, 72, 36, 1.152, 1.152)
    ex = np.diff(patch_edges(g, 72, 1.152))
    ey = np.diff(patch_edges(gh, 36, 1.152))
    area = np.outer(ey, ex) * inside
    assert abs((mean * area).sum() - label.sum()) < 1e-6 * label.sum()


def check_to_photo():
    # A patch-grid ramp comes back as the same ramp on the label grid, read
    # at cell centres: cell x sits at patch (x + 0.5) / 10 - 0.5.
    grid = np.tile(np.arange(64, dtype=np.float32), (64, 1))
    out = to_photo(grid, 640, 320, 1.0, 2.0)
    assert out.shape == (320, 640)
    want = np.clip((np.arange(640) + 0.5) / 10 - 0.5, 0, 63)
    assert np.allclose(out[0], want, atol=1e-5)
    assert np.allclose(out[319], want, atol=1e-5)
    # And down the other axis, where only the top 32 patch rows are photo.
    grid = np.tile(np.arange(64, dtype=np.float32)[:, None], (1, 64))
    out = to_photo(grid, 640, 320, 1.0, 2.0)
    want = np.clip((np.arange(320) + 0.5) / 10 - 0.5, 0, 63)
    assert np.allclose(out[:, 0], want, atol=1e-5)
    assert out.max() < 32, "nothing from the padding rows should reach the photo"

    # Round trip: a smooth field averaged down and read back up is close.
    y, x = np.mgrid[0:320, 0:640]
    field = 0.5 + 0.5 * np.sin(x / 90.0) * np.cos(y / 70.0)
    mean, _ = box_targets(field, 64, 64, 1.0, 2.0)
    back = to_photo(mean, 640, 320, 1.0, 2.0)
    err = np.abs(back - field)[5:-5, 5:-5].mean()
    assert err < 0.01, err


def check_onto_grid():
    # The whole-lot grid (56 patches over 1.5x the photo) read at the block
    # grid's centres (150 patches over 1.2x): a field that is linear in the
    # PHOTOGRAPH's coordinate must come back as the same field, so both grids
    # describe the same ground at the same cell.
    p_in = (np.arange(56) + 0.5) * 1.5 / 56
    grid = np.tile(p_in[None, :, None], (40, 1, 3)).astype(np.float32)
    out = onto_grid(grid, 1.5, 1.0, 150, 90, 1.2, 1.0)
    assert out.shape == (90, 150, 3)
    p_out = (np.arange(150) + 0.5) * 1.2 / 150
    inner = (p_out > p_in[0]) & (p_out < p_in[-1])
    assert np.allclose(out[0, inner, 0], p_out[inner], atol=1e-5)
    assert np.allclose(out[:, :, 2], out[:, :, 0])
    # Same grid, same cover: unchanged.
    same = onto_grid(grid, 1.5, 1.0, 56, 40, 1.5, 1.0)
    assert np.allclose(same, grid, atol=1e-6)


check_edges()
check_box_means()
check_to_photo()
check_onto_grid()
print("decoder grid: ok")
