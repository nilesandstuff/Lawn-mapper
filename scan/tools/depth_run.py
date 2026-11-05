"""
DEPTH FROM ONE PICTURE, AGAINST ARCORE'S (core session, 2026-11-05; the owner: "you can try the depth sensing runs
so we have the info for later"). Run by workflow "S. Yard AR tool", task `depth`, on a twin fetched WITH its
pictures, on GitHub's free runner (CPU; no paid compute).

The S21's depth (its depth hardware with ARCore; the owner: good on walls, poor on grass and in bright light), as
WebXR hands it over: on the work walk most of what it called standing was the ground misread or nothing (SCAN-H7). A depth model trained on pictures (Depth Anything V2, small,
public) guesses depth from ONE picture: good at shapes and edges, with no scale of its own. So for each picture the
twin kept, the model's guess is scaled to ARCore's depth points from the same moment (1/depth = a * guess + b, fitted
robustly), and then the two are compared where both have something:

  - how far apart they are once scaled, by range, for ground points and for standing points;
  - of ARCore's standing points, how many the model puts more than 0.5 m farther away (ARCore floated them nearer:
    the phantoms of SCAN-H7) and how many it agrees with.

Kept beside the twin for later: depth-summary.json (the numbers) and depth-maps.npz (each picture's scaled depth at a
quarter of its size, float16). NUMBERS ONLY in the log.

    python scan/tools/depth_run.py twin
"""
import glob
import json
import os
import sys
import time

import numpy as np
from PIL import Image

MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
SAME_MOMENT_S = 0.3   # an ARCore point this close in time to a picture is from the same view
MIN_POINTS = 30       # a picture with fewer ARCore points in it is not fitted
BANDS = [(0, 2), (2, 3), (3, 4), (4, 6), (6, 8)]
GROUND_TOL, STAND_LOW, STAND_HIGH = 0.2, 0.4, 2.4  # as scan/lib/locate.js BANDS


def read_cloud(d):
    parts = sorted(glob.glob(os.path.join(d, "cloud-*.bin")))
    arr = np.concatenate([np.fromfile(p, dtype="<f4") for p in parts]) if parts else np.zeros(0, "<f4")
    return arr[: len(arr) // 6 * 6].reshape(-1, 6)  # t, odo, x, y, z, ground


def read_keys(d):
    keys = []
    for p in sorted(glob.glob(os.path.join(d, "keys-*.json"))):
        keys.extend(json.load(open(p)))
    return [k for k in keys if os.path.exists(os.path.join(d, k["name"]))]


def inv_rigid(M):
    M = np.asarray(M, dtype=np.float64).reshape(4, 4).T  # column-major -> row-major
    R, t = M[:3, :3], M[:3, 3]
    out = np.eye(4)
    out[:3, :3] = R.T
    out[:3, 3] = -R.T @ t
    return out


def robust_fit(g, z):
    """1/z = a*g + b, trimming the worst fifth twice."""
    y = 1.0 / z
    keep = np.ones(len(g), bool)
    a = b = None
    for _ in range(3):
        A = np.stack([g[keep], np.ones(keep.sum())], 1)
        sol, *_ = np.linalg.lstsq(A, y[keep], rcond=None)
        a, b = sol
        r = np.abs(a * g + b - y)
        cut = np.quantile(r, 0.8)
        keep = r <= cut
        if keep.sum() < MIN_POINTS // 2:
            break
    return a, b


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    t0 = time.time()
    cloud, keys = read_cloud(d), read_keys(d)
    print(f"Twin: {len(cloud):,} ARCore points, {len(keys)} pictures.")
    if not keys or not len(cloud):
        print("Nothing to compare.")
        return
    import torch
    from transformers import pipeline
    torch.set_num_threads(os.cpu_count() or 2)
    pipe = pipeline("depth-estimation", model=MODEL, device="cpu")
    order = np.argsort(cloud[:, 0])
    cloud = cloud[order]
    ts = cloud[:, 0]
    rows = []  # per point: band, class, arcore z, model z
    maps, fits, done = {}, [], 0
    for k in keys:
        lo, hi = np.searchsorted(ts, k["t"] - SAME_MOMENT_S), np.searchsorted(ts, k["t"] + SAME_MOMENT_S)
        pts = cloud[lo:hi]
        if len(pts) < MIN_POINTS:
            continue
        img = Image.open(os.path.join(d, k["name"])).convert("RGB")
        W, H = img.size
        V, P = inv_rigid(k["view"]), np.asarray(k["proj"], dtype=np.float64).reshape(4, 4).T
        hom = np.concatenate([pts[:, 2:5], np.ones((len(pts), 1))], 1)
        cam = (V @ hom.T).T
        front = cam[:, 2] < -0.3
        clip = (P @ cam.T).T
        nx, ny = clip[:, 0] / clip[:, 3], clip[:, 1] / clip[:, 3]
        inside = front & (np.abs(nx) < 0.98) & (np.abs(ny) < 0.98)
        if inside.sum() < MIN_POINTS:
            continue
        out = pipe(img)
        g = out["predicted_depth"].squeeze().cpu().numpy().astype(np.float64)  # relative inverse depth, model size
        gh, gw = g.shape
        px = np.clip(((nx[inside] + 1) / 2 * gw).astype(int), 0, gw - 1)
        py = np.clip(((1 - ny[inside]) / 2 * gh).astype(int), 0, gh - 1)
        gv, z = g[py, px], -cam[inside, 2]
        a, b = robust_fit(gv, z)
        zm = 1.0 / np.maximum(a * gv + b, 1e-3)
        h = pts[inside, 3] - pts[inside, 5]
        cls = np.where(np.abs(h) < GROUND_TOL, 0, np.where((h > STAND_LOW) & (h < STAND_HIGH), 1, 2))
        for zi, zmi, ci in zip(z, zm, cls):
            rows.append((zi, zmi, ci))
        # the scaled map at a quarter size, kept for later
        q = np.asarray(Image.fromarray(g.astype(np.float32)).resize((max(1, W // 4), max(1, H // 4)), Image.BILINEAR))
        maps[k["name"]] = (1.0 / np.maximum(a * q + b, 1e-3)).astype(np.float16)
        fits.append({"name": k["name"], "t": k["t"], "a": float(a), "b": float(b), "points": int(inside.sum())})
        done += 1
        if done % 50 == 0:
            print(f"  {done} pictures ({int(time.time() - t0)} s)")
    if not rows:
        print("No picture had enough ARCore points in it.")
        return
    R = np.array(rows)
    z, zm, cls = R[:, 0], R[:, 1], R[:, 2].astype(int)
    diff = zm - z
    summ = {"model": MODEL, "pictures": done, "points": int(len(R)), "bands": []}
    print(f"Fitted {done} pictures, {len(R):,} ARCore points in them. Model minus ARCore, once scaled (median |m|; share > 0.5 m):")
    for lo_, hi_ in BANDS:
        line = {"band": [lo_, hi_]}
        parts = []
        for name, c in (("ground", 0), ("standing", 1)):
            sel = (z >= lo_) & (z < hi_) & (cls == c)
            if sel.sum() < 20:
                continue
            med, far = float(np.median(np.abs(diff[sel]))), float(np.mean(np.abs(diff[sel]) > 0.5))
            line[name] = {"n": int(sel.sum()), "medianM": round(med, 3), "over05": round(far, 3)}
            parts.append(f"{name} {int(sel.sum()):,}: {med:.2f} m, {far * 100:.0f}%")
        summ["bands"].append(line)
        print(f"  {lo_}-{hi_} m: " + ("; ".join(parts) if parts else "too few"))
    st = cls == 1
    if st.sum():
        farther, agree = float(np.mean(diff[st] > 0.5)), float(np.mean(np.abs(diff[st]) <= 0.25))
        summ["standing"] = {"n": int(st.sum()), "modelFartherBy05": round(farther, 3), "agreeWithin025": round(agree, 3)}
        print(f"ARCore's standing points ({int(st.sum()):,}): the model puts {farther * 100:.0f}% more than 0.5 m farther (floated nearer by ARCore?), agrees within 25 cm on {agree * 100:.0f}%.")
    json.dump({**summ, "fits": fits}, open(os.path.join(d, "depth-summary.json"), "w"))
    np.savez_compressed(os.path.join(d, "depth-maps.npz"), **{n.replace(".jpg", ""): m for n, m in maps.items()})
    mb = os.path.getsize(os.path.join(d, "depth-maps.npz")) / 1e6
    print(f"Kept: depth-summary.json, depth-maps.npz ({mb:.1f} MB). Done in {int(time.time() - t0)} s.")


if __name__ == "__main__":
    main()
