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
    # the one lift (the cut is the same whoever names it), then each namer's vote on its things
    vis, ms = S.lift(w["xyz0"], sel, obj)
    off, comp, joined = S.merge(vis, ms, cams)
    piece, purity, vp, vn = S.vote(len(w["xyz0"]), vis, ms, off, comp)
    stand = np.isfinite(w["h"]) & (w["h"] > S.STAND)
    ids, cnt = np.unique(piece[piece >= 0], return_counts=True)
    big = [int(i) for i in ids[cnt >= S.PIECE_MIN]]
    desc = {i: S.describe(w["xyz0"], w["h"], np.flatnonzero(piece == i)) for i in big}
    standing = sorted((i for i in big if desc[i]["shape"] != "flat"), key=lambda i: -desc[i]["n"])
    numbers = [f"{len(sel)} pictures; {len(big)} things of {S.PIECE_MIN} points or more, {len(standing)} of them standing."]
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
            c, share = S.top_of(cls.get(i, {}), 0.5)
            tally[c or "no clear name"] = tally.get(c or "no clear name", 0) + 1
        numbers.append(f"{nm}: named {named:,} of {shapes:,} shapes in the pictures; the standing things: " + ", ".join(f"{v} {k}" for k, v in sorted(tally.items(), key=lambda kv: -kv[1])) + ".")
    # where the namers agree on a thing and where they do not
    rows_txt = []
    for i in standing[:14]:
        said = []
        for nm in namers:
            c, share = S.top_of(per[nm].get(i, {}))
            said.append(f"{nm} {c or '-'}{f' {100 * share:.0f}%' if c else ''}")
        rows_txt.append(f"  a {S.says(desc[i])}: " + "; ".join(said))
    numbers.append("The biggest standing things, by each namer (its top name and that name's share of its votes):")
    numbers += rows_txt
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
    eyes = [
        "Which column's names are right most often? (Only you can say what each thing really is.)",
        "The stone wall seen close: are its blocks each named a wall of some kind, and by which namer?",
        "Is any namer good on the ground (lawn, gravel, pavement, soil) and another good on standing things? A mix by kind of thing may beat any one.",
    ]
    if "phone" in namers:
        eyes.append("The phone column costs nothing and could run live. Is it good enough to use by itself for the keep-by-name rule?")
    keep(d, sid, "Who names a shape best", "The cut is SAM objects throughout. Each column is one namer; every namer sees the whole picture. A shape with no name written is one the namer left unnamed (or too small).", eyes, numbers, sheets)


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
        f = f"study-{sid}-{re.sub(r'[^a-z0-9]+', '-', tag.lower()).strip('-')}.png"
        S.picture(os.path.join(d, f), w["xyz0"], w["h"], piece, np.array(list(desc)))
        sheets.append({"file": f, "title": f"From above: {tag}"})
    for line in numbers:
        print(line)
    eyes = ["In the views from above, each colour is one thing. Does the 50 ft or 80 ft view still keep separate things separate (a wall apart from a shrub in front of it), or do colours run together?",
            "Does the longer reach fill in parts of the yard the 26 ft view leaves empty, and are those parts drawn in the right place?"]
    keep(d, sid, "The lift with a longer reach", "The cut is SAM objects. A picture names a point only if it saw it. First by the old test (the nearest point in a patch of the picture), then by the picture's own depth, at three reaches.", eyes, numbers, sheets)


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


if __name__ == "__main__":
    main()
