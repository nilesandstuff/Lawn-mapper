"""
THE YARD'S THINGS BY NAME (core session, 2026-11-27). The owner, after the structures made from the lidar's shapes:
"I don't think the dimension based rules for what is deck will work. My deck has 2 levels, one that's about 5 feet
off the ground and another that's about 10 feet off the ground. Then there's a wooden staircase... So I think it needs
vision labels to determine what is deck. And we'll need more labels for objects around yards to see whether they fall
into solid or open (for example, a transformer box and raised garden planter are solid, a sandbox is open. And fences
are their own things with only a couple inches of depth)."

Neither labeller the walks have knows a deck, a hot tub, a sandbox or a planter (ADE20K's 150 classes). CLIPSeg
(CIDAS/clipseg-rd64-refined, in transformers itself, no remote code; 150 M parameters, a second or so a picture on the
free CPU) is told the things in plain words and says, for each, where in the picture it is. Each picture's answer is
put on its own 72 x 128 depth grid (the cells surfaces.py casts), and every picture of a walk is kept in ONE file,
yard-labels.npz beside the walk (labelled once; a picture already in it is not labelled again unless the words
change, VERSION).

    python scan/tools/yard_labels.py <twin dir> [<twin dir> ...]

Prints counts only: pictures, and for each thing the pictures holding it.
"""
import json
import os
import re
import sys

import numpy as np

MODEL = "CIDAS/clipseg-rd64-refined"
VERSION = 1
# (name, the words, what it is for the map: solid / open / fence / pool / ground or plant, the last never a structure)
THINGS = [
    ("house", "the wall of a house", "solid"),
    ("garage", "a garage", "solid"),
    ("shed", "a garden shed", "solid"),
    ("hot tub", "a hot tub", "solid"),
    ("utility box", "a green electrical utility box", "solid"),
    ("ac unit", "an air conditioner unit", "solid"),
    ("planter", "a raised garden bed", "solid"),
    ("retaining wall", "a retaining wall", "solid"),
    ("deck", "a wooden deck", "open"),
    ("stairs", "outdoor wooden stairs", "open"),
    ("sandbox", "a sandbox", "open"),
    ("fence", "a fence", "fence"),
    ("pool", "a swimming pool", "pool"),
    ("lawn", "grass lawn", "ground"),
    ("paving", "a paved driveway or sidewalk", "ground"),
    ("tree", "a tree", "plant"),
    ("shrub", "a bush", "plant"),
    ("sky", "the sky", "ground"),
]
SURE = 0.4          # a cell is a thing where the model's sigmoid for it is this or more and the highest of all


def read_keys(d):
    keys = []
    for n in sorted(x for x in os.listdir(d) if re.fullmatch(r"keys-\d+\.json", x)):
        keys += json.load(open(os.path.join(d, n)))
    return keys


def label_dir(d, model, proc, torch):
    from PIL import Image
    path = os.path.join(d, "yard-labels.npz")
    have = {}
    if os.path.exists(path):
        try:
            z = np.load(path, allow_pickle=False)
            if int(z["version"]) == VERSION:
                for nm, ix, cf in zip(json.loads(str(z["pics"])), z["idx"], z["conf"]):
                    have[nm] = (ix, cf)
        except Exception:
            have = {}
    words = [w for _, w, _ in THINGS]
    # the words once (CLIP's text side), and each picture's own side once for all of them: the decoder alone runs per
    # word (7 s a picture on four cores the plain way, the picture's side redone for every word)
    with torch.no_grad():
        tx = proc.tokenizer(words, padding=True, return_tensors="pt")
        cond = model.get_conditional_embeddings(batch_size=len(words), input_ids=tx["input_ids"], attention_mask=tx["attention_mask"])
    new = 0
    for k in read_keys(d):
        nm = k["name"]
        fj, fr = os.path.join(d, nm), os.path.join(d, nm.replace(".jpg", ".rdepth"))
        if nm in have or not (os.path.exists(fj) and os.path.exists(fr)):
            continue
        r = np.fromfile(fr, dtype="<u2", count=2)
        nx, ny = int(r[0]), int(r[1])
        if nx != 72 or ny != 128:
            continue
        img = Image.open(fj).convert("RGB")
        with torch.no_grad():
            pv = proc.image_processor(images=[img], return_tensors="pt")["pixel_values"]
            vo = model.clip.vision_model(pixel_values=pv, output_hidden_states=True, return_dict=True)
            acts = [vo.hidden_states[i + 1].expand(len(words), -1, -1) for i in model.extract_layers]
            pr = torch.sigmoid(model.decoder(acts, cond, return_dict=True).logits).numpy()   # (things, 352, 352), the picture squashed square
        h, w = pr.shape[1:]
        jj, ii = np.mgrid[0:ny, 0:nx]
        q = pr[:, np.clip(((jj + 0.5) / ny * h).astype(int), 0, h - 1), np.clip(((ii + 0.5) / nx * w).astype(int), 0, w - 1)]
        best = q.argmax(0); top = q.max(0)
        ix = np.where(top >= SURE, best + 1, 0).astype(np.uint8)
        have[nm] = (ix, np.round(top * 255).astype(np.uint8))
        new += 1
    if have:
        names = sorted(have)
        np.savez_compressed(path, version=VERSION, pics=json.dumps(names), things=json.dumps(THINGS),
                            idx=np.stack([have[n][0] for n in names]), conf=np.stack([have[n][1] for n in names]))
    return have, new


def main():
    dirs = [x for x in sys.argv[1:] if os.path.isdir(x)]
    import torch
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
    torch.set_num_threads(os.cpu_count() or 2)
    proc = CLIPSegProcessor.from_pretrained(MODEL)
    model = CLIPSegForImageSegmentation.from_pretrained(MODEL).eval()
    for d in dirs:
        have, new = label_dir(d, model, proc, torch)
        if not have:
            print(f"  THE YARD'S THINGS BY NAME, {os.path.basename(os.path.normpath(d))}: no pictures to label.")
            continue
        held = np.zeros(len(THINGS) + 1, int)
        for ix, _ in have.values():
            c = np.bincount(ix.ravel(), minlength=len(THINGS) + 1)
            held += c >= 0.01 * ix.size
        print(f"  THE YARD'S THINGS BY NAME, {os.path.basename(os.path.normpath(d))}: {len(have)} pictures ({new} labelled now); pictures holding each (1% of the picture or more): "
              + ", ".join(f"{THINGS[i][0]} {held[i + 1]}" for i in range(len(THINGS)) if THINGS[i][2] in ("solid", "open", "fence", "pool")) + ".")


if __name__ == "__main__":
    main()
