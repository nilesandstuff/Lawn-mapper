"""The same synthetic cases as tools/align.test.js, for the Python side."""
import numpy as np

from naip_align import align_images, resample

W = H = 96


def scene(tx=0, ty=0):
    g = np.full((H, W), 90.0, dtype=np.float32)

    def rect(x0, y0, x1, y1, v):
        for y in range(y0, y1):
            for x in range(x0, x1):
                X, Y = x + tx, y + ty
                if 0 <= X < W and 0 <= Y < H:
                    g[Y, X] = v

    rect(10, 12, 34, 30, 200); rect(55, 20, 80, 44, 170); rect(0, 60, 96, 68, 140)
    rect(20, 72, 40, 90, 220); rect(62, 74, 70, 94, 30)
    return g


r = align_images(scene(), scene(3, -2), max_shift=6)
assert r["moved"] and abs(r["dx"] + 3) < 0.6 and abs(r["dy"] - 2) < 0.6 and r["scale"] == 1.0, r
print("PASS  a 3 px / 2 px offset is found and undone")

r = align_images(scene(), scene(), max_shift=6)
assert not r["moved"] and r["dx"] == 0 and r["dy"] == 0, r
print("PASS  a lined-up pair is left alone")

flat = np.full((H, W), 100.0)
assert not align_images(flat, flat, max_shift=6)["moved"]
print("PASS  nothing to match means no move")

ref = scene()
c = (W - 1) / 2
big = np.zeros_like(ref)
for y in range(H):
    for x in range(W):
        big[y, x] = ref[int(round(c + (y - c) / 1.03)), int(round(c + (x - c) / 1.03))]
r = align_images(ref, big, max_shift=4, scales=(0.96, 0.97, 0.98, 1.0, 1.02, 1.03, 1.04))
assert r["moved"] and abs(r["scale"] - 1 / 1.03) < 0.012, r
print("PASS  a 3% scale error is found")

# Resampling by the answer puts NAIP back on the photograph.
shifted = scene(3, -2)[..., None]
back = resample(shifted, -3, 2, 1.0)[..., 0]
inner = (slice(8, -8), slice(8, -8))
assert np.abs(back[inner] - scene()[inner]).mean() < 1.0
print("PASS  resampling by the found shift undoes it")

# A margin fetch: the frame sits 5 px inside a bigger picture.
padded = np.pad(scene()[..., None], ((5, 5), (5, 5), (0, 0)), mode="edge")
out = resample(padded, 0, 0, 1.0, offset=(5, 5), out_shape=(H, W))[..., 0]
assert np.abs(out - scene()).max() < 1e-4
print("PASS  a margin around the frame is cropped back exactly")
