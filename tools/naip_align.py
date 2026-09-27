"""
Line NAIP up with the Mapbox photograph, for the training pipeline.

The same arithmetic as public/lib/align.js, which the editor runs when a map
is looked at in NAIP (owner, 2026-09-27: NAIP is sometimes shifted or a
little off in scale against Mapbox, and Mapbox is the one to trust). A map
whose alignment was set in the editor carries it; every other frame is
aligned here, automatically, before its near-infrared reaches the detector.

Edges rather than colours: NAIP and Mapbox disagree about colour (season,
sensor, NAIP's bands here are NIR/red/green) but a roof edge, a kerb or a
fence is in the same place in both. NAIP is slid and scaled until its edge
strength best correlates with the photograph's, and the answer is used only
when it clearly beats leaving NAIP alone.

Both tests (tools/naip_align_test.py and tools/align.test.js) check the same
synthetic cases so the two sides cannot drift apart.
"""

import numpy as np

SCALES = (0.985, 0.99, 0.995, 1.0, 1.005, 1.01, 1.015)


def edges(grey):
    """Central-difference gradient magnitude, zero on the border."""
    g = np.asarray(grey, dtype=np.float32)
    out = np.zeros_like(g)
    gx = g[1:-1, 2:] - g[1:-1, :-2]
    gy = g[2:, 1:-1] - g[:-2, 1:-1]
    out[1:-1, 1:-1] = np.sqrt(gx * gx + gy * gy)
    return out


def blur3(a):
    """3x3 box blur with the edge handled by averaging what is there."""
    a = np.asarray(a, dtype=np.float32)
    p = np.pad(a, 1, mode="constant")
    n = np.pad(np.ones_like(a), 1, mode="constant")
    s = sum(p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
            for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    c = sum(n[1 + dy:n.shape[0] - 1 + dy, 1 + dx:n.shape[1] - 1 + dx]
            for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    return s / c


def _score(ref, mov, dx, dy, s, margin):
    h, w = ref.shape
    cy, cx = (h - 1) / 2, (w - 1) / 2
    ys = np.arange(margin, h - margin)
    xs = np.arange(margin, w - margin)
    qy = np.round(cy + (ys - dy - cy) / s).astype(int)
    qx = np.round(cx + (xs - dx - cx) / s).astype(int)
    oky = (qy >= 0) & (qy < h)
    okx = (qx >= 0) & (qx < w)
    if oky.sum() * okx.sum() < 16:
        return -1.0
    a = ref[np.ix_(ys[oky], xs[okx])].ravel()
    b = mov[np.ix_(qy[oky], qx[okx])].ravel()
    a = a - a.mean()
    b = b - b.mean()
    va = float((a * a).sum())
    vb = float((b * b).sum())
    return float((a * b).sum()) / np.sqrt(va * vb) if va > 0 and vb > 0 else -1.0


def _sub_step(m, c0, p):
    d = m - 2 * c0 + p
    if d >= 0:
        return 0.0
    return float(max(-0.5, min(0.5, 0.5 * (m - p) / d)))


def align_images(ref_grey, mov_grey, max_shift=8, scales=SCALES, min_gain=0.02, scale_gain=0.01):
    """(dx, dy, scale, ncc, ncc0, moved): move `mov` by (dx, dy) px (+x right,
    +y down) and scale it about the centre to lie on `ref`. Same rules as
    alignImages in public/lib/align.js."""
    ref = blur3(edges(ref_grey))
    mov = blur3(edges(mov_grey))
    margin = max_shift + 2
    ncc0 = _score(ref, mov, 0, 0, 1.0, margin)

    def search(s):
        best = None
        for dy in range(-max_shift, max_shift + 1):
            for dx in range(-max_shift, max_shift + 1):
                v = _score(ref, mov, dx, dy, s, margin)
                if best is None or v > best[3] + 1e-9:
                    best = (dx, dy, s, v)
        return best

    best = search(1.0)
    for s in scales:
        if s == 1.0:
            continue
        b = search(s)
        if b[3] > best[3] + scale_gain:
            best = b
    dx, dy, s, v = best
    fx = _sub_step(_score(ref, mov, dx - 1, dy, s, margin), v, _score(ref, mov, dx + 1, dy, s, margin))
    fy = _sub_step(_score(ref, mov, dx, dy - 1, s, margin), v, _score(ref, mov, dx, dy + 1, s, margin))
    moved = v - ncc0 >= min_gain and (dx or dy or s != 1.0)
    if not moved:
        return {"dx": 0.0, "dy": 0.0, "scale": 1.0, "ncc": ncc0, "ncc0": ncc0, "moved": False}
    return {"dx": dx + fx, "dy": dy + fy, "scale": s, "ncc": v, "ncc0": ncc0, "moved": True}


def resample(arr, dx, dy, scale, offset=(0, 0), out_shape=None):
    """`arr` (H, W, C) moved by (dx, dy) px and scaled about the centre of the
    OUTPUT grid, read bilinearly. `offset` is where the output grid's (0, 0)
    sits in `arr` (a fetch with a margin around the frame)."""
    arr = np.asarray(arr, dtype=np.float32)
    h, w = out_shape or arr.shape[:2]
    cy, cx = (h - 1) / 2, (w - 1) / 2
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    qy = cy + (ys - dy - cy) / scale + offset[0]
    qx = cx + (xs - dx - cx) / scale + offset[1]
    qy = np.clip(qy, 0, arr.shape[0] - 1)
    qx = np.clip(qx, 0, arr.shape[1] - 1)
    y0 = np.floor(qy).astype(int)
    x0 = np.floor(qx).astype(int)
    y1 = np.minimum(y0 + 1, arr.shape[0] - 1)
    x1 = np.minimum(x0 + 1, arr.shape[1] - 1)
    fy = (qy - y0)[..., None]
    fx = (qx - x0)[..., None]
    a = arr[y0, x0] * (1 - fx) + arr[y0, x1] * fx
    b = arr[y1, x0] * (1 - fx) + arr[y1, x1] * fx
    return a * (1 - fy) + b * fy
