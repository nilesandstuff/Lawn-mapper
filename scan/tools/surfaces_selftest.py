"""
A DRAWN WALK FOR surfaces.py (core session, 2026-11-27): a twin folder made from a scene of known shapes, run through
surfaces.py --ade --keep, and the kept squares checked. The scene, in the walk's own metres (y up, the walk's ground
at y = 0): a lawn, a paved strip down its west side with a 2 ft x 2 ft speck of grass in it, a 3 ft hole in the lawn
where nothing was seen, a deck's boards 0.6 m up, and a wall. Two pictures look at the deck and the wall.

    python scan/tools/surfaces_selftest.py
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import zlib

import numpy as np

FT = 3.28084
HERE = os.path.dirname(os.path.abspath(__file__))


def persp(fov_y=np.radians(60), aspect=72 / 128, n=0.1, f=50.0):
    t = 1 / np.tan(fov_y / 2)
    return np.array([[t / aspect, 0, 0, 0], [0, t, 0, 0], [0, 0, (f + n) / (n - f), 2 * f * n / (n - f)], [0, 0, -1, 0]])


def look_at(eye, target):
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    fwd = target - eye; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    M = np.eye(4); M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = right, up, -fwd, eye
    return M    # camera to session


DECK = (2.0, 4.5, -7.0, -4.0, 0.6)     # x0, x1, z0, z1, height
WALL_Z = -10.0


def scene_hit(o, d):
    """The nearest of: the deck's top, the wall (z = WALL_Z, 0-3 m up), the ground. -> (t, what) what: 0 ground, 1 deck, 2 wall."""
    best, what = np.inf, -1
    if d[1] < 0:
        t = -o[1] / d[1]; best, what = t, 0
        t = (DECK[4] - o[1]) / d[1]; p = o + t * d
        if 0 < t < best and DECK[0] <= p[0] <= DECK[1] and DECK[2] <= p[2] <= DECK[3]:
            best, what = t, 1
    if d[2] < 0:
        t = (WALL_Z - o[2]) / d[2]; p = o + t * d
        if 0 < t < best and 0 <= p[1] <= 3 and -6 <= p[0] <= 6:
            best, what = t, 2
    return best, what


def make(d):
    rng = np.random.default_rng(3)
    # the walk's kept points: the ground every 0.1 m over x -6..6, z -12..0; paving x < -3; the speck of grass at
    # x -5.2..-4.6, z -6.0..-5.4; nothing in the hole x 0..0.9, z -3..-2.1; the wall's face (the phone's "building")
    xs, zs = np.meshgrid(np.arange(-6, 6, 0.1) + 0.05, np.arange(-12, 0, 0.1) + 0.05)
    xs, zs = xs.ravel(), zs.ravel()
    hole = (xs >= 0) & (xs <= 0.9) & (zs >= -3) & (zs <= -2.1)
    under_deck = (xs >= DECK[0]) & (xs <= DECK[1]) & (zs >= DECK[2]) & (zs <= DECK[3])
    keep = ~hole & ~under_deck & (zs > WALL_Z)
    xs, zs = xs[keep], zs[keep]
    speck = (xs >= -5.2) & (xs <= -4.6) & (zs >= -6.0) & (zs <= -5.4)
    lab = np.where((xs < -3) & ~speck, 6, 7).astype(np.uint8)          # sidewalk 5 + 1, terrain 6 + 1
    wx = rng.uniform(-6, 0, 3000); wy = rng.uniform(0.4, 2.8, 3000)   # the phone labelled only the wall's west half
    t = np.arange(len(xs) + len(wx), dtype=np.float32) * 0.01
    recs = np.zeros((len(xs) + len(wx), 6), np.float32)
    recs[:, 0] = t
    recs[:len(xs), 2], recs[:len(xs), 3], recs[:len(xs), 4] = xs, 0.0, zs
    recs[len(xs):, 2], recs[len(xs):, 3], recs[len(xs):, 4] = wx, wy, WALL_Z + 0.02
    recs[:, 5] = 0.0
    labs = np.zeros((len(recs), 4), np.uint8)
    labs[:len(xs), 0] = lab
    labs[len(xs):, 0] = 3                                              # building 2 + 1
    recs.tofile(os.path.join(d, "cloud-0.bin")); labs.tofile(os.path.join(d, "labels-0.bin"))
    # two pictures, from the lawn, at the deck and the wall
    nx, ny = 72, 128
    P = persp()
    keys, track = [], []
    for i, (eye, tgt) in enumerate((([1.0, 1.5, -1.0], [3.2, 0.3, -5.5]), ([0.0, 1.5, -4.0], [0.0, 1.2, -10.0]))):
        C = look_at(eye, tgt)
        name = f"key-{i:04d}.jpg"
        keys.append({"name": name, "t": 1.0 + i, "view": C.T.ravel().tolist(), "proj": P.T.ravel().tolist()})
        track.append([1.0 + i, 0, *eye, 0, 0, 0, 0, 0])
        Pi = np.linalg.inv(P)
        dist = np.zeros(nx * ny); conf = np.zeros(nx * ny); sem = np.zeros(nx * ny, np.uint8); ade = np.zeros(nx * ny, np.uint8)
        for jj in range(ny):
            for ii in range(nx):
                u, v = 2 * (ii + 0.5) / nx - 1, 1 - 2 * (jj + 0.5) / ny
                a4 = Pi @ [u, v, -1, 1]; b4 = Pi @ [u, v, 1, 1]
                dc = b4[:3] / b4[3] - a4[:3] / a4[3]
                dw = C[:3, :3] @ dc; dw /= np.linalg.norm(dw)
                tt, what = scene_hit(np.asarray(eye, float), dw)
                k = jj * nx + ii
                if what < 0 or tt > 12:
                    continue
                dist[k], conf[k] = tt, 1.0
                sem[k] = (6, 7, 2)[what]          # terrain, structure, building
                ade[k] = (1, 9, 8)[what]          # turf, floor, built
        r = np.concatenate([[nx, ny], np.round(dist * 1000), np.round(conf * 255)]).astype("<u2")
        r.tofile(os.path.join(d, name.replace(".jpg", ".rdepth")))
        hdr = np.array([nx & 255, nx >> 8, ny & 255, ny >> 8], np.uint8)
        np.concatenate([hdr, sem, np.full(nx * ny, 255, np.uint8)]).tofile(os.path.join(d, name.replace(".jpg", ".sem")))
        np.concatenate([hdr, ade]).tofile(os.path.join(d, name.replace(".jpg", ".ade")))
    json.dump(keys, open(os.path.join(d, "keys-0.json"), "w"))
    # ARCore's surfaces: the whole wall; a fence along the east side (no building seen along it); the deck's boards
    wall = [-6, 0, WALL_Z, 6, 0, WALL_Z, 6, 2.8, WALL_Z, -6, 2.8, WALL_Z]
    fence = [5.8, 0, -9, 5.8, 0, -2, 5.8, 1.2, -2, 5.8, 1.2, -9]
    deck = [DECK[0], DECK[4], DECK[2], DECK[1], DECK[4], DECK[2], DECK[1], DECK[4], DECK[3], DECK[0], DECK[4], DECK[3]]
    json.dump({"v": 1, "planes": [[1, 2, 0, wall], [2, 2, 0, fence], [3, 0, 0, deck]]}, open(os.path.join(d, "planes.json"), "w"))
    np.array(track, np.float32).tofile(os.path.join(d, "track-0.bin"))
    json.dump({"ok": True, "T": {"theta": 0, "tx": 0, "ty": 0, "s": 1}, "n": 3, "worstM": 0.1}, open(os.path.join(d, "fit.json"), "w"))


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "m1-1")
        os.makedirs(d)
        make(d)
        out = os.path.join(tmp, "surfaces-map.json")
        r = subprocess.run([sys.executable, os.path.join(HERE, "surfaces.py"), d, "--ade", "--keep", out], capture_output=True, text=True)
        print(r.stdout[-3000:]); print(r.stderr[-3000:])
        assert r.returncode == 0, "surfaces.py failed"
        j = json.load(open(out))
        g = np.frombuffer(zlib.decompress(base64.b64decode(j["kinds"])), np.uint8).reshape(j["h"], j["w"])
        c = j["cellM"]
        at = lambda x, z: g[int(np.floor(-z / c)) - j["j0"], int(np.floor(x / c)) - j["i0"]]   # north = -z
        assert at(-5.0, -5.7) == 2, f"the speck of grass in the paving is paving now ({at(-5.0, -5.7)})"
        assert at(0.45, -2.55) == 9, f"the hole in the lawn is turf, guessed ({at(0.45, -2.55)})"
        assert at(3.2, -5.5) == 5, f"the deck's boards are an open structure ({at(3.2, -5.5)})"
        assert at(0.0, WALL_Z + 0.1) == 4, f"the wall is a solid structure ({at(0.0, WALL_Z + 0.1)})"
        assert at(2.0, -1.0) == 1 and at(-4.5, -1.0) == 2, "the lawn and the paving as seen"
        assert at(5.0, WALL_Z + 0.1) == 4, f"the wall's east end, by ARCore's plane where the labels saw nothing ({at(5.0, WALL_Z + 0.1)})"
        assert at(5.8, -5.0) != 4, "the fence's plane is not a wall"
        assert "ARCORE'S SURFACES: 2 walls, 1 of them" in r.stdout, "the surfaces' line"
        kinds = np.bincount(g.ravel(), minlength=11)
        print("surfaces selftest: ok;", ", ".join(f"{k}: {v}" for k, v in enumerate(kinds) if v))


if __name__ == "__main__":
    main()
