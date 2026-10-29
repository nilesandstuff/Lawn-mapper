"""
THE LIVE DETECTOR: "Trained model (alpha release)" on Modal (owner, 2026-09-29).

THE PLAN (H60) served for real: Scale-MAE over the whole lot, the fused
decoder with the edge refiner, stage 3 over the tree model's canopy, and the
lidar veto -- the pipeline that scored 24.0% in run 36601001355, trained once
more on every approved lot (workflow 14 `release: alpha`) because a scoring
run keeps no weights.

HOW THE SITE USES IT. Same shape as the Replicate calls it already makes:

    POST {start url}   {imageUrl, frame, parcel?, naipAlign?, tiles?, cols?, rows?}   -> {id}
    GET  {result url}?id=...                                   -> {status: running | succeeded | failed, ...}
    POST {cancel url}?id=...                                   -> {cancelled}

The worker (worker/src/index.js, model "alpha") sends the photograph's URL --
the same capture tools/train-detector.js trained on -- and polls. Both
endpoints want `Authorization: Bearer <ALPHA_TOKEN>`; workflow 2 derives the
token from the Modal secret and hands it to both sides.

COST. A GPU (L4, or an A10G when no L4 is free) only while lots are being read, plus SCALEDOWN (20) seconds idle
after the last one, so an immediate retry does not pay the cold start
again. Nothing runs, and nothing is billed, when nobody is detecting.

    modal deploy tools/modal_serve.py        (workflow 2 does this)
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import modal

APP = "lawn-mapper-alpha"
# THE L4 FIRST, AN A10G WHEN NO L4 IS FREE (owner, 2026-10-27: "Yes add a10g
# backup"). On 2026-10-27 Modal had no L4 for at least half an hour and every
# press waited, then timed out. Modal takes a list and tries it in order; the
# A10G (about $1.10 an hour against $0.80) is only used when no L4 is free.
# MODAL_GPU may name one type, or several separated by commas.
GPU = [g.strip() for g in os.environ.get("MODAL_GPU", "L4,A10G").split(",") if g.strip()]
GPU = GPU[0] if len(GPU) == 1 else GPU
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
# USGS'S NEWER FLIGHTS (owner, 2026-10-13: "go ahead with the cache"; H96).
# Where the newest flight over a lot is only USGS's LAZ tiles (57-520 MB
# each, not yet an octree on AWS), they are fetched once, in the background,
# onto this volume; the lot is served from the newest octree meanwhile, and
# every later lot in those tiles reads them from here. Grows only with the
# places people ask about.
TILES_VOLUME = "lawn-lidar-tiles"
TILE_DIR = "/tiles"
tiles = modal.Volume.from_name(TILES_VOLUME, create_if_missing=True)


# THE EYES A RELEASE MAY NAME (H114, 2026-10-23): DINOv3's satellite ViT-L
# beat Scale-MAE lot by lot, so a release may be trained on it. Its weights
# are gated on the hub; the HF_TOKEN in the lawn-alpha-auth secret (workflow
# 2 writes it from the repository secret) opens them at image build, and
# again at run time if a release names an eye the image does not hold.
DINOV3_EYES = ("facebook/dinov3-vitl16-pretrain-sat493m",)


def _bake_weights():
    """The big downloads, into the image, so a cold start does not repeat them."""
    from torchgeo.models import ScaleMAELarge16_Weights, scalemae_large_patch16
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
    scalemae_large_patch16(weights=ScaleMAELarge16_Weights.FMOW_RGB, img_size=896, res=1.0)
    SegformerForSemanticSegmentation.from_pretrained("restor/tcd-segformer-mit-b5")
    SegformerImageProcessor.from_pretrained("restor/tcd-segformer-mit-b5", do_resize=False)
    if os.environ.get("HF_TOKEN"):
        from transformers import AutoImageProcessor, AutoModel
        for eye in DINOV3_EYES:
            try:
                AutoModel.from_pretrained(eye)
                AutoImageProcessor.from_pretrained(eye)
                print(f"baked {eye}", flush=True)
            except Exception as e:  # noqa: BLE001 - the image still builds; a release on it would fetch at start
                print(f"not baked, {eye}: {str(e)[:200]}", flush=True)
    else:
        print("no HF_TOKEN at build: DINOv3's weights not baked", flush=True)


auth = modal.Secret.from_name("lawn-alpha-auth")

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    # Node 22, as CI runs: Debian's own is too old for the scorer's modules.
    .apt_install("curl", "ca-certificates")
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "apt-get install -y nodejs")
    .pip_install(
        "torch", "torchvision", "transformers", "pillow", "numpy", "torchgeo>=0.7",
        "scikit-image", "scipy", "laspy[lazrs]", "fastapi[standard]",
    )
    .run_function(_bake_weights, secrets=[auth])
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
    # rasterio: the CRS of USGS's tiles, to Web Mercator (tools/lidar_sources.py).
    .pip_install("numpy", "pillow", "scipy", "scikit-image", "laspy[lazrs]", "rasterio")
    .run_commands(f"mkdir -p {REPO} && cd {REPO} && echo '{{\"type\": \"module\", \"private\": true}}' > package.json"
                  " && npm install pngjs@7 >/dev/null")
    .add_local_dir(os.path.join(ROOT, "tools"), f"{REPO}/tools",
                   ignore=["**/__pycache__/**", "**/*.test.*", "**/*_test.py"])
    .add_local_dir(os.path.join(ROOT, "worker", "src"), f"{REPO}/worker/src")
    .add_local_dir(os.path.join(ROOT, "public", "lib"), f"{REPO}/public/lib")
)

web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


def _node(cmd, payload):
    r = subprocess.run(["node", f"{REPO}/tools/serve-alpha.mjs", cmd], input=json.dumps(payload),
                       capture_output=True, text=True, cwd=REPO, timeout=300,
                       env={**os.environ, "LIDAR_FOOTPRINTS_FILE": FOOTPRINTS})
    if r.returncode:
        raise RuntimeError(f"serve-alpha {cmd}: {r.stderr[-600:]}")
    return json.loads(r.stdout)


_footprints_lock = threading.Lock()


def _prepare(body):
    """The scorer's `prepare`. The first call on a machine with no 3DEP
    footprints file downloads and writes it; with several lots in flight that
    happens under a lock, so no lot reads a half-written file."""
    if os.path.exists(FOOTPRINTS):
        return _node("prepare", body)
    with _footprints_lock:
        fresh = not os.path.exists(FOOTPRINTS)
        out = _node("prepare", body)
        if fresh and os.path.exists(FOOTPRINTS):
            models.commit()
        return out


def _gather_here(payload, tile_fetch=None):
    """alpha_sources.gather with this machine's copy of the scorer's `prepare`."""
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import alpha_sources
    key = payload.get("progressKey")
    return alpha_sources.gather(payload, _prepare, progress=lambda stage, **more: _note(key, stage, **more),
                                cache_dir="/models/lidar-cache", tile_fetch=tile_fetch)


# WHO IS FETCHING WHICH TILE (lidar_tiles below): a page asks every few
# seconds while the server fetches; the first ask starts the fetch and the
# rest only wait, unless the last start is twenty minutes old.
fetching = modal.Dict.from_name("lawn-lidar-tiles-fetching", create_if_missing=True)
FETCH_AGAIN_S = 1200
# ONE DOWNLOAD A TILE, WHOEVER ASKS (2026-10-29). The address's warm-up
# (lidar_warm), a shade or water page (lidar_tiles) and the detector's press
# (gather) can all want the same tile within a minute of each other; rockyweb
# serves one machine slowly and refuses a crowd. The first to ask writes the
# note above and fetches; the others wait for the file to appear on the
# volume, reading how far it has got from tile_progress.
#
# A PRESS WAITS FOR THE NEWEST LIDAR, AND SAYS SO (owner, 2026-10-29: "if a
# lidar tile download is still pending when the user presses detect, add an
# intermediate waiting step until the lidar arrives and is cropped. We don't
# need to warm up the machine while it's waiting for a slow download, and the
# user should be made aware that the tile download is adding extra wait
# time"). The gather waits up to PRESS_TILE_WAIT_S, saying the MB and the
# minutes left on the press's line; the GPU is asked for only after the
# gather (`lot`), so nothing is billed for the wait but this CPU machine.
tile_progress = modal.Dict.from_name("lawn-lidar-tiles-progress", create_if_missing=True)
PRESS_TILE_WAIT_S = 900
GATHER_TIMEOUT_S = PRESS_TILE_WAIT_S + 600  # the wait, then the read, NAIP and the photo
WAIT_STEP_S = 5


NOTE_EVERY_S = 60


class _Holding:
    """The note that this machine is fetching `name`, rewritten every
    NOTE_EVERY_S while it does: a download that waits out USGS's 429s for half
    an hour must not look abandoned after FETCH_AGAIN_S, or a second machine
    starts the same tile beside it and doubles the crowd USGS refuses."""

    def __init__(self, name):
        import threading
        self.name, self.stop = name, threading.Event()

    def _beat(self):
        while not self.stop.wait(NOTE_EVERY_S):
            try:
                fetching[self.name] = time.time()
            except Exception:  # noqa: BLE001 - a note that fails to write is only a note
                pass

    def __enter__(self):
        import threading
        try:
            fetching[self.name] = time.time()
        except Exception:  # noqa: BLE001
            pass
        threading.Thread(target=self._beat, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        return False


def _tile_words(shown, now=None):
    """The press's line while USGS's tiles download: how much, and how long."""
    now = now or time.time()
    size = sum(v["size"] for v in shown.values() if v.get("size"))
    done = sum(min(v.get("done", 0), v.get("size") or 0) for v in shown.values() if v.get("size"))
    lefts = []
    for v in shown.values():
        if v.get("size") and v.get("done") and now > v.get("t0", now):
            rate = v["done"] / (now - v["t0"])
            if rate > 0:
                lefts.append((v["size"] - v["done"]) / rate)
    head = "Downloading USGS's newest lidar survey of this lot"
    if size:
        head += f": {done / 1e6:.0f} of {size / 1e6:.0f} MB"
        if lefts:
            m = max(lefts) / 60
            head += ", under a minute left" if m < 1 else f", about {m:.0f} minute{'s' if m >= 1.5 else ''} left"
    return head + ". USGS offers it only as large files, so the first lot in an area waits for it once"


def _fetch_or_wait(urls, say=lambda words: None, wait_s=FETCH_AGAIN_S, fetch_after_wait=True, parallel=1, deadline=None):
    """Every one of these tiles onto the volume: fetched here, or -- when
    another machine is fetching it right now -- waited for. Returns the urls
    still missing (a fetch that failed, or a wait that ran out). `parallel`
    tiles at a time: the live server's logs (2026-10-29) show Ketchum's two
    tiles fetched one after the other, 92 MB in 255 s then 34 MB in 202 s,
    when side by side the pair takes about as long as the larger one.
    `deadline` (a time.time()) ends any waiting and stops a new fetch from
    starting; a fetch already under way runs to its end."""
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import concurrent.futures
    import threading
    import lidar_sources
    from pathlib import Path
    commit_lock = threading.Lock()
    shown = {}  # name -> {done, size, t0}: what the press's line is made of
    say_lock = threading.Lock()

    def tell():
        with say_lock:
            try:
                say(_tile_words(shown))
            except Exception:  # noqa: BLE001 - a courtesy, never the download
                pass

    def one(i, url):
        name = url.rsplit("/", 1)[-1]
        path = Path(TILE_DIR) / name
        whole = lambda: path.exists() and path.stat().st_size > 0  # noqa: E731
        if whole():
            return True
        try:
            started = fetching.get(name)
        except Exception:  # noqa: BLE001
            started = None
        if started and time.time() - float(started) < FETCH_AGAIN_S:
            shown[name] = {"done": 0, "size": 0, "t0": float(started)}
            until = min(time.time() + wait_s, float(started) + FETCH_AGAIN_S, deadline or float("inf"))
            while time.time() < until and not whole():
                try:
                    p = tile_progress.get(name)
                    if p:
                        shown[name] = {"done": p.get("done", 0), "size": p.get("size", 0), "t0": p.get("t0", float(started))}
                except Exception:  # noqa: BLE001
                    pass
                tell()
                time.sleep(WAIT_STEP_S)
                try:
                    tiles.reload()
                except Exception:  # noqa: BLE001 - a file open on another lot: look again next time round
                    pass
                try:
                    if not fetching.get(name):  # the other fetch failed and cleared its note
                        break
                except Exception:  # noqa: BLE001
                    pass
            if whole():
                return True
            if not fetch_after_wait or (deadline and time.time() >= deadline):
                return False
        t0 = time.time()
        shown[name] = {"done": 0, "size": 0, "t0": t0}

        def progress(done, size):
            shown[name] = {"done": done, "size": size, "t0": t0}
            try:
                tile_progress[name] = {"done": done, "size": size, "t0": t0, "at": time.time()}
            except Exception:  # noqa: BLE001 - a note that fails to write is only a note
                pass
            tell()

        try:
            # A press's 429s are waited out only to its deadline; a warm-up's for
            # RATE_PATIENCE_S (run 271: seven tries gave up on 6 of 20 tiles).
            with _Holding(name):
                lidar_sources.fetch_ranged(url, path, progress=progress, patient_until=deadline)
            with commit_lock:
                tiles.commit()
            print(f"tile {name}: {path.stat().st_size / 1e6:.0f} MB in {time.time() - t0:.0f}s", flush=True)
            return True
        except Exception as e:  # noqa: BLE001 - said, and the note cleared so the next ask tries again at once
            print(f"tile {name}: NOT fetched ({str(e)[:160]})", flush=True)
            try:
                del fetching[name]
            except Exception:  # noqa: BLE001
                pass
            return False

    if parallel > 1 and len(urls) > 1:
        with concurrent.futures.ThreadPoolExecutor(min(parallel, len(urls))) as ex:
            ok = list(ex.map(lambda iu: one(*iu), enumerate(urls)))
    else:
        ok = [one(i, u) for i, u in enumerate(urls)]
    return [u for u, good in zip(urls, ok) if not good]


# 5400 s: each tile may now wait out USGS's 429s for RATE_PATIENCE_S (30 min)
# and then download for twenty more (run 271: 324 MB took 1296 s).
@app.function(image=cpu_image, volumes={TILE_DIR: tiles}, timeout=5400, cpu=1.0, memory=2048)
def fetch_tiles(urls):
    """USGS's tiles of a newer flight onto the volume, for the next lot there.
    Each is written under a temporary name and renamed when whole, so a reader
    never meets half a file; two lots asking at once fetch it twice, harmlessly."""
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import lidar_sources
    from pathlib import Path
    got = 0
    for url in urls:
        path = Path(TILE_DIR) / url.rsplit("/", 1)[-1]
        if path.exists():
            continue
        t0 = time.time()
        try:
            with _Holding(path.name):
                lidar_sources.fetch_ranged(url, path)
        except Exception as e:  # noqa: BLE001 - said, and the note cleared so the next ask tries again at once
            print(f"tile {path.name}: NOT fetched ({str(e)[:160]})", flush=True)
            try:
                del fetching[path.name]
            except Exception:  # noqa: BLE001
                pass
            continue
        tiles.commit()
        got += 1
        print(f"tile {path.name}: {path.stat().st_size / 1e6:.0f} MB in {time.time() - t0:.0f}s", flush=True)
    return got


def _ask_fetch(urls):
    """fetch_tiles started for the tiles nobody has asked for in the last
    twenty minutes, each noted as asked; the rest are already on their way.
    Returns the urls asked for."""
    now = time.time()
    ask = []
    for u in urls:
        name = u.rsplit("/", 1)[-1]
        try:
            started = fetching.get(name)
        except Exception:  # noqa: BLE001
            started = None
        if not started or now - float(started) > FETCH_AGAIN_S:
            try:
                fetching[name] = now
            except Exception:  # noqa: BLE001 - a note that fails to write is only a note
                pass
            ask.append(u)
    if ask:
        fetch_tiles.spawn(ask)
    return ask


TILE_NAME = re.compile(r"^https://rockyweb\.usgs\.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/[A-Za-z0-9_./-]+\.laz$")


@app.function(image=cpu_image, volumes={TILE_DIR: tiles}, timeout=600, cpu=2.0, memory=4096, scaledown_window=120)
@modal.concurrent(max_inputs=4)
def crop_tiles(urls, box, spacing=0.0):
    """THE PAGES' CROP (public/lib/lidar-tiles.js, 2026-10-29): the points of
    these tiles inside `box` (Web Mercator) as one LAZ, from the volume --
    or the names of the tiles not on it yet."""
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import lidar_sources
    from pathlib import Path
    try:
        tiles.reload()
    except Exception:  # noqa: BLE001 - read what is here
        pass
    t0 = time.time()
    # The address's area, when one was kept that holds this box: a few MB to
    # read instead of whole tiles (lidar_warm, lidar_sources.write_area).
    area = lidar_sources.area_covering(TILE_DIR, urls, box)
    if area:
        laz = lidar_sources.crop_tiles_laz([str(area)], box, spacing_m=spacing)
        print(f"crop over {box[2] - box[0]:.0f} x {box[3] - box[1]:.0f} m from the kept area {area.name}: {len(laz) / 1e6:.1f} MB in {time.time() - t0:.1f}s", flush=True)
        return {"laz": laz, "from": "area"}
    paths = [Path(TILE_DIR) / u.rsplit("/", 1)[-1] for u in urls]
    missing = [u for u, p in zip(urls, paths) if not (p.exists() and p.stat().st_size > 0)]
    if missing:
        return {"missing": missing}
    laz = lidar_sources.crop_tiles_laz([str(p) for p in paths], box, spacing_m=spacing)
    print(f"crop of {len(paths)} tiles over {box[2] - box[0]:.0f} x {box[3] - box[1]:.0f} m: {len(laz) / 1e6:.1f} MB in {time.time() - t0:.0f}s", flush=True)
    return {"laz": laz, "from": "tiles"}


# THE ADDRESS'S WARM-UP (owner, 2026-10-29: "when a user enters an address
# into lawn map: we should initiate the download, crop it to the sizes needed
# by the shade map and water map, save it to a cache so it's available to the
# shade map, water map, and ai detector"). Started by lidar_warm below when an
# address is confirmed (worker/src/lidar-tiles.js warmLidar): the tiles onto
# the volume, then the square round the address cut once as an area, which
# crop_tiles and the detector's gather both read from. Minutes, once; nobody
# waits on it.
warming = modal.Dict.from_name("lawn-lidar-warming", create_if_missing=True)
WARM_PARALLEL = 2  # tiles fetched side by side; each is already RANGE_PARTS ranges, and rockyweb refuses a crowd


@app.function(image=cpu_image, volumes={TILE_DIR: tiles}, timeout=3600, cpu=2.0, memory=4096)
def warm_area(urls, box):
    if f"{REPO}/tools" not in sys.path:
        sys.path.insert(0, f"{REPO}/tools")
    import lidar_sources
    try:
        tiles.reload()
    except Exception:  # noqa: BLE001 - read what is here
        pass
    if lidar_sources.area_covering(TILE_DIR, urls, box):
        return {"area": "kept already"}
    missing = _fetch_or_wait(urls, say=lambda words: print(words, flush=True), parallel=WARM_PARALLEL)
    if missing:
        return {"missing": [u.rsplit("/", 1)[-1] for u in missing]}
    t0 = time.time()
    path = lidar_sources.write_area(TILE_DIR, urls, box)
    tiles.commit()
    print(f"area {path.parent.name}/{path.name}: {path.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.0f}s", flush=True)
    return {"area": path.name}


def _gather_with_tiles(payload):
    """The downloads, reading USGS's tiles from the volume when they are
    there, and asking for them in the background when they are not."""
    os.environ["LIDAR_TILE_DIR"] = TILE_DIR
    try:
        tiles.reload()  # tiles fetched since this machine started
    except Exception:  # noqa: BLE001 - files open on another lot: read what is here
        pass
    got = _gather_here(payload, tile_fetch=lambda urls, say: _fetch_or_wait(
        urls, say=lambda words: say(words), wait_s=PRESS_TILE_WAIT_S, fetch_after_wait=True,
        parallel=2, deadline=time.time() + PRESS_TILE_WAIT_S))
    rec = (got.get("sources") or {}).get("rec", {})
    if rec.get("tilesFetched"):
        try:
            tiles.commit()  # fetched before this lot's read (alpha_sources.py): kept for the next
        except Exception as e:  # noqa: BLE001 - the next lot fetches again
            print(f"tiles not committed: {e}", flush=True)
    pending = rec.get("tilesPending")
    if pending:
        try:
            _ask_fetch(pending)  # not again for a tile another machine is fetching now
        except Exception as e:  # noqa: BLE001 - next lot asks again
            print(f"tiles not asked for: {e}", flush=True)
    return got


# WHERE EACH LOT HAS GOT TO (owner, 2026-10-21: the trace "took forever and
# needed to be resent several times... messages that say what the trace is
# getting stuck on"). `lot` and the downloads write a line here under the
# lot's own call id; `result` hands it back beside "running", the Worker
# passes it to the app, and the app shows it instead of guessing -- and
# only restarts a press whose line has not changed for a long time, instead
# of any press older than 100 s, which on a 10-acre lot (downloads alone
# 3-4 minutes) restarted every press before its downloads finished.
progress = modal.Dict.from_name("lawn-mapper-alpha-progress", create_if_missing=True)


def _note(key, stage, **more):
    """One line about a lot, for the app. Never fatal."""
    if not key:
        return
    try:
        progress[key] = {"stage": stage, "at": time.time(), **more}
    except Exception:  # noqa: BLE001 - a note that fails to write is only a note
        pass


@app.function(image=cpu_image, volumes={"/models": models, TILE_DIR: tiles}, timeout=GATHER_TIMEOUT_S, cpu=1.0, memory=2048,
              # A CPU machine costs a few cents an hour, so it can wait longer
              # for the next lot than the GPU does.
              scaledown_window=300)
# Several lots at once: it is downloads, so one CPU machine can wait on four
# as easily as one, and a second press need not start a second machine.
@modal.concurrent(max_inputs=PER_MACHINE)
def gather(payload):
    """The downloads for one lot, on a CPU: see tools/alpha_sources.py."""
    return _gather_with_tiles(payload)


@app.cls(image=gpu_image, gpu=GPU, volumes={"/models": models}, timeout=600,
         scaledown_window=SCALEDOWN, secrets=[auth],
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
            # THE EYE THE RELEASE NAMES goes into the snapshot (H114): a
            # release on DINOv3 would otherwise reopen its eye after every
            # restore, on the GPU's clock. The decoder itself is read after
            # the restore as before, so shipping one still needs no snapshot.
            backbone, size = "scalemae-large", 896
            try:
                meta = torch.load(RELEASE, map_location="cpu", weights_only=False).get("meta") or {}
                backbone, size = meta.get("backbone") or backbone, int(meta.get("size") or size)
            except Exception as e:  # noqa: BLE001 - no release yet, or unreadable: Scale-MAE as always
                print(f"release meta not read for the snapshot ({str(e)[:80]}); Scale-MAE eye", flush=True)
            self.det = alpha_infer.Detector(None, backbone=backbone, size=size)
            print(f"models loaded for the snapshot in {time.time() - t0:.0f}s ({backbone} at {size})", flush=True)
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
        # The GPU has started: `lot` stops counting the wait for one.
        _note(payload.get("progressKey"), "Reading the lot through the model")
        frame = payload["frame"]
        # The CPU machine's downloads, already finished when `lot` called
        # this (see `lot`); read here otherwise
        # -- the queue scorer calls this directly, and a failed gather is not
        # a failed lot.
        got = None
        if payload.get("gather"):
            try:
                got = modal.FunctionCall.from_id(payload["gather"]).get(timeout=300)
            except Exception as e:  # noqa: BLE001
                print(f"gather failed, reading here: {e}", flush=True)
        if got is None:
            got = _gather_here(payload)
        waited = round(time.time() - t0, 1)
        prep = got["prep"]
        photo = Image.open(__import__("io").BytesIO(got["photo"])).convert("RGB")
        with tempfile.TemporaryDirectory() as d:
            rec = self.det.run(photo, prep, d, naip_align=payload.get("naipAlign"), sources=got["sources"])
            # The photo on the scoring grid, for stage 3's see-through canopy
            # (public/lib/finish.js SEE_THROUGH: 'colour' reads its colour,
            # 'small-100-leafoff' whether it looks leaf-off, H127).
            photo.resize((prep["w"], prep["h"]), Image.BOX).save(os.path.join(d, "photo.png"))
            rec["seconds"]["waited"] = waited
            fin = _node("finish", {"dir": d, "w": prep["w"], "h": prep["h"], "mpp": prep["mpp"],
                                   "frame": frame, "parcel": payload.get("parcel")})
            with open(os.path.join(d, "final.png"), "rb") as f:
                mask = base64.b64encode(f.read()).decode()
            # The decoder's own picture, before the property line, the gap
            # filling and the canopy/roof steps: what the app's "show the raw
            # AI mask" draws, so a misplaced outline can be told from a
            # misread photo (owner, 2026-10-02).
            with open(os.path.join(d, "prob.png"), "rb") as f:
                prob = base64.b64encode(f.read()).decode()
            # What the finishing steps read besides it: the tree model's
            # canopy and the lidar's roofs and voids, so the page's confidence
            # slider can run the same steps at another cut (public/lib/
            # finish.js; owner, 2026-10-24). Absent when not made.
            parts = {}
            for name in ("canopy", "roof", "void"):
                fp = os.path.join(d, f"{name}.png")
                if os.path.exists(fp):
                    with open(fp, "rb") as f:
                        parts[name] = base64.b64encode(f.read()).decode()
        return {
            "mask": mask, "prob": prob, "parts": parts, "w": prep["w"], "h": prep["h"], "mpp": prep["mpp"], "version": self.version,
            "uncertainty": fin.get("uncertainty"), "lawnCells": fin.get("lawnCells"),
            "leafOff": fin.get("leafOff"),
            "used": {"lidar": rec["lidar"], "naip": rec["naip"]},
            "seconds": {**rec["seconds"], "total": round(time.time() - t0, 1)},
        }


def _authorised(header):
    want = os.environ.get("ALPHA_TOKEN", "")
    return bool(want) and header == f"Bearer {want}"


with web_image.imports():
    from fastapi import HTTPException, Request  # noqa: F401 - resolved in the container


@app.function(image=web_image, timeout=GATHER_TIMEOUT_S + 600, cpu=0.25, memory=512, scaledown_window=300)
# It only waits -- on the downloads, then on the GPU -- so one small machine
# can hold many lots at once.
@modal.concurrent(max_inputs=32)
def lot(body):
    """One lot, start to finish: downloads first, THEN the GPU (2026-10-08).

    `start` used to launch the downloads and the GPU together, so the cold
    start overlapped the downloads -- and every warm press, and every cold one
    whose GPU woke first, paid an L4 to sit through them: about 11 of a lot's
    ~12 seconds (workflow 32). Now the GPU is asked for only once the lidar,
    NAIP and photo are in hand, and is billed for the reading alone. The cost
    of the order is on a cold press: the GPU's start no longer hides behind
    the downloads, so that press waits for both in turn.
    """
    t0 = time.time()
    key = modal.current_function_call_id()
    body = {**body, "progressKey": key}
    _note(key, "Fetching the aerial photograph, the lidar and the near-infrared imagery")
    got = gather.spawn(body)
    try:
        # As long as the gather may take: a first lot in an area waits for
        # USGS's newest tiles (PRESS_TILE_WAIT_S); most lots take 15-120 s.
        # Waiting here, on this small machine, is what keeps the GPU unasked
        # until the lidar is in hand.
        got.get(timeout=GATHER_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - detect reads the lot itself, as before
        # This machine has no numpy (web_image), so a gather that FINISHED
        # cannot be unpacked here -- and need not be: the GPU fetches it by id.
        # Only a real failure is worth a line; this one appeared on every press
        # and read as an error in workflow 34 (2026-10-11).
        if "Deserialization failed" not in str(e):
            print(f"gather failed, the GPU will read it: {e}", flush=True)
    downloads = round(time.time() - t0, 1)
    waking = "Waking the GPU and reading the lot through the model"
    _note(key, waking, downloads=downloads)
    # WAITING FOR A GPU, SAID SO (owner, 2026-10-27: "a couple detections time
    # out completely"). On 2026-10-27 18:25-18:40 UTC Modal had no L4 free
    # ("waiting to be scheduled on a GPU_L4 worker ... acquiring more
    # capacity") and the app, hearing nothing new, gave up on each press.
    # While the GPU has not started (detect writes its own line when it does),
    # the line says how long it has been waiting, so the app shows it and
    # does not take a long queue for a stuck press.
    import threading
    stop = threading.Event()
    asked = time.time()

    def heartbeat():
        while not stop.wait(15):
            try:
                if (progress.get(key) or {}).get("stage", "").startswith(("Waking the GPU", "Waiting for a GPU")):
                    waited = int(time.time() - asked)
                    if waited >= 45:
                        _note(key, f"Waiting for a GPU to come free -- the GPU provider is busy right now "
                                   f"({waited // 60}:{waited % 60:02d})", downloads=downloads)
                else:
                    return
            except Exception:  # noqa: BLE001 - a courtesy, never fatal
                return

    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        out = Alpha().detect.remote({**body, "gather": got.object_id})
    finally:
        stop.set()
    out.setdefault("seconds", {})["downloads"] = downloads
    out["seconds"]["gpuWait"] = round(time.time() - asked, 1)
    _note(key, "Done", downloads=downloads)
    return out


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
    # The downloads on a CPU, then the GPU: see `lot`.
    call = lot.spawn(body)
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
        # Still going: say where it has got to, and for how long (seconds
        # since the line was written), so the app can tell slow from stuck.
        try:
            note = progress.get(id) or {}
        except Exception:  # noqa: BLE001 - the note is a courtesy
            note = {}
        stage = note.get("stage")
        return {"status": "running", "stage": stage, "since": round(time.time() - note["at"], 1) if note.get("at") else None}
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


@app.function(image=web_image, secrets=[auth], timeout=300)
@modal.fastapi_endpoint(method="GET")
def lidar_tiles(request: "Request", tiles: str, box: str, spacing: float = 0.0):
    """USGS'S TILE-ONLY LIDAR FOR THE PAGES (worker/src/lidar-tiles.js proxies
    this): ?tiles=<rockyweb urls>&box=w,s,e,n[&spacing=m] -> the tiles'
    points inside the box as one LAZ; 202 {status: fetching} while the tiles
    are fetched onto the volume the first time (fetch_tiles, started here)."""
    from fastapi.responses import JSONResponse, Response
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="not authorised")
    urls = [u for u in str(tiles or "").split(",") if u]
    if not urls or len(urls) > 12 or not all(TILE_NAME.match(u) for u in urls):
        raise HTTPException(status_code=400, detail="tiles: 1 to 12 of USGS's rockyweb LAZ urls")
    try:
        bbox = [float(v) for v in str(box).split(",")]
        assert len(bbox) == 4 and bbox[0] < bbox[2] and bbox[1] < bbox[3]
        assert bbox[2] - bbox[0] <= 1500 and bbox[3] - bbox[1] <= 1500
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="box: w,s,e,n in Web Mercator metres, at most 1.5 km across")
    out = crop_tiles.remote(urls, bbox, float(spacing or 0.0))
    if out.get("missing"):
        ask = _ask_fetch(out["missing"])
        return JSONResponse({"status": "fetching", "missing": [u.rsplit("/", 1)[-1] for u in out["missing"]], "started": bool(ask)}, status_code=202)
    return Response(content=out["laz"], media_type="application/vnd.laszip", headers={"Cache-Control": "public, max-age=604800"})


@app.function(image=web_image, secrets=[auth], timeout=60)
@modal.fastapi_endpoint(method="GET")
def lidar_warm(request: "Request", tiles: str, box: str):
    """?tiles=<rockyweb urls>&box=w,s,e,n: start the address's warm-up
    (warm_area) unless one for the same tiles and box started in the last
    twenty minutes. Answers at once; nothing waits on it."""
    import hashlib
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="not authorised")
    urls = [u for u in str(tiles or "").split(",") if u]
    if not urls or len(urls) > 12 or not all(TILE_NAME.match(u) for u in urls):
        raise HTTPException(status_code=400, detail="tiles: 1 to 12 of USGS's rockyweb LAZ urls")
    try:
        bbox = [float(v) for v in str(box).split(",")]
        assert len(bbox) == 4 and bbox[0] < bbox[2] and bbox[1] < bbox[3]
        assert bbox[2] - bbox[0] <= 1500 and bbox[3] - bbox[1] <= 1500
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="box: w,s,e,n in Web Mercator metres, at most 1.5 km across")
    names = sorted(u.rsplit("/", 1)[-1] for u in urls)
    key = hashlib.sha1(("|".join(names) + "|" + ",".join(str(round(v)) for v in bbox)).encode()).hexdigest()[:24]
    now = time.time()
    try:
        last = warming.get(key)
    except Exception:  # noqa: BLE001
        last = None
    if last and now - float(last) < FETCH_AGAIN_S:
        return {"status": "warming", "started": False}
    try:
        warming[key] = now
    except Exception:  # noqa: BLE001 - a note that fails to write is only a note
        pass
    warm_area.spawn(urls, bbox)
    return {"status": "warming", "started": True}
