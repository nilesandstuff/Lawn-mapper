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

THE INTERFACE IS A DIRECTORY OF FILES, deliberately. Node fetches the
photographs, rasterises the outlines and does the leave-one-out scoring -- all
of that is built and tested and has no reason to move. This does one job:
pictures in, patch features out. Raw float32 so nothing is lost to JSON, and a
manifest saying what shape they are.

  IMAGES=dir OUT=dir MODEL=facebook/dinov2-base SIZE=672 python3 extract_features.py
"""

import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_SD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def load(model_id):
    """The model, frozen and on the CPU.

    eval() and no_grad are not an optimisation here -- training is not
    happening and a backbone left in training mode would run its dropout and
    return a different answer to the same photograph every time, which would
    quietly poison the leave-one-out comparison this feeds.
    """
    model = AutoModel.from_pretrained(model_id)
    model.eval()
    return model


def patch_side(model, size):
    """How many patches across, from the model's own config."""
    cfg = model.config
    patch = getattr(cfg, "patch_size", None)
    if patch is None:
        raise SystemExit(f"{cfg.model_type} does not declare a patch size")
    if size % patch:
        raise SystemExit(f"size {size} is not a whole number of {patch}px patches")
    return size // patch, patch


def features(model, path, size):
    img = Image.open(path).convert("RGB").resize((size, size), Image.BOX)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_SD
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)

    with torch.no_grad():
        out = model(pixel_values=tensor)

    hidden = out.last_hidden_state              # [1, tokens, dim]
    side, patch = patch_side(model, size)
    tokens = hidden.shape[1]
    want = side * side

    """
    HOW MANY TOKENS ARE NOT PATCHES.

    A plain ViT prepends one classification token; DINOv2 with registers
    prepends several more. Guessing wrong does not fail -- it shifts every
    patch by one position, so the features describe the ground slightly up and
    to the left of where they are used, and the model trains on a picture that
    is subtly out of register with its own labels. Deriving the count from the
    shape is the only way to be sure.
    """
    extra = tokens - want
    if extra < 0:
        raise SystemExit(
            f"{tokens} tokens for a {side}x{side} grid -- the model returned "
            "fewer than one per patch, so this reader has the geometry wrong"
        )
    grid = hidden[0, extra:, :].numpy().astype(np.float32)
    return grid, side, grid.shape[1], extra


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

    print(f"{model_id} at {size}px, {len(names)} photographs", flush=True)
    started = time.time()
    model = load(model_id)
    print(f"loaded in {time.time() - started:.1f}s", flush=True)

    manifest = {"model": model_id, "size": size, "images": {}}
    for i, name in enumerate(names):
        t = time.time()
        grid, side, dim, extra = features(model, os.path.join(images, name), size)
        stem = name[:-4]
        grid.tofile(os.path.join(out_dir, f"{stem}.f32"))
        manifest["images"][stem] = {"gridW": side, "gridH": side, "dim": dim}
        manifest["extraTokens"] = extra
        print(
            f"  {i + 1}/{len(names)}  {side}x{side} patches of {dim}"
            f"  {time.time() - t:.1f}s",
            flush=True,
        )

    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)

    total = time.time() - started
    print(f"\n{len(names)} done in {total:.0f}s ({total / len(names):.1f}s each)")
    print(f"{side}x{side} patches, {dim} numbers each, {extra} non-patch token(s) skipped")


if __name__ == "__main__":
    sys.exit(main())
