"""
A WALK'S PICTURES AT FULL RESOLUTION, FROM ITS ARCORE RECORDING (core session, 2026-11-08). The owner: "Do we know
that 480 is actually good enough?" The page keeps each picture 480 wide; a walk recorded by the app (bridge 3)
holds ARCore's camera stream whole in recording.mp4 (1920x1080 on the walks recorded in the largest mode). This
finds, for every picture the twin kept, the same moment in the recording, and writes that frame turned and cropped
the way the page's picture was, at the recording's own size: a copy of the twin whose key-NNNN.jpg are full size.
Every study that reads a twin can then run on both.

  python scan/tools/fullres_frames.py <twin dir> <recording.mp4> <out dir>

How the moment is found: the twin's pictures carry the seconds since the walk began; the recording starts when
ARCore's session did, a little earlier. Small grey copies of the pictures are matched against the recording at five
frames a second for one offset (the median over many pictures, both turns tried); then each picture is matched again
frame by frame within 0.4 s of it, since the page took its picture a little after ARCore's frame.

Prints counts, sizes and match quality only: the pictures are the yard and the repository is public.
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

SMALL = (160, 90)        # the recording's frames, shrunk, for matching (landscape, as recorded)
COARSE_FPS = 5
WINDOW = 0.4             # s either side of the offset's guess, matched frame by frame


def probe(mp4):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          "stream=index,width,height,avg_frame_rate,nb_frames", "-of", "json", mp4],
                         capture_output=True, text=True, check=True).stdout
    vs = json.loads(out).get("streams", [])
    if not vs:
        raise SystemExit("no video in the recording")
    for i, s in enumerate(vs):
        s["vi"] = i
    best = max(vs, key=lambda s: s["width"] * s["height"])
    return best, vs


def gray_frames(mp4, vi, start=None, dur=None, fps=None):
    """The recording's frames as small grey arrays (n, 90, 160); with fps, resampled to it."""
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, start):.3f}"]
    cmd += ["-i", mp4]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    vf = (f"fps={fps}," if fps else "") + f"scale={SMALL[0]}:{SMALL[1]},format=gray"
    cmd += ["-map", f"0:v:{vi}", "-vf", vf, "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, SMALL[1], SMALL[0]).astype(np.float32)


def turned(frames, turn, aspect):
    """The recording's frames as the page saw them: turned a quarter (1 = clockwise, -1 = anticlockwise) and cropped
    across to the picture's width / height, centred."""
    r = np.rot90(frames, k=-1 if turn == 1 else 1, axes=(1, 2))      # (n, 160, 90): portrait
    h, w = r.shape[1], r.shape[2]
    cw = min(w, max(4, round(h * aspect)))
    x0 = (w - cw) // 2
    return r[:, :, x0:x0 + cw]


def norm(a):
    a = a.reshape(a.shape[0], -1)
    a = a - a.mean(1, keepdims=True)
    return a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-6)


def key_small(path, shape):
    im = Image.open(path).convert("L").resize((shape[1], shape[0]), Image.BILINEAR)
    return np.asarray(im, np.float32)


def main(twin, mp4, out):
    keys = []
    for f in sorted(x for x in os.listdir(twin) if x.startswith("keys-") and x.endswith(".json")):
        keys += json.load(open(os.path.join(twin, f)))
    keys = [k for k in keys if os.path.exists(os.path.join(twin, k["name"]))]
    if not keys:
        raise SystemExit("the twin has no pictures")
    st, allv = probe(mp4)
    W, H = st["width"], st["height"]
    sizes = ", ".join(f"{s['width']}x{s['height']}" for s in allv)
    print(f"Recording: {len(allv)} video stream(s) ({sizes}); using {W}x{H}. Pictures in the twin: {len(keys)} ({keys[0]['w']}x{keys[0]['h']}).")
    aspect = keys[0]["w"] / keys[0]["h"]

    # one offset for the walk: a spread of pictures against the whole recording at five frames a second
    coarse = gray_frames(mp4, st["vi"], fps=COARSE_FPS)
    sample = keys[:: max(1, len(keys) // 40)]
    best = None
    for turn in (1, -1):
        T = turned(coarse, turn, aspect)
        Tn = norm(T)
        offs, scores = [], []
        for k in sample:
            ks = norm(key_small(os.path.join(twin, k["name"]), T.shape[1:])[None])[0]
            c = Tn @ ks
            i = int(np.argmax(c))
            offs.append(i / COARSE_FPS - k["t"])
            scores.append(float(c[i]))
        off = float(np.median(offs))
        inl = [s for o, s in zip(offs, scores) if abs(o - off) < 0.5]
        cand = (len(inl), float(np.median(scores)), turn, off)
        if best is None or cand[:2] > best[:2]:
            best = cand
    n_in, med, turn, off = best
    print(f"Offset: the recording runs {off:+.2f} s from the walk's clock ({n_in} of {len(sample)} pictures agree within 0.5 s; "
          f"turned {'clockwise' if turn == 1 else 'anticlockwise'}; median match {med:.2f}).")
    if n_in < max(3, len(sample) // 3):
        raise SystemExit("the pictures do not line up with the recording: not this walk's recording, or a different camera")

    # every picture: matched frame by frame near its guess, then written at the recording's size
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(twin):
        if not f.startswith("key-"):
            src, dst = os.path.join(twin, f), os.path.join(out, f)
            if not os.path.exists(dst):
                try:
                    os.symlink(os.path.abspath(src), dst)
                except OSError:
                    shutil.copy(src, dst)
    cw = min(H, round(W * aspect))     # the crop across the turned frame (H wide once turned), centred
    x0 = (H - cw) // 2
    scores, moved, done = [], [], 0
    by_name = {}
    for k in keys:
        guess = k["t"] + off
        win = gray_frames(mp4, st["vi"], start=guess - WINDOW, dur=2 * WINDOW)
        if not len(win):
            continue
        Tn = norm(turned(win, turn, aspect))
        ks = norm(key_small(os.path.join(twin, k["name"]), turned(win[:1], turn, aspect).shape[1:])[None])[0]
        c = Tn @ ks
        i = int(np.argmax(c))
        scores.append(float(c[i]))
        start = max(0.0, guess - WINDOW)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", mp4, "-map", f"0:v:{st['vi']}",
                              "-vf", f"select=eq(n\\,{i})", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True, check=True).stdout
        if len(raw) != W * H * 3:
            continue
        fr = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
        fr = np.rot90(fr, k=-1 if turn == 1 else 1)          # (W, H, 3): portrait, H wide
        fr = np.ascontiguousarray(fr[:, x0:x0 + cw])
        Image.fromarray(fr).save(os.path.join(out, k["name"]), quality=92)
        by_name[k["name"]] = (fr.shape[1], fr.shape[0])
        moved.append(abs(start + i / max(1.0, len(win) / (2 * WINDOW)) - guess))
        done += 1
    for f in sorted(x for x in os.listdir(twin) if x.startswith("keys-") and x.endswith(".json")):
        ks = json.load(open(os.path.join(twin, f)))
        for k in ks:
            if k["name"] in by_name:
                k["w"], k["h"] = by_name[k["name"]]
        dst = os.path.join(out, f)
        if os.path.islink(dst):
            os.unlink(dst)
        json.dump(ks, open(dst, "w"))
    meta = os.path.join(out, "meta.json")
    if os.path.exists(meta) and by_name:
        m = json.load(open(meta))
        os.unlink(meta)
        w, h = next(iter(by_name.values()))
        m["camera"] = {**(m.get("camera") or {}), "w": w, "h": h, "fromRecording": True}
        json.dump(m, open(meta, "w"))
    sc = np.array(scores) if scores else np.zeros(1)
    size = "x".join(map(str, next(iter(by_name.values()), ("-", "-"))))
    print(f"Full-size pictures: {done} of {len(keys)} written, {size}; "
          f"match quartiles {np.percentile(sc, 25):.2f} / {np.median(sc):.2f} / {np.percentile(sc, 75):.2f}; "
          f"{(sc < 0.5).sum()} matched poorly (under 0.5).")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
