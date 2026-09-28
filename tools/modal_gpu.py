"""
The GPU half of workflow 14, on Modal (owner, 2026-09-28).

WHY. On GitHub's free four-core runner the backbone, the tree model and the
decoders are most of a run: 46 min of backbone and 33 min a decoder once the
not-lawn examples went in, and the 6 cm blocks could not finish inside a job
at all. The downloads (lidar, NAIP) and the scorer stay on GitHub, because a
GPU does nothing for a network wait and the scorer is Node.

HOW. Workflow 14 calls this with a JSON file of steps:

    modal run tools/modal_gpu.py --plan plan.json

    {"run": "gh-123-1",                 a folder of its own on the volume
     "send": ["frames", "lidar"],       local paths, tarred up and unpacked there
     "steps": [{"script": "extract_features.py", "env": {"IMAGES": "frames", ...}}],
     "fetch": ["feats", "preds"],       tarred there, unpacked here afterwards
     "cleanup": false}                  delete the run's folder when done

Each script runs exactly as it does on GitHub -- same file, same environment
variables, same relative folders -- in the run's folder on the volume, so
what one call writes (the canopy) the next call can read. The scripts pick
the GPU up for themselves (DEVICE in each).

ONE TAR EACH WAY, NOT FILES: every lot id has two colons in it, which is what
broke the first GitHub artifact handoff (36471713925).

Credentials: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in the environment, which
the modal client reads on its own. GPU type: MODAL_GPU (default L4).
"""

import io
import json
import os
import subprocess
import sys
import tarfile
import time

import modal

GPU = os.environ.get("MODAL_GPU", "L4")
VOLUME = "lawn-mapper-runs"
TOOLS = os.path.dirname(os.path.abspath(__file__))

app = modal.App("lawn-mapper-gpu")

# The CUDA wheels, which is the point; the pins mirror tools/requirements*.txt
# minus the CPU index. Built once by Modal and cached until this list changes.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch",
        "torchvision",
        "transformers",
        "pillow",
        "numpy",
        "torchgeo>=0.7",
        "scikit-image",
        "scipy",
    )
    .add_local_dir(TOOLS, "/root/tools", ignore=["**/__pycache__/**", "**/*.js", "**/*.test.*"])
)

volume = modal.Volume.from_name(VOLUME, create_if_missing=True)


@app.function(image=image, gpu=GPU, volumes={"/work": volume}, timeout=6 * 3600, memory=32768)
def run(run_dir: str, steps: list, fetch: list):
    volume.reload()
    here = f"/work/{run_dir}"
    os.makedirs(here, exist_ok=True)
    os.chdir(here)

    for name in sorted(os.listdir(here)):
        if name.startswith("in-") and name.endswith(".tar"):
            with tarfile.open(name) as t:
                t.extractall(".")
            os.remove(name)
            print(f"unpacked {name}", flush=True)

    import torch

    print(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE -- running on CPU'}",
          flush=True)

    for step in steps:
        started = time.time()
        print(f"\n=== {step['script']} ===", flush=True)
        env = dict(os.environ, **{k: str(v) for k, v in (step.get("env") or {}).items()})
        code = subprocess.run([sys.executable, f"/root/tools/{step['script']}"], env=env).returncode
        print(f"=== {step['script']}: exit {code}, {time.time() - started:.0f}s ===", flush=True)
        if code:
            volume.commit()
            raise RuntimeError(f"{step['script']} failed with exit code {code}")

    have = [p for p in fetch if os.path.exists(p)]
    if have:
        with tarfile.open("out.tar", "w") as t:
            for p in have:
                t.add(p)
    volume.commit()
    return have


def _send(run_dir, paths):
    """Local paths -> one tar on the volume, unpacked by `run` before its steps."""
    have = [p for p in paths if os.path.exists(p)]
    if not have:
        return
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for p in have:
            t.add(p)
    size = buf.tell()
    buf.seek(0)
    started = time.time()
    with volume.batch_upload(force=True) as up:
        up.put_file(buf, f"/{run_dir}/in-{int(time.time() * 1000)}.tar")
    print(f"sent {', '.join(have)}: {size / 1e6:.0f} MB in {time.time() - started:.0f}s", flush=True)


def _fetch(run_dir):
    started = time.time()
    size = 0
    with open("modal-out.tar", "wb") as f:
        for chunk in volume.read_file(f"/{run_dir}/out.tar"):
            f.write(chunk)
            size += len(chunk)
    with tarfile.open("modal-out.tar") as t:
        t.extractall(".")
    os.remove("modal-out.tar")
    print(f"fetched {size / 1e6:.0f} MB in {time.time() - started:.0f}s", flush=True)


@app.local_entrypoint()
def main(plan: str):
    with open(plan) as f:
        p = json.load(f)
    run_dir = p["run"]
    _send(run_dir, p.get("send") or [])
    got = run.remote(run_dir, p.get("steps") or [], p.get("fetch") or [])
    if got:
        _fetch(run_dir)
        print(f"back from Modal: {', '.join(got)}", flush=True)
    if p.get("cleanup"):
        volume.remove_file(f"/{run_dir}", recursive=True)
        print(f"removed {run_dir} from the volume", flush=True)
