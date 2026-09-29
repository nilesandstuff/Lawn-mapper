"""
Moving between the label grid and the patch grid, exactly.

THE TWO GRIDS. The Node side rasterises the traced lawn on a grid of G x GH
cells over the photograph (15 cm a cell). The backbone returns one feature
vector per PATCH, on a grid that covers the photograph padded to a square (or,
in windowed mode, padded past its edge), so a patch grid is `gridW x gridH`
with `coverX = grid ground / photo ground` on each axis. The decoder trains
on the patch grid and answers on it, and the answer is scored on the label
grid; so labels go DOWN to patches here and answers come UP to labels.

DOWN IS AN AREA AVERAGE, NOT A NEAREST PIXEL. A patch is about 1.4 m of
ground and the label cell is 0.15 m, so a patch straddling a lawn edge is
partly lawn, and the target says how much (a number in 0..1) rather than
rounding it to whichever side its centre fell on. The average is exact: an
integral image of the label is bilinear inside each cell, so reading it at a
fractional coordinate is the true box sum, not an approximation of one.

UP IS BILINEAR, CENTRE TO CENTRE. A label cell's answer is read from the
patch grid at the patch coordinate of the cell's centre, between the four
nearest patches. Nearest-patch would draw a 1.4 m staircase around every
lawn and the tracer would report every step as a handle.

Pure numpy, so decoder_test.py can check both directions without torch.
"""

import numpy as np


def patch_edges(cells, patches, cover):
    """The label-grid coordinate of every patch boundary along one axis.

    Patch k runs from edges[k] to edges[k + 1] in label cells. The grid
    covers `cover` times the photograph, so a patch is cells * cover / patches
    cells wide, and the last patches may lie past the photograph entirely.
    """
    return np.arange(patches + 1, dtype=np.float64) * (cells * cover / patches)


def _integral_at(S, xs, ys):
    """The integral image S (h+1, w+1) read at fractional (xs, ys), exactly."""
    h, w = S.shape[0] - 1, S.shape[1] - 1
    ix = np.clip(np.floor(xs).astype(int), 0, max(w - 1, 0))
    iy = np.clip(np.floor(ys).astype(int), 0, max(h - 1, 0))
    fx = np.clip(xs - ix, 0.0, 1.0)
    fy = np.clip(ys - iy, 0.0, 1.0)
    fx2, fy2 = np.meshgrid(fx, fy)
    return ((1 - fy2) * (1 - fx2) * S[iy][:, ix]
            + (1 - fy2) * fx2 * S[iy][:, ix + 1]
            + fy2 * (1 - fx2) * S[iy + 1][:, ix]
            + fy2 * fx2 * S[iy + 1][:, ix + 1])


def box_targets(label, grid_w, grid_h, cover_x, cover_y):
    """Each patch's mean of `label` (GH x G, floats) over the photograph it covers.

    Returns (mean, inside): `mean` is the label averaged over the part of the
    patch that lies on the photograph, and `inside` is how much of the patch
    that is (0..1). A patch wholly in the padding has inside 0 and mean 0.
    """
    label = np.asarray(label, dtype=np.float64)
    gh, g = label.shape
    S = np.zeros((gh + 1, g + 1), dtype=np.float64)
    S[1:, 1:] = label.cumsum(axis=0).cumsum(axis=1)

    ex = patch_edges(g, grid_w, cover_x)
    ey = patch_edges(gh, grid_h, cover_y)
    cx = np.clip(ex, 0, g)
    cy = np.clip(ey, 0, gh)

    at = _integral_at(S, cx, cy)
    box = at[1:, 1:] - at[:-1, 1:] - at[1:, :-1] + at[:-1, :-1]

    wx = np.diff(cx)
    wy = np.diff(cy)
    area = np.outer(wy, wx)
    full = np.outer(np.diff(ey), np.diff(ex))
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(area > 0, box / np.where(area > 0, area, 1), 0.0)
    inside = area / full
    return mean.astype(np.float32), inside.astype(np.float32)


def photo_coords(cells, patches, cover):
    """The patch coordinate to_photo reads each label cell's centre at, clamped
    to the grid: cell x sits at patch (x + 0.5) * patches / (cells * cover) - 0.5.
    The edge refiner (edge_refine.py) reads the decoder at these same points."""
    u = (np.arange(cells) + 0.5) * (patches / (cells * cover)) - 0.5
    return np.clip(u, 0, patches - 1)


def _lerp_axis(arr, n_out, cover, axis, cover_out=1.0):
    """Bilinear resample along one axis: label cell centres read off patches.

    `cover` is how far past the photograph the INPUT grid runs; `cover_out`
    the same for the output (1 for label cells, which are the photograph).
    """
    n_in = arr.shape[axis]
    # Output cell x has its centre at (x + 0.5) * cover_out / n_out of the
    # photograph; input patch k has its centre at (k + 0.5) * cover / n_in.
    u = (np.arange(n_out) + 0.5) * (cover_out * n_in / (n_out * cover)) - 0.5
    u = np.clip(u, 0, n_in - 1)
    i0 = np.floor(u).astype(int)
    i1 = np.minimum(i0 + 1, n_in - 1)
    f = (u - i0).astype(arr.dtype)
    a = np.take(arr, i0, axis=axis)
    b = np.take(arr, i1, axis=axis)
    shape = [1] * arr.ndim
    shape[axis] = n_out
    f = f.reshape(shape)
    return a * (1 - f) + b * f


def to_photo(grid, cells_w, cells_h, cover_x, cover_y):
    """A (gridH x gridW) patch-grid answer, resampled to (GH x G) label cells."""
    grid = np.asarray(grid, dtype=np.float32)
    out = _lerp_axis(grid, cells_w, cover_x, axis=1)
    out = _lerp_axis(out, cells_h, cover_y, axis=0)
    return out


def onto_grid(grid, cover_x, cover_y, out_w, out_h, out_cover_x, out_cover_y):
    """A (H x W x C) patch grid resampled onto another patch grid of the SAME
    photograph -- the whole-lot pass read at the 6 cm blocks' cell centres, for
    the both-scales decoder. Each grid's cover says how far past the
    photograph it runs; past the edge the nearest patch is repeated."""
    grid = np.asarray(grid, dtype=np.float32)
    out = _lerp_axis(grid, out_w, cover_x, axis=1, cover_out=out_cover_x)
    out = _lerp_axis(out, out_h, cover_y, axis=0, cover_out=out_cover_y)
    return np.ascontiguousarray(out)
