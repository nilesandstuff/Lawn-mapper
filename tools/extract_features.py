"""
Feature extraction with a real backbone, in the language the backbones live in.

WHY PYTHON EXISTS IN A JAVASCRIPT PROJECT. The ONNX export of DINOv2 that Node
can load is frozen at 224 pixels: its position-embedding table was baked in at
one size, so the graph refuses anything larger. Over a 40 m property that is a
patch every 3.3 m, which is coarser than the hand-written colour features it
was meant to improve on. The workaround was to run it on sixteen tiles -- and
tiling is precisely what destroys the thing a pretrained model is for, because
a patch in the middle of a tile cannot see the garden it sits in.

In PyTorch the same model interpolates its position embeddings and takes any
size. So this runs the whole property in ONE pass at a resolution we choose,
and every patch attends to every other. Grass in shadow can be read as grass
because the model can see the lawn around it, which is the objection that sent
us here.

TWO KINDS OF EYE NOW, and the difference is what they were shown.

DINOv2 learned from ordinary photographs -- things at eye level, lit from the
side. It has seen grass and tarmac, but never from above, and it has no idea
how big anything in the picture is.

Scale-MAE learned from satellite imagery, and it learned SCALE on purpose: it
is given the ground distance a pixel covers and builds its position encoding
out of it. That makes it the first model here that knows a 40 m garden is a
40 m garden. It also makes the scale a REQUIRED input rather than a nicety --
tell it the wrong number and it reads a lawn as though it were a field seen
from orbit, confidently, with nothing on screen to say so. Hence scale.json,
and hence the check below that proves the number is reaching the model.

THE INTERFACE IS A DIRECTORY OF FILES, deliberately. Node fetches the
photographs, rasterises the outlines and does the leave-one-out scoring -- all
of that is built and tested and has no reason to move. This does one job:
pictures in, patch features out. Raw float32 so nothing is lost to JSON, and a
manifest saying what shape they are.

AND SINCE 2026-09-23, THE MODEL READS EVERY LAWN AT 10 CM A PIXEL. "One pass
over the whole property" was true and, on a big lot, was the problem: the
photographs are 10 cm a pixel or finer whatever the size of the lot, so
squeezing a 172 m lot into 896 px handed the model 19 cm a pixel and a 319 m
lot 36. A lot the eye can read whole at the target still is, exactly as
before. A bigger one is read in overlapping windows of SIZE pixels at the
photograph's own resolution, keeping only the middle of each so every patch
had context on all sides, and the windows are stitched into one grid. See
windows.py for why overlap rather than tiles.

  IMAGES=dir OUT=dir MODEL=facebook/dinov2-base SIZE=672 python3 extract_features.py
  IMAGES=dir OUT=dir MODEL=scalemae-large    SIZE=672 python3 extract_features.py
"""

import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

from windows import padded_side_metres, window_plan, windowed

# The ground a pixel may cover, at most, when the model reads it. The canopy
# model was trained at this and the live detector is fed it; the rule is that
# every detector gets it. TARGET_MPP overrides it for an experiment.
TARGET_MPP = float(os.environ.get("TARGET_MPP", "0.10"))

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_SD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Scale-MAE's own transform in torchgeo is Normalize(0, 255) then these same
# two constants, so both eyes want the picture prepared identically. Worth
# saying out loud, because "the satellite model surely wants its own
# normalisation" is the obvious guess and it is wrong.


class HubEye:
    """Anything on the HuggingFace hub shaped like a plain ViT.

    DINOv2 in all its sizes, with or without registers. The model is asked for
    its own patch size rather than told one, because guessing it wrong shifts
    every patch and produces a result that looks plausible.
    """

    wants_scale = False

    def __init__(self, model_id, size):
        from transformers import AutoModel

        self.name = model_id
        self.model = AutoModel.from_pretrained(model_id)
        # eval() and no_grad are not an optimisation here -- training is not
        # happening, and a backbone left in training mode would run its dropout
        # and return a different answer to the same photograph every time,
        # which would quietly poison the leave-one-out comparison this feeds.
        self.model.eval()

        patch = getattr(self.model.config, "patch_size", None)
        if patch is None:
            raise SystemExit(f"{self.model.config.model_type} declares no patch size")
        if size % patch:
            raise SystemExit(f"size {size} is not a whole number of {patch}px patches")
        self.patch = patch
        self.side = size // patch

    def look(self, tensor, _metres_per_pixel):
        with torch.no_grad():
            return self.model(pixel_values=tensor).last_hidden_state


class SatelliteEye:
    """Scale-MAE: a ViT-Large pretrained on overhead imagery, told its scale.

    torchgeo carries the loader and the published weights, which is why it is a
    dependency rather than two hundred lines of copied research code. The one
    thing worth knowing about the architecture: ScaleMAE._pos_embed IGNORES the
    stored position table and builds a fresh sin-cos encoding from
    `self.res` -- the ground distance a pixel covers -- every forward pass. So
    the model takes any input size without interpolating anything, and the
    scale can be changed per photograph by assignment.
    """

    wants_scale = True
    PATCH = 16

    def __init__(self, size):
        from torchgeo.models import ScaleMAELarge16_Weights, scalemae_large_patch16

        if size % self.PATCH:
            raise SystemExit(
                f"Scale-MAE has {self.PATCH}px patches and {size} does not divide by "
                f"{self.PATCH}. Try 448, 672 or 896."
            )
        self.name = "scalemae-large"
        self.patch = self.PATCH
        self.side = size // self.PATCH
        self.model = scalemae_large_patch16(
            weights=ScaleMAELarge16_Weights.FMOW_RGB, img_size=size, res=1.0
        )
        self.model.eval()

    def look(self, tensor, metres_per_pixel):
        # Read at forward time out of self.res, so this is the whole of telling
        # it what it is looking at.
        self.model.res = float(metres_per_pixel)
        with torch.no_grad():
            return self.model.forward_features(tensor)


def open_eye(model_id, size):
    """One of the two, chosen by name."""
    if model_id.startswith("scalemae"):
        return SatelliteEye(size)
    return HubEye(model_id, size)


def normalised(img):
    """A PIL image as the (h, w, 3) float array the models are fed."""
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return (arr - IMAGENET_MEAN) / IMAGENET_SD


def to_tensor(arr):
    return torch.from_numpy(np.ascontiguousarray(arr)).permute(2, 0, 1).unsqueeze(0)


def as_tensor(path, size):
    """The whole photograph as one `size` x `size` tensor, plus its cover.

    A RECTANGLE IS PADDED TO A SQUARE FIRST, never squashed. The frames are
    the parcel plus a margin, cropped both ways (2026-09-23), and a ViT with
    a fixed window wants a square -- so the shorter side is extended by
    reflection to the longer one, and the whole is resized to `size`. The
    padding is context the model sees and the head never reads: `cover` says
    how far past the photograph the grid runs on each axis, and sampleAt on
    the Node side divides by it (the same mechanism the windows use).
    """
    img = Image.open(path).convert("RGB")
    w, h = img.size
    cover = (1.0, 1.0)
    if w != h:
        long = max(w, h)
        arr = np.asarray(img)
        pad = ((0, long - h), (0, long - w), (0, 0))
        mode = "reflect" if max(long - h, long - w) < min(w, h) else "edge"
        img = Image.fromarray(np.pad(arr, pad, mode=mode))
        cover = (long / w, long / h)
    if img.size != (size, size):
        # BOX is an area average and is the right filter going down -- it is
        # the same thing the Node side does to reach its 512 grid. Going UP it
        # is blocky nonsense, so bicubic for that case.
        shrinking = img.size[0] >= size
        img = img.resize((size, size), Image.BOX if shrinking else Image.BICUBIC)
    return to_tensor(normalised(img)), cover


def read_whole(span, w, h, size, target=TARGET_MPP):
    """Whether one resized pass already reads this lawn at the target.

    Yes when the lot is small enough that `size` pixels over it is 10 cm or
    finer -- the path every run before 2026-09-23 took, kept byte for byte for
    those lots. Yes too when the photograph itself has no more pixels than
    the window, because windows cannot add resolution a picture does not
    hold. And yes when nobody said how big the lot is, since the alternative
    is guessing.
    """
    if span is None:
        return True
    if max(w, h) <= size:
        return True
    return span / size <= target + 1e-9


def patches_of(hidden, side):
    """
    HOW MANY TOKENS ARE NOT PATCHES.

    A plain ViT prepends one classification token; DINOv2 with registers
    prepends several more. Guessing wrong does not fail -- it shifts every
    patch by one position, so the features describe the ground slightly up and
    to the left of where they are used, and the model trains on a picture that
    is subtly out of register with its own labels. Deriving the count from the
    shape is the only way to be sure.
    """
    tokens = hidden.shape[1]
    want = side * side
    extra = tokens - want
    if extra < 0:
        raise SystemExit(
            f"{tokens} tokens for a {side}x{side} grid -- the model returned "
            "fewer than one per patch, so this reader has the geometry wrong"
        )
    grid = hidden[0, extra:, :].numpy().astype(np.float32)
    return grid, grid.shape[1], extra


def read_spans(images):
    """How many metres of ground each frame covers, written by the dumper.

    Absent is fine for a model that does not ask. For one that does it is
    fatal, and deliberately so: the alternative is a default that makes every
    property the same size and turns a scale-aware model into a worse
    scale-blind one, which would look like a disappointing result rather than
    like a bug.
    """
    path = os.path.join(images, "scale.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f).get("frames", {})


def prove_scale_is_read(eye, tensor):
    """That the number is reaching the model, before twenty lawns rely on it.

    Two passes over the same picture at scales a factor of ten apart. If the
    features come back identical the resolution is being ignored somewhere --
    a renamed attribute, a loader change -- and every result after this would
    be Scale-MAE run scale-blind while reporting itself as scale-aware.
    """
    near = eye.look(tensor, 0.1)[0, 1:, :]
    far = eye.look(tensor, 1.0)[0, 1:, :]
    moved = float((near - far).abs().mean())
    if moved < 1e-6:
        raise SystemExit(
            "the same photograph at 0.1 and 1.0 m a pixel gave identical "
            "features -- the scale is not reaching the model, so this run "
            "would be scale-blind and say otherwise"
        )
    return moved


def main():
    images = os.environ.get("IMAGES")
    out_dir = os.environ.get("OUT")
    model_id = os.environ.get("MODEL", "facebook/dinov2-base")
    size = int(os.environ.get("SIZE", "672"))
    if not images or not out_dir:
        raise SystemExit("IMAGES and OUT are required")

    os.makedirs(out_dir, exist_ok=True)
    names = sorted(n for n in os.listdir(images) if n.endswith(".png"))
    if not names:
        raise SystemExit(f"no .png files in {images}")

    spans = read_spans(images)

    print(f"{model_id} at {size}px, {len(names)} photographs", flush=True)
    started = time.time()
    eye = open_eye(model_id, size)
    print(f"loaded in {time.time() - started:.1f}s", flush=True)

    if eye.wants_scale:
        if not spans:
            raise SystemExit(
                f"{eye.name} is a scale-aware model and {images}/scale.json is "
                "missing. Re-run the frame dump; it writes one."
            )
        missing = [n[:-4] for n in names if n[:-4] not in spans]
        if missing:
            raise SystemExit(
                f"scale.json has no ground size for {len(missing)} of "
                f"{len(names)} frames, starting with {missing[0]}"
            )
        moved = prove_scale_is_read(eye, as_tensor(os.path.join(images, names[0]), size)[0])
        print(f"scale is reaching the model (features move {moved:.4f} across "
              "a tenfold change)", flush=True)

    manifest = {"model": eye.name, "size": size, "scaleAware": eye.wants_scale,
                "targetMpp": TARGET_MPP, "windowed": 0, "images": {}}
    extra = 0
    dim = 0
    coarsest = 0.0
    passes = 0
    for i, name in enumerate(names):
        t = time.time()
        stem = name[:-4]
        img = Image.open(os.path.join(images, name)).convert("RGB")
        w, h = img.size
        span = spans.get(stem)

        if read_whole(span, w, h, size):
            # Metres per pixel of what the model is about to see, which depends
            # on the size it is read at and so cannot be stored with the picture.
            tensor, cover = as_tensor(os.path.join(images, name), size)
            # Metres per pixel of what the model sees: the padded square's
            # side over `size`. See padded_side_metres for why it is cover[0]
            # and not max(cover) -- the first rectangular run got that wrong
            # and told the model a 319 m lot was 878 m across.
            long_m = padded_side_metres(span, cover) if span else 0.0
            mpp = (long_m / size) if (eye.wants_scale and span) else 0.0
            hidden = eye.look(tensor, mpp)
            flat, dim, extra = patches_of(hidden, eye.side)
            grid = flat.reshape(eye.side, eye.side, dim)
            windows = 1
            # What the model resolved, for the summary -- a scale-blind eye is
            # still fed pixels of a known size.
            seen_mpp = long_m / size if span else 0.0
        else:
            # At the photograph's own resolution, in overlapping windows.
            mpp = (span / w) if eye.wants_scale else 0.0
            seen_mpp = span / w

            tokens = {"extra": 0}

            def look(win):
                hidden = eye.look(to_tensor(win), mpp)
                flat, d, tokens["extra"] = patches_of(hidden, eye.side)
                return flat.reshape(eye.side, eye.side, d)

            grid, cover, windows = windowed(normalised(img), size, eye.patch, look)
            dim = grid.shape[2]
            extra = tokens["extra"]
            manifest["windowed"] += 1

        np.ascontiguousarray(grid).tofile(os.path.join(out_dir, f"{stem}.f32"))
        manifest["images"][stem] = {
            "gridW": int(grid.shape[1]), "gridH": int(grid.shape[0]), "dim": int(dim),
            "coverX": cover[0], "coverY": cover[1],
            "windows": windows, "mpp": seen_mpp,
        }
        manifest["extraTokens"] = extra
        coarsest = max(coarsest, seen_mpp)
        passes += windows
        scale = f"  {seen_mpp:.3f} m/px" if span else ""
        how = "one pass" if windows == 1 else f"{windows} windows"
        print(
            f"  {i + 1}/{len(names)}  {grid.shape[1]}x{grid.shape[0]} patches of {dim}"
            f"{scale}  {how}  {time.time() - t:.1f}s",
            flush=True,
        )

    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)

    total = time.time() - started
    print(f"\n{len(names)} done in {total:.0f}s ({total / len(names):.1f}s each), "
          f"{passes} passes of {size} px")
    print(f"{dim} numbers a patch, {extra} non-patch token(s) skipped")
    if manifest["windowed"]:
        print(f"{manifest['windowed']} of {len(names)} lawns were too big to read at "
              f"{TARGET_MPP * 100:.0f} cm a pixel in one pass and were read in "
              "overlapping windows at the photograph's own resolution.")
    else:
        print(f"Every lawn fitted one pass at {TARGET_MPP * 100:.0f} cm a pixel or finer.")
    if spans:
        print(f"The coarsest any lawn reached the model: {coarsest * 100:.1f} cm a pixel.")


if __name__ == "__main__":
    sys.exit(main())
