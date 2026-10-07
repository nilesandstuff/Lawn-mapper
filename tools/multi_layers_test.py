"""S30: the middle layers are squeezed the same way every time and come out
on the same patch grid as the last layer, cls token dropped."""
import os

import numpy as np
import torch

import extract_features as ef

assert ef.tap_layers({"MULTI_LAYERS": "8, 16"}) == [8, 16]
assert ef.tap_layers({}) == []
p1, p2 = ef.projection(1024, 256), ef.projection(1024, 256)
assert p1.shape == (1024, 256) and np.array_equal(p1, p2)


class FakeEye:
    side = 4
    taps = [8, 16]
    tapped = {8: torch.randn(1, 1 + 16, 1024), 16: torch.randn(1, 1 + 16, 1024)}


g = ef.tapped_grid(FakeEye, 4)
assert g.shape == (4, 4, 2 * ef.MULTI_DIMS), g.shape
# Patch (0, 0) is token 1 (token 0 is the class token), projected by the fixed matrix.
want = FakeEye.tapped[8][0, 1].numpy() @ p1
assert np.allclose(g[0, 0, :256], want, atol=1e-4)

# The hook keeps a block's output on a real timm ViT, if timm is here.
try:
    import timm
except ImportError:
    timm = None
if timm is not None:
    vit = timm.create_model("vit_tiny_patch16_224", pretrained=False)
    kept = {}
    vit.blocks[7].register_forward_hook(lambda _m, _i, out: kept.__setitem__(8, out.detach()))
    with torch.no_grad():
        vit.forward_features(torch.randn(1, 3, 224, 224))
    assert kept[8].shape[1] == 1 + 14 * 14
print("multi layers: ok")
