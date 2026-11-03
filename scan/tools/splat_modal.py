"""
A GAUSSIAN SPLAT FROM A WALK'S TWIN (core session, 2026-11-03; the owner: "Do the splat afterwards just for
curiosity sake"). Run by .github/workflows/scan-splat.yml on Modal's GPU (paid: the owner says yes first, every time).

    modal run scan/tools/splat_modal.py --src twin --out out --steps 7000

`twin` holds one walk's parts as scan/lib/twin.js wrote them: keys-*.json (each picture's pose and projection),
key-*.jpg, cloud-*.bin (the depth points), meta.json. The phone already knows where each picture was taken (ARCore's
tracking), so there is no structure-from-motion step: the splat starts from the depth points, coloured from the
pictures, and is trained straight against the pictures with gsplat (github.com/nerfstudio-project/gsplat).

Out, in `out`:
  splat.splat         the splat in the common 32-byte-a-point format (antimatter15/splat), in the walk's own frame
  splat-compare.jpg   a few pictures beside the splat's render of the same view: how it lines up with reality
  splat.json          the numbers: pictures, points, steps, PSNR, which way up the pictures were

The log carries numbers only, never a picture or a place.
"""

import io
import json
import math
import os
import struct
import sys
import time

import modal

GPU = os.environ.get("MODAL_GPU", "L4")
app = modal.App("lawn-scan-splat")
image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("torch==2.4.1", "numpy<2", "pillow")
    .pip_install("https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt24cu121-cp310-cp310-linux_x86_64.whl")
)


def read_twin(src):
    """The parts from the folder, as bytes keyed by name."""
    out = {}
    for name in sorted(os.listdir(src)):
        with open(os.path.join(src, name), "rb") as f:
            out[name] = f.read()
    return out


@app.function(image=image, gpu=GPU, timeout=60 * 60)
def train(parts: dict, steps: int = 7000) -> dict:
    import numpy as np
    import torch
    import torch.nn.functional as F
    from PIL import Image
    from gsplat import rasterization
    from gsplat.strategy import DefaultStrategy

    t0 = time.time()
    dev = "cuda"
    keys = []
    for name in sorted(n for n in parts if n.startswith("keys-") and n.endswith(".json")):
        keys += json.loads(parts[name])
    keys = [k for k in keys if k["name"] in parts]
    if len(keys) < 8:
        return {"error": f"only {len(keys)} pictures: a splat needs many more"}
    imgs = [np.asarray(Image.open(io.BytesIO(parts[k["name"]])).convert("RGB"), dtype=np.float32) / 255.0 for k in keys]
    H, W = imgs[0].shape[:2]
    keep = [i for i, im in enumerate(imgs) if im.shape[:2] == (H, W)]
    keys = [keys[i] for i in keep]
    imgs = torch.tensor(np.stack([imgs[i] for i in keep]), device=dev)

    # WebXR's camera-to-world (column-major, OpenGL: y up, looking down -z) to gsplat's world-to-camera (OpenCV:
    # y down, looking down +z); the projection to pixel intrinsics.
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    c2w = np.stack([np.array(k["view"], dtype=np.float64).reshape(4, 4).T @ flip for k in keys])
    viewmats = torch.tensor(np.linalg.inv(c2w), dtype=torch.float32, device=dev)

    Ks = []
    for k in keys:
        P = k["proj"]
        Ks.append([[P[0] * W / 2, 0, W * (1 - P[8]) / 2], [0, P[5] * H / 2, H * (1 + P[9]) / 2], [0, 0, 1]])
    Ks = torch.tensor(Ks, dtype=torch.float32, device=dev)

    # the depth points, the splat's start
    rec = []
    for name in sorted(n for n in parts if n.startswith("cloud-")):
        rec.append(np.frombuffer(parts[name], dtype=np.float32).reshape(-1, 6))
    pts = np.concatenate(rec)[:, 2:5] if rec else np.zeros((0, 3), np.float32)
    if len(pts) > 400000:
        pts = pts[np.random.default_rng(0).choice(len(pts), 400000, replace=False)]
    if len(pts) < 1000:
        return {"error": f"only {len(pts)} depth points to start from"}
    means0 = torch.tensor(pts, dtype=torch.float32, device=dev)
    cams = torch.tensor(c2w[:, :3, 3], dtype=torch.float32, device=dev)
    scene = float(torch.linalg.norm(cams - cams.mean(0), dim=1).max().item()) * 1.1 + 1.0

    def colour_points(flip_img):
        """Each point's colour from the pictures it falls in (the mean), grey where none."""
        acc = torch.zeros((len(means0), 3), device=dev)
        n = torch.zeros(len(means0), device=dev)
        hom = torch.cat([means0, torch.ones_like(means0[:, :1])], 1)
        for i in range(0, len(keys), max(1, len(keys) // 60)):
            cam = (viewmats[i] @ hom.T).T[:, :3]
            z = cam[:, 2]
            uv = (Ks[i] @ cam.T).T
            u, v = uv[:, 0] / z.clamp(min=1e-6), uv[:, 1] / z.clamp(min=1e-6)
            ok = (z > 0.2) & (u >= 0) & (u < W - 1) & (v >= 0) & (v < H - 1)
            im = imgs[i].flip(0) if flip_img else imgs[i]
            acc[ok] += im[v[ok].long(), u[ok].long()]
            n[ok] += 1
        col = torch.where(n[:, None] > 0, acc / n.clamp(min=1)[:, None], torch.full_like(acc, 0.5))
        return col, int((n > 0).sum().item())

    def ssim(a, b):
        # a, b: (N, H, W, 3) -> mean SSIM, an 11-pixel gaussian window
        a, b = a.permute(0, 3, 1, 2), b.permute(0, 3, 1, 2)
        g = torch.exp(-((torch.arange(11, device=dev) - 5) ** 2) / (2 * 1.5**2))
        g = (g / g.sum())
        w = (g[:, None] @ g[None, :]).expand(3, 1, 11, 11).contiguous()
        mu_a, mu_b = F.conv2d(a, w, padding=5, groups=3), F.conv2d(b, w, padding=5, groups=3)
        s_aa = F.conv2d(a * a, w, padding=5, groups=3) - mu_a**2
        s_bb = F.conv2d(b * b, w, padding=5, groups=3) - mu_b**2
        s_ab = F.conv2d(a * b, w, padding=5, groups=3) - mu_a * mu_b
        c1, c2 = 0.01**2, 0.03**2
        return (((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / ((mu_a**2 + mu_b**2 + c1) * (s_aa + s_bb + c2))).mean()

    def run(n_steps, flip_img, densify):
        col, seen = colour_points(flip_img)
        N = len(means0)
        # each starting gaussian about as wide as the gap to its neighbours: the depth points are ~5 cm apart
        params = torch.nn.ParameterDict({
            "means": torch.nn.Parameter(means0.clone()),
            "scales": torch.nn.Parameter(torch.full((N, 3), math.log(0.04), device=dev)),
            "quats": torch.nn.Parameter(torch.tensor([[1.0, 0, 0, 0]], device=dev).repeat(N, 1)),
            "opacities": torch.nn.Parameter(torch.full((N,), 0.0, device=dev)),  # sigmoid 0.5
            "sh0": torch.nn.Parameter(((col - 0.5) / 0.28209479177387814)[:, None, :]),
        })
        lrs = {"means": 1.6e-4 * scene, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3}
        opts = {k: torch.optim.Adam([{"params": params[k], "lr": lrs[k], "name": k}], eps=1e-15) for k in params}
        strategy = DefaultStrategy(verbose=False, refine_stop_iter=int(n_steps * 0.6), reset_every=10**9 if n_steps < 3000 else 3000)
        strategy.check_sanity(params, opts)
        state = strategy.initialize_state(scene_scale=scene)
        imgs_used = imgs.flip(1) if flip_img else imgs
        gen = torch.Generator(device="cpu").manual_seed(0)
        loss_v = 0.0
        for step in range(n_steps):
            i = int(torch.randint(0, len(keys), (1,), generator=gen))
            render, _, info = rasterization(
                params["means"], F.normalize(params["quats"], dim=-1), torch.exp(params["scales"]), torch.sigmoid(params["opacities"]),
                params["sh0"], viewmats[i:i + 1], Ks[i:i + 1], W, H, sh_degree=0, packed=False)
            img = render[..., :3].clamp(0, 1)
            gt = imgs_used[i:i + 1]
            loss = 0.8 * (img - gt).abs().mean() + 0.2 * (1 - ssim(img, gt))
            if densify:
                strategy.step_pre_backward(params, opts, state, step, info)
            loss.backward()
            for o in opts.values():
                o.step()
                o.zero_grad(set_to_none=True)
            if densify:
                strategy.step_post_backward(params, opts, state, step, info, packed=False)
            loss_v = 0.98 * loss_v + 0.02 * float(loss.item()) if step else float(loss.item())
        return params, loss_v, seen

    # which way up the pictures are is not certain (GL reads rows bottom first; the page flips them): a short
    # trial each way, and the lower loss wins
    trials = {}
    for upright in (True, False):
        _, l, _ = run(400, not upright, False)
        trials[upright] = l
    upright = trials[True] <= trials[False]
    params, loss_v, seen = run(steps, not upright, True)

    # the numbers, and a few pictures beside the splat's render of the same view
    imgs_used = imgs if upright else imgs.flip(1)
    psnrs, tiles = [], []
    with torch.no_grad():
        for i in np.linspace(0, len(keys) - 1, num=min(6, len(keys))).astype(int):
            render, _, _ = rasterization(
                params["means"], F.normalize(params["quats"], dim=-1), torch.exp(params["scales"]), torch.sigmoid(params["opacities"]),
                params["sh0"], viewmats[i:i + 1], Ks[i:i + 1], W, H, sh_degree=0, packed=False)
            img = render[0, ..., :3].clamp(0, 1)
            mse = float(((img - imgs_used[i]) ** 2).mean().item())
            psnrs.append(10 * math.log10(1 / max(mse, 1e-10)))
            tiles.append(torch.cat([imgs_used[i], img], 1))
    grid = (torch.cat(tiles, 0).cpu().numpy() * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(grid).save(buf, format="JPEG", quality=85)

    # the .splat: position, scale, colour + opacity, rotation; the biggest, most opaque first
    with torch.no_grad():
        m = params["means"].cpu().numpy().astype(np.float32)
        s = torch.exp(params["scales"]).cpu().numpy().astype(np.float32)
        q = F.normalize(params["quats"], dim=-1).cpu().numpy()
        a = torch.sigmoid(params["opacities"]).cpu().numpy()
        c = (0.5 + 0.28209479177387814 * params["sh0"][:, 0, :]).clamp(0, 1).cpu().numpy()
    order = np.argsort(-(s.prod(1) * a))
    rec = np.zeros(len(m), dtype=[("m", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("q", "u1", 4)])
    rec["m"], rec["s"] = m[order], s[order]
    rec["c"] = np.clip(np.concatenate([c[order], a[order, None]], 1) * 255, 0, 255).astype(np.uint8)
    rec["q"] = np.clip(q[order] * 128 + 128, 0, 255).astype(np.uint8)
    out = io.BytesIO(rec.tobytes())
    numbers = {"pictures": len(keys), "size": [W, H], "startPoints": int(len(means0)), "pointsColoured": seen, "gaussians": int(len(m)),
               "steps": steps, "psnr": round(sum(psnrs) / len(psnrs), 2), "upright": bool(upright),
               "trialLoss": {"upright": round(trials[True], 4), "flipped": round(trials[False], 4)}, "seconds": round(time.time() - t0)}
    return {"splat": out.getvalue(), "compare": buf.getvalue(), "numbers": numbers}


@app.local_entrypoint()
def main(src: str = "twin", out: str = "out", steps: int = 7000):
    parts = read_twin(src)
    keys = sum(1 for n in parts if n.startswith("key-"))
    print(f"Sending {len(parts)} parts ({sum(len(v) for v in parts.values()) / 1e6:.1f} MB, {keys} pictures) to the GPU ({GPU}).")
    r = train.remote(parts, steps)
    os.makedirs(out, exist_ok=True)
    if r.get("error"):
        print(f"No splat: {r['error']}")
        with open(os.path.join(out, "splat.json"), "w") as f:
            json.dump({"error": r["error"]}, f)
        sys.exit(1)
    with open(os.path.join(out, "splat.splat"), "wb") as f:
        f.write(r["splat"])
    with open(os.path.join(out, "splat-compare.jpg"), "wb") as f:
        f.write(r["compare"])
    with open(os.path.join(out, "splat.json"), "w") as f:
        json.dump(r["numbers"], f)
    print("SPLAT " + json.dumps(r["numbers"]))
