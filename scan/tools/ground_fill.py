"""
THE GROUND'S GAPS AND SPECKS (core session, 2026-11-27; the owner: "can we work on filling gaps in turf, pavement...
I'm thinking we should use similar rules to how the lawnmapper guesses turf under canopy", and "we can know that there
won't ever be a 0-6 sqft patch of grass surrounded by pavement").

Pure numpy on the map's one-byte-a-square ground (surfaces.py g8: 0 not called, 1 turf, 2 paved, 3 porous, 4 solid
structure, 5 open structure). No places are printed by anything here.

  despeckle   a piece of turf of SPECK_SQFT or less whose rim is paving (SURROUND of the called squares round it or
              more) is paving: grass does not grow in a patch that small in the middle of paving.
  fill        the lawn mapper's two rules for the ground under a tree (public/lib/stage3.js), on the squares the walks
              did not call:
                bridge  a gap whose rim is mostly one kind (BRIDGE_SHARE of its called rim, and the rim called for
                        RIM_CALLED of its length: the gap is surrounded, not open to the unseen) is that kind;
                reach   but only as far as REACH_FT from a square the walks did call that kind.
              A gap larger than MAX_GAP_SQFT, or touching the edge of what was looked at, is left alone. Only turf
              and paving are filled. What is filled is flagged (GUESSED), never mistaken for what was seen.
  holdout     how right the fill is, by the walks agreeing with themselves: blocks of squares that WERE called are
              hidden, the fill is run, and what it puts back is compared with what had been there.
"""
import numpy as np

SPECK_SQFT = 6          # the owner's number: no patch of grass this small inside paving
SURROUND = 0.75         # of the called squares round a speck, this share paving: it is inside paving
BRIDGE_SHARE = 0.6      # of a gap's called rim, this share one kind
RIM_CALLED = 0.5        # of a gap's rim, this share called at all (else the gap opens onto what nobody saw)
REACH_FT = {1: 6.0, 2: 4.0}   # turf runs on further under leaves and shade than paving does under a parked thing
MAX_GAP_SQFT = 400      # bigger is not a gap in the ground but a place not looked at
GUESSED = 8             # a filled square's byte is its kind + GUESSED (9 turf, 10 paving)
FILLABLE = (1, 2)
EIGHT = np.ones((3, 3), bool)


def _label(mask):
    from scipy import ndimage
    return ndimage.label(mask, structure=EIGHT)


def _rim(piece_mask):
    from scipy import ndimage
    return ndimage.binary_dilation(piece_mask, structure=EIGHT) & ~piece_mask


def despeckle(g8, sqft_per_square, kind=1, into=2, speck_sqft=SPECK_SQFT, surround=SURROUND):
    """Turf pieces of speck_sqft or less inside paving become paving. -> (new grid, squares changed, pieces changed)."""
    from scipy import ndimage
    out = g8.copy()
    lab, n = _label(g8 == kind)
    if not n:
        return out, 0, 0
    size = np.bincount(lab.ravel())
    small = [k for k in range(1, n + 1) if size[k] * sqft_per_square <= speck_sqft]
    changed = pieces = 0
    if not small:
        return out, 0, 0
    objs = ndimage.find_objects(lab)
    for k in small:
        sl = objs[k - 1]
        y0, y1 = max(0, sl[0].start - 1), min(g8.shape[0], sl[0].stop + 1)
        x0, x1 = max(0, sl[1].start - 1), min(g8.shape[1], sl[1].stop + 1)
        p = lab[y0:y1, x0:x1] == k
        rim = _rim(p)
        rk = g8[y0:y1, x0:x1][rim]
        called = rk[(rk > 0) & (rk < GUESSED)]
        if len(called) and (called == into).mean() >= surround and (called == into).sum() >= max(3, rim.sum() // 2):
            out[y0:y1, x0:x1][p] = into
            changed += int(p.sum()); pieces += 1
    return out, changed, pieces


def fill(g8, sqft_per_square, ft_per_square, blocked=None, reach_ft=REACH_FT, bridge=BRIDGE_SHARE, rim_called=RIM_CALLED, max_gap_sqft=MAX_GAP_SQFT):
    """The gaps (squares 0, not blocked) filled by bridge and reach. -> (new grid with guessed squares as kind +
    GUESSED, {kind: squares filled})."""
    from scipy import ndimage
    out = g8.copy()
    H, W = g8.shape
    gap = (g8 == 0) if blocked is None else (g8 == 0) & ~blocked
    lab, n = _label(gap)
    got = {k: 0 for k in FILLABLE}
    if not n:
        return out, got
    # how far each square is from a square the walks called each kind (in feet)
    dist = {k: ndimage.distance_transform_edt(g8 != k) * ft_per_square for k in FILLABLE}
    size = np.bincount(lab.ravel())
    objs = ndimage.find_objects(lab)
    for k in range(1, n + 1):
        if size[k] * sqft_per_square > max_gap_sqft:
            continue
        sl = objs[k - 1]
        if sl[0].start == 0 or sl[1].start == 0 or sl[0].stop == H or sl[1].stop == W:
            continue    # open onto the edge of what was looked at
        y0, y1, x0, x1 = sl[0].start - 1, sl[0].stop + 1, sl[1].start - 1, sl[1].stop + 1
        p = lab[y0:y1, x0:x1] == k
        rim = _rim(p)
        rk = g8[y0:y1, x0:x1][rim]
        called = rk[(rk > 0) & (rk < GUESSED)]
        if not len(called) or len(called) < rim_called * rim.sum():
            continue
        for kind in FILLABLE:
            if (called == kind).mean() >= bridge:
                near = p & (dist[kind][y0:y1, x0:x1] <= reach_ft.get(kind, 0))
                out[y0:y1, x0:x1][near] = kind + GUESSED
                got[kind] += int(near.sum())
                break
    return out, got


def holdout(g8, sqft_per_square, ft_per_square, blocked=None, block=3, share=0.05, seed=7):
    """Hide blocks of block x block squares among those called turf or paving (about `share` of them), fill, and
    compare. -> {kind: (hidden, put back the same, put back as the other kind, left empty)}."""
    rng = np.random.default_rng(seed)
    H, W = g8.shape
    called = np.isin(g8, FILLABLE)
    ys, xs = np.nonzero(called)
    res = {k: [0, 0, 0, 0] for k in FILLABLE}
    if not len(ys):
        return res
    n_blocks = max(1, int(share * len(ys) / (block * block)))
    pick = rng.choice(len(ys), size=min(n_blocks, len(ys)), replace=False)
    hid = np.zeros_like(called)
    for i in pick:
        y, x = ys[i], xs[i]
        hid[y:y + block, x:x + block] = True
    hid &= called
    g = g8.copy()
    g[hid] = 0
    f, _ = fill(g, sqft_per_square, ft_per_square, blocked)
    for k in FILLABLE:
        m = hid & (g8 == k)
        back = f[m] - GUESSED
        res[k] = [int(m.sum()), int((back == k).sum()), int(((back > 0) & (back != k) & (back < GUESSED)).sum()), int((f[m] == 0).sum())]
    return res


if __name__ == "__main__":
    # a self-check on a drawn grid: a lawn with a hole, a drive with a speck of grass, the drive's own gap
    g = np.zeros((40, 60), np.uint8)
    g[5:35, 5:30] = 1            # lawn
    g[15:20, 12:16] = 0          # a hole in it (under a shrub's leaves)
    g[5:35, 33:45] = 2           # a drive
    g[10:12, 36:38] = 1          # a 4 sq ft speck of grass in it
    g[25:27, 37:40] = 0          # a gap in the drive
    d, ch, pc = despeckle(g, 1.0)
    assert ch == 4 and pc == 1 and (d[10:12, 36:38] == 2).all(), (ch, pc)
    f, got = fill(d, 1.0, 1.0)
    assert (f[15:20, 12:16] == 1 + GUESSED).all(), "the lawn's hole"
    assert (f[25:27, 37:40] == 2 + GUESSED).all(), "the drive's gap"
    assert (f[0:5, :] == 0).all(), "nothing out past the edge"
    # the gap between lawn and drive (30-33) runs to the grid's edge: open, left
    assert (f[20, 30:33] == 0).all()
    big = np.ones((60, 60), np.uint8); big[10:50, 10:50] = 0
    fb, _ = fill(big, 1.0, 1.0)
    assert (fb[30, 30] == 0), "a gap of 1,600 sq ft is not filled"
    small = np.ones((40, 40), np.uint8); small[10:30, 10:30] = 0
    fs, _ = fill(small, 1.0, 1.0)
    assert fs[20, 20] == 0 and fs[10, 10] == 1 + GUESSED, "reach: 6 ft from seen turf and no further"
    h = holdout(g, 1.0, 1.0)
    assert h[1][0] > 0 and h[1][1] >= 0.8 * h[1][0], h
    print("ground_fill: ok", h)
