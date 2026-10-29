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
import math
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
from windows import padded_side_metres, windowed  # noqa: E402


def _tree_module():
    spec = importlib.util.spec_from_file_location("tree_canopy", os.path.join(HERE, "tree-canopy.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod



def lidar_for_decoder(rec, lidar):
    """The lidar the decoder reads: none on a leaf-on flight (S68,
    alpha_sources.LEAF_ON_SHARE), as its training's dropout shows a lot
    without it; the veto and stage 3 keep reading the flight either way."""
    return None if rec.get("lidarLeafOn") else lidar

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
        # AN AVERAGE OF DECODERS (H83; owner, 2026-10-07): a release may carry
        # several, trained from different seeds; their answers are averaged.
        # A release with one (every release before) has no "members".
        parts = [blob] + list(blob.get("members") or [])
        self.members = [(self._decoder(p["state"], device), p["mean"].to(device), p["sd"].to(device))
                        for p in parts]
        self.model, self.mean, self.sd = self.members[0]
        self.device = device

    def _decoder(self, state, device):
        td = self.td
        model = td.Decoder(self.meta["dim"])
        if self.meta.get("refine"):
            from edge_refine import Refiner
            model.refiner = Refiner(reach=self.meta.get("refineReach") or "normal",
                                    edges=bool(self.meta.get("refineEdges")), gate=bool(self.meta.get("refineGate")))
        model.load_state_dict(state)
        return model.to(device).eval()

    def to(self, device):
        self.members = [(m.to(device), mu.to(device), sd.to(device)) for m, mu, sd in self.members]
        self.model, self.mean, self.sd = self.members[0]
        self.device = device
        return self

    def answer(self, L):
        """The lawn probability on the 15 cm grid: the members' answers averaged."""
        probs = [self.td.answer(m, mu, sd, L) for m, mu, sd in self.members]
        return probs[0] if len(probs) == 1 else sum(probs) / len(probs)


class Detector:
    """Everything loaded once per container: the eye, the tree model, the release.

    IN TWO HALVES, for Modal's memory snapshot (tools/modal_serve.py). The
    two big models -- Scale-MAE and the tree model, fixed, baked into the
    image -- load first, on whatever device the modules chose (the CPU while a
    snapshot is being taken). `to(device)` then moves them onto the GPU after
    a restore, and `load_release` reads the small, replaceable decoder last,
    so a new release is picked up without a new snapshot.
    """

    def __init__(self, release_path=None, backbone=None, size=896):
        self.device = extract_features.DEVICE
        if backbone is None:
            # The eye the release was trained on, so a DINOv3 release does not
            # first fetch Scale-MAE's 1.1 GB only to swap it out (workflow 43's
            # first draw did). The server names its eye itself, from the same meta.
            meta = torch.load(release_path, map_location="cpu")["meta"] if release_path else {}
            backbone, size = meta.get("backbone") or "scalemae-large", int(meta.get("size") or size)
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
            self.release.to(device)
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
        """The lot through Scale-MAE: whole in one pass (`windows: off`, every
        release before S49), or, for a release trained with `windows: on`
        (meta "windowed" > 0, or ALPHA_WINDOWS=1), a lot too big for one pass
        at 10 cm read in overlapping windows at the photograph's own
        resolution, exactly as tools/extract_features.py reads it for
        training (windows.py: the margins are read and thrown away, the
        cores stitched). Owner, 2026-10-22: a 10-acre condo complex squeezed
        whole was read at 44 cm a pixel and traced very badly."""
        size = self.eye.side * self.eye.patch
        w, h = photo.size
        meta = self.release.meta if self.release is not None else {}
        windows_on = bool(meta.get("windowed") or os.environ.get("ALPHA_WINDOWS") == "1")
        if windows_on and not extract_features.read_whole(span, w, h, size):
            mpp = (span / w) if self.eye.wants_scale else 0.0

            def look(win):
                hidden = self.eye.look(extract_features.to_tensor(win), mpp)
                flat, d, _ = extract_features.patches_of(hidden, self.eye.side)
                return flat.reshape(self.eye.side, self.eye.side, d)

            grid, cover, n = windowed(extract_features.normalised(photo), size, self.eye.patch, look)
            self.last_windows = n
        elif meta.get("native") and not extract_features.read_whole(span, w, h, size):
            # NATIVE (S58): the whole lot in one pass with a pixel at the
            # target, as many patches as that takes, capped as training was.
            long_m = span * max(w, h) / w
            S = int(math.ceil(long_m / extract_features.TARGET_MPP / self.eye.patch)) * self.eye.patch
            S = max(size, min(int(meta.get("nativeMaxPx") or extract_features.NATIVE_MAX_PX), S))
            grid, cover = self.whole(photo, span, S)
            self.last_windows = 1
        else:
            grid, cover = self.whole(photo, span, size)
            self.last_windows = 1
        if meta.get("bothScales"):
            # BOTH SCALES (`windows: on + whole`, 2026-10-22): the whole-lot
            # pass resampled onto this grid and stacked beside it, exactly as
            # train_decoder.read_lawn stacks FEATURES_WHOLE. A lot read whole
            # above is stacked with itself, as its training grid was.
            from decoder_grid import onto_grid
            whole, wc = (grid, cover) if self.last_windows == 1 else self.whole(photo, span, size)
            gh, gw = grid.shape[:2]
            grid = np.concatenate([grid, onto_grid(whole, wc[0], wc[1], gw, gh, cover[0], cover[1])], axis=2)
        return grid, cover

    def whole(self, photo, span, size):
        """The lot read in one pass at `size` px a side: squeezed to the eye's
        own size, as every release before S49 read it, or (native, S58) at as
        many pixels as 10 cm takes.

        THE GRID IS size / patch PATCHES A SIDE, NOT THE EYE'S DEFAULT. Until
        2026-10-24 this unpacked every answer as eye.side (56) patches a side;
        a native read at 4096 px returns 256 x 256, and patches_of keeps the
        LAST side*side tokens -- so the live server laid the bottom twelve rows
        of the condo complex's grid across the whole lot, as horizontal
        stripes (the owner's press on release v7). Training unpacked it by
        S // patch (extract_features.py) and was never affected."""
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            photo.save(f.name)
            tensor, cover = extract_features.as_tensor(f.name, size)
        long_m = padded_side_metres(span, cover)
        mpp = (long_m / size) if self.eye.wants_scale else 0.0
        hidden = self.eye.look(tensor, mpp)
        side = int(size) // int(self.eye.patch)
        flat, dim, _ = extract_features.patches_of(hidden, side)
        return flat.reshape(side, side, dim), cover

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
            rec["windows"] = int(getattr(self, "last_windows", 1))

            t0 = time.time()
            can = self.canopy(photo, prep["span"], prep["down"])
            t["canopy"] = round(time.time() - t0, 1)

            t0 = time.time()
            meta = self.release.meta
            x = grid
            if meta.get("fuse"):
                fuse_can = can if meta.get("fuseCanopy") else None
                # The lidar's ground brightness (S38) only for a release trained with it.
                # A leaf-on flight (S68, alpha_sources.LEAF_ON_SHARE): the decoder
                # reads it as no lidar, as its training dropout shows it; the
                # veto and stage 3 still read height/roof/void.png above.
                to_decoder = lidar_for_decoder(rec, lidar)
                rec["lidarToDecoder"] = to_decoder is not None
                extra = extra_channels(gw, gh, cover[0], cover[1], lidar=to_decoder, ndvi=ndvi, ndvi_valid=valid, canopy=fuse_can,
                                       with_intensity=bool(meta.get("fuseIntensity")))
                x = np.concatenate([grid, extra.transpose(1, 2, 0)], axis=2)
            cells_w, cells_h = int(prep["w"]), int(prep["h"])
            L = {
                "x": torch.from_numpy(np.ascontiguousarray(x.transpose(2, 0, 1))),
                "cells": (cells_w, cells_h),
                "cover": cover,
                "rgb": np.asarray(photo.convert("RGB").resize((cells_w, cells_h), Image.BOX)),
            }
            prob = self.release.answer(L)
            t["decoder"] = round(time.time() - t0, 1)

        Image.fromarray(can.astype(np.uint8) * 255).save(os.path.join(out_dir, "canopy.png"))
        Image.fromarray(np.clip(np.round(prob * 255), 0, 255).astype(np.uint8), mode="L").save(
            os.path.join(out_dir, "prob.png"))
        rec["seconds"] = t
        return rec
