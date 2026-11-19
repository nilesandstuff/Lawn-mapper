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
    rgb.tofile(os.path.join(d, "view-rgb.bin"))
    with open(os.path.join(d, "view.json"), "w") as f:
        json.dump({"records": int(len(recs)), "cloud": int(n_cloud), "weak": int(len(recs) - n_cloud), "coloured": int(rgb[:, 3].sum()),
                   "pose": "session to camera" if which.startswith("session to camera") else "camera to session", "pictures": len(keys)}, f)
    print(f"3D view made ready: {len(recs):,} records ({n_cloud:,} of the cloud, {len(recs) - n_cloud:,} weak); {int(rgb[:, 3].sum()):,} coloured from {len(keys)} pictures ({100 * rgb[:, 3].mean():.0f}%). Pictures' poses: {which}.")


if __name__ == "__main__":
    main()
