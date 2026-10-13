"""
S38's arithmetic, offline (tools/intensity_errors.py).

A rank flipped bright-for-dark, or a "called lawn" side built from the wrong
mask, does not fail: it reports a plausible AUC about the wrong question.

    python3 tools/intensity_errors_test.py
"""

import numpy as np

from intensity_errors import scene_rank, lot_sides, summarise, verdict


def check_rank():
    r = scene_rank(np.array([[10.0, np.nan], [30.0, 20.0]]))
    assert r[0, 0] == 0.0 and r[1, 0] == 1.0 and r[1, 1] == 0.5, r
    assert np.isnan(r[0, 1]), "no ground return stays silent"
    assert np.isnan(scene_rank(np.full((2, 2), np.nan))).all()
    # Two flights on different scales read the same once ranked.
    assert np.allclose(scene_rank(np.array([1.0, 2.0, 3.0])), scene_rank(np.array([100.0, 900.0, 5000.0])))
    print("rank: darkest 0, brightest 1, per frame, NaN kept")


def check_sides():
    #           lawn  lawn  not   not   canopy  outside
    classes = np.array([[0, 0, 3, 3, 1, -1]])
    rank = np.array([[0.9, np.nan, 0.2, 0.8, 0.5, 0.5]])
    pred = np.array([[True, True, True, False, True, True]])
    sides, counts = lot_sides(classes, rank, pred)
    lawn, not_ = sides["said_lawn"]
    assert list(lawn) == [0.9] and list(not_) == [0.2], "called lawn: one true (0.9), one false (0.2)"
    assert len(sides["said_not"][0]) == 0 and list(sides["said_not"][1]) == [0.8]
    assert counts["open"] == 4 and counts["wrong"] == 1 and counts["false_lawn"] == 1
    assert counts["wrong_silent"] == 0
    assert len(sides["all"][0]) == 1, "the silent lawn cell sits out"
    print("sides: open cells only, split by the held-out answer, silent cells counted")


def lot(i, lawn_said, false_said, missed, true_not, wrong=10):
    return {"id": str(i), "counts": {"open": 100, "wrong": wrong},
            "sides": {"all": (np.array(lawn_said + missed), np.array(false_said + true_not)),
                      "said_lawn": (np.array(lawn_said), np.array(false_said)),
                      "said_not": (np.array(missed), np.array(true_not))}}


def check_verdict():
    rng = np.random.default_rng(1)
    u = lambda lo, hi, n=30: list(rng.uniform(lo, hi, n))  # noqa: E731
    strong = [lot(i, u(0.4, 1), u(0, 0.6), u(0.4, 1), u(0, 0.6), wrong=5 + i) for i in range(9)]
    assert verdict(summarise(strong)) == "trial"
    toss = [lot(i, u(0, 1), u(0, 1), u(0, 1), u(0, 1), wrong=5 + i) for i in range(9)]
    assert verdict(summarise(toss)) == "closed"
    # Strong pooled but split by direction lot to lot (a wavelength flip) is not a trial.
    flip = [lot(i, u(0.4, 1), u(0, 0.6), u(0, 1), u(0, 1)) if i % 2 else lot(i, u(0, 0.6), u(0.4, 1), u(0, 1), u(0, 1))
            for i in range(9)]
    assert verdict(summarise(flip)) != "trial"
    print("bar: a clear signal is a trial, a coin toss closed, a lot-to-lot flip is not a trial")


if __name__ == "__main__":
    check_rank()
    check_sides()
    check_verdict()
    print("intensity errors: ok")
