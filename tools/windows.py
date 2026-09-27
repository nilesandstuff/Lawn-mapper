"""
Reading a big photograph through a fixed-size eye, without losing resolution.

THE RULE THIS SERVES: every detector gets 10 cm a pixel. A vision transformer
reads a fixed number of pixels per pass (896 for the backbone runs here), and
the banked photographs are 10 cm a pixel or finer whatever the size of the lot
-- so a 172 m lot is 1720 px, a 319 m lot 3192 px, and squeezing either into
896 hands the model 19 or 36 cm a pixel. Which it was doing, to a third of the
corpus, until 2026-09-23.

WHY NOT SIMPLY READ THE WHOLE THING. The cost of a transformer pass grows with
the square of the token count: 896 px is about 3,100 patches, 3192 px would be
40,000, and attention over 40,000 tokens is about 160 times the work of the
first on a machine that has no GPU. So the picture is read in WINDOWS.

WHY NOT SIMPLY TILE. The header of extract_features.py explains, correctly,
what tiling costs: a patch in the middle of a tile cannot see the garden it
sits in, so grass in shadow has nothing around it to be read against. That
argument was made about 224 px tiles over a 40 m lot. It still holds at the
seams of any tile -- a patch on a tile's edge sees context on three sides and
nothing on the fourth.

SO THE WINDOWS OVERLAP, AND ONLY THE MIDDLE OF EACH IS KEPT. Each window is
`size` pixels across with a margin of `size / 8` on every side; the margins
are read and thrown away, and only the core -- the middle three quarters --
goes into the stitched grid. Every patch that is kept therefore had at least
112 px (about 11 m at 10 cm) of real photograph on every side of it when the
model read it, and the seam between two cores is a place where two windows
both saw the same ground, not a place where either stopped looking. The
photograph is padded by reflection so the outermost windows have context on
their outer side too, and the padding is never part of the answer.

The whole-photo path is unchanged for lots the eye can already read at the
target: under about 90 m across at 896, the picture is resized to `size`
exactly as before. Only lots past the target are windowed, so nothing in a
result that was already at 10 cm moves.

Pure numpy, so it can be tested without a model: `look` is any callable that
turns a (size, size, 3) window into a (side, side, dim) patch grid.
"""

import math

import numpy as np


def padded_side_metres(span_across, cover):
    """How many metres the padded square's side covers, from the span ACROSS.

    `cover` is (long / w, long / h) for a photograph padded to a square of
    side `long`. The square's side in metres is the width in metres times
    long / w -- that is cover[0], whichever side is the long one: on a wide
    photograph cover[0] is 1 and the side IS the width; on a tall one it is
    h / w and the side is the height.

    NOT max(cover). The first rectangular run used that, and on a wide lot
    max(cover) is long / h -- the width multiplied by the wrong ratio. A 319 m
    lot at 3004 x 1028 was told it was 932 m across and read at 98 cm a
    pixel, and every backbone row collapsed (81.6% on the eye alone). A
    scale-aware model told the wrong scale does not fail; it reads a garden
    as a landscape.
    """
    return span_across * cover[0]


def window_plan(w, h, size, patch):
    """Margin, core and window counts for a w x h photograph read at `size`.

    The margin is an eighth of the window, rounded DOWN to a whole number of
    patches so the kept core lands on patch boundaries: 896 -> 112 px (7
    patches), 1280 -> 160 (10), 672 -> 80 (5), 448 -> 48 (3).
    """
    margin = (size // 8 // patch) * patch
    core = size - 2 * margin
    if core <= 0 or core % patch:
        raise ValueError(f"no usable core for size {size} and patch {patch}")
    return margin, core, math.ceil(w / core), math.ceil(h / core)


def windowed(arr, size, patch, look, keep=None):
    """Read `arr` (h, w, c) in overlapping windows; return the stitched grid.

    Returns (grid, cover, windows) where grid is (gridH, gridW, dim), `cover`
    is (coverX, coverY) -- how much wider than the photograph the grid's
    ground is, because the last core runs past the picture's edge into
    padding -- and `windows` is how many passes it took. A consumer maps a
    photograph pixel x to grid column x / patch, i.e. (x / w) * gridW / coverX.
    """
    h, w = arr.shape[:2]
    margin, core, nx, ny = window_plan(w, h, size, patch)
    pad_r = margin + nx * core - w
    pad_b = margin + ny * core - h
    pads = ((margin, pad_b), (margin, pad_r), (0, 0))
    # Reflection needs less padding than there is picture; a tiny test image
    # can fail that, and the edge value is a fine stand-in there.
    mode = "reflect" if max(margin, pad_r, pad_b) < min(h, w) else "edge"
    padded = np.pad(arr, pads, mode=mode)

    cp, mp = core // patch, margin // patch
    out = None
    skipped = []
    for ky in range(ny):
        for kx in range(nx):
            # A window whose core is nowhere near the lot is not read at all
            # (the owner's "don't process the padding", 2026-09-27): its
            # patches stay zero, and the decoder gives ground outside the
            # property line no weight anyway. `keep` gets the core's box in
            # the photograph's own pixels.
            if keep is not None and not keep(kx * core, ky * core, (kx + 1) * core, (ky + 1) * core):
                skipped.append((ky, kx))
                continue
            win = padded[ky * core:ky * core + size, kx * core:kx * core + size]
            g = look(win)
            if g.shape[0] != size // patch or g.shape[1] != size // patch:
                raise ValueError(
                    f"the eye returned a {g.shape[0]}x{g.shape[1]} grid for a "
                    f"{size} px window of {patch} px patches; wanted "
                    f"{size // patch}x{size // patch}"
                )
            if out is None:
                out = np.zeros((ny * cp, nx * cp, g.shape[2]), dtype=np.float32)
            out[ky * cp:(ky + 1) * cp, kx * cp:(kx + 1) * cp] = g[mp:mp + cp, mp:mp + cp]

    if out is None:
        # Every window skipped: nothing of the lot in the photograph. One read
        # of the first window keeps the grid's shape honest.
        g = look(padded[0:size, 0:size])
        out = np.zeros((ny * cp, nx * cp, g.shape[2]), dtype=np.float32)
        skipped = [s for s in skipped if s != (0, 0)]
        out[0:cp, 0:cp] = g[mp:mp + cp, mp:mp + cp]
    windowed.last_skipped = len(skipped)
    return out, (nx * core / w, ny * core / h), nx * ny - len(skipped)
