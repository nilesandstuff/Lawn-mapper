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


def crown_segments(canopy, tops, lawn, visible_lawn, cell_m, chm=None, near_m=10.0):
    """
    H47, the unit below the clump: every canopy cell goes to its nearest tree
    top IN THE SAME CLUMP; a clump with no top the lidar can see is one
    segment. One record per segment:

      area, lawn     m², and the tracer's lawn under it
      border         of the non-canopy cells touching the segment, the share
                     that is visible lawn (0 for a crown with none: the middle
                     of a wood)
      dist           median distance of its cells to visible lawn, metres
      crowding       other tops within `near_m` of its top (0 if topless)
      height         its top's height (the clump median if topless)
    """
    from scipy.ndimage import binary_dilation, distance_transform_edt, label
    cell_m2 = cell_m * cell_m
    clump, n = label(canopy, structure=np.ones((3, 3), dtype=bool))
    ty, tx = np.nonzero(tops & canopy)
    seg = np.zeros(canopy.shape, dtype=np.int64)
    if len(ty):
        _, (iy, ix) = distance_transform_edt(~(tops & canopy), return_indices=True)
        top_id = np.zeros(canopy.shape, dtype=np.int64)
        top_id[ty, tx] = np.arange(1, len(ty) + 1)
        near = top_id[iy, ix]
        same = clump[iy, ix] == clump
        seg = np.where(canopy & same, near, 0)
    # canopy cells whose nearest top is in another clump (or no top at all):
    # one segment per clump, numbered after the tops
    rest = canopy & (seg == 0)
    seg[rest] = len(ty) + clump[rest]
    dist = distance_transform_edt(~visible_lawn) * cell_m
    out = []
    ring_all = ~canopy
    for s in np.unique(seg[seg > 0]):
        m = seg == s
        cells = int(m.sum())
        ring = binary_dilation(m, structure=np.ones((3, 3), dtype=bool)) & ~m & ring_all
        if s <= len(ty):
            y, x = ty[s - 1], tx[s - 1]
            crowd = int(((ty - y) ** 2 + (tx - x) ** 2 <= (near_m / cell_m) ** 2).sum()) - 1
            h = float(chm[y, x]) if chm is not None else 0.0
        else:
            crowd = 0
            h = float(np.median(chm[m])) if chm is not None else 0.0
        out.append({
            "area": cells * cell_m2,
            "lawn": float((m & lawn).sum() * cell_m2),
            "border": float((ring & visible_lawn).sum() / ring.sum()) if ring.any() else 0.0,
            "dist": float(np.median(dist[m])),
            "crowding": crowd,
            "height": h,
        })
    return out
