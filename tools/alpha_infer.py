"""
THE PLAN's detector on one lot, for the live server (tools/modal_serve.py).

Every step calls the function training used, so the lot served is read the
way the lots measured were:

    photograph  -> Scale-MAE, the whole lot in one pass   extract_features.as_tensor / padded_side_metres
    NAIP        -> NDVI over the frame, lined up           naip_bands.naip_for
    3DEP lidar  -> height, returns, roof, void             lidar_frame.lidar_for
    decoder + edge refiner -> probability on the 15 cm grid train_decoder.answer
    tree model  -> canopy mask at the photograph's pixels   tree-canopy.canopy_at

Stage 3 and the lidar veto are the scorer's JavaScript (tools/serve-alpha.mjs),
run over the pictures this writes.

A source that cannot be read (no point cloud here, NAIP down) is left out the
way training left it out -- the fused decoder was trained with each source
hidden now and then (DROP_LIDAR / DROP_NAIP) and has met "no lidar here".
"""

import importlib.util
import os
import sys
import tempfile
import threading
import time

import numpy as np
import torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import extract_features  # noqa: E402
from decoder_grid import to_photo  # noqa: E402,F401  (kept importable beside answer)
from fuse_layers import extra_channels, ndvi_from_png  # noqa: E402
from windows import padded_side_metres  # noqa: E402


def _tree_module():
    spec = importlib.util.spec_from_file_location("tree_canopy", os.path.join(HERE, "tree-canopy.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Release:
    """The saved decoder (+ edge refiner) and the standardiser it was trained with."""

    def __init__(self, path, device):
        os.environ.setdefault("REFINE", "1")
        import train_decoder  # noqa: E402  (reads REFINE at import)
        self.td = train_decoder
        blob = torch.load(path, map_location="cpu")
        self.meta = blob["meta"]
        if self.meta.get("refine") and not train_decoder.REFINE:
            raise SystemExit("this release has an edge refiner; import train_decoder with REFINE=1")
        model = train_decoder.Decoder(self.meta["dim"])
        if self.meta.get("refine"):
            from edge_refine import Refiner
            model.refiner = Refiner(reach=self.meta.get("refineReach") or "normal",
                                    edges=bool(self.meta.get("refineEdges")), gate=bool(self.meta.get("refineGate")))
        model.load_state_dict(blob["state"])
        self.model = model.to(device).eval()
        self.mean = blob["mean"].to(device)
        self.sd = blob["sd"].to(device)
        self.device = device


class Detector:
    """Everything loaded once per container: the eye, the tree model, the release.

    IN TWO HALVES, for Modal's memory snapshot (tools/modal_serve.py). The
    two big models -- Scale-MAE and the tree model, fixed, baked into the
    image -- load first, on whatever device the modules chose (the CPU while a
    snapshot is being taken). `to(device)` then moves them onto the GPU after
    a restore, and `load_release` reads the small, replaceable decoder last,
    so a new release is picked up without a new snapshot.
    """

    def __init__(self, release_path=None, backbone="scalemae-large", size=896):
        self.device = extract_features.DEVICE
        self.eye_key = (backbone, int(size))
        self.eye = extract_features.open_eye(*self.eye_key)
        self.tree = _tree_module()
        from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
        self.tree_model = SegformerForSemanticSegmentation.from_pretrained(self.tree.MODEL).to(self.device).eval()
        self.tree_processor = SegformerImageProcessor.from_pretrained(self.tree.MODEL, do_resize=False)
        self.tree_want = self.tree.tree_index(self.tree_model)
        self.release = None
        # The GPU steps take turns when a machine runs several lots at once.
        self.gpu_lock = threading.Lock()
        if release_path:
            self.load_release(release_path)

    def to(self, device):
        """Every model, and the modules' own notion of the device, onto `device`."""
        extract_features.DEVICE = device
        td = sys.modules.get("train_decoder")
        if td is not None:
            td.DEVICE = device
        self.eye.model.to(device)
        self.tree_model.to(device)
        if self.release is not None:
            self.release.model.to(device)
            self.release.mean = self.release.mean.to(device)
            self.release.sd = self.release.sd.to(device)
            self.release.device = device
        self.device = device
        return self

    def load_release(self, release_path):
        """The trained decoder (+ edge refiner). Reopens the eye only if the
        release was trained on a different backbone or size."""
        self.release = Release(release_path, self.device)
        self.release.td.DEVICE = self.device
        meta = self.release.meta
        key = (meta.get("backbone") or "scalemae-large", int(meta.get("size") or 896))
        if key != self.eye_key:
            extract_features.DEVICE = self.device
            self.eye = extract_features.open_eye(*key)
            self.eye_key = key
        return self

    # --------------------------------------------------------------- pieces
    def features(self, photo, span):
        """The whole lot through Scale-MAE in one pass (`windows: off`)."""
        size = self.eye.side * self.eye.patch
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            photo.save(f.name)
            tensor, cover = extract_features.as_tensor(f.name, size)
        long_m = padded_side_metres(span, cover)
        mpp = (long_m / size) if self.eye.wants_scale else 0.0
        hidden = self.eye.look(tensor, mpp)
        flat, dim, _ = extract_features.patches_of(hidden, self.eye.side)
        return flat.reshape(self.eye.side, self.eye.side, dim), cover

    def canopy(self, photo, span, down):
        mask, _, _, _ = self.tree.canopy_at(self.tree_model, self.tree_processor, self.tree_want,
                                            self.device, photo, span, down)
        return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(photo.size, Image.NEAREST)) >= 128

    # ------------------------------------------------------------ one lot
    def run(self, photo, prep, out_dir, naip_align=None, sources=None):
        """Writes prob.png, canopy.png and (when lidar reads) roof/void/height.png
        into out_dir; returns a record of what was used and how long it took.

        `sources` is what alpha_sources.gather_sources read on the CPU machine
        (tools/modal_serve.py); without it, this reads them itself, as before.

        ONE LOT ON THE GPU AT A TIME, several in flight (owner, 2026-09-30:
        a machine takes up to four lots at once). Only the GPU steps take turns
        -- the backbone sets a per-lot scale on the shared model before it
        reads, so two at once could swap scales -- and everything else, the
        downloads included, runs side by side.
        """
        import alpha_sources

        t = {}
        if sources is None:
            sources = alpha_sources.gather_sources(photo, prep, naip_align)
        rec = dict(sources["rec"])
        t.update(sources.get("seconds", {}))

        lidar = sources.get("lidar")
        if lidar is not None:
            Image.fromarray(np.asarray(sources["height_png"])).save(os.path.join(out_dir, "height.png"))
            for k in ("roof", "void"):
                Image.fromarray(np.asarray(sources[k]).astype(np.uint8) * 255).save(os.path.join(out_dir, f"{k}.png"))

        ndvi = valid = None
        if sources.get("naip") is not None:
            ndvi, valid = ndvi_from_png(sources["naip"])
            if not valid.any():
                ndvi = valid = None
                rec["naip"] = False
            else:
                rec["naip"] = True

        with self.gpu_lock:
            t0 = time.time()
            grid, cover = self.features(photo, prep["span"])
            gh, gw = grid.shape[:2]
            t["backbone"] = round(time.time() - t0, 1)

            t0 = time.time()
            can = self.canopy(photo, prep["span"], prep["down"])
            t["canopy"] = round(time.time() - t0, 1)

            t0 = time.time()
            meta = self.release.meta
            x = grid
            if meta.get("fuse"):
                fuse_can = can if meta.get("fuseCanopy") else None
                extra = extra_channels(gw, gh, cover[0], cover[1], lidar=lidar, ndvi=ndvi, ndvi_valid=valid, canopy=fuse_can)
                x = np.concatenate([grid, extra.transpose(1, 2, 0)], axis=2)
            cells_w, cells_h = int(prep["w"]), int(prep["h"])
            L = {
                "x": torch.from_numpy(np.ascontiguousarray(x.transpose(2, 0, 1))),
                "cells": (cells_w, cells_h),
                "cover": cover,
                "rgb": np.asarray(photo.convert("RGB").resize((cells_w, cells_h), Image.BOX)),
            }
            prob = self.release.td.answer(self.release.model, self.release.mean, self.release.sd, L)
            t["decoder"] = round(time.time() - t0, 1)

        Image.fromarray(can.astype(np.uint8) * 255).save(os.path.join(out_dir, "canopy.png"))
        Image.fromarray(np.clip(np.round(prob * 255), 0, 255).astype(np.uint8), mode="L").save(
            os.path.join(out_dir, "prob.png"))
        rec["seconds"] = t
        return rec
