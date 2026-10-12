"""
The UperNet head keeps the small decoder's contract (S26).

Shapes are the whole contract: the answer and the refiner's 32-number hidden
layer must land on the patch grid the labels are on, for any grid the frame
dump makes (a windowed lawn is not 64 across), or every downstream reader is
out of register and the result reads as "UperNet is worse".

    python3 tools/upernet_test.py
"""

import torch

from upernet_head import UperNetHead, CHANNELS


def check_shapes():
    m = UperNetHead(1031)
    for h, w in ((64, 64), (50, 70), (9, 9)):
        hidden, logits = m.parts(torch.randn(2, 1031, h, w))
        assert logits.shape == (2, 1, h, w), (h, w, logits.shape)
        assert hidden.shape == (2, 32, h, w), "the refiner reads 32 numbers a patch"
    print(f"shapes: answer and hidden layer on the grid, for 64x64, 50x70 and 9x9")


def check_small():
    n = sum(p.numel() for p in UperNetHead(1031).parameters())
    assert 300_000 < n < 1_000_000, n
    assert not any(isinstance(mod, torch.nn.BatchNorm2d) for mod in UperNetHead(1031).modules()), "GroupNorm only: batches are four lawns"
    print(f"small: {n:,} weights at {CHANNELS} channels, no BatchNorm")


def check_eval_is_deterministic():
    m = UperNetHead(1031).eval()
    x = torch.randn(1, 1031, 16, 16)
    with torch.no_grad():
        assert torch.allclose(m(x), m(x)), "eval must not depend on dropout draws"
    m.train()
    torch.manual_seed(1)
    a = m(x)
    torch.manual_seed(2)
    b = m(x)
    assert not torch.allclose(a, b), "training must apply dropout"
    print("dropout: on in training, off at eval")


def check_pyramid():
    levels = UperNetHead.pyramid(torch.randn(1, 4, 50, 70))
    assert [tuple(l.shape[-2:]) for l in levels] == [(50, 70), (25, 35), (13, 18), (7, 9)], [l.shape for l in levels]
    print("pyramid: strides 1, 2, 4, 8, ceil on odd sizes")


if __name__ == "__main__":
    check_shapes()
    check_small()
    check_eval_is_deterministic()
    check_pyramid()
    print("upernet head: ok")
