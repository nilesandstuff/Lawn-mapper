"""
A SMALL GROUND LABELLER FOR THE PHONE, TAUGHT BY THE LARGE ONE (core session, 2026-11-26). The owner: "I wonder if there's
any substitute for the native arcore scene semantics that can run live on the user's phone and get more granular labels...
maybe that 'substitute' labeler could run on the user's phone after a walk?" -- and the $15 of Modal for the AR work is
the core session's to spend (the owner, 2026-11-26).

The large panoptic model (Mask2Former, swin-large, ADE20K: on the owner's own names 97% with the ground as one kind, 89%
with the kinds of ground apart) is too heavy for a phone; SegFormer-B0 (3.7 M weights) is light enough but, off the shelf,
reads November lawn as earth (S4 run 10). So B0 is trained, on Modal's GPU, to give the large model's answer on the walks'
own pictures, in the few kinds the maps use (KINDS). Measured on a walk it was NOT trained on: how often it gives the large
model's kind, against B0 off the shelf mapped to the same kinds. Then trained on every walk given, and written out as ONNX
(and an 8-bit copy) for the page to run after a walk.

    modal run scan/tools/distill_modal.py --data data.npz --out out

data.npz (distill_prep): jpeg (bytes of every picture, joined), cuts (their offsets), target (N, TH, TW) uint8 kinds, 255
where the large model named nothing; walk (N,) which walk each picture is of. Pictures only: no pose, no place.
"""
import io
import json
import os
import time

import modal

GPU = os.environ.get("MODAL_GPU", "L4")
BASE = "nvidia/segformer-b0-finetuned-ade-512-512"
KINDS = ["other", "turf", "low plants", "porous", "paved", "tree", "built", "sky"]
TW, TH = 320, 704          # the size trained at: the app's pictures are portrait, 480 x 1067
TTW, TTH = TW // 4, TH // 4

app = modal.App("lawn-scan-distill")


def fetch():
    from huggingface_hub import snapshot_download
    snapshot_download(BASE, allow_patterns=["*.json", "*.safetensors", "*.bin", "*.txt"])


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.4.1", "transformers==4.46.3", "numpy<2", "pillow", "huggingface_hub", "onnx==1.16.2", "onnxruntime==1.19.2")
    .run_function(fetch)
)


@app.function(image=image, gpu=GPU, timeout=60 * 60)
def train(data: bytes, epochs: int = 14) -> dict:
    import numpy as np
    import torch
    import torch.nn.functional as F
    from PIL import Image
    from transformers import SegformerForSemanticSegmentation
    t0 = time.time()
    z = np.load(io.BytesIO(data), allow_pickle=False)
    blob, cuts, target, walk = z["jpeg"].tobytes(), z["cuts"], z["target"], z["walk"]
    base_map = json.loads(str(z["base_map"]))     # B0's own 150 ADE classes -> our kinds, for the yardstick
    # THE YARD LABELLER (2026-11-28, yard_distill_prep.py): its own kinds, the owner's names apart as the answer key
    # (taught three times as hard), and a held-out run of the walk by time
    kinds = json.loads(str(z["kinds"])) if "kinds" in z else KINDS
    owner = z["owner"] if "owner" in z else None
    hold_mask = z["hold"] if "hold" in z else None
    n = len(cuts) - 1
    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1); std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
    imgs = np.zeros((n, TH, TW, 3), np.uint8)
    for i in range(n):
        im = Image.open(io.BytesIO(blob[cuts[i]:cuts[i + 1]])).convert("RGB").resize((TW, TH), Image.BILINEAR)
        imgs[i] = np.asarray(im)
    X = torch.from_numpy(imgs).permute(0, 3, 1, 2).float().div(255)
    X = (X - mean) / std
    Y = torch.from_numpy(target.astype(np.int64))
    O = torch.from_numpy(owner.astype(np.int64)) if owner is not None else None
    dev = "cuda"
    walks = sorted(set(int(w) for w in walk))

    def make():
        m = SegformerForSemanticSegmentation.from_pretrained(BASE, num_labels=len(kinds), ignore_mismatched_sizes=True)
        return m.to(dev)

    def fit(m, idx, ep):
        opt = torch.optim.AdamW(m.parameters(), lr=2e-4, weight_decay=0.01)
        steps = ep * ((len(idx) + 7) // 8); sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-4, total_steps=max(1, steps))
        m.train()
        for e in range(ep):
            perm = idx[torch.randperm(len(idx))]
            for b in range(0, len(perm), 8):
                j = perm[b:b + 8]
                x, y = X[j].to(dev), Y[j].to(dev)
                wt = (1.0 + 2.0 * (O[j] != 255).float()).to(dev) if O is not None else torch.ones_like(y, dtype=torch.float32)
                if torch.rand(1).item() < 0.5:
                    x, y, wt = x.flip(3), y.flip(2), wt.flip(2)
                x = x * (0.8 + 0.4 * torch.rand(len(j), 1, 1, 1, device=dev)) + 0.2 * (torch.rand(len(j), 3, 1, 1, device=dev) - 0.5)
                lo = m(pixel_values=x).logits
                lo = F.interpolate(lo, size=y.shape[-2:], mode="bilinear", align_corners=False)
                ce = F.cross_entropy(lo, y, ignore_index=255, reduction="none")
                ok = (y != 255).float()
                loss = (ce * wt * ok).sum() / (wt * ok).sum().clamp(min=1)
                opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            print(f"  pass {e + 1} of {ep}: loss {loss.item():.3f} ({round(time.time() - t0)} s)", flush=True)
        return m

    @torch.no_grad()
    def judge(predict, idx, key=None):
        key = Y if key is None else key
        conf = np.zeros((len(kinds), len(kinds)), np.int64)
        for b in range(0, len(idx), 16):
            j = idx[b:b + 16]
            p = predict(X[j].to(dev)).cpu().numpy(); y = key[j].numpy()
            ok = y != 255
            np.add.at(conf, (y[ok], p[ok]), 1)
        acc = conf.trace() / max(1, conf.sum())
        ground = [1, 2, 3, 4]
        gi = np.ix_(ground, ground); gacc = conf[gi].trace() / max(1, conf[ground].sum())
        per = {kinds[k]: round(float(conf[k, k] / max(1, conf[k].sum())), 3) for k in range(len(kinds)) if conf[k].sum()}
        said = {kinds[k]: kinds[int(np.argmax(np.where(np.arange(len(kinds)) == k, -1, conf[k])))] for k in range(len(kinds)) if conf[k].sum() > conf[k, k]}
        return {"agree": round(float(acc), 3), "ground_kinds_agree": round(float(gacc), 3), "per_kind_recall": per,
                "large_says": {kinds[k]: int(conf[k].sum()) for k in range(len(kinds)) if conf[k].sum()}, "else_mostly": said}

    out = {"pictures": n, "walks": len(walks)}
    # THE YARDSTICK: B0 off the shelf, its 150 classes mapped to ours
    base = SegformerForSemanticSegmentation.from_pretrained(BASE).to(dev).eval()
    lut = torch.tensor([base_map.get(str(i), 0) for i in range(base.config.num_labels)], device=dev)

    def base_pred(x):
        lo = F.interpolate(base(pixel_values=x).logits, size=(TTH, TTW), mode="bilinear", align_corners=False)
        return lut[lo.argmax(1)]
    if hold_mask is not None and hold_mask.any():
        tr = torch.tensor([i for i in range(n) if not hold_mask[i]]); te = torch.tensor([i for i in range(n) if hold_mask[i]])
        m = fit(make(), tr, epochs).eval()
        pred = lambda x: F.interpolate(m(pixel_values=x).logits, size=(TTH, TTW), mode="bilinear", align_corners=False).argmax(1)
        out["held_out"] = {"pictures": len(te), "taught_against_lessons": judge(pred, te)}
        if O is not None:
            out["held_out"]["taught_against_owner"] = judge(pred, te, O)
        del m
    elif len(walks) >= 2:
        hold = walks[-1]
        tr = torch.tensor([i for i in range(n) if int(walk[i]) != hold]); te = torch.tensor([i for i in range(n) if int(walk[i]) == hold])
        out["held_out"] = {"pictures": len(te), "off_the_shelf": judge(base_pred, te)}
        m = fit(make(), tr, epochs).eval()
        out["held_out"]["taught"] = judge(lambda x: F.interpolate(m(pixel_values=x).logits, size=(TTH, TTW), mode="bilinear", align_corners=False).argmax(1), te)
        del m
    m = fit(make(), torch.arange(n), epochs).eval()
    # ONNX: in, the picture (1, 3, TH, TW) normalised; out, the kinds' scores at a quarter of that
    buf = io.BytesIO()

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__(); self.m = m

        def forward(self, x):
            return self.m(pixel_values=x).logits
    torch.onnx.export(Wrap(m).cpu().eval(), torch.zeros(1, 3, TH, TW), buf, input_names=["pixels"], output_names=["kinds"], opset_version=17, dynamic_axes={"pixels": {2: "h", 3: "w"}, "kinds": {2: "h4", 3: "w4"}})
    onnx_bytes = buf.getvalue()
    # THE 8-BIT COPY (S5 run 1, 2026-11-26: onnxruntime's quantizer failed on a node with no scale, after 30 minutes of
    # teaching, and nothing was kept): only the matrix products made 8-bit, and a failure no longer loses the model
    q, qwhy = b"", None
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        open("/tmp/m.onnx", "wb").write(onnx_bytes)
        quantize_dynamic("/tmp/m.onnx", "/tmp/m8.onnx", weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
        q = open("/tmp/m8.onnx", "rb").read()
    except Exception as e:
        qwhy = f"{type(e).__name__}: {str(e)[:160]}"
    out.update({"kinds": kinds, "size": [TW, TH], "seconds": round(time.time() - t0), "onnx_mb": round(len(onnx_bytes) / 1e6, 1), "onnx8_mb": round(len(q) / 1e6, 1) if q else None, "onnx8_failed": qwhy})
    return {"numbers": out, "onnx": onnx_bytes, "onnx8": q}


@app.local_entrypoint()
def main(data: str = "data.npz", out: str = "out", epochs: int = 14, name: str = "ground-labeller"):
    os.makedirs(out, exist_ok=True)
    r = train.remote(open(data, "rb").read(), epochs)
    open(os.path.join(out, f"{name}.onnx"), "wb").write(r["onnx"])
    if r["onnx8"]:
        open(os.path.join(out, f"{name}-8bit.onnx"), "wb").write(r["onnx8"])
    json.dump(r["numbers"], open(os.path.join(out, "numbers.json"), "w"))
    print("DISTILL " + json.dumps(r["numbers"]))
