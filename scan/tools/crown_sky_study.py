"""
CAN COLOUR SAY WHERE THE LIDAR'S CROWN IS NOT, WHERE DEPTH CANNOT REACH? (core session, 2026-11-24). The owner,
2026-11-24 ("Remember that last sentence", CLAUDE.md): "we can rely on color a lot for tweaking canopies beyond the
distance of the actual depth finding by comparing whether or not tree or sky is visible from a position and comparing
that with what the lidar says there should be... And we use the lidar to estimate what the distance should be for the
edits" -- best in leaf-off months on a clear day, sky blue against branches.

A ground walk's depth says nothing above about 30 ft (SCAN-PLAN 62). Its PICTURES do: a lidar crown cell projected
into a picture lands on some pixels. A bare crown there shows blue with twigs through it; air with sky behind shows
clean blue. (SegFormer's "sky" is no use for this: it called November's bare crowns sky, SCAN-H14.) So the test is
the colour of the pixels themselves: the share of a patch that is plain sky blue.

PROVED THE OWNER'S WAY, BY THE WALK AGREEING WITH ITSELF: from 8 to 30 ft the walk's DEPTH already says where crown is
(points the phone labelled tree in a 2 ft x 2 ft x half-metre block) and where air is (clearHigh's blocks: 8 m of
line with nothing seen, plants.py clear_of). The colour verdict is measured against both there:
  - how often a block the depth says is CROWN looks like clean sky (a false clearing);
  - how often a block the depth says is AIR looks like clean sky (what it can see; low where trees or roofs stand
    behind, which the colour test cannot tell from crown, so it never claims those).
Then the lidar's crown blocks ABOVE 30 ft: how many look like clean sky from enough pictures.

A block is CLEAN in a picture when 95% or more of the pixels it covers are sky blue (b > 140, b - r >= 45, b - g >= 15:
the sky-blue test of plants.py, measured on this walk's roof edges); CLEAN when that holds in CLEAN_VIEWS pictures or
more, and HAZY when 3 or more pictures saw it under 50%. Under an overcast sky nothing passes, and nothing is claimed.

Inputs beside the twin: the pictures (key-NNNN.jpg, keys-NNNN.json), fit.json (walk-fit.mjs), and skyline-prep.mjs's
sky-points.bin, sky-ground.bin, sky-input.json (the lidar's returns and ground in the map's metres). Counts only.

  python scan/tools/crown_sky_study.py <twin dir>
"""
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plants as PL  # noqa: E402
import trunks as TR  # noqa: E402

FT = 3.28084
RANGE_M = 45.0        # m from the camera: no further (a 2 ft block is two pixels there)
MIN_PX = 2            # the patch is at least this many pixels across
CLEAN_SHARE = 0.95    # of a patch sky blue: clean in that picture
OPEN_R_M = (0.15, 0.3, 0.6, 1.2)   # m at the block's own range: how wide a clear stretch of sky round it must be
# THE OWNER'S CORRECTION (2026-11-24): "some sky will be visible between the bare branches. So if this is going to
# work with bare branches at all, then it's going to need to think about seeing large enough sections of sky. For leaf
# on situations, those sky sections can be smaller." So besides "is the block's own patch sky", each view asks how far
# the sky runs round the block without a break (the distance from its pixel to the nearest pixel that is not sky),
# turned into metres at the block's range (the lidar's distance, as the owner said). A bare crown shows only small
# gaps; air shows a stretch wider than them.
HAZY_SHARE = 0.5      # under this: something is there (or behind)
CLEAN_VIEWS = 3       # pictures a block must be clean in
NEAR_M = 12.0         # m: a 2 ft block is 3 degrees wide or more within this
TREE_KIND = 2         # structures.js: a tree column's kind (3: a solid tree)


def sky_blue(img):
    r, g, b = (img[..., i].astype(np.int32) for i in range(3))
    return (b > 140) & (b - r >= 45) & (b - g >= 15)


def sky_own(img):
    """THE PICTURE'S OWN SKY (run 566: the controls' patches were blue in the middle, 97 / 129 / 159, yet only 27% of
    their views passed "95% of the pixels over fixed thresholds": pixel noise, and each picture's exposure). This
    picture's sky colour is the median of its plainly blue pixels (blue 30 over red, no less than green, blue 80 or
    more, 0.5% of the frame at the least); a pixel is sky when within 40 of that colour and still bluer than red by 10.
    A twig is darker or browner, a white cloud far paler: neither counts. None when the picture holds too little sky."""
    r, g, b = (img[..., i].astype(np.int32) for i in range(3))
    plain = (b - r >= 30) & (b >= g) & (b >= 80)
    if plain.mean() < 0.005:
        return np.zeros(img.shape[:2], bool)
    ref = np.median(img[plain].astype(np.int32), axis=0)
    dd = np.sqrt(((img.astype(np.int32) - ref[None, None, :]) ** 2).sum(2))
    return (dd <= 40) & (b - r >= 10)


SEM_SKY, SEM_CONF = 1, 0.5     # ARCore's sky label, and the least confidence it is taken at


def phone_sky(d, name):
    """THE PHONE'S OWN SKY (key-NNNN.sem, kept with each picture since 2026-11-24; the owner: ARCore's scene semantics
    "has a label for sky... it largely avoids marking trees as sky when it does it's own segmentation"): the picture's
    grid of labels, rows from the top, in the picture's own frame. -> bool (ny, nx) sky mask, or None."""
    f = os.path.join(d, name.replace(".jpg", ".sem"))
    if not os.path.exists(f):
        return None
    b = np.fromfile(f, dtype=np.uint8)
    if len(b) < 4:
        return None
    nx, ny = int(b[0]) | (int(b[1]) << 8), int(b[2]) | (int(b[3]) << 8)
    if len(b) < 4 + 2 * nx * ny:
        return None
    lab = b[4:4 + nx * ny].reshape(ny, nx)
    conf = b[4 + nx * ny:4 + 2 * nx * ny].reshape(ny, nx) / 255.0
    return (lab == SEM_SKY) & (conf >= SEM_CONF)


def sky_bright(img):
    """THE RELATIVE TEST (run 564: the plain-sky controls' pixels were blue in the middle at 108 / 141 / 162, a quarter
    of them darker, 79 / 104 / 114, which the strict test's "blue over 140" throws out; this camera's sky is darker than
    the roof-edge colours it was measured on). Blue 25 or more over red, no less than green, and not dark (blue 90 or
    more). Bare twigs (browns and greys) fail it; white cloud fails it too (the owner: "some light clouds to the
    southwest"), which only makes the stretch of sky round a block look shorter, never longer."""
    r, g, b = (img[..., i].astype(np.int32) for i in range(3))
    return (b - r >= 25) & (b >= g) & (b >= 90)


def main():
    a = sys.argv[1:]
    if not a or not os.path.isdir(a[0]):
        print("usage: crown_sky_study.py <twin dir>")
        return 1
    d = a[0]
    from PIL import Image
    try:
        fit = json.load(open(os.path.join(d, "fit.json")))
        inp = json.load(open(os.path.join(d, "sky-input.json")))
    except Exception as e:
        print(f"\nCOLOUR AGAINST DEPTH: inputs missing ({e}). Nothing measured.")
        return 0
    if not (fit.get("ok") and fit.get("T")):
        print(f"\nCOLOUR AGAINST DEPTH: the walk has no fit to its map ({fit.get('why')}). Nothing measured.")
        return 0
    T = fit["T"]
    recs, kind, flags = TR.read_walk(d)
    # the phone's own label of each point (labels-NNNN.bin byte 0: ARCore's label + 1), the cloud parts' order
    parts_ = []
    for n_ in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        m_ = os.path.getsize(os.path.join(d, n_)) // 24
        lp = os.path.join(d, n_.replace("cloud-", "labels-"))
        lb = np.fromfile(lp, dtype=np.uint8) if os.path.exists(lp) else np.zeros(0, np.uint8)
        parts_.append(lb.reshape(-1, 4)[:, 0] if len(lb) == 4 * m_ else np.zeros(m_, np.uint8))
    labs_all = np.concatenate(parts_) if parts_ else None
    if labs_all is not None and len(labs_all) != len(recs):
        labs_all = None
    pk = PL.phone_kinds(d, len(recs))
    lab = pk if pk is not None else kind
    track = PL.read_track(d)
    cut = 0.0
    for f in ("view.json", "start.json"):
        try:
            cut = max(cut, float(json.load(open(os.path.join(d, f))).get("startCutS") or 0))
        except Exception:
            pass
    seen, _ = PL.seen_of(recs, flags, track, cut, T)
    if not seen:
        print("\nCOLOUR AGAINST DEPTH: the walk's open air could not be read. Nothing measured.")
        return 0
    i0, j0, w, h = seen["i0"], seen["j0"], seen["w"], seen["h"]
    _, cst = PL.clear_of(recs, flags, track, cut, T, (i0, j0, w, h), want_blocks=True)
    ns = cst["_ns"]
    clear = cst["_clear"].reshape(-1)                          # depth says AIR
    looked = cst["_path"].reshape(-1) > 0
    s_, th = float(T.get("s") or 1.0), float(T["theta"])
    cth, sth = np.cos(th) * s_, np.sin(th) * s_
    CELL, SLAB, FROM = PL.SEEN_CELL, PL.CLEAR_SLAB, PL.CLEAR_FROM
    # the walk's ground under any map place, in the session's height (median ground of its points per 1 m of the map)
    t_, x_, y_, z_, g_ = (recs[:, i].astype(np.float64) for i in (0, 2, 3, 4, 5))
    ok = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & (t_ >= cut) & ((flags & 3) == 0)
    E = cth * x_[ok] - sth * (-z_[ok]) + T["tx"]
    N = sth * x_[ok] + cth * (-z_[ok]) + T["ty"]
    he = (y_[ok] - g_[ok]) * s_
    from scipy.spatial import cKDTree
    gm = np.floor(np.stack([E, N], 1)).astype(np.int64)
    o = np.lexsort((gm[:, 1], gm[:, 0]))
    gs, gy = gm[o], g_[ok][o]
    brk = np.flatnonzero(np.r_[True, (np.diff(gs, axis=0) != 0).any(1)])
    gmed = np.array([np.median(gy[p:q]) for p, q in zip(brk, np.r_[brk[1:], len(gy)])])
    gtree = cKDTree(gs[brk].astype(np.float64))
    # depth says CROWN: the phone's tree points in each block
    ci, cj = np.floor(E / CELL).astype(np.int64) - i0, np.floor(N / CELL).astype(np.int64) - j0
    kk = np.floor((he - FROM) / SLAB).astype(np.int64)
    good = (he >= FROM) & (kk < ns) & (ci >= 0) & (ci < w) & (cj >= 0) & (cj < h) & np.isin(lab[ok], [TR.KINDS.index("tree"), TR.KINDS.index("plant")])
    crown = np.zeros(w * h * ns, np.int32)
    np.add.at(crown, ((cj[good] * w + ci[good]) * ns + kk[good]), 1)
    crown = crown >= 2
    # the lidar's crown blocks: its tree returns, height over its ground, on the same blocks; and above 20 m too
    try:
        pts = np.fromfile(os.path.join(d, "sky-points.bin"), dtype="<f4").reshape(-1, 6)
        lg = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4")
    except Exception as e:
        print(f"\nCOLOUR AGAINST DEPTH: the lidar's returns are not beside the twin ({e}). Nothing measured.")
        return 0
    G = inp["grid"]
    col = np.floor((pts[:, 0] - G["x0"]) / G["cell"]).astype(np.int64)
    row = np.floor((G["y1"] - pts[:, 1]) / G["cellY"]).astype(np.int64)
    inside = (col >= 0) & (col < G["w"]) & (row >= 0) & (row < G["h"])
    lgz = np.full(len(pts), np.nan)
    lgz[inside] = lg[row[inside] * G["w"] + col[inside]]
    lh = pts[:, 2] - lgz
    TOPB = 40.0                                               # m: the lidar's crown counted to here
    nsl = int(np.ceil((TOPB - FROM) / SLAB))
    tree = inside & np.isin(pts[:, 5], [TREE_KIND, 3]) & np.isfinite(lh) & (lh >= FROM) & (lh < TOPB)
    li, lj = np.floor(pts[tree, 0] / CELL).astype(np.int64) - i0, np.floor(pts[tree, 1] / CELL).astype(np.int64) - j0
    lk = np.floor((lh[tree] - FROM) / SLAB).astype(np.int64)
    inw = (li >= 0) & (li < w) & (lj >= 0) & (lj < h)
    lkey = np.unique((lj[inw] * w + li[inw]) * nsl + lk[inw])
    # the blocks to look at: the lidar's crown (to 40 m), and the walk's own crown and air (8-20 m)
    def walk_blocks(mask):
        k = np.flatnonzero(mask)
        sq, sl = k // ns, k % ns
        return sq * nsl + sl
    keys_all = np.unique(np.concatenate([lkey, walk_blocks(crown), walk_blocks(clear)]))
    sq, sl = keys_all // nsl, keys_all % nsl
    bc, br = sq % w, sq // w
    be, bn = (i0 + bc + 0.5) * CELL, (j0 + br + 0.5) * CELL
    bh = FROM + (sl + 0.5) * SLAB                              # metres over the ground, the map's
    # CONTROLS: blocks 30 m up (the tallest crown here is about 24 m), every 6 m over the walk's squares; seen only
    # steeply (35 degrees up or more), so nothing but sky stands behind them: how much of plain sky each test calls sky
    cg_e, cg_n = np.meshgrid(np.arange((i0 + 0.5) * CELL, (i0 + w) * CELL, 6.0), np.arange((j0 + 0.5) * CELL, (j0 + h) * CELL, 6.0))
    nctl = cg_e.size
    be, bn = np.r_[be, cg_e.ravel()], np.r_[bn, cg_n.ravel()]
    bh = np.r_[bh, np.full(nctl, 30.0)]
    ctl = np.r_[np.zeros(len(keys_all), bool), np.ones(nctl, bool)]
    keys_all = np.r_[keys_all, np.full(nctl, -1)]
    sl = np.r_[sl, np.full(nctl, nsl)]
    sq = np.r_[sq, np.zeros(nctl, np.int64)]
    # into the session: the inverse of the fit, the height over the walk's own ground
    ux, uy = be - T["tx"], bn - T["ty"]
    X = (np.cos(th) * ux + np.sin(th) * uy) / s_
    mZ = (-np.sin(th) * ux + np.cos(th) * uy) / s_
    _, near = gtree.query(np.stack([np.floor(be), np.floor(bn)], 1))
    Y = gmed[near] + bh / s_
    P4 = np.stack([X, Y, -mZ, np.ones_like(X)], 1)
    nb = len(keys_all)
    clean_n, hazy_n, views = np.zeros(nb, np.int32), np.zeros(nb, np.int32), np.zeros(nb, np.int32)
    # the same counted on NEAR views only: where the block is wide in the picture against the pictures' own pointing
    # error (2-5 degrees, SCAN-H14 to H16), i.e. within NEAR_M
    cleanN, viewsN = np.zeros(nb, np.int32), np.zeros(nb, np.int32)
    cleanB, cleanBN = np.zeros(nb, np.int32), np.zeros(nb, np.int32)     # the looser test, all views and near
    from scipy.ndimage import distance_transform_edt
    openS = np.zeros((len(OPEN_R_M), nb), np.int32)    # views with that much clear sky round the block: strict blue
    openB = np.zeros((len(OPEN_R_M), nb), np.int32)    # ...the looser test
    viewsP, cleanP = np.zeros(nb, np.int32), np.zeros(nb, np.int32)     # the PHONE'S own sky (key-NNNN.sem), where kept
    openP = np.zeros((len(OPEN_R_M), nb), np.int32)
    pics_sem = 0
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    keys = [k for k in keys if os.path.exists(os.path.join(d, k["name"])) and k.get("t", 0) >= cut]
    used, pics_blue = 0, 0
    ctl_blocked = [0, 0]
    try:
        stand = np.fromfile(os.path.join(d, "sky-surface.bin"), dtype="<f4") - lg     # how high the lidar's things stand
        stand = np.where(np.isfinite(stand), stand, 0.0)
    except Exception:
        stand = np.zeros(G["w"] * G["h"])
    ctl_rgb = []   # the mean colour of each control patch in each view: blue sky, white sky, or not sky at all
    for k in keys:
        try:
            img = np.asarray(Image.open(os.path.join(d, k["name"])).convert("RGB"))
        except Exception:
            continue
        H_, W_ = img.shape[:2]
        V = np.asarray(k["view"], np.float64).reshape(4, 4).T  # camera -> session
        Pm = np.asarray(k["proj"], np.float64).reshape(4, 4).T
        cam = P4 @ np.linalg.inv(V).T
        zc = -cam[:, 2]
        clip = cam @ Pm.T
        wq = np.where(np.abs(clip[:, 3]) < 1e-9, 1e-9, clip[:, 3])
        nx, ny = clip[:, 0] / wq, clip[:, 1] / wq
        vis = (zc > 1.0) & ((zc < RANGE_M) | (ctl & (zc < 2 * RANGE_M))) & (np.abs(nx) < 0.97) & (np.abs(ny) < 0.97)
        if ctl.any():   # a control counts only when seen steeply, and with nothing of the lidar's in the way
            camp = V[:3, 3]
            el = np.degrees(np.arctan2(P4[:, 1] - camp[1], np.hypot(P4[:, 0] - camp[0], P4[:, 2] - camp[2])))
            vis &= ~ctl | (el >= 35)
            cv = np.flatnonzero(vis & ctl)
            if len(cv):
                tq = np.linspace(0.03, 0.97, 48)[:, None, None]
                Q = camp[None, None, :] + (P4[cv, :3][None] - camp[None, None, :]) * tq      # session points on each line
                qx, qy, qz = Q[..., 0].ravel(), Q[..., 1].ravel(), Q[..., 2].ravel()
                qe, qn = cth * qx - sth * (-qz) + T["tx"], sth * qx + cth * (-qz) + T["ty"]
                _, nq = gtree.query(np.stack([np.floor(qe), np.floor(qn)], 1))
                qh = (qy - gmed[nq]) * s_
                cc_ = np.floor((qe - G["x0"]) / G["cell"]).astype(np.int64)
                rr_ = np.floor((G["y1"] - qn) / G["cellY"]).astype(np.int64)
                okq = (cc_ >= 0) & (cc_ < G["w"]) & (rr_ >= 0) & (rr_ < G["h"])
                standq = np.zeros(len(qe))
                standq[okq] = stand[rr_[okq] * G["w"] + cc_[okq]]
                blocked = ((qh < standq + 0.3) & (standq > 2.0)).reshape(len(tq), len(cv)).any(0)
                vis[cv[blocked]] = False
                ctl_blocked[0] += int(blocked.sum()); ctl_blocked[1] += len(cv)
        if not vis.any():
            continue
        blue = sky_blue(img)
        if blue.mean() > 0.01:
            pics_blue += 1
        integ = np.pad(blue.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        bright = sky_bright(img)
        integB = np.pad(bright.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        dS, dB = distance_transform_edt(blue), distance_transform_edt(bright)   # pixels to the nearest non-sky
        fpx = Pm[0, 0] * W_ / 2                               # pixels per unit at depth 1
        idx = np.flatnonzero(vis)
        px = ((nx[idx] + 1) / 2 * W_).astype(np.int64)
        py = ((1 - ny[idx]) / 2 * H_).astype(np.int64)
        r = np.maximum(MIN_PX / 2, CELL * fpx / zc[idx] / 2).astype(np.int64)
        x0, x1 = np.clip(px - r, 0, W_), np.clip(px + r + 1, 0, W_)
        y0, y1 = np.clip(py - r, 0, H_), np.clip(py + r + 1, 0, H_)
        area = np.maximum(1, (x1 - x0) * (y1 - y0))
        share = (integ[y1, x1] - integ[y0, x1] - integ[y1, x0] + integ[y0, x0]) / area
        shareB = (integB[y1, x1] - integB[y0, x1] - integB[y1, x0] + integB[y0, x0]) / area
        cm = ctl[idx]
        if cm.any():
            for q_ in np.flatnonzero(cm)[:50]:
                ctl_rgb.append(img[y0[q_]:y1[q_], x0[q_]:x1[q_]].reshape(-1, 3).mean(0))
        views[idx] += 1
        clean_n[idx] += share >= CLEAN_SHARE
        hazy_n[idx] += share < HAZY_SHARE
        nr = zc[idx] <= NEAR_M
        viewsN[idx[nr]] += 1
        cleanN[idx[nr]] += share[nr] >= CLEAN_SHARE
        cleanB[idx] += shareB >= CLEAN_SHARE
        pyc, pxc = np.clip(py, 0, H_ - 1), np.clip(px, 0, W_ - 1)
        mS, mB = dS[pyc, pxc] * zc[idx] / fpx, dB[pyc, pxc] * zc[idx] / fpx    # metres of clear sky round it
        for ri, R in enumerate(OPEN_R_M):
            openS[ri, idx] += mS >= R
            openB[ri, idx] += mB >= R
        ps = phone_sky(d, k["name"])
        if ps is not None:
            pics_sem += 1
            gy_, gx_ = ps.shape
            cxg = np.clip((nx[idx] + 1) / 2 * gx_, 0, gx_ - 1e-6).astype(np.int64)
            cyg = np.clip((1 - ny[idx]) / 2 * gy_, 0, gy_ - 1e-6).astype(np.int64)
            # the block's own cells (at least its one), and the clear sky round it, on the phone's grid
            rg = np.maximum(0, (CELL * fpx / zc[idx] / 2) / (W_ / gx_)).astype(np.int64)
            integP = np.pad(ps.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
            a0, a1 = np.clip(cxg - rg, 0, gx_), np.clip(cxg + rg + 1, 0, gx_)
            b0, b1 = np.clip(cyg - rg, 0, gy_), np.clip(cyg + rg + 1, 0, gy_)
            shP = (integP[b1, a1] - integP[b0, a1] - integP[b1, a0] + integP[b0, a0]) / np.maximum(1, (a1 - a0) * (b1 - b0))
            viewsP[idx] += 1
            cleanP[idx] += shP >= CLEAN_SHARE
            dP = distance_transform_edt(ps)[cyg, cxg] * (W_ / gx_) * zc[idx] / fpx
            for ri, R in enumerate(OPEN_R_M):
                openP[ri, idx] += dP >= R
        cleanBN[idx[nr]] += shareB[nr] >= CLEAN_SHARE
        used += 1
    # THE PICTURES' OWN GEOMETRY, BY THE WALK'S OWN POINTS (run 565: plain sky with nothing of the lidar's in the way read
    # dark in 27% of views, and crown and air did not separate: is the projection itself right?). The points the phone
    # took within 0.3 s of a picture, a foot or more over their ground (walls, trunks, branches, not sky), put into that
    # picture: how many land on sky, in the picture as kept and turned or flipped. The right way is the one where
    # fewest do. No lidar and no fit in it.
    TT = t_[ok]
    Pw = np.stack([x_[ok], y_[ok], z_[ok], np.ones(int(ok.sum()))], 1)
    hpt = y_[ok] - g_[ok]
    stand_pt = (hpt >= 0.3) & (hpt <= 2.0)          # LOW SOLIDS: walls, shrubs, fences, a foot to six feet up: rarely against sky
    lab_ok = labs_all[ok] if labs_all is not None else None
    sky_pt = (lab_ok == 2) if lab_ok is not None else np.zeros(len(hpt), bool)   # what the PHONE labelled sky (label + 1 = 2)
    order = np.argsort(TT)
    TTs = TT[order]
    WAYS = ("as kept", "upside down", "mirrored", "turned right", "turned left")
    land = np.zeros((len(WAYS), 2)); landS = np.zeros((len(WAYS), 2)); dims_off = 0; npix = 0; base = [0.0, 0]
    for k in keys[:: max(1, len(keys) // 200)]:
        try:
            img = np.asarray(Image.open(os.path.join(d, k["name"])).convert("RGB"))
        except Exception:
            continue
        H_, W_ = img.shape[:2]
        if k.get("w") and k.get("h") and (int(k["w"]), int(k["h"])) != (W_, H_):
            dims_off += 1
        a_, b_ = np.searchsorted(TTs, k["t"] - 0.3), np.searchsorted(TTs, k["t"] + 0.3)
        sel0 = order[a_:b_]
        sel_sky = sel0[sky_pt[sel0]]
        # BELOW THE CAMERA (run 567: points 1-6 ft up landed on sky 11.3% as kept, 3-7% turned or flipped; but the phone
        # was held 0.85 m up, so a wall's top or a shrub over it can stand against the sky). A point lower than the
        # camera is seen below the horizon, where no sky is: none should land on sky the right way round.
        camY = np.asarray(k["view"], np.float64)[13]
        sel0 = sel0[y_[ok][sel0] < camY - 0.2]
        sel = sel0[stand_pt[sel0]]
        if len(sel) < 20:
            continue
        V = np.asarray(k["view"], np.float64).reshape(4, 4).T
        Pm = np.asarray(k["proj"], np.float64).reshape(4, 4).T
        sky = sky_bright(img)
        if sky.mean() < 0.005:
            continue
        Vi = np.linalg.inv(V)
        base[0] += sky.mean(); base[1] += 1
        for which, pick in ((0, sel), (1, sel_sky)):
            if not len(pick):
                continue
            cam = Pw[pick] @ Vi.T
            clip = cam @ Pm.T
            wq = np.where(np.abs(clip[:, 3]) < 1e-9, 1e-9, clip[:, 3])
            u, v = (clip[:, 0] / wq + 1) / 2, (1 - clip[:, 1] / wq) / 2
            inn = (-cam[:, 2] > 0.3) & (u > 0.02) & (u < 0.98) & (v > 0.02) & (v < 0.98)
            u, v = u[inn], v[inn]
            for wi, (cu, cv_) in enumerate(((u, v), (u, 1 - v), (1 - u, v), (1 - v, u), (v, 1 - u))):
                cc = np.clip((cu * W_).astype(np.int64), 0, W_ - 1); rr = np.clip((cv_ * H_).astype(np.int64), 0, H_ - 1)
                if which == 0:
                    land[wi, 0] += sky[rr, cc].sum(); land[wi, 1] += len(cc)
                else:
                    landS[wi, 0] += sky[rr, cc].sum(); landS[wi, 1] += len(cc)
        npix += 1
    if npix:
        print(f"\nTHE PICTURES' OWN GEOMETRY ({npix} pictures with sky in them; the walk's own points taken within 0.3 s of each; {dims_off} pictures whose size is not the one their record gives), the share landing on the picture's own sky, the picture "
              + ", ".join(WAYS) + ":")
        print(f"  (A pixel picked at random in these pictures is sky {100 * base[0] / max(1, base[1]):.0f}% of the time, by the relative test.)")
        print(f"  SOLIDS BELOW THE CAMERA (a foot or more over their ground, and lower than the phone; {int(land[0, 1]):,} landings): " + " / ".join(f"{100 * land[i, 0] / max(1, land[i, 1]):.1f}%" for i in range(len(WAYS))) + ". The right way is the LOWEST.")
        print(f"  WHAT THE PHONE LABELLED SKY ({int(landS[0, 1]):,} landings): " + " / ".join(f"{100 * landS[i, 0] / max(1, landS[i, 1]):.1f}%" for i in range(len(WAYS))) + ". The right way is the HIGHEST.")
    print(f"\nCOLOUR AGAINST DEPTH: CAN THE PICTURES SAY WHERE THE LIDAR'S CROWN IS NOT? (crown_sky_study.py; blocks 2 ft x 2 ft x half a metre; a block CLEAN when {CLEAN_SHARE:.0%} of its pixels are sky blue in {CLEAN_VIEWS} pictures or more)")
    print(f"  {used:,} pictures looked at ({len(keys):,} kept after the start cut), {pics_blue:,} with blue sky in them; {nb:,} blocks: the lidar's crown 8-130 ft up, and the walk's own crown and air 8-66 ft up.")
    if ctl_blocked[1]:
        print(f"  CONTROLS: of {ctl_blocked[1]:,} steep views of them, {ctl_blocked[0]:,} ({100 * ctl_blocked[0] / ctl_blocked[1]:.0f}%) had something of the lidar's (a crown, a roof) in the line of sight, and were not counted.")
    if ctl_rgb:
        C_ = np.array(ctl_rgb); lum = C_.sum(1)
        qs = np.percentile(C_, [25, 50, 75], axis=0)
        print(f"  WHAT THE CONTROLS' PIXELS ARE (plain sky 30 m up, {len(C_):,} views): mean red / green / blue at a quarter, the middle, three quarters: "
              + "; ".join(f"{int(a)} / {int(b)} / {int(c)}" for a, b, c in qs)
              + f". Dark (all three under 100 on average, not sky: the aim off) {100 * (lum < 300).mean():.0f}%; white or grey (bright, blue within 15 of red) {100 * ((lum >= 450) & (C_[:, 2] - C_[:, 0] < 15)).mean():.0f}%; blue (blue 30 or more over red) {100 * (C_[:, 2] - C_[:, 0] >= 30).mean():.0f}%.")
    if not pics_blue:
        print("  NO BLUE SKY in the pictures (overcast, or dusk): the colour can say nothing on this walk.")
        return 0
    verdict_clean = clean_n >= CLEAN_VIEWS
    verdict_hazy = hazy_n >= 3
    # 1-2. against the depth, 8 to 30 ft (where clearHigh and the walk's crown speak)
    wk = sq * ns + np.minimum(sl, ns - 1)
    inwalk = sl < ns
    dep_crown = inwalk & crown[np.where(inwalk, wk, 0)]
    dep_air = inwalk & clear[np.where(inwalk, wk, 0)] & ~dep_crown
    seen_ok = views >= CLEAN_VIEWS
    for name, m in (("the walk's depth says CROWN (2 tree points or more in it)", dep_crown), ("the walk's depth says AIR (8 m of line, nothing seen)", dep_air)):
        m2 = m & seen_ok
        print(f"  {name}: {int(m.sum()):,} blocks, {int(m2.sum()):,} in {CLEAN_VIEWS} pictures or more; CLEAN by colour {int((m2 & verdict_clean).sum()):,} ({100 * (m2 & verdict_clean).sum() / max(1, m2.sum()):.1f}%), "
              f"HAZY {int((m2 & verdict_hazy).sum()):,} ({100 * (m2 & verdict_hazy).sum() / max(1, m2.sum()):.1f}%), both {int((m2 & verdict_clean & verdict_hazy).sum()):,}.")
    # 3. the lidar's crown, by height
    is_l = np.isin(keys_all, lkey)
    hft = bh * FT
    print("  THE LIDAR'S CROWN BLOCKS, by height over the ground (seen in 3 pictures or more / CLEAN by colour and never hazy / clean but hazy too):")
    for lo, hi in ((8, 16), (16, 30), (30, 50), (50, 80), (80, 131)):
        m = is_l & seen_ok & (hft >= lo) & (hft < hi)
        print(f"     {lo}-{hi} ft: {int((is_l & (hft >= lo) & (hft < hi)).sum()):,} blocks, {int(m.sum()):,} seen; clean {int((m & verdict_clean & ~verdict_hazy).sum()):,}; mixed {int((m & verdict_clean & verdict_hazy).sum()):,}.")
    # BY THE SHARE OF ITS VIEWS THAT ARE CLEAN (run 560: with hundreds of pictures, "clean in 3" is chance: 68.5% of the
    # depth's crown blocks and 79.6% of its air passed it). Does any share separate crown from air, all views or near?
    for lab_, cn, vn, need in (("STRICT BLUE, ALL VIEWS", clean_n, views, 10), (f"STRICT BLUE, NEAR VIEWS (within {NEAR_M:.0f} m)", cleanN, viewsN, 5),
                               ("RELATIVE BLUE, ALL VIEWS", cleanB, views, 10), (f"RELATIVE BLUE, NEAR VIEWS (within {NEAR_M:.0f} m)", cleanBN, viewsN, 5)):
        sh = np.where(vn > 0, cn / np.maximum(1, vn), np.nan)
        cc = ctl & (views >= 5)
        if lab_.endswith("ALL VIEWS") and not cc.any():
            print(f"  {lab_}: CONTROLS: none of the {int(ctl.sum())} was seen 5 times steeply enough.")
        if lab_.endswith("ALL VIEWS") and cc.any():
            qq = np.percentile(cleanB[cc] / np.maximum(1, views[cc]) if lab_.startswith("RELATIVE") else clean_n[cc] / np.maximum(1, views[cc]), [25, 50, 75])
            print(f"  {lab_}: CONTROLS (plain sky, 30 m up, seen 35 degrees up or more; {int(cc.sum())} blocks): the share of views clean {qq[0]:.2f} / {qq[1]:.2f} / {qq[2]:.2f}. Near 1.00 if the test and the aim are right.")
        c_ = dep_crown & (vn >= need)
        a_ = dep_air & (vn >= need)
        if c_.sum() < 20 or a_.sum() < 20:
            print(f"  {lab_}: too few blocks seen {need} times or more (crown {int(c_.sum())}, air {int(a_.sum())}).")
            continue
        qc, qa = np.percentile(sh[c_], [25, 50, 75]), np.percentile(sh[a_], [25, 50, 75])
        print(f"  {lab_}, blocks seen {need} times or more: the share of views that are clean sky: depth's CROWN {int(c_.sum()):,} blocks {qc[0]:.2f} / {qc[1]:.2f} / {qc[2]:.2f}; depth's AIR {int(a_.sum()):,} blocks {qa[0]:.2f} / {qa[1]:.2f} / {qa[2]:.2f} (a quarter / the middle / three quarters).")
        rows = []
        for thr in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95):
            rows.append(f"{thr:.2f}: crown {100 * (sh[c_] >= thr).mean():.1f}% / air {100 * (sh[a_] >= thr).mean():.1f}%")
        print("     cleared at a share of: " + "; ".join(rows))
        l_ = is_l & (vn >= need)
        print("     the lidar's crown blocks seen that often, cleared at 0.8 / 0.9 by height: " + ", ".join(
            f"{lo}-{hi} ft {int((l_ & (hft >= lo) & (hft < hi) & (sh >= 0.8)).sum())} / {int((l_ & (hft >= lo) & (hft < hi) & (sh >= 0.9)).sum())} of {int((l_ & (hft >= lo) & (hft < hi)).sum())}"
            for lo, hi in ((8, 16), (16, 30), (30, 50), (50, 80))) + ".")
    # BY HOW WIDE A STRETCH OF CLEAR SKY IS ROUND THE BLOCK (the owner's correction): the share of views with at least
    # R metres of sky round it, for the depth's crown, the depth's air and the plain-sky controls
    need = 10
    c_, a_, k_ = dep_crown & (views >= need), dep_air & (views >= need), ctl & (views >= 5)
    for nm, arr in (("STRICT BLUE", openS), ("RELATIVE BLUE", openB)):
        for ri, R in enumerate(OPEN_R_M):
            sh = arr[ri] / np.maximum(1, views)
            med = lambda m: float(np.median(sh[m])) if m.any() else float("nan")  # noqa: E731
            rows = "; ".join(f"{t:.1f}: crown {100 * (sh[c_] >= t).mean():.1f}% / air {100 * (sh[a_] >= t).mean():.1f}%" for t in (0.2, 0.4, 0.6) if c_.any() and a_.any())
            lid = is_l & (views >= need)
            print(f"  OPEN SKY ROUND IT, {nm}, {R * FT:.1f} ft or more of clear sky round the block: share of views, middle: crown {med(c_):.2f}, air {med(a_):.2f}, controls {med(k_):.2f}. Cleared at a share of {rows}. "
                  f"The lidar's crown at 0.4: " + ", ".join(f"{lo}-{hi} ft {int((lid & (hft >= lo) & (hft < hi) & (sh >= 0.4)).sum())} of {int((lid & (hft >= lo) & (hft < hi)).sum())}" for lo, hi in ((8, 30), (30, 50), (50, 80))) + ".")
    # THE PHONE'S OWN SKY (key-NNNN.sem): the same questions, on the pictures that kept it
    if pics_sem:
        c_, a_, k_ = dep_crown & (viewsP >= need), dep_air & (viewsP >= need), ctl & (viewsP >= 5)
        shc = cleanP / np.maximum(1, viewsP)
        med = lambda m, sh: float(np.median(sh[m])) if m.any() else float("nan")  # noqa: E731
        print(f"  THE PHONE'S OWN SKY (ARCore's label, confidence {SEM_CONF:.1f} or more; {pics_sem} pictures kept it): the block's own patch sky, share of views, middle: crown {med(c_, shc):.2f}, air {med(a_, shc):.2f}, controls {med(k_, shc):.2f}.")
        for ri, R in enumerate(OPEN_R_M):
            sh = openP[ri] / np.maximum(1, viewsP)
            rows = "; ".join(f"{t:.1f}: crown {100 * (sh[c_] >= t).mean():.1f}% / air {100 * (sh[a_] >= t).mean():.1f}%" for t in (0.2, 0.4, 0.6) if c_.any() and a_.any())
            lid = is_l & (viewsP >= need)
            print(f"  OPEN SKY ROUND IT, THE PHONE'S SKY, {R * FT:.1f} ft or more: share of views, middle: crown {med(c_, sh):.2f}, air {med(a_, sh):.2f}, controls {med(k_, sh):.2f}. Cleared at a share of {rows}. "
                  "The lidar's crown at 0.4: " + ", ".join(f"{lo}-{hi} ft {int((lid & (hft >= lo) & (hft < hi) & (sh >= 0.4)).sum())} of {int((lid & (hft >= lo) & (hft < hi)).sum())}" for lo, hi in ((8, 30), (30, 50), (50, 80))) + ".")
    else:
        print("  THE PHONE'S OWN SKY: no picture of this walk kept it (key-NNNN.sem, kept since 2026-11-24): a walk made since will answer.")
    m = is_l & dep_crown
    print(f"  The lidar's crown blocks the walk's depth also saw crown in: {int(m.sum()):,}; of those seen in 3 pictures, CLEAN by colour {int((m & seen_ok & verdict_clean).sum()):,}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
