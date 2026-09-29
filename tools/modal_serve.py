"""
THE LIVE DETECTOR: "Trained model (alpha release)" on Modal (owner, 2026-09-29).

THE PLAN (H60) served for real: Scale-MAE over the whole lot, the fused
decoder with the edge refiner, stage 3 over the tree model's canopy, and the
lidar veto -- the pipeline that scored 24.0% in run 36601001355, trained once
more on every approved lot (workflow 14 `release: alpha`) because a scoring
run keeps no weights.

HOW THE SITE USES IT. Same shape as the Replicate calls it already makes:

    POST {start url}   {imageUrl, frame, parcel?, naipAlign?}   -> {id}
    GET  {result url}?id=...                                   -> {status: running | succeeded | failed, ...}
    POST {cancel url}?id=...                                   -> {cancelled}

The worker (worker/src/index.js, model "alpha") sends the photograph's URL --
the same capture tools/train-detector.js trained on -- and polls. Both
endpoints want `Authorization: Bearer <ALPHA_TOKEN>`; workflow 2 derives the
token from the Modal secret and hands it to both sides.

COST. A GPU (L4) only while lots are being read, plus SCALEDOWN seconds idle
after the last one so a second lot minutes later does not pay the cold start
again. Nothing runs, and nothing is billed, when nobody is detecting.

    modal deploy tools/modal_serve.py        (workflow 2 does this)
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import modal

APP = "lawn-mapper-alpha"
GPU = os.environ.get("MODAL_GPU", "L4")
SCALEDOWN = int(os.environ.get("ALPHA_SCALEDOWN", "300"))
MAX_CONTAINERS = int(os.environ.get("ALPHA_MAX_CONTAINERS", "3"))
FOOTPRINTS = "/models/footprints.json"
MODELS_VOLUME = "lawn-mapper-models"
RELEASE = "/models/alpha/model.pt"
REPO = "/root/repo"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

app = modal.App(APP)
models = modal.Volume.from_name(MODELS_VOLUME, create_if_missing=True)


def _bake_weights():
    """The two big downloads, into the image, so a cold start does not repeat them."""
    from torchgeo.models import ScaleMAELarge16_Weights, scalemae_large_patch16
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
    scalemae_large_patch16(weights=ScaleMAELarge16_Weights.FMOW_RGB, img_size=896, res=1.0)
    SegformerForSemanticSegmentation.from_pretrained("restor/tcd-segformer-mit-b5")
    SegformerImageProcessor.from_pretrained("restor/tcd-segformer-mit-b5", do_resize=False)


gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    # Node 22, as CI runs: Debian's own is too old for the scorer's modules.
    .apt_install("curl", "ca-certificates")
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "apt-get install -y nodejs")
    .pip_install(
        "torch", "torchvision", "transformers", "pillow", "numpy", "torchgeo>=0.7",
        "scikit-image", "scipy", "laspy[lazrs]", "fastapi[standard]",
    )
    .run_function(_bake_weights)
    # The repository's .js files are ES modules, as its package.json says.
    .run_commands(f"mkdir -p {REPO} && cd {REPO} && echo '{{\"type\": \"module\", \"private\": true}}' > package.json"
                  " && npm install pngjs@7 >/dev/null")
    .add_local_dir(os.path.join(ROOT, "tools"), f"{REPO}/tools",
                   ignore=["**/__pycache__/**", "**/*.test.*", "**/*_test.py"])
    .add_local_dir(os.path.join(ROOT, "worker", "src"), f"{REPO}/worker/src")
    .add_local_dir(os.path.join(ROOT, "public", "lib"), f"{REPO}/public/lib")
)

web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")
auth = modal.Secret.from_name("lawn-alpha-auth")


def _node(cmd, payload):
    r = subprocess.run(["node", f"{REPO}/tools/serve-alpha.mjs", cmd], input=json.dumps(payload),
                       capture_output=True, text=True, cwd=REPO, timeout=300,
                       env={**os.environ, "LIDAR_FOOTPRINTS_FILE": FOOTPRINTS})
    if r.returncode:
        raise RuntimeError(f"serve-alpha {cmd}: {r.stderr[-600:]}")
    return json.loads(r.stdout)


@app.cls(image=gpu_image, gpu=GPU, volumes={"/models": models}, timeout=600,
         scaledown_window=SCALEDOWN,
         # A ceiling on the bill: at most this many GPUs at once, however
         # many lots arrive together (the queue scorer sends dozens).
         max_containers=MAX_CONTAINERS)
class Alpha:
    @modal.enter()
    def load(self):
        sys.path.insert(0, f"{REPO}/tools")
        os.environ["REFINE"] = "1"
        import alpha_infer
        t0 = time.time()
        self.det = alpha_infer.Detector(RELEASE)
        self.version = self.det.release.meta.get("trainedAt") or "unknown"
        # The 3DEP footprints once, onto the volume, so later containers skip
        # the download. Refetched by deleting the file.
        if not os.path.exists(FOOTPRINTS):
            try:
                _node("prepare", {"frame": {"lng": -85.67, "lat": 42.96, "zoom": 19, "size": 640}})
                models.commit()
            except Exception as e:  # noqa: BLE001 - each lot then fetches them itself
                print(f"footprints not cached: {e}", flush=True)
        print(f"alpha release {self.version} loaded in {time.time() - t0:.0f}s", flush=True)

    @modal.method()
    def detect(self, payload):
        from PIL import Image
        t0 = time.time()
        frame = payload["frame"]
        prep = _node("prepare", {"frame": frame})
        req = urllib.request.Request(payload["imageUrl"], headers={"User-Agent": "lawn-mapper-alpha"})
        with urllib.request.urlopen(req, timeout=60) as r:
            photo = Image.open(__import__("io").BytesIO(r.read())).convert("RGB")
        with tempfile.TemporaryDirectory() as d:
            rec = self.det.run(photo, prep, d, naip_align=payload.get("naipAlign"))
            fin = _node("finish", {"dir": d, "w": prep["w"], "h": prep["h"], "mpp": prep["mpp"],
                                   "frame": frame, "parcel": payload.get("parcel")})
            with open(os.path.join(d, "final.png"), "rb") as f:
                mask = base64.b64encode(f.read()).decode()
        return {
            "mask": mask, "w": prep["w"], "h": prep["h"], "version": self.version,
            "uncertainty": fin.get("uncertainty"), "lawnCells": fin.get("lawnCells"),
            "used": {"lidar": rec["lidar"], "naip": rec["naip"]},
            "seconds": {**rec["seconds"], "total": round(time.time() - t0, 1)},
        }


def _authorised(header):
    want = os.environ.get("ALPHA_TOKEN", "")
    return bool(want) and header == f"Bearer {want}"


with web_image.imports():
    from fastapi import HTTPException, Request  # noqa: F401 - resolved in the container


@app.function(image=web_image, secrets=[auth])
@modal.fastapi_endpoint(method="POST")
async def start(request: "Request"):
    """Begin one lot; answers at once with the id to poll."""
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="not authorised")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = None
    if not isinstance(body, dict) or not body.get("imageUrl") or not isinstance(body.get("frame"), dict):
        raise HTTPException(status_code=400, detail="imageUrl and frame are required")
    call = Alpha().detect.spawn(body)
    return {"id": call.object_id}


@app.function(image=web_image, secrets=[auth])
@modal.fastapi_endpoint(method="GET")
def result(id: str, request: "Request"):
    """Where a lot has got to: running, succeeded (with the mask), or failed."""
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="not authorised")
    try:
        call = modal.FunctionCall.from_id(id)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="unknown id")
    try:
        out = call.get(timeout=0)
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:  # noqa: BLE001 - the detection itself failed
        return {"status": "failed", "error": str(e)[:300]}
    return {"status": "succeeded", **out}


@app.function(image=web_image, secrets=[auth])
@modal.fastapi_endpoint(method="POST")
def cancel(id: str, request: "Request"):
    """Stop a lot the person gave up waiting for, so the GPU stops too."""
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="not authorised")
    try:
        modal.FunctionCall.from_id(id).cancel()
    except Exception:  # noqa: BLE001 - already finished or unknown: nothing to stop
        return {"cancelled": False}
    return {"cancelled": True}
