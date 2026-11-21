"""
EVERY POINT OF A WALK, MADE READY FOR THE 3D VIEW (core session, 2026-11-19).

The owner: "build a full 3D render of every single point, not filtered, and I could view it in a 3d viewer and an
inspect button that allows me to see the picture associated with that spot, then I can erase the bad ones point by
point. Then you'll get the absolute best possible idea of what's real and what's not so we can settle it once and for
all."

The page (scan/public/cloud.html) reads the twin's own parts. This adds what a phone should not have to work out:
each point's COLOUR, from the picture taken nearest in time to when the point was seen (the point was in that view),
so the cloud looks like the place and not like dots.

    python scan/tools/view_prep.py twin

Writes beside the twin (private):
    view-rgb.bin   one quad a record, in the order the page reads them: r, g, b, 1 if the colour came from a picture
    view.json      { records, cloud, weak, coloured, pose: which way the pictures' poses were kept, pictures }
THE ORDER OF RECORDS, here and on the page and in erased.bin: cloud-NNNN.bin parts by name, then weak-NNNN.bin parts
by name. Counts only in the log.
"""

import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402

NEAR_S = 3.0     # s: a picture this near in time to a point's sighting may colour it


def records(d):
    """Every record of the twin, the cloud's then the weak ones: (N, 6) [t, odo, x, y, z, ground], count of cloud's."""
    out = []
    for pat in (r"cloud-\d+\.bin", r"weak-\d+\.bin"):
        for n in sorted(x for x in os.listdir(d) if re.fullmatch(pat, x)):
            a = np.fromfile(os.path.join(d, n), dtype="<f4")
            out.append((pat.startswith("cloud"), a[: len(a) // 6 * 6].reshape(-1, 6)))
    cloud = sum(len(a) for c, a in out if c)
    return (np.concatenate([a for _, a in out]) if out else np.zeros((0, 6), np.float32)), cloud


def main():
    from PIL import Image
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    recs, n_cloud = records(d)
    _, _, keys = S.read_twin(d)
    track = S.read_track(d)
    which = S.pose_keys(keys, track)
    rgb = np.zeros((len(recs), 4), np.uint8)
    rgb[:, :3] = 128
    if keys and len(recs):
        kt = np.array([k["t"] for k in keys])
        near = np.clip(np.searchsorted(kt, recs[:, 0]), 1, len(kt) - 1) if len(kt) > 1 else np.zeros(len(recs), int)
        if len(kt) > 1:
            near = np.where(np.abs(kt[near - 1] - recs[:, 0]) < np.abs(kt[near] - recs[:, 0]), near - 1, near)
        xyz1 = np.concatenate([recs[:, 2:5].astype(np.float64), np.ones((len(recs), 1))], 1)
        was = S.RANGE
        S.RANGE = 1e9                      # any distance: the point was in this view when it was seen
        try:
            for step in (0, -1, 1):        # the nearest picture, then the one before, the one after, for those left
                for q in range(len(keys)):
                    idx = np.flatnonzero((near + step == q) & (rgb[:, 3] == 0) & (np.abs(kt[q] - recs[:, 0]) <= NEAR_S))
                    if not len(idx):
                        continue
                    img = np.asarray(Image.open(os.path.join(d, keys[q]["name"])).convert("RGB"))
                    px, py, z, ok = S.project(xyz1[idx], keys[q], img.shape[1], img.shape[0])
                    rgb[idx[ok], :3] = img[py[ok], px[ok]]
                    rgb[idx[ok], 3] = 1
        finally:
            S.RANGE = was
    # EACH POINT'S KIND (studies.voted, docs/SCAN-PLAN.md 36), for the view's "kind" colours: the owner, 2026-11-20:
    # "the 3d view is much better than the views from above". One byte a record, an index into studies.VOTE_KINDS,
    # 0 none (not kept, or nothing spoke for it). The weak records take the phone's own label.
    kinds = np.zeros(len(recs), np.uint8)
    try:
        import studies as T
        w = T.load(d)
        kind = T.voted(d, w)[0]
        kinds[: len(kind)] = kind[:n_cloud]
        if len(recs) > n_cloud:
            wl = []
            for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"weaklabels-\d+\.bin", x)):
                wl.append(np.fromfile(os.path.join(d, n), dtype=np.uint8).reshape(-1, 4))
            wl = np.concatenate(wl) if wl else np.zeros((0, 4), np.uint8)
            if len(wl) == len(recs) - n_cloud:
                lut = np.array([T.VOTE_KINDS.index(T.PHONE_KIND[x]) if x in T.PHONE_KIND else 0 for x in range(256)], np.uint8)
                kinds[n_cloud:] = np.where(wl[:, 1] >= 128, lut[wl[:, 0]], 0)
                TR, PL = T.VOTE_KINDS.index("tree"), T.VOTE_KINDS.index("plant")
                veg = np.isin(kinds, (TR, PL))
                kinds[veg] = np.where(T.tree_or_plant(recs[:, 2:5].astype(np.float64), veg)[veg], TR, PL)
        kinds.tofile(os.path.join(d, "view-kind.bin"))
        print("Kinds for the view: " + ", ".join(f"{T.VOTE_KINDS[k]} {int((kinds == k).sum()):,}" for k in np.argsort(-np.bincount(kinds, minlength=len(T.VOTE_KINDS))) if k and (kinds == k).any()) + f"; none {int((kinds == 0).sum()):,}.")
    except Exception as e:
        print(f"Kinds for the view: not made ({type(e).__name__}: {str(e)[:100]}).")
    # WHERE THE RECORDS LIE (2026-11-21; the owner: "the points are mostly all stacked vertically in a bubble in what
    # seems to be the front yard... dozens of meters tall"): the cloud's and the weak ones apart, by how sure the depth
    # was, how far from the camera and how far above it.
    try:
        la = []
        for pat, lp in ((r"cloud-\d+\.bin", "labels-"), (r"weak-\d+\.bin", "weaklabels-")):
            for n in sorted(x for x in os.listdir(d) if re.fullmatch(pat, x)):
                cnt = os.path.getsize(os.path.join(d, n)) // 24
                f = os.path.join(d, lp + n.split("-")[1])
                raw = np.fromfile(f, dtype=np.uint8) if os.path.exists(f) else np.zeros(0, np.uint8)
                la.append(raw.reshape(-1, 4) if len(raw) == 4 * cnt else np.zeros((cnt, 4), np.uint8))
        la = np.concatenate(la) if la else np.zeros((0, 4), np.uint8)
        if len(track) >= 2 and len(la) == len(recs):
            cam = S.cam_at(track, recs[:, 0].astype(np.float64))
            rng, up = np.linalg.norm(recs[:, 2:5] - cam, axis=1), recs[:, 3] - cam[:, 1]
            spanxz = np.hypot(recs[:, 2] - np.median(track[:, 1]), recs[:, 4] - np.median(track[:, 3]))
            for name, m in (("the cloud's", np.arange(len(recs)) < n_cloud), ("the weak ones", np.arange(len(recs)) >= n_cloud)):
                for sub, mm in (("all", m), ("depth confidence under 0.05", m & (la[:, 2] < 13)), ("0.05 to 0.2", m & (la[:, 2] >= 13) & (la[:, 2] < 51)), ("0.2 and up", m & (la[:, 2] >= 51))):
                    if mm.sum() < 50:
                        continue
                    q = lambda a, f: np.percentile(a[mm], f) * S.FT  # noqa: E731
                    print(f"  WHERE {name} records lie, {sub} ({int(mm.sum()):,}): from the camera {q(rng, 10):.0f} / {q(rng, 50):.0f} / {q(rng, 90):.0f} ft (low / middle / high); "
                          f"above the camera {q(up, 10):.0f} / {q(up, 50):.0f} / {q(up, 90):.0f} / {q(up, 99):.0f} ft (.. / highest 1%); over 15 ft above it {100 * (up[mm] > 4.57).mean():.0f}%; "
                          f"called sky {100 * (la[mm, 0] == 2).mean():.0f}%, tree {100 * (la[mm, 0] == 4).mean():.0f}%; flags: Google's {100 * ((la[mm, 3] & 2) > 0).mean():.0f}%.")
            # is one stretch of the walk to blame? the records over 15 ft above the camera, by the minute they were seen
            hi = up > 4.57
            if hi.sum() > 100:
                mins = (recs[:, 0] // 60).astype(int)
                c = np.bincount(mins[hi], minlength=mins.max() + 1)
                print("  Records over 15 ft above the camera, by the minute of the walk: " + ", ".join(f"{i}: {int(v):,}" for i, v in enumerate(c)) + f" (of {int(hi.sum()):,}).")
            # HOW WIDE EACH LIES (2026-11-21: in the 3D view the owner sees the path wide and the points in one small
            # slice of it): widths only, east-west and north-south and in height, the middle 90%.
            def wide(a):
                return " x ".join(f"{(np.percentile(a[:, j], 95) - np.percentile(a[:, j], 5)) * S.FT:.0f}" for j in (0, 2, 1)) + " ft (two ways flat, then height)"
            is_cloud = np.arange(len(recs)) < n_cloud
            sure = ~is_cloud & (la[:, 2] >= 13)
            print(f"  HOW WIDE: the track {wide(track[:, 1:4])}; the cloud's records {wide(recs[is_cloud, 2:5])}; the weak ones with confidence 0.05 and up ({int(sure.sum()):,}) {wide(recs[sure, 2:5]) if sure.sum() > 20 else '-'}; all the weak ones {wide(recs[~is_cloud, 2:5]) if (~is_cloud).sum() > 20 else '-'}.")
            mins = (recs[:, 0] // 60).astype(int)
            print("  The cloud's records by the minute they were seen: " + ", ".join(f"{i}: {int(v):,}" for i, v in enumerate(np.bincount(mins[is_cloud], minlength=mins.max() + 1)))
                  + "; the track's poses by the minute: " + ", ".join(f"{i}: {int(v):,}" for i, v in enumerate(np.bincount((track[:, 0] // 60).astype(int)))) + ".")
            again = (la[:, 3] & 8) > 0
            print(f"  The cloud's records seen again from another place: {int((is_cloud & again).sum()):,}; the same spot (2 in cube) holding more than one of the cloud's records: "
                  f"{100 * (1 - len(np.unique(np.floor(recs[is_cloud, 2:5] / 0.05).astype(np.int64), axis=0)) / max(1, int(is_cloud.sum()))):.0f}% of them are repeats.")
            t_half = np.percentile(np.hypot(track[:, 1] - np.median(track[:, 1]), track[:, 3] - np.median(track[:, 3])), 90)
            print(f"  The track reaches {t_half * S.FT:.0f} ft from its middle (9 in 10 of its poses); the records' middle distance from it, flat on the ground: {np.median(spanxz) * S.FT:.0f} ft; within 15 ft of the track's middle {100 * (spanxz < 4.57).mean():.0f}%.")
    except Exception as e:
        print(f"  Where the records lie: not worked out ({type(e).__name__}: {str(e)[:100]}).")
    rgb.tofile(os.path.join(d, "view-rgb.bin"))
    with open(os.path.join(d, "view.json"), "w") as f:
        json.dump({"records": int(len(recs)), "cloud": int(n_cloud), "weak": int(len(recs) - n_cloud), "coloured": int(rgb[:, 3].sum()),
                   "pose": "session to camera" if which.startswith("session to camera") else "camera to session", "pictures": len(keys)}, f)
    print(f"3D view made ready: {len(recs):,} records ({n_cloud:,} of the cloud, {len(recs) - n_cloud:,} weak); {int(rgb[:, 3].sum()):,} coloured from {len(keys)} pictures ({100 * rgb[:, 3].mean():.0f}%). Pictures' poses: {which}.")


if __name__ == "__main__":
    main()
