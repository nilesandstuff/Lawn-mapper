"""
Stage 1 of the plan: a small convolutional decoder over the WHOLE of what the
backbone says, trained to draw the visible lawn.

WHY THIS EXISTS. Every backbone row in train-detector.js goes through the same
narrow door: 1024 numbers a patch are squeezed through a FIXED RANDOM
projection to 32 (or 96), then a one-hidden-layer head of 16 units decides
each 15 cm cell on its own, from that cell's numbers and a few of its
neighbours'. Nothing in that path is learnt from the backbone's own
dimensions -- the projection is random, and a random 32 of 1024 directions
keep whatever they happen to keep. That is the ceiling H22 ran into, and it
is a ceiling on the reader, not on the eye.

So this reads all 1024, learns which of them matter, and answers with a few
patches of context on every side:

    1x1 conv 1024 -> 128    GELU       (which of the eye's directions matter)
    3x3 conv  128 ->  64    GELU       (what the neighbours say)
    3x3 conv   64 ->  32    GELU
    1x1 conv   32 ->   1               (lawn, as a logit)

A quarter of a million weights, which is small for a decoder and large for
thirty lawns, so it is regularised (weight decay, dropout on the first layer,
flips and quarter turns of every training grid) and trained for a fixed
number of epochs rather than to convergence.

LEAVE ONE OUT, THE SAME AS THE HEAD. One decoder per held-out lawn, trained
on the rest, answering the one it never saw. The answer is written as a
probability picture on the LABEL grid (see decoder_grid.py) and
train-detector.js scores it with the same arithmetic as every other row --
judgeFold -- so the number lands in the same table beside the same SAM line.

TRAINED ON GROUND SOMEBODY COULD SEE. The plan's first stage is the visible
lawn; what is under a canopy is stage 3's job (geometry) and is not something
a picture can teach. So cells the reviewer marked "inferred, not seen" carry
no weight in the loss -- dropped, not labelled 0, for the reason seenOnlyTwin
in train-detector.js gives: zero would teach "canopy means not lawn". Ground
outside the property line carries no weight either, and neither does the
padding past the photograph. The eye still SEES all of that; it is context,
it just is not graded.

SOFT TARGETS. A patch is about 1.4 m of ground and a label cell is 0.15 m, so
a patch on a lawn edge is partly lawn, and its target is that fraction rather
than a coin toss on where its centre fell.

    FEATURES=feats FRAMES=frames OUT=preds python3 tools/train_decoder.py

Reads `FEATURES/manifest.json` and the .f32 grids the extractor wrote, and
`FRAMES/<id>-labels.png` (red = traced lawn, green = inside the property
line, blue = inferred) which the frame dump writes beside each photograph.
Writes `OUT/<id>-pred.png` (grey, 255 = certainly lawn) and `OUT/manifest.json`.

FREE, and CPU only. MEASURED on four threads: an epoch over 31 lawns of
64x64x1024 is 1.3 s, so a fold at 30 epochs is about 40 s and 32 folds are
about 21 minutes; a GitHub runner is roughly that. The 1x1 layer over 1024
channels is nearly all of it, and batching lawns did not change it.
"""

import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

from decoder_grid import box_targets, to_photo

EPOCHS = int(os.environ.get("EPOCHS", "30"))
SEED = int(os.environ.get("SEED", "7"))
LR = float(os.environ.get("LR", "1e-3"))
WEIGHT_DECAY = float(os.environ.get("WEIGHT_DECAY", "1e-2"))
DROPOUT = float(os.environ.get("DROPOUT", "0.1"))
BATCH = int(os.environ.get("BATCH", "4"))
# A directory of <id>-mask.png from tools/tree-canopy.py, or unset.
CANOPY = os.environ.get("CANOPY", "")
# "lawn": canopy is unseen only where the tracer drew lawn. "all": everywhere.
CANOPY_MODE = "all" if os.environ.get("CANOPY_MODE", "lawn") == "all" else "lawn"
# How many lawns to hold out, for a quick look. Unset means every lawn.
LIMIT = int(os.environ.get("LIMIT", "0") or 0)
# THE FUSED-INPUTS TEST (tools/fuse_layers.py): seven more numbers a patch
# from the lidar (FUSE_LIDAR=dir of <id>.npz from lidar_frame.py), NAIP's
# near-infrared (FUSE_NAIP=dir of <id>-naip.png from naip_bands.py) and the
# tree model's mask (CANOPY). Off unless FUSE=1.
FUSE = os.environ.get("FUSE") == "1"
FUSE_LIDAR = os.environ.get("FUSE_LIDAR", "")
FUSE_NAIP = os.environ.get("FUSE_NAIP", "")
# The tree model's canopy as an input channel. OFF for the "canopy on lawn"
# decoder (H48): that decoder grades canopy only where the tracer drew no
# lawn, so every graded canopy cell is not-lawn, and a canopy channel let it
# learn "canopy = not lawn" outright (inferred 34.5 -> 44.6%). The channel
# stays in the grid as zeros so every decoder reads the same shape.
FUSE_CANOPY = os.environ.get("FUSE_CANOPY", "1") == "1"
# Modality dropout: the chance, per lawn per step, that a source is hidden
# as though it were missing -- so the decoder cannot lean on the lidar where
# it is stale, and has met "no lidar here" before it meets it on a lot.
DROP_LIDAR = float(os.environ.get("DROP_LIDAR", "0.3"))
DROP_NAIP = float(os.environ.get("DROP_NAIP", "0.2"))


class Decoder(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(dim, 128, 1), nn.GELU(), nn.Dropout2d(DROPOUT),
            nn.Conv2d(128, 64, 3, padding=1), nn.GELU(),
            nn.Conv2d(64, 32, 3, padding=1), nn.GELU(),
            nn.Conv2d(32, 1, 1),
        )

    def forward(self, x):
        return self.net(x)


def read_lawn(feats, frames, stem, shape):
    """One lawn: its patch grid, and its targets and weights on that grid."""
    grid = np.fromfile(os.path.join(feats, f"{stem}.f32"), dtype=np.float32)
    gh, gw, dim = shape["gridH"], shape["gridW"], shape["dim"]
    if grid.size != gh * gw * dim:
        raise SystemExit(f"{stem}.f32 holds {grid.size} numbers, not {gh}x{gw}x{dim}")
    grid = grid.reshape(gh, gw, dim)

    labels = np.asarray(Image.open(os.path.join(frames, f"{stem}-labels.png")).convert("RGB"))
    truth = labels[:, :, 0] >= 128
    within = labels[:, :, 1] >= 128
    inferred = labels[:, :, 2] >= 128
    cells_h, cells_w = truth.shape
    cx, cy = float(shape.get("coverX") or 1.0), float(shape.get("coverY") or 1.0)

    # THE CANOPY IS UNSEEN GROUND TOO, when the run brought the tree model's
    # mask (CANOPY=dir of <id>-mask.png from tools/tree-canopy.py). It is a
    # better record of what the camera could not see than the hand-drawn
    # marks, and it means the same thing here: no weight, never a zero. A
    # zero would teach "canopy means not lawn", which is stage 3's question
    # and the wrong answer to it.
    #
    # ONLY OVER TRACED LAWN, unless CANOPY_MODE=all. Making every canopy
    # cell don't-care (H27) took away the decoder's only weighted examples
    # of woods -- the tracer had looked at them and drawn nothing -- and the
    # lawn's edge crept into the trees. Canopy the tracer left out stays a
    # weighted zero; canopy over lawn they drew (marked inferred or not) is
    # the case the mask is here to catch.
    canopy = False
    mask_file = os.path.join(CANOPY, f"{stem}-mask.png") if CANOPY else None
    if mask_file and os.path.exists(mask_file):
        can = Image.open(mask_file).convert("L").resize((cells_w, cells_h), Image.NEAREST)
        can = np.asarray(can) >= 128
        inferred = inferred | (can if CANOPY_MODE == "all" else (can & truth))
        canopy = True

    extra = None
    sources = []
    if FUSE:
        from fuse_layers import extra_channels, ndvi_from_png
        lidar = None
        lf = os.path.join(FUSE_LIDAR, f"{stem}.npz") if FUSE_LIDAR else None
        if lf and os.path.exists(lf):
            z = np.load(lf)
            lidar = {k: z[k] for k in ("height", "n_ground", "n_all")}
            sources.append("lidar")
        ndvi = valid = None
        nf = os.path.join(FUSE_NAIP, f"{stem}-naip.png") if FUSE_NAIP else None
        if nf and os.path.exists(nf):
            ndvi, valid = ndvi_from_png(Image.open(nf).convert("RGB"))
            if valid.any():
                sources.append("naip")
            else:
                ndvi = valid = None
        can_in = None
        if FUSE_CANOPY and mask_file and os.path.exists(mask_file):
            can_in = np.asarray(Image.open(mask_file).convert("L")) >= 128
            sources.append("canopy")
        extra = extra_channels(gw, gh, cx, cy, lidar=lidar, ndvi=ndvi, ndvi_valid=valid, canopy=can_in)
        grid = np.concatenate([grid, extra.transpose(1, 2, 0)], axis=2)

    target, inside = box_targets(truth, gw, gh, cx, cy)
    allowed, _ = box_targets(within, gw, gh, cx, cy)
    unseen, _ = box_targets(inferred, gw, gh, cx, cy)
    # Graded where it is on the photograph, inside the line, and seen.
    weight = inside * allowed * (1.0 - unseen)

    return {
        "id": stem,
        "x": torch.from_numpy(np.ascontiguousarray(grid.transpose(2, 0, 1))),  # (dim, gh, gw)
        "t": torch.from_numpy(target)[None],
        "w": torch.from_numpy(weight)[None],
        "cells": (cells_w, cells_h),
        "cover": (cx, cy),
        "canopy": canopy,
        "sources": sources,
    }


def standardiser(lawns):
    """Per-channel mean and sd over the training lawns' patches.

    Over every patch, padding included: the padding is reflected photograph,
    so it has the same statistics, and the held-out lawn is not in the sum.
    """
    total = None
    total_sq = None
    n = 0.0
    for L in lawns:
        x = L["x"]
        s = x.sum(dim=(1, 2))
        s2 = (x * x).sum(dim=(1, 2))
        total = s if total is None else total + s
        total_sq = s2 if total_sq is None else total_sq + s2
        n += float(x.shape[1] * x.shape[2])
    mean = total / n
    var = total_sq / n - mean * mean
    sd = torch.sqrt(torch.clamp(var, min=1e-8))
    return mean[:, None, None], sd[:, None, None]


def dihedral(x, t, w, k, flip):
    """The same quarter turn and flip on the features and their labels."""
    if flip:
        x, t, w = x.flip(-1), t.flip(-1), w.flip(-1)
    if k:
        x, t, w = torch.rot90(x, k, (-2, -1)), torch.rot90(t, k, (-2, -1)), torch.rot90(w, k, (-2, -1))
    return x, t, w


def with_dropout(x, rng):
    """The lawn's patches, with a fused source hidden now and then (FUSE only)."""
    if not FUSE:
        return x
    from fuse_layers import CHANNELS, drop_sources
    k = len(CHANNELS)
    e = drop_sources(x[-k:].numpy(), rng, DROP_LIDAR, DROP_NAIP)
    return torch.cat([x[:-k], torch.from_numpy(e)], dim=0)


def train_one(train, dim, seed):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    mean, sd = standardiser(train)
    model = Decoder(dim)

    # Lawns of one shape go through together: every lot squeezed whole is
    # the same 64x64 grid. (Measured: batches of 1, 4 and 8 cost the same on
    # a CPU, so this is for the optimiser's sake -- a step over four lawns is
    # a steadier gradient than a step over one -- not for speed.) Windowed
    # lawns come in their own shapes and simply make smaller batches.
    by_shape = {}
    for i, L in enumerate(train):
        by_shape.setdefault(tuple(L["x"].shape[1:]), []).append(i)
    steps_per_epoch = sum(-(-len(v) // BATCH) for v in by_shape.values())

    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS * steps_per_epoch, eta_min=LR / 10)

    # Balance lawn against not-lawn the way the head does, from the weighted
    # soft targets of the training set.
    pos = sum(float((L["w"] * L["t"]).sum()) for L in train)
    neg = sum(float((L["w"] * (1 - L["t"])).sum()) for L in train)
    pos_weight = torch.tensor(neg / max(pos, 1e-6))

    last = 0.0
    for epoch in range(EPOCHS):
        model.train()
        batches = []
        for members in by_shape.values():
            order = rng.permutation(members)
            batches += [order[k:k + BATCH] for k in range(0, len(order), BATCH)]
        rng.shuffle(batches)
        loss_sum, w_sum = 0.0, 0.0
        for batch in batches:
            x = torch.stack([(with_dropout(train[i]["x"], rng) - mean) / sd for i in batch])
            t = torch.stack([train[i]["t"] for i in batch])
            w = torch.stack([train[i]["w"] for i in batch])
            x, t, w = dihedral(x, t, w, int(rng.integers(4)), bool(rng.integers(2)))
            logits = model(x)
            loss = F.binary_cross_entropy_with_logits(logits, t, weight=w, pos_weight=pos_weight, reduction="sum")
            denom = w.sum().clamp(min=1e-6)
            opt.zero_grad()
            (loss / denom).backward()
            opt.step()
            sched.step()
            loss_sum += loss.item()
            w_sum += float(denom)
        last = loss_sum / max(w_sum, 1e-6)
    return model, mean, sd, last


def answer(model, mean, sd, L):
    model.eval()
    with torch.no_grad():
        x = (L["x"] - mean) / sd
        prob = torch.sigmoid(model(x[None])[0, 0]).numpy()
    w, h = L["cells"]
    return to_photo(prob, w, h, *L["cover"])


def main():
    feats = os.environ.get("FEATURES")
    frames = os.environ.get("FRAMES")
    out = os.environ.get("OUT")
    if not feats or not frames or not out:
        raise SystemExit("FEATURES, FRAMES and OUT are required")
    os.makedirs(out, exist_ok=True)

    with open(os.path.join(feats, "manifest.json")) as f:
        manifest = json.load(f)
    stems = sorted(manifest["images"])
    stems = [s for s in stems if os.path.exists(os.path.join(frames, f"{s}-labels.png"))]
    if len(stems) < 3:
        raise SystemExit(f"only {len(stems)} lawns have both features and labels; three is the floor")

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    started = time.time()
    lawns = [read_lawn(feats, frames, s, manifest["images"][s]) for s in stems]
    dim = lawns[0]["x"].shape[0]
    params = sum(p.numel() for p in Decoder(dim).parameters())
    print(f"{len(lawns)} lawns, {dim} numbers a patch, grids "
          f"{min(L['x'].shape[2] for L in lawns)}-{max(L['x'].shape[2] for L in lawns)} patches across")
    print(f"decoder of {params:,} weights, {EPOCHS} epochs a fold, seed {SEED}", flush=True)
    if CANOPY:
        with_canopy = sum(1 for L in lawns if L["canopy"])
        print(f"canopy from {CANOPY} treated as unseen ground on {with_canopy} of {len(lawns)} lawns"
              + (" (every canopy cell)" if CANOPY_MODE == "all" else " (only over traced lawn)")
              + ("" if with_canopy else " -- no masks found; was the canopy step run?"), flush=True)

    if FUSE:
        from fuse_layers import CHANNELS
        n_l = sum(1 for L in lawns if "lidar" in L["sources"])
        n_n = sum(1 for L in lawns if "naip" in L["sources"])
        n_c = sum(1 for L in lawns if "canopy" in L["sources"])
        print(f"FUSED INPUTS: {len(CHANNELS)} more numbers a patch ({', '.join(CHANNELS)}); "
              f"lidar on {n_l}, NAIP on {n_n}, tree canopy on {n_c} of {len(lawns)} lawns; "
              f"dropout lidar {DROP_LIDAR:g}, NAIP {DROP_NAIP:g}", flush=True)

    held_out = lawns if not LIMIT else lawns[:LIMIT]
    for n, held in enumerate(held_out):
        t0 = time.time()
        train = [L for L in lawns if L is not held]
        model, mean, sd, loss = train_one(train, dim, SEED + n)
        prob = answer(model, mean, sd, held)
        img = Image.fromarray(np.clip(np.round(prob * 255), 0, 255).astype(np.uint8), mode="L")
        img.save(os.path.join(out, f"{held['id']}-pred.png"))
        # How much of the photograph it called lawn, so a fold that collapsed
        # to one answer everywhere shows up here rather than in the table.
        print(f"  {n + 1}/{len(held_out)}  {held['id'][:28]:28}  train loss {loss:.3f}  "
              f"lit {100 * float((prob > 0.5).mean()):4.1f}% of the picture  {time.time() - t0:.0f}s",
              flush=True)

    total = time.time() - started
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump({
            "model": manifest.get("model"), "size": manifest.get("size"),
            "dim": dim, "params": params, "epochs": EPOCHS, "seed": SEED,
            "lr": LR, "weightDecay": WEIGHT_DECAY, "dropout": DROPOUT,
            "seenOnly": True, "lawns": len(lawns), "folds": len(held_out),
            "canopyUnseen": sum(1 for L in lawns if L["canopy"]),
            "canopyMode": CANOPY_MODE if CANOPY else None,
            "fused": ({"lidar": sum(1 for L in lawns if "lidar" in L["sources"]),
                       "naip": sum(1 for L in lawns if "naip" in L["sources"]),
                       "canopy": sum(1 for L in lawns if "canopy" in L["sources"]),
                       "canopyInput": FUSE_CANOPY,
                       "dropLidar": DROP_LIDAR, "dropNaip": DROP_NAIP} if FUSE else None),
            "seconds": round(total),
        }, f)
    print(f"\n{len(held_out)} folds in {total:.0f}s ({total / len(held_out):.0f}s each). "
          f"Answers in {out}/; score them with PREDICTIONS_DIR={out}.")


if __name__ == "__main__":
    sys.exit(main())
