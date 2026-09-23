"""
Where the tree canopy is, on every approved lawn.

WHAT IT IS FOR. Stage 2 of the four-stage plan in docs/DETECTOR-FINDINGS.md:
the detector finds grass it can SEE, this finds canopy, and the stage after
decides where lawn continues underneath. The canopy raster is the product.

THIS USED TO CUT THE CANOPY INTO CROWNS AND IT NO LONGER DOES, which is a
correction rather than a simplification. `tcd-segformer-*` is a SEMANTIC model:
it answers tree / no-tree per pixel and has no notion of where one tree ends.
The crowns it used to report came out of a watershed here -- a distance
transform, a peak finder and a gap parameter somebody chose -- so "63 crowns"
was a fact about that parameter and not about that lawn. It was reported as a
result anyway. See H18 and H19.

Restor do publish a real crown model, `tcd-mask-rcnn-r50`, and it was skipped
because detectron2 is a source build pinned to particular torch versions. That
trade was defensible; what was not was filling the gap with a watershed and
calling the output crowns.

So what is reported now is the canopy, plus its CONNECTED COMPONENTS -- clumps.
A clump is a contiguous patch of canopy and nothing more. Two trees whose
branches touch are one clump, and the name says so rather than implying a count
of trees.

SCALE IS SET DELIBERATELY, and this is the part most likely to be got wrong
silently. The model was trained at 10 cm a pixel. Our frames cover 25 m of
ground on a small lot and 194 m on the largest (H1), at a fixed pixel size, so
feeding them raw would hand it imagery between four times finer and twice
coarser than it has ever seen. Each frame is resampled to 10 cm a pixel first
and the crowns are mapped back afterwards. E2 is the same lesson from the other
direction: a model given the wrong ground size does not error, it quietly reads
a garden as a landscape.

    IMAGES=frames OUT=crowns python3 tools/tree-crowns.py
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy import ndimage
from skimage.measure import approximate_polygon, find_contours
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

IMAGES = Path(os.environ.get("IMAGES", "frames"))
OUT = Path(os.environ.get("OUT", "crowns"))
MODEL = os.environ.get("MODEL", "restor/tcd-segformer-mit-b5")

# What the model was trained on. See the note above.
TARGET_MPP = float(os.environ.get("TARGET_MPP", "0.1"))

# Bounds on the resample, so a tiny lot does not become a postage stamp and a
# farm does not become a gigapixel.
MIN_PX, MAX_PX = 256, 2048

# A clump smaller than this is a bush, a shadow or a speckle. Four square
# metres is a patch about 2.3 m across. It only affects the REPORTED clump
# list; the canopy raster itself is written whole, speckle included, because
# stage 3 works on the raster and should see what the model actually said.
MIN_CLUMP_M2 = float(os.environ.get("MIN_CLUMP_M2", "4"))

# How closely a clump outline follows the mask, in metres. These are shapes to
# look at, not measurements -- the measurements are taken on the raster -- and
# a 400-vertex blob is slow to draw and slower to read.
SIMPLIFY_M = float(os.environ.get("SIMPLIFY_M", "0.4"))


def tree_index(model):
    """
    Which label means tree, read from the model rather than assumed.

    A hard-coded 1 works right up until somebody swaps in a checkpoint whose
    labels are the other way round, and then every lawn is a forest and every
    forest is a lawn, with nothing in the output saying so.
    """
    labels = getattr(model.config, "id2label", None) or {}
    for k, v in labels.items():
        if "tree" in str(v).lower():
            return int(k)
    # Two classes and neither named: background first is the near-universal
    # convention, so the second is the thing being looked for.
    return 1 if len(labels) != 1 else 0


def clumps_for(mask):
    """
    The canopy's connected components.

    NO PARAMETER, which is the point. Two canopy pixels are in the same clump
    if you can walk between them through canopy; that is a property of the
    model's output and of nothing else. The watershed this replaced had a gap
    in metres that somebody picked, and every count it produced was partly a
    fact about that number.

    A clump is not a tree. Two trees that touch are one clump, and a tree split
    by a driveway running under it is two. The name is chosen to stop those
    being read as tree counts, which is what happened last time.
    """
    if not mask.any():
        return np.zeros_like(mask, dtype=np.int32), 0
    labels, count = ndimage.label(mask)
    return labels.astype(np.int32), int(count)


def main():
    frames = sorted(p for p in IMAGES.glob("*.png"))
    if not frames:
        print(f"No frames in {IMAGES}. The dump step writes them.")
        sys.exit(1)

    scale_file = IMAGES / "scale.json"
    if not scale_file.exists():
        # Same refusal as the Scale-MAE extractor, for the same reason: a wrong
        # ground size does not error, it silently reads the wrong thing.
        print("No scale.json beside the frames, so the ground size is unknown.")
        print("Every crown would be found at the wrong scale and nothing would say so.")
        sys.exit(1)
    spans = json.loads(scale_file.read_text())["frames"]

    print(f"Loading {MODEL}…")
    model = SegformerForSemanticSegmentation.from_pretrained(MODEL)
    model.eval()
    processor = SegformerImageProcessor.from_pretrained(MODEL, do_resize=False)
    want = tree_index(model)
    print(f"  tree is label {want} of {model.config.id2label}\n")

    OUT.mkdir(parents=True, exist_ok=True)
    totals = []

    for path in frames:
        lawn_id = path.stem
        across = spans.get(lawn_id)
        if not across:
            print(f"  {lawn_id[:28]}  no span in scale.json, skipped")
            continue

        img = Image.open(path).convert("RGB")
        frame_px = img.width

        # To the model's own scale, within the clamps.
        target = int(round(across / TARGET_MPP))
        target = max(MIN_PX, min(MAX_PX, target))
        mpp = across / target
        small = img.resize((target, target), Image.BILINEAR)

        inputs = processor(images=small, return_tensors="pt")
        with torch.no_grad():
            logits = model(**inputs).logits
        # SegFormer answers at a quarter of the input; put it back.
        logits = torch.nn.functional.interpolate(
            logits, size=(target, target), mode="bilinear", align_corners=False
        )
        mask = (logits.argmax(dim=1)[0].numpy() == want)

        labels, count = clumps_for(mask)

        per_px_m2 = mpp * mpp
        min_px = MIN_CLUMP_M2 / per_px_m2
        tolerance = max(1.0, SIMPLIFY_M / mpp)
        # Back to the frame's own pixels, which is what the browser and the
        # renderer both work in.
        to_frame = frame_px / target

        clumps = []
        for k in range(1, count + 1):
            blob = labels == k
            area = int(blob.sum())
            if area < min_px:
                continue
            contours = find_contours(blob.astype(float), 0.5)
            if not contours:
                continue
            outline = max(contours, key=len)
            outline = approximate_polygon(outline, tolerance=tolerance)
            if len(outline) < 4:
                continue
            ys, xs = np.nonzero(blob)
            clumps.append({
                "areaSqM": round(area * per_px_m2, 1),
                # [x, y] in the frame's pixels, which is the order everything
                # downstream uses. find_contours answers [row, col].
                "centre": [
                    round(float(xs.mean()) * to_frame, 1),
                    round(float(ys.mean()) * to_frame, 1),
                ],
                "polygon": [
                    [round(float(x) * to_frame, 1), round(float(y) * to_frame, 1)]
                    for y, x in outline
                ],
            })

        # THE PRODUCT. Everything else in this file is a way of looking at it.
        #
        # Stage 3 works on this raster, not on the clump outlines, so it is
        # written whole -- speckle, holes and all -- with nothing dropped for
        # being small. The clump list below is for reading and drawing.
        #
        # Written at the frame's own size so the drawing step does not have to
        # know what scale it was read at, and as 1-bit PNG, which for a mask
        # this size is a few kilobytes.
        Image.fromarray((mask * 255).astype(np.uint8)).resize(
            (frame_px, frame_px), Image.NEAREST
        ).convert("1").save(OUT / f"{lawn_id}-mask.png")

        clumps.sort(key=lambda c: -c["areaSqM"])
        (OUT / f"{lawn_id}.json").write_text(json.dumps({
            "id": lawn_id,
            "model": MODEL,
            "framePx": frame_px,
            "metresAcross": round(across, 1),
            "readAt": {"px": target, "mpp": round(mpp, 3)},
            "canopySqM": round(float(mask.sum()) * per_px_m2, 1),
            # WHETHER THIS FRAME WAS UPSAMPLED TO REACH THE MODEL'S SCALE.
            #
            # The stored photograph is a fixed pixel count whatever the lot, so
            # a big lot arrives coarser than 10 cm and asking for 10 cm
            # INVENTS pixels. The model is then being shown interpolation and
            # told it is imagery, which is E2's lesson and the most likely
            # reason the canopy reads worse on bigger lots. Recorded per lawn
            # so the question is answerable from the output instead of being
            # re-derived from the log every time.
            "sourceMpp": round(across / frame_px, 3),
            "upsampled": round(max(1.0, (across / frame_px) / mpp), 2),
            "clumps": clumps,
        }, indent=1))

        canopy_pct = 100.0 * mask.mean()
        source_mpp = across / frame_px
        up = source_mpp / mpp
        totals.append((lawn_id, len(clumps), canopy_pct, across, up))
        flag = f"  UPSAMPLED {up:.1f}x" if up > 1.05 else ""
        print(f"  {lawn_id[:28]:30} {len(clumps):3} clumps  "
              f"{canopy_pct:5.1f}% canopy  {across:5.0f} m across  "
              f"read at {target}px ({mpp:.3f} m/px){flag}")

    if not totals:
        print("\nNothing was read.")
        sys.exit(1)

    counts = [t[1] for t in totals]
    canopies = [t[2] for t in totals]
    print(f"\n{len(totals)} lawns. Canopy cover: "
          f"{min(canopies):.0f}% to {max(canopies):.0f}% of the frame.")
    print(f"Clumps per lawn (contiguous patches, NOT trees): "
          f"min {min(counts)}, median {sorted(counts)[len(counts) // 2]}, max {max(counts)}.")

    # THE RESOLUTION SPLIT, printed because it is the open question about this
    # step. A frame coarser than the model's 10 cm has to be upsampled to reach
    # it, and upsampling adds pixels rather than detail.
    up = [t for t in totals if t[4] > 1.05]
    if up:
        worst = max(up, key=lambda t: t[4])
        print(f"\n{len(up)} of {len(totals)} lawns were UPSAMPLED to reach the model's "
              f"10 cm, worst {worst[4]:.1f}x at {worst[3]:.0f} m across.")
        print("Those are the big lots, and upsampling invents pixels rather than")
        print("detail -- the first thing to rule out if the canopy reads worse there.")
    else:
        print(f"\nNo lawn was upsampled: every frame was at or finer than 10 cm.")
    print(f"\nWritten to {OUT}/.")


if __name__ == "__main__":
    main()
