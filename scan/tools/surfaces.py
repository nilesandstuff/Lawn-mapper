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
import json
import os
import sys

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


REACH, SMOOTH, COLOUR = 8.0, False, False   # set from the command line in main()
CAST_MAX_M = 8.0       # m: a picture's depth cell is cast onto the ground only this near (the depth is off 3-6% of the distance)
CAST_CONF = 0.3        # the least depth confidence for a cast cell


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
    X, Z, Lb, Cc, R, used = [], [], [], [], [], 0
    reach = CAST_MAX_M if reach is None else reach
    if colour:
        try:
            from PIL import Image
        except Exception:
            colour = False
    for k in keys:
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
        g = np.abs(P[:, 1] - gmed[near]) <= GROUND_M
        if g.any():
            X.append(P[g, 0]); Z.append(P[g, 2]); Lb.append(lab[m][g] + 1); R.append(dist[m][g]); used += 1
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
    if not X:
        return None
    return np.concatenate(X), np.concatenate(Z), np.concatenate(Lb).astype(np.uint8), used, np.concatenate(Cc), np.concatenate(R)


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
    rf = os.path.join(d, "view-rgb.bin")
    if COLOUR and os.path.exists(rf):
        rgb = np.fromfile(rf, dtype=np.uint8)
        if len(rgb) >= 4 * len(recs):
            q = rgb[:4 * len(recs)].reshape(-1, 4)[ok]
            C = np.where(q[:, 3] > 0, colour_class(q[:, :3]), COLOUR_UNKNOWN).astype(np.uint8)
    note = f"{name}: {int(ok.sum()):,} kept ground points"
    # the pictures' own ground, where the walk kept their label grids
    if fin.sum() > 100:
        from scipy.spatial import cKDTree
        gij = np.floor(np.stack([x_[fin], z_[fin]], 1)).astype(np.int64)
        o = np.lexsort((gij[:, 1], gij[:, 0])); gs, gy = gij[o], g_[fin][o]
        brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
        gmed = np.array([np.median(gy[p:q]) for p, q in zip(brk, np.r_[brk[1:], len(gy)])])
        cast = cast_pictures(d, cut, cKDTree(gs[brk].astype(np.float64)), gmed, float(fit.get("castScale") or 1.0), REACH, SMOOTH, COLOUR)
        if cast is not None:
            cx, cz, cl, used, ccol, crange = cast
            if "--nocast" not in sys.argv:
                X, Z, L, C = np.r_[X, cx], np.r_[Z, cz], np.r_[L, cl], np.r_[C, ccol]
                if K is not None:
                    K = np.r_[K, np.zeros(len(cx), K.dtype)]
            note += f" and {len(cx):,} ground cells from {used} pictures' own depth and labels (within {REACH * FT:.0f} ft{', and the smoothed depth where the raw has none' if SMOOTH else ''})" + (" (counted, NOT used)" if "--nocast" in sys.argv else "")
        else:
            note += "; its pictures kept no label grids (a walk from before 2026-11-24)"
    s_, th = float(T.get("s") or 1.0), float(T["theta"])
    cth, sth = np.cos(th) * s_, np.sin(th) * s_
    E = cth * X - sth * (-Z) + T["tx"]
    N = sth * X + cth * (-Z) + T["ty"]
    return E, N, L, K, C, note + f"; its {fit.get('n')} corners agree within {(fit.get('worstM') or 0) * 39.37:.0f} in."


def main():
    global CELL, REACH, SMOOTH, COLOUR
    a = [x for x in sys.argv[1:] if x not in ("--nocast", "--smooth", "--colour")]
    SMOOTH, COLOUR = "--smooth" in sys.argv, "--colour" in sys.argv
    if "--reach" in a:     # metres: how far a picture's depth is cast onto the ground (CAST_MAX_M by default)
        i = a.index("--reach"); REACH = float(a[i + 1]); a = a[:i] + a[i + 2:]
    edits = None
    if "--edits" in a:     # the owner's erasures (edits/<map>.json): a ground square erased is not called
        i = a.index("--edits"); ef = a[i + 1]; a = a[:i] + a[i + 2:]
        try:
            edits = json.load(open(ef))
        except Exception:
            edits = None
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
    Es, Ns, Ls, Ks, Cs, said, have_vote = [], [], [], [], [], [], True
    for d in a:
        got = load_walk(d)
        if got is None:
            continue
        e_, n_, l_, k_, c_, note = got
        Es.append(e_); Ns.append(n_); Ls.append(l_); Cs.append(c_); said.append(note)
        if k_ is None:
            have_vote = False
        Ks.append(k_ if k_ is not None else np.zeros(len(e_), np.uint8))
    if not Es:
        print("\nTHE GROUND AS THE WALKS SAW IT: no walk here could be put on the map.")
        return 0
    E, N, L, Cl = np.concatenate(Es), np.concatenate(Ns), np.concatenate(Ls), np.concatenate(Cs)
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
    if plants:
        print(f"  THE PLANTS ON THE SAME SQUARES: {int(plant_any.sum() * (CELL * FT) ** 2):,} sq ft under a plant; {int(plant_ground.sum() * (CELL * FT) ** 2):,} where it stands within {PLANT_GROUND_DM * 4} in of the ground, so no ground is called there.")
    for name, (pav, gra) in ways.items():
        P, G = grid(pav), grid(gra)
        paved = (P >= MIN_PTS) & (P >= 2 * G)
        grass0 = (G >= MIN_PTS) & (G >= 2 * P)
        if COLOUR and name == "THE PHONE'S OWN LABELS":
            # terrain that is brown is not grass: porous ground away from plants, leaves near them; a square with no colour keeps the label's word
            grass0 = grass0 & ~(brown_sq & ~((Gc + Bc) < MIN_PTS))
        grass = grass0 & ~big_bare & ~(big_porous if COLOUR else False) & ~(leaves if COLOUR else False)
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
            import base64
            import zlib
            # ONE KIND A SQUARE (the owner, 2026-11-26: "only 1 type of ground (paving, turf, porous ground) can occupy the
            # same space vertically. And at ground level, plant has to be mutually exclusive too (but a plant can be ABOVE
            # other types of ground)"): paving over porous over turf, and a plant standing on the square over all three
            g8 = np.zeros((H, W), np.uint8)
            g8[grass] = 1
            g8[(big_bare | (big_porous if COLOUR else False)) & ~paved] = 3
            g8[paved] = 2
            g8[plant_ground] = 0
            # THE OWNER'S ERASURES of the ground, at the size they were erased at (edits' cellM)
            if edits and isinstance(edits.get("erased"), list):
                f = max(1, int(round(float(edits.get("cellM") or CELL) / CELL)))
                gone = 0
                for e in edits["erased"]:
                    if len(e) >= 3 and e[0] == "g":
                        for da in range(f):
                            for db in range(f):
                                c_, r_ = int(e[1]) * f + da - i0, int(e[2]) * f + db - j0
                                if 0 <= c_ < W and 0 <= r_ < H and g8[r_, c_]:
                                    g8[r_, c_] = 0; gone += 1
                print(f"     The owner's erasures: {gone:,} ground squares left out.")
            json.dump({"v": 1, "cellM": CELL, "i0": i0, "j0": j0, "w": int(W), "h": int(H), "from": "the walk's ground points by the phone's own labels",
                       "what": "one byte a square, rows south to north: 0 not called, 1 grass, 2 paved, 3 porous ground: bare soil, woodchips, moss (a patch of 4 sq ft or more)", "enc": "zlib+base64",
                       "kinds": base64.b64encode(zlib.compress(g8.tobytes(), 9)).decode()}, open(keep, "w"))
            print(f"     Kept for the start page's map: {os.path.basename(keep)} ({os.path.getsize(keep) / 1e3:.0f} KB).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
