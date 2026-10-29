"""The live detector unpacks a read by its real grid (2026-10-24).

A native read at 4096 px is 256 x 256 patches; unpacking it as the eye's
default 56 x 56 laid the bottom rows of the grid across the whole lot as
stripes. A stand-in eye answers each patch with its own row and column, so a
wrong unpacking shows at once. No model is loaded.

    python3 alpha_infer_test.py
"""
import sys

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, ".")
import alpha_infer  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"\n      {detail}" if detail and not cond else ""))
    ok = ok and bool(cond)


class Eye:
    side, patch, wants_scale = 56, 16, False

    def look(self, tensor, mpp):
        n = tensor.shape[-1] // self.patch
        rows, cols = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        feats = np.stack([rows.ravel(), cols.ravel()], axis=1).astype(np.float32)
        extra = np.full((5, 2), -1, np.float32)  # a class token and registers, as DINOv3 has
        return torch.from_numpy(np.concatenate([extra, feats])[None])


det = object.__new__(alpha_infer.Detector)
det.eye = Eye()
photo = Image.new("RGB", (600, 640), (90, 140, 60))
for size in (896, 4096):
    grid, cover = det.whole(photo, 427.0, size)
    n = size // 16
    check(f"a {size} px read is {n} x {n} patches", grid.shape[:2] == (n, n), str(grid.shape))
    check(f"and each patch sits where the eye saw it ({size} px)",
          grid[0, 0, 0] == 0 and grid[n - 1, n - 1, 1] == n - 1 and grid[n // 2, 3, 0] == n // 2 and grid[n // 2, 3, 1] == 3,
          f"{grid[0, 0]} {grid[n - 1, n - 1]} {grid[n // 2, 3]}")

# LEAF-ON LIDAR (S68): the decoder gets none, and the fused channels read exactly as training's dropout makes them.
from fuse_layers import extra_channels  # noqa: E402
lid = {"height": np.full((8, 8), 12.0), "n_ground": np.ones((8, 8)), "n_all": np.full((8, 8), 4.0), "intensity": np.full((8, 8), 300.0)}
check("a leaf-off or undated flight goes to the decoder", alpha_infer.lidar_for_decoder({}, lid) is lid and alpha_infer.lidar_for_decoder({"lidarLeafOn": False}, lid) is lid)
check("a leaf-on flight does not", alpha_infer.lidar_for_decoder({"lidarLeafOn": True}, lid) is None)
hid = extra_channels(4, 4, (0, 8), (0, 8), lidar=alpha_infer.lidar_for_decoder({"lidarLeafOn": True}, lid), with_intensity=True)
check("and its channels, flag and brightness included, are all zero, as a lot without lidar reads", float(np.abs(hid).sum()) == 0.0)

print("alpha_infer: ok" if ok else "alpha_infer: FAILED")
sys.exit(0 if ok else 1)
