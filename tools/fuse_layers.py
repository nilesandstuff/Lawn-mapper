"""
THE FUSED-INPUTS TEST (S11): what the lidar, NAIP's near-infrared and the
tree model say about each patch, as extra numbers beside the eye's 1024.

The owner's question, 2026-09-26: rather than hand-written rules over each
source (the lidar veto, stage 3's woods logic), give the detector every
source and let it learn how to use them. The literature says height is the
input that separates grass from trees and shrubs (ISPRS Vaihingen/Potsdam,
Audebert et al. 2018; the Chesapeake 1 m land cover with its turf-grass class
is built on NAIP + lidar height), and NIR sees vegetation through shadow.

WHAT IT CAN AND CANNOT TEACH. The decoder is trained on ground somebody could
see (H17), so these inputs can fix what the camera sees wrongly -- roofs,
water, shrubs and sheds in the open, grass in shadow -- and cannot teach it
what lies under a canopy. Stage 3 keeps that job.

Every layer is a raster over the photograph's extent (the lidar's 2 m grid,
NAIP at about 1 m, the tree model's mask at photo pixels) and goes down to
the patch grid by the same exact area average as the labels (box_targets).
A lot with no point cloud or no NAIP gets zeros and a 0 flag, which is also
what modality dropout shows the decoder in training, so a missing source is
something it has seen rather than something it meets for the first time.

Pure numpy; tests in fuse_test.py.
"""

import numpy as np

from decoder_grid import box_targets

# Channel order, and which ones one source owns (for modality dropout).
CHANNELS = ("height", "ground_share", "returns", "has_lidar", "ndvi", "has_ndvi", "canopy")
LIDAR = (0, 1, 2, 3)
NAIP = (4, 5)
# FIRST RETURNS AGAINST LATER ONES (owner, 2026-10-05; H73): appended after
# CHANNELS when the run brings tools/tree_lidar.py's layers. Hidden together
# with the lidar above, since they come from the same flight.
RETURN_CHANNELS = ("penetration", "multi", "spread", "has_returns")
RETURN_LIDAR = (7, 8, 9, 10)
# THE LIDAR'S GROUND BRIGHTNESS (owner, 2026-10-13; S38): appended last when
# asked for (FUSE_INTENSITY). S38 found the ground intensity, ranked within
# its own frame, tells true lawn from false where the detector calls lawn
# (AUC 0.64-0.66 pooled, 41-44 lots of 45-49 the same way, three seeds).
# Ranked, because 3DEP intensity is on each flight's own scale; hidden with
# the lidar, since it comes from the same flight.
INTENSITY_CHANNELS = ("intensity_rank", "has_intensity")
# THE PAVED CENTRELINES (owner, 2026-10-20): appended last when asked for
# (FUSE_OVERTURE; tools/overture-frames.js writes <id>-overture.png). One
# number, 1 on an OpenStreetMap road, sidewalk, footway or path centreline
# falling to 0 two metres off it -- "this center line falls somewhere on a
# road, sidewalk, or sometimes a driveway" -- and a flag. The building
# footprint and the wide nearness channels that were here made THE PLAN worse
# (H105) and the owner scrapped Overture's shapes for the lawn map. Its own
# source for modality dropout: the lines have gaps of their own.
OVERTURE_CHANNELS = ("paved_line", "has_overture")


def intensity_index(with_returns):
    """Where the intensity channels sit: after CHANNELS, and after the returns when those are on."""
    i = len(CHANNELS) + (len(RETURN_CHANNELS) if with_returns else 0)
    return (i, i + 1)


def overture_index(with_returns, with_intensity):
    """Where the Overture channels start: after everything else that is on."""
    return len(CHANNELS) + (len(RETURN_CHANNELS) if with_returns else 0) + (len(INTENSITY_CHANNELS) if with_intensity else 0)


def frame_rank(intensity):
    """Each cell's rank among the frame's cells with a ground return, 0..1; NaN where none."""
    v = np.asarray(intensity, dtype=np.float64)
    out = np.full(v.shape, np.nan)
    ok = ~np.isnan(v)
    n = int(ok.sum())
    if n:
        # Average ranks for ties, as S38 measured it (scipy's rankdata), in numpy.
        u, inv, c = np.unique(v[ok], return_inverse=True, return_counts=True)
        avg = np.cumsum(c) - (c - 1) / 2.0  # 1-based average rank of each value
        out[ok] = (avg[inv] - 1) / max(1, n - 1)
    return out


def ndvi_from_png(rgb):
    """A NAIP bandIds=3,0,1 picture (NIR, red, green) to NDVI in -1..1, and where it is valid."""
    a = np.asarray(rgb, dtype=np.float32)
    nir, red = a[..., 0], a[..., 1]
    s = nir + red
    valid = s > 0
    ndvi = np.where(valid, (nir - red) / np.where(valid, s, 1.0), 0.0)
    return ndvi.astype(np.float32), valid


def extra_channels(grid_w, grid_h, cover_x, cover_y, lidar=None, ndvi=None, ndvi_valid=None, canopy=None,
                   returns=None, with_returns=False, with_intensity=False, overture=None, with_overture=False):
    """
    (len(CHANNELS), grid_h, grid_w) float32.

    lidar:    dict with height (m), n_ground, n_all on the lidar grid, or None
    ndvi:     NDVI -1..1 over the photograph, with ndvi_valid, or None
    canopy:   the tree model's mask (bool) over the photograph, or None
    overture: dict with line (nearness 0..1 to a paved centreline) over the frame, or None
    """
    n = (len(CHANNELS) + (len(RETURN_CHANNELS) if with_returns else 0) + (len(INTENSITY_CHANNELS) if with_intensity else 0)
         + (len(OVERTURE_CHANNELS) if with_overture else 0))
    out = np.zeros((n, grid_h, grid_w), dtype=np.float32)

    def down(layer):
        mean, _ = box_targets(np.asarray(layer, dtype=np.float64), grid_w, grid_h, cover_x, cover_y)
        return mean

    if lidar is not None:
        h = np.clip(np.nan_to_num(np.asarray(lidar["height"], dtype=np.float64)), 0, 30) / 10.0
        n_all = np.asarray(lidar["n_all"], dtype=np.float64)
        n_g = np.asarray(lidar["n_ground"], dtype=np.float64)
        share = np.where(n_all > 0, n_g / np.maximum(n_all, 1), 0.0)
        out[0] = down(h)
        out[1] = down(share)
        # Water and dark roofs send almost nothing back (H38's void).
        out[2] = down(np.log1p(n_all) / 3.0)
        out[3] = 1.0
    if ndvi is not None:
        valid = np.ones(ndvi.shape, bool) if ndvi_valid is None else ndvi_valid
        v = down(valid.astype(np.float64))
        s = down(np.where(valid, ndvi, 0.0))
        out[4] = np.where(v > 0, s / np.maximum(v, 1e-6), 0.0)
        out[5] = v
    if canopy is not None:
        out[6] = down(np.asarray(canopy, dtype=np.float64))
    if with_returns and returns is not None:
        # returns: tree_lidar.py's 1 m layers. A cell with no points reads as
        # open ground for the shares (all reach it, none split) and 0 spread.
        pen = np.nan_to_num(np.asarray(returns["penetration"], dtype=np.float64), nan=1.0)
        mul = np.nan_to_num(np.asarray(returns["multi"], dtype=np.float64), nan=0.0)
        spr = np.clip(np.nan_to_num(np.asarray(returns["spread"], dtype=np.float64), nan=0.0), 0, 20) / 10.0
        out[7] = down(pen)
        out[8] = down(mul)
        out[9] = down(spr)
        out[10] = 1.0
    if with_intensity and lidar is not None and lidar.get("intensity") is not None:
        # The mean rank over the cells that have one, and the share that do,
        # as NDVI is carried: a patch of roofs has no ground to be bright.
        r = frame_rank(lidar["intensity"])
        ok = ~np.isnan(r)
        i, f = intensity_index(with_returns)
        v = down(ok.astype(np.float64))
        s = down(np.where(ok, r, 0.0))
        out[i] = np.where(v > 0, s / np.maximum(v, 1e-6), 0.0)
        out[f] = v
    if with_overture and overture is not None:
        o = overture_index(with_returns, with_intensity)
        out[o] = down(np.asarray(overture["line"], dtype=np.float64))
        out[o + 1] = 1.0
    return out


def drop_sources(extra, rng, p_lidar, p_naip, more_lidar=(), overture=(), p_overture=0.0, with_returns=None):
    """Modality dropout: zero a whole source's channels, flag included, as a missing one reads.
    `more_lidar`: channels from the same flight placed elsewhere (the intensity).
    `overture`: the Overture channels' indices, hidden on their own with p_overture.
    `with_returns`: whether RETURN_LIDAR's slots hold the returns (None: assume so when they exist --
    the old reading, wrong once Overture sits in those slots, so say it)."""
    e = extra.copy()
    if p_lidar and rng.random() < p_lidar:
        returns = RETURN_LIDAR if with_returns or (with_returns is None and not overture) else ()
        e[[i for i in LIDAR + returns + tuple(more_lidar) if i < len(e) and i not in overture]] = 0.0
    if p_naip and rng.random() < p_naip:
        e[list(NAIP)] = 0.0
    if p_overture and overture and rng.random() < p_overture:
        e[[i for i in overture if i < len(e)]] = 0.0
    return e
