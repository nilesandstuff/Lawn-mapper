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
            model.refiner = Refiner()
        model.load_state_dict(blob["state"])
        self.model = model.to(device).eval()
        self.mean = blob["mean"].to(device)
        self.sd = blob["sd"].to(device)
        self.device = device


class Detector:
    """Everything loaded once per container: the eye, the tree model, the release."""

    def __init__(self, release_path):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.release = Release(release_path, self.device)
        meta = self.release.meta
        self.eye = extract_features.open_eye(meta.get("backbone") or "scalemae-large", int(meta.get("size") or 896))
        self.tree = _tree_module()
        from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
        self.tree_model = SegformerForSemanticSegmentation.from_pretrained(self.tree.MODEL).to(self.device).eval()
        self.tree_processor = SegformerImageProcessor.from_pretrained(self.tree.MODEL, do_resize=False)
        self.tree_want = self.tree.tree_index(self.tree_model)

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
    def run(self, photo, prep, out_dir, naip_align=None):
        """Writes prob.png, canopy.png and (when lidar reads) roof/void/height.png
        into out_dir; returns a record of what was used and how long it took."""
        import lidar_frame
        import naip_bands

        t = {}
        rec = {"lidar": False, "naip": False}
        t0 = time.time()
        grid, cover = self.features(photo, prep["span"])
        gh, gw = grid.shape[:2]
        t["backbone"] = round(time.time() - t0, 1)

        lidar = None
        if prep.get("lidarUrl"):
            t0 = time.time()
            try:
                got = lidar_frame.lidar_for(prep["lidarUrl"], prep["bbox"])
                if got:
                    layers, masks = got
                    lidar = {k: layers[k] for k in ("height", "n_ground", "n_all")}
                    Image.fromarray(lidar_frame.height_png(layers["height"])).save(os.path.join(out_dir, "height.png"))
                    for k in ("roof", "void"):
                        Image.fromarray(masks[k].astype(np.uint8) * 255).save(os.path.join(out_dir, f"{k}.png"))
                    rec["lidar"] = True
            except Exception as e:  # noqa: BLE001 - served without it, as trained
                rec["lidarError"] = str(e)[:200]
            t["lidar"] = round(time.time() - t0, 1)

        ndvi = valid = None
        t0 = time.time()
        try:
            naip, _ = naip_bands.naip_for(prep["bbox"], photo=photo, stored=naip_align)
            ndvi, valid = ndvi_from_png(naip)
            if valid.any():
                rec["naip"] = True
            else:
                ndvi = valid = None
        except Exception as e:  # noqa: BLE001 - served without it, as trained
            rec["naipError"] = str(e)[:200]
        t["naip"] = round(time.time() - t0, 1)

        t0 = time.time()
        can = self.canopy(photo, prep["span"], prep["down"])
        Image.fromarray(can.astype(np.uint8) * 255).save(os.path.join(out_dir, "canopy.png"))
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
        Image.fromarray(np.clip(np.round(prob * 255), 0, 255).astype(np.uint8), mode="L").save(
            os.path.join(out_dir, "prob.png"))
        t["decoder"] = round(time.time() - t0, 1)
        rec["seconds"] = t
        return rec
