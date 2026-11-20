"""
THE PHOTOS' OWN DEPTH, JOINED INTO ONE CLOUD (core session, 2026-11-20).

The owner, 2026-11-19: "if a section is segmented and named, and has depth points, we should be able to connect the
dots to map it." And on the owner's-lot walk of 2026-11-19 the walk's own kept points were 17,000 from eleven
minutes, nearly all grass: the house and the trees were not among them. But every photo keeps a depth grid of its
own (72 x 128 cells, key-NNNN.depth; from 2026-11-20 also the phone's smoothed depth, key-NNNN.sdepth), and every
pixel has a class from the picture model. So: every depth cell of every photo is put into space with its photo's
colour and its pixel's kind, and cells falling in the same 3 in cube are one point, taking the kind most of them
voted and counting the photos that saw it.

    python scan/tools/dense_prep.py twin

Writes view-dense.bin beside the twin (private) for scan/public/cloud.html?dense=1: a point is Float32 x, y, z, t and
Uint8 r, g, b, kind (studies.VOTE_KINDS), photos that saw it (to 255), source (1: only the smoothed depth saw it),
0, 0. Sky is left out: a cell the picture model calls sky is not a thing (docs/SCAN-PLAN.md 34, 37). Counts only.
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402
import studies as T        # noqa: E402

VOX = 0.08        # m: cells in one cube are one point
FAR = 20.0        # m: a depth cell past this is not used (the phone's depth is from its own motion)
FAR_SMOOTH = 12.0
CAP = 330000      # points the page is sent (8 MB a part)


def cells(k, dg, w, h):
    """A photo's depth cells in space: -> world (n, 3), pixel x, y, distance."""
    gy, gx = np.nonzero(dg > 0)
    u, v = (gx + 0.5) * w / dg.shape[1], (gy + 0.5) * h / dg.shape[0]
    ndc = np.stack([u / w * 2 - 1, 1 - v / h * 2, -np.ones(len(u)), np.ones(len(u))], 1)
    cam = ndc @ np.linalg.inv(np.array(k["proj"], dtype=np.float64).reshape(4, 4).T).T
    ray = cam[:, :3] / cam[:, 3:4]
    ray /= np.linalg.norm(ray, axis=1, keepdims=True)
    d = dg[gy, gx]
    return (ray * d[:, None]) @ k["c2w"][:3, :3].T + k["c2w"][:3, 3], np.clip(u.astype(int), 0, w - 1), np.clip(v.astype(int), 0, h - 1), d


def main():
    from PIL import Image
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    w = T.load(d)
    keys = w["keys"]
    kind_maps = {}
    mf = os.path.join(d, "segments-masks.npz")
    if os.path.exists(mf):
        z = np.load(mf, allow_pickle=False)
        if "pan" in z and "names" in z:
            for i, m, nm in zip(z["pics"], z["pan"], json.loads(str(z["names"]))):
                lut = np.zeros(int(m.max()) + 1, np.uint8)
                for j, name in nm.items():
                    kk = T.KIND.get(name)
                    if kk in T.VOTE_KINDS and int(j) < len(lut):
                        lut[int(j)] = T.VOTE_KINDS.index(kk)
                kind_maps[int(i)] = lut[m]
    # what the walk kept beside its photos (a walk whose joined cloud is thin should say why)
    have = {ext: [os.path.join(d, k["name"].replace(".jpg", ext)) for k in keys if os.path.exists(os.path.join(d, k["name"].replace(".jpg", ext)))] for ext in (".depth", ".sdepth", ".rdepth")}
    fill = {}
    for ext in (".depth", ".sdepth"):
        g = [T.read_depth(f) for f in have[ext][:: max(1, len(have[ext]) // 60)]]
        g = [x for x in g if x is not None]
        fill[ext] = 100 * float(np.mean([(x > 0).mean() for x in g])) if g else 0.0
        if g:
            allv = np.concatenate([x[x > 0] for x in g]) if any((x > 0).any() for x in g) else np.zeros(1)
            print(f"  {ext[1:]}: {len(g)} sampled; distances low / middle / high {np.percentile(allv, 10) * S.FT:.0f} / {np.median(allv) * S.FT:.0f} / {np.percentile(allv, 90) * S.FT:.0f} ft; within {FAR_SMOOTH * S.FT:.0f} ft {100 * (allv <= FAR_SMOOTH).mean():.0f}%.")
    posed = sum("c2w" in k for k in keys)
    print(f"Beside its {len(keys)} photos ({posed} with a pose) the walk kept: the measured depth for {len(have['.depth'])} (a distance under {fill['.depth']:.0f}% of a photo's cells), "
          f"the smoothed depth for {len(have['.sdepth'])} ({fill['.sdepth']:.0f}%), the uncut raw depth for {len(have['.rdepth'])}; classes for {len(kind_maps)}.")
    SKY = T.VOTE_KINDS.index("sky")
    P, C, K, PH, TT, SM = [], [], [], [], [], []
    n_raw = n_smooth = photos = 0
    used = {0: 0, 1: 0}
    why = {"no file or unreadable": 0, "nothing within reach": 0, "all sky": 0}
    for i, k in enumerate(keys):
        if "c2w" not in k:
            continue
        base = os.path.join(d, k["name"])
        img = None
        for ext, far, smooth in ((".depth", FAR, 0), (".sdepth", FAR_SMOOTH, 1)):
            f = base.replace(".jpg", ext)
            dg = T.read_depth(f) if os.path.exists(f) else None
            if dg is None:
                why["no file or unreadable"] += smooth
                continue
            if smooth:
                raw = T.read_depth(base.replace(".jpg", ".depth")) if os.path.exists(base.replace(".jpg", ".depth")) else None
                if raw is not None and raw.shape == dg.shape:
                    dg = np.where(raw > 0, 0, dg)          # the smoothed depth only where the camera measured none
            dg = np.where(dg <= far, dg, 0)
            if not (dg > 0).any():
                why["nothing within reach"] += smooth
                continue
            if img is None:
                img = np.asarray(Image.open(base).convert("RGB"))
                photos += 1
            H, W = img.shape[:2]
            xyz, px, py, _ = cells(k, dg, W, H)
            km = kind_maps.get(i)
            kd = km[np.clip(py * km.shape[0] // H, 0, km.shape[0] - 1), np.clip(px * km.shape[1] // W, 0, km.shape[1] - 1)] if km is not None else np.zeros(len(px), np.uint8)
            ok = kd != SKY
            used[smooth] += 1
            why["all sky"] += smooth * int(not ok.any())
            P.append(xyz[ok]); C.append(img[py[ok], px[ok]]); K.append(kd[ok]); PH.append(np.full(int(ok.sum()), i, np.int32))
            TT.append(np.full(int(ok.sum()), k["t"], np.float32)); SM.append(np.full(int(ok.sum()), smooth, np.uint8))
            n_raw += 0 if smooth else int(ok.sum())
            n_smooth += int(ok.sum()) if smooth else 0
    print(f"  Photos used: {used[0]} by their measured depth, {used[1]} by their smoothed depth; smoothed depth not used: " + ", ".join(f"{k} {v}" for k, v in why.items()) + ".")
    if not P:
        print("The photos kept no depth of their own: no joined cloud.")
        return
    P, C, K, PH, TT, SM = np.concatenate(P), np.concatenate(C).astype(np.float64), np.concatenate(K), np.concatenate(PH), np.concatenate(TT), np.concatenate(SM)
    q = np.floor(P / VOX).astype(np.int64)
    q -= q.min(0)
    key = (q[:, 0] * (q[:, 1].max() + 1) + q[:, 1]) * (q[:, 2].max() + 1) + q[:, 2]
    uq, inv = np.unique(key, return_inverse=True)
    n = len(uq)
    cnt = np.bincount(inv, minlength=n).astype(np.float64)
    pos = np.stack([np.bincount(inv, P[:, j], n) / cnt for j in range(3)], 1)
    col = np.stack([np.bincount(inv, C[:, j], n) / cnt for j in range(3)], 1)
    nk = len(T.VOTE_KINDS)
    kv = np.bincount(inv * nk + K, minlength=n * nk).reshape(n, nk)
    kv[:, 0] = 0
    kind = np.where(kv.sum(1) > 0, kv.argmax(1), 0).astype(np.uint8)
    looks = np.bincount(np.unique(inv.astype(np.int64) * (PH.max() + 1) + PH) // (PH.max() + 1), minlength=n)
    smooth_only = np.bincount(inv, 1 - SM, n) == 0
    t0 = np.full(n, np.inf)
    np.minimum.at(t0, inv, TT)
    keep = np.arange(n)
    if n > CAP:
        keep = np.sort(np.argsort(-(looks * 1000 + cnt))[:CAP])
    rec = np.zeros(len(keep), dtype=[("p", "<f4", 3), ("t", "<f4"), ("c", "u1", 3), ("kind", "u1"), ("looks", "u1"), ("src", "u1"), ("pad", "u1", 2)])
    rec["p"], rec["t"], rec["c"], rec["kind"] = pos[keep], t0[keep], np.clip(col[keep], 0, 255), kind[keep]
    rec["looks"], rec["src"] = np.minimum(looks[keep], 255), smooth_only[keep]
    rec.tofile(os.path.join(d, "view-dense.bin"))
    by = np.bincount(kind[keep], minlength=nk)
    print(f"The photos' own depth, joined: {photos} photos gave {n_raw:,} measured cells and {n_smooth:,} from the smoothed depth (within {FAR * S.FT:.0f} / {FAR_SMOOTH * S.FT:.0f} ft, sky left out); "
          f"{n:,} points of {VOX * 39.37:.0f} in, {len(keep):,} kept for the page; seen by two photos or more {100 * (looks[keep] >= 2).mean():.0f}%, by five or more {100 * (looks[keep] >= 5).mean():.0f}%; only the smoothed depth saw {100 * smooth_only[keep].mean():.0f}%.")
    print("  By kind: " + ", ".join(f"{T.VOTE_KINDS[j]} {int(by[j]):,}" for j in np.argsort(-by) if j and by[j]) + f"; no kind {int(by[0]):,}.")
    print(f"  Against it, the walk's own kept points: {int((~w['drop']).sum()):,}.")


if __name__ == "__main__":
    main()
