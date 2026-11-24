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


def main():
    global CELL
    a = sys.argv[1:]
    keep = None
    if "--keep" in a:      # where to write the phone's squares for the map (surfaces-keep.mjs puts them beside the map)
        i = a.index("--keep"); keep = a[i + 1]; a = a[:i] + a[i + 2:]
    if "--feet" in a:      # the squares' size (run 570: at 1 ft the walk's paving broke into 30 pieces, three points a square being few)
        i = a.index("--feet"); CELL = float(a[i + 1]) / FT; a = a[:i] + a[i + 2:]
    if not a or not os.path.isdir(a[0]):
        print("usage: surfaces.py <twin dir>")
        return 1
    d = a[0]
    try:
        fit = json.load(open(os.path.join(d, "fit.json")))
    except Exception:
        fit = None
    if not (fit and fit.get("ok") and fit.get("T")):
        print(f"\nTHE GROUND AS THE WALK SAW IT: not put on the map ({(fit or {}).get('why') or 'no fit kept beside the walk'}).")
        return 0
    T = fit["T"]
    recs, kind, flags = TR.read_walk(d)
    import re
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
    ok = np.isfinite(x_) & np.isfinite(y_) & np.isfinite(z_) & np.isfinite(g_) & (t_ >= cut) & ((flags & 3) == 0) & (np.abs(y_ - g_) <= GROUND_M)
    s_, th = float(T.get("s") or 1.0), float(T["theta"])
    cth, sth = np.cos(th) * s_, np.sin(th) * s_
    E = cth * x_[ok] - sth * (-z_[ok]) + T["tx"]
    N = sth * x_[ok] + cth * (-z_[ok]) + T["ty"]
    i0, j0 = int(np.floor(E.min() / CELL)), int(np.floor(N.min() / CELL))
    ci, cj = np.floor(E / CELL).astype(int) - i0, np.floor(N / CELL).astype(int) - j0
    W, H = ci.max() + 1, cj.max() + 1
    key = cj * W + ci

    def grid(m):
        return np.bincount(key[m], minlength=W * H).reshape(H, W)
    L = lab[ok]
    ways = {"THE PHONE'S OWN LABELS": (np.isin(L, PHONE_PAVED), np.isin(L, PHONE_GRASS))}
    if kind is not None:
        K = kind[ok]
        ways["THE PICTURES' VOTE"] = (K == TR.KINDS.index("paved"), np.isin(K, [TR.KINDS.index("grass")]))
    try:
        lawn = json.load(open(os.path.join(d, "lawn.json"))).get("rings") or []
    except Exception:
        lawn = []
    print(f"\nTHE GROUND AS THE WALK SAW IT, ON THE MAP (surfaces.py; {int(ok.sum()):,} ground points after the start cut, put on the map by its {fit.get('n')} corners; squares of {CELL * FT:.0f} ft; a square called when {MIN_PTS} points or more say so and twice as many as say the other):")
    cxy = np.stack(np.meshgrid((np.arange(W) + i0 + 0.5) * CELL, (np.arange(H) + j0 + 0.5) * CELL), -1)
    lawn_in = inside(lawn, cxy[..., 0].ravel(), cxy[..., 1].ravel()).reshape(H, W) if lawn else None
    if lawn_in is not None:
        print(f"  The traced lawn: {len(lawn)} ring(s), {int(lawn_in.sum() * (CELL * FT) ** 2):,} sq ft of it on the squares the walk covers.")
    else:
        print("  The traced lawn: not read (no lawn.json): nothing compared with it.")
    out = {}
    SQ = (CELL * FT) ** 2           # square feet in a square
    # POROUS GROUND IS NOT GRASS (the owner, 2026-11-24, later the same day: "woodchips and moss count as bare soil, so
    # let's call it 'porous ground'. I'm undecided if stones should fall into that category"; and before: "sometimes turf runs up against edges of bare dirt, so we atleast
    # need to not count bare areas larger than like 4 sqft as grass"). The phone's "terrain" is grass and bare ground
    # alike; the pictures' vote tells them apart. A square is BARE when half or more of its ground points the vote
    # called bare ground; bare pieces of BARE_MIN_SQFT or more are taken out of the grass, smaller ones left in.
    BARE = (K == TR.KINDS.index("bare ground")) if kind is not None else np.zeros(len(L), bool)
    Bg, Tg = grid(BARE), grid(np.ones(len(L), bool))
    bare_sq = (Bg >= MIN_PTS) & (Bg * 2 >= Tg)
    from scipy import ndimage
    blab, bn = ndimage.label(bare_sq, structure=np.ones((3, 3)))
    bsize = np.bincount(blab.ravel())
    big_bare = bare_sq & (bsize[blab] * (CELL * FT) ** 2 >= BARE_MIN_SQFT)
    for name, (pav, gra) in ways.items():
        P, G = grid(pav), grid(gra)
        paved = (P >= MIN_PTS) & (P >= 2 * G)
        grass0 = (G >= MIN_PTS) & (G >= 2 * P)
        grass = grass0 & ~big_bare
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
                ext = cells.max(0) - cells.min(0) + CELL
                rows.append(f"{int(sizes[k] * SQ):,} sq ft, {ext.max() * FT:.0f} ft long" + (f", its longest straight run of one width {sw[1] * FT:.0f} ft long, {ftin(sw[0])} wide ({sw[2]} cross-sections)" if sw else ", no straight run of one width"))
            print(f"     The paving's pieces, largest first ({n} in all): " + "; ".join(rows) + ".")
        out[name] = {"paved": int(paved.sum()), "grass": int(grass.sum())}
        if keep and name == "THE PHONE'S OWN LABELS":
            # FOR THE START PAGE'S MAP (the owner's eyes on the lawn trace): one byte a square, rows south to north,
            # 0 not called, 1 grass, 2 paved, 3 bare (a patch of BARE_MIN_SQFT or more); the square at column c, row r has its south-west corner (i0 + c) * cellM
            # east and (j0 + r) * cellM north of the map's point
            import base64
            import zlib
            g8 = np.zeros((H, W), np.uint8)
            g8[grass] = 1
            g8[big_bare & ~paved] = 3
            g8[paved] = 2
            json.dump({"v": 1, "cellM": CELL, "i0": i0, "j0": j0, "w": int(W), "h": int(H), "from": "the walk's ground points by the phone's own labels",
                       "what": "one byte a square, rows south to north: 0 not called, 1 grass, 2 paved, 3 porous ground: bare soil, woodchips, moss (a patch of 4 sq ft or more)", "enc": "zlib+base64",
                       "kinds": base64.b64encode(zlib.compress(g8.tobytes(), 9)).decode()}, open(keep, "w"))
            print(f"     Kept for the start page's map: {os.path.basename(keep)} ({os.path.getsize(keep) / 1e3:.0f} KB).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
