"""
Every tree crown on a lot, as its own shape.

WHAT IT IS FOR. The plan is to hand a tracer each crown as a toggle -- on means
grass underneath, off means ignore it -- which turns the slowest part of tracing
a wooded lawn into a row of taps. This is the half that finds the crowns.
Nothing here decides which way a toggle should start; that is the tracer's
judgement and the whole point of the design.

WHY THE SEMANTIC MODEL AND NOT THE INSTANCE ONE, which is a real trade and not
a shortcut. Restor publish both. `tcd-mask-rcnn-r50` delineates crowns
directly and is the better answer on paper -- and it loads with **detectron2**,
a source build pinned to particular torch versions, which is a day of CI
fighting for a step whose entire purpose is to be cheap enough to throw away.
`tcd-segformer-*` loads with plain `transformers` and gives a tree/no-tree
raster, which this then splits into crowns with a watershed.

The two disagree in exactly one place: touching crowns. And the instance
model's own card says it *"cannot delineate all trees in situations where tree
crowns are touching"* either -- it is built for pre-canopy-closure work. So
for the case that matters here, an isolated tree standing in a lawn, both
approaches do the same thing. If the pictures look promising, detectron2 is
then worth the fight; if they do not, a day was saved.

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
from skimage.feature import peak_local_max
from skimage.measure import approximate_polygon, find_contours
from skimage.segmentation import watershed
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

IMAGES = Path(os.environ.get("IMAGES", "frames"))
OUT = Path(os.environ.get("OUT", "crowns"))
MODEL = os.environ.get("MODEL", "restor/tcd-segformer-mit-b5")

# What the model was trained on. See the note above.
TARGET_MPP = float(os.environ.get("TARGET_MPP", "0.1"))

# Bounds on the resample, so a tiny lot does not become a postage stamp and a
# farm does not become a gigapixel.
MIN_PX, MAX_PX = 256, 2048

# A crown smaller than this is a bush, a shadow or a speckle. Four square
# metres is a canopy about 2.3 m across.
MIN_CROWN_M2 = float(os.environ.get("MIN_CROWN_M2", "4"))

# HOW FAR APART TWO CROWNS MUST BE TO COUNT AS TWO. In metres, not pixels,
# because the whole reason for the resample above is that pixels mean different
# things on different lots. Three metres is deliberately generous: splitting one
# broad tree into four is worse for a toggle list than leaving two touching
# trees joined, since the first makes four wrong taps and the second makes one.
CROWN_GAP_M = float(os.environ.get("CROWN_GAP_M", "3"))

# How closely a crown outline follows the mask, in metres. The toggles are tap
# targets, not measurements, and a 400-vertex blob is slow to draw and slower
# to hit.
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


def crowns_for(mask, mpp):
    """
    Split a tree/no-tree mask into individual crowns.

    Distance transform, peaks, watershed -- the standard way, and the same
    shape of method the forestry literature applies to a canopy height model.
    It separates crowns that meet at a neck and does not separate crowns that
    genuinely merge, which is the documented limit of the instance model too.
    """
    if not mask.any():
        return np.zeros_like(mask, dtype=np.int32), 0

    distance = ndimage.distance_transform_edt(mask)
    min_distance = max(3, int(round(CROWN_GAP_M / mpp)))
    peaks = peak_local_max(
        distance, min_distance=min_distance, labels=mask, exclude_border=False
    )
    if len(peaks) == 0:
        # One blob with no interior peak: still a crown, just an awkward one.
        return ndimage.label(mask)[0].astype(np.int32), 1

    markers = np.zeros(distance.shape, dtype=np.int32)
    for n, (y, x) in enumerate(peaks, start=1):
        markers[y, x] = n
    labels = watershed(-distance, markers, mask=mask)
    return labels.astype(np.int32), int(labels.max())


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

        labels, count = crowns_for(mask, mpp)

        per_px_m2 = mpp * mpp
        min_px = MIN_CROWN_M2 / per_px_m2
        tolerance = max(1.0, SIMPLIFY_M / mpp)
        # Back to the frame's own pixels, which is what the browser and the
        # renderer both work in.
        to_frame = frame_px / target

        crowns = []
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
            crowns.append({
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

        crowns.sort(key=lambda c: -c["areaSqM"])
        (OUT / f"{lawn_id}.json").write_text(json.dumps({
            "id": lawn_id,
            "model": MODEL,
            "framePx": frame_px,
            "metresAcross": round(across, 1),
            "readAt": {"px": target, "mpp": round(mpp, 3)},
            "canopySqM": round(float(mask.sum()) * per_px_m2, 1),
            "crowns": crowns,
        }, indent=1))

        canopy_pct = 100.0 * mask.mean()
        totals.append((lawn_id, len(crowns), canopy_pct))
        print(f"  {lawn_id[:28]:30} {len(crowns):3} crowns  "
              f"{canopy_pct:5.1f}% canopy  read at {target}px ({mpp:.3f} m/px)")

    if not totals:
        print("\nNothing was read.")
        sys.exit(1)

    counts = [t[1] for t in totals]
    canopies = [t[2] for t in totals]
    print(f"\n{len(totals)} lawns. Crowns per lawn: "
          f"min {min(counts)}, median {sorted(counts)[len(counts) // 2]}, max {max(counts)}.")
    print(f"Canopy cover: {min(canopies):.0f}% to {max(canopies):.0f}% of the frame.")
    print(f"Written to {OUT}/.")


if __name__ == "__main__":
    main()
