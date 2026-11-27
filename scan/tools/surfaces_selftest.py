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
SHED = (-4.5, -2.5, -8.0, -6.5)        # x0, x1, z0, z1: a shed 2 m tall, only the walk's kept points on its walls
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
    in_shed = (xs >= SHED[0]) & (xs <= SHED[1]) & (zs >= SHED[2]) & (zs <= SHED[3])
    keep = ~hole & ~under_deck & ~in_shed & (zs > WALL_Z)
    xs, zs = xs[keep], zs[keep]
    speck = (xs >= -5.2) & (xs <= -4.6) & (zs >= -6.0) & (zs <= -5.4)
    lab = np.where((xs < -3) & ~speck, 6, 7).astype(np.uint8)          # sidewalk 5 + 1, terrain 6 + 1
    wx = rng.uniform(-6, 0, 3000); wy = rng.uniform(0.4, 2.8, 3000)   # the phone labelled only the wall's west half
    # a tree's trunk in the lawn the phone called "building" (one source: the walk's kept points), 0.3 m across, 0.4-2.5 m up
    tx_ = -1.0 + rng.uniform(-0.15, 0.15, 400); tz_ = -7.5 + rng.uniform(-0.15, 0.15, 400); ty_ = rng.uniform(0.4, 2.5, 400)
    wx, wy = np.r_[wx, tx_], np.r_[wy, ty_]
    wz = np.r_[np.full(3000, WALL_Z + 0.02), tz_]
    # the shed's four walls, 0.2-2.0 m up, a point every 5 cm along them
    sx_, sz_ = [], []
    for t_ in np.arange(0, 1, 0.025):
        for (ax, az, bx, bz) in ((SHED[0], SHED[2], SHED[1], SHED[2]), (SHED[1], SHED[2], SHED[1], SHED[3]), (SHED[1], SHED[3], SHED[0], SHED[3]), (SHED[0], SHED[3], SHED[0], SHED[2])):
            sx_.append(ax + t_ * (bx - ax)); sz_.append(az + t_ * (bz - az))
    sx_, sz_ = np.repeat(sx_, 10), np.repeat(sz_, 10)
    sy_ = np.tile(np.linspace(0.2, 2.0, 10), len(sx_) // 10)
    wx, wy, wz = np.r_[wx, sx_], np.r_[wy, sy_], np.r_[wz, sz_]
    t = np.arange(len(xs) + len(wx), dtype=np.float32) * 0.01
    recs = np.zeros((len(xs) + len(wx), 6), np.float32)
    recs[:, 0] = t
    recs[:len(xs), 2], recs[:len(xs), 3], recs[:len(xs), 4] = xs, 0.0, zs
    recs[len(xs):, 2], recs[len(xs):, 3], recs[len(xs):, 4] = wx, wy, wz
    recs[:, 5] = 0.0
    labs = np.zeros((len(recs), 4), np.uint8)
    labs[:len(xs), 0] = lab
    labs[len(xs):, 0] = 3                                              # building 2 + 1
    recs.tofile(os.path.join(d, "cloud-0.bin")); labs.tofile(os.path.join(d, "labels-0.bin"))
    # pictures from the lawn at the deck and the wall
    nx, ny = 72, 128
    P = persp()
    keys, track, yard = [], [], {}
    # (since the rule wants two sources for a built square and a picture's built cells only within 5 m: two looks at the
    # deck, and five along the wall from 4.5 m)
    views = [([1.0, 1.5, -2.5], [3.2, 0.3, -5.5]), ([5.5, 1.5, -3.0], [3.2, 0.3, -5.5])]
    views += [([x0, 1.5, -5.5], [x0, 1.2, WALL_Z]) for x0 in (-4.0, -2.0, 0.0, 2.0, 4.0)]
    for i, (eye, tgt) in enumerate(views):
        C = look_at(eye, tgt)
        name = f"key-{i:04d}.jpg"
        keys.append({"name": name, "t": 1.0 + i, "view": C.T.ravel().tolist(), "proj": P.T.ravel().tolist()})
        track.append([1.0 + i, 0, *eye, 0, 0, 0, 0, 0])
        Pi = np.linalg.inv(P)
        yi = np.zeros(nx * ny, np.uint8)
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
                ade[k] = (1, 8, 8)[what]          # turf, and the deck's boards labelled "wall" like the wall (the owner's deck, 2026-11-27): the shape must tell them apart
                yi[k] = (17, 9, 1)[what]          # the yard labeller: lawn, deck, house (yard_labels.THINGS, 1-based)
        r = np.concatenate([[nx, ny], np.round(dist * 1000), np.round(conf * 255)]).astype("<u2")
        r.tofile(os.path.join(d, name.replace(".jpg", ".rdepth")))
        hdr = np.array([nx & 255, nx >> 8, ny & 255, ny >> 8], np.uint8)
        np.concatenate([hdr, sem, np.full(nx * ny, 255, np.uint8)]).tofile(os.path.join(d, name.replace(".jpg", ".sem")))
        np.concatenate([hdr, ade]).tofile(os.path.join(d, name.replace(".jpg", ".ade")))
        yard[name] = yi.reshape(ny, nx)
    json.dump(keys, open(os.path.join(d, "keys-0.json"), "w"))
    nm_ = sorted(yard)
    np.savez_compressed(os.path.join(d, "yard-labels.npz"), version=1, pics=json.dumps(nm_), things="[]", idx=np.stack([yard[n] for n in nm_]), conf=np.stack([yard[n] for n in nm_]))
    # ARCore's surfaces: the whole wall; a fence along the east side (no building seen along it); the deck's boards
    wall = [-6, 0, WALL_Z, 6, 0, WALL_Z, 6, 2.8, WALL_Z, -6, 2.8, WALL_Z]
    fence = [5.8, 0, -9, 5.8, 0, -2, 5.8, 1.2, -2, 5.8, 1.2, -9]
    deck = [DECK[0], DECK[4], DECK[2], DECK[1], DECK[4], DECK[2], DECK[1], DECK[4], DECK[3], DECK[0], DECK[4], DECK[3]]
    json.dump({"v": 1, "planes": [[1, 2, 0, wall], [2, 2, 0, fence], [3, 0, 0, deck]]}, open(os.path.join(d, "planes.json"), "w"))
    np.array(track, np.float32).tofile(os.path.join(d, "track-0.bin"))
    json.dump({"ok": True, "T": {"theta": 0, "tx": 0, "ty": 0, "s": 1}, "n": 3, "worstM": 0.1}, open(os.path.join(d, "fit.json"), "w"))


def lidar_file(path):
    """The lidar's shapes for the scene (lidar-built.mjs's file): the house behind the wall, its roof's edge 2 ft out
    over the lawn (the lidar sees the eaves, not the wall), and the deck as a low structure."""
    c = 0.3048
    i0, j0, w, h = -30, -10, 60, 60
    k = np.zeros((h, w), np.uint8); t = np.zeros((h, w), np.uint8)
    for r in range(h):
        for q in range(w):
            x, n = (i0 + q + 0.5) * c, (j0 + r + 0.5) * c          # n = -z
            if -6 <= x <= 6 and n >= -WALL_Z - 0.6:
                k[r, q], t[r, q] = 1, 60
            if DECK[0] <= x <= DECK[1] and -DECK[3] <= n <= -DECK[2]:
                k[r, q], t[r, q] = 4, 6
            if SHED[0] <= x <= SHED[1] and -SHED[3] <= n <= -SHED[2]:
                k[r, q], t[r, q] = 4, 20
    enc = lambda a: base64.b64encode(zlib.compress(a.tobytes(), 9)).decode()
    json.dump({"v": 1, "cellM": c, "i0": i0, "j0": j0, "w": w, "h": h, "enc": "zlib+base64", "kinds": enc(k), "tops": enc(t)}, open(path, "w"))


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "m1-1")
        os.makedirs(d)
        make(d)
        out = os.path.join(tmp, "surfaces-map.json")
        r = subprocess.run([sys.executable, os.path.join(HERE, "surfaces.py"), d, "--ade", "--keep", out], capture_output=True, text=True)
        print(r.stdout[-3000:]); print(r.stderr[-3000:])
        assert r.returncode == 0, "surfaces.py failed"
        check(json.load(open(out)), r, tmp)
        # AND WITH THE LIDAR'S SHAPES (--lidar): the walls placed where the walks saw them, 2 ft in from the roof's edge
        lf = os.path.join(tmp, "lidar-built.json"); lidar_file(lf)
        r = subprocess.run([sys.executable, os.path.join(HERE, "surfaces.py"), d, "--ade", "--keep", out, "--lidar", lf], capture_output=True, text=True)
        print(r.stdout[-3000:]); print(r.stderr[-3000:])
        assert r.returncode == 0, "surfaces.py failed"
        j = json.load(open(out))
        g = check(j, r, tmp)
        c = j["cellM"]
        at = lambda x, z: g[int(np.floor(-z / c)) - j["j0"], int(np.floor(x / c)) - j["i0"]]
        yl = [l for l in r.stdout.splitlines() if "THE YARD LABELS ON THE LIDAR'S SHAPES" in l]
        assert yl and "(building, 80 sq ft, confirmed): " in yl[0] and "house 8" in yl[0] and "a deck): " in yl[0] and "deck 3" in yl[0].split("a deck): ")[1], f"the yard labels on the shapes ({yl})"
        assert "THE LIDAR'S SHAPES, CHECKED BY THE WALKS: 3 shapes" in r.stdout and "confirmed with their walls placed 2" in r.stdout and "a deck, not a building 1" in r.stdout, "the shapes' verdicts"
        assert at(0.0, WALL_Z + 0.45) != 4, f"under the eaves, between the roof's edge and the wall: not solid ({at(0.0, WALL_Z + 0.45)})"
        assert at(-5.0, WALL_Z + 0.1) == 4, "the wall, all along the lidar's shape"
        pe_ = __import__("re").search(r"edge squares placed by ARCore's wall planes ([0-9,]+)", r.stdout)
        assert pe_ and int(pe_.group(1).replace(",", "")) > 0, "the house's south face placed by its wall plane"
        sj = json.load(open(os.path.join(tmp, "structures.json")))
        sk = np.frombuffer(zlib.decompress(base64.b64decode(sj["kinds"])), np.uint8).reshape(sj["h"], sj["w"])
        assert not (sk == 6).any(), "no lidar shape here is a tree: nothing taken away"
        # TWO WALKS, THE SECOND PUT 1 FT EAST AND 1 FT NORTH: the walls against each other say so
        d2 = os.path.join(tmp, "m1-2")
        import shutil
        shutil.copytree(d, d2)
        json.dump({"ok": True, "T": {"theta": 0, "tx": 0.3048, "ty": 0.3048, "s": 1}, "n": 3, "worstM": 0.1}, open(os.path.join(d2, "fit.json"), "w"))
        r2 = subprocess.run([sys.executable, os.path.join(HERE, "surfaces.py"), d, d2, "--ade", "--keep", out, "--lidar", lf], capture_output=True, text=True)
        assert r2.returncode == 0, r2.stderr[-2000:]
        al = [l for l in r2.stdout.splitlines() if "THE WALKS' WALLS AGAINST EACH OTHER" in l]
        print(al)
        import re as _re
        m2 = _re.search(r"walk 2: ([+-][0-9.]+) ft east, ([+-][0-9.]+) ft north", al[0] if al else "")
        assert m2 and abs(float(m2.group(1)) - 1) <= 0.5 and abs(float(m2.group(2)) - 1) <= 0.5, f"walk 2 found 1 ft east and 1 ft north of walk 1 ({al})"
        kinds = np.bincount(g.ravel(), minlength=11)
        print("surfaces selftest with the lidar: ok;", ", ".join(f"{k}: {v}" for k, v in enumerate(kinds) if v))


def check(j, r, tmp):
    if True:
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
        sj = json.load(open(os.path.join(tmp, "structures.json")))
        sk = np.frombuffer(zlib.decompress(base64.b64decode(sj["kinds"])), np.uint8).reshape(sj["h"], sj["w"])
        tp = np.frombuffer(zlib.decompress(base64.b64decode(sj["tops"])), np.uint8).reshape(sj["h"], sj["w"])
        sat = lambda a, x, z: a[int(np.floor(-z / c)) - sj["j0"], int(np.floor(x / c)) - sj["i0"]]
        assert sat(sk, 3.2, -5.5) == 5 and abs(sat(tp, 3.2, -5.5) - 6) <= 1, "the deck's boards at 0.6 m for the fused model"
        assert sat(sk, 0.0, WALL_Z + 0.1) == 4 and sat(tp, 0.0, WALL_Z + 0.1) >= 25, "the wall's top for the fused model"
        assert sat(sk, 2.0, -1.0) == 0, "the lawn: looked at, no claim"
        assert at(-1.0, -7.5) != 4, f"a trunk only the walk's points called building is not solid ({at(-1.0, -7.5)})"
        kinds = np.bincount(g.ravel(), minlength=11)
        print("surfaces selftest: ok;", ", ".join(f"{k}: {v}" for k, v in enumerate(kinds) if v))
        return g


if __name__ == "__main__":
    main()
