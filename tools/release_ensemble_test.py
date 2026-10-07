"""A release with several decoders loads them all and averages their answers;
one saved before averaging existed (no "members") loads as a single decoder."""
import os
import tempfile

import numpy as np
import torch

os.environ["REFINE"] = "1"
import train_decoder as td  # noqa: E402
from alpha_infer import Release  # noqa: E402

DIM = 8


def blob_of(model, members=()):
    state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    out = {"state": state, "mean": torch.zeros(DIM), "sd": torch.ones(DIM),
           "meta": {"dim": DIM, "refine": True, "refineReach": "normal"}}
    if members:
        out["members"] = [{"state": {k: v.detach().clone() for k, v in m.state_dict().items()},
                           "mean": torch.zeros(DIM), "sd": torch.ones(DIM)} for m in members]
    return out


def model(seed):
    torch.manual_seed(seed)
    m = td.Decoder(DIM)
    from edge_refine import Refiner
    m.refiner = Refiner()
    return m


real_answer = td.answer
with tempfile.TemporaryDirectory() as d:
    a, b, c = model(1), model(2), model(3)
    path = os.path.join(d, "model.pt")
    torch.save(blob_of(a, [b, c]), path)
    r = Release(path, "cpu")
    assert len(r.members) == 3
    # Each member answers with its first weight, so the average is checkable.
    td.answer = lambda m, mu, sd, L: np.full((2, 2), float(next(m.parameters()).flatten()[0]))
    want = np.mean([float(next(x.parameters()).flatten()[0]) for x in (a, b, c)])
    assert np.allclose(r.answer({}), want)

    torch.save(blob_of(a), path)
    r1 = Release(path, "cpu")
    assert len(r1.members) == 1
    assert np.allclose(r1.answer({}), float(next(a.parameters()).flatten()[0]))
td.answer = real_answer
print("release ensemble: ok")
