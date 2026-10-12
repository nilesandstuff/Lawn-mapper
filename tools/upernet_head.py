"""
A SMALL UPERNET OVER THE FROZEN EYE'S ONE GRID (S26; owner, 2026-10-12: "try
doing a run or 2 using upernet instead of our decoder ... taking a lot of
measures to protect against over fitting").

UperNet (Xiao et al. 2018) is a pyramid pooling module on the coarsest level
of a feature pyramid, lateral 1x1 convolutions on every level, a top-down
path that adds each level into the finer one, a 3x3 smoothing per level, and
one 3x3 fusion over every level brought to the finest. It is the head
Scale-MAE's own paper scores with. It wants a PYRAMID, and a plain ViT hands
over one map at one stride; ViTDet (Li et al. 2022) found that building the
pyramid from that last map alone, by pooling and deconvolution, does as well
as tapping middle layers. That is what this does: the one squeezed grid the
decoder already reads, at strides 1, 2, 4 and 8 of it by max pooling (a 64
patch grid: 64, 32, 16 and 8 across). The answer is at the grid, exactly as
the small decoder's, so every reader downstream (to_photo, the edge refiner,
stage 3, the veto) is unchanged.

MEASURES AGAINST OVERFITTING, each a named choice:
  1. the backbone is frozen -- features are extracted once; this trains
     only the head (few-shot segmentation work keeps the backbone frozen
     for exactly this reason);
  2. 64 channels, not UperNet's 512. At 512 the head has tens of millions
     of weights; the ViT-22B transfer paper found UperNet's size alone
     closed the gap between a frozen and a fine-tuned backbone, i.e. the
     head can memorise. At 64 it is about 0.56 M weights over 1031 inputs,
     twice the small decoder's;
  3. GroupNorm, not BatchNorm: a batch is four lawns, too few for batch
     statistics, and GroupNorm has no train/eval mismatch;
  4. dropout where the decoder has it (Dropout2d on the first layer,
     DROPOUT) and where UperNet has it (Dropout2d on the fused features,
     mmsegmentation's dropout_ratio 0.1);
  5. no auxiliary head: its purpose is deep supervision of a backbone being
     trained, and ours is not; it would only add weights and a second loss;
  6. everything else THE PLAN's: AdamW with weight decay 1e-2, cosine, a
     FIXED 30 epochs (H84: 15 worse, 60 nothing) and never early stopping on
     the held-out lots, flips and quarter turns, modality dropout, soft
     targets, the loss, the folds by place, the seeds. Overfitting shows as
     a held-out score worse than the small decoder's at a lower train loss,
     which the run log prints side by side.

    HEAD=upernet python3 tools/train_decoder.py      (workflow 14, refiner_trial: upernet)

A trial, not a release: alpha_infer.py builds the small decoder, and
train_decoder.py refuses RELEASE_OUT with this head.
"""

import os

import torch
import torch.nn as nn
import torch.nn.functional as F

CHANNELS = int(os.environ.get("UPERNET_CHANNELS", "64"))
POOL_SCALES = (1, 2, 3, 6)
STRIDES = (1, 2, 4, 8)
FUSE_DROPOUT = 0.1


def _gn(c):
    return nn.GroupNorm(min(8, c), c)


def _conv(cin, cout, k):
    return nn.Sequential(nn.Conv2d(cin, cout, k, padding=k // 2, bias=False), _gn(cout), nn.GELU())


class PPM(nn.Module):
    """Pyramid pooling: the coarsest level averaged over 1x1, 2x2, 3x3 and 6x6
    bins, each read back up to its size and stacked beside it."""

    def __init__(self, c, scales):
        super().__init__()
        self.stages = nn.ModuleList(nn.Sequential(nn.AdaptiveAvgPool2d(s), _conv(c, c, 1)) for s in scales)
        self.bottleneck = _conv(c * (1 + len(scales)), c, 3)

    def forward(self, x):
        size = x.shape[-2:]
        outs = [x] + [F.interpolate(s(x), size=size, mode="bilinear", align_corners=False) for s in self.stages]
        return self.bottleneck(torch.cat(outs, dim=1))


class UperNetHead(nn.Module):
    def __init__(self, dim, channels=CHANNELS, hidden=32, dropout_in=0.1, dropout=FUSE_DROPOUT):
        super().__init__()
        c = channels
        self.reduce = nn.Sequential(nn.Conv2d(dim, c, 1), nn.GELU(), nn.Dropout2d(dropout_in))
        self.ppm = PPM(c, POOL_SCALES)
        self.laterals = nn.ModuleList(_conv(c, c, 1) for _ in STRIDES[:-1])
        self.smooth = nn.ModuleList(_conv(c, c, 3) for _ in STRIDES[:-1])
        self.fuse = _conv(c * len(STRIDES), c, 3)
        self.drop = nn.Dropout2d(dropout)
        self.hidden = nn.Sequential(nn.Conv2d(c, hidden, 3, padding=1), nn.GELU())
        self.cls = nn.Conv2d(hidden, 1, 1)

    @staticmethod
    def pyramid(x):
        """The one map at strides 1, 2, 4 and 8 of itself (ceil, so an odd grid keeps its last row)."""
        return [x] + [F.max_pool2d(x, s, stride=s, ceil_mode=True) for s in STRIDES[1:]]

    def parts(self, x):
        """The last hidden layer (32 numbers a patch, as the small decoder's) and the answer from it."""
        levels = self.pyramid(self.reduce(x))
        lats = [lat(lv) for lat, lv in zip(self.laterals, levels[:-1])] + [self.ppm(levels[-1])]
        for i in range(len(lats) - 1, 0, -1):
            lats[i - 1] = lats[i - 1] + F.interpolate(lats[i], size=lats[i - 1].shape[-2:], mode="bilinear", align_corners=False)
        outs = [sm(l) for sm, l in zip(self.smooth, lats[:-1])] + [lats[-1]]
        size = outs[0].shape[-2:]
        outs = [outs[0]] + [F.interpolate(o, size=size, mode="bilinear", align_corners=False) for o in outs[1:]]
        hidden = self.hidden(self.drop(self.fuse(torch.cat(outs, dim=1))))
        return hidden, self.cls(hidden)

    def forward(self, x):
        return self.parts(x)[1]
