"""
STUDIES OF A WALK, EACH KEPT UNDER ITS OWN NAME FOR THE OWNER'S EYES (core session, 2026-11-19).

The owner, leaving for six hours with up to $10 of Modal allowed: "Please use that time to experiment... Make to sure
to clearly flag inferences you make from looking at data that should have human eyes to confirm, then show them to me
later so I can make those judgements. And note that with the current way the studies are being displayed to me,
overwrites the previous study of that walk... So if you want to show me multiple studies, you'll have to print that
seperately."

So a study is a set of parts beside the walk's twin (private; the twin page shows each as a card of its own):
    study-<id>.json            { id, title, made, what, eyes: [what a person should judge, each a question],
                                 numbers: [lines], sheets: [{ file, title }] }
    study-<id>-<sheet>.jpg|png  its pictures
Nothing is overwritten by another study; the same id run again replaces itself.

THE STUDIES HERE (segment_study.py does the cutting and the lift; this names and draws):
    names    WHO NAMES A SHAPE BEST. The owner chose SAM objects as the cut; the panoptic vote "was not great", the
             cut-out namer "Irrevocably bad", and of it: "Maybe I was too quick to discard that small namer given it
             wasn't given a chance with the whole image context." Every namer below sees the WHOLE picture:
               panoptic   the vote of the panoptic model's pixels inside the shape (what the last sheets showed)
               phone      the vote of Google's scene labels on the walk's own points inside the shape (free, and what a
                          live page could do; the owner: "probably even just the google scene semantics")
               clipseg    CLIPSeg: for each of a yard's words a heat map over the whole picture; the shape takes the
                          word hottest inside it (the small picture-and-words model, with the whole picture)
               owl        OWLv2: an open-vocabulary detector's boxes for the same words; the shape takes the word of
                          the boxes it mostly fills
               marked     CLIP (its large one) shown a wide cut of the picture with the shape outlined and the rest
                          dimmed: the cut-out namer again, with its surroundings (the owner's own suggestion)
    map      WHAT THE WALK KNOWS, FROM ABOVE: every point the keep-by-name rule used, coloured by what the phone
             called it; the smoothed, the confirmed high and low spots and the left-out drawn apart.
    reach    THE LIFT WITH A LONGER REACH: a picture speaks for a point only where the picture's OWN depth (the grid
             kept with it, key-NNNN.depth) reads that point's distance; then 80 ft, beside the 26 ft lift.

    python scan/tools/studies.py twin --study names [--names twin/segments-names.json]
    python scan/tools/studies.py twin --study map
    python scan/tools/studies.py twin --study reach

COUNTS, SIZES AND NAMES ONLY in the log. Every guess of mine a person should check goes in the study's `eyes`.
"""

import json
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_study as S  # noqa: E402

FT = 3.281
# a yard's words: the name shown, and the phrase the picture-and-words models are asked with
WORDS = {
    "lawn": "grass lawn", "soil": "bare soil", "gravel": "gravel", "mulch": "mulch", "leaves": "fallen leaves",
    "pavement": "asphalt pavement", "concrete": "concrete slab", "sidewalk": "sidewalk",
    "fence": "fence", "hedge": "hedge", "shrub": "shrub", "evergreen": "evergreen shrub", "tree": "tree",
    "trunk": "tree trunk", "flowers": "flower bed", "house": "house", "wall": "wall", "stone wall": "stone wall",
    "brick wall": "brick wall", "roof": "roof", "window": "window", "door": "door", "garage door": "garage door",
    "shed": "shed", "deck": "wooden deck", "steps": "steps", "car": "car", "truck": "truck", "trailer": "trailer",
    "bin": "trash bin", "pole": "pole", "mailbox": "mailbox", "furniture": "patio furniture", "machine": "air conditioner",
    "hose": "garden hose", "sky": "sky", "person": "person",
}
NAME_AREA = 0.004      # of the picture: a shape smaller than this is not named
# WHAT KIND OF THING A NAME IS (the owner, 2026-11-19, on the namers saying building, wall and shed of the same
# things: "building, wall, and shed are essentially synonyms for our purposes. At some point we'll break individual
# names into distinct classes based on how it affects a lawn in terms of shadow, heat radiance, wind blocking,
# permeability, whether it's permanent/fixed or mobile."). Until those classes are drawn up, the namers are compared
# and the maps coloured by these few kinds; the names themselves stay written on the pictures.
KIND = {name: kind for kind, names in {
    "built": ["building", "house", "wall", "stone wall", "brick wall", "garage door", "door", "window", "roof", "shed", "structure", "deck", "steps", "stairs", "stairway", "awning", "bridge"],
    "fence": ["fence", "railing"],
    "grass": ["lawn", "grass", "terrain", "field"],
    "bare ground": ["soil", "earth", "mulch", "leaves", "gravel", "sand", "dirt track", "land", "ground", "rock"],
    "paved": ["pavement", "concrete", "sidewalk", "road", "path", "floor"],
    "plant": ["tree", "trunk", "shrub", "hedge", "evergreen", "flowers", "plant", "palm", "flower"],
    "movable": ["car", "truck", "trailer", "bin", "furniture", "hose", "machine", "person", "vehicle", "object", "mailbox", "pole", "van", "bus", "bench", "chair", "table"],
    "water": ["water"],
    "sky": ["sky"],
}.items() for name in names}
KIND_COL = {"built": (200, 80, 60), "fence": (150, 90, 190), "grass": (120, 190, 90), "bare ground": (150, 120, 80), "paved": (120, 120, 130),
            "plant": (30, 120, 50), "movable": (60, 120, 220), "water": (60, 190, 220), "sky": (255, 0, 255)}


def kinds_of(counts):
    """A thing's votes by name -> its votes by kind (a name of no known kind keeps itself)."""
    out = {}
    for name, n in counts.items():
        k = KIND.get(name, name)
        out[k] = out.get(k, 0) + n
    return out
CLIPSEG = "CIDAS/clipseg-rd64-refined"
OWL = "google/owlv2-base-patch16-ensemble"
CLIP_BIG = "openai/clip-vit-large-patch14"


def shapes_of(m):
    ids, cnt = np.unique(m[m > 0], return_counts=True)
    return [int(i) for i in ids[cnt >= NAME_AREA * m.size]]


# ---------------------------------------------------------------- the namers (each: -> [{id: name}] per picture)

def name_phone(xyz0, labs, keys, maps):
    """Google's scene labels on the walk's own points, voted inside each shape of each picture."""
    vis, ms = S.lift(xyz0, keys, maps)
    out = []
    for v, m in zip(vis, ms):
        res = {}
        for i in np.unique(m[m > 0]):
            l = labs[v[m == i], 0]
            l = l[l > 0]
            if len(l) >= 8:
                c = np.bincount(l)
                if c.max() >= 0.4 * len(l):
                    res[int(i)] = S.LABELS[int(c.argmax()) - 1]
        out.append(res)
    return out


def name_clipseg(imgs, maps, device="cpu", log=print):
    """CLIPSeg: a heat map of the whole picture for each word; a shape takes the word hottest inside it."""
    import torch
    from PIL import Image
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
    proc = CLIPSegProcessor.from_pretrained(CLIPSEG)
    model = CLIPSegForImageSegmentation.from_pretrained(CLIPSEG).to(device).eval()
    keys, phrases = list(WORDS), [WORDS[k] for k in WORDS]
    out, t0 = [], time.time()
    for im, m in zip(imgs, maps):
        heat = []
        for b in range(0, len(phrases), 12):
            ph = phrases[b:b + 12]
            inp = proc(text=ph, images=[im] * len(ph), padding=True, return_tensors="pt").to(device)
            with torch.no_grad():
                try:      # the model's pictures are 352 wide and its eye was trained at 224: older libraries must be told
                    lg = model(**inp, interpolate_pos_encoding=True).logits
                except TypeError:
                    lg = model(**inp).logits
            heat.append(torch.sigmoid(lg).cpu().numpy().reshape(len(ph), lg.shape[-2], lg.shape[-1]))
        heat = np.concatenate(heat)                                    # (words, 352, 352)
        small = np.asarray(Image.fromarray(m.astype(np.uint16)).resize((heat.shape[2], heat.shape[1]), Image.NEAREST))
        res = {}
        for i in shapes_of(m):
            on = small == i
            if on.sum() < 4:
                continue
            res[i] = keys[int(heat[:, on].mean(1).argmax())]
        out.append(res)
    log(f"  clipseg: {len(imgs)} pictures in {time.time() - t0:.0f} s on {device}")
    return out


def name_owl(imgs, maps, device="cpu", log=print, least=0.12):
    """OWLv2: boxes for each word over the whole picture; a shape takes the word of the surest box that it fills at
    least half of and that covers at least half of it."""
    import torch
    from transformers import Owlv2ForObjectDetection, Owlv2Processor
    proc = Owlv2Processor.from_pretrained(OWL)
    model = Owlv2ForObjectDetection.from_pretrained(OWL).to(device).eval()
    keys, phrases = list(WORDS), [f"a photo of a {WORDS[k]}" for k in WORDS]
    out, t0 = [], time.time()
    for im, m in zip(imgs, maps):
        with torch.no_grad():
            o = model(**proc(text=[phrases], images=im, return_tensors="pt").to(device))
        side = max(im.height, im.width)                                # the processor pads the picture to a square
        r = proc.post_process_object_detection(o, threshold=least, target_sizes=torch.tensor([[side, side]]))[0]
        boxes, scores, lab = r["boxes"].cpu().numpy(), r["scores"].cpu().numpy(), r["labels"].cpu().numpy()
        res = {}
        for i in shapes_of(m):
            ys, xs = np.nonzero(m == i)
            best, bs = None, 0.0
            for (x0, y0, x1, y1), sc, lb in zip(boxes, scores, lab):
                inside = ((xs >= x0) & (xs <= x1) & (ys >= y0) & (ys <= y1)).mean()
                area = max(1.0, (x1 - x0) * (y1 - y0))
                if inside >= 0.5 and len(xs) / area >= 0.35 and sc > bs:
                    best, bs = keys[int(lb)], float(sc)
            if best:
                res[i] = best
        out.append(res)
    log(f"  owlv2: {len(imgs)} pictures in {time.time() - t0:.0f} s on {device}")
    return out


def name_marked(imgs, maps, device="cpu", log=print, model_id=CLIP_BIG):
    """CLIP shown a wide cut of the picture (the shape's box and as much again round it) with the shape outlined in
    red and everything else dimmed; the word nearest that picture."""
    import torch
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor
    proc = CLIPProcessor.from_pretrained(model_id)
    model = CLIPModel.from_pretrained(model_id).to(device).eval()
    keys = list(WORDS)
    with torch.no_grad():
        t = model.get_text_features(**proc(text=[f"a photo of a {WORDS[k]}" for k in keys], return_tensors="pt", padding=True).to(device))
        t = t / t.norm(dim=-1, keepdim=True)
    out, t0, n = [], time.time(), 0
    for im, m in zip(imgs, maps):
        a = np.asarray(im.convert("RGB"))
        if m.shape != a.shape[:2]:
            m = np.asarray(Image.fromarray(m.astype(np.uint16)).resize((a.shape[1], a.shape[0]), Image.NEAREST))
        ids, cuts = shapes_of(m), []
        for i in ids:
            on = m == i
            ys, xs = np.nonzero(on)
            py, px = (ys.max() - ys.min() + 1) // 2 + 16, (xs.max() - xs.min() + 1) // 2 + 16
            y0, y1, x0, x1 = max(0, ys.min() - py), min(a.shape[0], ys.max() + py + 1), max(0, xs.min() - px), min(a.shape[1], xs.max() + px + 1)
            cut, o = a[y0:y1, x0:x1].astype(np.float32), on[y0:y1, x0:x1]
            cut[~o] *= 0.45
            edge = np.zeros(o.shape, bool)
            edge[:, 1:] |= o[:, 1:] != o[:, :-1]
            edge[1:, :] |= o[1:, :] != o[:-1, :]
            edge[:, :-1] |= edge[:, 1:]
            edge[:-1, :] |= edge[1:, :]
            cut[edge] = (255, 0, 0)
            cuts.append(Image.fromarray(cut.astype(np.uint8)))
        res = {}
        for b in range(0, len(cuts), 48):
            with torch.no_grad():
                f = model.get_image_features(**proc(images=cuts[b:b + 48], return_tensors="pt").to(device))
            f = f / f.norm(dim=-1, keepdim=True)
            for j, w in enumerate((f @ t.T).argmax(1).tolist()):
                res[ids[b + j]] = keys[w]
        out.append(res)
        n += len(ids)
    log(f"  marked (CLIP): {n:,} shapes in {time.time() - t0:.0f} s on {device}")
    return out


# ---------------------------------------------------------------- a study, kept

def keep(d, sid, title, what, eyes, numbers, sheets):
    """study-<id>.json beside the twin; the sheets are already written as study-<id>-*.{jpg,png}."""
    body = {"id": sid, "title": title, "made": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "what": what,
            "eyes": eyes, "numbers": numbers, "sheets": sheets}
    with open(os.path.join(d, f"study-{sid}.json"), "w") as f:
        json.dump(body, f)
    print(f"Study kept: {sid} ({len(sheets)} sheets, {len(eyes)} things for a person's eyes).")


def load(d):
    """The walk as segment_study.py takes it: points (the report's verdicts when judged.bin is there), pictures."""
    recs, labs, keys = S.read_twin(d)
    track = S.read_track(d)
    xyz, h = recs[:, 2:5].copy(), (recs[:, 3] - recs[:, 5]).astype(np.float64)
    drop = (labs[:, 3] & 3) > 0
    verdict = None
    jf = os.path.join(d, "judged.bin")
    if os.path.exists(jf) and os.path.getsize(jf) == len(recs):
        verdict = np.fromfile(jf, dtype=np.uint8)
        drop |= (verdict == 255) | (verdict == 3)
    elif len(track) >= 2:
        drop |= np.linalg.norm(xyz - S.cam_at(track, recs[:, 0].astype(np.float64)), axis=1) > S.NEAR
    S.pose_keys(keys, track)
    xyz0 = np.where(drop[:, None], 1e6, xyz)
    h = np.where(drop, np.nan, h)
    return {"recs": recs, "labs": labs, "keys": keys, "track": track, "xyz": xyz, "xyz0": xyz0, "h": h, "drop": drop, "verdict": verdict}


def strip(cells, titles, head=""):
    """Pictures side by side under their titles (and one line over them all)."""
    from PIL import Image, ImageDraw
    f = S._font(16)
    W, H = cells[0].size
    HEAD = 26
    out = Image.new("RGB", (W * len(cells), H + (2 if head else 1) * HEAD), (255, 255, 255))
    dr = ImageDraw.Draw(out)
    if head:
        dr.text((6, 4), head, fill=(0, 0, 0), font=f)
    y0 = HEAD if head else 0
    for i, c in enumerate(cells):
        out.paste(c, (i * W, y0 + HEAD))
        dr.text((i * W + 6, y0 + 4), titles[i], fill=(90, 90, 90), font=f)
    return out


def stack(rows, path, wide=2600):
    from PIL import Image
    W = max(r.width for r in rows)
    out = Image.new("RGB", (W, sum(r.height for r in rows)), (255, 255, 255))
    y = 0
    for r in rows:
        out.paste(r, (0, y))
        y += r.height
    if W > wide:
        out = out.resize((wide, round(out.height * wide / W)))
    out.save(path, quality=80)
    return os.path.basename(path)


# ---------------------------------------------------------------- study: names

def study_names(d, names_file=None, sid="names", pictures=10):
    from PIL import Image
    w = load(d)
    mf = os.path.join(d, "segments-masks.npz")
    if not os.path.exists(mf):
        print("No kept shapes for this walk (workflow S3 makes them): no names study.")
        return
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj = list(z["obj"])
    cams = np.array([k["c2w"][:3, 3] for k in sel])
    pan_names = [{int(a): b for a, b in nm.items()} for nm in json.loads(str(z["names"]))]
    namers = {"panoptic": S.name_by_vote(obj, list(z["pan"]), pan_names)}
    if (w["labs"][:, 0] > 0).any():
        namers["phone"] = name_phone(w["xyz0"], w["labs"], sel, obj)
    if names_file and os.path.exists(names_file):
        with open(names_file) as f:
            for k, v in json.load(f).items():
                namers[k] = [{int(a): b for a, b in nm.items()} for nm in v]
    # the one lift (the cut is the same whoever names it), then each namer's vote on its things. Where the pictures
    # kept their own depth, a picture speaks only for what that depth saw, out to 80 ft (the reach study: that keeps
    # things apart where the points' own test ran them together); else the 26 ft lift
    depths = [read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    by_depth = sum(x is not None for x in depths) >= 0.8 * len(sel)
    # (not the "fill" variant: letting the points' own test speak where a picture's depth is empty brought the
    # running-together straight back -- the biggest standing thing 12% by depth alone, 46% with the fill, on the
    # second app walk, 2026-11-19)
    vis, ms = lift_by_depth(w["xyz0"], sel, obj, depths, 24.4) if by_depth else S.lift(w["xyz0"], sel, obj)
    off, comp, joined = S.merge(vis, ms, cams)
    piece, purity, vp, vn = S.vote(len(w["xyz0"]), vis, ms, off, comp)
    stand = np.isfinite(w["h"]) & (w["h"] > S.STAND)
    ids, cnt = np.unique(piece[piece >= 0], return_counts=True)
    big = [int(i) for i in ids[cnt >= S.PIECE_MIN]]
    desc = {i: S.describe(w["xyz0"], w["h"], np.flatnonzero(piece == i)) for i in big}
    standing = sorted((i for i in big if desc[i]["shape"] != "flat"), key=lambda i: -desc[i]["n"])
    numbers = [f"{len(sel)} pictures; {len(big)} things of {S.PIECE_MIN} points or more, {len(standing)} of them standing. The lift: {'each picture speaks for what its own depth saw, out to 80 ft' if by_depth else 'the 26 ft lift (these pictures kept no depth of their own)'}."]
    per = {}
    for nm, names in namers.items():
        node = {}
        for p, d1 in enumerate(names):
            for i, c in d1.items():
                node[int(off[p] + i)] = c
        cls = {}
        ok = comp[vn] == piece[vp]
        for pc, nd in zip(piece[vp][ok], vn[ok]):
            c = node.get(int(nd))
            if c:
                dd = cls.setdefault(int(pc), {})
                dd[c] = dd.get(c, 0) + 1
        per[nm] = cls
        shapes = sum(len(shapes_of(m)) for m in obj)
        named = sum(len(set(x) & set(shapes_of(m))) for x, m in zip(names, obj))
        tally = {}
        for i in standing:
            c, share = S.top_of(kinds_of(cls.get(i, {})), 0.5)
            tally[c or "no clear kind"] = tally.get(c or "no clear kind", 0) + 1
        numbers.append(f"{nm}: named {named:,} of {shapes:,} shapes in the pictures; the standing things BY KIND: " + ", ".join(f"{v} {k}" for k, v in sorted(tally.items(), key=lambda kv: -kv[1])) + ".")
    # where the namers agree on a thing and where they do not
    rows_txt = []
    for i in standing[:14]:
        said = []
        for nm in namers:
            c, share = S.top_of(per[nm].get(i, {}))
            k, ks = S.top_of(kinds_of(per[nm].get(i, {})))
            said.append(f"{nm} {k or '-'}{f' {100 * ks:.0f}% (mostly {c})' if k else ''}")
        rows_txt.append(f"  a {S.says(desc[i])}: " + "; ".join(said))
    numbers.append("The biggest standing things, by each namer (its top KIND, that kind's share of its votes, and the name it used most):")
    numbers += rows_txt
    # how often two namers give a thing the same kind, over every thing both gave a clear kind (half its votes)
    kind_of = {nm: {i: S.top_of(kinds_of(per[nm].get(i, {})), 0.5)[0] for i in big} for nm in namers}
    nms = list(namers)
    for a_i, a in enumerate(nms):
        for b in nms[a_i + 1:]:
            both = [i for i in big if kind_of[a][i] and kind_of[b][i]]
            if both:
                same = sum(kind_of[a][i] == kind_of[b][i] for i in both)
                numbers.append(f"  {a} and {b} give the same kind to {same} of the {len(both)} things both are clear on ({100 * same / len(both):.0f}%).")
    for line in numbers:
        print(line)
    # the sheet: the same pictures, the same cut, each namer's names written on it
    pick = np.unique(np.linspace(0, len(sel) - 1, num=min(pictures, len(sel))).astype(int))
    rows = []
    for p in pick:
        img = Image.open(os.path.join(d, sel[p]["name"])).convert("RGB")
        cells = [img] + [S.overlay(img, obj[p], off[p], comp, namers[nm][p], int(off[p + 1] - off[p])) for nm in namers]
        rows.append(strip(cells, ["the camera"] + list(namers), f"picture {int(p) + 1} of {len(sel)}"))
    sheets = [{"file": stack(rows, os.path.join(d, f"study-{sid}-pictures.jpg")), "title": "The same pictures and the same cut, named by each namer"}]
    # every namer one vote a thing (its clear kind): the kind most of them give it
    maj = {}
    for i in big:
        votes = {}
        for nm in namers:
            k = kind_of[nm][i]
            if k:
                votes[k] = votes.get(k, 0) + 1
        if votes:
            top = max(votes.values())
            win = [k for k, v in votes.items() if v == top]
            if len(win) == 1 and top >= 2:
                maj[i] = {win[0]: 1}
    per["most namers"] = maj
    agree_all = sum(1 for i in standing if i in maj)
    numbers.append(f"Most namers together (a kind two or more namers give a thing, and more than give it any other): {agree_all} of the {len(standing)} standing things get one.")
    for nm in list(namers) + ["most namers"]:
        f = f"study-{sid}-above-{re.sub(r'[^a-z0-9]+', '-', nm)}.png"
        named_map(os.path.join(d, f), w["xyz0"], piece, {pc: kinds_of(c) for pc, c in per[nm].items()}, f"From above, every thing coloured by the KIND of name {nm} gave it")
        sheets.append({"file": f, "title": f"From above, named by: {nm}"})
    eyes = [
        "Which column's names are right most often? Building, wall and shed count as the same (your note): judge by kind of thing, not the exact word.",
        "In the views from above (one per namer): which one looks most like the place: lawn, paving, buildings and walls, trees where they really are?",
        "The last view from above is the kind most namers agree on. Is it better than any single namer's view, or does it just leave more grey?",
        "The stone wall seen close: are its blocks each named a wall of some kind, and by which namer?",
        "Is any namer good on the ground (lawn, gravel, pavement, soil) and another good on standing things? A mix by kind of thing may beat any one.",
    ]
    if "phone" in namers:
        eyes.append("The phone column costs nothing and could run live. Is it good enough to use by itself for the keep-by-name rule?")
    keep(d, sid, "Who names a shape best", "The cut is SAM objects throughout. Each column is one namer; every namer sees the whole picture. A shape with no name written is one the namer left unnamed (or too small).", eyes, numbers, sheets)


def named_map(path, xyz0, piece, cls, title):
    """From above: each point in the colour of its thing's name (the name with half its votes or more; grey where a
    thing has no clear name), the commonest names in a legend."""
    from PIL import Image, ImageDraw
    e, n = xyz0[:, 0], -xyz0[:, 2]
    ok = (np.abs(e) < 1e5) & (piece >= 0)
    if not ok.any():
        return
    name = {pc: S.top_of(c, 0.5)[0] for pc, c in cls.items()}
    words = sorted({v for v in name.values() if v})
    rng = np.random.default_rng(11)
    fixed = {**KIND_COL, "lawn": (120, 190, 90), "terrain": (120, 190, 90), "earth": (150, 120, 80), "soil": (150, 120, 80), "road": (90, 90, 100), "pavement": (90, 90, 100),
             "sidewalk": (170, 170, 180), "concrete": (170, 170, 180), "building": (200, 80, 60), "house": (200, 80, 60), "wall": (230, 150, 60), "stone wall": (230, 150, 60), "structure": (230, 150, 60),
             "tree": (30, 120, 50), "plant": (60, 160, 60), "shrub": (60, 160, 60), "fence": (150, 90, 190), "sky": (255, 0, 255), "car": (60, 120, 220), "gravel": (190, 180, 150)}
    col = {wd: fixed.get(wd, tuple(int(x) for x in rng.integers(40, 230, 3))) for wd in words}
    e0, n0 = np.median(e[ok]), np.median(n[ok])
    r = max(5.0, float(np.percentile(np.hypot(e[ok] - e0, n[ok] - n0), 99.5)))
    SZ = 1400
    x = np.clip(((e - e0) / r * 0.5 + 0.5) * (SZ - 1), 0, SZ - 1).astype(int)
    y = np.clip((0.5 - (n - n0) / r * 0.5) * (SZ - 1), 0, SZ - 1).astype(int)
    img = np.full((SZ, SZ, 3), 255, np.uint8)
    cols = np.full((len(e), 3), 200, np.uint8)
    count = {}
    for pc in np.unique(piece[ok]):
        wd = name.get(int(pc))
        on = piece == pc
        if wd:
            cols[on] = col[wd]
            count[wd] = count.get(wd, 0) + int((on & ok).sum())
    for dy in (0, 1):
        for dx in (0, 1):
            img[np.clip(y[ok] + dy, 0, SZ - 1), np.clip(x[ok] + dx, 0, SZ - 1)] = cols[ok]
    im = Image.fromarray(img)
    dr, f = ImageDraw.Draw(im), S._font(18)
    dr.text((10, 8), title, fill=(0, 0, 0), font=f)
    dr.text((10, 32), f"{2 * r * FT:.0f} ft across; grey: in a thing with no clear name", fill=(90, 90, 90), font=f)
    for k, (wd, c) in enumerate(sorted(count.items(), key=lambda kv: -kv[1])[:16]):
        dr.rectangle((10, 62 + 24 * k, 28, 80 + 24 * k), fill=col[wd])
        dr.text((36, 60 + 24 * k), f"{wd} ({c:,} points)", fill=(0, 0, 0), font=f)
    im.save(path)


# ---------------------------------------------------------------- study: map

MAP_COL = {"terrain": (120, 190, 90), "road": (90, 90, 100), "sidewalk": (170, 170, 180), "building": (200, 80, 60), "structure": (230, 150, 60),
           "tree": (30, 120, 50), "object": (150, 90, 190), "vehicle": (60, 120, 220), "water": (60, 190, 220), "sky": (255, 0, 255), "person": (0, 0, 0), "unlabeled": (140, 140, 140)}


def study_map(d, sid="map"):
    from PIL import Image, ImageDraw
    w = load(d)
    if w["verdict"] is None:
        print("No verdicts (judged.bin) for this walk: no map study.")
        return
    v, labs, xyz = w["verdict"], w["labs"], w["xyz"]
    e, n = xyz[:, 0], -xyz[:, 2]
    used = v <= 2
    e0, n0 = np.median(e[used]), np.median(n[used])
    r = max(5.0, float(np.percentile(np.hypot(e[used] - e0, n[used] - n0), 99.5)))
    SZ = 1400

    def px(sel):
        return (np.clip(((e[sel] - e0) / r * 0.5 + 0.5) * (SZ - 1), 0, SZ - 1).astype(int), np.clip((0.5 - (n[sel] - n0) / r * 0.5) * (SZ - 1), 0, SZ - 1).astype(int))

    def draw(masks_cols, legend, title):
        img = np.full((SZ, SZ, 3), 255, np.uint8)
        for sel, col in masks_cols:
            x, y = px(sel)
            for dy in (0, 1):
                for dx in (0, 1):
                    img[np.clip(y + dy, 0, SZ - 1), np.clip(x + dx, 0, SZ - 1)] = col
        im = Image.fromarray(img)
        dr, f = ImageDraw.Draw(im), S._font(18)
        dr.text((10, 8), title, fill=(0, 0, 0), font=f)
        dr.text((10, 32), f"{2 * r * FT:.0f} ft across; the walk's own middle at the centre", fill=(90, 90, 90), font=f)
        for k, (name, col) in enumerate(legend):
            dr.rectangle((10, 62 + 24 * k, 28, 80 + 24 * k), fill=col)
            dr.text((36, 60 + 24 * k), name, fill=(0, 0, 0), font=f)
        return im

    # 1: by what the phone called it
    order = np.argsort(-np.bincount(labs[used, 0], minlength=len(S.LABELS) + 1))
    mc, lg = [], []
    for li in order:
        sel = used & (labs[:, 0] == li)
        if not sel.any():
            continue
        name = S.LABELS[li - 1] if li else "no label"
        col = MAP_COL.get(name, (140, 140, 140))
        mc.append((sel, col))
        lg.append((f"{name} ({int(sel.sum()):,})", col))
    a = draw(mc[::-1], lg, "What the walk knows, by the phone's label (every point the rule used)")
    a.save(os.path.join(d, f"study-{sid}-labels.png"))
    # 2: by what the rule did
    b = draw([(v == 0, (185, 185, 185)), (v == 2, (255, 170, 0)), (v == 1, (220, 0, 0)), (v == 3, (0, 110, 255))],
             [(f"kept as it was ({int((v == 0).sum()):,})", (185, 185, 185)), (f"ground over 5 in off its surroundings, seen once: smoothed ({int((v == 2).sum()):,})", (255, 170, 0)),
              (f"the same but seen from two places: a real high or low spot ({int((v == 1).sum()):,})", (220, 0, 0)), (f"left out: seen once and odd or nameless ({int((v == 3).sum()):,})", (0, 110, 255))],
             "What the keep-by-name rule did with each point")
    b.save(os.path.join(d, f"study-{sid}-rule.png"))
    numbers = [f"{int(used.sum()):,} points used, {2 * r * FT:.0f} ft across.", "By the phone's label: " + ", ".join(x[0] for x in lg) + ".",
               f"Smoothed {int((v == 2).sum()):,}; confirmed high or low spots {int((v == 1).sum()):,}; left out {int((v == 3).sum()):,}."]
    for line in numbers:
        print(line)
    eyes = ["Does the first picture look like the place from above: is the lawn where the lawn is, paving where paving is, buildings where they stand?",
            "The red points (high or low spots seen from two places): are they where the ground really rolls, or on kerbs, edges and things lying on the ground?",
            "The blue points (left out): are they mostly noise, or is something real being thrown away (a fence, a shrub)?",
            "Is the picture still too thin to be a map? If so the limit is what the walk recorded, not what the tools kept: the next walk records more (second looks, a wider look)."]
    keep(d, sid, "What the walk knows, from above", "Every camera-measured point the keep-by-name rule used, out to 80 ft from the phone, seen from above. No picture model is involved: only the phone's own labels and the rule.", eyes, numbers,
         [{"file": f"study-{sid}-labels.png", "title": "By the phone's label"}, {"file": f"study-{sid}-rule.png", "title": "What the rule did"}])


# ---------------------------------------------------------------- study: relief

def study_relief(d, sid="relief"):
    """THE GROUND'S HIGH AND LOW SPOTS, FROM ABOVE (the owner: "legitimate low spots and permanent mounds do exist in
    lawns... Itd be nice to map legitimate low spots and high spots"). The ground-named points the rule used, on
    0.5 m squares: each square's middle height, set against the middle height of the 5 m round it (local bumps and
    dips, inches), and against the whole walk (the lie of the land, feet). A square seen in one stretch only is
    drawn pale: the rule says a bump needs two looks."""
    from PIL import Image, ImageDraw
    from scipy import ndimage
    w = load(d)
    if w["verdict"] is None:
        print("No verdicts for this walk: no relief study.")
        return
    labs, xyz, t = w["labs"], w["xyz"], w["recs"][:, 0]
    ground = np.isin(labs[:, 0], [S.LABELS.index(x) + 1 for x in ("terrain", "road", "sidewalk")]) & (w["verdict"] <= 2)
    if ground.sum() < 500:
        print("Too few ground-named points: no relief study.")
        return
    C = 0.5
    e, n, y = xyz[ground, 0], -xyz[ground, 2], xyz[ground, 1]
    ix, iy = np.floor(e / C).astype(int), np.floor(n / C).astype(int)
    ix -= ix.min()
    iy -= iy.min()
    W, H = ix.max() + 1, iy.max() + 1
    order = np.lexsort((y, iy * W + ix))
    cell = (iy * W + ix)[order]
    ys, ts = y[order], np.floor(t[ground][order] / 20)
    first = np.flatnonzero(np.concatenate([[True], cell[1:] != cell[:-1]]))
    last = np.concatenate([first[1:], [len(cell)]])
    med = np.full(W * H, np.nan)
    looks = np.zeros(W * H, int)
    for a, b in zip(first, last):
        if b - a >= 6:
            med[cell[a]] = ys[(a + b) // 2]
            looks[cell[a]] = len(np.unique(ts[a:b]))
    med, looks = med.reshape(H, W), looks.reshape(H, W)
    have = np.isfinite(med)
    wide = ndimage.generic_filter(med, np.nanmedian, size=11, mode="constant", cval=np.nan)
    local = (med - wide) * 39.37                         # inches over the 5 m round it
    whole = (med - np.nanpercentile(med, 10)) * FT       # feet over the walk's low ground
    K = max(2, min(8, 1400 // max(W, H)))

    def draw(val, lim, unit, title):
        img = np.full((H * K, W * K, 3), 255, np.uint8)
        v = np.clip(val / lim, -1, 1)
        for r in range(H):
            for c in range(W):
                if not have[r, c] or not np.isfinite(v[r, c]):
                    continue
                x = v[r, c]
                col = np.array([255, 255 - 200 * x, 255 - 200 * x]) if x >= 0 else np.array([255 + 200 * x, 255 + 200 * x, 255])
                if looks[r, c] < 2:
                    col = 0.55 * 255 + 0.45 * col      # one look only: pale
                img[(H - 1 - r) * K:(H - r) * K, c * K:(c + 1) * K] = col.astype(np.uint8)
        pad = Image.new("RGB", (max(W * K, 900), H * K + 90), (255, 255, 255))
        pad.paste(Image.fromarray(img), (0, 90))
        dr, f = ImageDraw.Draw(pad), S._font(18)
        dr.text((10, 6), title, fill=(0, 0, 0), font=f)
        dr.text((10, 30), f"red: up to {lim:g} {unit} higher; blue: up to {lim:g} {unit} lower; white: level. Pale: seen in one stretch of the walk only.", fill=(90, 90, 90), font=f)
        dr.text((10, 54), f"each square 20 in; {W * C * FT:.0f} x {H * C * FT:.0f} ft", fill=(90, 90, 90), font=f)
        return pad

    draw(local, 8.0, "in", "Bumps and dips: each square of ground against the 16 ft round it").save(os.path.join(d, f"study-{sid}-local.png"))
    draw(whole - np.nanmedian(whole[have]), 3.0, "ft", "The lie of the land: each square against the walk's middle ground height").save(os.path.join(d, f"study-{sid}-whole.png"))
    two = have & (looks >= 2)
    numbers = [f"{int(have.sum()):,} squares of ground (20 in), {int(two.sum()):,} seen in two stretches or more ({100 * two.sum() / max(1, have.sum()):.0f}%).",
               f"Against the 16 ft round it: {int((np.abs(local[have]) > 5).sum()):,} squares more than 5 in off ({int((np.abs(local[two]) > 5).sum()):,} of them seen twice or more).",
               f"The ground the walk saw spans {np.nanpercentile(whole[have], 95) - np.nanpercentile(whole[have], 5):.1f} ft from its low twentieth to its high twentieth."]
    for line in numbers:
        print(line)
    eyes = ["Bumps and dips: do the red and blue patches sit where the lawn really has mounds and low spots, or along kerbs, edges, and where the phone's depth wandered?",
            "The lie of the land: does the broad red-to-blue trend match the way the ground really slopes? If it tilts the wrong way or steps suddenly, that is the phone's height drifting along the walk, not the ground.",
            "Are the pale squares (one look only) noisier than the solid ones? If so the two-looks rule for bumps is doing its job."]
    keep(d, sid, "The ground's high and low spots, from above", "Only points the phone called ground (terrain, road, sidewalk) and the rule kept. No lidar is used: this is the walk's own ground.", eyes, numbers,
         [{"file": f"study-{sid}-local.png", "title": "Bumps and dips (inches, against the 16 ft round each square)"}, {"file": f"study-{sid}-whole.png", "title": "The lie of the land (feet)"}])


# ---------------------------------------------------------------- study: reach

def read_depth(path):
    """key-NNNN.depth: Uint16 [nx, ny, then ny rows of nx distances from the camera in mm, 0 none]."""
    a = np.fromfile(path, dtype="<u2")
    if len(a) < 2 or len(a) != 2 + int(a[0]) * int(a[1]):
        return None
    return a[2:].reshape(int(a[1]), int(a[0])).astype(np.float32) / 1000.0


def lift_by_depth(xyz0, keys, maps, depths, reach, fill=0.0):
    """As segment_study.lift, but a picture speaks for a point only where the picture's own depth reads the point's
    distance (within 8% or 0.25 m): what it saw, not what lay behind it. fill > 0: where the picture's depth is EMPTY
    at a point's pixel and the point is within `fill` metres, the points' own hidden-behind test speaks instead."""
    xyz1 = np.concatenate([xyz0.astype(np.float64), np.ones((len(xyz0), 1))], 1)
    vis, ms = [], []
    was = S.RANGE
    S.RANGE = reach
    try:
        for k, m, dg in zip(keys, maps, depths):
            h, w = m.shape
            px, py, z, ok = S.project(xyz1, k, w, h)
            idx = np.flatnonzero(ok)
            if dg is None or not len(idx):
                vis.append(idx[:0])
                ms.append(np.zeros(0, np.int64))
                continue
            cam = k["c2w"][:3, 3]
            rng = np.linalg.norm(xyz0[idx] - cam, axis=1)
            gy = np.clip((py[idx] * dg.shape[0] // h), 0, dg.shape[0] - 1)
            gx = np.clip((px[idx] * dg.shape[1] // w), 0, dg.shape[1] - 1)
            dd = dg[gy, gx]
            good = (dd > 0) & (np.abs(dd - rng) <= np.maximum(0.25, 0.08 * dd))
            if fill > 0:
                near = np.zeros(len(xyz0), bool)
                near[S.seen(px, py, z, ok & (z < fill), w, h)] = True
                good |= (dd <= 0) & near[idx]
            v = idx[good]
            ids = m[py[v], px[v]].astype(np.int64)
            c = np.bincount(ids, minlength=int(m.max()) + 1)
            ids[c[ids] < S.MIN_PTS] = 0
            vis.append(v)
            ms.append(ids)
    finally:
        S.RANGE = was
    return vis, ms


def study_reach(d, sid="reach"):
    w = load(d)
    mf = os.path.join(d, "segments-masks.npz")
    if not os.path.exists(mf):
        print("No kept shapes for this walk: no reach study.")
        return
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj = list(z["obj"])
    cams = np.array([k["c2w"][:3, 3] for k in sel])
    depths = [read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    have = sum(x is not None for x in depths)
    numbers = [f"{len(sel)} pictures, {have} with a depth grid of their own."]
    if have < len(sel) // 2:
        numbers.append("Too few pictures have their own depth: the study cannot be made on this walk.")
        for line in numbers:
            print(line)
        keep(d, sid, "The lift with a longer reach", "Not made: this walk's pictures have no depth grids.", [], numbers, [])
        return
    pan_names = [{int(a): b for a, b in nm.items()} for nm in json.loads(str(z["names"]))]
    names = S.name_by_vote(obj, list(z["pan"]), pan_names)
    stand = np.isfinite(w["h"]) & (w["h"] > S.STAND)
    sheets = []
    for tag, fn in (("26 ft, hidden-behind by the points", lambda: S.lift(w["xyz0"], sel, obj)),
                    ("26 ft, by each picture's own depth", lambda: lift_by_depth(w["xyz0"], sel, obj, depths, 8.0)),
                    ("50 ft, by each picture's own depth", lambda: lift_by_depth(w["xyz0"], sel, obj, depths, 15.2)),
                    ("80 ft, by each picture's own depth", lambda: lift_by_depth(w["xyz0"], sel, obj, depths, 24.4)),
                    ("80 ft by depth, and within 26 ft the old test where the depth is empty", lambda: lift_by_depth(w["xyz0"], sel, obj, depths, 24.4, 8.0))):
        vis, ms = fn()
        off, comp, joined = S.merge(vis, ms, cams)
        piece, purity, vp, vn = S.vote(len(w["xyz0"]), vis, ms, off, comp)
        saw = np.zeros(len(w["xyz0"]), bool)
        for v in vis:
            saw[v] = True
        ids, cnt = np.unique(piece[piece >= 0], return_counts=True)
        big = ids[cnt >= S.PIECE_MIN]
        desc = {int(i): S.describe(w["xyz0"], w["h"], np.flatnonzero(piece == i)) for i in big}
        st = [i for i in desc if desc[i]["shape"] != "flat"]
        biggest = max((int((stand & (piece == i)).sum()) for i in st), default=0)
        used = int((~w["drop"]).sum())
        numbers.append(f"{tag}: {100 * saw.sum() / max(1, used):.0f}% of the used points were in a picture, {100 * (piece >= 0).sum() / max(1, used):.0f}% ended in a thing; {len(big)} things ({len(st)} standing); "
                       f"the biggest standing thing holds {100 * biggest / max(1, stand.sum()):.0f}% of the standing points and is {max((desc[i]['length'] for i in st), default=0) * FT:.0f} ft long; a point's pictures agree {100 * purity:.0f}%.")
        f = f"study-{sid}-{re.sub(r'[^a-z0-9]+', '-', tag.lower()).strip('-')[:48].strip('-')}.png"   # the site serves names this short
        S.picture(os.path.join(d, f), w["xyz0"], w["h"], piece, np.array(list(desc)))
        sheets.append({"file": f, "title": f"From above: {tag}"})
    for line in numbers:
        print(line)
    eyes = ["In the views from above, each colour is one thing. Does the 50 ft or 80 ft view still keep separate things separate (a wall apart from a shrub in front of it), or do colours run together?",
            "Does the longer reach fill in parts of the yard the 26 ft view leaves empty, and are those parts drawn in the right place?"]
    keep(d, sid, "The lift with a longer reach", "The cut is SAM objects. A picture names a point only if it saw it. First by the old test (the nearest point in a patch of the picture), then by the picture's own depth, at three reaches.", eyes, numbers, sheets)


# ---------------------------------------------------------------- study: the best guess

def study_best(d, names_file=None, sid="best"):
    """ONE MAP FROM ABOVE, EVERYTHING PUT TOGETHER (2026-11-19). The thesis (docs/SCAN-PLAN.md 29) wants one picture of
    the yard built from what is known. Here, from a walk alone: each point takes the KIND of the thing it was lifted
    into (the cut: SAM objects; the lift: each picture's own depth, 80 ft; the kind: what most namers give the thing,
    else the heat-map namer's, else the panoptic vote's); a point in no thing takes the kind of the phone's own
    label; a point with neither is grey. Beside it, the same with the things alone, to show what each part adds."""
    w = load(d)
    mf = os.path.join(d, "segments-masks.npz")
    if not os.path.exists(mf):
        print("No kept shapes for this walk: no best-guess study.")
        return
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj = list(z["obj"])
    cams = np.array([k["c2w"][:3, 3] for k in sel])
    pan_names = [{int(a): b for a, b in nm.items()} for nm in json.loads(str(z["names"]))]
    namers = {"panoptic": S.name_by_vote(obj, list(z["pan"]), pan_names)}
    names_file = names_file or os.path.join(d, "segments-names.json")
    if os.path.exists(names_file):
        with open(names_file) as f:
            for k, v in json.load(f).items():
                namers[k] = [{int(a): b for a, b in nm.items()} for nm in v]
    depths = [read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    by_depth = sum(x is not None for x in depths) >= 0.8 * len(sel)
    vis, ms = lift_by_depth(w["xyz0"], sel, obj, depths, 24.4) if by_depth else S.lift(w["xyz0"], sel, obj)
    off, comp, joined = S.merge(vis, ms, cams)
    piece, purity, vp, vn = S.vote(len(w["xyz0"]), vis, ms, off, comp)
    ok = comp[vn] == piece[vp]
    kind_by = {}
    for nm, names in namers.items():
        node = {int(off[p] + i): KIND.get(c, c) for p, d1 in enumerate(names) for i, c in d1.items()}
        cls = {}
        for pc, nd in zip(piece[vp][ok], vn[ok]):
            c = node.get(int(nd))
            if c:
                dd = cls.setdefault(int(pc), {})
                dd[c] = dd.get(c, 0) + 1
        kind_by[nm] = {pc: S.top_of(c, 0.5)[0] for pc, c in cls.items()}
    things = {}
    how = {"most namers": 0, "clipseg": 0, "panoptic": 0}
    for pc in np.unique(piece[piece >= 0]):
        votes = {}
        for nm in kind_by:
            k = kind_by[nm].get(int(pc))
            if k:
                votes[k] = votes.get(k, 0) + 1
        top = max(votes.values()) if votes else 0
        win = [k for k, v in votes.items() if v == top]
        if top >= 2 and len(win) == 1:
            things[int(pc)] = win[0]
            how["most namers"] += 1
        elif kind_by.get("clipseg", {}).get(int(pc)):
            things[int(pc)] = kind_by["clipseg"][int(pc)]
            how["clipseg"] += 1
        elif kind_by["panoptic"].get(int(pc)):
            things[int(pc)] = kind_by["panoptic"][int(pc)]
            how["panoptic"] += 1
    used = ~w["drop"]
    kind = np.full(len(piece), "", dtype=object)
    sky_pts = 0
    for pc, k in things.items():
        if k == "sky":            # a point is never sky: a thing the namers call sky is a roof edge, a wire, a bare
            sky_pts += int((piece == pc).sum())   # crown or depth gone wrong against the sky: left without a kind
            continue
        kind[piece == pc] = k
    from_things = kind != ""
    phone = np.array([KIND.get(S.LABELS[l - 1], "") if l else "" for l in w["labs"][:, 0]], dtype=object)
    phone[phone == "sky"] = ""                       # a point is never sky
    fill = used & ~from_things & (phone != "")
    both = kind.copy()
    both[fill] = phone[fill]

    def draw(kinds, path, title):
        fake_piece = np.full(len(kinds), -1, np.int64)
        cls, ids = {}, {}
        for k in np.unique(kinds[used & (kinds != "")]):
            ids[k] = len(ids)
            cls[ids[k]] = {k: 1}
            fake_piece[used & (kinds == k)] = ids[k]
        fake_piece[used & (kinds == "")] = len(ids)          # grey: no kind
        named_map(path, w["xyz0"], fake_piece, cls, title)

    draw(both, os.path.join(d, f"study-{sid}-all.png"), "The best guess: every point's kind (things first, the phone's label where no thing)")
    draw(kind, os.path.join(d, f"study-{sid}-things.png"), "The things alone (grey: in no thing, or a thing with no clear kind)")
    n_used = int(used.sum())
    tally = {}
    for k in both[used]:
        tally[k or "no kind"] = tally.get(k or "no kind", 0) + 1
    numbers = [f"{n_used:,} points used. A kind from the thing it is in: {100 * (used & from_things).sum() / n_used:.0f}%; from the phone's label instead: {100 * fill.sum() / n_used:.0f}%; none: {100 * (used & (both == '')).sum() / n_used:.0f}%.",
               "Things given their kind by: " + ", ".join(f"{v} {k}" for k, v in how.items()) + f"; {len(np.unique(piece[piece >= 0])) - len(things)} things left without one.",
               f"{sky_pts:,} points sit in things the namers call sky ({100 * sky_pts / n_used:.0f}%): a point is never sky, so they take the phone's label if it has one, else none.",
               "Points by kind: " + ", ".join(f"{k} {100 * v / n_used:.0f}%" for k, v in sorted(tally.items(), key=lambda kv: -kv[1])) + ".",
               f"Where a point has a kind both ways, the thing's kind and the phone's label agree on {100 * ((kind == phone) & from_things & (phone != '') & used).sum() / max(1, (from_things & (phone != '') & used).sum()):.0f}% of them."]
    for line in numbers:
        print(line)
    eyes = ["Is the first picture the place, seen from above? Where is it wrong: grass drawn as paving, a wall missing, a tree where there is none?",
            "Compare it with the second (things alone): does filling in from the phone's label add true ground, or does it paint over things the cut had right?",
            "Is paved against grass against bare ground right? That split is what the lawn's edge would be redrawn from.",
            "What is still missing that you know is there and walked past?",
            "Grey points are ones nothing could name, many of them in things the namers called sky. Are they roof edges and treetops (real, just unnamed) or points floating where nothing is?"]
    keep(d, sid, "The best guess of the yard, from above", "Everything put together from one walk: the cut (SAM objects), the lift (each picture's own depth, 80 ft), kinds by the namers' vote, and the phone's own label for points in no thing. No lidar, no trace.", eyes, numbers,
         [{"file": f"study-{sid}-all.png", "title": "The best guess: every point's kind"}, {"file": f"study-{sid}-things.png", "title": "The things alone"}])


# ---------------------------------------------------------------- study: fewer pictures

def study_thin(d, sid="thin"):
    """HOW MANY PICTURES DOES THE CUT NEED? Segment Anything is the cost (5-7 s a picture on a GPU; a walk keeps a
    picture a second). The kept shapes of every 2nd, 3rd, 4th and 6th picture, lifted as the full set is, and each
    point's KIND then set against what the full set gave it. Numbers only: nothing here needs a person's eyes."""
    w = load(d)
    mf = os.path.join(d, "segments-masks.npz")
    if not os.path.exists(mf):
        print("No kept shapes for this walk: no fewer-pictures study.")
        return
    z = np.load(mf, allow_pickle=False)
    sel = [w["keys"][i] for i in z["pics"]]
    obj, pan = list(z["obj"]), list(z["pan"])
    pan_names = [{int(a): b for a, b in nm.items()} for nm in json.loads(str(z["names"]))]
    names = S.name_by_vote(obj, pan, pan_names)
    depths = [read_depth(p) if os.path.exists(p) else None for p in (os.path.join(d, k["name"].replace(".jpg", ".depth")) for k in sel)]
    by_depth = sum(x is not None for x in depths) >= 0.8 * len(sel)
    used = int((~w["drop"]).sum())

    def run(step):
        ix = list(range(0, len(sel), step))
        ks, ms_, nm, dp = [sel[i] for i in ix], [obj[i] for i in ix], [names[i] for i in ix], [depths[i] for i in ix]
        cams = np.array([k["c2w"][:3, 3] for k in ks])
        vis, ms = lift_by_depth(w["xyz0"], ks, ms_, dp, 24.4) if by_depth else S.lift(w["xyz0"], ks, ms_)
        off, comp, joined = S.merge(vis, ms, cams)
        piece, purity, vp, vn = S.vote(len(w["xyz0"]), vis, ms, off, comp)
        node = {}
        for p, d1 in enumerate(nm):
            for i, c in d1.items():
                node[int(off[p] + i)] = KIND.get(c, c)
        cls = {}
        ok = comp[vn] == piece[vp]
        for pc, nd in zip(piece[vp][ok], vn[ok]):
            c = node.get(int(nd))
            if c:
                dd = cls.setdefault(int(pc), {})
                dd[c] = dd.get(c, 0) + 1
        kind = np.full(len(piece), "", dtype=object)
        for pc, c in cls.items():
            k, share = S.top_of(c, 0.5)
            if k:
                kind[piece == pc] = k
        return len(ix), piece, kind

    n0, piece0, kind0 = run(1)
    numbers = [f"{len(sel)} pictures kept with shapes (one a second of walking, at most); {used:,} points used. The lift: {'by each picture own depth, 80 ft' if by_depth else '26 ft'}.",
               f"every picture ({n0}): {100 * (piece0 >= 0).sum() / used:.0f}% of the points in a thing, {100 * (kind0 != '').sum() / used:.0f}% given a kind."]
    for step in (2, 3, 4, 6):
        n, piece, kind = run(step)
        both = (kind0 != "") & (kind != "")
        numbers.append(f"every {step}{'nd' if step == 2 else 'rd' if step == 3 else 'th'} picture ({n}): {100 * (piece >= 0).sum() / used:.0f}% of the points in a thing, {100 * (kind != '').sum() / used:.0f}% given a kind; "
                       f"of the points both give a kind, {100 * (kind0[both] == kind[both]).mean() if both.any() else 0:.0f}% get the same one; {100 * ((kind0 != '') & (kind == '')).sum() / max(1, (kind0 != '').sum()):.0f}% of the full set's kinded points lose theirs.")
    for line in numbers:
        print(line)
    keep(d, sid, "How many pictures does the cut need", "The same walk cut from fewer of its pictures, against the cut from all of them. Kinds by the panoptic vote. Numbers only.", [], numbers, [])


def main():
    args = sys.argv[1:]
    d = next((a for a in args if not a.startswith("--") and (args.index(a) == 0 or not args[args.index(a) - 1].startswith("--"))), "twin")
    what = args[args.index("--study") + 1] if "--study" in args else "names"
    for one in what.split(","):
        if one == "names":
            study_names(d, args[args.index("--names") + 1] if "--names" in args else os.path.join(d, "segments-names.json"))
        elif one == "map":
            study_map(d)
        elif one == "reach":
            study_reach(d)
        elif one == "relief":
            study_relief(d)
        elif one == "thin":
            study_thin(d)
        elif one == "best":
            study_best(d)


if __name__ == "__main__":
    main()
