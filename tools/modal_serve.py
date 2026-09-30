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

COST. A GPU (L4) only while lots are being read, plus SCALEDOWN (20) seconds idle
after the last one, so an immediate retry does not pay the cold start
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

import modal

APP = "lawn-mapper-alpha"
GPU = os.environ.get("MODAL_GPU", "L4")
# How long a GPU stays on after its last lot. Was 300 s; cut to 60 s on
# 2026-09-30 (owner: "costs accruing faster than I'd hoped"). Most presses are
# alone, so the idle tail was most of the bill -- roughly 300 of every ~360
# GPU-seconds a lone press paid for. A press within a minute of the last one
# still finds it warm; after that it pays a cold start (~30-60 s) instead.
# 20 s since 2026-09-30 (owner): enough for an immediate Retry or re-detect
# to find the GPU warm, and a lone press no longer pays a minute of idle.
SCALEDOWN = int(os.environ.get("ALPHA_SCALEDOWN", "20"))
# Lots one GPU machine works on at once. Most of a lot is downloads and CPU
# arithmetic, so an overlapping press shares a warm machine rather than
# paying a second cold start (owner, 2026-09-30).
PER_MACHINE = int(os.environ.get("ALPHA_PER_MACHINE", "4"))
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

# THE DOWNLOADS' MACHINE (owner, 2026-09-30): lidar, NAIP and the photograph
# on a CPU, started beside the GPU one -- see tools/alpha_sources.py. No torch.
cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "ca-certificates")
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "apt-get install -y nodejs")
    .pip_install("numpy", "pillow", "scipy", "scikit-image", "laspy[lazrs]")
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


def _gather_here(payload):
    """alpha_sources.gather with this machine's copy of the scorer's `prepare`."""
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import alpha_sources
    fresh = not os.path.exists(FOOTPRINTS)
    out = alpha_sources.gather(payload, lambda body: _node("prepare", body))
    if fresh and os.path.exists(FOOTPRINTS):
        models.commit()
    return out


@app.function(image=cpu_image, volumes={"/models": models}, timeout=300, cpu=1.0, memory=2048,
              # A CPU machine costs a few cents an hour, so it can wait longer
              # for the next lot than the GPU does.
              scaledown_window=300)
def gather(payload):
    """The downloads for one lot, on a CPU: see tools/alpha_sources.py."""
    return _gather_here(payload)


@app.cls(image=gpu_image, gpu=GPU, volumes={"/models": models}, timeout=600,
         scaledown_window=SCALEDOWN,
         # A ceiling on the bill: at most this many GPUs at once, however
         # many lots arrive together (the queue scorer sends dozens).
         max_containers=MAX_CONTAINERS,
         # FASTER COLD STARTS (owner, 2026-09-30). Modal snapshots the
         # container's memory once the big models are loaded, and later cold
         # starts restore from it instead of loading them again -- a GPU
         # billed for seconds, not for most of a minute. The snapshot is
         # taken on the CPU (no GPU is attached then); see the two halves below.
         enable_memory_snapshot=True)
@modal.concurrent(max_inputs=PER_MACHINE)
class Alpha:
    @modal.enter(snap=True)
    def load_models(self):
        """Into the snapshot: Scale-MAE and the tree model, on the CPU.

        torch is told there is no GPU while this runs, so nothing touches
        CUDA before the snapshot -- the modules' own device choice included.
        """
        import torch
        real = torch.cuda.is_available
        torch.cuda.is_available = lambda: False
        try:
            sys.path.insert(0, f"{REPO}/tools")
            os.environ["REFINE"] = "1"
            t0 = time.time()
            import alpha_infer
            self.det = alpha_infer.Detector(None)
            print(f"models loaded for the snapshot in {time.time() - t0:.0f}s", flush=True)
        finally:
            torch.cuda.is_available = real

    @modal.enter(snap=False)
    def onto_gpu(self):
        """After every start, snapshot or not: onto the GPU, then the release.

        The release is read here, never snapshotted, so shipping a new one
        (workflow 14 `release: alpha`) takes effect on the next start.
        """
        import torch
        t0 = time.time()
        self.det.to("cuda" if torch.cuda.is_available() else "cpu")
        self.det.load_release(RELEASE)
        self.version = self.det.release.meta.get("trainedAt") or "unknown"
        # The 3DEP footprints once, onto the volume, so later containers skip
        # the download. Refetched by deleting the file.
        if not os.path.exists(FOOTPRINTS):
            try:
                _node("prepare", {"frame": {"lng": -85.67, "lat": 42.96, "zoom": 19, "size": 640}})
                models.commit()
            except Exception as e:  # noqa: BLE001 - each lot then fetches them itself
                print(f"footprints not cached: {e}", flush=True)
        print(f"alpha release {self.version} ready on {self.det.device} in {time.time() - t0:.1f}s", flush=True)

    @modal.method()
    def detect(self, payload):
        from PIL import Image
        t0 = time.time()
        frame = payload["frame"]
        # The CPU machine's downloads when `start` launched one beside this
        # (it usually finished while this GPU was waking); read here otherwise
        # -- the queue scorer calls this directly, and a failed gather is not
        # a failed lot.
        got = None
        if payload.get("gather"):
            try:
                got = modal.FunctionCall.from_id(payload["gather"]).get(timeout=240)
            except Exception as e:  # noqa: BLE001
                print(f"gather failed, reading here: {e}", flush=True)
        if got is None:
            got = _gather_here(payload)
        waited = round(time.time() - t0, 1)
        prep = got["prep"]
        photo = Image.open(__import__("io").BytesIO(got["photo"])).convert("RGB")
        with tempfile.TemporaryDirectory() as d:
            rec = self.det.run(photo, prep, d, naip_align=payload.get("naipAlign"), sources=got["sources"])
            rec["seconds"]["waited"] = waited
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
    # Both at once: the downloads on a CPU while the GPU machine wakes.
    got = gather.spawn(body)
    call = Alpha().detect.spawn({**body, "gather": got.object_id})
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
