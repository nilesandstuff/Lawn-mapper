"""
EVERY LABELLER AGAINST THE OWNER'S NAMES, KIND BY KIND (core session, 2026-11-27).

The owner named the shapes of the home walk on the naming page (seg-names.json), and said how: shapes poorly seen or
holding two unrelated things were left unnamed; a low plant sharing a ground shape was named for the ground; deck
boards, windows and the like were named for the whole (deck, house); an evergreen sharing a shape with leafless trees
was called tree. And of the labellers: "arcore's scene semantics was by far the best in both categories [cutting and
naming], just that it lacks the specific object classes that we need."

So the owner's names are the answer key, and each labeller is scored on the PIXELS of the named shapes (a shape is
the owner's unit, but deck boards are many small shapes: pixels weigh a board by its size):
    phone      ARCore's scene semantics (key-NNNN.sem, the 12 labels the app keeps with each picture)
    panoptic   Mask2Former's classes (kept with the shapes, segments-masks.npz)
    segformer  SegFormer-B0 on ADE20K (the small labeller, phone-sized)
    clipseg    CLIPSeg told the yard's things in words (yard_labels.py's model)
    owl        OWLv2 boxes for the same words, a pixel taking the surest box over it
    phone+X    the owner's idea (2026-11-26): the phone's broad label, broken up by X where X's kind is of the same
               broad kind; else the phone's own.
Two scores for each named kind: BROAD (built / fence / ground / plant / sky / water / movable) and FINE (house, deck,
grass, mulch, paving...). A labeller with no word for a kind cannot get it right: that is the measurement.

And the owner's "ground was the least reliably segmented": of the pixels the phone calls each broad kind, the share
inside any shape at all.

    python scan/tools/names_score.py <twin dir> [--no-models]

Counts, shares and kind names only: no place, no picture. The owner's own words are printed only as plain letters.
"""
import json
import os
import re
import sys
import time

import numpy as np

# ---------------------------------------------------------------- kinds

BROAD = {"house": "built", "deck": "built", "stairs": "built", "shed": "built", "hot tub": "built", "planter": "built",
         "retaining wall": "built", "equipment": "movable", "pergola": "built", "fence": "fence", "pool": "water",
         "water": "water", "grass": "ground", "mulch": "ground", "bare ground": "ground", "paving": "ground",
         "rock": "ground", "tree": "plant", "shrub": "plant", "sky": "sky", "vehicle": "movable",
         "furniture": "movable", "person": "movable",
         # the phone's own broad answers where it has no finer word: never the owner's kind, so never right on FINE
         "ground (any)": "ground", "built (any)": "built"}
FINE = list(BROAD)
# words -> a fine kind (the owner's words, and every labeller's own; plurals and "-merged"/"-other" stripped first)
WORD = {k: k for k in FINE}
for kind, words in {
    "house": ["building", "home", "wall", "siding", "window", "windowpane", "door", "garage", "garage door", "roof",
              "gutter", "downspout", "chimney", "brick", "brick wall", "foundation", "shutter", "trim", "soffit", "eave",
              "column", "pillar", "screen door", "double door", "skyscraper", "hovel", "tower", "awning", "ceiling",
              "house wall", "wall of a house", "wall brick", "wall stone", "wall wood", "wall other", "wall panel",
              "wall tile", "building other", "window other", "window blind", "door stuff", "porch roof", "canopy",
              "structure"],
    "deck": ["deck board", "decking", "porch", "balcony", "railing", "bannister", "floor", "floor wood", "platform",
             "wooden deck", "deck railing", "pier", "stage", "board"],
    "stairs": ["step", "steps", "stair", "stairway", "staircase", "outdoor wooden stairs"],
    "shed": ["garden shed", "outbuilding", "playhouse"],
    "hot tub": ["hottub", "spa", "jacuzzi", "bathtub"],
    "planter": ["raised bed", "raised garden bed", "garden bed", "planter box"],
    "retaining wall": ["stone wall", "block wall"],
    "pergola": ["gazebo", "arbor", "trellis"],
    "equipment": ["ac unit", "air conditioner", "air conditioner unit", "utility box", "electrical box", "transformer",
                  "machine", "machinery", "grill", "trash can", "trash bin", "bin", "ashcan", "barrel", "hose",
                  "garden hose", "box", "tank", "pole", "light", "streetlight", "signboard", "mailbox", "equipment",
                  "machine/equipment", "lamp", "pot", "potted plant", "vase", "basket", "bucket", "plaything", "toy"],
    "fence": ["fence merged", "privacy fence", "gate", "chain link", "chain-link", "chain link fence", "wooden fence",
              "vinyl fence", "wooden or vinyl privacy fence"],
    "pool": ["swimming pool", "pool cover", "above ground pool"],
    "water": ["river", "lake", "sea", "puddle", "fountain"],
    "grass": ["lawn", "turf", "grass merged", "grass lawn", "field", "playingfield", "yard"],
    "mulch": ["wood chip", "wood chips", "pine straw", "bark"],
    "bare ground": ["ground", "dirt", "dirt merged", "soil", "bare soil", "earth", "gravel", "sand", "leaves", "leaf",
                    "leaf litter", "fallen leaves", "dirt track", "land", "mud", "bare dirt", "terrain"],
    "paving": ["concrete", "driveway", "sidewalk", "patio", "paver", "pavers", "asphalt", "pavement",
               "pavement merged", "road", "path", "walkway", "runway", "concrete slab", "flagstone",
               "paved driveway or sidewalk", "a paved driveway or sidewalk"],
    "rock": ["rock merged", "stone", "boulder", "mountain", "hill"],
    "tree": ["tree merged", "trunk", "tree trunk", "branch", "evergreen", "pine", "palm", "trees", "evergreen tree",
             "deciduous tree"],
    "shrub": ["bush", "hedge", "plant", "flower", "flowers", "flower bed", "vegetation", "ivy", "weed", "weeds",
              "evergreen shrub", "ground cover", "groundcover"],
    "sky": ["sky other", "sky other merged", "cloud", "clouds", "the sky"],
    "vehicle": ["car", "truck", "van", "bus", "trailer", "boat", "bicycle", "motorcycle", "minibike"],
    "furniture": ["chair", "table", "bench", "dining table", "patio furniture", "umbrella", "couch", "sofa", "seat",
                  "armchair", "swivel chair", "stool", "tent", "cushion"],
    "person": ["people", "animal", "dog", "cat"],
}.items():
    for w in words:
        WORD[w] = kind
# the phone's 12 labels -> (broad, the fine kind it means when nothing finer is known)
PHONE = ["unlabeled", "sky", "building", "tree", "road", "sidewalk", "terrain", "structure", "object", "vehicle", "person", "water"]
PHONE_BROAD = {1: "sky", 2: "built", 3: "plant", 4: "ground", 5: "ground", 6: "ground", 7: "built", 8: "movable",
               9: "movable", 10: "movable", 11: "water"}
PHONE_FINE = {1: "sky", 2: "house", 3: "tree", 4: "paving", 5: "paving", 6: "ground (any)", 7: "built (any)", 8: "equipment",
              9: "vehicle", 10: "person", 11: "water"}
BROADS = ["built", "fence", "ground", "plant", "sky", "water", "movable"]
# what CLIPSeg and OWLv2 are asked, and the kind each answer is
ASK = [("the wall of a house", "house"), ("a window", "house"), ("a roof", "house"), ("a door", "house"),
       ("a garage", "house"), ("a wooden deck", "deck"), ("a deck railing", "deck"), ("outdoor wooden stairs", "stairs"),
       ("a garden shed", "shed"), ("a hot tub", "hot tub"), ("a swimming pool", "pool"), ("a raised garden bed", "planter"),
       ("a retaining wall", "retaining wall"), ("a pergola", "pergola"),
       ("a wooden or vinyl privacy fence", "fence"), ("a chain-link fence", "fence"),
       ("an air conditioner unit", "equipment"), ("a green electrical utility box", "equipment"), ("a trash can", "equipment"),
       ("grass lawn", "grass"), ("mulch", "mulch"), ("bare soil", "bare ground"), ("fallen leaves", "bare ground"),
       ("gravel", "bare ground"), ("a paved driveway or sidewalk", "paving"), ("a concrete patio", "paving"),
       ("a tree", "tree"), ("a tree trunk", "tree"), ("a bush", "shrub"), ("the sky", "sky"), ("a car", "vehicle"),
       ("patio furniture", "furniture")]
SURE = 0.4           # CLIPSeg: a pixel is a word where its sigmoid is this or more and the highest of all
OWL_LEAST = 0.12


def kind_of(word):
    """A word (the owner's or a labeller's) -> a fine kind, or None."""
    w = re.sub(r"[-_]+", " ", (word or "").strip().lower())
    w = re.sub(r"\b(merged|other|stuff)\b", "", w).strip()
    w = re.sub(r"\s+", " ", w)
    for c in (w, w[:-1] if w.endswith("s") else w, w[:-2] if w.endswith("es") else w, re.sub(r"^(a|an|the) ", "", w)):
        if c in WORD:
            return WORD[c]
    return None


def plain(n):
    n = (n or "").strip().lower()
    return n if re.fullmatch(r"[a-z /-]{1,24}", n) else "(other)"


# ---------------------------------------------------------------- the labellers, each -> a fine-kind index map per picture

def resize_nearest(a, shape):
    h, w = shape
    jj = np.clip(((np.arange(h) + 0.5) / h * a.shape[0]).astype(int), 0, a.shape[0] - 1)
    ii = np.clip(((np.arange(w) + 0.5) / w * a.shape[1]).astype(int), 0, a.shape[1] - 1)
    return a[jj][:, ii]


def lut_of(names):
    """{id: word} -> a lookup array id -> 1 + fine index (0 nothing)."""
    top = max([int(i) for i in names] + [0])
    lut = np.zeros(top + 1, np.uint8)
    for i, word in names.items():
        k = kind_of(word)
        if k:
            lut[int(i)] = 1 + FINE.index(k)
    return lut


def phone_maps(d, photos, shape_of):
    out, phone_lab = [], []
    lut = np.zeros(256, np.uint8)
    for i, k in PHONE_FINE.items():
        lut[i] = 1 + FINE.index(k)
    for p, nm in enumerate(photos):
        f = os.path.join(d, nm.replace(".jpg", ".sem")) if nm else ""
        if not f or not os.path.isfile(f):
            out.append(None); phone_lab.append(None)
            continue
        b = np.fromfile(f, dtype=np.uint8)
        nx, ny = int(b[0]) | (int(b[1]) << 8), int(b[2]) | (int(b[3]) << 8)
        if len(b) < 4 + nx * ny:
            out.append(None); phone_lab.append(None)
            continue
        lab = b[4:4 + nx * ny].reshape(ny, nx)
        if len(b) >= 4 + 2 * nx * ny:
            lab = np.where(b[4 + nx * ny:4 + 2 * nx * ny].reshape(ny, nx) >= 128, lab, 0)   # the surfaces' own test: sure cells only
        lab = resize_nearest(lab, shape_of[p])
        phone_lab.append(lab)
        out.append(lut[lab])
    return out, phone_lab


def panoptic_maps(z, n):
    if "pan" not in z or "names" not in z:
        return None
    names = json.loads(str(z["names"]))
    out = []
    for p in range(n):
        lut = lut_of(names[p])
        m = z["pan"][p]
        out.append(lut[np.clip(m, 0, len(lut) - 1)] * (m < len(lut)))
    return out


def segformer_maps(d, photos, shape_of, torch, log):
    from PIL import Image
    from transformers import AutoImageProcessor, SegformerForSemanticSegmentation
    mid = "nvidia/segformer-b0-finetuned-ade-512-512"
    proc = AutoImageProcessor.from_pretrained(mid)
    model = SegformerForSemanticSegmentation.from_pretrained(mid).eval()
    lut = lut_of({int(i): w for i, w in model.config.id2label.items()})
    out, t0 = [], time.time()
    for p, nm in enumerate(photos):
        img = Image.open(os.path.join(d, nm)).convert("RGB")
        with torch.no_grad():
            lg = model(**proc(images=img, return_tensors="pt")).logits[0]
        out.append(lut[resize_nearest(lg.argmax(0).numpy(), shape_of[p])])
    log(f"  segformer: {len(photos)} pictures in {time.time() - t0:.0f} s")
    return out


def clipseg_maps(d, photos, shape_of, torch, log):
    from PIL import Image
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
    mid = "CIDAS/clipseg-rd64-refined"
    proc = CLIPSegProcessor.from_pretrained(mid)
    model = CLIPSegForImageSegmentation.from_pretrained(mid).eval()
    words = [w for w, _ in ASK]
    lut = np.array([0] + [1 + FINE.index(k) for _, k in ASK], np.uint8)
    with torch.no_grad():
        tx = proc.tokenizer(words, padding=True, return_tensors="pt")
        cond = model.get_conditional_embeddings(batch_size=len(words), input_ids=tx["input_ids"], attention_mask=tx["attention_mask"])
    out, t0 = [], time.time()
    for p, nm in enumerate(photos):
        img = Image.open(os.path.join(d, nm)).convert("RGB")
        with torch.no_grad():
            pv = proc.image_processor(images=[img], return_tensors="pt")["pixel_values"]
            vo = model.clip.vision_model(pixel_values=pv, output_hidden_states=True, return_dict=True)
            acts = [vo.hidden_states[i + 1].expand(len(words), -1, -1) for i in model.extract_layers]
            pr = torch.sigmoid(model.decoder(acts, cond, return_dict=True).logits).numpy()
        best, top = pr.argmax(0), pr.max(0)
        ix = np.where(top >= SURE, best + 1, 0)
        out.append(lut[resize_nearest(ix, shape_of[p])])
    log(f"  clipseg: {len(photos)} pictures in {time.time() - t0:.0f} s")
    return out


def owl_maps(d, photos, shape_of, torch, log):
    from PIL import Image
    from transformers import Owlv2ForObjectDetection, Owlv2Processor
    mid = "google/owlv2-base-patch16-ensemble"
    proc = Owlv2Processor.from_pretrained(mid)
    model = Owlv2ForObjectDetection.from_pretrained(mid).eval()
    phrases = [f"a photo of {w}" for w, _ in ASK]
    out, t0 = [], time.time()
    for p, nm in enumerate(photos):
        img = Image.open(os.path.join(d, nm)).convert("RGB")
        with torch.no_grad():
            o = model(**proc(text=[phrases], images=img, return_tensors="pt"))
        side = max(img.height, img.width)                     # the processor pads the picture to a square
        r = proc.post_process_object_detection(o, threshold=OWL_LEAST, target_sizes=torch.tensor([[side, side]]))[0]
        H, W = shape_of[p]
        sx, sy = W / img.width, H / img.height
        m, sc = np.zeros((H, W), np.uint8), np.zeros((H, W), np.float32)
        for (x0, y0, x1, y1), s, lb in zip(r["boxes"].numpy(), r["scores"].numpy(), r["labels"].numpy()):
            a0, a1 = int(max(0, x0 * sx)), int(min(W, x1 * sx + 1))
            b0, b1 = int(max(0, y0 * sy)), int(min(H, y1 * sy + 1))
            if a1 <= a0 or b1 <= b0:
                continue
            win = sc[b0:b1, a0:a1] < s
            m[b0:b1, a0:a1][win] = 1 + FINE.index(ASK[int(lb)][1])
            sc[b0:b1, a0:a1][win] = s
        out.append(m)
    log(f"  owl: {len(photos)} pictures in {time.time() - t0:.0f} s")
    return out


def combine(phone, fine):
    """The phone's broad label, broken up by a finer labeller where the finer one's kind is of the same broad kind."""
    out = []
    bro = np.array(["none"] + [BROAD[k] for k in FINE])
    for a, b in zip(phone, fine):
        if a is None or b is None:
            out.append(a)
            continue
        out.append(np.where((b > 0) & (bro[b] == bro[a]) & (a > 0), b, a))
    return out


# ---------------------------------------------------------------- the score

def owner_maps(d, seg, names):
    """Each picture's shape map (seg-NNNN.png, what the page showed) -> the owner's fine kind per pixel (0 not named),
    with the shapes named, by kind and word."""
    from PIL import Image
    th_names, sh_names = names.get("names", {}), names.get("shapes", {})
    maps, shape_maps, words, unmapped, n_named, n_shapes = [], [], {}, {}, 0, 0
    for p, pic in enumerate(seg["pictures"]):
        f = os.path.join(d, f"seg-{p:04d}.png")
        if not os.path.exists(f):
            maps.append(None); shape_maps.append(None)
            continue
        rg = np.asarray(Image.open(f).convert("RGB"))
        m = (rg[..., 0].astype(np.int32) << 8) | rg[..., 1]
        lut = np.zeros(int(m.max()) + 1, np.uint8)
        for sid, (thing, px, cells) in pic["shapes"].items():
            n_shapes += 1
            own = sh_names.get(f"{p}:{sid}")
            nm = own if own is not None else th_names.get(str(thing), "")
            if not nm:
                continue
            k = kind_of(nm)
            words[plain(nm)] = words.get(plain(nm), 0) + 1
            if not k:
                unmapped[plain(nm)] = unmapped.get(plain(nm), 0) + 1
                continue
            n_named += 1
            if int(sid) < len(lut):
                lut[int(sid)] = 1 + FINE.index(k)
        maps.append(lut[m])
        shape_maps.append(m)
    return maps, shape_maps, words, unmapped, n_named, n_shapes


def score(truth, labellers, log=print):
    """Per owner kind: pixels, and for each labeller the share of them it gave the same broad and the same fine kind,
    and what it said most where it was wrong."""
    bro = np.array(["none"] + [BROAD[k] for k in FINE])
    tot = np.zeros(len(FINE) + 1, np.int64)
    res = {nm: {"fine": np.zeros(len(FINE) + 1, np.int64), "broad": np.zeros(len(FINE) + 1, np.int64),
                "said": np.zeros((len(FINE) + 1, len(FINE) + 1), np.int64)} for nm in labellers}
    for p, t in enumerate(truth):
        if t is None:
            continue
        on = t > 0
        if not on.any():
            continue
        tv = t[on]
        tot += np.bincount(tv, minlength=len(FINE) + 1)
        for nm, maps in labellers.items():
            lm = maps[p] if maps is not None else None
            if lm is None:
                continue
            lv = lm[on]
            r = res[nm]
            r["fine"] += np.bincount(tv[lv == tv], minlength=len(FINE) + 1)
            r["broad"] += np.bincount(tv[(lv > 0) & (bro[lv] == bro[tv])], minlength=len(FINE) + 1)
            np.add.at(r["said"], (tv, lv), 1)
    kinds = [i for i in np.argsort(-tot) if tot[i] > 0 and i > 0]
    names = list(labellers)
    pct = lambda a, b: f"{100 * a / max(1, b):.0f}%"
    log(f"  OVERALL, pixels of every named kind together ({int(tot.sum()):,}): " + "; ".join(
        f"{nm} broad {pct(res[nm]['broad'].sum(), tot.sum())}, fine {pct(res[nm]['fine'].sum(), tot.sum())}" for nm in names) + ".")
    for i in kinds:
        k = FINE[i - 1]
        parts = []
        for nm in names:
            r = res[nm]
            wrong = r["said"][i].copy(); wrong[i] = 0
            w = int(wrong.argmax())
            miss = f", else mostly {'nothing' if w == 0 else FINE[w - 1]} {pct(wrong[w], tot[i])}" if wrong[w] else ""
            parts.append(f"{nm} {pct(r['broad'][i], tot[i])}/{pct(r['fine'][i], tot[i])}{miss}")
        log(f"  {k:<14} ({BROAD[k]}, {int(tot[i]):,} px): " + "; ".join(parts) + ".")
    return res, tot


def coverage(phone_lab, shape_maps, truth, log=print):
    """Of the pixels the phone calls each broad kind, the share inside any shape, and inside a named one."""
    n = {b: np.zeros(3, np.int64) for b in BROADS}
    for lab, sm, t in zip(phone_lab, shape_maps, truth):
        if lab is None or sm is None or t is None:
            continue
        for i, b in PHONE_BROAD.items():
            on = lab == i
            if on.any():
                n[b] += (on.sum(), (on & (sm > 0)).sum(), (on & (t > 0)).sum())
    log("  THE CUT, by what the phone calls the pixels: share inside a shape (and inside a named one): " + "; ".join(
        f"{b} {100 * v[1] / v[0]:.0f}% ({100 * v[2] / v[0]:.0f}%)" for b, v in n.items() if v[0]) + ".")
    return n


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "twin"
    no_models = "--no-models" in sys.argv
    sf, nf, mf = (os.path.join(d, x) for x in ("seg.json", "seg-names.json", "segments-masks.npz"))
    if not (os.path.exists(sf) and os.path.exists(nf)):
        print("NAMES SCORED: no names on this walk.")
        return
    seg, names = json.load(open(sf)), json.load(open(nf))
    truth, shape_maps, words, unmapped, n_named, n_shapes = owner_maps(d, seg, names)
    photos = [p["photo"] for p in seg["pictures"]]
    keep = [p for p, t in enumerate(truth) if t is not None and (t > 0).any()]
    print(f"THE OWNER'S NAMES AS THE ANSWER KEY: {n_named:,} of {n_shapes:,} shapes named with a kind, in {len(keep)} of {len(photos)} photos.")
    often = sorted(((w, c) for w, c in words.items() if c >= 2), key=lambda x: -x[1])
    print("  The names used (twice or more): " + ", ".join(f"{w} {c}" for w, c in often[:40]) + ".")
    if unmapped:
        print("  Names with no kind (left out of the score): " + ", ".join(f"{w} {c}" for w, c in sorted(unmapped.items(), key=lambda x: -x[1]) if c >= 2) + ".")
    # only the photos with a name are labelled (the models' time)
    sub = lambda maps: [maps[p] if maps is not None and p in keep else None for p in range(len(photos))]
    shape_of = [m.shape if m is not None else None for m in shape_maps]
    labellers = {}
    phone, phone_lab = phone_maps(d, [photos[p] if p in keep else "" for p in range(len(photos))], shape_of)
    if any(x is not None for x in phone):
        labellers["phone"] = phone
    if os.path.exists(mf):
        z = np.load(mf, allow_pickle=False)
        pm = panoptic_maps(z, len(photos))
        if pm is not None:
            labellers["panoptic"] = [resize_nearest(x, shape_of[p]) if x is not None and shape_of[p] and x.shape != shape_of[p] else x for p, x in enumerate(sub(pm))]
    if not no_models:
        import torch
        torch.set_num_threads(os.cpu_count() or 2)
        kp = [photos[p] for p in keep]
        ks = [shape_of[p] for p in keep]
        for nm, fn in (("segformer", segformer_maps), ("clipseg", clipseg_maps), ("owl", owl_maps)):
            try:
                got = fn(d, kp, ks, torch, print)
            except Exception as e:
                print(f"  {nm}: could not be run ({str(e)[:100]}).")
                continue
            full = [None] * len(photos)
            for p, g in zip(keep, got):
                full[p] = g
            labellers[nm] = full
    if "phone" in labellers:
        for nm in [x for x in labellers if x != "phone"]:
            labellers[f"phone+{nm}"] = combine(labellers["phone"], labellers[nm])
    print("EACH LABELLER AGAINST THE NAMES, per kind: the share of the kind's pixels given the same BROAD kind / the same FINE kind, and what it said most where it was wrong:")
    score(truth, labellers)
    if "phone" in labellers:
        coverage(phone_lab, shape_maps, truth)
    # the phone's labels sit on the pictures the right way (sem_check.py's test, by the panoptic model's broad kinds)
    if "phone" in labellers and "panoptic" in labellers:
        bro = np.array(["none"] + [BROAD[k] for k in FINE])
        a = b = 0
        flip = 0
        for x, y in zip(labellers["phone"], labellers["panoptic"]):
            if x is None or y is None:
                continue
            on = (x > 0) & (y > 0)
            a += (on & (bro[x] == bro[y])).sum(); b += on.sum()
            yf = y[::-1]
            flip += ((x > 0) & (yf > 0) & (bro[x] == bro[yf])).sum()
        print(f"  The phone and the panoptic model give the same broad kind on {100 * a / max(1, b):.0f}% of the pixels both label (upside down: {100 * flip / max(1, b):.0f}%: the labels sit the right way if the first is the higher).")


if __name__ == "__main__":
    main()
