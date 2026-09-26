"""
S9, the owner's tree count: woods are several crowns with no lawn between
them; a lawn tree is one or two with a border of lawn.

Measured before any rule is built, per canopy CLUMP (H35: the clump is the
level a woods rule acts at, and a layer that reads well per cell can fail per
clump):

  crowns   tree tops in the lidar's canopy height model, by the published
           variable-window method (Popescu & Wynne 2004): a cell is a top if
           it is at least MIN_TOP_M high and the highest within a circle
           whose width grows with its height -- their deciduous crown width,
           2.51503 + 0.00901 h^2 metres. The CHM is smoothed first (a 3x3
           mean) so the holes a 1-2 points/m² cloud leaves in a crown do not
           split it into false tops.
  border   of the ring of cells just outside the clump, the share that is
           visible lawn: "a good border of lawn around it".
  truth    the share of the clump the tracer called lawn (traced or
           inferred). A clump is a LAWN clump at half or more.

Pure functions; tests in crowns_lidar_test.py.
"""

import numpy as np

MIN_TOP_M = 3.0


def crown_width_m(h):
    """Popescu & Wynne (2004), deciduous: crown width from height."""
    return 2.51503 + 0.00901 * h * h


def tree_tops(chm, cell_m, min_h=MIN_TOP_M):
    """Boolean mask of tree tops on a 2-D canopy height model (metres)."""
    from scipy.ndimage import uniform_filter
    h = uniform_filter(np.nan_to_num(chm.astype(np.float64)), size=3, mode="nearest")
    tops = np.zeros(h.shape, dtype=bool)
    H, W = h.shape
    ys, xs = np.nonzero(h >= min_h)
    for y, x in zip(ys, xs):
        r = max(1, int(round(crown_width_m(h[y, x]) / 2 / cell_m)))
        y0, y1, x0, x1 = max(0, y - r), min(H, y + r + 1), max(0, x - r), min(W, x + r + 1)
        win = h[y0:y1, x0:x1]
        yy, xx = np.ogrid[y0 - y:y1 - y, x0 - x:x1 - x]
        disc = (yy * yy + xx * xx) <= r * r
        # the highest in its circle; on a tie, the first in reading order
        m = win[disc].max()
        if h[y, x] < m:
            continue
        ties = np.argwhere((win == m) & disc)
        ty, tx = ties[0]
        if (y0 + ty, x0 + tx) == (y, x):
            tops[y, x] = True
    return tops


def clump_stats(canopy, lawn, visible_lawn, tops, cell_m2, min_cells=2, chm=None):
    """
    One record per 8-connected canopy clump of at least `min_cells` cells:
    area (m²), lawn m² under it, crowns, border lawn share.
    `lawn` is the tracer's lawn (traced or inferred); `visible_lawn` the lawn
    outside the canopy (the border test).
    """
    from scipy.ndimage import binary_dilation, label
    lab, n = label(canopy, structure=np.ones((3, 3), dtype=bool))
    out = []
    for k in range(1, n + 1):
        m = lab == k
        cells = int(m.sum())
        if cells < min_cells:
            continue
        ring = binary_dilation(m, structure=np.ones((3, 3), dtype=bool)) & ~m & ~canopy
        out.append({
            "area": cells * cell_m2,
            "lawn": float((m & lawn).sum() * cell_m2),
            "crowns": int((m & tops).sum()),
            "border": float((ring & visible_lawn).sum() / ring.sum()) if ring.any() else 0.0,
            "height": float(np.median(chm[m])) if chm is not None else 0.0,
        })
    return out


def rule_trade(clumps, woods):
    """
    For a predicate over clumps that says "woods": the tracer's lawn m² it
    would call woods (cost) and the not-lawn canopy m² it would call woods
    (the woods it finds), pooled.
    """
    cost = sum(c["lawn"] for c in clumps if woods(c))
    found = sum(c["area"] - c["lawn"] for c in clumps if woods(c))
    lawn_all = sum(c["lawn"] for c in clumps)
    woods_all = sum(c["area"] - c["lawn"] for c in clumps)
    return cost, lawn_all, found, woods_all
