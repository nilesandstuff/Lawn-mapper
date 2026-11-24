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
HAZY_SHARE = 0.5      # under this: something is there (or behind)
CLEAN_VIEWS = 3       # pictures a block must be clean in
NEAR_M = 12.0         # m: a 2 ft block is 3 degrees wide or more within this
TREE_KIND = 2         # structures.js: a tree column's kind (3: a solid tree)


def sky_blue(img):
    r, g, b = (img[..., i].astype(np.int32) for i in range(3))
    return (b > 140) & (b - r >= 45) & (b - g >= 15)


def sky_bright(img):
    """THE LOOSER TEST (run 561: by the strict one, crown and air alike were clean in 9% of their views, which says the
    test, not the scene): pale sky counts too. Bright (within 75% of the picture's own 99th-percentile brightness) and
    no less blue than red or green. A bare twig against it is darker."""
    r, g, b = (img[..., i].astype(np.int32) for i in range(3))
    lum = r + g + b
    return (lum >= 0.75 * np.percentile(lum, 99)) & (b >= r) & (b >= g - 5)


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
    # CONTROLS: blocks 45 m up, every 6 m over the walk's squares; seen only steeply (35 degrees up or more), nothing
    # but sky can stand behind them, so they say how much of plain sky each test calls sky
    cg_e, cg_n = np.meshgrid(np.arange((i0 + 0.5) * CELL, (i0 + w) * CELL, 6.0), np.arange((j0 + 0.5) * CELL, (j0 + h) * CELL, 6.0))
    nctl = cg_e.size
    be, bn = np.r_[be, cg_e.ravel()], np.r_[bn, cg_n.ravel()]
    bh = np.r_[bh, np.full(nctl, 45.0)]
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
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    keys = [k for k in keys if os.path.exists(os.path.join(d, k["name"])) and k.get("t", 0) >= cut]
    used, pics_blue = 0, 0
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
        vis = (zc > 1.0) & (zc < RANGE_M) & (np.abs(nx) < 0.97) & (np.abs(ny) < 0.97)
        if ctl.any():   # a control counts only when seen steeply
            camp = V[:3, 3]
            el = np.degrees(np.arctan2(P4[:, 1] - camp[1], np.hypot(P4[:, 0] - camp[0], P4[:, 2] - camp[2])))
            vis &= ~ctl | (el >= 35)
        if not vis.any():
            continue
        blue = sky_blue(img)
        if blue.mean() > 0.01:
            pics_blue += 1
        integ = np.pad(blue.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        integB = np.pad(sky_bright(img).astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
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
        views[idx] += 1
        clean_n[idx] += share >= CLEAN_SHARE
        hazy_n[idx] += share < HAZY_SHARE
        nr = zc[idx] <= NEAR_M
        viewsN[idx[nr]] += 1
        cleanN[idx[nr]] += share[nr] >= CLEAN_SHARE
        cleanB[idx] += shareB >= CLEAN_SHARE
        cleanBN[idx[nr]] += shareB[nr] >= CLEAN_SHARE
        used += 1
    print(f"\nCOLOUR AGAINST DEPTH: CAN THE PICTURES SAY WHERE THE LIDAR'S CROWN IS NOT? (crown_sky_study.py; blocks 2 ft x 2 ft x half a metre; a block CLEAN when {CLEAN_SHARE:.0%} of its pixels are sky blue in {CLEAN_VIEWS} pictures or more)")
    print(f"  {used:,} pictures looked at ({len(keys):,} kept after the start cut), {pics_blue:,} with blue sky in them; {nb:,} blocks: the lidar's crown 8-130 ft up, and the walk's own crown and air 8-66 ft up.")
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
                               ("BRIGHT SKY, ALL VIEWS", cleanB, views, 10), (f"BRIGHT SKY, NEAR VIEWS (within {NEAR_M:.0f} m)", cleanBN, viewsN, 5)):
        sh = np.where(vn > 0, cn / np.maximum(1, vn), np.nan)
        cc = ctl & (views >= 5)
        if lab_.endswith("ALL VIEWS") and not cc.any():
            print(f"  {lab_}: CONTROLS: none of the {int(ctl.sum())} was seen 5 times steeply enough.")
        if lab_.endswith("ALL VIEWS") and cc.any():
            qq = np.percentile(cleanB[cc] / np.maximum(1, views[cc]) if lab_.startswith("BRIGHT") else clean_n[cc] / np.maximum(1, views[cc]), [25, 50, 75])
            print(f"  {lab_}: CONTROLS (plain sky, 45 m up, seen 35 degrees up or more; {int(cc.sum())} blocks): the share of views clean {qq[0]:.2f} / {qq[1]:.2f} / {qq[2]:.2f}. Near 1.00 if the test and the aim are right.")
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
    m = is_l & dep_crown
    print(f"  The lidar's crown blocks the walk's depth also saw crown in: {int(m.sum()):,}; of those seen in 3 pictures, CLEAN by colour {int((m & seen_ok & verdict_clean).sum()):,}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
