"""
The trained model's downloads, apart from its GPU work (owner, 2026-09-30).

The 3DEP lidar and NAIP's near-infrared are network reads plus light
arithmetic. On the GPU machine they were billed at GPU rates while the GPU
sat idle -- lidar alone was 6.5 of a lot's 12 seconds. So tools/modal_serve.py
runs `gather` on a small CPU machine, started at the same moment as the GPU
one, and on a cold start the downloads finish while the GPU is still waking.

No torch, no transformers: this module has to import on the CPU image.
Everything here is what alpha_infer.Detector.run did before, moved, not
changed -- the same readers (lidar_frame.lidar_for, naip_bands.naip_for) with
the same failure rule: a source that cannot be read is left out, as training
left it out.
"""

import io
import json
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image


def _looks_like_image(data):
    """PNG, JPEG, GIF, WebP or TIFF by its first bytes."""
    head = bytes(data[:12])
    return (head.startswith(b"\x89PNG") or head.startswith(b"\xff\xd8") or head.startswith(b"GIF8")
            or (head[:4] == b"RIFF" and head[8:12] == b"WEBP") or head[:4] in (b"II*\x00", b"MM\x00*"))


def fetch_photo(url, tries=3, pause_s=2.0, opener=None):
    """One picture's bytes, tried up to `tries` times.

    A county's export can answer a request with an error page instead of a
    picture, or not at all, and then answer the same request a moment later
    (Kent County, 2026-10-23: piece 2 of 4 of the condo complex failed and the
    whole press with it; the next press drew all four). Each failure waits a
    little longer before the next try. The error raised is a plain
    RuntimeError naming what came back, so it can be reported anywhere: a
    Pillow error could not be read back by the server's result page.
    """
    opener = opener or urllib.request.urlopen
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lawn-mapper-alpha"})
            with opener(req, timeout=60) as r:
                data = r.read()
            if _looks_like_image(data):
                return data
            last = f"not a picture ({len(data)} bytes: {bytes(data[:80])!r})"
        except Exception as e:  # noqa: BLE001 - tried again below
            last = f"{type(e).__name__}: {str(e)[:160]}"
        if attempt + 1 < tries:
            time.sleep(pause_s * (attempt + 1))
    raise RuntimeError(f"the photograph could not be fetched after {tries} tries: {last}")


# Tiles up to this many MB are fetched before the first read (16 ranges at once: a 130 MB tile in under a minute).
INLINE_TILES_MB = 400


def stitch_tiles(tiles, cols, rows):
    """One photograph from its tiles: (col, row, PIL image) pasted at
    (col * px, row * px). The tiles abut exactly because the Worker split the
    frame in world pixels (worker/src/imagery.js pressPlan, the banking's own
    grid), so this is a plain paste; a tile of another size would paste
    misaligned and leave a seam, and is refused instead."""
    if not tiles:
        raise ValueError("no tiles")
    px, py = tiles[0][2].size
    out = Image.new("RGB", (px * cols, py * rows))
    for col, row, img in tiles:
        if img.size != (px, py):
            raise ValueError(f"tile {col},{row} is {img.size[0]}x{img.size[1]} px, the first {px}x{py}")
        if not (0 <= col < cols and 0 <= row < rows):
            raise ValueError(f"tile {col},{row} is outside the {cols}x{rows} grid")
        out.paste(img.convert("RGB"), (col * px, row * py))
    return out


def fetch_press_photo(payload, say=None):
    """The press's photograph as bytes: one picture, or its tiles stitched
    (payload["tiles"], 2026-10-22: a big lot at 10 cm a pixel instead of one
    picture capped at what Mapbox serves in a request)."""
    tiles = payload.get("tiles") or []
    if len(tiles) <= 1:
        return fetch_photo(payload["imageUrl"])
    cols, rows = int(payload.get("cols") or 1), int(payload.get("rows") or 1)
    if cols * rows != len(tiles):
        raise ValueError(f"{len(tiles)} tiles for a {cols}x{rows} grid")
    # Two pieces at a time: a county export took 30-50 s a piece one after
    # another (Kent County, 2026-10-23), and two at once halve that without
    # asking more of a county server than an editor's own map does.
    from concurrent.futures import ThreadPoolExecutor

    done = [0]

    def one(i_t):
        i, t = i_t
        data = fetch_photo(t["url"])
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception as e:  # noqa: BLE001 - said plainly, see fetch_photo
            raise RuntimeError(f"piece {i + 1} of {len(tiles)} is not a readable picture: {type(e).__name__}") from None
        done[0] += 1
        if say:
            say(f"Fetching the aerial photograph of your lot ({done[0]} of {len(tiles)} pieces in)")
        return (int(t["col"]), int(t["row"]), img)

    if say:
        say(f"Fetching the aerial photograph of your lot ({len(tiles)} pieces)")
    with ThreadPoolExecutor(max_workers=2) as pool:
        got = list(pool.map(one, enumerate(tiles)))
    buf = io.BytesIO()
    stitch_tiles(got, cols, rows).save(buf, format="PNG")
    return buf.getvalue()


def _lidar_cache_file(cache_dir, prep, local):
    """Where this frame's lidar layers live on the volume, or None."""
    if not cache_dir:
        return None
    import hashlib
    key = json.dumps({"bbox": [round(float(v), 2) for v in prep["bbox"]], "url": prep.get("lidarUrl"),
                      "epoch": prep.get("lidarEpoch"), "tiles": sorted(local or [])}, sort_keys=True)
    return Path(cache_dir) / f"{hashlib.sha1(key.encode()).hexdigest()}.npz"


def _lidar_cached(path, max_age_s=7 * 86400):
    """The (layers, masks) saved for this frame, or None."""
    try:
        if not path or not path.exists() or time.time() - path.stat().st_mtime > max_age_s:
            return None
        with np.load(path, allow_pickle=False) as z:
            layers = {k[2:]: z[k] for k in z.files if k.startswith("l_")}
            masks = {k[2:]: z[k].astype(bool) for k in z.files if k.startswith("m_")}
        return (layers, masks) if layers else None
    except Exception:  # noqa: BLE001 - a bad file is a miss
        return None


def _lidar_save(path, got):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        layers, masks = got
        np.savez_compressed(path, **{f"l_{k}": np.asarray(v) for k, v in layers.items()},
                            **{f"m_{k}": np.asarray(v, dtype=np.uint8) for k, v in masks.items()})
    except Exception:  # noqa: BLE001 - the next press reads USGS again, as before
        pass


def gather_sources(photo, prep, naip_align=None, progress=None, cache_dir=None, tile_fetch=None):
    """Lidar and NAIP for one lot. Returns plain arrays and a record:

        lidar       {height, n_ground, n_all, intensity} on lidar_frame's 2 m grid, or None
        height_png  the height picture stage 3 reads, or None
        roof, void  boolean masks for the lidar veto, or None
        naip        NAIP's RGB-as-NIR array, lined up with the photograph, or None
        rec         {lidar: bool, naip: bool, lidarSource?, tilesPending?, lidarError?, naipError?}
        seconds     {lidar, naip}

    `progress(stage)` is told each step as it starts (the model server shows
    it to the app). `cache_dir` keeps each frame's lidar layers for a week,
    so a press sent again for the same lot (the app restarting one, or a
    person pressing twice) reads nothing from USGS: on a 10-acre lot the
    lidar alone was three minutes (owner, 2026-10-21).
    `tile_fetch(urls, say)`, when given, puts missing tiles on the volume --
    fetching them, or waiting for the machine already fetching them (the
    address's warm-up, tools/modal_serve.py _fetch_or_wait) -- and returns the
    urls still missing; without it they are fetched here, one by one.
    """
    import lidar_frame
    import naip_bands

    say = progress or (lambda stage, **more: None)

    out = {"lidar": None, "height_png": None, "roof": None, "void": None, "naip": None,
           "rec": {"lidar": False, "naip": False}, "seconds": {}}

    # THE NEWEST FLIGHT (H96): when it is only USGS's LAZ tiles, they are read
    # from the server's volume (LIDAR_TILE_DIR) once they are there; until
    # then the newest octree is, and the tiles are named for the server to
    # fetch in the background (tools/modal_serve.py, fetch_tiles).
    tiles = prep.get("lidarTiles") or []
    tile_dir = os.environ.get("LIDAR_TILE_DIR")
    local = None
    if tiles and tile_dir:
        paths = [Path(tile_dir) / u.rsplit("/", 1)[-1] for u in tiles]
        pending = [u for u, p in zip(tiles, paths) if not p.exists()]
        # THE FIRST LOT IN AN AREA (owner, 2026-10-29: "make sure we're pulling
        # the newest and most up to date lidar everywhere"): the tiles are
        # fetched NOW when they are modest, so the first press reads the newest
        # flight too, not the older octree -- which over part of Ketchum had a
        # hole and nothing at all. A big set is still read next time.
        mb = prep.get("lidarTilesMb")
        if pending and (mb is None or mb <= INLINE_TILES_MB) and tile_fetch is not None:
            still = tile_fetch(pending, lambda words: say(words))
            if len(still) < len(pending):
                out["rec"]["tilesFetched"] = len(pending) - len(still)
            if still:
                out["rec"]["tilesError"] = f"{len(still)} tile(s) not on the volume yet"
            pending = still
        elif pending and (mb is None or mb <= INLINE_TILES_MB):
            import lidar_sources
            try:
                for i, u in enumerate(pending):
                    say(f"Fetching USGS's newest lidar survey over this lot (tile {i + 1} of {len(pending)}"
                        + (f", {mb:.0f} MB in all" if mb else "") + "): the first lot in an area takes a minute or two")
                    lidar_sources.fetch_ranged(u, Path(tile_dir) / u.rsplit("/", 1)[-1])
                out["rec"]["tilesFetched"] = len(pending)
                pending = []
            except Exception as e:  # noqa: BLE001 - the octree now, the tiles next time
                out["rec"]["tilesError"] = str(e)[:200]
        if not pending:
            local = [str(p) for p in paths]
        else:
            out["rec"]["tilesPending"] = pending
    # THE ADDRESS'S AREA (tools/modal_serve.py warm_area), when one holds this
    # frame: the same points as the tiles, cut once already, so the read is of
    # a few MB instead of whole tiles. The layers' cache stays keyed on the
    # tiles themselves.
    read_from = local
    if local:
        import lidar_sources
        try:
            area = lidar_sources.area_covering(tile_dir, tiles, lidar_sources.grow(prep["bbox"], 5))
        except Exception:  # noqa: BLE001 - the tiles, as before
            area = None
        if area:
            read_from = [str(area)]

    if prep.get("lidarUrl") or local:
        t0 = time.time()
        cache_file = _lidar_cache_file(cache_dir, prep, local)
        try:
            got = _lidar_cached(cache_file)
            if got:
                out["rec"]["lidarSource"] = "cache"
                say("Reading the lidar kept from the last press")
            else:
                span = max(prep["bbox"][2] - prep["bbox"][0], prep["bbox"][3] - prep["bbox"][1])
                say(f"Separating USGS lidar point clouds over {span:.0f} m of ground"
                    + (" (a big lot: this is the slow part)" if span > 200 else ""))
            if got is None and local:
                try:
                    got = lidar_frame.lidar_for(None, prep["bbox"], epoch=prep.get("lidarTilesEpoch"), tiles=read_from)
                    out["rec"]["lidarSource"] = "area" if read_from is not local else "tiles"
                except Exception as e:  # noqa: BLE001 - the octree is still there
                    out["rec"]["tilesError"] = str(e)[:200]
            if got is None and prep.get("lidarUrl"):
                got = lidar_frame.lidar_for(prep["lidarUrl"], prep["bbox"], epoch=prep.get("lidarEpoch"))
                out["rec"]["lidarSource"] = "octree"
            if got:
                if out["rec"].get("lidarSource") != "cache" and cache_file:
                    _lidar_save(cache_file, got)
                layers, masks = got
                out["lidar"] = {k: layers[k] for k in ("height", "n_ground", "n_all", "intensity")}
                out["height_png"] = lidar_frame.height_png(layers["height"])
                out["roof"] = np.asarray(masks["roof"], dtype=bool)
                out["void"] = np.asarray(masks["void"], dtype=bool)
                out["rec"]["lidar"] = True
        except Exception as e:  # noqa: BLE001 - served without it, as trained
            out["rec"]["lidarError"] = str(e)[:200]
        out["seconds"]["lidar"] = round(time.time() - t0, 1)

    t0 = time.time()
    span = max(prep["bbox"][2] - prep["bbox"][0], prep["bbox"][3] - prep["bbox"][1])
    # The slow step on a big lot (workflow 32, 2026-10-22: 103 s of a 275 m
    # lot's 116 s of downloads was this; the lidar was 10 s).
    say("Aligning the near-infrared imagery" + (f" over {span:.0f} m of ground (a big lot: this takes a minute or two)" if span > 200 else ""))
    try:
        naip, _ = naip_bands.naip_for(prep["bbox"], photo=photo, stored=naip_align)
        out["naip"] = np.asarray(naip)
    except Exception as e:  # noqa: BLE001 - served without it, as trained
        out["rec"]["naipError"] = str(e)[:200]
    out["seconds"]["naip"] = round(time.time() - t0, 1)
    return out


def gather(payload, prepare, progress=None, cache_dir=None, tile_fetch=None):
    """Everything a lot needs before the GPU: where it is (`prepare`, the
    scorer's own grid via serve-alpha.mjs), the photograph, and its sources."""
    t0 = time.time()
    say = progress or (lambda stage, **more: None)
    say("Working out the lot's grid")
    # The grid's cap, when the press asks for a finer one (serve-alpha.mjs serveCap).
    prep = prepare({"frame": payload["frame"], **({"gridMax": payload["gridMax"]} if payload.get("gridMax") else {})})
    say("Fetching the aerial photograph of your lot")
    photo_bytes = fetch_press_photo(payload, say)
    photo = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
    sources = gather_sources(photo, prep, payload.get("naipAlign"), progress=progress, cache_dir=cache_dir, tile_fetch=tile_fetch)
    sources["seconds"]["gather"] = round(time.time() - t0, 1)
    return {"prep": prep, "photo": photo_bytes, "sources": sources}
