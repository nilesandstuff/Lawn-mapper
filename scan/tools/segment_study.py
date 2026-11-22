"""
SEGMENT FIRST, NAME AFTER: A TRIAL ON ONE WALK (core session, 2026-11-18; docs/SCAN-PLAN.md section 29, the thesis).

The owner: "That model may not actually solve the labelling, but it could be useful for sorting the unlabeled stuff by
segmenting it... Also might be very helpful for producing smoother shapes", and, the same day: "If this doesn't work
maybe we should try a simpler 2D segmentation... Maybe a combo segmentation and classifier if one exists."

The model the owner found (SAMPart3D, arXiv 2411.07184) cuts ONE clean object into parts: it renders views of a mesh,
runs Segment Anything on each and lifts the shapes back into 3D. A walk is a yard of points, not a mesh, but it
already holds what that recipe needs: pictures, where the phone was for each, and depth points. So this runs the
recipe on the walk's own pictures, and compares:

  by shape alone     the standing points grouped by touching (0.2 m cubes). Free; no picture is read.
  panoptic           a picture model that cuts AND names in one pass (Mask2Former, ADE20K: fence, wall, tree, plant,
                     grass, road, building, car ...). The owner's "combo". Free on the runner's CPU.
  SAM objects/parts  Segment Anything's shapes (Modal's GPU, scan/tools/segment_modal.py: paid, asked first), read
                     twice: the largest shape at each pixel (objects), the smallest (parts).

THE LIFT (the same for every picture model): each point is put into each picture that saw it (inside the frame, within
RANGE of the camera, not hidden behind nearer points), and takes that picture's shape there. Two shapes from two
pictures are ONE thing when, on the points both pictures saw, they share at least half (IOU). A point belongs to the
thing most of its pictures voted for. The picture is read "as kept" (SCAN-H7, measured).

    python scan/tools/segment_study.py twin                       by shape alone
    python scan/tools/segment_study.py twin --panoptic            + the panoptic model, here on the CPU
    python scan/tools/segment_study.py twin --masks out/masks.npz + what segment_modal.py brought back
    python scan/tools/segment_study.py --selftest                 the lift on a made-up scene

With twin/disagree-cells.json (scan/tools/disagree.mjs, CELLS_OUT): what each patch the phone saw and the lidar lacks
turns out to be. Prints COUNTS, SIZES AND NAMES ONLY: no coordinate, no place. The top-down pictures it writes
(segments-*.png, about the walk's own middle) go to the private bucket, never to the log.
"""

import json
import os
import re
import sys
import time

import numpy as np

# m: a picture speaks for points this near its camera. 8 m (26 ft). At 24.4 m (80 ft), tried 2026-11-19, the lift
# fell apart: nearly every standing point ended in ONE thing 174 ft long on one walk and 85 ft on the other (the
# hidden-behind test is too loose at range, and a pose a little off puts a far shape on the wrong points). A longer
# reach needs each picture's own depth to say what it saw; until then LIFT_RANGE is for trying it.
RANGE = float(os.environ.get("LIFT_RANGE", "8"))
ZCELL = 8        # px: the cell of the hidden-behind test
MIN_PTS = 15     # a shape with fewer points in a picture says nothing
IOU = 0.5        # two pictures' shapes are one thing when they share this much of what both saw
PAIR_MIN = 30    # points two pictures must both see to be compared
STAND = 0.3      # m over the ground: standing
NEAR = 6.0       # m: without the report's verdicts (judged.bin), a point counts when the phone was this near
JOIN_VOX = 0.25  # m: two things of one name whose points come this near are one thing
VOX = 0.2        # m: "touching", for the grouping by shape alone
PIECE_MIN = 30   # points: a thing smaller than this is not listed
PIC_MAX = int(os.environ.get("PIC_MAX", "120"))  # pictures read on the CPU (evenly through the walk)
LABELS = ['unlabeled', 'sky', 'building', 'tree', 'road', 'sidewalk', 'terrain', 'structure', 'object', 'vehicle', 'person', 'water']
PAN_MODEL = "facebook/mask2former-swin-large-ade-panoptic"
# NAMING THE SHAPES (2026-11-19). The owner judged SAM objects the right cut and the panoptic model's names "pretty
# good". A small picture-and-words model (CLIP) was tried on each SAM shape cut out of its picture (2026-11-18): the
# owner, "very bad. Irrevocably bad." It is gone. What a cut-out loses is what is round it; a model that names every
# pixel of the WHOLE picture keeps that, so a shape takes the name most of its own pixels were given (name_by_vote):
# today the panoptic model's, already made for every picture; any per-pixel namer can stand in.
NAME_AREA = 0.002   # of the picture: a shape smaller than this is not named
FT = 3.281


# ---------------------------------------------------------------- the twin

def read_twin(d):
    """-> recs (N, 6) [t, odo, x, y, z, ground], labs (N, 4) uint8, keys (those whose picture is there, by time)."""
    recs, labs = [], []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"cloud-\d+\.bin", x)):
        a = np.fromfile(os.path.join(d, n), dtype="<f4")
        a = a[: len(a) // 6 * 6].reshape(-1, 6)
        l = np.zeros((len(a), 4), np.uint8)
        lp = os.path.join(d, n.replace("cloud-", "labels-"))
        if os.path.exists(lp):
            raw = np.fromfile(lp, dtype=np.uint8)
            if len(raw) == 4 * len(a):
                l = raw.reshape(-1, 4)
        recs.append(a)
        labs.append(l)
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        with open(os.path.join(d, n)) as f:
            keys += json.load(f)
    keys = sorted((k for k in keys if os.path.exists(os.path.join(d, k["name"]))), key=lambda k: k["t"])
    if not recs:
        return np.zeros((0, 6), np.float32), np.zeros((0, 4), np.uint8), keys
    return np.concatenate(recs), np.concatenate(labs), keys


def erased(d, n):
    """The points the owner erased by hand in the 3D view (scan/public/cloud.html; twin part erased.bin: indexes
    into the records, the cloud's first). -> (n,) bool for the cloud's records."""
    out = np.zeros(n, bool)
    f = os.path.join(d, "erased.bin")
    if os.path.exists(f):
        idx = np.fromfile(f, dtype="<u4")
        out[idx[idx < n]] = True
    return out


def start_cut(d, recs):
    """THE WALK'S START IS LEFT OUT (the owner, 2026-11-21: "MAYBE we should discard the points that have been
    collected before all references have been marked?"; tried by eye in the 3D view: on the walk of 2026-11-20 the
    second garage wall was what the first minute saw, and hiding the start left one wall). The cut is the moment
    every roof corner had been marked ONCE (live.json marks, each with the metres walked; a corner asked for again
    later does not move it). -> seconds into the walk, or 0 when the walk kept no marks.
    Why the start lies off is NOT KNOWN (docs/SCAN-PLAN.md 47: the map fix moves no point; a phone's tracking is
    least settled when a session is young)."""
    # the places seen twice may put it later (mend_study.py start_by_overlaps keeps start.json; 2026-11-22)
    more = 0.0
    try:
        with open(os.path.join(d, "start.json")) as f:
            more = float((json.load(f) or {}).get("startCutS") or 0)
    except Exception:
        more = 0.0
    try:
        with open(os.path.join(d, "live.json")) as f:
            marks = [m for m in (json.load(f) or {}).get("marks", []) if m.get("odo") is not None and m.get("id") is not None]
    except Exception:
        return more
    if not marks or len(recs) < 10:
        return more
    ids = {m["id"] for m in marks}
    seen, odo = set(), None
    for m in sorted(marks, key=lambda m: m["odo"]):
        seen.add(m["id"])
        if seen == ids:
            odo = float(m["odo"])
            break
    if odo is None:
        return more
    o = np.argsort(recs[:, 1])
    return max(more, float(np.interp(odo, recs[o, 1], recs[o, 0])))


def read_track(d):
    """-> (M, 4) [t, x, y, z] by time: where the camera was, five times a second."""
    tr = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"track-\d+\.bin", x)):
        a = np.fromfile(os.path.join(d, n), dtype="<f4")
        tr.append(a[: len(a) // 10 * 10].reshape(-1, 10)[:, [0, 2, 3, 4]])
    if not tr:
        return np.zeros((0, 4))
    tr = np.concatenate(tr).astype(np.float64)
    return tr[np.argsort(tr[:, 0])]


def cam_at(track, t):
    """The camera's place at each time t (the nearest pose)."""
    i = np.clip(np.searchsorted(track[:, 0], t), 1, len(track) - 1)
    i = np.where(np.abs(track[i - 1, 0] - t) < np.abs(track[i, 0] - t), i - 1, i)
    return track[i, 1:4]


def pose_keys(keys, track):
    """Each key gets "c2w", its camera-to-session matrix. A picture's `view` was kept two ways: the web page's WebXR
    walks kept the camera's own matrix (camera to session); the app's walks keep ARCore's VIEW matrix (session to
    camera; found here 2026-11-18, when 2% of an app walk's points fell in its pictures). Whichever puts the cameras
    where the track says they were is the one. -> 'camera to session' | 'session to camera' | 'unknown (no track)'."""
    Ms = [np.array(k["view"], dtype=np.float64).reshape(4, 4).T for k in keys]
    which = "unknown (no track)"
    inv = False
    if len(track) >= 2 and keys:
        want = cam_at(track, np.array([k["t"] for k in keys]))
        as_is = np.median(np.linalg.norm(np.array([M[:3, 3] for M in Ms]) - want, axis=1))
        turned = np.median(np.linalg.norm(np.array([np.linalg.inv(M)[:3, 3] for M in Ms]) - want, axis=1))
        inv = turned < as_is
        which = f"{'session to camera (the app)' if inv else 'camera to session'}; the cameras then sit {min(as_is, turned) * 39.37:.0f} in from the track (the other reading: {max(as_is, turned) * FT:.0f} ft)"
    for k, M in zip(keys, Ms):
        k["c2w"] = np.linalg.inv(M) if inv else M
    return which


# ---------------------------------------------------------------- the lift

def project(xyz1, key, W, H):
    """Each point's pixel in a picture ("as kept"), its range, and whether it is in the frame and near enough."""
    V = np.linalg.inv(key["c2w"])
    P = np.array(key["proj"], dtype=np.float64).reshape(4, 4).T
    cam = xyz1 @ V.T
    z = -cam[:, 2]
    clip = cam @ P.T
    w = np.where(np.abs(clip[:, 3]) < 1e-9, 1e-9, clip[:, 3])
    nx, ny = clip[:, 0] / w, clip[:, 1] / w
    ok = (z > 0.3) & (z < RANGE) & (np.abs(nx) < 0.98) & (np.abs(ny) < 0.98)
    px = np.clip(((nx + 1) / 2 * W).astype(np.int64), 0, W - 1)
    py = np.clip(((1 - ny) / 2 * H).astype(np.int64), 0, H - 1)
    return px, py, z, ok


def seen(px, py, z, ok, W, H):
    """The points a picture really saw: not hidden behind nearer points of its cell. -> sorted indexes."""
    idx = np.flatnonzero(ok)
    if not len(idx):
        return idx
    cw = W // ZCELL + 1
    cell = (py[idx] // ZCELL) * cw + px[idx] // ZCELL
    zmin = np.full((H // ZCELL + 1) * cw, np.inf)
    np.minimum.at(zmin, cell, z[idx])
    return idx[z[idx] <= zmin[cell] * 1.1 + 0.2]


def lift(xyz, keys, idmaps):
    """idmaps[p]: (h, w) ints, 0 none (any size: scaled to the picture). -> vis[p] sorted point indexes the picture
    saw, ms[p] its shape id at each (0 none; shapes under MIN_PTS points dropped)."""
    xyz1 = np.concatenate([xyz.astype(np.float64), np.ones((len(xyz), 1))], 1)
    vis, ms = [], []
    for k, m in zip(keys, idmaps):
        h, w = m.shape
        px, py, z, ok = project(xyz1, k, w, h)
        v = seen(px, py, z, ok, w, h)
        ids = m[py[v], px[v]].astype(np.int64)
        n = np.bincount(ids, minlength=int(m.max()) + 1)
        ids[n[ids] < MIN_PTS] = 0
        vis.append(v)
        ms.append(ids)
    return vis, ms


def merge(vis, ms, cams=None):
    """Shapes of different pictures joined when they share IOU of what both pictures saw. -> off (each picture's
    first node), comp (node -> thing), joined (share of shapes joined to another picture's)."""
    K = [int(m.max()) + 1 if len(m) else 1 for m in ms]
    off = np.concatenate([[0], np.cumsum(K)])
    parent = np.arange(off[-1])

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    P = len(vis)
    for p in range(P):
        if len(vis[p]) < PAIR_MIN:
            continue
        for q in range(p + 1, P):
            if len(vis[q]) < PAIR_MIN or (cams is not None and np.linalg.norm(cams[p] - cams[q]) > 2 * RANGE):
                continue
            _, ip, iq = np.intersect1d(vis[p], vis[q], assume_unique=True, return_indices=True)
            if len(ip) < PAIR_MIN:
                continue
            a, b = ms[p][ip], ms[q][iq]
            na, nb = np.bincount(a, minlength=K[p]), np.bincount(b, minlength=K[q])
            both = (a > 0) & (b > 0)
            if not both.any():
                continue
            u, c = np.unique(a[both] * K[q] + b[both], return_counts=True)
            ua, ub = u // K[q], u % K[q]
            good = (c >= 10) & (c / (na[ua] + nb[ub] - c) >= IOU)
            for x, y in zip(ua[good], ub[good]):
                rx, ry = find(off[p] + x), find(off[q] + y)
                if rx != ry:
                    parent[ry] = rx
    comp = np.array([find(i) for i in range(off[-1])])
    used = np.zeros(off[-1], bool)
    for p in range(P):
        used[off[p] + np.unique(ms[p][ms[p] > 0])] = True
    sizes = np.bincount(comp[used], minlength=off[-1])
    joined = float((sizes[comp[used]] > 1).mean()) if used.any() else 0.0
    return off, comp, joined


def vote(n_points, vis, ms, off, comp):
    """Each point's thing by the vote of its pictures. -> piece (N,) (-1 none), purity (mean share of a point's votes
    that went to its thing, over points with two or more), votes [(point, node)] for naming."""
    pts, nodes = [], []
    for p in range(len(vis)):
        on = ms[p] > 0
        pts.append(vis[p][on])
        nodes.append(off[p] + ms[p][on])
    pts, nodes = np.concatenate(pts) if pts else np.zeros(0, np.int64), np.concatenate(nodes) if nodes else np.zeros(0, np.int64)
    piece = np.full(n_points, -1, np.int64)
    if not len(pts):
        return piece, 0.0, pts, nodes
    c = comp[nodes]
    u, cnt = np.unique(pts * (comp.max() + 1) + c, return_counts=True)
    up, uc = u // (comp.max() + 1), u % (comp.max() + 1)
    order = np.lexsort((-cnt, up))
    first = np.concatenate([[True], up[order][1:] != up[order][:-1]])
    win_p, win_c, win_n = up[order][first], uc[order][first], cnt[order][first]
    piece[win_p] = win_c
    total = np.bincount(pts, minlength=n_points)[win_p]
    many = total >= 2
    purity = float((win_n[many] / total[many]).mean()) if many.any() else 0.0
    return piece, purity, pts, nodes


def by_shape(xyz, h):
    """The standing points grouped by touching (VOX cubes, corners count). -> piece (N,), -1 for the rest."""
    from scipy import ndimage
    piece = np.full(len(xyz), -1, np.int64)
    idx = np.flatnonzero(np.isfinite(h) & (h > STAND))
    if not len(idx):
        return piece
    v = np.floor(xyz[idx] / VOX).astype(np.int64)
    v -= v.min(0)
    grid = np.zeros(tuple(v.max(0) + 1), bool)
    grid[v[:, 0], v[:, 1], v[:, 2]] = True
    lab, _ = ndimage.label(grid, structure=np.ones((3, 3, 3)))
    piece[idx] = lab[v[:, 0], v[:, 1], v[:, 2]]
    return piece


# ---------------------------------------------------------------- what a thing is like

def describe(xyz, h, idx):
    """A thing's size about its own middle: length and thickness on the ground, how high it stands."""
    e, n = xyz[idx, 0], -xyz[idx, 2]
    hh = h[idx][np.isfinite(h[idx])]
    c = np.stack([e - e.mean(), n - n.mean()], 1)
    if len(idx) >= 3:
        _, vec = np.linalg.eigh(np.cov(c.T) + 1e-9 * np.eye(2))
        a, b = c @ vec[:, 1], c @ vec[:, 0]
        length, thick = np.percentile(a, 98) - np.percentile(a, 2), np.percentile(b, 98) - np.percentile(b, 2)
    else:
        length = thick = 0.0
    lo, top = (float(np.percentile(hh, 5)), float(np.percentile(hh, 95))) if len(hh) else (0.0, 0.0)
    standing = float((hh > STAND).mean()) if len(hh) else 0.0
    if standing < 0.3:
        shape = "flat"
    elif length >= 2 and thick <= max(0.8, length / 5) and top <= 2.8:
        shape = "line"
    elif top > 3:
        shape = "tall"
    else:
        shape = "thing"
    return {"n": int(len(idx)), "length": float(length), "thick": float(thick), "lo": lo, "top": top, "standing": standing, "shape": shape}


def says(d):
    return f"{d['shape']} {d['length'] * FT:.0f} ft long, {d['thick'] * FT:.0f} ft thick, {max(0, d['top']) * FT:.0f} ft high"


def feet(ds):
    return ", ".join("%.0f ft" % (d["length"] * FT) for d in sorted(ds, key=lambda d: -d["length"])[:5])


def top_of(counts, least=0.0):
    if not counts:
        return None, 0.0
    tot = sum(counts.values())
    k = max(counts, key=counts.get)
    return (k, counts[k] / tot) if counts[k] / tot >= least else (None, counts[k] / tot)


def report(name, piece, xyz, h, labs, patches, classes=None, extra=""):
    """One way of cutting the walk up, as lines. classes: {piece id: {class name: votes}} when the model names."""
    out = [f"== {name} =={extra}"]
    stand = np.isfinite(h) & (h > STAND)
    ids, cnt = np.unique(piece[piece >= 0], return_counts=True)
    big = ids[cnt >= PIECE_MIN]
    if not len(big):
        return out + ["  nothing: no thing of 30 points or more."], {}
    desc = {int(i): describe(xyz, h, np.flatnonzero(piece == i)) for i in big}
    standing = {i: d for i, d in desc.items() if d["shape"] != "flat"}
    in_piece = np.isin(piece, big)
    s_in = int((stand & in_piece).sum())
    biggest = max((int((stand & (piece == i)).sum()) for i in standing), default=0)
    out.append(f"  {len(big)} things of {PIECE_MIN} points or more ({len(standing)} standing, {len(big) - len(standing)} flat); "
               f"{100 * s_in / max(1, stand.sum()):.0f}% of the standing points are in one; the biggest standing thing holds {100 * biggest / max(1, stand.sum()):.0f}% of them.")
    kinds = {}
    for i, d in standing.items():
        kinds.setdefault(d["shape"], []).append(d)
    for k in ("line", "tall", "thing"):
        if k in kinds:
            ds = sorted(kinds[k], key=lambda d: -d["length"])
            out.append(f"  {len(ds)} {k}{'s' if len(ds) > 1 else ''}: " + ", ".join("%.0fx%.0f ft, %.0f high" % (d["length"] * FT, d["thick"] * FT, max(0, d["top"]) * FT) for d in ds[:10]) + (" ..." if len(ds) > 10 else ""))
    if classes:
        byc = {}
        for i, d in standing.items():
            c, share = top_of(classes.get(i, {}), 0.5)
            byc.setdefault(c or "no clear name", []).append(d)
        out.append("  the standing things, by the model's name: " + "; ".join(
            f"{len(ds)} {c} ({feet(ds)})" for c, ds in sorted(byc.items(), key=lambda kv: -len(kv[1]))))
    # the phone's own labels inside each standing thing: is a thing one label, or a mix?
    lab_pure = []
    for i in standing:
        l = labs[(piece == i) & stand, 0]
        l = l[l > 0]
        if len(l) >= 10:
            lab_pure.append(np.bincount(l).max() / len(l))
    if lab_pure:
        out.append(f"  the phone's label inside a standing thing: its commonest label covers {100 * np.mean(lab_pure):.0f}% of the thing on average.")
    for j, pt in enumerate(patches):
        idx = np.array([i for i in pt.get("idx", []) if i < len(piece)], np.int64)
        if not len(idx):
            continue
        pc = piece[idx]
        u, c = np.unique(pc[pc >= 0], return_counts=True)
        keep = [(int(a), int(b)) for a, b in sorted(zip(u, c), key=lambda t: -t[1]) if a in desc and b >= 0.1 * len(idx)]
        head = f"  patch {j + 1} ({pt['cells']} m2{', a line ' + str(round(pt['lengthM'] * FT)) + ' ft' if pt.get('line') else ''}, the phone said {pt['label']}): "
        if not keep:
            out.append(head + (f"only in bits under {PIECE_MIN} points." if (pc >= 0).mean() > 0.5 else f"in no thing ({100 * (pc >= 0).mean():.0f}% of its points in any)."))
            continue
        a, b = keep[0]
        nm = ""
        if classes:
            c, share = top_of(classes.get(a, {}))
            nm = f"; the model calls it {c} ({100 * share:.0f}% of votes)" if c else ""
        out.append(head + f"{len(keep)} thing{'s' if len(keep) > 1 else ''}; the main one holds {100 * b / len(idx):.0f}% of it: a {says(desc[a])}{nm}.")
    return out, desc


def sheet(xyz, h, idx):
    """A patch's own shape, whatever it was cut into: the flat sheet that fits its points best, how far that leans
    from level and how thick the points are about it. Level and thin is ground the phone took for standing (a bank,
    a slope, a kerb, or its ground height being off); upright and thin is a fence or a wall; thick is a lump."""
    P = xyz[idx].astype(np.float64)
    P = P[np.isfinite(P).all(1)]
    if len(P) < 20:
        return None
    c = P - P.mean(0)
    w, v = np.linalg.eigh(np.cov(c.T))
    nrm = v[:, 0]
    lean = float(np.degrees(np.arccos(min(1.0, abs(nrm[1])))))
    d = c @ nrm
    thick = float(np.percentile(d, 95) - np.percentile(d, 5))
    hh = h[idx][np.isfinite(h[idx])]
    lo, hi = float(np.percentile(hh, 5)), float(np.percentile(hh, 95))
    kind = "level and thin: ground read as standing (a bank, a slope, or the ground height off)" if lean < 35 and thick <= 0.3 else \
           "upright and thin: a fence or a wall" if lean > 60 and thick <= 0.35 else "a lump (a shrub, a pile, an object)"
    return f"its points fit a sheet leaning {lean:.0f} deg from level, {thick * 12 * FT:.0f} in thick, {lo * FT:.1f}-{hi * FT:.1f} ft over the phone's ground -> {kind}"


def picture(path, xyz, h, piece, big):
    """From above, about the walk's own middle: the ground grey, each thing its own colour."""
    from PIL import Image
    e, n = xyz[:, 0], -xyz[:, 2]
    # (the lifts hand their left-out points over as far away, not as NaN: 2026-11-18 the views from above of the
    # picture models came out blank, every point squeezed into the middle by them)
    ok = np.isfinite(e) & np.isfinite(n) & (np.abs(e) < 1e5) & (np.abs(n) < 1e5)
    if not ok.any():
        return
    e, n = np.where(ok, e, 0.0), np.where(ok, n, 0.0)
    e0, n0 = np.median(e[ok]), np.median(n[ok])
    r = max(5.0, float(np.percentile(np.hypot(e[ok] - e0, n[ok] - n0), 99)))
    S = 1000
    x = np.clip(((e - e0) / r * 0.5 + 0.5) * (S - 1), 0, S - 1).astype(np.int64)
    y = np.clip((0.5 - (n - n0) / r * 0.5) * (S - 1), 0, S - 1).astype(np.int64)
    img = np.full((S, S, 3), 255, np.uint8)
    rng = np.random.default_rng(3)
    pal = rng.integers(30, 220, size=(int(piece.max()) + 2, 3)).astype(np.uint8)
    flat = ok & ~(np.isin(piece, big) & np.isfinite(h) & (h > STAND))
    img[y[flat], x[flat]] = (205, 205, 205)
    on = ok & np.isin(piece, big) & np.isfinite(h) & (h > STAND)
    for dy in (0, 1):
        for dx in (0, 1):
            img[np.clip(y[on] + dy, 0, S - 1), np.clip(x[on] + dx, 0, S - 1)] = pal[piece[on]]
    Image.fromarray(img).save(path)


# ---------------------------------------------------------------- the picture models

def panoptic_maps(imgs, device="cpu", log=print):
    """Mask2Former (ADE20K panoptic) on each picture. -> idmaps [(H, W) uint16, 0 none], names [{id: class}]."""
    import torch
    from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation
    from transformers.utils import logging as hf_logging
    hf_logging.set_verbosity_error()
    proc = AutoImageProcessor.from_pretrained(PAN_MODEL)
    model = Mask2FormerForUniversalSegmentation.from_pretrained(PAN_MODEL).to(device).eval()
    maps, names = [], []
    t0 = time.time()
    for i, im in enumerate(imgs):
        with torch.no_grad():
            o = model(**proc(images=im, return_tensors="pt").to(device))
        r = proc.post_process_panoptic_segmentation(o, target_sizes=[(im.height, im.width)])[0]
        seg = r["segmentation"].cpu().numpy()
        m = np.zeros(seg.shape, np.uint16)
        nm = {}
        for j, s in enumerate(r["segments_info"]):
            m[seg == s["id"]] = j + 1
            nm[j + 1] = model.config.id2label[s["label_id"]].split(",")[0].strip()
        maps.append(m)
        names.append(nm)
        if i == 4:
            log(f"  the panoptic model: {(time.time() - t0) / 5:.1f} s a picture on {device}")
    return maps, names


def name_by_vote(maps, name_maps, names):
    """Each shape of `maps` named by the vote of its own pixels in a per-pixel naming of the same picture
    (`name_maps` ids with their `names`). -> [{id: name}], a shape named only when one name holds 40% of it."""
    out = []
    for m, nm_map, nm in zip(maps, name_maps, names):
        nm = {int(k): v for k, v in nm.items()}
        K = int(nm_map.max()) + 1
        res = {}
        ids, cnt = np.unique(m[m > 0], return_counts=True)
        for i in ids[cnt >= NAME_AREA * m.size]:
            v = np.bincount(nm_map[m == i].astype(np.int64), minlength=K)
            v[0] = 0
            top = int(v.argmax())
            if top in nm and v[top] >= 0.4 * (m == i).sum():
                res[int(i)] = nm[top]
        out.append(res)
    return out


FOLD_AREA = 0.005   # of the picture: a shape smaller than this, ringed by one other shape, is folded into it
FOLD_RING = 0.6     # ... when that one shape (or the unshaped ground) is this share of what touches it
SKY_SHARE = 0.8     # a shape this much sky by the whole-picture model is sky: clouds are not things


def tidy_shapes(m, pan=None, pan_names=None):
    """THE OWNER, LOOKING AT THE SHEETS (2026-11-19): "Clouds, rocks, and non-uniform patches of turf are all segmented
    separately... we should fold in shapes of a certain size, when they're surrounded by a bigger shape. Size
    measured in pixels. So it would only segment a rock if it's a big rock or if you're really close to it. (...
    it might be a handy feature to have sprinkler heads automatically segmented and named by looking directly at
    it)", and of clouds: "we wouldn't [want] to be labelling trees as sky in an attempt to avoid segmenting clouds."
    One picture's shapes -> the same with (1) every shape the whole-picture model calls sky (SKY_SHARE of its pixels)
    made ONE sky shape, so a cloud is sky and a tree against the sky stays a tree; (2) each small shape (under
    FOLD_AREA of the picture) folded into whatever rings it, when one neighbour is FOLD_RING of its edge: a bigger
    shape, or nothing (ground the cut left unshaped). Smallest first, so a pebble on a rock on gravel goes all the way.
    -> (map, sky id or 0, shapes folded)."""
    from scipy import ndimage
    m = m.astype(np.int32).copy()
    sky_id = 0
    if pan is not None and pan_names:
        sky_ids = [int(k) for k, v in pan_names.items() if v == "sky"]
        if sky_ids:
            sky = np.isin(pan, sky_ids)
            if sky.any():
                ids, cnt = np.unique(m[m > 0], return_counts=True)
                in_sky = np.bincount(m[sky & (m > 0)], minlength=int(m.max()) + 1)
                sky_id = int(m.max()) + 1
                hit = [int(i) for i, c in zip(ids, cnt) if in_sky[i] >= SKY_SHARE * c]
                if hit:
                    m[np.isin(m, hit)] = sky_id
                m[sky & (m == 0)] = sky_id
    folded = 0
    cap = FOLD_AREA * m.size
    boxes = ndimage.find_objects(m)
    sizes = np.bincount(m.ravel())
    for i in np.argsort(sizes):
        if i == 0 or i == sky_id or sizes[i] == 0 or sizes[i] >= cap or boxes[i - 1] is None:
            continue
        sl = tuple(slice(max(0, a.start - 3), a.stop + 3) for a in boxes[i - 1])
        sub = m[sl]
        on = sub == i
        if not on.any():
            continue
        ring = ndimage.binary_dilation(on, iterations=2) & ~on
        if not ring.any():
            continue
        near = np.bincount(sub[ring])
        top = int(near.argmax())
        if near[top] >= FOLD_RING * ring.sum() and (top == 0 or sizes[top] > sizes[i]):
            sub[on] = top
            if top:
                sizes[top] += sizes[i]
            sizes[i] = 0
            folded += 1
    return m.astype(np.uint16), sky_id, folded


def tidy_all(obj, pan, pan_names):
    """Every picture's shapes tidied (tidy_shapes). -> (maps, [sky id per picture], shapes before, after)."""
    out, skies, before, after = [], [], 0, 0
    for i, m in enumerate(obj):
        before += len(np.unique(m)) - 1
        t, sky, _ = tidy_shapes(m, pan[i] if pan is not None else None, pan_names[i] if pan_names else None)
        if sky:
            t = t.copy()
            t[t == sky] = 0                       # sky is no thing: nothing is lifted from it, nothing named in it
        out.append(t)
        skies.append(sky)
        after += len(np.unique(t)) - 1
    return out, skies, before, after


def join_named(piece, xyz, classes):
    """THE OWNER'S STONE WALL (2026-11-18): seen close, each block is a shape of its own; seen from afar, the wall is
    one. "Do post processing on shapes... that are touching". Things whose votes give them the SAME NAME and whose
    points come within JOIN_VOX of each other are one thing. -> piece (renumbered), classes (summed), joins made."""
    name = {pc: top_of(c, 0.5)[0] for pc, c in classes.items()}
    named = np.array([pc for pc, nm in name.items() if nm], np.int64)
    idx = np.flatnonzero(np.isin(piece, named) & (np.abs(xyz[:, 0]) < 1e5))
    if not len(idx):
        return piece, classes, 0
    v = np.floor(xyz[idx] / JOIN_VOX).astype(np.int64)
    v -= v.min(0)
    S = v.max(0) + 3
    code = ((v[:, 0] + 1) * S[1] + v[:, 1] + 1) * S[2] + v[:, 2] + 1
    u, first = np.unique(np.stack([code, piece[idx]], 1), axis=0, return_index=True)   # each (cube, thing) once
    cubes = {}
    for c, pc in u:
        cubes.setdefault(int(c), []).append(int(pc))
    parent = {int(pc): int(pc) for pc in named}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    offs = [(dx * S[1] + dy) * S[2] + dz for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]
    joins = 0
    for c, pcs in cubes.items():
        for o in offs:
            for b in cubes.get(c + int(o), ()):
                for a in pcs:
                    if a != b and name[a] == name[b]:
                        ra, rb = find(a), find(b)
                        if ra != rb:
                            parent[rb] = ra
                            joins += 1
    if not joins:
        return piece, classes, 0
    out = piece.copy()
    lut = {pc: find(pc) for pc in parent}
    sel = np.isin(piece, named)
    out[sel] = np.array([lut[int(x)] for x in piece[sel]], np.int64)
    merged = {}
    for pc, c in classes.items():
        d = merged.setdefault(lut.get(pc, pc), {})
        for k, n in c.items():
            d[k] = d.get(k, 0) + n
    return out, merged, joins


def run_lift(tag, xyz, h, labs, keys, maps, names, patches, cams, out_dir):
    t0 = time.time()
    vis, ms = lift(xyz, keys, maps)
    off, comp, joined = merge(vis, ms, cams)
    piece, purity, vp, vn = vote(len(xyz), vis, ms, off, comp)
    classes = None
    if names:
        node_class = {}
        for p, nm in enumerate(names):
            for i, c in nm.items():
                node_class[int(off[p] + i)] = c
        classes = {}
        win = piece[vp]
        ok = comp[vn] == win
        for pc, nd in zip(win[ok], vn[ok]):
            c = node_class.get(int(nd))
            if c:
                d = classes.setdefault(int(pc), {})
                d[c] = d.get(c, 0) + 1
    joins = 0
    if classes:
        piece, classes, joins = join_named(piece, xyz, classes)
    saw = np.zeros(len(xyz), bool)
    for v in vis:
        saw[v] = True
    extra = f" ({len(keys)} pictures; {100 * saw.mean():.0f}% of the points were in a picture; {100 * joined:.0f}% of the shapes were joined to another picture's; a point's pictures agree {100 * purity:.0f}%; {joins} touching things of one name joined; {time.time() - t0:.0f} s)"
    lines, desc = report(tag, piece, xyz, h, labs, patches, classes, extra)
    try:
        picture(os.path.join(out_dir, f"segments-{re.sub(r'[^a-z]+', '-', tag.lower()).strip('-')}.png"), xyz, h, piece, np.array(list(desc)))
    except Exception as e:  # a picture that cannot be drawn does not lose the numbers
        lines.append(f"  (no picture: {type(e).__name__})")
    return lines, {"tag": tag.split(" (")[0], "keys": keys, "maps": maps, "names": names, "off": off, "comp": comp}


# ---------------------------------------------------------------- for the owner's eyes

def _font(size=15):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def overlay(img, m, off_p, comp, names_p, k_p=None):
    """A picture with a model's shapes over it: each shape in the colour of the THING it was lifted into (so one
    thing keeps its colour from picture to picture), edges dark, the model's name on the bigger shapes."""
    from PIL import Image, ImageDraw
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    if m.shape != a.shape[:2]:
        m = np.asarray(Image.fromarray(m.astype(np.uint16)).resize((a.shape[1], a.shape[0]), Image.NEAREST))
    pal = np.random.default_rng(7).integers(40, 255, size=(4096, 3)).astype(np.float32)
    # a shape no point fell in was never lifted (its id may be past this picture's nodes): a colour of its own
    ids = m.astype(np.int64)
    lifted = ids < (k_p if k_p is not None else len(comp) - off_p)
    thing = np.where(lifted, comp[np.minimum(off_p + ids, len(comp) - 1)], 2000 + ids) % 4096
    on = m > 0
    out = a.copy()
    out[on] = 0.45 * a[on] + 0.55 * pal[thing[on]]
    out[~on] *= 0.45
    edge = np.zeros(m.shape, bool)
    edge[:, 1:] |= m[:, 1:] != m[:, :-1]
    edge[1:, :] |= m[1:, :] != m[:-1, :]
    out[edge] = 20
    im = Image.fromarray(out.astype(np.uint8))
    if names_p:
        dr, f = ImageDraw.Draw(im), _font(14)
        from scipy import ndimage
        for i, c in names_p.items():
            on = m == i
            if on.sum() >= 0.012 * m.size:
                # the name is written at the shape's own deepest point. (Until 2026-11-19 it was written at the
                # middle of the shape's pixels, which for ground wrapped round a machine is ON THE MACHINE: the
                # owner saw "a clearly visible and well segmented roller machine and skid steer both being called
                # mulch" -- the ground's name, on them.)
                ys, xs = np.nonzero(on)
                y0, x0 = ys.min(), xs.min()
                box = np.pad(on[y0:ys.max() + 1, x0:xs.max() + 1], 1)
                yy, xx = np.unravel_index(int(ndimage.distance_transform_edt(box).argmax()), box.shape)
                x, y = int(x0 + xx - 1), int(y0 + yy - 1)
                dr.text((x + 1, y + 1), c, fill=(0, 0, 0), font=f, anchor="mm")
                dr.text((x, y), c, fill=(255, 255, 255), font=f, anchor="mm")
    return im


def sheets(d, xyz0, patches, views):
    """Two sheets of pictures, kept beside the twin in the private bucket and shown on the twin page (admin only):
    segments-patches.jpg  one row per patch the phone saw and the lidar lacks: the picture that saw most of it, the
                          patch's points dotted on it, and the same picture as each model cut it
    segments-walk.jpg     eight pictures through the walk, plain and as each model cut them"""
    from PIL import Image, ImageDraw
    if not views:
        return []
    keys = views[0]["keys"]
    xyz1 = np.concatenate([xyz0.astype(np.float64), np.ones((len(xyz0), 1))], 1)
    f, HEAD = _font(16), 26
    cols = ["the camera"] + [v["tag"] for v in views]

    def row(p, dots=None, title=""):
        k = keys[p]
        img = Image.open(os.path.join(d, k["name"])).convert("RGB")
        W, H = img.size
        first = img.copy()
        if dots is not None and len(dots):
            px, py, z, ok = project(xyz1[dots], k, W, H)
            dr = ImageDraw.Draw(first)
            for x, y in zip(px[ok], py[ok]):
                dr.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(255, 0, 255))
        cells = [first]
        for v in views:
            cell = overlay(img, v["maps"][p], v["off"][p], v["comp"], v["names"][p] if v["names"] else None, int(v["off"][p + 1] - v["off"][p]))
            if dots is not None and len(dots):
                dr = ImageDraw.Draw(cell)
                for x, y in zip(px[ok][::3], py[ok][::3]):
                    dr.point((x, y), fill=(255, 0, 255))
            cells.append(cell)
        strip = Image.new("RGB", (W * len(cells), H + 2 * HEAD), (255, 255, 255))
        dr = ImageDraw.Draw(strip)
        dr.text((6, 4), title, fill=(0, 0, 0), font=f)
        for i, c in enumerate(cells):
            strip.paste(c, (i * W, 2 * HEAD))
            dr.text((i * W + 6, HEAD + 4), cols[i], fill=(90, 90, 90), font=f)
        return strip

    def stack(rows, path):
        if not rows:
            return None
        W = max(r.width for r in rows)
        out = Image.new("RGB", (W, sum(r.height for r in rows)), (255, 255, 255))
        y = 0
        for r in rows:
            out.paste(r, (0, y))
            y += r.height
        if W > 2400:
            out = out.resize((2400, round(out.height * 2400 / W)))
        out.save(path, quality=82)
        return os.path.basename(path)

    made = []
    rows = []
    for j, pt in enumerate(patches):
        idx = np.array([i for i in pt.get("idx", []) if i < len(xyz0)], np.int64)
        if not len(idx):
            continue
        best, best_n = None, 0
        for p, k in enumerate(keys):
            m = views[0]["maps"][p]
            px, py, z, ok = project(xyz1[idx], k, m.shape[1], m.shape[0])
            # the patch whole and not at the far edge of what the picture can speak for
            n = int(ok.sum()) - (0 if not ok.any() else int(0.02 * ok.sum() * np.median(z[ok])))
            if n > best_n:
                best, best_n = p, n
        if best is not None:
            rows.append(row(best, idx, f"patch {j + 1} ({pt['cells']} m2, phone: {pt['label']})"))
    made.append(stack(rows, os.path.join(d, "segments-patches.jpg")))
    pick = np.unique(np.linspace(0, len(keys) - 1, num=min(8, len(keys))).astype(int))
    made.append(stack([row(int(p), None, f"picture {int(p) + 1} of {len(keys)}") for p in pick], os.path.join(d, "segments-walk.jpg")))
    return [m for m in made if m]


# ---------------------------------------------------------------- the self test

def selftest():
    """A made-up yard: a floor, a fence and a post, eight cameras round it; the 'picture model' is the truth drawn
    into each picture with ids shuffled per picture. The lift must give the fence and the post back as two things."""
    rng = np.random.default_rng(1)
    floor = np.stack([rng.uniform(-4, 4, 6000), np.zeros(6000), rng.uniform(-4, 4, 6000)], 1)
    fence = np.stack([rng.uniform(-2, 2, 3000), rng.uniform(0.35, 1.5, 3000), np.full(3000, 1.0) + rng.normal(0, 0.02, 3000)], 1)
    post = np.stack([rng.normal(2.5, 0.08, 800), rng.uniform(0.35, 2.0, 800), rng.normal(-1.5, 0.08, 800)], 1)
    xyz = np.concatenate([floor, fence, post]).astype(np.float32)
    truth = np.concatenate([np.zeros(6000, int), np.ones(3000, int), np.full(800, 2)])
    h = xyz[:, 1].astype(np.float64)
    W, H, f = 240, 320, 1.2
    proj = [f * H / W, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0]
    keys, maps, cams = [], [], []
    for i in range(8):
        a = i * np.pi / 4
        eye = np.array([5.5 * np.sin(a), 1.4, 5.5 * np.cos(a)])
        zc = eye - np.array([0, 0.7, 0])
        zc /= np.linalg.norm(zc)
        xc = np.cross([0, 1, 0], zc)
        xc /= np.linalg.norm(xc)
        yc = np.cross(zc, xc)
        M = np.eye(4)
        M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = xc, yc, zc, eye
        k = {"view": np.linalg.inv(M).T.reshape(-1).tolist() if i % 2 else M.T.reshape(-1).tolist(), "proj": proj, "t": float(i), "c2w": M}
        xyz1 = np.concatenate([xyz.astype(np.float64), np.ones((len(xyz), 1))], 1)
        px, py, z, ok = project(xyz1, k, W, H)
        m = np.zeros((H, W), np.uint16)
        perm = rng.permutation(3) + 1
        order = np.argsort(-z)
        for j in order[ok[order]]:
            m[max(0, py[j] - 1):py[j] + 2, max(0, px[j] - 1):px[j] + 2] = perm[truth[j]]
        keys.append(k)
        maps.append(m)
        cams.append(eye)
    track = np.array([[float(i), *cams[i]] for i in range(8)])
    for want_inv in (False, True):
        ks = [{"view": (np.linalg.inv(k["c2w"]) if want_inv else k["c2w"]).T.reshape(-1).tolist(), "t": k["t"]} for k in keys]
        said = pose_keys(ks, track)
        assert said.startswith("session to camera" if want_inv else "camera to session"), said
        assert all(np.allclose(a["c2w"], b["c2w"], atol=1e-6) for a, b in zip(ks, keys)), "the pose was not put right"
    vis, ms = lift(xyz, keys, maps)
    off, comp, joined = merge(vis, ms, np.array(cams))
    piece, purity, _, _ = vote(len(xyz), vis, ms, off, comp)
    assert overlay(__import__("PIL.Image", fromlist=["x"]).new("RGB", (W, H)), maps[0], off[0], comp, {1: "fence"}).size == (W, H)
    fence_p, post_p = np.bincount(piece[truth == 1][piece[truth == 1] >= 0]).argmax(), np.bincount(piece[truth == 2][piece[truth == 2] >= 0]).argmax()
    assert fence_p != post_p, "the fence and the post are one thing"
    assert (piece[truth == 1] == fence_p).mean() > 0.85, f"the fence is in pieces: {(piece[truth == 1] == fence_p).mean():.2f}"
    assert (piece[truth == 2] == post_p).mean() > 0.7, f"the post is in pieces: {(piece[truth == 2] == post_p).mean():.2f}"
    assert (piece[truth == 0] == fence_p).mean() < 0.05, "the floor was taken into the fence"
    d = describe(xyz, h, np.flatnonzero(piece == fence_p))
    assert d["shape"] == "line" and 3.3 < d["length"] < 4.4, f"the fence is not a 4 m line: {d}"
    g = by_shape(xyz, h)
    assert len(np.unique(g[g >= 0])) == 2, "by shape alone: two standing things"
    lines, _ = report("self test", piece, xyz, h, np.zeros((len(xyz), 4), np.uint8), [{"cells": 3, "lengthM": 4, "line": True, "label": "terrain", "idx": np.flatnonzero(truth == 1)[:500].tolist()}])
    assert any("patch 1" in l and "line" in l for l in lines), lines
    # tidying one picture: pebbles on unshaped gravel go; a small knot inside a wall joins the wall; a cloud is sky
    tm = np.zeros((200, 200), np.uint16)
    tm[100:200, 0:120] = 1                 # a wall
    tm[130:140, 40:50] = 2                 # a block in it (100 px of 40,000: small)
    tm[60:66, 20:26] = 3                   # a pebble on unshaped ground
    tm[0:15, 0:60] = 4                     # a cloud
    tm[40:95, 130:190] = 5                 # a big thing by itself: stays
    tpan = np.zeros((200, 200), np.uint16)
    tpan[0:30, :] = 1
    tt, sky, folded = tidy_shapes(tm, tpan, {1: "sky"})
    assert tt[135, 45] == 1 and tt[62, 22] == 0 and tt[60, 160] == 5 and folded == 2, "the block joins the wall, the pebble goes, the big thing stays"
    assert sky and tt[5, 5] == sky and tt[5, 150] == sky, "the cloud and the bare sky are one sky"
    # the owner's stone wall: two halves of the fence and the post, each a thing; the halves share a name and touch
    halves = np.full(len(xyz), -1, np.int64)
    halves[(truth == 1) & (xyz[:, 0] < 0)] = 5
    halves[(truth == 1) & (xyz[:, 0] >= 0)] = 6
    halves[truth == 2] = 7
    jp, jc, joins = join_named(halves, xyz.astype(np.float64), {5: {"fence": 9, "wall": 1}, 6: {"fence": 4}, 7: {"fence": 3}})
    assert joins == 1 and len(np.unique(jp[truth == 1])) == 1 and jp[truth == 2][0] == 7, "touching halves of one name are one thing; the post, apart, is not"
    assert jc[int(jp[truth == 1][0])] == {"fence": 13, "wall": 1}, jc
    print(f"segment lift self test: ok (joined {joined:.2f}, pictures agree {purity:.2f})")


# ---------------------------------------------------------------- main

def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    d = next((a for a in args if not a.startswith("--")), "twin")
    masks = args[args.index("--masks") + 1] if "--masks" in args else None
    recs, labs, keys = read_twin(d)
    if len(recs) < 1000:
        print(f"Only {len(recs)} points: nothing to cut up.")
        return
    track = read_track(d)
    xyz, h = recs[:, 2:5].copy(), (recs[:, 3] - recs[:, 5]).astype(np.float64)
    # left out, as the disagreement report leaves them out: spikes, Google's far street geometry (not measured by
    # the camera), and points the phone was more than NEAR from when it saw them
    drop = ((labs[:, 3] & 3) > 0)
    jf = os.path.join(d, "judged.bin")
    if os.path.exists(jf) and os.path.getsize(jf) == len(recs):
        # the report's own verdicts (lib/disagree.js judge, the owner's rule of 2026-11-19): every measured point out
        # to 80 ft that its name makes likely; the odd and the nameless only with a second look
        v = np.fromfile(jf, dtype=np.uint8)
        drop |= (v == 255) | (v == 3)
        print(f"Points by the report's verdicts: {int((~drop).sum()):,} used out to 80 ft ({int((v == 3).sum()):,} seen once and odd or nameless: left out).")
    elif len(track) >= 2:
        drop |= np.linalg.norm(xyz - cam_at(track, recs[:, 0].astype(np.float64)), axis=1) > NEAR
    gone = erased(d, len(recs))
    if gone.any():
        print(f"Erased by hand in the 3D view: {int(gone.sum()):,} points, left out.")
        drop |= gone
    xyz[drop] = np.nan
    h[drop] = np.nan
    print(f"Pictures' poses: {pose_keys(keys, track)}.")
    patches = []
    pf = os.path.join(d, "disagree-cells.json")
    if os.path.exists(pf):
        with open(pf) as f:
            patches = json.load(f)
    stand = np.isfinite(h) & (h > STAND)
    print(f"The walk: {len(recs):,} points, {int((~drop).sum()):,} used ({int(stand.sum()):,} standing over {STAND * FT:.0f} ft), {len(keys)} pictures; {len(patches)} patches the phone saw and the lidar lacks.")
    labs_named = labs[stand, 0]
    cnt = np.bincount(labs_named, minlength=len(LABELS) + 1)
    print("The phone's own labels on the standing points: " + ", ".join(f"{LABELS[i - 1]} {100 * cnt[i] / max(1, cnt.sum()):.0f}%" for i in np.argsort(-cnt) if i > 0 and cnt[i] / max(1, cnt.sum()) >= 0.02) + (f", none {100 * cnt[0] / max(1, cnt.sum()):.0f}%" if cnt[0] else "") + ".")

    if patches:
        print("== The patches' own shapes (no cutting, no picture) ==")
        for j, pt in enumerate(patches):
            said = sheet(xyz, h, np.array([i for i in pt.get("idx", []) if i < len(xyz)], np.int64))
            print(f"  patch {j + 1} ({pt['cells']} m2, the phone said {pt['label']}): {said or 'too few points'}.")
    xyz0 = np.nan_to_num(xyz, nan=1e6)
    g = by_shape(xyz, h)
    lines, desc = report("By shape alone (touching, no picture)", g, xyz, h, labs, patches)
    print("\n".join(lines))
    try:
        picture(os.path.join(d, "segments-shape.png"), xyz, h, g, np.array(list(desc)))
    except Exception as e:
        print(f"  (no picture: {type(e).__name__})")

    cams = np.array([k["c2w"][:3, 3] for k in keys]) if keys else None
    views = []

    def go(tag, sel, maps, names, c):
        lines, view = run_lift(tag, xyz0, h, labs, sel, maps, names, patches, c, d)
        print("\n".join(lines))
        views.append(view)

    if masks:
        z = np.load(masks, allow_pickle=False)
        names_all = json.loads(str(z["names"])) if "names" in z else None
        sel = [keys[i] for i in z["pics"]]
        c = cams[z["pics"]]
        if "pan" in z:
            go("Panoptic (cuts and names)", sel, list(z["pan"]), [{int(a): b for a, b in nm.items()} for nm in names_all], c)
        if "obj" in z:
            pan_names = [{int(a): b for a, b in nm.items()} for nm in names_all] if names_all and "pan" in z else None
            obj, _, n0, n1 = tidy_all(list(z["obj"]), list(z["pan"]) if "pan" in z else None, pan_names)
            print(f"SAM objects tidied (small shapes folded into what rings them, sky made one and set aside): {n0:,} shapes in the pictures -> {n1:,}.")
            obj_names = name_by_vote(obj, list(z["pan"]), pan_names) if pan_names else None
            go("SAM objects" + (", named by the panoptic model's vote" if obj_names else " (largest shape)"), sel, obj, obj_names, c)
            go("SAM parts (smallest shape)", sel, list(z["part"]), None, c)
    elif "--panoptic" in args and keys:
        from PIL import Image
        pick = np.unique(np.linspace(0, len(keys) - 1, num=min(PIC_MAX, len(keys))).astype(int))
        sel = [keys[i] for i in pick]
        imgs = [Image.open(os.path.join(d, k["name"])).convert("RGB") for k in sel]
        maps, names = panoptic_maps(imgs)
        go("Panoptic (cuts and names)", sel, maps, names, cams[pick])
    try:
        # SAM parts is left off the sheets (the owner, 2026-11-18: "too fine, it marks individual bricks")
        made = sheets(d, xyz0, patches, [v for v in views if not v["tag"].startswith("SAM parts")])
        if made:
            print(f"Pictures for the twin page: {', '.join(made)} (private; see the walk's twin page).")
    except Exception as e:  # the pictures are for looking; the numbers above stand without them
        print(f"(no sheets of pictures: {type(e).__name__}: {str(e)[:120]})")


if __name__ == "__main__":
    main()
