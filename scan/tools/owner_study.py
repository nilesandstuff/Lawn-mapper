"""
WHAT THE OWNER'S OWN HANDS SAY ABOUT A WALK (core session, 2026-11-20).

The owner named a walk's shapes in their own words (scan/public/name.html -> seg-names.json), erased some points by
hand in the 3D view (cloud.html -> erased.bin), and reported what they saw there: "the depth to the ground is
extremely chaotic... There's distinct planes at multiple levels. I couldn't exactly sort out where the true ground
actually was... I do believe that the true ground layer was likely the most populous layer... if you were to take
the median, or even average, it would likely end up a couple inches above the true ground"; and that false points
are often sky-blue or lighter than the true surface.

    python scan/tools/owner_study.py twin

Three parts, numbers only (no place, no picture):
  NAMES    what was named, how the names sit against the machine's names, and where two of the owner's names land on
           the same kept points (where the cut or the lift put a border in the wrong place).
  ERASED   what the erased points have in common that the kept ones have not.
  GROUND   the layers the owner saw: in each 0.5 m column of ground, how many levels there are, how far apart, which
           holds most points, where the median sits against it, and WHAT A POINT'S LEVEL GOES WITH: how far the
           camera was, which pass of the walk, how sure the depth was, how light its colour.
The owner's words are category names; only names of plain letters used twice or more are printed.
"""

import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402
import studies as T        # noqa: E402
import view_prep as V      # noqa: E402

IN = 39.37
PLACED = 8
# the owner's key (2026-11-20): "ground/bare soil/gravel. I should've just called all of these ground";
# "barrel. I should've just called those machine/equipment"
SAME = {"bare soil": "ground", "soil": "ground", "gravel": "ground", "dirt": "ground", "barrel": "machine/equipment",
        "machine": "machine/equipment", "equipment": "machine/equipment", "machinery": "machine/equipment"}
COL = 0.5        # m: a column of ground
BIN = 0.02       # m: a level's thickness when counting levels
GAP_S = 20       # s apart: another pass over the same column


def plain(n):
    n = (n or "").strip().lower()
    n = SAME.get(n, n)
    return n if re.fullmatch(r"[a-z /-]{1,24}", n) else ("(other)" if n else "")


def pct(a, b):
    return f"{100 * a / max(1, b):.0f}%"


def names_part(d, w):
    nf, sf, mf = (os.path.join(d, x) for x in ("seg-names.json", "seg.json", "segments-masks.npz"))
    if not (os.path.exists(nf) and os.path.exists(sf) and os.path.exists(mf)):
        print("NAMES: none given on this walk yet.")
        return
    N, G = json.load(open(nf)), json.load(open(sf))
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj = T.tidied(z)
    pan = list(z["pan"]) if "pan" in z else None
    pan_names = [{int(a): b for a, b in nm.items()} for nm in json.loads(str(z["names"]))] if "names" in z else None
    names, own = N.get("names", {}), N.get("shapes", {})
    by, placed, fixes, machine, total, shapes_n = {}, {}, {}, {}, 0, 0
    name_maps = []
    for p, pic in enumerate(G["pictures"]):
        m = obj[p]
        lut = np.zeros(int(m.max()) + 1, np.int32)
        for sid, (thing, px, cells) in pic["shapes"].items():
            shapes_n += 1
            o = own.get(f"{p}:{sid}")
            tn = plain(names.get(str(thing)))
            n = plain(o) if o is not None else tn
            if o is not None and tn and plain(o) != tn:
                k = (tn, plain(o) or "(no name)")
                fixes[k] = fixes.get(k, 0) + 1
            if not n:
                continue
            total += 1
            by[n] = by.get(n, 0) + 1
            if cells >= PLACED:
                placed[n] = placed.get(n, 0) + 1
            if int(sid) < len(lut):
                lut[int(sid)] = 1 + list(by).index(n)
            if pan is not None and pan_names:
                under = pan[p][m == int(sid)]
                if len(under):
                    c = np.bincount(under)
                    mn = pan_names[p].get(int(c.argmax()), "nothing")
                    machine.setdefault(n, {})
                    machine[n][mn] = machine[n].get(mn, 0) + 1
        name_maps.append(lut[m])
    order = list(by)
    often = [n for n in sorted(by, key=lambda n: -by[n]) if by[n] >= 2]
    print(f"NAMES: {total:,} of {shapes_n:,} shapes carry one of the owner's names ({pct(total, shapes_n)}), in {sum(1 for nm in name_maps if nm.any())} of {len(name_maps)} photos.")
    for n in often:
        mm = sorted(machine.get(n, {}).items(), key=lambda x: -x[1])[:3]
        print(f"  {n:<20} {by[n]:>4} shapes, {placed.get(n, 0):>4} with depth under them; the picture model called them: " + (", ".join(f"{a} {pct(c, by[n])}" for a, c in mm) or "-"))
    if fixes:
        print("  Corrected on one shape (the matching had carried another name there): " + "; ".join(f"{a} -> {b}: {c}" for (a, b), c in sorted(fixes.items(), key=lambda x: -x[1])[:10]))
    else:
        print("  No shape was corrected against its thing's name.")
    # the owner's names on the kept points: a photo speaks for a point where its own depth reads the point's distance
    depths = [T.read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    vis, ms = T.lift_by_depth(w["xyz0"], sel, [nm.astype(np.uint16) for nm in name_maps], depths, 24.4)
    K = len(order) + 1
    votes = np.zeros((len(w["xyz0"]), K), np.int32)
    for v, ids in zip(vis, ms):
        np.add.at(votes, (v, ids), 1)
    votes[:, 0] = 0
    got = votes.sum(1) > 0
    top = votes.argmax(1)
    kept = int((~w["drop"]).sum())
    print(f"  On the walk's kept points: {int(got.sum()):,} of {kept:,} take a name ({pct(got.sum(), kept)}).")
    two = (votes > 0).sum(1) >= 2
    pair = {}
    for i in np.flatnonzero(two):
        a, b = np.argsort(-votes[i])[:2]
        k = tuple(sorted((order[a - 1], order[b - 1])))
        pair[k] = pair.get(k, 0) + 1
    print(f"  Points two names fell on: {int(two.sum()):,} ({pct(two.sum(), got.sum())} of the named). The pairs: " + ("; ".join(f"{a} + {b}: {c:,}" for (a, b), c in sorted(pair.items(), key=lambda x: -x[1])[:8]) or "none"))
    h, labs = w["h"], w["labs"]
    for n in often:
        i = np.flatnonzero(got & (top == 1 + order.index(n)) & np.isfinite(h))
        if len(i) < 20:
            continue
        lab = np.bincount(labs[i, 0], minlength=13)
        ln = sorted(((S_LABELS[j - 1] if j else "no label", c) for j, c in enumerate(lab) if c), key=lambda x: -x[1])[:3]
        q = np.percentile(h[i], [10, 50, 90]) * IN
        print(f"    {n:<20} {len(i):>6,} points; height over the phone's ground {q[0]:.0f} / {q[1]:.0f} / {q[2]:.0f} in (low / middle / high); the phone's own labels: " + ", ".join(f"{a} {pct(c, len(i))}" for a, c in ln))
    return votes, order


S_LABELS = ["unlabeled", "sky", "building", "tree", "road", "sidewalk", "terrain", "structure", "object", "vehicle", "person", "water"]


def all_records(d):
    recs, n_cloud = V.records(d)
    labs = []
    for pat, lp in ((r"cloud-\d+\.bin", "labels-"), (r"weak-\d+\.bin", "weaklabels-")):
        for n in sorted(x for x in os.listdir(d) if re.fullmatch(pat, x)):
            cnt = os.path.getsize(os.path.join(d, n)) // 24
            f = os.path.join(d, lp + n.split("-")[1])
            raw = np.fromfile(f, dtype=np.uint8) if os.path.exists(f) else np.zeros(0, np.uint8)
            l = raw.reshape(-1, 4).copy() if len(raw) == 4 * cnt else np.zeros((cnt, 4), np.uint8)
            if pat.startswith("weak"):
                l[:, 3] |= 4
            labs.append(l)
    labs = np.concatenate(labs) if labs else np.zeros((0, 4), np.uint8)
    rgb = None
    f = os.path.join(d, "view-rgb.bin")
    if os.path.exists(f) and os.path.getsize(f) == 4 * len(recs):
        rgb = np.fromfile(f, dtype=np.uint8).reshape(-1, 4)
    return recs, labs, rgb, n_cloud


def traits(recs, labs, rgb, rng, idx):
    out = {"n": len(idx)}
    if not len(idx):
        return out
    out["weak"] = (labs[idx, 3] & 4).astype(bool).mean()
    out["again"] = (labs[idx, 3] & 8).astype(bool).mean()
    out["conf"] = labs[idx, 2][labs[idx, 2] > 0].mean() / 255 if (labs[idx, 2] > 0).any() else float("nan")
    out["sky"] = (labs[idx, 0] == 2).mean()
    out["range"] = np.median(rng[idx]) * S.FT
    out["h"] = np.nanmedian((recs[idx, 3] - recs[idx, 5])) * S.FT
    if rgb is not None:
        c = rgb[idx][rgb[idx, 3] == 1][:, :3].astype(int)
        if len(c):
            out["blue"] = ((c[:, 2] > c[:, 0] + 20) & (c[:, 2] >= c[:, 1])).mean()
            out["light"] = c.mean()
    return out


def erased_part(d, recs, labs, rgb, rng):
    f = os.path.join(d, "erased.bin")
    if not os.path.exists(f) or not os.path.getsize(f):
        print("ERASED: nothing erased by hand on this walk yet.")
        return np.zeros(len(recs), bool)
    idx = np.fromfile(f, dtype="<u4")
    gone = np.zeros(len(recs), bool)
    gone[idx[idx < len(recs)]] = True
    # compare with the kept points NEAR the erased ones (within 1.5 m), not with the whole walk
    from scipy.spatial import cKDTree
    e = np.flatnonzero(gone)
    near = np.zeros(len(recs), bool)
    if len(e):
        t = cKDTree(recs[e, 2:5])
        dd, _ = t.query(recs[:, 2:5], distance_upper_bound=1.5)
        near = np.isfinite(dd) & ~gone
    a, b = traits(recs, labs, rgb, rng, e), traits(recs, labs, rgb, rng, np.flatnonzero(near))
    print(f"ERASED: {a['n']:,} points erased by hand; beside them (within 5 ft) {b['n']:,} points were left standing.")

    def line(name, key, fmt):
        if key in a and key in b:
            print(f"  {name:<44} erased {fmt(a[key])}; left {fmt(b[key])}")
    p = lambda x: f"{100 * x:.0f}%"  # noqa: E731
    line("weak depth (under the live confidence cut)", "weak", p)
    line("seen again from another place", "again", p)
    line("depth confidence, where given", "conf", lambda x: f"{x:.2f}")
    line("the phone called it sky", "sky", p)
    line("sky-blue in the photo", "blue", p)
    line("lightness of its colour (0-255)", "light", lambda x: f"{x:.0f}")
    line("distance from the camera, middle", "range", lambda x: f"{x:.0f} ft")
    line("height over the phone's ground, middle", "h", lambda x: f"{x:.1f} ft")
    return gone


def ground_part(recs, labs, rgb, rng, gone, track):
    """The levels of the ground. GROUND here: the phone named it terrain, road or sidewalk, or it lies within 16 in
    of the ground the page took under it (so a level well off the true one is still counted)."""
    h = recs[:, 3] - recs[:, 5]
    named = np.isin(labs[:, 0], (5, 6, 7))
    g = ~gone & ((labs[:, 3] & 3) == 0) & (named | (np.abs(h) < 0.4)) & (labs[:, 0] != 2) & (rng < 24.4) & (np.abs(np.nan_to_num(h, nan=9)) < 1.0)
    idx = np.flatnonzero(g)
    if len(idx) < 500:
        print("GROUND: too few ground points to study.")
        return
    cx, cz = np.floor(recs[idx, 2] / COL).astype(np.int64), np.floor(recs[idx, 4] / COL).astype(np.int64)
    key = cx * 100003 + cz
    order = np.argsort(key, kind="stable")
    idx, key = idx[order], key[order]
    cuts = np.flatnonzero(np.diff(key)) + 1
    groups = [x for x in np.split(idx, cuts) if len(x) >= 40]
    if len(groups) < 20:
        print("GROUND: too few well-seen columns to study.")
        return
    levels, gaps, most_is, med_off, spreads = [], [], {"lowest": 0, "middle": 0, "highest": 0, "only": 0}, [], []
    res = np.full(len(recs), np.nan)       # each point's height over its column's MOST POPULOUS level
    pass_gap, pass_n, within = [], 0, []
    for gi in groups:
        y = recs[gi, 3].astype(np.float64)
        lo = np.percentile(y, 1)
        hist = np.bincount(np.clip(((y - lo) / BIN).astype(int), 0, 79), minlength=80).astype(float)
        sm = np.convolve(hist, [0.25, 0.5, 0.25], mode="same")
        pk = [i for i in range(80) if sm[i] >= 0.2 * sm.max() and sm[i] == sm[max(0, i - 2):i + 3].max()]
        kept = []
        for i in pk:                      # levels at least 2 in apart
            if not kept or i - kept[-1] >= 3:
                kept.append(i)
            elif sm[i] > sm[kept[-1]]:
                kept[-1] = i
        top = max(kept, key=lambda i: sm[i])
        mode = lo + (top + 0.5) * BIN
        levels.append(len(kept))
        if len(kept) > 1:
            gaps += list(np.diff(kept) * BIN)
            most_is["lowest" if top == kept[0] else "highest" if top == kept[-1] else "middle"] += 1
        else:
            most_is["only"] += 1
        med_off.append(np.median(y) - mode)
        spreads.append(np.percentile(y, 90) - np.percentile(y, 10))
        res[gi] = y - mode
        # passes: the same column seen at times GAP_S apart
        t = recs[gi, 0]
        o = np.argsort(t)
        br = np.flatnonzero(np.diff(t[o]) > GAP_S) + 1
        ps = [p for p in np.split(o, br) if len(p) >= 12]
        if len(ps) >= 2:
            pass_n += 1
            m = [np.median(y[p]) for p in ps]
            pass_gap.append(max(m) - min(m))
            within.append(np.median([np.percentile(y[p], 90) - np.percentile(y[p], 10) for p in ps]))
    L = np.array(levels)
    n = len(groups)
    print(f"GROUND: {len(idx):,} ground points in {n:,} columns ({COL * S.FT:.1f} ft square, 40 points or more each).")
    print(f"  Thickness of the ground in a column (the middle 80% of its points): middle {np.median(spreads) * IN:.1f} in; a quarter of columns over {np.percentile(spreads, 75) * IN:.1f} in; a tenth over {np.percentile(spreads, 90) * IN:.1f} in.")
    print(f"  Levels in a column (2 in or more apart, each a fifth or more of the fullest): one {pct((L == 1).sum(), n)}, two {pct((L == 2).sum(), n)}, three or more {pct((L >= 3).sum(), n)}." + (f" Levels are {np.median(gaps) * IN:.1f} in apart in the middle (a quarter over {np.percentile(gaps, 75) * IN:.1f} in)." if gaps else ""))
    many = n - most_is["only"]
    if many:
        print(f"  Where there is more than one level, the fullest is the LOWEST in {pct(most_is['lowest'], many)}, the highest in {pct(most_is['highest'], many)}, one between in {pct(most_is['middle'], many)}.")
    mo = np.array(med_off) * IN
    print(f"  The middle point of a column against its fullest level: {np.median(mo):+.1f} in in the middle; over 1 in above it in {pct((mo > 1).sum(), n)} of columns, over 1 in below in {pct((mo < -1).sum(), n)}.")
    if pass_n:
        print(f"  PASSES ({pass_n:,} columns seen on two passes or more, {GAP_S} s apart): the passes' own ground levels differ by {np.median(pass_gap) * IN:.1f} in in the middle (a quarter over {np.percentile(pass_gap, 75) * IN:.1f} in); within ONE pass the ground is {np.median(within) * IN:.1f} in thick.")
    ok = np.flatnonzero(np.isfinite(res))
    r = res[ok] * IN

    def table(title, val, edges, names):
        b = np.digitize(val, edges)
        cells = []
        for i, nm in enumerate(names):
            x = r[b == i]
            if len(x) >= 200:
                cells.append(f"{nm}: {np.median(x):+.1f} in (spread {np.percentile(x, 90) - np.percentile(x, 10):.1f}, {len(x):,})")
        if cells:
            print(f"  A POINT'S LEVEL OVER ITS COLUMN'S FULLEST LEVEL, by {title}: " + "; ".join(cells))
    table("how far the camera was", rng[ok] * S.FT, [6, 12, 25, 45], ["under 6 ft", "6-12 ft", "12-25 ft", "25-45 ft", "45 ft on"])
    cf = labs[ok, 2] / 255.0
    has = cf > 0
    if has.sum() > 1000:
        b = np.digitize(cf[has], [0.2, 0.5, 0.8])
        cells = []
        for i, nm in enumerate(["under 0.2", "0.2-0.5", "0.5-0.8", "0.8 on"]):
            x = r[has][b == i]
            if len(x) >= 200:
                cells.append(f"{nm}: {np.median(x):+.1f} in (spread {np.percentile(x, 90) - np.percentile(x, 10):.1f}, {len(x):,})")
        print("  ... by how sure the depth was: " + "; ".join(cells))
    for nm, m in (("seen once", (labs[ok, 3] & 8) == 0), ("seen again from another place", (labs[ok, 3] & 8) > 0), ("weak depth", (labs[ok, 3] & 4) > 0), ("depth at the live cut", (labs[ok, 3] & 4) == 0)):
        if m.sum() >= 200:
            print(f"  ... {nm}: {np.median(r[m]):+.1f} in (spread {np.percentile(r[m], 90) - np.percentile(r[m], 10):.1f}, {int(m.sum()):,})")
    if rgb is not None:
        c = rgb[ok]
        has = c[:, 3] == 1
        if has.sum() > 1000:
            light = c[has, :3].astype(float).mean(1)
            q = np.percentile(light, [33, 67])
            b = np.digitize(light, q)
            print("  ... by the lightness of its colour in the photo: " + "; ".join(f"{nm}: {np.median(r[has][b == i]):+.1f} in (spread {np.percentile(r[has][b == i], 90) - np.percentile(r[has][b == i], 10):.1f})" for i, nm in enumerate(["darkest third", "middle third", "lightest third"])))
            # the owner's own test: within a column, is a lighter point further from the fullest level?
            off = np.abs(r[has])
            print(f"  ... points within 1 in of the fullest level have lightness {light[off <= 1].mean():.0f}; 2-4 in off it {light[(off > 2) & (off <= 4)].mean():.0f}; over 4 in off it {light[off > 4].mean():.0f}.")
    # the camera's own height over the ground it took, by pass: does the phone's frame drift up and down?
    if len(track) > 10:
        above = r > 1.5
        print(f"  Points over 1.5 in above the fullest level: {pct(above.sum(), len(r))}; over 1.5 in below it: {pct((r < -1.5).sum(), len(r))}.")


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    w = T.load(d)
    try:
        names_part(d, w)
    except Exception as e:  # the other two parts must still be read
        print(f"NAMES: could not be read ({type(e).__name__}: {str(e)[:120]}).")
    recs, labs, rgb, n_cloud = all_records(d)
    track = w["track"]
    rng = np.linalg.norm(recs[:, 2:5] - S.cam_at(track, recs[:, 0].astype(np.float64)), axis=1) if len(track) >= 2 else np.full(len(recs), np.nan)
    gone = erased_part(d, recs, labs, rgb, rng)
    ground_part(recs, labs, rgb, rng, gone, track)


if __name__ == "__main__":
    main()
