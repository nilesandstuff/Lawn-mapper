"""
STRETCHING A MAP'S PHOTOS ONTO THE LIDAR (core session, 2026-11-09; docs/SCAN-PLAN.md section 17). The owner: aerial
photos are locally skewed and only the lidar is true to the ground; "Yes let's do it."

From scan/tools/warp-prep.mjs's folder: the lidar at its measured place, the photo the map was traced on (the
county's, as Lawn Mapper keeps it) and Mapbox's for the same frame, and every walk's marks on this map.

For each photo, on a common grid of the map's local metres (CELL m a pixel):
  - the lidar drawn as the brightness of its GROUND returns (pavement against grass), with a mask of everything 0.5 m
    or more above the ground grown by 1 m: roofs and crowns lean in a photo, so no match is taken there;
  - matches between the lidar picture and the photo, two ways:
      windows: the site's own kind of matcher, edges by direction (gradient magnitude, which does not care that
               pavement is dark in the lidar and light in the photo), phase correlation in overlapping windows;
      RoMa:    a pretrained dense matcher (MIT code, DINOv2 Apache-2 backbone; arXiv 2305.15404), on the CPU;
  - the photo's displacement onto the lidar (lidar place less photo place, metres) at each match, then:
      none (as today without the shade map's shift), one shift (what the shade map does), an affine, and a
      smoothed thin-plate spline (the smoothing chosen by five-fold cross-validation);
    each scored on HELD-OUT matches (five folds), and across methods (fitted on one matcher's matches, scored on the
    other's), the honest test.
Then the owner's own test: check points placed on Mapbox (the walks before 2026-11-09 evening) and on the county
photo (that walk): how far apart the two placements of each point are as placed, and after each photo is stretched.

Writes warp.json (the fitted fields on a 1 m grid, per photo) and warped-<photo>.png beside the inputs. Prints
distances and counts only.

    python scan/tools/warp_study.py warp
"""
import json
import math
import os
import sys
import time

import cv2
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import binary_dilation, gaussian_filter

SHIFT = [0.0, 0.0]                   # the model's one shift onto the photo, in the map's metres (photos.json)
FT = 3.28084
CELL = 0.25          # m a pixel on the common grid
R = 6378137.0


def merc(lng, lat):
    return math.radians(lng) * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R


class Frame:
    """A photo's pixels against the map's local metres (scan/lib/photo.js toPx / fromPx)."""

    def __init__(self, fr, w, h, origin):
        self.cx, self.cy = merc(fr["lng"], fr["lat"])
        self.ox, self.oy = merc(*origin)
        self.k = math.cos(math.radians(origin[1]))
        self.mpp = (2 * math.pi * R / (256 * 2 ** fr["zoom"])) * fr["size"] / w   # mercator metres a pixel
        self.w, self.h = w, h

    def to_local(self, x, y):
        mx = self.cx + (np.asarray(x) - self.w / 2) * self.mpp
        my = self.cy - (np.asarray(y) - self.h / 2) * self.mpp
        return (mx - self.ox) * self.k, (my - self.oy) * self.k

    def to_px(self, e, n):
        mx = np.asarray(e) / self.k + self.ox
        my = np.asarray(n) / self.k + self.oy
        return (mx - self.cx) / self.mpp + self.w / 2, (self.cy - my) / self.mpp + self.h / 2


def lidar_rasters(L, x0, y1, W, H):
    """The ground returns' brightness on the grid (NaN where none near) and the mask of raised things."""
    gnd = (L[:, 4] == 2) | (np.abs(L[:, 5]) < 0.25)
    up = L[:, 5] > 0.5
    def cells(P):
        c = np.floor((P[:, 0] - x0) / CELL).astype(int)
        r = np.floor((y1 - P[:, 1]) / CELL).astype(int)
        ok = (c >= 0) & (r >= 0) & (c < W) & (r < H)
        return r[ok], c[ok], P[ok]
    r, c, P = cells(L[gnd])
    s = np.zeros((H, W)); n = np.zeros((H, W))
    np.add.at(s, (r, c), P[:, 3]); np.add.at(n, (r, c), 1.0)
    sig = 0.45 / CELL
    S, N = gaussian_filter(s, sig), gaussian_filter(n, sig)
    # gaps between returns filled from farther out, never left as holes: a hole blanked in both pictures is a pattern
    # they share at zero shift, and pulled every window's answer toward none (the synthetic lot: a quarter of the shift)
    S2, N2 = gaussian_filter(s, 3 * sig), gaussian_filter(n, 3 * sig)
    img = np.where(N > 0.05, S / np.maximum(N, 1e-9), np.where(N2 > 1e-4, S2 / np.maximum(N2, 1e-9), np.nan))
    lo, hi = np.nanpercentile(img, 2), np.nanpercentile(img, 98)
    img = np.clip((img - lo) / max(1e-6, hi - lo), 0, 1)
    r2, c2, _ = cells(L[up])
    raised = np.zeros((H, W), bool); raised[r2, c2] = True
    raised = binary_dilation(raised, iterations=int(round(1.0 / CELL)))
    return img, raised


def photo_on_grid(path, fr, x0, y1, W, H):
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    lpp = fr.mpp * fr.k                      # local metres a photo pixel
    if lpp < CELL:                           # shrinking: blur first, as remap does not average
        im = cv2.GaussianBlur(im, (0, 0), 0.5 * CELL / lpp)
    xs = x0 + (np.arange(W) + 0.5) * CELL
    ys = y1 - (np.arange(H) + 0.5) * CELL
    E, N = np.meshgrid(xs, ys)
    px, py = fr.to_px(E, N)
    out = cv2.remap(im, px.astype(np.float32), py.astype(np.float32), cv2.INTER_LINEAR)
    inside = (px >= 0) & (py >= 0) & (px < fr.w) & (py < fr.h)
    return out, inside


def edges(gray, sig=1.2):
    g = gaussian_filter(gray.astype(np.float64), sig)
    gx, gy = np.gradient(g)
    m = np.hypot(gx, gy)
    return m / (np.percentile(m, 99) + 1e-9)


def match_windows(lid, raised, photo, inside, win=24.0, step=8.0, reach=3.0):
    """Tie points [e, n, de, dn] (photo place, lidar less photo) from phase correlation of edge maps in windows."""
    gray = cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY)
    A = edges(np.nan_to_num(lid, nan=float(np.nanmedian(lid)))); B = edges(gray)
    bad = raised | ~inside | np.isnan(lid)
    # faded out, not cut: a sharp blank shared by both is itself a match at zero shift
    wgt = gaussian_filter((~bad).astype(np.float64), 4.0)
    A = A * wgt; B = B * wgt
    H, W = A.shape
    wpx, spx = int(win / CELL), int(step / CELL)
    han = cv2.createHanningWindow((wpx, wpx), cv2.CV_64F)
    out = []
    for r0 in range(0, H - wpx + 1, spx):
        for c0 in range(0, W - wpx + 1, spx):
            a = A[r0:r0 + wpx, c0:c0 + wpx]; b = B[r0:r0 + wpx, c0:c0 + wpx]
            if (bad[r0:r0 + wpx, c0:c0 + wpx]).mean() > 0.5 or a.std() < 0.02 or b.std() < 0.02:
                continue
            # each window's own mean taken off first: a positive-mean edge map under the Hann window peaks at zero
            # shift whatever the truth (a synthetic lot read 0.1 m where it was moved 0.6)
            (dx, dy), resp = cv2.phaseCorrelate(np.ascontiguousarray(b - b.mean()), np.ascontiguousarray(a - a.mean()), han)   # how far b must move to sit on a
            if resp < 0.08 or math.hypot(dx, dy) * CELL > reach:
                continue
            out.append([c0 + wpx / 2, r0 + wpx / 2, dx * CELL, -dy * CELL, resp])
    return np.array(out) if out else np.zeros((0, 5))


def match_roma(lid, raised, photo, inside, n=4000):
    import torch
    from PIL import Image
    from romatch import roma_outdoor
    torch.set_num_threads(os.cpu_count() or 2)
    H, W = lid.shape
    A = Image.fromarray((np.nan_to_num(lid, nan=0.5) * 255).astype(np.uint8)).convert("RGB")
    B = Image.fromarray(cv2.cvtColor(photo, cv2.COLOR_BGR2RGB))
    # no custom CUDA kernel on a CPU runner (run 226: "No module named 'local_corr'"), and full precision on a CPU
    model = roma_outdoor(device="cpu", coarse_res=448, upsample_res=672, use_custom_corr=False, amp_dtype=torch.float32)
    warp, cert = model.match(A, B, device="cpu")
    m, c = model.sample(warp, cert, num=n)
    ka, kb = model.to_pixel_coordinates(m, H, W, H, W)
    ka, kb, c = ka.numpy(), kb.numpy(), c.numpy()
    ra, ca = np.clip(ka[:, 1].astype(int), 0, H - 1), np.clip(ka[:, 0].astype(int), 0, W - 1)
    rb, cb = np.clip(kb[:, 1].astype(int), 0, H - 1), np.clip(kb[:, 0].astype(int), 0, W - 1)
    keep = (c > 0.3) & ~raised[ra, ca] & ~raised[rb, cb] & inside[rb, cb] & ~np.isnan(lid[ra, ca])
    ka, kb, c = ka[keep], kb[keep], c[keep]
    if len(ka) < 10:
        return np.zeros((0, 5))
    # a loose global affine first, only to throw out the wild ones (the local warp is fitted afterwards)
    M, inl = cv2.estimateAffine2D(kb.astype(np.float32), ka.astype(np.float32), ransacReprojThreshold=1.5 / CELL)
    if inl is None:
        return np.zeros((0, 5))
    inl = inl.ravel().astype(bool)
    ka, kb, c = ka[inl], kb[inl], c[inl]
    d = (ka - kb) * CELL
    return np.stack([kb[:, 0], kb[:, 1], d[:, 0], -d[:, 1], c], 1)


# ------------------------------------------------------------------ warps
def fit(model, P, D, lam=None):
    """A displacement field fitted to points P (n,2 metres) with displacements D (n,2): a function of positions."""
    if model == "none":
        return lambda Q: np.zeros((len(Q), 2))
    if model == "shift":
        m = np.median(D, 0)
        return lambda Q: np.tile(m, (len(Q), 1))
    if model == "affine":
        X = np.c_[P, np.ones(len(P))]
        Wt, *_ = np.linalg.lstsq(X, D, rcond=None)
        return lambda Q: np.c_[Q, np.ones(len(Q))] @ Wt
    if model == "spline":
        X = np.c_[P, np.ones(len(P))]
        Wt, *_ = np.linalg.lstsq(X, D, rcond=None)
        base = lambda Q: np.c_[Q, np.ones(len(Q))] @ Wt
        rbf = RBFInterpolator(P, D - base(P), kernel="thin_plate_spline", smoothing=lam, degree=1)
        return lambda Q: base(Q) + rbf(Q)
    raise ValueError(model)


def folds(n, k=5, seed=0):
    idx = np.random.default_rng(seed).permutation(n)
    return [idx[i::k] for i in range(k)]


def held_out(model, P, D, lam=None):
    errs = []
    for f in folds(len(P)):
        tr = np.setdiff1d(np.arange(len(P)), f)
        if len(tr) < 8:
            return np.array([np.nan])
        g = fit(model, P[tr], D[tr], lam)
        errs.append(np.linalg.norm(g(P[f]) - D[f], axis=1))
    return np.concatenate(errs)


def best_lambda(P, D):
    best = None
    for lam in [0.3, 1, 3, 10, 30, 100, 300, 1000]:
        e = held_out("spline", P, D, lam)
        s = float(np.sqrt(np.mean(e ** 2)))
        if best is None or s < best[1]:
            best = (lam, s)
    return best[0]


def summary(e):
    e = e[np.isfinite(e)]
    if not len(e):
        return "-"
    return f"{np.sqrt(np.mean(e ** 2)) * FT:.1f} ft RMS, 95% {np.percentile(e, 95) * FT:.1f} ft"


def main(d):
    t0 = time.time()
    info = json.load(open(os.path.join(d, "photos.json")))
    origin, photos = info["origin"], info["photos"]
    global SHIFT
    SHIFT = info.get("shift") or [0.0, 0.0]
    L = np.fromfile(os.path.join(d, "lidar.bin"), dtype="<f4").reshape(-1, 6).astype(np.float64)
    marks = json.load(open(os.path.join(d, "marks.json")))["walks"]
    print(f"Photos onto the lidar: {len(L):,} lidar returns; photos {', '.join(photos)}; {len(marks)} walks on the map.")
    out = {"cell": 1.0, "photos": {}, "shift": SHIFT}
    fields = {}
    for src, p in photos.items():
        fr = Frame(p["frame"], p["w"], p["h"], origin)
        e0, n0 = fr.to_local(0, p["h"]); e1, n1 = fr.to_local(p["w"], 0)
        x0, y1 = float(e0), float(n1)
        W, H = int((float(e1) - x0) / CELL), int((y1 - float(n0)) / CELL)
        lid, raised = lidar_rasters(L, x0, y1, W, H)
        photo, inside = photo_on_grid(os.path.join(d, p["file"]), fr, x0, y1, W, H)
        ties = {}
        ties["windows"] = match_windows(lid, raised, photo, inside)
        try:
            ties["RoMa"] = match_roma(lid, raised, photo, inside)
        except Exception as e:   # noqa: BLE001
            print(f"  {src}: RoMa could not run ({str(e)[:120]})")
        print(f"  {src} ({W}x{H} cells of {CELL} m, {inside.mean():.0%} covered, {raised.mean():.0%} raised): "
              + ", ".join(f"{k} {len(v)} matches" for k, v in ties.items()))
        to_m = lambda T: np.c_[x0 + (T[:, 0] + 0.5) * CELL, y1 - (T[:, 1] + 0.5) * CELL]
        best_field = None
        for name, T in ties.items():
            if len(T) < 12:
                print(f"    {name}: too few matches to fit")
                continue
            P, D = to_m(T), T[:, 2:4]
            lam = best_lambda(P, D)
            ho = {m: held_out(m, P, D, lam) for m in ("none", "shift", "affine", "spline")}
            print(f"    {name}: the median shift {np.hypot(*np.median(D, 0)) * FT:.1f} ft; held out (five folds) -- "
                  + "; ".join(f"{m} {summary(e)}" for m, e in ho.items())
                  + f" (spline smoothing {lam})")
            rms = {m: float(np.sqrt(np.nanmean(e ** 2))) for m, e in ho.items()}
            method = min(("shift", "affine", "spline"), key=lambda m: rms[m])
            # a stretch is kept only when it predicts matches it never saw clearly better than leaving the photo alone
            # (run 226: the edge windows' 30 matches disagreed by 6 ft, and their spline was worse than none)
            if not rms[method] < 0.8 * rms["none"]:
                print(f"    {name}: no stretch beats none on held-out matches; nothing kept from it")
                continue
            g = fit(method, P, D, lam)
            for other, T2 in ties.items():
                if other == name or len(T2) < 5:
                    continue
                P2, D2 = to_m(T2), T2[:, 2:4]
                cross = {m: np.linalg.norm(fit(m, P, D, lam)(P2) - D2, axis=1) for m in ("none", "shift", "affine", "spline")}
                print(f"      fitted on {name}, scored on {other}'s matches: " + "; ".join(f"{m} {summary(e)}" for m, e in cross.items()))
            if best_field is None or rms[method] < best_field[2]:
                best_field = (f"{name}'s {method}", g, rms[method])
        if best_field:
            fields[src] = best_field[1]
            # the field on a 1 m grid over the photo, for the placement map (the photo stretched onto the lidar)
            gx = np.arange(x0, x0 + W * CELL, 1.0); gy = np.arange(y1, y1 - H * CELL, -1.0)
            GX, GY = np.meshgrid(gx, gy)
            F = best_field[1](np.c_[GX.ravel(), GY.ravel()]).reshape(GY.shape + (2,))
            out["photos"][src] = {"from": best_field[0], "x0": x0, "y1": y1, "w": len(gx), "h": len(gy), "de": np.round(F[..., 0], 3).tolist(), "dn": np.round(F[..., 1], 3).tolist()}
            # the photo stretched: each pixel of the output where the lidar is, taken from where the photo had it
            im = cv2.imread(os.path.join(d, p["file"]), cv2.IMREAD_COLOR)
            YY, XX = np.mgrid[0:p["h"], 0:p["w"]].astype(np.float64)
            E, N = fr.to_local(XX, YY)
            # each output pixel is a place in the MODEL's frame (the page draws the lidar with the model's one shift onto
            # the photo applied); the measured place is that less the shift, and the photo had it the field away from there
            E, N = E - SHIFT[0], N - SHIFT[1]
            disp = best_field[1](np.c_[E.ravel(), N.ravel()]).reshape(E.shape + (2,))
            sx, sy = fr.to_px(E - disp[..., 0], N - disp[..., 1])
            warped = cv2.remap(im, sx.astype(np.float32), sy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            cv2.imwrite(os.path.join(d, f"warped-{src}.png"), warped)
            mags = np.hypot(F[..., 0], F[..., 1]) * FT
            print(f"    kept: {best_field[0]} (held out {best_field[2] * FT:.1f} ft RMS); the stretch over the photo {np.percentile(mags, 5):.1f}-{np.percentile(mags, 95):.1f} ft (5th-95th percentile)")
    json.dump(out, open(os.path.join(d, "warp.json"), "w"))

    # THE OWNER'S TEST: the same check points placed on Mapbox and on the county photo
    if len(marks) >= 2:
        marks = sorted(marks, key=lambda w: w.get("started") or "")
        county, earlier = marks[-1], marks[:-1]
        cm = {m["id"]: np.array(m["map"], float) for m in county["marks"]}
        pairs = []
        for w in reversed(earlier):          # the walk just before first: a point may have been dragged since
            for m in w["marks"]:
                if m["id"] in cm:
                    pairs.append((m["id"], np.array(m["map"], float), cm[m["id"]]))
        seen = {}
        for pid, a, b in pairs:
            seen.setdefault(pid, (a, b))
        if seen:
            raw, fixed = [], []
            for pid, (a, b) in seen.items():
                raw.append(np.linalg.norm(a - b))
                if "mapbox" in fields and "county" in fields:
                    a2 = a + fields["mapbox"](a[None])[0]; b2 = b + fields["county"](b[None])[0]
                    fixed.append(np.linalg.norm(a2 - b2))
            far = sum(x > 9 for x in raw)       # 30 ft and more: dragged to another spot, not the same corner
            line = (f"({far} of them more than 30 ft apart: moved to another spot between walks, not a photo's error) " if far else "") + f"The same {len(seen)} points placed on Mapbox (earlier walks) and on the county photo (the newest walk): apart {', '.join(f'{x * FT:.1f}' for x in raw)} ft"
            if fixed:
                line += f"; after both photos are stretched onto the lidar: {', '.join(f'{x * FT:.1f}' for x in fixed)} ft"
            print(line + ".")
        else:
            print("No point was placed both on Mapbox and on the county photo under the same name.")
    print(f"({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "warp")
