"""
The canopy's connected patches, and an outline for each that keeps its holes.

WHY THE HOLES MATTER. The first version of this took the longest contour of
each patch and called it the outline. That is the OUTER boundary only, so a
clearing inside a wood -- a few thousand square feet of grass with trees all
round it -- was drawn as canopy and counted as canopy in the on-lawn share,
while the raw mask beside it correctly showed no trees there. Found by reading
the pictures of the Kent county lot, not by reading the code.

Stage 3 and the decoder work on the raster and never saw this; the outlines
are for drawing and for workflow 19's two overlap numbers, and both were wrong
on any lot with a clearing.

    from clumps import clumps_for, outlines_for

Only numpy, scipy and scikit-image, so canopy_test.py can import it without
loading the model.
"""

import numpy as np
from scipy import ndimage
from skimage.measure import approximate_polygon, find_contours


def clumps_for(mask):
    """
    The canopy's connected components.

    NO PARAMETER, which is the point. Two canopy pixels are in the same clump
    if you can walk between them through canopy; that is a property of the
    model's output and of nothing else. The watershed this replaced had a gap
    in metres that somebody picked, and every count it produced was partly a
    fact about that number.

    A clump is not a tree. Two trees that touch are one clump, and a tree split
    by a driveway running under it is two. The name is chosen to stop those
    being read as tree counts, which is what happened last time.
    """
    if not mask.any():
        return np.zeros_like(mask, dtype=np.int32), 0
    labels, count = ndimage.label(mask)
    return labels.astype(np.int32), int(count)


def trace(blob, tolerance):
    """The simplified boundary of one solid blob as [row, col] points, or None
    if it is too small to have a shape.

    PADDED BY ONE EMPTY PIXEL FIRST (owner, 2026-10-04: on B09 "the outline
    was inverted" -- most of the frame is canopy and the shapes were drawn
    round the parts that are not). find_contours leaves a boundary OPEN where
    the blob runs off the edge of the array, so a patch touching the frame's
    edge had no closed outer ring, and the longest open piece was the edge of
    the open ground inside it. With a border of nothing round it, every patch
    closes along the frame edge and the longest contour is its outside. The
    half-pixel the padding adds is taken off again.
    """
    padded = np.pad(blob.astype(float), 1)
    contours = find_contours(padded, 0.5)
    if not contours:
        return None
    outline = approximate_polygon(max(contours, key=len) - 1.0, tolerance=tolerance)
    return outline if len(outline) >= 4 else None


def outlines_for(blob, tolerance, min_px=0):
    """
    (outer, holes) for one patch: its outer boundary, and the boundary of
    every clearing enclosed by it that is at least min_px pixels.

    The same minimum as the patches themselves: a hole smaller than a bush is
    a gap between two branches, not a clearing, and drawing it would put
    hundreds of specks inside every wood.

    A hole's ring is traced from the hole's own pixels, so it sits half a
    pixel inside where the outer ring of a patch would put it. Drawn with an
    even-odd fill (which is what rasterizePolygon does) the outer ring minus
    the hole rings is the patch, clearing and all.
    """
    outer = trace(blob, tolerance)
    if outer is None:
        return None, []
    holes = []
    inside = ndimage.binary_fill_holes(blob) & ~blob
    if inside.any():
        labels, count = ndimage.label(inside)
        for k in range(1, count + 1):
            hole = labels == k
            if int(hole.sum()) < min_px:
                continue
            ring = trace(hole, tolerance)
            if ring is not None:
                holes.append(ring)
    return outer, holes
