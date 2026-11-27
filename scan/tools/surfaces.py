"""
THE GROUND AS THE WALK SAW IT: PAVING AND GRASS ON THE MAP (core session, 2026-11-24). The owner: "Until the next walk,
what's next? Lawn shape refinement and driveway marking?" -- the goal's "automatically refine the lawn trace".

The lidar's ground alone could not say which strip was the drive (SCAN-PLAN 24: two readings, two different strips).
The walk's own GROUND points carry the phone's labels (ARCore: road, sidewalk, terrain), and the pictures' vote
(view-kind.bin: paved, grass, bare ground). Put on the map by the walk's corners (fit.json), one foot square at a time:
  - a square is PAVED or GRASS when 3 points or more say so and twice as many as say the other;
  - against the TRACED LAWN (lawn.json, the map record's own shapes in the map's metres, lawn-prep.mjs): grass the walk
    saw outside the trace (lawn missing from it) and paving inside it (the trace runs over paving);
  - the paving's pieces, largest first, and for each its longest straight run of one width: the owner's drive is known
    by tape measure (SCAN-PLAN 23), so its width is the check.

Counts, areas and widths only: no places (the repository and its logs are public).

  python scan/tools/surfaces.py <twin dir>
"""
import base64
import json
import os
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trunks as TR  # noqa: E402

FT = 3.28084
CELL = 0.3048          # m: a foot
GROUND_M = 0.2         # m: a ground point is within this of the ground under it
MIN_PTS = 3            # points to call a square
BARE_MIN_SQFT = 4      # a bare patch this big or more is not grass (the owner, 2026-11-24)
PHONE_PAVED, PHONE_GRASS = (5, 6), (7,)    # labels-NNNN.bin byte 0 is ARCore's label + 1: road 5, sidewalk 6, terrain 7


def ftin(m):
    inch = int(round(m * 39.3701))
    return f"{inch // 12} ft {inch % 12} in"


def inside(rings, x, y):
    """Points (x, y) inside any ring (even-odd), vectorised."""
    out = np.zeros(len(x), bool)
    for r in rings:
        r = np.asarray(r, float)
        if len(r) < 3:
            continue
        xi, yi = r[:, 0], r[:, 1]
        xj, yj = np.roll(xi, 1), np.roll(yi, 1)
        for a, b, c, dd in zip(xi, yi, xj, yj):
            cond = ((b > y) != (dd > y)) & (x < (c - a) * (y - b) / np.where(dd - b == 0, 1e-12, dd - b) + a)
            out ^= cond
    return out


def pieces(mask):
    """8-neighbour pieces of a bool grid, after a one-square closing (a gap of a foot is not a break)."""
    from scipy import ndimage
    m = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=1) | mask
    lab, n = ndimage.label(m, structure=np.ones((3, 3)))
    return lab, n


def straight_width(cells, pts=None):
    """A piece's longest straight run of one width: turned to the piece's own long axis (from its squares), a foot at
    a time along it, the width across each foot from the paved POINTS in it (four times their median distance from
    their middle, as for anything spread evenly across; 20 points at the least, pooled over nine feet; the squares' own edges lose about a foot, since a square half on
    paving is not called); the longest run within 15 in of its own middle (the points' own scatter is about a foot).
    -> (median width m, run length m, cross-sections) or None."""
    if len(cells) < 30:
        return None
    mu = cells.mean(0)
    c = cells - mu
    w, v = np.linalg.eigh(np.cov(c.T))
    ax = v[:, np.argmax(w)]
    nrm = np.array([-ax[1], ax[0]])
    along = c @ ax
    b0, b1 = int(np.floor(along.min() / CELL)), int(np.floor(along.max() / CELL))
    if pts is not None and len(pts) >= 50:
        pa, pc = (pts - mu) @ ax, (pts - mu) @ nrm
        pb = np.floor(pa / CELL).astype(int)
    else:
        pa, pc, pb = along, c @ nrm, np.floor(along / CELL).astype(int)
    widths = []
    for b in range(b0, b1 + 1):
        q = pc[(pb >= b - 4) & (pb <= b + 4)]             # the nine feet round this one, pooled
        # paving fills its width evenly, so points across it are spread evenly: the width is four times their median
        # distance from their middle (unbiased however few they are; a stray point outside hardly moves it)
        widths.append(np.nan if len(q) < 20 else 4 * np.median(np.abs(q - np.median(q))))
    widths = np.array(widths)
    best = (0, 0, 0)
    for i in range(len(widths)):
        if not np.isfinite(widths[i]):
            continue
        for j in range(i + 1, len(widths) + 1):
            seg = widths[i:j]
            if not np.isfinite(seg).all():
                break
            med = np.median(seg)
            if np.abs(seg - med).max() > 1.25 / FT:
                break
            if j - i > best[1] - best[0]:
                best = (i, j, med)
    if best[1] - best[0] < 5:
        return None
    return best[2], (best[1] - best[0]) * CELL, best[1] - best[0]


def share_width(cells, pav_pts, gra_pts, reach=4.0, binw=0.1):
    """The same run of width, from the SHARE of paved points across (2026-11-25). The width above is four times the
    points' median distance from their middle, right only when they lie evenly across; a picture's cast cells are
    thick by the walker and thin far off, which pulls it narrow, and it sees only the points on the piece's own
    squares. Here every paved and grass point within `reach` of the piece's long axis is binned across it, 4 in at a
    time, nine feet pooled along; the width at a foot is the unbroken run of bins through the paving's middle where
    paving has half the points or more (3 at the least; one empty bin is not a break).
    -> (median width m, run length m, cross-sections) or None."""
    if len(cells) < 30 or len(pav_pts) < 50:
        return None
    mu = cells.mean(0)
    c = cells - mu
    w, v = np.linalg.eigh(np.cov(c.T))
    ax = v[:, np.argmax(w)]
    nrm = np.array([-ax[1], ax[0]])
    along = c @ ax
    off0 = np.median(c @ nrm)
    b0, b1 = int(np.floor(along.min() / CELL)), int(np.floor(along.max() / CELL))
    nb = int(round(2 * reach / binw))
    def split(pts):
        a_, x_ = (pts - mu) @ ax, (pts - mu) @ nrm - off0
        ok = np.abs(x_) < reach
        return np.floor(a_[ok] / CELL).astype(int), np.clip(((x_[ok] + reach) / binw).astype(int), 0, nb - 1)
    pb, px = split(pav_pts)
    gb, gx = split(gra_pts) if len(gra_pts) else (np.zeros(0, int), np.zeros(0, int))
    widths = []
    for b in range(b0, b1 + 1):
        hp = np.bincount(px[(pb >= b - 4) & (pb <= b + 4)], minlength=nb)
        hg = np.bincount(gx[(gb >= b - 4) & (gb <= b + 4)], minlength=nb)
        paved = (hp >= 3) & (hp >= hg)
        empty = (hp + hg) == 0
        if not paved.any():
            widths.append(np.nan)
            continue
        # start at the paved bin nearest the piece's own middle, grow both ways over paved bins and single empty ones
        idx = np.flatnonzero(paved)
        m = idx[np.argmin(np.abs(idx - nb // 2))]
        lo = hi = m
        while lo > 0 and (paved[lo - 1] or (empty[lo - 1] and lo > 1 and paved[lo - 2])):
            lo -= 1
        while hi < nb - 1 and (paved[hi + 1] or (empty[hi + 1] and hi < nb - 2 and paved[hi + 2])):
            hi += 1
        widths.append(np.nan if lo == 0 or hi == nb - 1 else (hi - lo + 1) * binw)   # ran off the reach: not a width
    widths = np.array(widths)
    best = (0, 0, 0)
    for i in range(len(widths)):
        if not np.isfinite(widths[i]):
            continue
        for j in range(i + 1, len(widths) + 1):
            seg = widths[i:j]
            if not np.isfinite(seg).all():
                break
            med = np.median(seg)
            if np.abs(seg - med).max() > 1.25 / FT:
                break
            if j - i > best[1] - best[0]:
                best = (i, j, med)
    if best[1] - best[0] < 5:
        return None
    return best[2], (best[1] - best[0]) * CELL, best[1] - best[0]


# THE GROUND'S OWN COLOUR (2026-11-26; the owner: "work on the bare ground"). The phone's "terrain" is grass, bare soil,
# woodchips, moss and fallen leaves alike. The picture's colour at the point tells green from brown: GREEN is turf;
# BROWN is porous ground or fallen leaves, which colour cannot tell apart, so brown under or near a tree is LEAVES and is
# not called at all (the owner: "we shouldn't really guess what's under the leaves... We can see what's in between
# leaves, but only when we can see what's between them": a green square among the leaves is still turf).
COLOUR_UNKNOWN, COLOUR_GREEN, COLOUR_BROWN, COLOUR_OTHER = 0, 1, 2, 3
LEAF_REACH_FT = 6      # brown within this of a plant the walks saw (3 ft up or more) is taken for fallen leaves
PLANT_GROUND_DM = 3    # a plant whose lowest part is this near the ground STANDS on the square: no ground is called there


def colour_class(rgb):
    """(n, 3) uint8 -> class per row: green, brown, other (grey, dark, sky-bright), by hue and saturation."""
    c = rgb.astype(np.float64) / 255.0
    mx, mn = c.max(1), c.min(1)
    v, s = mx, np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    r, g, b = c[:, 0], c[:, 1], c[:, 2]
    d = np.maximum(mx - mn, 1e-9)
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    out = np.full(len(c), COLOUR_OTHER, np.uint8)
    ok = (v >= 0.10) & (v <= 0.97) & (s >= 0.12)
    out[ok & (h >= 55) & (h <= 170)] = COLOUR_GREEN
    out[ok & ((h < 52) | (h >= 340))] = COLOUR_BROWN
    return out


REACH, SMOOTH, COLOUR, ADE = 8.0, False, False, False   # set from the command line in main()
CAST_MAX_M = 8.0       # m: a picture's depth cell is cast onto the ground only this near (the depth is off 3-6% of the distance)
CAST_CONF = 0.3        # the least depth confidence for a cast cell
STRUCT_TOP_M = 4.0     # m: built cells this high over the ground at most are put down onto their squares
# WHAT IS SOLID (2026-11-27, after the owner's eyes on the first map: "a wood line; some trees, tree trunks maybe; most of
# the large deck in the back (none of which is called open structure); a fairly wide area bulging out from real walls;
# random small patches in the middle of the lawn and driveway")
BUILT_MAX_M = 5.0      # m: a picture's built cell counts only this near (at 8 m the depth is off up to half a metre)
NOT_BUILT = (1, 3, 6, 9, 10)   # the phone's own labels that veto the large labeller's "built": sky, tree, terrain, car, person
STAND_M = 0.4          # m: a wall stands up: its cells over a square span this much height (10th to 90th percentile)
STAND_TOP_M = 0.6      # m: and reach this high
FLAT_M = 0.4           # m: a deck's boards are flat: their cells span less than this
DECK_M = (0.3, 1.8)    # m: the boards' height over the ground
DECK_MIN_SQFT = 16     # a deck is bigger than a table or a car's hood
HALO_SHARE = 0.2       # a solid square holds at least this share of the most cells on a square within 2 ft (else a wall's smear)
# THE LIDAR'S SHAPES, CHECKED BY THE WALKS (2026-11-27; the owner: "the lidar shapes are really good, but they have some
# fuzziness at edges, lidar doesn't actually know how far in the walls sit, and it can get confused when trees touch the
# building"): surfaces.py --lidar
LIDAR_BAND_FT = 6      # the walks' walls within this of a lidar shape's edge, in or out, are that shape's walls
WALL_OUT_MAX_FT = 1    # but a wall moves the edge OUT by no more than this (the lidar's outline is good; the bulges were walls seen out of place)
WALL_IN_MAX_FT = 4     # and IN by no more than this (eaves)
ADD_AGREE_FT = 1.5     # ...unless two walks or more put it further out and agree within this: an addition since the flight
BUILT_FIT_M = 0.3      # a walk whose corners agree no better than this gives no built things
YARD_MAX_M = 8.0       # the yard labels' cells counted this near the camera
YARD_CELLS = []        # (x, z session, label) of the walk being read, filled by cast_pictures, moved onto the map by load_walk
YARD_MAP = []          # (east, north, label) of every walk on the map
WALL_NEAR_FT = 4       # an edge square takes the walls within this of it
WALL_SPREAD_FT = 8     # an edge square with no walls near takes the offset of the edge within this that has one
WALL_INSET_FT = 2      # walls stand 2 ft in from a roof's edge where the walks did not see them (structures.js WALL_INSET_M)
CONFIRM_SHARE = 0.25   # walls found along this share of the edge the walks looked at: the shape is confirmed
SEEN_SHARE = 0.5       # the walks looked at this share of a shape's edge: they could judge it
DECK_SHARE = 0.3       # a low shape with its boards lying flat over this share of what was looked at is a deck
DECK_TOP_M = 2.5       # a lidar shape no taller than this may be a deck
WALK_ONLY_SQFT = 16    # a solid piece the lidar does not have stands on the walks alone only this big


def cast_pictures(d, cut, gtree, gmed, scale=1.0, reach=None, smooth=False, colour=False):
    """THE PICTURES' OWN GROUND (2026-11-25; the owner: "look into how we can make better use of it, because I gave
    pretty clear views of the ground"). The walk's kept points are thinned to one a small cube, so a clear view of a
    drive leaves a few points a square foot. Every picture also keeps, on one 72 x 128 grid, the camera's raw depth
    (key-NNNN.rdepth) and, since 2026-11-24, the phone's own label (key-NNNN.sem): each cell is a labelled point in
    space. Those within CAST_MAX_M, sure enough, and within GROUND_M of the walk's ground are the ground as that
    picture saw it: thousands a picture instead of dozens. -> (x, z session, label + 1) arrays, pictures used."""
    import re
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    # THE PICTURES' POSES THE RIGHT WAY ROUND (2026-11-25): the app keeps ARCore's VIEW matrix (session to camera), the
    # web page kept camera to session; segment_study.pose_keys tells which by the track. This tool read every app walk's
    # pictures inside out until today, so what it said of pictures before then is void.
    import segment_study as SS
    SS.pose_keys(keys, SS.read_track(d))
    X, Z, Lb, Cc, R, Ad, used = [], [], [], [], [], [], 0
    Pn, SX, SZ, SH, SK, SP, SR, SL = [], [], [], [], [], [], [], []   # each ground cell's picture; the built cells (x, z, height, kind, picture, range, the phone's own label)
    reach = CAST_MAX_M if reach is None else reach
    # THE YARD'S THINGS BY NAME (yard_labels.py, 2026-11-27): each picture's CLIPSeg labels on its depth grid, if the walk has them
    ylab = {}
    try:
        yz = np.load(os.path.join(d, "yard-labels.npz"), allow_pickle=False)
        ylab = dict(zip(json.loads(str(yz["pics"])), yz["idx"]))
    except Exception:
        ylab = {}
    YX, YZ, YI = [], [], []
    if colour:
        try:
            from PIL import Image
        except Exception:
            colour = False
    for pic_no, k in enumerate(keys):
        if k.get("t", 0) < cut:
            continue
        fs, fr = os.path.join(d, k["name"].replace(".jpg", ".sem")), os.path.join(d, k["name"].replace(".jpg", ".rdepth"))
        if not (os.path.exists(fs) and os.path.exists(fr)):
            continue
        b = np.fromfile(fs, dtype=np.uint8); r = np.fromfile(fr, dtype="<u2")
        nx, ny = int(r[0]), int(r[1])
        if len(r) < 2 + 2 * nx * ny or len(b) < 4 + nx * ny or (int(b[0]) | (int(b[1]) << 8)) != nx:
            continue
        dist = r[2:2 + nx * ny].astype(np.float64) / 1000.0 * scale   # the phone's metres to the map's when the twin was moved (twin-onref.mjs)
        conf = r[2 + nx * ny:2 + 2 * nx * ny].astype(np.float64) / 255.0
        lab = b[4:4 + nx * ny].astype(np.int64)
        sure = b[4 + nx * ny:4 + 2 * nx * ny] >= 128 if len(b) >= 4 + 2 * nx * ny else np.ones(nx * ny, bool)
        m = (dist > 0.4) & (dist <= reach) & (conf >= CAST_CONF) & (lab < 12) & sure
        # (--smooth) where the raw depth has nothing, ARCore's smoothed depth (key-NNNN.sdepth, no holes), to the same reach
        fsd = os.path.join(d, k["name"].replace(".jpg", ".sdepth"))
        if smooth and os.path.exists(fsd):
            sd = np.fromfile(fsd, dtype="<u2")
            if len(sd) >= 2 + nx * ny and int(sd[0]) == nx and int(sd[1]) == ny:
                sdist = sd[2:2 + nx * ny].astype(np.float64) / 1000.0 * scale
                hole = ~((dist > 0.4) & (conf >= CAST_CONF)) & (sdist > 0.4) & (sdist <= reach) & (lab < 12) & sure
                dist = np.where(hole, sdist, dist); m = m | hole
        if not m.any():
            continue
        V = k["c2w"]
        Pi = np.linalg.inv(np.asarray(k["proj"], np.float64).reshape(4, 4).T)
        jj, ii = np.divmod(np.flatnonzero(m), nx)
        u, v = 2 * (ii + 0.5) / nx - 1, 1 - 2 * (jj + 0.5) / ny
        a4 = np.stack([u, v, -np.ones_like(u), np.ones_like(u)], 1) @ Pi.T
        b4 = np.stack([u, v, np.ones_like(u), np.ones_like(u)], 1) @ Pi.T
        dc = b4[:, :3] / b4[:, 3:4] - a4[:, :3] / a4[:, 3:4]
        dw = dc @ V[:3, :3].T
        dw /= np.linalg.norm(dw, axis=1, keepdims=True)
        P = V[:3, 3][None, :] + dw * dist[m][:, None]
        _, near = gtree.query(np.floor(P[:, [0, 2]]))
        hgt = P[:, 1] - gmed[near]
        g = np.abs(hgt) <= GROUND_M
        fa = os.path.join(d, k["name"].replace(".jpg", ".ade"))
        ak_all = np.zeros(len(P), np.uint8)
        if ADE and os.path.exists(fa):
            ab = np.fromfile(fa, dtype=np.uint8)
            if len(ab) >= 4 + nx * ny and (int(ab[0]) | (int(ab[1]) << 8)) == nx:
                ak_all = ab[4:4 + nx * ny][np.flatnonzero(m)]
        # THE BUILT THINGS AT ANY HEIGHT (2026-11-27): the large labeller's walls, pillars, floors off the ground and
        # roofs seen from under, wherever they stand up to STRUCT_TOP_M, put down onto their squares with their height
        sb = ~g & np.isin(ak_all, (8, 9, 10)) & (hgt > -0.5) & (hgt <= STRUCT_TOP_M)
        if k["name"] in ylab:
            yi = ylab[k["name"]].ravel()[np.flatnonzero(m)]
            ys = (yi > 0) & (dist[m] <= YARD_MAX_M) & (hgt > -0.5) & (hgt <= STRUCT_TOP_M)
            if ys.any():
                YX.append(P[ys, 0]); YZ.append(P[ys, 2]); YI.append(yi[ys])
        if sb.any():
            SX.append(P[sb, 0]); SZ.append(P[sb, 2]); SH.append(hgt[sb]); SK.append(ak_all[sb]); SP.append(np.full(int(sb.sum()), pic_no, np.int32))
            SR.append(dist[m][sb]); SL.append(lab[m][sb].astype(np.int16))
        if g.any():
            X.append(P[g, 0]); Z.append(P[g, 2]); Lb.append(lab[m][g] + 1); R.append(dist[m][g]); used += 1
            ak = ak_all[g]
            Ad.append(ak); Pn.append(np.full(int(g.sum()), pic_no, np.int32))
            cc = np.zeros(int(g.sum()), np.uint8)
            fj = os.path.join(d, k["name"])
            if colour and os.path.exists(fj):
                try:
                    im = np.asarray(Image.open(fj).convert("RGB"))
                    Hh, Ww = im.shape[:2]
                    px = np.clip(((ii[g] + 0.5) / nx * Ww).astype(int), 0, Ww - 1); py = np.clip(((jj[g] + 0.5) / ny * Hh).astype(int), 0, Hh - 1)
                    cc = colour_class(im[py, px])
                except Exception:
                    pass
            Cc.append(cc)
    if YX:
        YARD_CELLS.append((np.concatenate(YX), np.concatenate(YZ), np.concatenate(YI)))
    if not X:
        return None
    built = tuple(np.concatenate(v) for v in (SX, SZ, SH, SK, SP, SR, SL)) if SX else None
    return np.concatenate(X), np.concatenate(Z), np.concatenate(Lb).astype(np.uint8), used, np.concatenate(Cc), np.concatenate(R), np.concatenate(Ad), np.concatenate(Pn), built


def yard_study(shapes_info, H, W, i0, j0, SQ):
    """THE YARD LABELS ON THE LIDAR'S SHAPES (a study, 2026-11-27): for each lidar shape, largest first, the share of
    the labelled cells on it and within 2 ft of it that each named thing holds; and away from every shape, the squares
    each structure-like thing holds. Names and counts only."""
    if not YARD_MAP:
        print("  THE YARD LABELS ON THE LIDAR'S SHAPES: none (the walks have no yard-labels.npz yet).")
        return
    import yard_labels as YL
    from scipy import ndimage
    names = [t[0] for t in YL.THINGS]; kinds = [t[2] for t in YL.THINGS]
    ye = np.concatenate([a[0] for a in YARD_MAP]); yn = np.concatenate([a[1] for a in YARD_MAP]); yi = np.concatenate([a[2] for a in YARD_MAP]).astype(int)
    ci_, cj_ = np.floor(ye / CELL).astype(int) - i0, np.floor(yn / CELL).astype(int) - j0
    ok_ = (ci_ >= 0) & (cj_ >= 0) & (ci_ < W) & (cj_ < H)
    nT = len(names) + 1
    cnt = np.zeros((H * W, nT), np.int32)
    np.add.at(cnt, (cj_[ok_] * W + ci_[ok_], yi[ok_]), 1)
    cnt = cnt.reshape(H, W, nT)
    on_any = np.zeros((H, W), bool)
    lines = []
    two = max(1, int(round(2 / (CELL * FT))))
    for q, (lk, fp, y0, x0, v) in enumerate(sorted(shapes_info, key=lambda t: -int(t[1].sum()))):
        m = np.zeros((H, W), bool); m[y0:y0 + fp.shape[0], x0:x0 + fp.shape[1]] = fp
        m2 = ndimage.binary_dilation(m, structure=np.ones((3, 3)), iterations=two)
        on_any |= m2
        c = cnt[m2].sum(0)[1:]
        if not c.sum():
            lines.append(f"shape {q + 1} ({'building' if lk == 1 else 'low structure'}, {int(m.sum() * SQ):,} sq ft, {v}): no labelled cells within 26 ft of a camera")
            continue
        tot = int(c.sum())
        top = np.argsort(-c)[:5]
        lines.append(f"shape {q + 1} ({'building' if lk == 1 else 'low structure'}, {int(m.sum() * SQ):,} sq ft, {v}): {tot:,} labelled cells, "
                     + ", ".join(f"{names[t]} {100 * c[t] / tot:.0f}%" for t in top if c[t]))
    print("  THE YARD LABELS ON THE LIDAR'S SHAPES (the shapes largest first; each, the named things' shares of the labelled cells on it and within 2 ft): " + "; ".join(lines) + ".")
    away = ~on_any
    tot_sq = cnt.sum(2)
    parts = []
    for t in range(len(names)):
        if kinds[t] not in ("solid", "open", "fence", "pool"):
            continue
        dom = away & (cnt[:, :, t + 1] >= MIN_PTS) & (2 * cnt[:, :, t + 1] >= tot_sq)
        if dom.any():
            parts.append(f"{names[t]} {int(dom.sum() * SQ):,} sq ft")
    print("     AWAY FROM EVERY LIDAR SHAPE, the squares each thing holds (half or more of the labelled cells there): " + (", ".join(parts) if parts else "none") + ".")


def load_walk(d):
    """One walk's ground on the map: (east, north, phone label + 1, voted kind or None, a line saying what it gave),
    or None when its corners gave no fit."""
    import re
    name = os.path.basename(os.path.normpath(d))
    try:
        fit = json.load(open(os.path.join(d, "fit.json")))
    except Exception:
        fit = None
    if not (fit and fit.get("ok") and fit.get("T")):
        print(f"  {name}: NOT put on the map ({(fit or {}).get('why') or 'no fit kept beside the walk'}).")
        return None
    T = fit["T"]
    recs, kind, flags = TR.read_walk(d)
    parts = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        m_ = os.path.getsize(os.path.join(d, n)) // 24
        lp = os.path.join(d, n.replace("cloud-", "labels-"))
        lb = np.fromfile(lp, dtype=np.uint8) if os.path.exists(lp) else np.zeros(0, np.uint8)
        parts.append(lb.reshape(-1, 4)[:, 0] if len(lb) == 4 * m_ else np.zeros(m_, np.uint8))
    lab = np.concatenate(parts) if parts else np.zeros(len(recs), np.uint8)
    if len(lab) != len(recs):
        lab = np.zeros(len(recs), np.uint8)
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    fin = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & (t_ >= cut) & ((flags & 3) == 0)
    ok = fin & (np.abs(y_ - g_) <= GROUND_M)
    X, Z, L = x_[ok], z_[ok], lab[ok]
    K = kind[ok] if kind is not None else None
    C = np.zeros(len(X), np.uint8)
    A = np.zeros(len(X), np.uint8)       # the second labeller's kind (ground_labels.py; pictures' cells only)
    rf = os.path.join(d, "view-rgb.bin")
    if COLOUR and os.path.exists(rf):
        rgb = np.fromfile(rf, dtype=np.uint8)
        if len(rgb) >= 4 * len(recs):
            q = rgb[:4 * len(recs)].reshape(-1, 4)[ok]
            C = np.where(q[:, 3] > 0, colour_class(q[:, :3]), COLOUR_UNKNOWN).astype(np.uint8)
    note = f"{name}: {int(ok.sum()):,} kept ground points"
    Src = np.full(len(X), -1, np.int32)          # the picture a ground point came from; -1 the walk's kept points
    Rg = np.full(len(X), np.nan)                 # how far the camera was from it (kept points: not known here)
    # the walk's kept points on built things, off the ground: the phone's "building" label or the pictures' vote's "built"
    hk = y_ - g_
    # (2026-11-27, the owner: a wood line and trees called solid) where both speak, both must say built: the phone's
    # "building" is not taken where the vote says tree or plant, nor the vote's "built" where the phone says sky, tree,
    # terrain, a car or a person
    if kind is not None:
        vb, vsoft = kind == TR.KINDS.index("built"), np.isin(kind, [TR.KINDS.index("tree"), TR.KINDS.index("plant"), TR.KINDS.index("grass")])
    else:
        vb, vsoft = np.zeros(len(lab), bool), np.zeros(len(lab), bool)
    sk = fin & (hk > 0.3) & (hk <= STRUCT_TOP_M) & (((lab == 3) & ~vsoft) | (vb & ~np.isin(lab.astype(np.int16) - 1, NOT_BUILT)))
    BX, BZ, BH, BK, BP = [x_[sk]], [z_[sk]], [hk[sk]], [np.full(int(sk.sum()), 8, np.uint8)], [np.full(int(sk.sum()), -1, np.int32)]
    BR, BL = [np.full(int(sk.sum()), np.nan)], [lab[sk].astype(np.int16) - 1]
    # the pictures' own ground, where the walk kept their label grids
    if fin.sum() > 100:
        from scipy.spatial import cKDTree
        gij = np.floor(np.stack([x_[fin], z_[fin]], 1)).astype(np.int64)
        o = np.lexsort((gij[:, 1], gij[:, 0])); gs, gy = gij[o], g_[fin][o]
        brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
        gmed = np.array([np.median(gy[p:q]) for p, q in zip(brk, np.r_[brk[1:], len(gy)])])
        cast = cast_pictures(d, cut, cKDTree(gs[brk].astype(np.float64)), gmed, float(fit.get("castScale") or 1.0), REACH, SMOOTH, COLOUR)
        if cast is not None:
            cx, cz, cl, used, ccol, crange, cade, cpic, cbuilt = cast
            if cbuilt is not None:
                BX.append(cbuilt[0]); BZ.append(cbuilt[1]); BH.append(cbuilt[2]); BK.append(cbuilt[3]); BP.append(cbuilt[4])
                BR.append(cbuilt[5]); BL.append(cbuilt[6])
            if "--nocast" not in sys.argv:
                X, Z, L, C, A = np.r_[X, cx], np.r_[Z, cz], np.r_[L, cl], np.r_[C, ccol], np.r_[A, cade]
                Src, Rg = np.r_[Src, cpic], np.r_[Rg, crange]
                if K is not None:
                    K = np.r_[K, np.zeros(len(cx), K.dtype)]
            note += f" and {len(cx):,} ground cells from {used} pictures' own depth and labels (within {REACH * FT:.0f} ft{', and the smoothed depth where the raw has none' if SMOOTH else ''})" + (" (counted, NOT used)" if "--nocast" in sys.argv else "")
        else:
            note += "; its pictures kept no label grids (a walk from before 2026-11-24)"
    s_, th = float(T.get("s") or 1.0), float(T["theta"])
    cth, sth = np.cos(th) * s_, np.sin(th) * s_
    E = cth * X - sth * (-Z) + T["tx"]
    N = sth * X + cth * (-Z) + T["ty"]
    # THE SURFACES ARCORE FOUND (planes.json, bridge 10, 2026-11-27): each plane's outline with its height over the
    # walk's ground under it (the 1 m cells' median, as for the pictures' cells)
    planes = []
    try:
        pj = json.load(open(os.path.join(d, "planes.json")))
    except Exception:
        pj = None
    if pj and fin.sum() > 100:
        for pl in pj.get("planes") or []:
            xyz = np.asarray(pl[3], np.float64).reshape(-1, 3) if len(pl) > 3 and len(pl[3]) >= 9 else None
            if xyz is None or not np.isfinite(xyz).all():
                continue
            _, nn = cKDTree(gs[brk].astype(np.float64)).query(np.floor(xyz[:, [0, 2]]))
            planes.append((int(pl[1]), xyz[:, 0], xyz[:, 2], xyz[:, 1] - gmed[nn]))
    bx, bz = np.concatenate(BX), np.concatenate(BZ)
    built = (cth * bx - sth * (-bz) + T["tx"], sth * bx + cth * (-bz) + T["ty"], np.concatenate(BH), np.concatenate(BK), np.concatenate(BP),
             np.concatenate(BR), np.concatenate(BL))
    note += f"; {len(bx):,} cells on built things off the ground"
    if pj is not None:
        note += f"; ARCore's surfaces: {sum(1 for p_ in planes if p_[0] == 2)} walls, {sum(1 for p_ in planes if p_[0] == 0)} facing up, {sum(1 for p_ in planes if p_[0] == 1)} facing down"
    planes = [(k_, cth * px - sth * (-pz) + T["tx"], sth * px + cth * (-pz) + T["ty"], ph) for k_, px, pz, ph in planes]
    # A WALK THAT IS NOT IN PLACE PUTS ITS WALLS IN THE WRONG PLACE (the owner, 2026-11-27: "the actual position of the
    # colors is pretty chaotic. For the most part they bulge out from the true building"; the S4 runs of that night had
    # the newest walk's corners agreeing only within 37 in, and two walks sitting 6 ft north of it): its built things
    # are left out when its corners agree no better than BUILT_FIT_M
    worst = float(fit.get("worstM") or 0)
    if worst <= BUILT_FIT_M:
        for yx_, yz_, yi_ in YARD_CELLS:
            YARD_MAP.append((cth * yx_ - sth * (-yz_) + T["tx"], sth * yx_ + cth * (-yz_) + T["ty"], yi_))
    YARD_CELLS.clear()
    if worst > BUILT_FIT_M and fit.get("by") != "the reference":
        built = tuple(a_[:0] for a_ in built); planes = []
        note += f"; ITS BUILT THINGS LEFT OUT (its corners agree only within {worst * 39.37:.0f} in)"
    return E, N, L, K, C, A, Src, Rg, built, planes, note + f"; its {fit.get('n')} corners agree within {(fit.get('worstM') or 0) * 39.37:.0f} in."


def main():
    global CELL, REACH, SMOOTH, COLOUR, ADE
    a = [x for x in sys.argv[1:] if x not in ("--nocast", "--smooth", "--colour", "--ade")]
    SMOOTH, COLOUR, ADE = "--smooth" in sys.argv, "--colour" in sys.argv, "--ade" in sys.argv
    if "--reach" in a:     # metres: how far a picture's depth is cast onto the ground (CAST_MAX_M by default)
        i = a.index("--reach"); REACH = float(a[i + 1]); a = a[:i] + a[i + 2:]
    edits = None
    if "--edits" in a:     # the owner's erasures (edits/<map>.json): a ground square erased is not called
        i = a.index("--edits"); ef = a[i + 1]; a = a[:i] + a[i + 2:]
        try:
            edits = json.load(open(ef))
        except Exception:
            edits = None
    lidar_b = None
    if "--lidar" in a:     # the lidar's built things on the map's squares (lidar-built.mjs): each checked by the walks
        i = a.index("--lidar"); lf = a[i + 1]; a = a[:i] + a[i + 2:]
        try:
            lidar_b = json.load(open(lf))
        except Exception:
            lidar_b = None
    plants = None
    if "--plants" in a:    # the map's plants as one (plants-pool.mjs): a plant standing on a square takes it from the ground; brown near a plant is leaves
        i = a.index("--plants"); pf = a[i + 1]; a = a[:i] + a[i + 2:]
        try:
            plants = json.load(open(pf))
        except Exception:
            plants = None
    keep = None
    if "--keep" in a:      # where to write the phone's squares for the map (surfaces-keep.mjs puts them beside the map)
        i = a.index("--keep"); keep = a[i + 1]; a = a[:i] + a[i + 2:]
    if "--feet" in a:      # the squares' size (run 570: at 1 ft the walk's paving broke into 30 pieces, three points a square being few)
        i = a.index("--feet"); CELL = float(a[i + 1]) / FT; a = a[:i] + a[i + 2:]
    if not a or not all(os.path.isdir(x) for x in a):
        print("usage: surfaces.py <twin dir> [more twin dirs of the same lot ...]")
        return 1
    # SEVERAL WALKS TOGETHER (the owner, 2026-11-25: "that's how this will be intended to function, the walks are
    # cumulative"): each walk's ground put on the map by its OWN corners' fit, then pooled square by square.
    Es, Ns, Ls, Ks, Cs, As, said, have_vote = [], [], [], [], [], [], [], True
    Ss, Rs, Bs, Ps = [], [], [], []
    for d in a:
        got = load_walk(d)
        if got is None:
            continue
        e_, n_, l_, k_, c_, a_, src_, rg_, b_, pl_, note = got
        Ps.append(pl_)
        Es.append(e_); Ns.append(n_); Ls.append(l_); Cs.append(c_); As.append(a_); said.append(note)
        # one id for each source of a ground point: a walk's picture, or that walk's kept points as one
        Ss.append(len(Ss) * 100000 + np.where(src_ >= 0, src_, 99999)); Rs.append(rg_); Bs.append(b_)
        if k_ is None:
            have_vote = False
        Ks.append(k_ if k_ is not None else np.zeros(len(e_), np.uint8))
    if not Es:
        print("\nTHE GROUND AS THE WALKS SAW IT: no walk here could be put on the map.")
        return 0
    E, N, L, Cl, Ad = np.concatenate(Es), np.concatenate(Ns), np.concatenate(Ls), np.concatenate(Cs), np.concatenate(As)
    K = np.concatenate(Ks)
    kind = K if (have_vote or any(k.any() for k in Ks)) else None
    d = a[0]
    fit = {"n": "own"}
    ok = np.ones(len(E), bool)
    lab = L
    i0, j0 = int(np.floor(E.min() / CELL)), int(np.floor(N.min() / CELL))
    ci, cj = np.floor(E / CELL).astype(int) - i0, np.floor(N / CELL).astype(int) - j0
    W, H = ci.max() + 1, cj.max() + 1
    key = cj * W + ci

    def grid(m):
        return np.bincount(key[m], minlength=W * H).reshape(H, W)
    ways = {"THE PHONE'S OWN LABELS": (np.isin(L, PHONE_PAVED), np.isin(L, PHONE_GRASS))}
    if kind is not None:
        ways["THE PICTURES' VOTE"] = (K == TR.KINDS.index("paved"), np.isin(K, [TR.KINDS.index("grass")]))
    lawn = []
    for d_ in a:
        try:
            lawn = json.load(open(os.path.join(d_, "lawn.json"))).get("rings") or []
        except Exception:
            lawn = []
        if lawn:
            break
    print(f"\nTHE GROUND AS THE WALK{'S' if len(a) > 1 else ''} SAW IT, ON THE MAP (surfaces.py; {len(Es)} walk{'s' if len(Es) != 1 else ''}, each by its own corners; {len(E):,} ground points; squares of {CELL * FT:.0f} ft; a square called when {MIN_PTS} points or more say so and twice as many as say the other):")
    for note in said:
        print("  " + note)
    cxy = np.stack(np.meshgrid((np.arange(W) + i0 + 0.5) * CELL, (np.arange(H) + j0 + 0.5) * CELL), -1)
    lawn_in = inside(lawn, cxy[..., 0].ravel(), cxy[..., 1].ravel()).reshape(H, W) if lawn else None
    if lawn_in is not None:
        print(f"  The traced lawn: {len(lawn)} ring(s), {int(lawn_in.sum() * (CELL * FT) ** 2):,} sq ft of it on the squares the walk covers.")
    else:
        print("  The traced lawn: not read (no lawn.json): nothing compared with it.")
    # DO THE WALKS AGREE WITH EACH OTHER? (CLAUDE.md: "prove a step by the walk agreeing with itself".) Each walk's own
    # squares by the phone's labels; where two walks both call a square, how often they call it the same; and how far
    # one walk's paving edge lies from the other's (an edge moved is the walks' fits disagreeing, or the labels).
    if len(Es) > 1:
        from scipy import ndimage as _nd
        ends = np.cumsum([len(e) for e in Es]); own = []
        for q, e1 in enumerate(ends):
            sel = np.zeros(len(E), bool); sel[(ends[q - 1] if q else 0):e1] = True
            P_, G_ = grid(sel & np.isin(L, PHONE_PAVED)), grid(sel & np.isin(L, PHONE_GRASS))
            own.append(((P_ >= MIN_PTS) & (P_ >= 2 * G_), (G_ >= MIN_PTS) & (G_ >= 2 * P_)))
        for q in range(len(own)):
            for r in range(q + 1, len(own)):
                (p1, g1), (p2, g2) = own[q], own[r]
                both = (p1 | g1) & (p2 | g2); same = (p1 & p2) | (g1 & g2)
                line = f"  WALK {q + 1} AGAINST WALK {r + 1}: both call {int(both.sum() * (CELL * FT) ** 2):,} sq ft; the same on {100 * same.sum() / max(1, both.sum()):.1f}% of it"
                if p1.any() and p2.any():
                    d12 = _nd.distance_transform_edt(~p2)[p1] * CELL * FT; d21 = _nd.distance_transform_edt(~p1)[p2] * CELL * FT
                    seen2, seen1 = (p2 | g2)[p1], (p1 | g1)[p2]     # only where the other walk looked at all
                    if seen2.any() and seen1.any():
                        dd = np.r_[d12[seen2], d21[seen1]]
                        line += f"; one's paving squares the other also looked at lie from the other's paving: {100 * (dd == 0).mean():.0f}% on it, {100 * (dd <= 1).mean():.0f}% within 1 ft, {100 * (dd <= 2).mean():.0f}% within 2 ft, the worst {dd.max():.0f} ft"
                print(line + ".")
    out = {}
    SQ = (CELL * FT) ** 2           # square feet in a square
    # POROUS GROUND IS NOT GRASS (the owner, 2026-11-24, later the same day: "woodchips and moss count as bare soil, so
    # let's call it 'porous ground'. I'm undecided if stones should fall into that category"; and before: "sometimes turf runs up against edges of bare dirt, so we atleast
    # need to not count bare areas larger than like 4 sqft as grass"). The phone's "terrain" is grass and bare ground
    # alike; the pictures' vote tells them apart. A square is BARE when half or more of its ground points the vote
    # called bare ground; bare pieces of BARE_MIN_SQFT or more are taken out of the grass, smaller ones left in.
    BARE = (K == TR.KINDS.index("bare ground")) if kind is not None else np.zeros(len(L), bool)
    Bg, Tg = grid(BARE), grid((K > 0) if kind is not None else np.ones(len(L), bool))   # of the points the vote spoke for
    bare_sq = (Bg >= MIN_PTS) & (Bg * 2 >= Tg)
    from scipy import ndimage
    import ground_fill as GF
    blab, bn = ndimage.label(bare_sq, structure=np.ones((3, 3)))
    bsize = np.bincount(blab.ravel())
    big_bare = bare_sq & (bsize[blab] * (CELL * FT) ** 2 >= BARE_MIN_SQFT)
    # BY THE GROUND'S OWN COLOUR (--colour): of the phone's terrain, green against brown, square by square
    terr = np.isin(L, PHONE_GRASS)
    Gc, Bc = grid(terr & (Cl == COLOUR_GREEN)), grid(terr & (Cl == COLOUR_BROWN))
    coloured = (Gc + Bc) >= MIN_PTS
    green_sq = coloured & (Gc >= 2 * Bc)
    brown_sq = coloured & (Bc >= 2 * Gc)
    # the plants the walks saw, on the same squares (plants-pool.mjs boxes: [i, j, lo dm, hi dm], foot squares of the map)
    plant_any = np.zeros((H, W), bool); plant_ground = np.zeros((H, W), bool)
    if plants and plants.get("boxes"):
        pc = float(plants.get("cellM") or CELL)
        for bi, bj, blo, bhi in plants["boxes"]:
            c_, r_ = int(np.floor((bi + 0.5) * pc / CELL)) - i0, int(np.floor((bj + 0.5) * pc / CELL)) - j0
            if 0 <= c_ < W and 0 <= r_ < H:
                plant_any[r_, c_] = True
                if blo <= PLANT_GROUND_DM:
                    plant_ground[r_, c_] = True
    reach_sq = int(round(LEAF_REACH_FT / (CELL * FT)))
    near_plant = ndimage.binary_dilation(plant_any, structure=np.ones((3, 3)), iterations=max(1, reach_sq)) if plant_any.any() else plant_any
    leaves = brown_sq & near_plant
    porous_colour = brown_sq & ~near_plant
    plab, pn = ndimage.label(porous_colour, structure=np.ones((3, 3)))
    psize = np.bincount(plab.ravel())
    big_porous = porous_colour & (psize[plab] * (CELL * FT) ** 2 >= BARE_MIN_SQFT)
    if COLOUR:
        print(f"  THE GROUND'S OWN COLOUR: of {int(terr.sum()):,} terrain points {int((terr & (Cl == COLOUR_GREEN)).sum()):,} green, {int((terr & (Cl == COLOUR_BROWN)).sum()):,} brown, {int((terr & (Cl == COLOUR_UNKNOWN)).sum()):,} with no colour; "
              f"squares green {int(green_sq.sum() * (CELL * FT) ** 2):,} sq ft, brown {int(brown_sq.sum() * (CELL * FT) ** 2):,} (of it within {LEAF_REACH_FT} ft of a plant, so taken for LEAVES and not called: {int(leaves.sum() * (CELL * FT) ** 2):,}; "
              f"POROUS GROUND away from plants in patches of {BARE_MIN_SQFT} sq ft or more: {int(big_porous.sum() * (CELL * FT) ** 2):,}).")
    if COLOUR and len(Es) > 1:
        # the same question of the colour: where both walks call a square green or brown, how often alike
        ends = np.cumsum([len(e) for e in Es]); cper = []
        for q, e1 in enumerate(ends):
            sel = np.zeros(len(E), bool); sel[(ends[q - 1] if q else 0):e1] = True
            g_, b_ = grid(sel & terr & (Cl == COLOUR_GREEN)), grid(sel & terr & (Cl == COLOUR_BROWN))
            cper.append(((g_ + b_ >= MIN_PTS) & (g_ >= 2 * b_), (g_ + b_ >= MIN_PTS) & (b_ >= 2 * g_)))
        for q in range(len(cper)):
            for r in range(q + 1, len(cper)):
                (g1, b1), (g2, b2) = cper[q], cper[r]
                both = (g1 | b1) & (g2 | b2); same = (g1 & g2) | (b1 & b2)
                print(f"  THE COLOUR, WALK {q + 1} AGAINST WALK {r + 1}: both call {int(both.sum() * (CELL * FT) ** 2):,} sq ft green or brown; the same on {100 * same.sum() / max(1, both.sum()):.1f}% of it; brown where the other says green {int(((b1 & g2) | (g1 & b2)).sum() * (CELL * FT) ** 2):,} sq ft.")
    if ADE:
        # THE SECOND LABELLER (ground_labels.py), of the cells the phone called terrain: turf, low plants, porous, one a square
        TURF, BED, POR = 1, 2, 3
        # (2026-11-26, the owner: at least 5,000 sq ft of porous ground could have been seen, and 747 was kept) the second
        # labeller speaks for every cell at the ground's height the phone did NOT call paving or a building: ARCore may
        # call mulch, soil or a bed "tree", "unlabeled" or "structure", and those cells were never counted
        gnd = np.isin(L, (1, 4, 7, 8, 9)) & (Ad > 0)
        byl = {n_: int((gnd & (L == v_) & (Ad == POR)).sum()) for n_, v_ in (("terrain", 7), ("tree", 4), ("unlabeled", 1), ("structure", 8), ("object", 9))}
        print("  THE SECOND LABELLER'S POROUS CELLS BY THE PHONE'S OWN LABEL: " + ", ".join(f"{k} {v:,}" for k, v in byl.items()) + ".")

        def ade_grids(sel):
            t_, b_, p_ = grid(sel & gnd & (Ad == TURF)), grid(sel & gnd & (Ad == BED)), grid(sel & gnd & (Ad == POR))
            tot = t_ + b_ + p_
            return {"turf": (t_ >= MIN_PTS) & (t_ >= 2 * (b_ + p_)), "low plants": (b_ >= MIN_PTS) & (b_ >= 2 * (t_ + p_)), "porous": (p_ >= MIN_PTS) & (p_ >= 2 * (t_ + b_))}, tot
        allg, tot = ade_grids(np.ones(len(E), bool))
        sq = (CELL * FT) ** 2
        print(f"  THE SECOND LABELLER: of the terrain, {int((terr & (Ad > 0)).sum()):,} cells labelled ({int((terr & (Ad == TURF)).sum()):,} turf, {int((terr & (Ad == BED)).sum()):,} low plants, {int((terr & (Ad == POR)).sum()):,} porous, {int((terr & (Ad > 3)).sum()):,} other); "
              + ", ".join(f"{k} {int(v.sum() * sq):,} sq ft" for k, v in allg.items())
              + (f"; where colour says green, the labeller says turf on {100 * (allg['turf'] & green_sq).sum() / max(1, (green_sq & (tot >= MIN_PTS)).sum()):.0f}% and low plants on {100 * (allg['low plants'] & green_sq).sum() / max(1, (green_sq & (tot >= MIN_PTS)).sum()):.0f}%" if COLOUR else "") + ".")
        if len(Es) > 1:
            ends = np.cumsum([len(e) for e in Es])
            per = []
            for q, e1 in enumerate(ends):
                sel = np.zeros(len(E), bool); sel[(ends[q - 1] if q else 0):e1] = True
                per.append(ade_grids(sel)[0])
            for q in range(len(per)):
                for r in range(q + 1, len(per)):
                    any1 = per[q]["turf"] | per[q]["low plants"] | per[q]["porous"]; any2 = per[r]["turf"] | per[r]["low plants"] | per[r]["porous"]
                    both = any1 & any2
                    same = sum((per[q][k] & per[r][k]) for k in per[q])
                    print(f"  THE SECOND LABELLER, WALK {q + 1} AGAINST WALK {r + 1}: both call {int(both.sum() * sq):,} sq ft; the same on {100 * same.sum() / max(1, both.sum()):.1f}% of it.")
    # JUDGED BY THE OWNER'S ERASURES (2026-11-26): the ground squares the owner erased as wrong, each with the kind it had
    # been drawn as. For each labeller: of the squares erased as TURF, how many it too calls turf (the same mistake) and
    # how many it calls something else; the same for paving and porous ground.
    if edits and isinstance(edits.get("erased"), list) and (COLOUR or ADE):
        f = max(1, int(round(float(edits.get("cellM") or CELL) / CELL)))
        cuts = {}
        for e in edits["erased"]:
            if len(e) >= 4 and e[0] == "g":
                for da in range(f):
                    for db in range(f):
                        c_, r_ = int(e[1]) * f + da - i0, int(e[2]) * f + db - j0
                        if 0 <= c_ < W and 0 <= r_ < H:
                            cuts.setdefault(str(e[3]), []).append((r_, c_))
        for kind_, cells in cuts.items():
            rr, cc = np.array([x[0] for x in cells]), np.array([x[1] for x in cells])
            parts = [f"{len(cells):,} erased as {kind_}"]
            if COLOUR:
                parts.append(f"the colour calls {int(green_sq[rr, cc].sum()):,} green, {int(brown_sq[rr, cc].sum()):,} brown")
            if ADE:
                ag, _ = ade_grids(np.ones(len(E), bool))
                parts.append("the second labeller calls " + ", ".join(f"{int(v[rr, cc].sum()):,} {k}" for k, v in ag.items()))
            print("  JUDGED BY THE OWNER'S ERASURES: " + "; ".join(parts) + ".")
    # BUILT THINGS ON THE MAP (2026-11-27; the owner: "add structures to the colors... There's 2 types of structures
    # really. Solid structures, and structures like decks, that water can pass through"). From every walk: the large
    # labeller's walls, pillars and doors, the phone's "building" and the pictures' vote's "built" off the ground (SOLID);
    # its floors off the ground, steps and railings (OPEN: a deck's boards let rain through); and its roofs seen from
    # under (a porch's ceiling): what stands under a roof is SOLID, for rain does not reach it, whatever it is made of.
    SRC, RNG = np.concatenate(Ss), np.concatenate(Rs)
    WI = np.repeat(np.arange(len(Es)), [len(e) for e in Es])      # each ground point's walk
    BE = np.concatenate([b[0] for b in Bs]); BN = np.concatenate([b[1] for b in Bs]); BH = np.concatenate([b[2] for b in Bs])
    BK = np.concatenate([b[3] for b in Bs]); BW = np.concatenate([np.full(len(b[0]), q, np.int32) for q, b in enumerate(Bs)])
    BR = np.concatenate([b[5] for b in Bs]); BL = np.concatenate([b[6] for b in Bs])
    BS = BW.astype(np.int64) * 100000 + np.where(np.concatenate([b[4] for b in Bs]) >= 0, np.concatenate([b[4] for b in Bs]), 99999)
    # THE TWO VETOES ON A CELL (2026-11-27): the phone's own label says it is not built (sky, tree, terrain, a car, a
    # person); or a picture saw it from further than BUILT_MAX_M
    veto_lab = (BK != 10) & np.isin(BL, NOT_BUILT)
    veto_far = np.isfinite(BR) & (BR > BUILT_MAX_M)
    bok = ~veto_lab & ~veto_far
    bstat = {}
    bci, bcj = np.floor(BE / CELL).astype(int) - i0, np.floor(BN / CELL).astype(int) - j0
    bin_ = (bci >= 0) & (bcj >= 0) & (bci < W) & (bcj < H)
    bkey = np.where(bin_, bcj * W + bci, 0)

    def bgrid(m):
        return np.bincount(bkey[m & bin_], minlength=W * H).reshape(H, W)
    ground_all = np.bincount(key, minlength=W * H).reshape(H, W)

    # ARCORE'S SURFACES, ON THE SQUARES (bridge 10): a wall's line, a floor's or a ceiling's outline, for each walk
    cxs, cys = (np.arange(W) + i0 + 0.5) * CELL, (np.arange(H) + j0 + 0.5) * CELL
    pstat = {"walls": 0, "walls kept": 0, "floors": 0, "floors kept": 0, "ceilings": 0}

    def plane_masks(q):
        wl, fl_, ce = [], [], []
        for kind_, pe, pn, ph in Ps[q]:
            if kind_ == 2:
                # a wall: the line along its outline's long axis on the ground, if it stands half a metre or more
                if ph.max() < 0.5 or ph.max() - ph.min() < 0.5:
                    continue
                xy = np.stack([pe, pn], 1); mu = xy.mean(0)
                w_, v_ = np.linalg.eigh(np.cov((xy - mu).T)) if len(xy) > 2 else (None, None)
                if v_ is None:
                    continue
                ax = v_[:, np.argmax(w_)]; t_ = (xy - mu) @ ax
                if t_.max() - t_.min() < 0.6:
                    continue
                ts = np.arange(t_.min(), t_.max(), CELL / 3)
                c_ = np.floor((mu[0] + ts * ax[0]) / CELL).astype(int) - i0; r_ = np.floor((mu[1] + ts * ax[1]) / CELL).astype(int) - j0
                ok_ = (c_ >= 0) & (r_ >= 0) & (c_ < W) & (r_ < H)
                m_ = np.zeros((H, W), bool); m_[r_[ok_], c_[ok_]] = True
                wl.append((m_, float(ph.max())))
            elif kind_ in (0, 1):
                hm = float(np.median(ph))
                if (kind_ == 0 and not (0.15 < hm < 1.8)) or (kind_ == 1 and hm < 1.8):
                    continue
                c0, c1 = max(0, int(np.floor(pe.min() / CELL)) - i0), min(W, int(np.floor(pe.max() / CELL)) - i0 + 1)
                r0, r1 = max(0, int(np.floor(pn.min() / CELL)) - j0), min(H, int(np.floor(pn.max() / CELL)) - j0 + 1)
                if c1 <= c0 or r1 <= r0:
                    continue
                gx, gy = np.meshgrid(cxs[c0:c1], cys[r0:r1])
                ins = inside([np.stack([pe, pn], 1)], gx.ravel(), gy.ravel()).reshape(gy.shape)
                if ins.sum() * SQ < (16 if kind_ == 0 else 8):
                    continue     # a table, a car's hood: a deck or a porch's floor is bigger
                m_ = np.zeros((H, W), bool); m_[r0:r1, c0:c1] = ins
                (fl_ if kind_ == 0 else ce).append((m_, hm))
        return wl, fl_, ce
    PM = [plane_masks(q) for q in range(len(Ps))]
    plane_top, plane_floor = np.zeros((H, W)), np.zeros((H, W))   # m over the ground: a wall plane's top, a floor plane's height

    def sq_stats(m):
        """Per square, of the cells m: how many, their heights' 10th, 50th and 90th percentiles, how many sources."""
        n = np.zeros(H * W); p10 = np.zeros(H * W); p50 = np.zeros(H * W); p90 = np.zeros(H * W); ns = np.zeros(H * W)
        m = m & bin_
        if m.any():
            kk, hh, ss = bkey[m], BH[m], BS[m]
            o_ = np.lexsort((hh, kk)); kk, hh, ss = kk[o_], hh[o_], ss[o_]
            br_ = np.flatnonzero(np.r_[True, np.diff(kk) != 0]); en_ = np.r_[br_[1:], len(kk)]
            cnt = en_ - br_
            q_ = lambda f: hh[br_ + np.minimum(cnt - 1, np.floor(f * (cnt - 1) + 0.5).astype(int))]
            n[kk[br_]], p10[kk[br_]], p50[kk[br_]], p90[kk[br_]] = cnt, q_(0.1), q_(0.5), q_(0.9)
            u_ = np.unique(kk * 10000000 + ss)
            ns += np.bincount((u_ // 10000000).astype(np.int64), minlength=H * W)
        return n.reshape(H, W), p10.reshape(H, W), p50.reshape(H, W), p90.reshape(H, W), ns.reshape(H, W)

    def built_of(sel, walks, say=None):
        # WHAT STANDS UP IS SOLID, WHAT LIES FLAT OFF THE GROUND IS A DECK (2026-11-27, after the owner's eyes on the first
        # map): by the shape of the cells over a square, not the label's word between "wall" and "floor" (most of the
        # large deck in the back was called solid): a wall's cells span its height, a deck's boards lie at one height.
        # And a square is built only on two sources or more (a picture, or a walk's kept points), as for the far specks.
        c = sel & bok & np.isin(BK, (8, 9)) & (BH > 0.15) & (BH <= STRUCT_TOP_M)
        n, p10, p50, p90, ns = sq_stats(c)
        enough = (n >= MIN_PTS) & (2 * n >= ground_all)
        stands0 = enough & (p90 - p10 >= STAND_M) & (p90 >= STAND_TOP_M)
        stands = stands0 & (ns >= 2)
        # a wall's smear: a square beside a wall with a fifth or less of the cells of the densest square within 2 ft
        dens = ndimage.maximum_filter(np.where(stands, n, 0), size=5)
        halo = stands & (n < HALO_SHARE * dens)
        solid = stands & ~halo
        # a small piece standing alone that does not reach a man's chest is not a wall (a pillar does)
        lab_s, ns_ = ndimage.label(solid, structure=np.ones((3, 3)))
        lone_low = np.zeros_like(solid)
        if ns_:
            sz_ = np.bincount(lab_s.ravel()); top_ = ndimage.maximum(p90, lab_s, index=np.arange(ns_ + 1))
            small_low = (sz_ * SQ <= GF.SPECK_SQFT) & (np.asarray(top_) < 1.2); small_low[0] = False
            lone_low = small_low[lab_s]
            solid = solid & ~lone_low
        flat0 = enough & (p90 - p10 < FLAT_M) & (p50 >= DECK_M[0]) & (p50 <= DECK_M[1]) & ~stands0
        flat = flat0 & (ns >= 2)
        # flat pieces within 2 ft of each other are one deck (S4 of 10:44 pm Thu: 138 sq ft of 187 lying flat fell in
        # pieces under 16 sq ft: the boards are seen in patches between railings, chairs and the parts not looked at)
        lab_f, nf_ = ndimage.label(ndimage.binary_dilation(flat, structure=np.ones((3, 3))) if flat.any() else flat, structure=np.ones((3, 3)))
        deck = flat
        if nf_:
            szf = np.bincount(lab_f[flat], minlength=nf_ + 1); bigf = szf * SQ >= DECK_MIN_SQFT; bigf[0] = False
            deck = flat & bigf[lab_f]
        if say is not None:
            say.update({"one source": int(((stands0 | flat0) & (ns < 2)).sum()), "smear": int(halo.sum()), "low lone": int(lone_low.sum()),
                        "small flat": int((flat & ~deck).sum()), "flat": int(flat.sum())})
        fl = bgrid(c & (BK == 9))
        rf = bgrid(sel & bok & (BK == 10) & (BH > 1.8))
        # a wall ARCore found, along a built thing the labels saw for 30% of its length or more, is a wall all along:
        # the gaps between what the labels saw filled (a fence's plane, with no building seen along it, is not)
        near1 = ndimage.binary_dilation(solid, structure=np.ones((3, 3)), iterations=1) if solid.any() else solid
        add_w = np.zeros_like(solid)
        for q in walks:
            for m_, top_ in PM[q][0]:
                pstat["walls"] += 1
                if (m_ & near1).sum() >= 0.3 * m_.sum():
                    add_w |= m_; pstat["walls kept"] += 1
                    plane_top[m_] = np.maximum(plane_top[m_], top_)
        solid = solid | add_w
        # a floor ARCore found off the ground, where the labels saw a floor or the cells lie flat on a fifth of it or more, is a floor all over
        add_f = np.zeros_like(solid)
        for q in walks:
            for m_, top_ in PM[q][1]:
                pstat["floors"] += 1
                if (((fl > 0) | flat0) & m_).sum() >= 0.2 * m_.sum():
                    add_f |= m_; pstat["floors kept"] += 1
                    plane_floor[m_] = top_
        deck = (deck | add_f) & ~solid
        near_solid = ndimage.binary_dilation(solid, structure=np.ones((3, 3)), iterations=max(1, int(round(12 / (CELL * FT))))) if solid.any() else solid
        ceil = np.zeros_like(solid)
        for q in walks:
            for m_, _h in PM[q][2]:
                pstat["ceilings"] += 1; ceil |= m_
        roofed = ((rf >= MIN_PTS) | ceil) & near_solid
        return solid | roofed | (deck & roofed), deck & ~roofed, roofed
    solid_sq, deck_sq, roofed_sq = built_of(np.ones(len(BE), bool), range(len(Ps)), bstat)
    # HOW HIGH (for the fused model; the features session, 2026-11-27: "Without it a wall or shed has no top, and a deck
    # has no height for its boards"): a solid square's top is the highest built cell over it (or its wall plane's
    # top), a deck's boards the median height of the floor cells on it (or its floor plane's)
    _n, _p10, p50_all, p90_all, _ns = sq_stats(bok & np.isin(BK, (8, 9)) & (BH > 0.15) & (BH <= STRUCT_TOP_M))
    top_solid = np.maximum(p90_all, plane_top)
    top_deck = np.where(plane_floor > 0, plane_floor, p50_all)
    looked = (ground_all > 0) | (bgrid(np.ones(len(BE), bool)) > 0)
    # THE LIDAR'S SHAPES, CHECKED (--lidar; 2026-11-27, the owner: "more of a broad 'lidar says there's a building here.
    # Yup there is, but the shape is a bit off' or 'it's a deck, not a building'"). Each lidar building and low
    # structure is a shape; the walks' cells say, shape by shape: confirmed, and where its walls stand (moved in or out
    # from the lidar's edge, a stretch at a time); a deck; a tree, not a structure; or not looked at (kept, walls 2 ft
    # in). The lidar is the second witness, so a wall on ONE source counts beside a lidar edge. Solid and open then come
    # from the shapes, and from the walks alone only in pieces of WALK_ONLY_SQFT or more away from any shape.
    not_built = np.zeros((H, W), bool)     # lidar built squares the walks say are not built (a tree read as one; where a tree touches)
    if lidar_b is not None:
        from scipy.spatial import cKDTree
        lk_ = np.frombuffer(zlib.decompress(base64.b64decode(lidar_b["kinds"])), np.uint8).reshape(lidar_b["h"], lidar_b["w"])
        lt_ = np.frombuffer(zlib.decompress(base64.b64decode(lidar_b["tops"])), np.uint8).reshape(lidar_b["h"], lidar_b["w"])
        LK, LT = np.zeros((H, W), np.uint8), np.zeros((H, W))
        oi, oj = i0 - int(lidar_b["i0"]), j0 - int(lidar_b["j0"])
        ys_, xs_ = np.mgrid[0:H, 0:W]
        sy, sx = ys_ + oj, xs_ + oi
        inl = (sy >= 0) & (sx >= 0) & (sy < lidar_b["h"]) & (sx < lidar_b["w"])
        LK[inl] = lk_[sy[inl], sx[inl]]; LT[inl] = lt_[sy[inl], sx[inl]] / 10.0
        cw_ = bok & np.isin(BK, (8, 9)) & (BH > 0.15) & (BH <= STRUCT_TOP_M)
        nw, p10w, p50w, p90w, nsw = sq_stats(cw_)
        enough_w = (nw >= MIN_PTS) & (2 * nw >= ground_all)
        wall_w = enough_w & (p90w - p10w >= STAND_M) & (p90w >= STAND_TOP_M)
        flat_w = enough_w & (p90w - p10w < FLAT_M) & (p50w >= DECK_M[0]) & (p50w <= DECK_M[1]) & ~wall_w
        near_look = ndimage.binary_dilation(looked, structure=np.ones((3, 3)), iterations=3)
        ft_sq = CELL * FT
        l_solid, l_deck = np.zeros((H, W), bool), np.zeros((H, W), bool)
        l_top = np.zeros((H, W))
        claimed = np.zeros((H, W), bool)       # a shape's footprint and the band round it: no walls of the walks' own there
        claimed_fp = np.zeros((H, W), bool)    # the footprints alone: no deck of the walks' own there (a deck beside a house is in its band)
        deck_part = 0
        new_add = 0
        align_rows = {}                        # walk -> [(outward directions, how far its walls sit out from the others')]
        wall_q = []                            # each walk's own walls
        plane_q = []                           # each walk's ARCore wall planes (app 1.28): one smooth surface, not scattered cells
        for q in range(len(Bs)):
            nq_, p10q, _p50q, p90q, _nsq = sq_stats(cw_ & (BW == q))
            pq_ = np.zeros((H, W), bool)
            for m_, _top in (PM[q][0] if q < len(PM) else []):
                pq_ |= m_
            plane_q.append(pq_)
            wall_q.append(((nq_ >= MIN_PTS) & (p90q - p10q >= STAND_M) & (p90q >= STAND_TOP_M)) | pq_)
        plane_all = np.zeros((H, W), bool)
        for pq_ in plane_q:
            plane_all |= pq_
        n_plane_edges = 0
        shapes_info = []                       # (lidar kind, footprint, its corner, the verdict) for the yard labels' study
        verdict = {"confirmed": [], "deck": 0, "tree": 0, "unseen": 0, "nothing": 0}
        offs_all, trimmed_tree, moved_in, moved_out = [], 0, 0, 0
        band_sq = int(np.ceil(LIDAR_BAND_FT / ft_sq))
        for lk_kind in (1, 4):
            lab_l, nl_ = ndimage.label(LK == lk_kind, structure=np.ones((3, 3)))
            for o, sl in enumerate(ndimage.find_objects(lab_l), start=1):
                if sl is None:
                    continue
                y0, y1 = max(0, sl[0].start - band_sq - 1), min(H, sl[0].stop + band_sq + 1)
                x0, x1 = max(0, sl[1].start - band_sq - 1), min(W, sl[1].stop + band_sq + 1)
                fp = lab_l[y0:y1, x0:x1] == o
                if fp.sum() * SQ < 4:
                    continue
                d_in, d_out = ndimage.distance_transform_edt(fp), ndimage.distance_transform_edt(~fp)
                sd = np.where(fp, d_in - 0.5, -(d_out - 0.5)) * ft_sq          # ft, + inside the lidar's edge
                band = np.abs(sd) <= LIDAR_BAND_FT
                walls = (wall_w[y0:y1, x0:x1] | plane_all[y0:y1, x0:x1]) & band
                is_plane = plane_all[y0:y1, x0:x1]
                edge = fp & (d_in <= 1)
                ey, ex = np.nonzero(edge)
                seen_e = near_look[y0:y1, x0:x1][edge]
                seen_share = seen_e.mean() if len(seen_e) else 0.0
                top_o = float(np.median(LT[y0:y1, x0:x1][fp])) if fp.any() else 0.0
                flat_l = flat_w[y0:y1, x0:x1] & (fp | band)
                looked_fp = (near_look[y0:y1, x0:x1] & fp).sum()
                # a deck: a low shape whose boards lie flat over a good share of what the walks looked at of it
                if top_o <= DECK_TOP_M and looked_fp and (flat_l & fp).sum() >= DECK_SHARE * looked_fp and (flat_l & fp).sum() > (walls & fp).sum():
                    sub = l_deck[y0:y1, x0:x1]; sub |= (fp | flat_l)
                    l_top[y0:y1, x0:x1] = np.where(fp | flat_l, np.where(p50w[y0:y1, x0:x1] > 0, p50w[y0:y1, x0:x1], LT[y0:y1, x0:x1]), l_top[y0:y1, x0:x1])
                    claimed[y0:y1, x0:x1] |= fp | band
                    claimed_fp[y0:y1, x0:x1] |= fp | flat_l
                    verdict["deck"] += 1
                    shapes_info.append((lk_kind, fp, y0, x0, "a deck"))
                    continue
                # walls along the edge: each edge square takes the median offset of the walls within WALL_NEAR_FT ON ITS
                # OWN FACE (the owner's picture, SCAN-PLAN 91: at a step in a wall the walls of both faces were mixed and
                # the step rounded off, filled on one side and cut on the other): a wall belongs to the face of its
                # nearest edge square, and counts for an edge square whose outward direction is within 45 degrees of it
                gyy, gxx = np.gradient(sd)
                nrm = -np.stack([gxx, gyy], -1); nrm /= np.maximum(1e-9, np.linalg.norm(nrm, axis=-1, keepdims=True))   # outward, (east, north)
                ne_ = nrm[ey, ex]
                wy, wx = np.nonzero(walls)
                off = np.full(len(ey), np.nan); nwalks = np.zeros(len(ey), int); spread_q = np.full(len(ey), np.inf)
                offq = np.full((len(Bs), len(ey)), np.nan)
                if len(wy):
                    _, w_edge = cKDTree(np.c_[ey, ex].astype(float)).query(np.c_[wy, wx].astype(float))
                    w_face = ne_[w_edge]
                    w_bits = np.zeros(len(wy), np.int64)
                    for q in range(len(Bs)):
                        w_bits |= (wall_q[q][y0:y1, x0:x1][wy, wx] | plane_q[q][y0:y1, x0:x1][wy, wx]).astype(np.int64) << q
                    tw = cKDTree(np.c_[wy, wx].astype(float))
                    for q_, (yy, xx) in enumerate(zip(ey, ex)):
                        nb = np.asarray(tw.query_ball_point([yy, xx], WALL_NEAR_FT / ft_sq), int)
                        if len(nb):
                            nb = nb[(w_face[nb] @ ne_[q_]) > 0.7]
                        # an ARCore plane on this face says where the wall is better than the cells do: it alone, if there
                        if len(nb) and is_plane[wy[nb], wx[nb]].sum() >= 2:
                            nb = nb[is_plane[wy[nb], wx[nb]]]
                            n_plane_edges += 1
                        if len(nb) >= 2:
                            off[q_] = float(np.median(sd[wy[nb], wx[nb]]))
                            bits = int(np.bitwise_or.reduce(w_bits[nb]))
                            nwalks[q_] = bin(bits).count("1")
                            for q in range(len(Bs)):
                                mq = nb[(w_bits[nb] >> q) & 1 == 1]
                                if len(mq) >= 2:
                                    offq[q, q_] = float(np.median(sd[wy[mq], wx[mq]]))
                            fq = offq[:, q_][np.isfinite(offq[:, q_])]
                            if len(fq) >= 2:
                                spread_q[q_] = float(fq.max() - fq.min())
                has = np.isfinite(off)
                wall_share = has[seen_e].mean() if seen_e.any() else 0.0
                plants_here = plant_any[y0:y1, x0:x1] & fp
                if seen_share >= SEEN_SHARE and wall_share < 0.05 and looked_fp and plants_here.sum() >= 0.5 * fp.sum():
                    verdict["tree"] += 1          # seen round, no wall anywhere, and a plant over most of it: a tree
                    shapes_info.append((lk_kind, fp, y0, x0, "a tree"))
                    claimed[y0:y1, x0:x1] |= fp
                    claimed_fp[y0:y1, x0:x1] |= fp
                    nb_ = not_built[y0:y1, x0:x1]; nb_ |= fp
                    continue
                default = WALL_INSET_FT if lk_kind == 1 else 0.0
                # ONE OFFSET A FACE (S4 run 46051580289: the walks sit within 0.4 ft of each other, but each walk's walls
                # scatter about 1 ft on a face, and a stretch of 4 ft followed the scatter: the owner's "chaotic", the
                # bulges and the false hole). A face is a run of edge squares facing the same way (eight ways); it takes
                # the median of every wall offset found along it, unless two walks agree on more than a foot out there
                # (an addition: kept to its own stretch)
                if has.any():
                    ang = (np.round(np.arctan2(ne_[:, 1], ne_[:, 0]) / (np.pi / 4)).astype(int)) % 8
                    face_id = np.full(len(ey), -1)
                    nf = 0
                    for a_ in range(8):
                        sel = ang == a_
                        if not sel.any():
                            continue
                        mk = np.zeros(fp.shape, bool); mk[ey[sel], ex[sel]] = True
                        lab_e, n_e = ndimage.label(mk, structure=np.ones((3, 3)))
                        face_id[sel] = lab_e[ey[sel], ex[sel]] - 1 + nf
                        nf += n_e
                    keep_own = (off < -WALL_OUT_MAX_FT) & (nwalks >= 2) & (spread_q <= ADD_AGREE_FT)
                    for f_ in range(nf):
                        mf = face_id == f_
                        vf = mf & has & ~keep_own
                        if vf.sum() >= 2:
                            off[mf & ~keep_own] = float(np.median(off[vf]))
                            has = has | (mf & ~keep_own)
                if has.any():
                    te = cKDTree(np.c_[ey[has], ex[has]].astype(float))
                    for q_ in np.flatnonzero(~has):
                        nb = te.query_ball_point([ey[q_], ex[q_]], WALL_SPREAD_FT / ft_sq)
                        off[q_] = float(np.median(off[has][nb])) if nb else default
                else:
                    off[:] = default
                # OUT BY MORE THAN A FOOT only where two walks or more put the wall there and agree within ADD_AGREE_FT
                # (the owner: "we should be able to see if there's a genuine new addition to a building since the lidar
                # was flown")
                added = (off < -WALL_OUT_MAX_FT) & (nwalks >= 2) & (spread_q <= ADD_AGREE_FT)
                new_add += int(added.sum())
                off = np.where(added, np.clip(off, -LIDAR_BAND_FT, WALL_IN_MAX_FT), np.clip(off, -WALL_OUT_MAX_FT, WALL_IN_MAX_FT))
                if wall_share >= CONFIRM_SHARE:
                    verdict["confirmed"].append(float(np.median(off[has])))
                    # EACH WALK'S WALLS AGAINST THE OTHERS' on the same face (the owner: "get the auto alignment and checks
                    # better so we fix the problem at the source"): a walk put d ft off moves its walls by d along each
                    # face's outward direction; the shift that best explains how far its walls sit from the others'
                    for q in range(len(Bs)):
                        with np.errstate(all="ignore"), __import__("warnings").catch_warnings():
                            __import__("warnings").simplefilter("ignore")
                            oth = np.nanmedian(np.where(np.arange(len(Bs))[:, None] == q, np.nan, offq), axis=0) if len(Bs) > 1 else np.full(len(ey), np.nan)
                        okq = np.isfinite(offq[q]) & np.isfinite(oth)
                        if okq.any():
                            align_rows.setdefault(q, []).append((ne_[okq], -(offq[q][okq] - oth[okq])))
                    shapes_info.append((lk_kind, fp, y0, x0, "confirmed"))
                    offs_all += list(off[has])
                elif seen_share >= SEEN_SHARE:
                    verdict["nothing"] += 1
                    shapes_info.append((lk_kind, fp, y0, x0, "looked round, no wall"))
                else:
                    verdict["unseen"] += 1
                    shapes_info.append((lk_kind, fp, y0, x0, "not looked at enough"))
                # the shape again: each square inside the line its nearest edge square's walls make
                cand = sd >= -LIDAR_BAND_FT
                cy_, cx_ = np.nonzero(cand)
                _, ne = cKDTree(np.c_[ey, ex].astype(float)).query(np.c_[cy_, cx_].astype(float))
                newfp = np.zeros_like(fp)
                newfp[cy_, cx_] = sd[cy_, cx_] >= off[ne] - 0.5 * ft_sq
                # where a tree touches: an edge stretch with no wall seen, under a plant standing on the ground, is cut
                treecut = newfp & plant_ground[y0:y1, x0:x1] & ~ndimage.binary_dilation(walls, structure=np.ones((3, 3)), iterations=int(np.ceil(WALL_NEAR_FT / ft_sq)))
                newfp &= ~treecut
                nb_ = not_built[y0:y1, x0:x1]; nb_ |= treecut & fp
                trimmed_tree += int(treecut.sum())
                # A DECK INSIDE A SHAPE (S4 of 12:28 am Fri: the back deck was taken in by the house's shape and the band
                # round it, and no deck at all was left): boards lying flat over 16 sq ft or more of it, with the lidar's
                # top no more than 1.5 m over them (a railing; a porch's floor has its roof far over it) and no roof seen
                # from under, are a deck, not the building
                dp = newfp & flat_w[y0:y1, x0:x1] & (LT[y0:y1, x0:x1] - p50w[y0:y1, x0:x1] <= 1.5) & ~roofed_sq[y0:y1, x0:x1]
                if dp.any():
                    lab_d, nd_ = ndimage.label(ndimage.binary_dilation(dp, structure=np.ones((3, 3))), structure=np.ones((3, 3)))
                    szd = np.bincount(lab_d[dp], minlength=nd_ + 1); bigd = szd * SQ >= DECK_MIN_SQFT; bigd[0] = False
                    dp = dp & bigd[lab_d]
                if dp.any():
                    newfp &= ~dp
                    sub = l_deck[y0:y1, x0:x1]; sub |= dp
                    l_top[y0:y1, x0:x1] = np.where(dp, p50w[y0:y1, x0:x1], l_top[y0:y1, x0:x1])
                    deck_part += int(dp.sum())
                moved_in += int((fp & ~newfp).sum()); moved_out += int((newfp & ~fp).sum())
                sub = l_solid[y0:y1, x0:x1]; sub |= newfp
                l_top[y0:y1, x0:x1] = np.where(newfp, np.maximum(LT[y0:y1, x0:x1], np.where(walls, p90w[y0:y1, x0:x1], 0)), l_top[y0:y1, x0:x1])
                claimed[y0:y1, x0:x1] |= newfp | band
                claimed_fp[y0:y1, x0:x1] |= newfp
        # what the walks alone saw, away from every lidar shape: decks as before; solid only in pieces of WALK_ONLY_SQFT or more
        w_solid = solid_sq & ~roofed_sq & ~claimed
        lab_w, nw_ = ndimage.label(w_solid, structure=np.ones((3, 3)))
        if nw_:
            szw = np.bincount(lab_w.ravel()); bigw = szw * SQ >= WALK_ONLY_SQFT; bigw[0] = False
            w_solid = bigw[lab_w]
        w_deck = deck_sq & ~claimed_fp
        roofed_l = roofed_sq & ndimage.binary_dilation(l_solid | w_solid, structure=np.ones((3, 3)), iterations=max(1, int(round(12 / ft_sq)))) if (l_solid | w_solid).any() else np.zeros_like(roofed_sq)
        top_solid = np.where(l_solid, l_top, top_solid)
        top_deck = np.where(l_deck, l_top, top_deck)
        solid_sq = (l_solid | w_solid | roofed_l) & ~l_deck
        deck_sq = (l_deck | w_deck) & ~solid_sq
        cf = verdict["confirmed"]
        yard_study(shapes_info, H, W, i0, j0, SQ)
        if align_rows:
            parts_ = []
            for q in sorted(align_rows):
                Nq = np.concatenate([a_[0] for a_ in align_rows[q]]); dq = np.concatenate([a_[1] for a_ in align_rows[q]])
                if len(dq) < 6 or np.linalg.matrix_rank(Nq) < 2:
                    parts_.append(f"walk {q + 1}: too few faces ({len(dq)} edge squares)")
                    continue
                sh, *_ = np.linalg.lstsq(Nq, dq, rcond=None)
                res_ = dq - Nq @ sh
                parts_.append(f"walk {q + 1}: {sh[0] * ft_sq:+.1f} ft east, {sh[1] * ft_sq:+.1f} ft north (from {len(dq):,} edge squares of walls; left over after the shift {np.sqrt(np.mean(res_ ** 2)) * ft_sq:.1f} ft)")
            print("  THE WALKS' WALLS AGAINST EACH OTHER (each walk's walls on a confirmed shape's faces against the other walks' walls on the same faces; the shift that best explains the gaps): " + "; ".join(parts_) + ".")
        print(f"  THE LIDAR'S SHAPES, CHECKED BY THE WALKS: {len(cf) + verdict['deck'] + verdict['tree'] + verdict['nothing'] + verdict['unseen']} shapes (buildings and low structures); "
              f"confirmed with their walls placed {len(cf)}" + (f" (the walls, by stretches, in the middle {np.median(offs_all):+.1f} ft from the lidar's edge, inward +, from {np.percentile(offs_all, 10):+.1f} to {np.percentile(offs_all, 90):+.1f})" if offs_all else "")
              + f"; a deck, not a building {verdict['deck']} (and decks inside a shape {int(deck_part * SQ):,} sq ft); a tree, not a structure {verdict['tree']}; looked round but no wall found {verdict['nothing']} (kept, walls {WALL_INSET_FT} ft in); not looked at enough to judge {verdict['unseen']} (kept so).")
        print(f"     THE SHAPES MADE AGAIN: {int(moved_in * SQ):,} sq ft of the lidar's shapes outside their walls taken off, {int(moved_out * SQ):,} sq ft added where the walls stand outside the lidar's edge; "
              f"{int(trimmed_tree * SQ):,} sq ft cut where a tree touches and no wall was seen; edge squares moved out more than {WALL_OUT_MAX_FT} ft by two walks or more agreeing (an addition since the flight?) {new_add:,}; edge squares placed by ARCore's wall planes {n_plane_edges:,}. SOLID {int(solid_sq.sum() * SQ):,} sq ft ({int((l_solid & solid_sq).sum() * SQ):,} from the lidar's shapes, {int(w_solid.sum() * SQ):,} from the walks alone), "
              f"OPEN {int(deck_sq.sum() * SQ):,} sq ft ({int(l_deck.sum() * SQ):,} from the lidar's shapes, {int((w_deck & deck_sq & ~l_deck).sum() * SQ):,} from the walks alone).")
    if any(Ps):
        print(f"  ARCORE'S SURFACES: {pstat['walls']} walls, {pstat['walls kept']} of them along built things the labels saw (the rest, a fence or a hedge, left out); {pstat['floors']} floors off the ground of 16 sq ft or more, {pstat['floors kept']} where the labels saw a floor; {pstat['ceilings']} ceilings over 6 ft.")
    print(f"  BUILT THINGS: {len(BE):,} cells off the ground ({int((BK == 8).sum()):,} walls, pillars, doors; {int((BK == 9).sum()):,} floors, steps, railings; {int((BK == 10).sum()):,} roofs seen from under); "
          f"SOLID {int(solid_sq.sum() * SQ):,} sq ft (of it under a roof seen from below {int((roofed_sq & solid_sq).sum() * SQ):,}), OPEN (a deck's boards) {int(deck_sq.sum() * SQ):,} sq ft.")
    print(f"  BUILT, WHAT WAS LEFT OUT: cells the phone's own label says are sky, a tree, terrain, a car or a person {int(veto_lab.sum()):,}; "
          f"cells a picture saw from further than {BUILT_MAX_M * FT:.0f} ft {int((veto_far & ~veto_lab).sum()):,}; squares on one source only {int(bstat.get('one source', 0) * SQ):,} sq ft; "
          f"a wall's smear (a fifth or less of the cells of the densest square within 2 ft) {int(bstat.get('smear', 0) * SQ):,} sq ft; small pieces standing alone lower than 4 ft {int(bstat.get('low lone', 0) * SQ):,} sq ft; "
          f"flat pieces smaller than {DECK_MIN_SQFT} sq ft (those within 2 ft of each other taken as one) {int(bstat.get('small flat', 0) * SQ):,} sq ft. Lying flat {DECK_M[0] * FT:.0f}-{DECK_M[1] * FT:.0f} ft up (a deck's boards, by shape): {int(bstat.get('flat', 0) * SQ):,} sq ft.")
    if len(Bs) > 1:
        per_b = [built_of(BW == q, [q])[:2] for q in range(len(Bs))]
        for q in range(len(per_b)):
            for r in range(q + 1, len(per_b)):
                (s1, d1), (s2, d2) = per_b[q], per_b[r]
                both = (s1 | d1) & (s2 | d2); same = (s1 & s2) | (d1 & d2)
                near = ndimage.binary_dilation(s2 | d2, structure=np.ones((3, 3)), iterations=1)
                print(f"  BUILT, WALK {q + 1} AGAINST WALK {r + 1}: both call {int(both.sum() * SQ):,} sq ft built; the same kind on {100 * same.sum() / max(1, both.sum()):.0f}% of it; of walk {q + 1}'s built squares, {100 * ((s1 | d1) & near).sum() / max(1, (s1 | d1).sum()):.0f}% within a foot of walk {r + 1}'s.")
    # HOW MANY SOURCES SPEAK FOR A SQUARE (the root of the specks, 2026-11-27): a source is one picture, or one walk's
    # kept points; a square called by one source alone rests on one look
    pairs = np.unique(key.astype(np.int64) * 10000000 + SRC.astype(np.int64))
    nsrc = np.bincount((pairs // 10000000).astype(np.int64), minlength=W * H).reshape(H, W)
    if plants:
        print(f"  THE PLANTS ON THE SAME SQUARES: {int(plant_any.sum() * (CELL * FT) ** 2):,} sq ft under a plant; {int(plant_ground.sum() * (CELL * FT) ** 2):,} where it stands within {PLANT_GROUND_DM * 4} in of the ground, so no ground is called there.")
    for name, (pav, gra) in ways.items():
        P, G = grid(pav), grid(gra)
        paved = (P >= MIN_PTS) & (P >= 2 * G)
        grass0 = (G >= MIN_PTS) & (G >= 2 * P)
        if COLOUR and name == "THE PHONE'S OWN LABELS":
            # terrain that is brown is not grass: porous ground away from plants, leaves near them; a square with no colour keeps the label's word
            grass0 = grass0 & ~(brown_sq & ~((Gc + Bc) < MIN_PTS))
        none_ = np.zeros_like(grass0, dtype=bool)   # (not False: ~False is -1, and a mask of ints indexes rows)
        grass = grass0 & ~big_bare & ~(big_porous if COLOUR else none_) & ~(leaves if COLOUR else none_)
        if ADE and name == "THE PHONE'S OWN LABELS":
            # A SECOND WITNESS CAN SAY NO (S3 run 10: of the 1,581 squares the owner erased as turf, the colour had called
            # 483 green and none brown; the second labeller called 367 turf, 44 low plants and 534 porous). Turf is not
            # called where the second labeller says, square by square, low plants or porous ground; where it says nothing,
            # the colour's word stands.
            ag_, _ = ade_grids(np.ones(len(E), bool))
            veto = ag_["low plants"] | ag_["porous"]
            print(f"     THE SECOND LABELLER SAYS NO to {int((grass & veto).sum() * SQ):,} sq ft of the {int(grass.sum() * SQ):,} called turf.")
            grass = grass & ~veto
            # POROUS GROUND BY THE SECOND LABELLER (the owner, 2026-11-26: "there's atleast 5,000 sqft of porous ground that
            # could've been visible from those walks. Could be as high as 10,000 sqft. So the color approach way
            # underestimates that"): the colour kept 41 sq ft, and took most brown for leaves because nearly everything
            # is near a plant now. A square the second labeller calls porous (earth, sand, dirt, mulch) is porous ground
            # unless the colour says green (growth, turf or a bed), in patches of BARE_MIN_SQFT or more; brown near a
            # plant is taken for leaves only where the second labeller does NOT say porous.
            por_ade = ag_["porous"] & ~green_sq & ~paved
            alab, an_ = ndimage.label(por_ade, structure=np.ones((3, 3)))
            asz = np.bincount(alab.ravel())
            ade_porous = por_ade & (asz[alab] * SQ >= BARE_MIN_SQFT)
            leaves = leaves & ~ag_["porous"]
            print(f"     POROUS GROUND BY THE SECOND LABELLER: {int(ade_porous.sum() * SQ):,} sq ft in patches of {BARE_MIN_SQFT} sq ft or more (the colour's own: {int(big_porous.sum() * SQ):,}); brown near plants still left as leaves: {int(leaves.sum() * SQ):,} sq ft.")
            if edits and isinstance(edits.get("erased"), list):
                f2 = max(1, int(round(float(edits.get("cellM") or CELL) / CELL))); hit = tot2 = 0
                for e in edits["erased"]:
                    if len(e) >= 4 and e[0] == "g" and str(e[3]) == "turf":
                        for da in range(f2):
                            for db in range(f2):
                                c_, r_ = int(e[1]) * f2 + da - i0, int(e[2]) * f2 + db - j0
                                if 0 <= c_ < W and 0 <= r_ < H:
                                    tot2 += 1; hit += int(ade_porous[r_, c_])
                print(f"     Of the {tot2:,} squares the owner erased as turf, now called porous: {hit:,}.")
        else:
            ade_porous = np.zeros((H, W), bool)
            if edits and isinstance(edits.get("erased"), list):
                f = max(1, int(round(float(edits.get("cellM") or CELL) / CELL))); still = tot_ = 0
                for e in edits["erased"]:
                    if len(e) >= 4 and e[0] == "g" and str(e[3]) == "turf":
                        for da in range(f):
                            for db in range(f):
                                c_, r_ = int(e[1]) * f + da - i0, int(e[2]) * f + db - j0
                                if 0 <= c_ < W and 0 <= r_ < H:
                                    tot_ += 1; still += int(grass[r_, c_])
                print(f"     JUDGED BY THE OWNER'S ERASURES, THE TURF AS KEPT: of {tot_:,} squares erased as turf, {still:,} would still be called turf.")
        if kind is not None:
            print(f"  {name}: of {int(grass0.sum() * (CELL * FT) ** 2):,} sq ft called grass, {int((grass0 & big_bare).sum() * (CELL * FT) ** 2):,} lie in POROUS GROUND (bare soil, woodchips, moss: the pictures' vote's bare ground) in patches of {BARE_MIN_SQFT} sq ft or more and are NOT counted as grass "
                  f"({int(bare_sq.sum() * (CELL * FT) ** 2):,} sq ft called porous in all, {int(big_bare.sum() * (CELL * FT) ** 2):,} of it in such patches).")
        print(f"  {name}: {int(pav.sum()):,} points paved, {int(gra.sum()):,} grass; squares PAVED {int(paved.sum() * SQ):,} sq ft, GRASS {int(grass.sum() * SQ):,} sq ft.")
        if lawn_in is not None:
            print(f"     Against the traced lawn: grass inside it {int((grass & lawn_in).sum() * SQ):,} sq ft, grass OUTSIDE it {int((grass & ~lawn_in).sum() * SQ):,} (lawn the trace may be missing); "
                  f"paving INSIDE it {int((paved & lawn_in).sum() * SQ):,} sq ft (the trace over paving), paving outside {int((paved & ~lawn_in).sum() * SQ):,}.")
        lab_, n = pieces(paved)
        if n:
            sizes = np.bincount(lab_.ravel())[1:]
            order = np.argsort(sizes)[::-1][:4]
            rows = []
            for k in order:
                cells = np.argwhere(lab_ == k + 1)[:, ::-1].astype(float) * CELL
                from scipy import ndimage
                near = ndimage.binary_dilation(lab_ == k + 1, structure=np.ones((3, 3)), iterations=1)   # its edge squares too
                inpiece = near[cj, ci] & pav
                pts = np.stack([(E[inpiece] / CELL - i0), (N[inpiece] / CELL - j0)], 1) * CELL
                sw = straight_width(cells + CELL / 2, pts)
                allp = lambda sel: np.stack([(E[sel] / CELL - i0), (N[sel] / CELL - j0)], 1) * CELL
                sh = share_width(cells + CELL / 2, allp(pav), allp(gra))
                ext = cells.max(0) - cells.min(0) + CELL
                rows.append(f"{int(sizes[k] * SQ):,} sq ft, {ext.max() * FT:.0f} ft long" + (f", its longest straight run of one width {sw[1] * FT:.0f} ft long, {ftin(sw[0])} wide ({sw[2]} cross-sections)" if sw else ", no straight run of one width") + (f"; BY THE SHARE OF PAVED POINTS ACROSS: {ftin(sh[0])} wide over {sh[1] * FT:.0f} ft" if sh else "; by the share across: no straight run"))
            print(f"     The paving's pieces, largest first ({n} in all): " + "; ".join(rows) + ".")
        out[name] = {"paved": int(paved.sum()), "grass": int(grass.sum())}
        if keep and name == "THE PHONE'S OWN LABELS":
            # FOR THE START PAGE'S MAP (the owner's eyes on the lawn trace): one byte a square, rows south to north,
            # 0 not called, 1 grass, 2 paved, 3 bare (a patch of BARE_MIN_SQFT or more); the square at column c, row r has its south-west corner (i0 + c) * cellM
            # east and (j0 + r) * cellM north of the map's point
            # ONE KIND A SQUARE (the owner, 2026-11-26: "only 1 type of ground (paving, turf, porous ground) can occupy the
            # same space vertically. And at ground level, plant has to be mutually exclusive too (but a plant can be ABOVE
            # other types of ground)"): paving over porous over turf, and a plant standing on the square over all three
            g8 = np.zeros((H, W), np.uint8)
            g8[grass] = 1
            g8[(big_bare | (big_porous if COLOUR else False) | ade_porous) & ~paved] = 3
            g8[paved] = 2
            g8[plant_ground] = 0
            # the built things over all of it: a deck's boards (5), and walls, pillars and what stands under a roof (4)
            g8[deck_sq] = 5
            g8[solid_sq] = 4
            # THE OWNER'S ERASURES of the ground, at the size they were erased at (edits' cellM)
            erased_sq = np.zeros((H, W), bool)
            if edits and isinstance(edits.get("erased"), list):
                f = max(1, int(round(float(edits.get("cellM") or CELL) / CELL)))
                gone = 0
                # only where the square is still the kind the owner erased: a square erased as turf that is now called
                # porous ground is not taken away (the owner erased the turf, not the ground)
                KV = {"turf": 1, "paving": 2, "porous": 3, "solid": 4, "open": 5}
                for e in edits["erased"]:
                    if len(e) >= 3 and e[0] == "g":
                        want = KV.get(str(e[3])) if len(e) >= 4 else None
                        for da in range(f):
                            for db in range(f):
                                c_, r_ = int(e[1]) * f + da - i0, int(e[2]) * f + db - j0
                                if 0 <= c_ < W and 0 <= r_ < H:
                                    erased_sq[r_, c_] = True        # never filled by a guess, whatever it holds now
                                if 0 <= c_ < W and 0 <= r_ < H and g8[r_, c_] and (want is None or g8[r_, c_] == want):
                                    g8[r_, c_] = 0; gone += 1
                print(f"     The owner's erasures: {gone:,} ground squares left out.")
            import ground_fill as GF
            # THE SPECKS (the owner: "there won't ever be a 0-6 sqft patch of grass surrounded by pavement"), and first
            # what they rest on: a speck far from its kind, against every square, by how many sources speak for it
            far = {}
            for kk, nm_ in ((1, "turf"), (2, "paving")):
                lab_k, nk = ndimage.label(g8 == kk, structure=np.ones((3, 3)))
                if not nk:
                    continue
                szk = np.bincount(lab_k.ravel()); szk[0] = 0
                bigk = np.isin(lab_k, np.flatnonzero(szk * SQ >= 50))
                nearbig = ndimage.distance_transform_edt(~bigk) * CELL * FT <= 10 if bigk.any() else np.zeros_like(bigk)
                speck = (lab_k > 0) & (szk[lab_k] * SQ <= GF.SPECK_SQFT) & ~nearbig
                far[nm_] = speck
            called = np.isin(g8, (1, 2, 3))
            one = called & (nsrc <= 1)
            if far:
                sp = np.zeros((H, W), bool)
                for v in far.values():
                    sp |= v
                rg_all = RNG[np.isfinite(RNG)]
                spk = sp[cj, ci] & np.isfinite(RNG)
                print(f"     THE SPECKS FAR FROM THEIR KIND (a piece of {GF.SPECK_SQFT} sq ft or less with none of its kind of 50 sq ft within 10 ft): "
                      + ", ".join(f"{k} {int(v.sum() * SQ):,} sq ft" for k, v in far.items())
                      + f"; of their squares {100 * (sp & (nsrc <= 1)).sum() / max(1, sp.sum()):.0f}% rest on ONE source (a picture or a walk's kept points), of all ground called {100 * one.sum() / max(1, called.sum()):.0f}%"
                      + (f"; the pictures' cells in them seen from {np.median(RNG[spk]) * FT:.0f} ft in the middle (all: {np.median(rg_all) * FT:.0f} ft)" if spk.any() and len(rg_all) else "")
                      + "; by walk, of their points: " + ", ".join(f"walk {q + 1} {100 * (sp[cj, ci] & (WI == q)).sum() / max(1, sp[cj, ci].sum()):.0f}%" for q in range(len(Es))) + ".")
                # THE ROOT OF MOST (S4 run of 2026-11-27, 8:11 pm Thu Eastern: of the far specks' squares 43% rested on one
                # source against 17% of all, and their cells were seen from 23 ft in the middle against 7 ft): a far
                # speck that rests on one source is one picture's long look, and is not called
                lone = sp & (nsrc <= 1) & np.isin(g8, (1, 2))
                g8[lone] = 0
                print(f"     FAR SPECKS ON ONE SOURCE, not called: {int(lone.sum() * SQ):,} sq ft.")
            g8, ch, pcs = GF.despeckle(g8, SQ)
            print(f"     SPECKS OF TURF INSIDE PAVING (a patch of {GF.SPECK_SQFT} sq ft or less, {100 * GF.SURROUND:.0f}% of what is called round it paving): {pcs:,} patches, {int(ch * SQ):,} sq ft, made paving.")
            # THE GAPS FILLED (the lawn mapper's rules under a tree, public/lib/stage3.js: bridge and reach), never into an
            # erased square, a plant standing on the ground or a built thing; first held out to see how right it is
            blocked = erased_sq | plant_ground | np.isin(g8, (4, 5))
            ho = GF.holdout(g8, SQ, CELL * FT, blocked)
            for kk, nm_ in ((1, "turf"), (2, "paving")):
                hd, same, other, left = ho[kk]
                print(f"     THE FILL HELD OUT ({nm_}): of {hd:,} squares called {nm_} and hidden in 3 ft blocks, put back {nm_} {100 * same / max(1, hd):.0f}%, as the other kind {100 * other / max(1, hd):.0f}%, left empty {100 * left / max(1, hd):.0f}%.")
            g8, got = GF.fill(g8, SQ, CELL * FT, blocked)
            print(f"     THE GAPS FILLED (bridge: a gap {100 * GF.BRIDGE_SHARE:.0f}% one kind round it; reach: turf {GF.REACH_FT[1]:.0f} ft, paving {GF.REACH_FT[2]:.0f} ft from where it was seen; gaps of {GF.MAX_GAP_SQFT} sq ft or less): turf {int(got[1] * SQ):,} sq ft, paving {int(got[2] * SQ):,} sq ft, kept as GUESSED.")
            # THE BUILT THINGS FOR THE FUSED MODEL (agreed with the features session, 2026-11-27; docs/MAPS.md plants.structures):
            # kinds 0 no claim, 4 solid, 5 open (a deck), 255 never looked; tops in decimetres over the ground (0 unknown)
            sk_ = np.where(looked, 0, 255).astype(np.uint8)
            sk_[g8 == 4] = 4; sk_[g8 == 5] = 5
            # 6: the lidar's built thing is not here (agreed with the features session, 2026-11-27: fuse.js 6 takes it away)
            sk_[not_built & ~np.isin(g8, (4, 5))] = 6
            tp_ = np.zeros((H, W), np.uint8)
            tp_[g8 == 4] = np.clip(np.round(top_solid[g8 == 4] * 10), 0, 254).astype(np.uint8)
            tp_[g8 == 5] = np.clip(np.round(top_deck[g8 == 5] * 10), 0, 254).astype(np.uint8)
            enc_ = lambda a_: base64.b64encode(zlib.compress(a_.tobytes(), 9)).decode()
            sdoc = {"cellM": CELL, "i0": i0, "j0": j0, "w": int(W), "h": int(H), "enc": "zlib+base64", "notSeen": 255,
                    "kinds": enc_(sk_), "tops": enc_(tp_), "unitDm": 1,
                    "what": "kinds: one byte a square, rows south to north: 0 no claim, 4 solid structure, 5 open structure (a deck's boards), 6 the lidar's built thing is not here, 255 never looked; tops: decimetres over the ground (a solid's top, a deck's walking surface; 0 not known)"}
            json.dump(sdoc, open(os.path.join(os.path.dirname(keep) or ".", "structures.json"), "w"))
            print(f"     The built things for the fused model: {int((sk_ == 6).sum() * SQ):,} sq ft where the lidar's built thing is not; {int((sk_ == 4).sum() * SQ):,} sq ft solid (tops in the middle {np.median(tp_[sk_ == 4]) / 10 * FT if (sk_ == 4).any() else 0:.0f} ft), {int((sk_ == 5).sum() * SQ):,} sq ft open (boards in the middle {np.median(tp_[sk_ == 5]) / 10 * FT if (sk_ == 5).any() else 0:.1f} ft up); kept as structures.json ({os.path.getsize(os.path.join(os.path.dirname(keep) or '.', 'structures.json')) / 1e3:.0f} KB).")
            json.dump({"v": 1, "cellM": CELL, "i0": i0, "j0": j0, "w": int(W), "h": int(H), "from": "the walk's ground points by the phone's own labels",
                       "what": "one byte a square, rows south to north: 0 not called, 1 grass, 2 paved, 3 porous ground: bare soil, woodchips, moss (a patch of 4 sq ft or more), 4 solid structure (walls, pillars, what stands under a roof), 5 open structure (a deck's boards: rain passes through); 9 grass and 10 paved GUESSED (a gap filled, not seen)", "enc": "zlib+base64",
                       "kinds": base64.b64encode(zlib.compress(g8.tobytes(), 9)).decode()}, open(keep, "w"))
            print(f"     Kept for the start page's map: {os.path.basename(keep)} ({os.path.getsize(keep) / 1e3:.0f} KB).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
