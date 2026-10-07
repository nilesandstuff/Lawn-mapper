"""
S19: keep the whole-lot reading, re-draw only the edge (owner go-ahead
2026-09-29).

WHY. H53: on a lawn the detector gets right, nearly all of the wrong ground
is a band about half a metre wide along the true edge. The decoder answers
once per backbone patch -- 1.3 to 5.4 m of ground, depending on the lot --
and that answer is stretched bilinearly onto the 15 cm scoring grid, so the
edge can only ever be as sharp as a patch. Tiling to make the patch smaller
cost context and lost (H55-H59). E11: the published answer to a coarse
edge is to keep the coarse reading and re-decide the edge from the
full-resolution photograph (PointRend; FeatUp's image-guided upsampling).

WHAT. A small convolutional net ON THE SCORING GRID ITSELF (15 cm a cell).
At every cell it sees:

    the photograph's colour there (3 numbers),
    the decoder's answer there, stretched exactly as to_photo stretches it (1),
    the decoder's last hidden layer, stretched the same way (32),

and says how much to move the decoder's answer, as a logit:

    3x3 conv 36 -> 32, GELU
    3x3 conv 32 -> 32, dilated 2, GELU
    3x3 conv 32 -> 32, dilated 4, GELU
    1x1 conv 32 -> 1, STARTING AT ZERO

so it begins as exactly the decoder, and can only change the answer where
learning to has paid. It reaches 7 cells, about 1 m, either side of a
cell. About 20,000 weights.

WIDE (REFINE_REACH=wide; owner, 2026-10-06, from a picture of misses 2-6 m
out from the outline along a hard woodline and along pavement). The same
net with two more dilated layers, 8 and 16, so it reaches 31 cells, about
4.6 m, either side: far enough to see the woodline or the kerb from where
the decoder's edge stopped. About 18,000 more weights. Whether it moves
edges further or just invents them is what the trial measures.

TRAINED WITH THE DECODER, NOT AFTER IT. A refiner trained on a decoder's
answers for its own training lots learns to correct a decoder that is
overconfident there -- not the one it meets on a held-out lot. So both train
together, per fold, on the same lots: the decoder's own loss on the patch
grid as before, plus the refiner's on the scoring grid, where the targets
are the traced outline itself, cell by cell, rather than a patch's average
of it. The refiner is trained on 112-cell squares (17 m), most of them
centred on a traced edge because that is where it has work to do.

The decoder's hidden layer and answer are read onto the scoring grid with
grid_sample at exactly to_photo's coordinates (photo_coords in
decoder_grid.py; refine_test.py checks the two agree).
"""

import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from decoder_grid import photo_coords

CROP = 112
CROPS_PER_LAWN = 2
EDGE_SHARE = 0.7
EDGE_REACH = 3  # cells: a cell within this of a traced edge counts as edge
REACHES = {"normal": (2, 4), "wide": (2, 4, 8, 16)}  # dilations after the first 3x3
REFINE_REACH = os.environ.get("REFINE_REACH") or "normal"


# OVERNIGHT TRIAL (owner, 2026-10-07: "reach further for strong edges like
# driveways, houses, roads ... and softer, but still noticeable edges like
# woodlines"). Two ways to aim the refiner, after H80's plain wide reach lost:
#
#   REFINE_EDGES=1  hand it the photo's edges: how sharply the brightness
#                   changes at each cell, at the 15 cm grid and over a ~0.75 m
#                   blur (a woodline is a soft edge, a kerb a sharp one).
#                   Fixed filters, nothing learned, so it does not have to
#                   discover from 81 lots what an edge is.
#   REFINE_GATE=1   let it move the answer only where the decoder is unsure:
#                   its change is scaled by a gate that falls as the decoder's
#                   confidence (|logit|) rises, with the gate's level and
#                   steepness learned. A confident lawn interior (B28) can
#                   then not be eaten from 4 m away.
#
# Both start as exactly the decoder (the last layer is zero), like the rest.
REFINE_EDGES = os.environ.get("REFINE_EDGES") == "1"
REFINE_GATE = os.environ.get("REFINE_GATE") == "1"


def photo_edges(rgb):
    """(N, 3, H, W) photo -> (N, 2, H, W): Sobel magnitude of brightness, sharp
    and over a ~5-cell blur. Edge padding, so a crop's border is not an edge."""
    lum = rgb.mean(dim=1, keepdim=True)
    kx = torch.tensor([[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]], device=rgb.device) / 8
    k = torch.stack([kx, kx.t()])[:, None]

    def mag(x):
        g = F.conv2d(F.pad(x, (1, 1, 1, 1), mode="replicate"), k)
        return torch.sqrt((g * g).sum(1, keepdim=True) + 1e-6)

    blur = F.avg_pool2d(F.pad(lum, (2, 2, 2, 2), mode="replicate"), 5, stride=1)
    return torch.cat([mag(lum), mag(blur)], dim=1)


class Refiner(nn.Module):
    def __init__(self, hidden=32, width=32, reach=None, edges=None, gate=None):
        super().__init__()
        self.reach = reach or REFINE_REACH
        self.edges = REFINE_EDGES if edges is None else bool(edges)
        self.gated = REFINE_GATE if gate is None else bool(gate)
        extra = 2 if self.edges else 0
        layers = [nn.Conv2d(3 + extra + 1 + hidden, width, 3, padding=1), nn.GELU()]
        for d in REACHES[self.reach]:
            layers += [nn.Conv2d(width, width, 3, padding=d, dilation=d), nn.GELU()]
        self.net = nn.Sequential(*layers, nn.Conv2d(width, 1, 1))
        nn.init.zeros_(self.net[-1].weight)
        nn.init.zeros_(self.net[-1].bias)
        if self.gated:
            # gate = sigmoid(level - softplus(steep) * |logit|): about 0.9 at an
            # unsure cell, about 0.1 where the decoder says |logit| = 8.
            self.gate_level = nn.Parameter(torch.tensor(2.0))
            self.gate_steep = nn.Parameter(torch.tensor(0.0))

    def forward(self, rgb, coarse_logit, coarse_hidden):
        parts = [rgb] + ([photo_edges(rgb)] if self.edges else []) + [coarse_logit, coarse_hidden]
        delta = self.net(torch.cat(parts, dim=1))
        if self.gated:
            gate = torch.sigmoid(self.gate_level - F.softplus(self.gate_steep) * coarse_logit.detach().abs())
            delta = delta * gate
        return coarse_logit + delta


def sampling_grid(cells_w, cells_h, grid_w, grid_h, cover_x, cover_y, x0=0, y0=0, w=None, h=None):
    """grid_sample coordinates (1, h, w, 2) that read a (grid_h x grid_w) patch
    grid at the centres of label cells x0..x0+w, y0..y0+h -- the same points
    to_photo reads, clamped the same way (align_corners=True, border)."""
    w = cells_w - x0 if w is None else w
    h = cells_h - y0 if h is None else h
    ux = photo_coords(cells_w, grid_w, cover_x)[x0:x0 + w]
    uy = photo_coords(cells_h, grid_h, cover_y)[y0:y0 + h]
    gx = 2 * ux / max(grid_w - 1, 1) - 1
    gy = 2 * uy / max(grid_h - 1, 1) - 1
    g = np.stack(np.meshgrid(gx, gy), axis=-1).astype(np.float32)
    return torch.from_numpy(g)[None]


def stretch(grid, sgrid):
    """(1, C, gh, gw) patch-grid numbers read at the points of `sgrid`."""
    return F.grid_sample(grid, sgrid.to(grid.device), mode="bilinear", padding_mode="border", align_corners=True)


def rgb_tensor(img_u8):
    """(H, W, 3) uint8 -> (3, H, W) float, roughly centred."""
    x = torch.from_numpy(np.ascontiguousarray(img_u8.transpose(2, 0, 1))).float()
    return (x / 255.0 - 0.5) / 0.25


def edge_cells(truth, weight, reach=EDGE_REACH):
    """Flat indices of graded cells within `reach` of a change in the trace."""
    t = truth.astype(bool)
    edge = np.zeros_like(t)
    edge[:, 1:] |= t[:, 1:] != t[:, :-1]
    edge[:, :-1] |= t[:, 1:] != t[:, :-1]
    edge[1:, :] |= t[1:, :] != t[:-1, :]
    edge[:-1, :] |= t[1:, :] != t[:-1, :]
    if reach > 1:
        e = torch.from_numpy(edge.astype(np.float32))[None, None]
        e = F.max_pool2d(e, 2 * reach + 1, stride=1, padding=reach)[0, 0].numpy() > 0
    else:
        e = edge
    return np.flatnonzero(e & (weight > 0)), np.flatnonzero(weight > 0)


def pick_crops(L, rng, n=CROPS_PER_LAWN, size=CROP):
    """Top-left corners of `n` squares, mostly centred on a traced edge."""
    H, W = L["fine_t"].shape[-2:]
    sh, sw = min(size, H), min(size, W)
    out = []
    for _ in range(n):
        pool = L["edge_idx"] if len(L["edge_idx"]) and rng.random() < EDGE_SHARE else L["graded_idx"]
        if len(pool):
            c = int(pool[rng.integers(len(pool))])
            cy, cx = divmod(c, W)
        else:
            cy, cx = int(rng.integers(H)), int(rng.integers(W))
        y0 = int(np.clip(cy - sh // 2, 0, H - sh))
        x0 = int(np.clip(cx - sw // 2, 0, W - sw))
        out.append((x0, y0, sw, sh))
    return out
