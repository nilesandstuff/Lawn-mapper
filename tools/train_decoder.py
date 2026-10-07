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
# Folds; unset or 0 means leave-one-out (see main). "place" is grouped
# folds: lots within NEIGHBOUR_KM of each other are always held out together.
FOLDS_RAW = (os.environ.get("FOLDS", "") or "").strip()
FOLDS = int(FOLDS_RAW) if FOLDS_RAW.isdigit() else 0
BY_PLACE = FOLDS_RAW == "place"
PLACE_FOLDS = int(os.environ.get("PLACE_FOLDS", "15") or 15)
NEIGHBOUR_KM = float(os.environ.get("NEIGHBOUR_KM", "2") or 2)
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
# FUSE_RETURNS=dir of tools/tree_lidar.py's <id>.json + <id>.f32 (1 m cells):
# four more fused numbers a patch, the share of last returns reaching the
# ground, the share of points from split pulses, the first-to-last spread,
# and a flag (owner, 2026-10-05; H73 found the first two tell an evergreen).
FUSE_RETURNS = os.environ.get("FUSE_RETURNS", "")

# TAUGHT UNDER TREES (owner, 2026-10-05: "simply letting scale Mae figure out
# the scenarios where there's likely to be grass, which it learns from the
# markings on lawn maps we already have"). Without it, lawn the tracer marked
# inferred and canopy over traced lawn carry NO weight, so the decoder is
# never shown what is under a tree and stage 3's rules decide there. With it
# they are graded as what the tracer said: inferred lawn is lawn; canopy the
# tracer drew no lawn under stays not-lawn (as it already was). Not-lawn
# example frames keep their unseen canopy. The row to read is the decoder
# ALONE, since stage 3 replaces its answer under every canopy cell.
UNDER_TREES = os.environ.get("UNDER_TREES") == "1"

# LIDAR THAT DISAGREES WITH THE PHOTO, HIDDEN IN TRAINING (owner, 2026-10-06:
# "filtering out bad lidar maps"). LIDAR_DISTRUST = tools/lidar_ground_check.py's
# JSON: a lot whose visible lawn stands more than DISTRUST_M over the lidar's
# ground (trees since cut, a building since built, a misregistered survey --
# H76) trains with its lidar zeroed, as a lot with none reads. The check uses
# the tracing, so it is for TRAINING ONLY: a held-out lot is answered with its
# lidar as it is, which is all a new address would have.
# S21, WHERE THE LIVE MODEL WAS CORRECTED (owner, 2026-10-06). A lot whose
# outline the live release drew carries it as <id>-detected.png (the dump's
# CORRECTIONS). Cells where the person's finished lawn disagrees with it --
# what the model got wrong -- weigh 1 + CORRECTIONS_WEIGHT times as much.
# Every other cell, and every lot without one, is unchanged.
CORRECTIONS_WEIGHT = float(os.environ.get("CORRECTIONS_WEIGHT", "0") or 0)
# The not-lawn example frames (pond maps) left out of this decoder's training
# even when the run dumped them -- the arm a not_lawn run compares against.
SKIP_EXAMPLES = os.environ.get("SKIP_EXAMPLES") == "1"

LIDAR_DISTRUST = os.environ.get("LIDAR_DISTRUST", "")
DISTRUST_M = float(os.environ.get("DISTRUST_M", "0.5"))
_DISTRUSTED = None


def distrusted(stem):
    global _DISTRUSTED
    if _DISTRUSTED is None:
        _DISTRUSTED = set()
        if LIDAR_DISTRUST and os.path.exists(LIDAR_DISTRUST):
            with open(LIDAR_DISTRUST) as f:
                for k, r in json.load(f).items():
                    if r.get("median_m") is not None and abs(r["median_m"]) > DISTRUST_M:
                        _DISTRUSTED.add(k)
    return stem in _DISTRUSTED or stem.replace("/", "_") in _DISTRUSTED
# Modality dropout: the chance, per lawn per step, that a source is hidden
# as though it were missing -- so the decoder cannot lean on the lidar where
# it is stale, and has met "no lidar here" before it meets it on a lot.
DROP_LIDAR = float(os.environ.get("DROP_LIDAR", "0.3"))
DROP_NAIP = float(os.environ.get("DROP_NAIP", "0.2"))
# BOTH SCALES (workflow 14 `windows: both`, 2026-09-28): FEATURES are the
# 6 cm blocks, and FEATURES_WHOLE the same lots squeezed whole into one pass.
# H55: the blocks and the whole-lot read are each far better on DIFFERENT
# lots, by tens of points, and not by lot size -- so neither replaces the
# other; the decoder is given both at every cell and learns which to trust.
# The whole-lot grid is resampled onto the block grid (decoder_grid.onto_grid)
# and its numbers are stacked beside the blocks' at each cell.
FEATURES_WHOLE = os.environ.get("FEATURES_WHOLE", "")
WHOLE_MANIFEST = None
# S19, THE EDGE REFINER (tools/edge_refine.py; owner go-ahead 2026-09-29): a
# small net on the 15 cm scoring grid that sees the photograph and the
# decoder's answer and re-draws the edge, trained together with the decoder.
# Off unless REFINE=1; FINE_WEIGHT is its loss beside the decoder's own.
REFINE = os.environ.get("REFINE") == "1"
# Decoders per fold whose answers are averaged (1 = the usual single one).
ENSEMBLE = max(1, int(os.environ.get("ENSEMBLE") or "1"))
FINE_WEIGHT = float(os.environ.get("FINE_WEIGHT", "1.0"))
# THE OWNER'S NOT-LAWN TRACES (tinker mode, 2026-09-29): FRAMES/<id>-notlawn.png,
# written by the frame dump when NOT_LAWN=1. Where one is set, the cell is
# graded -- even outside the property line -- and graded NOT lawn. Canopy over
# it stays unseen, for the reason the examples gave: the photo shows leaves
# there, not the parking lot.
NOT_LAWN = os.environ.get("NOT_LAWN") == "1"


# A GPU WHEN THERE IS ONE (Modal, 2026-09-28); the CPU runner is unchanged.
# The lawns stay in memory on the CPU and each batch is moved over, so a
# corpus bigger than the card still fits.
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


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

    def parts(self, x):
        """The last hidden layer (32 numbers a patch) and the answer from it."""
        hidden = self.net[:-1](x)
        return hidden, self.net[-1](hidden)


def read_returns(stem):
    """tree_lidar.py's layers for one frame, as {name: 2-D array}, or None."""
    safe = stem.replace("/", "_")
    meta_path = os.path.join(FUSE_RETURNS, f"{safe}.json")
    if not os.path.exists(meta_path):
        return None
    with open(meta_path) as f:
        meta = json.load(f)
    gw, gh, names = meta["gw"], meta["gh"], meta["layers"]
    raw = np.fromfile(os.path.join(FUSE_RETURNS, f"{safe}.f32"), dtype="<f4")
    if raw.size != len(names) * gw * gh:
        return None
    return {k: raw[i * gw * gh:(i + 1) * gw * gh].reshape(gh, gw) for i, k in enumerate(names)}


def is_example(stem):
    """A not-lawn example (owner-reviewed public outline, 2026-09-28): trained
    on, never held out, never scored. Ids look like 'lng,lat:example:water-001'."""
    return ":example:" in stem


def read_lawn(feats, frames, stem, shape):
    """One lawn: its patch grid, and its targets and weights on that grid."""
    grid = np.fromfile(os.path.join(feats, f"{stem}.f32"), dtype=np.float32)
    gh, gw, dim = shape["gridH"], shape["gridW"], shape["dim"]
    if grid.size != gh * gw * dim:
        raise SystemExit(f"{stem}.f32 holds {grid.size} numbers, not {gh}x{gw}x{dim}")
    grid = grid.reshape(gh, gw, dim)
    cx, cy = float(shape.get("coverX") or 1.0), float(shape.get("coverY") or 1.0)

    if FEATURES_WHOLE:
        from decoder_grid import onto_grid
        ws = WHOLE_MANIFEST["images"].get(stem)
        if ws is None:
            raise SystemExit(f"{stem} has block features but no whole-lot features in {FEATURES_WHOLE}")
        whole = np.fromfile(os.path.join(FEATURES_WHOLE, f"{stem}.f32"), dtype=np.float32)
        whole = whole.reshape(ws["gridH"], ws["gridW"], ws["dim"])
        whole = onto_grid(whole, float(ws.get("coverX") or 1.0), float(ws.get("coverY") or 1.0), gw, gh, cx, cy)
        grid = np.concatenate([grid, whole], axis=2)

    labels = np.asarray(Image.open(os.path.join(frames, f"{stem}-labels.png")).convert("RGB"))
    truth = labels[:, :, 0] >= 128
    within = labels[:, :, 1] >= 128
    inferred = labels[:, :, 2] >= 128
    cells_h, cells_w = truth.shape

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
        # A NOT-LAWN EXAMPLE (tools/not-lawn-examples.js frames): the part of
        # an outline under the tree model's canopy is unseen too (owner,
        # 2026-09-28) -- the photo shows leaves there, not the pavement or
        # the pond, and teaching "leaves are not lawn" is stage 3's question.
        if is_example(stem):
            inferred = inferred | can
        else:
            inferred = inferred | (can if CANOPY_MODE == "all" else (can & truth))
        canopy = True

    if NOT_LAWN:
        nl_file = os.path.join(frames, f"{stem}-notlawn.png")
        if os.path.exists(nl_file):
            nl = np.asarray(Image.open(nl_file).convert("L").resize((cells_w, cells_h), Image.NEAREST)) >= 128
            truth = truth & ~nl
            within = within | nl

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
        returns = read_returns(stem) if FUSE_RETURNS else None
        if returns is not None:
            sources.append("returns")
        extra = extra_channels(gw, gh, cx, cy, lidar=lidar, ndvi=ndvi, ndvi_valid=valid, canopy=can_in,
                               returns=returns, with_returns=bool(FUSE_RETURNS))
        grid = np.concatenate([grid, extra.transpose(1, 2, 0)], axis=2)

    target, inside = box_targets(truth, gw, gh, cx, cy)
    allowed, _ = box_targets(within, gw, gh, cx, cy)
    unseen, _ = box_targets(inferred, gw, gh, cx, cy)
    # Graded where it is on the photograph, inside the line, and seen --
    # or, taught under trees, unseen too (not on an example frame).
    taught = UNDER_TREES and not is_example(stem)
    weight = inside * allowed * (1.0 if taught else (1.0 - unseen))
    wrong = None
    if CORRECTIONS_WEIGHT and not is_example(stem):
        df = os.path.join(frames, f"{stem}-detected.png")
        if os.path.exists(df):
            det = np.asarray(Image.open(df).convert("L").resize((cells_w, cells_h), Image.NEAREST)) >= 128
            wrong = (det != truth) & within
            err, _ = box_targets(wrong, gw, gh, cx, cy)
            weight = weight * (1.0 + CORRECTIONS_WEIGHT * err)

    L = {
        "id": stem,
        "x": torch.from_numpy(np.ascontiguousarray(grid.transpose(2, 0, 1))),  # (dim, gh, gw)
        "t": torch.from_numpy(target)[None],
        "w": torch.from_numpy(weight)[None],
        "cells": (cells_w, cells_h),
        "cover": (cx, cy),
        "canopy": canopy,
        "sources": sources,
        "corrected": wrong is not None,
        "distrust": FUSE and "lidar" in sources and distrusted(stem),
    }
    if REFINE and not is_example(stem):
        # THE REFINER'S VIEW, on the scoring grid itself: the photograph the
        # features came from, box-averaged onto the label cells (it is the
        # same frame, at ~10 cm against 15), and the trace cell by cell --
        # graded where the decoder is graded: inside the line and seen.
        from edge_refine import edge_cells
        photo = Image.open(os.path.join(frames, f"{stem}.png")).convert("RGB")
        L["rgb"] = np.asarray(photo.resize((cells_w, cells_h), Image.BOX))
        fine_w = (within if taught else (within & ~inferred)).astype(np.float32)
        if wrong is not None:
            fine_w = fine_w * (1.0 + CORRECTIONS_WEIGHT * wrong)
        L["fine_t"] = torch.from_numpy(truth.astype(np.float32))[None]
        L["fine_w"] = torch.from_numpy(fine_w)[None]
        L["edge_idx"], L["graded_idx"] = edge_cells(truth, fine_w)
    return L


CROP_MARGIN = 4


def crop_to_graded(L, margin=CROP_MARGIN):
    """An example cut down to its graded cells plus `margin` on every side.

    Examples are trained on and never answered, and only their kept outlines
    carry weight -- a pond in a 100 m frame is mostly weight-0 photograph that
    the decoder was convolving for nothing (2026-09-28: ~140 examples made
    each decoder 3x slower). Four cells is more than the decoder's reach (two
    3x3 layers), so what it says on a graded cell is what it would have said
    on the whole grid. The standardiser does see less of each example.
    """
    w = L["w"][0]
    rows = torch.nonzero(w.sum(dim=1) > 0).flatten()
    cols = torch.nonzero(w.sum(dim=0) > 0).flatten()
    if not len(rows) or not len(cols):
        return L
    y0, y1 = max(0, int(rows[0]) - margin), min(w.shape[0], int(rows[-1]) + 1 + margin)
    x0, x1 = max(0, int(cols[0]) - margin), min(w.shape[1], int(cols[-1]) + 1 + margin)
    out = dict(L)
    for k in ("x", "t", "w"):
        out[k] = L[k][:, y0:y1, x0:x1].contiguous()
    return out


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


def with_dropout(x, rng, distrust=False):
    """The lawn's patches, with a fused source hidden now and then (FUSE only),
    and the lidar always hidden on a lot whose lidar disagrees with its photo."""
    if not FUSE:
        return x
    from fuse_layers import CHANNELS, RETURN_CHANNELS, drop_sources
    k = len(CHANNELS) + (len(RETURN_CHANNELS) if FUSE_RETURNS else 0)
    e = drop_sources(x[-k:].numpy(), rng, 1.0 if distrust else DROP_LIDAR, DROP_NAIP)
    return torch.cat([x[:-k], torch.from_numpy(e)], dim=0)


def undo_dihedral(x, k, flip):
    """dihedral's turn and flip taken back off (it flips first, then turns)."""
    if k:
        x = torch.rot90(x, -k, (-2, -1))
    if flip:
        x = x.flip(-1)
    return x


def refine_loss(refiner, hidden, logits, members, train, rng, pos_weight):
    """The refiner's loss on edge-heavy squares of each lawn's scoring grid.

    `hidden` and `logits` are the decoder's, for the lawns `members`, already
    turned back to each lawn's own orientation; each square is then given a
    turn and flip of its own, photograph, answer and trace together.
    """
    from edge_refine import pick_crops, rgb_tensor, sampling_grid, stretch
    by_shape = {}
    for j, i in enumerate(members):
        L = train[i]
        if "fine_t" not in L:
            continue
        cw, ch = L["cells"]
        gh, gw = logits.shape[-2:]
        for x0, y0, w, h in pick_crops(L, rng):
            sg = sampling_grid(cw, ch, gw, gh, *L["cover"], x0=x0, y0=y0, w=w, h=h)
            coarse_h = stretch(hidden[j:j + 1], sg)
            coarse_l = stretch(logits[j:j + 1], sg)
            rgb = rgb_tensor(L["rgb"][y0:y0 + h, x0:x0 + w])[None].to(DEVICE)
            t = L["fine_t"][None, :, y0:y0 + h, x0:x0 + w].to(DEVICE)
            wt = L["fine_w"][None, :, y0:y0 + h, x0:x0 + w].to(DEVICE)
            k, flip = int(rng.integers(4)), bool(rng.integers(2))
            parts = []
            for a in (rgb, coarse_l, coarse_h, t, wt):
                a = a.flip(-1) if flip else a
                parts.append(torch.rot90(a, k, (-2, -1)) if k else a)
            key = tuple(parts[0].shape[-2:])
            by_shape.setdefault(key, []).append(parts)
    loss, denom = 0.0, 0.0
    for group in by_shape.values():
        rgb, cl, chd, t, wt = (torch.cat([g[n] for g in group]) for n in range(5))
        out = refiner(rgb, cl, chd)
        loss = loss + F.binary_cross_entropy_with_logits(out, t, weight=wt, pos_weight=pos_weight, reduction="sum")
        denom += float(wt.sum())
    return loss, denom


def train_one(train, dim, seed):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    mean, sd = standardiser(train)
    mean, sd = mean.to(DEVICE), sd.to(DEVICE)
    model = Decoder(dim).to(DEVICE)
    refiner = None
    if REFINE:
        from edge_refine import Refiner
        refiner = Refiner().to(DEVICE)

    # Lawns of one shape go through together: every lot squeezed whole is
    # the same 64x64 grid. (Measured: batches of 1, 4 and 8 cost the same on
    # a CPU, so this is for the optimiser's sake -- a step over four lawns is
    # a steadier gradient than a step over one -- not for speed.) Windowed
    # lawns come in their own shapes and simply make smaller batches.
    by_shape = {}
    for i, L in enumerate(train):
        by_shape.setdefault(tuple(L["x"].shape[1:]), []).append(i)
    steps_per_epoch = sum(-(-len(v) // BATCH) for v in by_shape.values())

    params = list(model.parameters()) + (list(refiner.parameters()) if refiner else [])
    opt = torch.optim.AdamW(params, lr=LR, weight_decay=WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS * steps_per_epoch, eta_min=LR / 10)

    # Balance lawn against not-lawn the way the head does, from the weighted
    # soft targets of the training set.
    pos = sum(float((L["w"] * L["t"]).sum()) for L in train)
    neg = sum(float((L["w"] * (1 - L["t"])).sum()) for L in train)
    pos_weight = torch.tensor(neg / max(pos, 1e-6), device=DEVICE)
    if REFINE:
        fpos = sum(float((L["fine_w"] * L["fine_t"]).sum()) for L in train if "fine_t" in L)
        fneg = sum(float((L["fine_w"] * (1 - L["fine_t"])).sum()) for L in train if "fine_t" in L)
        fine_pos_weight = torch.tensor(fneg / max(fpos, 1e-6), device=DEVICE)

    last = 0.0
    for epoch in range(EPOCHS):
        model.train()
        if refiner:
            refiner.train()
        batches = []
        for members in by_shape.values():
            order = rng.permutation(members)
            batches += [order[k:k + BATCH] for k in range(0, len(order), BATCH)]
        rng.shuffle(batches)
        loss_sum, w_sum = 0.0, 0.0
        for batch in batches:
            x = torch.stack([with_dropout(train[i]["x"], rng, train[i].get("distrust")) for i in batch]).to(DEVICE)
            x = (x - mean) / sd
            t = torch.stack([train[i]["t"] for i in batch]).to(DEVICE)
            w = torch.stack([train[i]["w"] for i in batch]).to(DEVICE)
            k, flip = int(rng.integers(4)), bool(rng.integers(2))
            x, t, w = dihedral(x, t, w, k, flip)
            if refiner:
                hidden, logits = model.parts(x)
            else:
                logits = model(x)
            loss = F.binary_cross_entropy_with_logits(logits, t, weight=w, pos_weight=pos_weight, reduction="sum")
            denom = w.sum().clamp(min=1e-6)
            total = loss / denom
            if refiner:
                fine, fine_denom = refine_loss(refiner, undo_dihedral(hidden, k, flip), undo_dihedral(logits, k, flip),
                                               batch, train, rng, fine_pos_weight)
                if fine_denom > 0:
                    total = total + FINE_WEIGHT * fine / fine_denom
            opt.zero_grad()
            total.backward()
            opt.step()
            sched.step()
            loss_sum += loss.item()
            w_sum += float(denom)
        last = loss_sum / max(w_sum, 1e-6)
    if refiner:
        model.refiner = refiner
    return model, mean, sd, last


def answer(model, mean, sd, L):
    model.eval()
    w, h = L["cells"]
    refiner = getattr(model, "refiner", None)
    with torch.no_grad():
        x = (L["x"].to(DEVICE) - mean) / sd
        if refiner is None:
            prob = torch.sigmoid(model(x[None])[0, 0]).cpu().numpy()
            return to_photo(prob, w, h, *L["cover"])
        # Refined: the decoder read onto every scoring cell, and the refiner's
        # answer there. Already on the label grid, so no to_photo.
        from edge_refine import rgb_tensor, sampling_grid, stretch
        refiner.eval()
        hidden, logits = model.parts(x[None])
        sg = sampling_grid(w, h, logits.shape[-1], logits.shape[-2], *L["cover"])
        out = refiner(rgb_tensor(L["rgb"])[None].to(DEVICE), stretch(logits, sg), stretch(hidden, sg))
        return torch.sigmoid(out[0, 0]).cpu().numpy()


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

    global WHOLE_MANIFEST
    if FEATURES_WHOLE:
        with open(os.path.join(FEATURES_WHOLE, "manifest.json")) as f:
            WHOLE_MANIFEST = json.load(f)
        print(f"BOTH SCALES: {manifest.get('tileMpp') or '?'} m blocks from {feats} plus the whole-lot "
              f"pass from {FEATURES_WHOLE}, stacked at every block cell", flush=True)

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    started = time.time()
    lawns = [read_lawn(feats, frames, s, manifest["images"][s]) for s in stems]
    dim = lawns[0]["x"].shape[0]
    params = sum(p.numel() for p in Decoder(dim).parameters())
    if REFINE:
        from edge_refine import Refiner
        ref_params = sum(p.numel() for p in Refiner().parameters())
        params += ref_params
        print(f"EDGE REFINER (S19, reach {os.environ.get('REFINE_REACH') or 'normal'}{', photo edges' if os.environ.get('REFINE_EDGES') == '1' else ''}{', gated by the decoder doubt' if os.environ.get('REFINE_GATE') == '1' else ''}): {ref_params:,} more weights on the 15 cm grid, trained with the decoder "
              f"(fine loss x{FINE_WEIGHT:g})", flush=True)
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
        if FUSE_RETURNS:
            n_r = sum(1 for L in lawns if "returns" in L["sources"])
            print(f"LIDAR BY RETURN: 4 more numbers a patch (penetration, multi, spread, has_returns) "
                  f"on {n_r} of {len(lawns)} lawns, hidden with the lidar", flush=True)
    if CORRECTIONS_WEIGHT:
        n_c = sum(1 for L in lawns if L.get("corrected"))
        print(f"CORRECTIONS WEIGHTED (S21): on {n_c} lots the live model's own outline is here; cells where the "
              f"finished lawn disagrees with it weigh {1 + CORRECTIONS_WEIGHT:g}x", flush=True)
    if SKIP_EXAMPLES:
        print("NOT-LAWN EXAMPLE FRAMES LEFT OUT of this decoder (the without-ponds arm)", flush=True)
    if LIDAR_DISTRUST:
        bad = sorted(L["id"] for L in lawns if L.get("distrust"))
        print(f"LIDAR DISTRUSTED IN TRAINING: {len(bad)} lots whose visible lawn stands over {DISTRUST_M:g} m "
              f"on the lidar train with it hidden (answered with it as it is): {', '.join(b[:24] for b in bad) or 'none'}",
              flush=True)
    if UNDER_TREES:
        print("TAUGHT UNDER TREES: inferred lawn and canopy over traced lawn are graded as the tracer "
              "drew them (lawn), not left out", flush=True)

    # NOT-LAWN EXAMPLES TRAIN, THEY ARE NEVER HELD OUT. They join every
    # fold's training -- except that a fold does not see an example within
    # NEIGHBOUR_KM of a lot it holds out, the same rule that keeps a lot's
    # neighbours out of its decoder (same photograph, same light).
    examples = [] if SKIP_EXAMPLES else [crop_to_graded(L) for L in lawns if is_example(L["id"])]
    lawns = [L for L in lawns if not is_example(L["id"])]
    # tools/milestones.js keeps the same reminder for the deploy log (owner, 2026-10-06).
    if len(lawns) >= 150:
        print(f"REMINDER -- {len(lawns)} lawns: revisit the decoder. Test a standard segmentation head "
              "(UperNet, then Mask2Former) against this small one. S26 in docs/DETECTOR-FINDINGS.md.", flush=True)
    if examples:
        from folds import lonlat, km_between
        from collections import Counter
        kinds = Counter(L["id"].split(":example:")[1].split("-")[0] for L in examples)
        print(f"NOT-LAWN EXAMPLES: {len(examples)} trained on, never held out "
              f"({', '.join(f'{k} {n}' for k, n in sorted(kinds.items()))})", flush=True)

    def near_held(example, group):
        a = lonlat(example["id"])
        return a is not None and any(
            (b := lonlat(h["id"])) is not None and km_between(a, b) < NEIGHBOUR_KM for h in group)

    # THE RELEASE (owner, 2026-09-29: "trained model (alpha release)"): one
    # decoder trained on EVERY lot, nothing held out, saved for the live
    # server (tools/modal_serve.py). Scoring is the folds' job, in their own
    # step; this only makes the thing that gets served.
    release_out = os.environ.get("RELEASE_OUT", "")
    if release_out:
        os.makedirs(release_out, exist_ok=True)
        t0 = time.time()
        model, mean, sd, loss = train_one(lawns + examples, dim, SEED)
        state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
        from fuse_layers import CHANNELS
        meta = {
            "backbone": manifest.get("model"), "size": manifest.get("size"),
            "resFactor": manifest.get("resFactor", 1.0),
            "dim": dim, "refine": REFINE, "refineReach": (os.environ.get("REFINE_REACH") or "normal") if REFINE else None, "refineEdges": os.environ.get("REFINE_EDGES") == "1", "refineGate": os.environ.get("REFINE_GATE") == "1", "fuse": FUSE, "fuseCanopy": FUSE_CANOPY,
            "underTrees": UNDER_TREES, "fuseReturns": bool(FUSE_RETURNS), "lidarDistrust": bool(LIDAR_DISTRUST), "correctionsWeight": CORRECTIONS_WEIGHT,
            "channels": list(CHANNELS) if FUSE else [],
            "canopyMode": CANOPY_MODE if CANOPY else None,
            "epochs": EPOCHS, "seed": SEED, "lr": LR, "weightDecay": WEIGHT_DECAY, "dropout": DROPOUT,
            "lawns": len(lawns), "examples": len(examples), "notLawn": NOT_LAWN,
            "trainLoss": round(float(loss), 4), "seconds": round(time.time() - t0),
            "commit": os.environ.get("GITHUB_SHA", ""), "run": os.environ.get("GITHUB_RUN_ID", ""),
            "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        torch.save({"state": state, "mean": mean.detach().cpu(), "sd": sd.detach().cpu(), "meta": meta},
                   os.path.join(release_out, "model.pt"))
        with open(os.path.join(release_out, "release.json"), "w") as f:
            json.dump(meta, f, indent=1)
        print(f"RELEASE: one decoder{' + edge refiner' if REFINE else ''} on all {len(lawns)} lots "
              f"in {meta['seconds']}s, train loss {loss:.3f}; saved to {release_out}/model.pt", flush=True)
        return 0

    held_out = lawns if not LIMIT else lawns[:LIMIT]
    # K-FOLD WHEN ASKED (FOLDS=k). Leave-one-out trains one decoder per lawn,
    # so its cost grows with the square of the corpus: 20 minutes a decoder
    # at 32 lawns, 68 at 53, past workflow 14's time limit with three of
    # them (2026-09-27). k folds train k decoders on (k-1)/k of the lawns;
    # every lawn is still answered by a decoder that never saw it. Unset, it
    # is leave-one-out exactly as every benchmark table was measured.
    groups = [[L] for L in held_out]
    if BY_PLACE and not LIMIT:
        from folds import place_folds
        assign = place_folds([L["id"] for L in lawns], PLACE_FOLDS, NEIGHBOUR_KM, SEED)
        groups = [[lawns[i] for i in fold] for fold in assign]
        print(f"{len(groups)} folds by place: lots within {NEIGHBOUR_KM:g} km of each other held out together "
              f"(sizes {', '.join(str(len(g)) for g in groups)})", flush=True)
    elif FOLDS > 1 and not LIMIT:
        order = np.random.default_rng(SEED).permutation(len(lawns))
        groups = [[lawns[i] for i in order[k::FOLDS]] for k in range(FOLDS)]
        groups = [g for g in groups if g]
        print(f"{len(groups)} folds of about {len(lawns) // len(groups)} lawns, not leave-one-out", flush=True)
    n = 0
    for f, group in enumerate(groups):
        t0 = time.time()
        train = [L for L in lawns if all(L is not h for h in group)]
        if examples:
            kept = [E for E in examples if not near_held(E, group)]
            if len(kept) < len(examples):
                print(f"  fold {f + 1}: {len(examples) - len(kept)} example(s) within {NEIGHBOUR_KM:g} km "
                      f"of a held-out lot left out", flush=True)
            train = train + kept
        model, mean, sd, loss = train_one(train, dim, SEED + f)
        # AN AVERAGE OF DECODERS (ENSEMBLE=k; overnight trial 2026-10-07): k-1
        # more trained on the same fold from other seeds, their answers
        # averaged. The first is the one above, so k=1 is exactly the usual.
        extra = [train_one(train, dim, SEED + f + 1000 * j)[:3] for j in range(1, ENSEMBLE)]
        for held in group:
            prob = answer(model, mean, sd, held)
            if extra:
                prob = (prob + sum(answer(m, mu, sg, held) for m, mu, sg in extra)) / ENSEMBLE
            img = Image.fromarray(np.clip(np.round(prob * 255), 0, 255).astype(np.uint8), mode="L")
            img.save(os.path.join(out, f"{held['id']}-pred.png"))
            n += 1
            # How much of the photograph it called lawn, so a fold that collapsed
            # to one answer everywhere shows up here rather than in the table.
            print(f"  {n}/{len(held_out)}  {held['id'][:28]:28}  train loss {loss:.3f}  "
                  f"lit {100 * float((prob > 0.5).mean()):4.1f}% of the picture  {time.time() - t0:.0f}s",
                  flush=True)

    total = time.time() - started
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump({
            "model": manifest.get("model"), "size": manifest.get("size"),
            "dim": dim, "params": params, "epochs": EPOCHS, "seed": SEED,
            "lr": LR, "weightDecay": WEIGHT_DECAY, "dropout": DROPOUT,
            "seenOnly": True, "bothScales": bool(FEATURES_WHOLE), "refine": REFINE, "lawns": len(lawns), "folds": len(groups), "examples": len(examples),
            "canopyUnseen": sum(1 for L in lawns if L["canopy"]),
            "canopyMode": CANOPY_MODE if CANOPY else None,
            "fused": ({"lidar": sum(1 for L in lawns if "lidar" in L["sources"]),
                       "naip": sum(1 for L in lawns if "naip" in L["sources"]),
                       "canopy": sum(1 for L in lawns if "canopy" in L["sources"]),
                       "canopyInput": FUSE_CANOPY, "underTrees": UNDER_TREES, "fuseReturns": bool(FUSE_RETURNS), "lidarDistrust": bool(LIDAR_DISTRUST), "correctionsWeight": CORRECTIONS_WEIGHT,
                       "dropLidar": DROP_LIDAR, "dropNaip": DROP_NAIP} if FUSE else None),
            "seconds": round(total),
        }, f)
    print(f"\n{len(groups)} folds in {total:.0f}s ({total / len(groups):.0f}s each). "
          f"Answers in {out}/; score them with PREDICTIONS_DIR={out}.")


if __name__ == "__main__":
    sys.exit(main())
