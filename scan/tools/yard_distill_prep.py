"""
THE YARD LABELLER'S LESSONS: THE OWNER'S NAMES, AND THE BEST LABELLER BY KIND WHERE THEY GAVE NONE (core session,
2026-11-28). After every labeller was scored against the owner's names (docs/SCAN-PLAN.md 104): no labeller gets a deck,
a pool, a shed or a hot tub (all call them house), mulch only OWLv2 half the time, and the best labeller differs kind by
kind. The owner: "Sounds good, keep going" -- to a phone-sized labeller taught on their names.

For each picture of a named walk, a target on distill_modal.py's grid (TTW x TTH):
    where the owner named the shape   their kind (also kept apart as `owner`, the answer key for the judging)
    elsewhere                         THE TEACHER: CLIPSeg where it says a kind it is good at (grass, paving, bare ground,
                                      house, sky: 73-97% on the owner's pixels), the panoptic model where it says one IT is
                                      good at (rock, stairs, shrub, tree, house, equipment, vehicle); the two disagreeing,
                                      nothing (255). The teacher never says deck, pool, shed or hot tub: those come from the
                                      owner's names only, and a pixel the teacher would call house inside a shape the owner
                                      called deck is the owner's.
    `hold`                            a quarter of the walk's pictures in one run by time, never taught on, judged on
                                      (neighbouring pictures see the same things: a random quarter would flatter it).
Also the teachers' own score on the held-out owner pixels, at the same grid, for the yardstick.

    python scan/tools/yard_distill_prep.py data.npz <named walk dir>
Counts and shares only.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import names_score as N  # noqa: E402

KINDS = ["other", "grass", "mulch", "bare ground", "paving", "rock", "shrub", "tree", "house", "deck", "stairs", "fence",
         "pool", "hot tub", "shed", "sky", "movable"]
# names_score's fine kinds -> ours
TO = {"grass": "grass", "mulch": "mulch", "bare ground": "bare ground", "paving": "paving", "rock": "rock",
      "shrub": "shrub", "tree": "tree", "house": "house", "deck": "deck", "stairs": "stairs", "fence": "fence",
      "pool": "pool", "hot tub": "hot tub", "shed": "shed", "sky": "sky", "planter": "house", "retaining wall": "house",
      "pergola": "deck", "equipment": "movable", "vehicle": "movable", "furniture": "movable", "person": "movable",
      "water": "pool"}
CLIPSEG_GOOD = {"grass", "paving", "bare ground", "house", "sky"}
PANOPTIC_GOOD = {"rock", "stairs", "shrub", "tree", "house", "movable"}
TTW, TTH = 80, 176
HOLD = 0.25


def to_ours(m):
    """A names_score fine-kind map (0 nothing, 1 + FINE index) -> ours (255 nothing)."""
    lut = np.full(len(N.FINE) + 1, 255, np.uint8)
    for i, k in enumerate(N.FINE):
        if k in TO:
            lut[i + 1] = KINDS.index(TO[k])
    return lut[m]


def teacher(cs, pn):
    """CLIPSeg and the panoptic model, each trusted only on its own good kinds; where both speak and differ, nothing."""
    good_c = np.isin(cs, [KINDS.index(k) for k in CLIPSEG_GOOD])
    good_p = np.isin(pn, [KINDS.index(k) for k in PANOPTIC_GOOD])
    t = np.full(cs.shape, 255, np.uint8)
    t[good_c] = cs[good_c]
    t[good_p & ~good_c] = pn[good_p & ~good_c]
    t[good_c & good_p & (cs != pn)] = 255
    return t


def main():
    out, d = sys.argv[1], sys.argv[2]
    seg, names = json.load(open(os.path.join(d, "seg.json"))), json.load(open(os.path.join(d, "seg-names.json")))
    truth, shape_maps, _, _, n_named, _ = N.owner_maps(d, seg, names)
    pics = seg["pictures"]
    order = sorted(range(len(pics)), key=lambda p: pics[p]["t"])
    use = [p for p in order if shape_maps[p] is not None and os.path.exists(os.path.join(d, pics[p]["photo"]))]
    grid = (TTH, TTW)
    small = lambda m: N.resize_nearest(m, grid)
    z = np.load(os.path.join(d, "segments-masks.npz"), allow_pickle=False)
    pan = N.panoptic_maps(z, len(pics))
    import torch
    torch.set_num_threads(os.cpu_count() or 2)
    cs = N.clipseg_maps(d, [pics[p]["photo"] for p in use], [grid] * len(use), torch, print)
    # the held-out run: the quarter of the pictures, by time, holding the most owner pixels' share closest to a quarter
    named_px = np.array([(small(truth[p]) > 0).sum() for p in use], np.float64)
    k = max(1, int(round(HOLD * len(use))))
    best, s0 = 0, None
    for s in range(0, len(use) - k + 1):
        share = named_px[s:s + k].sum() / max(1, named_px.sum())
        if s0 is None or abs(share - HOLD) < s0:
            best, s0 = s, abs(share - HOLD)
    hold = np.zeros(len(use), np.uint8)
    hold[best:best + k] = 1
    blobs, target, owner = [], [], []
    yard = {"clipseg": [0, 0], "panoptic": [0, 0], "teacher": [0, 0]}
    for i, p in enumerate(use):
        own = to_ours(small(truth[p]))
        c = to_ours(cs[i])
        pn = to_ours(small(pan[p])) if pan is not None else np.full(grid, 255, np.uint8)
        t = teacher(c, pn)
        t = np.where(own != 255, own, t)
        # inside a shape the owner named with no kind we score (movable thing before it was mapped, and the like): nothing
        blobs.append(open(os.path.join(d, pics[p]["photo"]), "rb").read())
        target.append(t); owner.append(own)
        if hold[i]:
            on = own != 255
            for nm, m in (("clipseg", c), ("panoptic", pn), ("teacher", teacher(c, pn))):
                yard[nm][0] += int((m[on] == own[on]).sum()); yard[nm][1] += int(on.sum())
    T, O = np.stack(target), np.stack(owner)
    cuts = np.cumsum([0] + [len(b) for b in blobs]).astype(np.int64)
    np.savez(out, jpeg=np.frombuffer(b"".join(blobs), np.uint8), cuts=cuts, target=T, owner=O, hold=hold,
             walk=np.zeros(len(use), np.int64), kinds=json.dumps(KINDS), base_map=json.dumps({}),
             yardstick=json.dumps({nm: round(a / max(1, b), 3) for nm, (a, b) in yard.items()}))
    lab = T != 255
    share = ", ".join(f"{KINDS[j]} {100 * (T == j).sum() / max(1, lab.sum()):.1f}%" for j in range(len(KINDS)) if (T == j).any())
    own_share = ", ".join(f"{KINDS[j]} {int((O == j).sum()):,}" for j in range(len(KINDS)) if (O == j).any())
    print(f"Ready: {len(use)} pictures ({int(hold.sum())} held out, a run of the walk by time, holding {100 * named_px[hold == 1].sum() / max(1, named_px.sum()):.0f}% of the owner's pixels), {cuts[-1] / 1e6:.0f} MB of JPEG; {100 * lab.mean():.0f}% of the cells taught, {100 * (O != 255).mean():.0f}% by the owner's names.")
    print(f"  The lessons by kind: {share}.")
    print(f"  The owner's cells by kind: {own_share}.")
    print(f"  THE YARDSTICK, on the held-out pictures' owner cells (the share given the owner's kind): " + ", ".join(f"{nm} {100 * a / max(1, b):.0f}%" for nm, (a, b) in yard.items()) + ".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
