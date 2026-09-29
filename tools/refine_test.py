"""edge_refine.py reads the decoder where to_photo does, and starts as the decoder.

If the refiner's stretch of the decoder's answer disagreed with to_photo's
by even a fraction of a patch, a refined run would be graded against a
shifted edge and the comparison with the plain decoder would measure the
shift. So: the same points, the same numbers, on grids with padding.
"""

import numpy as np
import torch

from decoder_grid import to_photo
from edge_refine import Refiner, edge_cells, pick_crops, sampling_grid, stretch
from train_decoder import dihedral, undo_dihedral


def check_stretch_matches_to_photo():
    rng = np.random.default_rng(3)
    for gw, gh, cw, ch, cx, cy in [(64, 64, 700, 520, 1.0, 1.35), (48, 30, 512, 300, 1.2, 1.1), (5, 7, 40, 33, 1.0, 1.0)]:
        grid = rng.random((gh, gw)).astype(np.float32)
        want = to_photo(grid, cw, ch, cx, cy)
        got = stretch(torch.from_numpy(grid)[None, None], sampling_grid(cw, ch, gw, gh, cx, cy))[0, 0].numpy()
        assert got.shape == want.shape, (got.shape, want.shape)
        assert np.abs(got - want).max() < 1e-5, np.abs(got - want).max()
        # A crop reads the same numbers as the whole.
        x0, y0, w, h = 7, 11, 20, 13
        part = stretch(torch.from_numpy(grid)[None, None], sampling_grid(cw, ch, gw, gh, cx, cy, x0, y0, w, h))[0, 0].numpy()
        assert np.abs(part - want[y0:y0 + h, x0:x0 + w]).max() < 1e-5


def check_starts_as_decoder():
    r = Refiner()
    rgb, logit, hidden = torch.randn(2, 3, 20, 24), torch.randn(2, 1, 20, 24), torch.randn(2, 32, 20, 24)
    assert torch.equal(r(rgb, logit, hidden), logit)


def check_undo_dihedral():
    x = torch.randn(1, 3, 5, 8)
    for k in range(4):
        for flip in (False, True):
            y, _, _ = dihedral(x, x, x, k, flip)
            assert torch.equal(undo_dihedral(y, k, flip), x), (k, flip)


def check_crops():
    truth = np.zeros((200, 150), bool)
    truth[50:120, 40:100] = True
    weight = np.ones((200, 150), np.float32)
    weight[:, :10] = 0
    edge, graded = edge_cells(truth, weight)
    ys, xs = np.divmod(edge, 150)
    assert len(edge) and all(abs(y - 50) <= 4 or abs(y - 119) <= 4 or abs(x - 40) <= 4 or abs(x - 99) <= 4
                             for y, x in zip(ys, xs))
    L = {"fine_t": torch.zeros(1, 200, 150), "edge_idx": edge, "graded_idx": graded}
    for x0, y0, w, h in pick_crops(L, np.random.default_rng(0), n=20, size=112):
        assert 0 <= x0 and x0 + w <= 150 and 0 <= y0 and y0 + h <= 200 and w == h == 112


check_stretch_matches_to_photo()
check_starts_as_decoder()
check_undo_dihedral()
check_crops()
print("edge refiner: ok")
