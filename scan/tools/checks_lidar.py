"""
DO THE CHECK MARKS SIT ON THE LIDAR? (core session, 2026-11-08). The owner places each check mark on the aerial photo,
on something it shows (a driveway corner, the corner in front of the hot tub, a dead shrub's stem, the well head),
"so in a visual sense they align nearly perfectly, within inches. BUT I'm wondering if the aerial imagery is
connecting correctly with the reality... Are we sure that (1,000, 1,000) and (2,000, 2,000) actually point to where
the lidar signatures for those visually recognizable shapes would be."

Every placement error the studies report is measured against those marks. The lidar was put on a photo by the shade
map with one shift for the whole frame, to about half a metre (docs/DETECTOR-FINDINGS.md H103/H108), and a photo is
not a true orthophoto: it can be stretched or leaned a little differently in each corner. So this measures, round
each mark, how far the photo's ground sits from the lidar's.

How: a 20 m square round each mark, on a 10 cm grid. The photo's edges against the lidar's (its ground returns'
brightness: pavement dark, grass bright; and the height of low things, a hot tub, a step, a kerb), compared by edge
DIRECTION only (a line matches a line whichever side is darker, as public/lib/register.js does), on open ground only:
anything 1.5 m or taller and 2.5 m round it is left out, since a roof or a crown leans in the photo by its height.
The shift that lines them up best, within 2.5 m, is where the photo puts that ground against the lidar. A mark's
spot in the lidar's world is the mark moved by that shift.

Writes checks-lidar.json (the shift per mark, in metres east and north). Prints distances only.

  python scan/tools/checks_lidar.py twin
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

MODE = os.environ.get("CHECK_MODE", "both")
RES = 0.1            # m a cell
HALF = 10.0          # m: half the square round a mark
REACH = 2.5          # m: the farthest shift searched
TALL = 1.5           # m: taller than this leans in the photo
LEAN = 2.5           # m round anything tall, left out
FT = 3.281


def load(d):
    inp = json.load(open(os.path.join(d, "sky-input.json")))
    ph = json.load(open(os.path.join(d, "checks-photo.json")))
    pts = np.fromfile(os.path.join(d, "sky-points.bin"), dtype="<f4").reshape(-1, 6)
    g = inp["grid"]
    gr = np.fromfile(os.path.join(d, "sky-ground.bin"), dtype="<f4").reshape(g["h"], g["w"])
    img = np.asarray(Image.open(os.path.join(d, "checks-photo.png")).convert("L"), np.float32)
    return inp, ph, pts, g, gr, img


def ground_at(g, gr, e, n):
    c = np.floor((e - g["x0"]) / g["cell"]).astype(int)
    r = np.floor((g["y1"] - n) / g["cellY"]).astype(int)
    ok = (c >= 0) & (r >= 0) & (c < g["w"]) & (r < g["h"])
    out = np.full(e.shape, np.nan, np.float32)
    out[ok] = gr[r[ok], c[ok]]
    return out


def lidar_rasters(pts, hag, e0, n1, nx, ny):
    """Over a grid from (e0, n1) (west, north edge), nx x ny cells of RES: the ground returns' brightness (a smooth
    average, NaN where none near) and the tallest return over the ground per cell (0 where none)."""
    c = np.floor((pts[:, 0] - e0) / RES).astype(int)
    r = np.floor((n1 - pts[:, 1]) / RES).astype(int)
    ok = (c >= 0) & (r >= 0) & (c < nx) & (r < ny) & np.isfinite(hag)
    c, r, h, it, cls = c[ok], r[ok], hag[ok], pts[ok, 3], pts[ok, 4]
    height = np.zeros((ny, nx), np.float32)
    np.maximum.at(height, (r, c), np.clip(h, 0, 30))
    g = (cls == 2) | (h < 0.25)
    s = np.zeros((ny, nx), np.float64)
    wt = np.zeros((ny, nx), np.float64)
    np.add.at(s, (r[g], c[g]), it[g])
    np.add.at(wt, (r[g], c[g]), 1.0)
    sig = 0.3 / RES
    S, W = ndimage.gaussian_filter(s, sig), ndimage.gaussian_filter(wt, sig)
    # seen: ground returns at 0.3 a square metre or more round the cell (this lot's lidar has about 1.6)
    bright = np.where(W * (1 / RES ** 2) >= 0.3, S / np.maximum(W, 1e-9), np.nan)
    # heights: the tallest nearby, spread over the sparse returns
    height = ndimage.grey_dilation(height, size=(5, 5))
    return bright, height


def photo_window(img, A, e0, n1, nx, ny):
    e = e0 + (np.arange(nx) + 0.5) * RES
    n = n1 - (np.arange(ny) + 0.5) * RES
    E, N = np.meshgrid(e, n)
    px = A[0] * E + A[1] * N + A[2]
    py = A[3] * E + A[4] * N + A[5]
    return ndimage.map_coordinates(img, [py.ravel(), px.ravel()], order=1, mode="nearest").reshape(ny, nx)


def orient(a, sigma):
    """Doubled-angle edge field: |g| e^(2i theta), so a line matches a line whichever side is darker."""
    a = np.nan_to_num(a, nan=np.nanmedian(a) if np.isfinite(a).any() else 0.0)
    a = ndimage.gaussian_filter(a.astype(np.float64), sigma)
    gx, gy = ndimage.sobel(a, 1), ndimage.sobel(a, 0)
    z = (gx + 1j * gy) ** 2 / (np.hypot(gx, gy) + 1e-9)
    return z


def corr(zp, zl, mask):
    """C(s) = sum_x conj(zp(x)) zl(x + s) over the photo's open cells, by FFT, as a share of the perfect."""
    ny, nx = zp.shape
    a = zp * mask
    b = zl
    P = (ny * 2, nx * 2)
    C = np.fft.fftshift(np.fft.ifft2(np.conj(np.fft.fft2(a, P)) * np.fft.fft2(b, P)).real)
    return C / (math.sqrt(float((np.abs(a) ** 2).sum() * (np.abs(b * mask) ** 2).sum())) + 1e-9)


def best_shift(pairs, mask):
    """The shift (cells) at the peak of the pairs' summed correlations, sub-cell, its score, and the best elsewhere
    (1 m or more away)."""
    C = sum(corr(zp, zl, mask) for zp, zl in pairs) / len(pairs)
    ny, nx = pairs[0][0].shape
    cy, cx = ny, nx
    rr = int(round(REACH / RES))
    win = C[cy - rr: cy + rr + 1, cx - rr: cx + rr + 1]
    iy, ix = np.unravel_index(int(np.argmax(win)), win.shape)
    peak = float(win[iy, ix])
    norm = 1.0

    def sub(v_m, v0, v_p):
        d = v_m - 2 * v0 + v_p
        return 0.0 if d >= 0 else 0.5 * (v_m - v_p) / d
    fy = sub(win[iy - 1, ix], peak, win[iy + 1, ix]) if 0 < iy < win.shape[0] - 1 else 0.0
    fx = sub(win[iy, ix - 1], peak, win[iy, ix + 1]) if 0 < ix < win.shape[1] - 1 else 0.0
    yy, xx = np.mgrid[0:win.shape[0], 0:win.shape[1]]
    far = np.hypot(yy - iy, xx - ix) * RES >= 1.0
    second = float(win[far].max()) if far.any() else 0.0
    sx, sy = (ix - rr + fx), (iy - rr + fy)
    # the lidar's ground for a photo spot x is at x + s: east +sx cells, north -sy cells (rows run south)
    return {"east": sx * RES, "north": -sy * RES, "score": peak / norm, "second": second / norm,
            "edge": bool(abs(ix - rr) >= rr - 1 or abs(iy - rr) >= rr - 1)}


def measure(inp, ph, pts, hag, img, ce, cn, half):
    e0, n1 = ce - half, cn + half
    nx = ny = int(round(2 * half / RES))
    bright, height = lidar_rasters(pts, hag, e0, n1, nx, ny)
    photo = photo_window(img, ph["affine"], e0, n1, nx, ny)
    tall = height >= TALL
    blocked = ndimage.binary_dilation(tall, iterations=int(round(LEAN / RES))) if tall.any() else tall
    seen = np.isfinite(bright)
    open_ = (~blocked) & ndimage.binary_erosion(seen, iterations=3)
    zp = orient(photo, 0.15 / RES)
    zl_b = orient(bright, 0.1 / RES)
    zl_h = orient(np.minimum(height, TALL), 0.1 / RES)
    # the lidar's two kinds of edge, each scaled to the same strength over the open ground
    def scaled(z):
        e = math.sqrt(float((np.abs(z[open_]) ** 2).mean())) if open_.any() else 0.0
        return z / e if e > 0 else z * 0
    zl = scaled(zl_b) + 0.7 * scaled(zl_h)
    # and the brightness itself, band-passed (pavement is dark in the photo and in the lidar's returns alike)
    def band(a, lo, hi):
        a = np.nan_to_num(a, nan=np.nanmedian(a) if np.isfinite(a).any() else 0.0).astype(np.float64)
        return ndimage.gaussian_filter(a, lo / RES) - ndimage.gaussian_filter(a, hi / RES)
    bp, bl = band(photo, 0.3, 2.0), band(bright, 0.3, 2.0)
    pairs = [(zp, zl)] if MODE == "edges" else [(bp.astype(np.complex128), bl.astype(np.complex128))] if MODE == "bright" else \
        [(zp, zl), (bp.astype(np.complex128), bl.astype(np.complex128))]
    share = float(open_.mean())
    if share < 0.15:
        return {"share": share, "why": f"only {share:.0%} of the square is open ground the lidar saw"}
    r = best_shift(pairs, open_.astype(np.float64))
    r["share"] = share
    sure = r["score"] >= 0.12 and r["score"] >= 1.15 * r["second"] and not r["edge"]
    r["sure"] = bool(sure)
    if not sure:
        r["why"] = ("the best shift is at the edge of the search" if r["edge"] else
                    f"another shift fits nearly as well ({r['second']:.2f} against {r['score']:.2f})" if r["score"] < 1.15 * r["second"] else
                    f"the edges agree weakly (score {r['score']:.2f})")
    return r


def main(d):
    inp, ph, pts, g, gr, img = load(d)
    hag = pts[:, 2] - ground_at(g, gr, pts[:, 0], pts[:, 1])
    checks = inp.get("checks") or []
    if not checks:
        raise SystemExit("Check marks against the lidar: the walk has no check marks.")
    out = {"marks": [], "whole": None}
    print(f"Check marks against the lidar: {len(checks)} marks; {len(pts):,} lidar returns; a {2 * HALF:.0f} m square round each, "
          f"edges compared on open ground (nothing {TALL} m tall within {LEAN} m), shifts up to {REACH * FT:.0f} ft.")
    es = [c["map"][0] for c in checks]
    ns = [c["map"][1] for c in checks]
    whole_half = max(HALF, 0.5 * max(max(es) - min(es), max(ns) - min(ns)) + 8)
    w = measure(inp, ph, pts, hag, img, 0.5 * (max(es) + min(es)), 0.5 * (max(ns) + min(ns)), whole_half)
    out["whole"] = w
    def line(r):
        if "east" not in r:
            return f"not measured ({r['why']})"
        mag = math.hypot(r["east"], r["north"]) * FT
        dirn = ("NESW"[int(((math.degrees(math.atan2(r["east"], r["north"])) + 360 + 45) % 360) // 90)]) if mag >= 0.05 else ""
        s = f"{mag:.1f} ft {dirn}".strip() + f" (east {r['east'] * FT:+.1f}, north {r['north'] * FT:+.1f} ft; score {r['score']:.2f}, next best {r['second']:.2f}; {r['share']:.0%} open)"
        return s + ("" if r.get("sure") else f"; NOT SURE: {r['why']}")
    print(f"  the whole lot ({2 * whole_half:.0f} m square): the lidar's ground sits {line(w)} from the photo's")
    for c in checks:
        r = measure(inp, ph, pts, hag, img, c["map"][0], c["map"][1], HALF)
        r["id"] = c["id"]
        out["marks"].append(r)
        print(f"  check {c['id']}: {line(r)}")
    sure = [r for r in out["marks"] if r.get("sure")]
    if sure:
        mags = sorted(math.hypot(r["east"], r["north"]) * FT for r in sure)
        print(f"  measured at {len(sure)} of {len(checks)} marks: median {mags[len(mags) // 2]:.1f} ft, largest {mags[-1]:.1f} ft. "
              f"Each mark's spot in the lidar's world is the mark moved by its shift; under about 0.3 ft is below what this can tell.")
    json.dump(out, open(os.path.join(d, "checks-lidar.json"), "w"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "twin")
