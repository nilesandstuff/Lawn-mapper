"""
ONLY THE PART OF A USGS TILE OVER A PROPERTY (owner, 2026-10-30: "Yes build
the partial download, but please make sure it works well before putting it
on the live site").

USGS serves a flight it has not yet put on AWS as plain LAZ 1.4 tiles of
50-500 MB on rockyweb, which gives one machine 0.07-0.4 MB/s whatever it does
(2026-10-30: 0.12 MB/s from a cloud container, 0.075 from the model server;
four connections no faster than one). A lot needs a few hundred metres of a
1-1.5 km tile, so most of every download was points nobody reads.

What a tile holds (measured on USGS_LPC_AR_Western_B24_15SUA950220.laz):
  - points in the order the plane flew them, packed by LASzip into chunks of
    50,000 that are compressed independently and listed, with their byte
    sizes, in a chunk table at the end of the file;
  - each chunk is a compact strip of one flight line, about the swath wide
    (~450 m there) and 25-40 m along it;
  - each chunk opens with its first point UNCOMPRESSED (the LAZ 1.4 layered
    format writes it raw), so 30 bytes say where the chunk is.

So: read the header (64 KB) and the chunk table (a few KB); read each chunk's
first point (one request asking for all of them, HTTP multi-range); work out
which chunks' strips can reach the box, with margins; fetch those (neighbours
are adjacent bytes: a few requests); decompress them; and, until it holds,
add the chunk beyond either end of a run whose end chunk still has points in
the box. Every point in the box is in a chunk read, which check() and
tools/lidar_partial_check.py prove against whole tiles.

Anything this cannot do -- another compressor, a server that ignores
multi-range, chunks that do not look like strips, a box that needs most of
the file -- returns None, and the caller downloads the whole tile as before.
"""
import io
import math
import re
import struct
import time
import urllib.request

import numpy as np

HEAD_BYTES = 65536
RANGES_PER_ASK = 300          # first points asked for in one multi-range request
MAX_SHARE = 0.5               # needing more of the file than this: fetch it whole (an Arkansas tile, 62% for a
                              # 164 m box, took 756 s in part against ~290 s whole for its neighbour; H132)
MERGE_GAP = 2                 # chunks between two runs fetched anyway, to save a request
MIN_GROUP = 3                 # chunks of one flight line needed to know its swath
SWATH_MARGIN = 0.15           # the swath's width, and this share again, and...
ABS_MARGIN_M = 20.0           # ...this much ground, either side
MAX_ROUNDS = 60
MIN_SAVING = 20e6             # a part saving less than this of the file is not worth its extra requests: the whole tile
END_PAD = 1                   # chunks added beyond each end of a run, so the check below rarely needs another request
GAP_S = 1.0                   # at least this long between two requests (rockyweb refuses bursts)
FIRST_WAIT_S = 2.0            # a 429 is waited out from this, doubling (lidar_sources' 15 s is for whole files)


class Unsupported(Exception):
    """This tile, or this server, cannot be read in part: fetch it whole."""


# ------------------------------------------------------------------ sources

class FileSource:
    """A tile already on disk, read as the network would be: for the check."""

    def __init__(self, path):
        self.path = str(path)
        import os
        self._size = os.path.getsize(self.path)
        self.min_saving = 0  # the check measures shares on every tile; the live floor is HttpSource's
        self.requests = 0
        self.bytes = 0

    def size(self):
        return self._size

    def get(self, a, b):
        self.requests += 1
        with open(self.path, "rb") as f:
            f.seek(a)
            d = f.read(b - a + 1)
        self.bytes += len(d)
        return d

    def get_many(self, ranges):
        out = []
        for i in range(0, len(ranges), RANGES_PER_ASK):
            self.requests += 1
            with open(self.path, "rb") as f:
                for a, b in ranges[i:i + RANGES_PER_ASK]:
                    f.seek(a)
                    d = f.read(b - a + 1)
                    self.bytes += len(d)
                    out.append(d)
        return out


def parse_multipart(body, content_type):
    """The parts of a multipart/byteranges answer as {(a, b): bytes}."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        raise Unsupported("multipart answer without a boundary")
    sep = b"--" + m.group(1).encode()
    parts = {}
    for chunk in body.split(sep)[1:]:
        if chunk.startswith(b"--"):
            break
        head, _, data = chunk.partition(b"\r\n\r\n")
        cr = re.search(rb"Content-Range:\s*bytes\s+(\d+)-(\d+)/", head, re.I)
        if not cr:
            continue
        a, b = int(cr.group(1)), int(cr.group(2))
        parts[(a, b)] = data[: b - a + 1]
    return parts


def pick_ranges(parts, ranges):
    """Each asked range out of the parts that came back (a server may merge neighbours)."""
    out = []
    for a, b in ranges:
        for (pa, pb), d in parts.items():
            if pa <= a and b <= pb and len(d) >= b - pa + 1:
                out.append(d[a - pa:b - pa + 1])
                break
        else:
            raise Unsupported(f"range {a}-{b} missing from the answer")
    return out


class HttpSource:
    """A tile on a web server, asked for in byte ranges. 429s are waited out
    (lidar_sources._Patience) until `patient_until`."""

    def __init__(self, url, timeout=120, patient_until=None):
        import lidar_sources
        self.url, self.timeout = url, timeout
        self.until = patient_until if patient_until is not None else time.time() + lidar_sources.RATE_PATIENCE_S
        self.refused, self.waited = 0, 0.0

        def noted(wait, refused):
            self.waited += wait
            self.refused += int(refused)
        self._patience = lambda: lidar_sources._Patience(lidar_sources.RATE_TRIES, self.until,
                                                         first_wait=FIRST_WAIT_S, on_wait=noted)
        self._size = None
        self._last = 0.0
        self._lock = __import__("threading").Lock()
        self.connections = 2
        self.requests = 0
        self.bytes = 0

    def _open(self, headers):
        q = urllib.request.Request(self.url, headers=headers)
        p = self._patience()
        while True:
            try:
                with self._lock:
                    gap = self._last + GAP_S - time.time()
                    if gap > 0:
                        time.sleep(gap)
                    self._last = time.time()
                self.requests += 1
                return urllib.request.urlopen(q, timeout=self.timeout)
            except Exception as e:  # noqa: BLE001 - waited out, then raised
                p.again(e)

    def size(self):
        if self._size is None:
            self.get(0, 0)
        return self._size

    def get(self, a, b):
        want = b - a + 1
        buf = bytearray()
        p = self._patience()
        while len(buf) < want:
            try:
                r = self._open({"Range": f"bytes={a + len(buf)}-{b}"})
                with r:
                    if r.status != 206:
                        raise Unsupported(f"the server answered a range with HTTP {r.status}")
                    cr = r.headers.get("Content-Range") or ""
                    if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                        self._size = int(cr.rsplit("/", 1)[1])
                    while len(buf) < want:
                        d = r.read(min(1 << 16, want - len(buf)))
                        if not d:
                            break
                        buf += d
                if len(buf) < want:
                    raise IOError(f"short range {len(buf)} of {want}")
            except Unsupported:
                raise
            except Exception as e:  # noqa: BLE001 - carried on from len(buf)
                p.again(e)
        self.bytes += len(buf)
        return bytes(buf)

    def get_many(self, ranges):
        out = []
        for i in range(0, len(ranges), RANGES_PER_ASK):
            batch = ranges[i:i + RANGES_PER_ASK]
            spec = ",".join(f"{a}-{b}" for a, b in batch)
            p = self._patience()
            while True:
                try:
                    r = self._open({"Range": f"bytes={spec}"})
                    with r:
                        ct = r.headers.get("Content-Type") or ""
                        if r.status == 206 and "multipart/byteranges" in ct:
                            body = r.read()
                            self.bytes += len(body)
                            out += pick_ranges(parse_multipart(body, ct), batch)
                            break
                        cr = r.headers.get("Content-Range") or ""
                        m = re.match(r"bytes (\d+)-(\d+)/", cr)
                        want = sum(b - a + 1 for a, b in batch)
                        if r.status == 206 and m and int(m.group(2)) - int(m.group(1)) < max(1 << 20, 2 * want):
                            body = r.read()  # all of them merged into one small range
                            self.bytes += len(body)
                            out += pick_ranges({(int(m.group(1)), int(m.group(2))): body}, batch)
                            break
                        # A whole file, or one huge merged range: not what was asked. Closed unread.
                        raise Unsupported(f"the server does not answer multi-range requests (HTTP {r.status}, {ct or 'no type'})")
                except Unsupported:
                    raise
                except Exception as e:  # noqa: BLE001 - waited out, then raised
                    p.again(e)
        return out


# ------------------------------------------------------------------ the file

class Sparse(io.RawIOBase):
    """A file of which only some byte ranges are known; reading anywhere else is an error."""

    def __init__(self, size):
        super().__init__()
        self.segs = []
        self.pos = 0
        self.size = size

    def add(self, a, data):
        self.segs.append((a, data))
        self.segs.sort(key=lambda s: s[0])

    def has(self, a, b):
        return any(s <= a and b < s + len(d) for s, d in self.segs)

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def tell(self):
        return self.pos

    def readinto(self, b):
        n = len(b)
        for s, d in self.segs:
            if s <= self.pos < s + len(d):
                k = min(n, s + len(d) - self.pos)
                b[:k] = d[self.pos - s:self.pos - s + k]
                self.pos += k
                return k
        if self.pos >= self.size:
            return 0
        raise IOError(f"byte {self.pos} was not fetched")


def tile_info(src):
    """Header, LASzip record, chunk table and chunk starts of a tile, from its first 64 KB and its last few."""
    import laspy
    import lazrs
    size = src.size()
    head = src.get(0, min(size, HEAD_BYTES) - 1)
    off = struct.unpack_from("<I", head, 96)[0]
    if off + 8 > len(head):
        head = src.get(0, off + 7)
    header = laspy.LasHeader.read_from(io.BytesIO(head))
    laz = [v for v in header.vlrs if getattr(v, "user_id", "") == "laszip encoded"]
    if not laz:
        raise Unsupported("not a LAZ file")
    vlr_raw = laz[0].record_data_bytes()
    compressor = struct.unpack_from("<H", vlr_raw, 0)[0]
    if compressor != 3:
        raise Unsupported(f"LASzip compressor {compressor}, not LAZ 1.4's layered chunks")
    if header.point_format.id < 6:
        raise Unsupported(f"point format {header.point_format.id}")
    ct_off = struct.unpack_from("<q", head, off)[0]
    if not (off + 8 < ct_off < size):
        raise Unsupported("no chunk table")
    # The extended records (where many USGS tiles keep their WKT) lie at the
    # end too; usually after the chunk table, so already in the tail.
    n_evlr = int(getattr(header, "number_of_evlrs", 0) or 0)
    evlr_at = int(getattr(header, "start_of_first_evlr", 0) or 0)
    lo = min(ct_off, evlr_at) if n_evlr and off < evlr_at < size else ct_off
    tail = src.get(lo, size - 1)
    sp = Sparse(size)
    sp.add(0, head)
    sp.add(lo, tail)
    if n_evlr and off < evlr_at < size:
        from laspy.vlrs.vlrlist import VLRList
        header.evlrs = VLRList.read_from(io.BytesIO(tail[evlr_at - lo:]), n_evlr, extended=True)
    sp.seek(off)
    table = [tuple(int(v) for v in e) for e in lazrs.read_chunk_table(sp, lazrs.LazVlr(vlr_raw))]
    # A fixed-size table says 50,000 for the last chunk too; it holds what is left.
    total = int(header.point_count)
    before = sum(c for c, _ in table[:-1])
    if table and before + table[-1][0] != total:
        if not (0 < total - before <= table[-1][0]):
            raise Unsupported("the chunk table's counts do not add up to the header's")
        table[-1] = (total - before, table[-1][1])
    starts = [off + 8]
    for _, nbytes in table:
        starts.append(starts[-1] + nbytes)
    if starts[-1] != ct_off:  # (the chunk table follows the last chunk)
        raise Unsupported("the chunk table does not add up to the file")
    return {"size": size, "header": header, "vlr": vlr_raw, "off": off, "table": table,
            "starts": starts, "sparse": sp, "psize": header.point_format.size}


def first_points(info, raws):
    """x, y (the tile's units), point source id and GPS time of each chunk's raw first point."""
    h = info["header"]
    xs, ys, srcs, gps = [], [], [], []
    for d in raws:
        x, y = struct.unpack_from("<ii", d, 0)
        srcs.append(struct.unpack_from("<H", d, 20)[0])  # point source id: after X Y Z, intensity, 4 bytes of flags and class, scan angle
        gps.append(struct.unpack_from("<d", d, 22)[0])
        xs.append(x * h.scales[0] + h.offsets[0])
        ys.append(y * h.scales[1] + h.offsets[1])
    xs, ys = np.array(xs), np.array(ys)
    info["gps"] = np.array(gps)
    pad = 0.01 * max(h.maxs[0] - h.mins[0], h.maxs[1] - h.mins[1]) + 1
    inside = (xs >= h.mins[0] - pad) & (xs <= h.maxs[0] + pad) & (ys >= h.mins[1] - pad) & (ys <= h.maxs[1] + pad)
    if not inside.all():
        raise Unsupported(f"{int((~inside).sum())} chunk(s) do not open with a readable point")
    return xs, ys, np.array(srcs)


# ------------------------------------------------------------------ choosing

TURN_S = 5.0      # a gap in the plane's clock this long between two chunks is a turn: a new flight line
TURN_TIMES = 20   # ...or this many times the line's usual gap


def lines_of(srcs, gps=None):
    """
    Runs of chunks flown in one pass, as (first, last). A new pass starts where
    the point source id changes, and -- because some projects give a whole
    flight one id (USGS's Arkansas 2024 tiles: 45 throughout) -- where the GPS
    time between two chunks' first points jumps (the turn at the end of a
    line, a minute or more) or runs backwards.
    """
    n = len(srcs)
    if n == 0:
        return []
    cut = np.zeros(n, dtype=bool)
    cut[0] = True
    cut[1:] |= np.asarray(srcs[1:]) != np.asarray(srcs[:-1])
    if gps is not None and len(gps) == n and n > 1:
        g = np.asarray(gps, dtype=float)
        dg = np.diff(g)
        pos = dg[(dg > 0) & np.isfinite(dg)]
        usual = float(np.median(pos)) if len(pos) else 0.0
        cut[1:] |= ~np.isfinite(dg) | (dg < 0) | (dg > max(TURN_S, TURN_TIMES * usual))
    starts = np.flatnonzero(cut).tolist() + [n]
    return [(starts[i], starts[i + 1] - 1) for i in range(len(starts) - 1)]


def select_chunks(xs, ys, srcs, box, unit_m=1.0, gps=None):
    """
    The chunks whose strip can reach `box` ([x0, y0, x1, y1] in the tile's
    units). A flight line is a run of chunks opening on the same point source
    id; its swath is the spread of their first points across the line (each
    lands anywhere across it), widened by SWATH_MARGIN and ABS_MARGIN_M; a
    chunk reaches from its own first point to the next one's along the line.
    A line too short to measure is taken as wide as the widest measured.
    Returns (sorted chunk indices, why) -- why is None, or the reason to
    fetch the whole tile.
    """
    n = len(xs)
    if n == 0:
        return [], None
    m_abs = ABS_MARGIN_M / unit_m
    corners = np.array([[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]], dtype=float)
    groups = lines_of(srcs, gps)
    pick = set()
    widest, short = 0.0, []
    for g0, g1 in groups:
        if g1 - g0 + 1 < MIN_GROUP:
            short.append((g0, g1))
            continue
        P = np.column_stack([xs[g0:g1 + 1], ys[g0:g1 + 1]])
        c0 = P.mean(axis=0)
        u, s, vt = np.linalg.svd(P - c0, full_matrices=False)
        ax, nx = vt[0], np.array([-vt[0][1], vt[0][0]])
        a = (P - c0) @ ax
        c = (P - c0) @ nx
        width = float(c.max() - c.min())
        if width <= 0 or float(a.max() - a.min()) <= 0:
            short.append((g0, g1))
            continue
        widest = max(widest, width)
        mc = SWATH_MARGIN * width + m_abs
        lo_c, hi_c = c.min() - mc, c.max() + mc
        steps = np.abs(np.diff(a))
        step = float(np.median(steps)) if len(steps) else 0.0
        ma = 0.5 * step + m_abs
        bc = (corners - c0) @ nx
        ba = (corners - c0) @ ax
        if bc.max() < lo_c or bc.min() > hi_c:
            continue
        for i in range(g1 - g0 + 1):
            a_here = a[i]
            a_next = a[i + 1] if i + 1 < len(a) else a[i] + (a[i] - a[i - 1] if i > 0 else step)
            lo_a, hi_a = min(a_here, a_next) - ma, max(a_here, a_next) + ma
            if ba.max() >= lo_a and ba.min() <= hi_a:
                pick.add(g0 + i)
    if short:
        if widest <= 0:
            return list(range(n)), "no flight line long enough to measure its swath"
        r = 1.3 * widest + m_abs
        for g0, g1 in short:
            for i in range(g0, g1 + 1):
                dx = max(box[0] - xs[i], 0, xs[i] - box[2])
                dy = max(box[1] - ys[i], 0, ys[i] - box[3])
                if math.hypot(dx, dy) <= r:
                    pick.add(i)
    # A chunk where one line ends and the next begins holds both: its neighbours come too.
    for i in list(pick):
        for j in (i - 1, i + 1):
            if 0 <= j < n:
                pick.add(j)
    return sorted(pick), None


def runs_of(idx, gap=MERGE_GAP):
    """Sorted chunk indices as (first, last) runs, merging runs fewer than `gap` chunks apart."""
    out = []
    for i in idx:
        if out and i - out[-1][1] <= gap + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return [tuple(r) for r in out]


# ------------------------------------------------------------------ reading

def _decode(info, k):
    """Chunk k's points (laspy ScaleAwarePointRecord), from bytes already fetched."""
    import laspy
    import lazrs
    sp = info["sparse"]
    sp.seek(info["off"])
    d = lazrs.LasZipDecompressor(sp, info["vlr"])
    first = sum(c for c, _ in info["table"][:k])
    d.seek(first)
    n = info["table"][k][0]
    buf = bytearray(n * info["psize"])
    d.decompress_many(buf)
    h = info["header"]
    arr = np.frombuffer(bytes(buf), dtype=h.point_format.dtype())
    return laspy.ScaleAwarePointRecord(arr, h.point_format, h.scales, h.offsets)


def _fetch_runs(src, info, runs, have):
    """The chunks of these runs not yet fetched, in as few requests as the server allows: one
    multi-range request for all of them (a run of neighbours is one range), else one per run."""
    want = []
    for k0, k1 in runs:
        ks = [k for k in range(k0, k1 + 1) if k not in have]
        for r0, r1 in runs_of(ks, gap=0):
            want.append((r0, r1))
    if not want:
        return
    ranges = [(info["starts"][r0], info["starts"][r1 + 1] - 1) for r0, r1 in want]

    def fetch(rs):
        if len(rs) == 1:
            return [src.get(*rs[0])]
        try:
            return src.get_many(rs)
        except Unsupported:
            return [src.get(a, b) for a, b in rs]

    # Two connections, as the whole download uses (rockyweb gives each about
    # 0.1 MB/s; workflow 47, 2026-10-31): the ranges split in two halves by bytes,
    # a range longer than half cut in two.
    ways = getattr(src, "connections", 1)
    total = sum(b - a + 1 for a, b in ranges)
    if ways >= 2 and total > 2 * (1 << 20):
        half = total / 2
        parts, acc, cut = [[], []], 0, False
        for a, b in ranges:
            if not cut and acc + (b - a + 1) > half:
                m = a + int(half - acc)
                if m > a:
                    parts[0].append((a, m - 1))
                parts[1].append((m, b))
                cut = True
            else:
                parts[1 if cut else 0].append((a, b))
            acc += b - a + 1
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(2) as ex:
            got = list(ex.map(fetch, [q for q in parts if q]))
        pieces = [(a, d) for q, ds in zip([q for q in parts if q], got) for (a, _), d in zip(q, ds)]
        joined = {}
        for a, d in sorted(pieces):  # a range cut in two, put back together
            prev = next((k for k in joined if k + len(joined[k]) == a), None)
            if prev is not None:
                joined[prev] = joined[prev] + d
            else:
                joined[a] = d
        datas = [joined[a] for a, _ in ranges]
    else:
        datas = fetch(ranges)
    for (a, _), d, (r0, r1) in zip(ranges, datas, want):
        info["sparse"].add(a, d)
        have.update(range(r0, r1 + 1))


def read_box(src, box3857, crs_of_header, say=lambda words: None):
    """
    The tile's records inside box3857 (Web Mercator), read in part: the same
    dict lidar_sources.tile_records gives, plus a "stats" entry. Raises
    Unsupported when it cannot, so the caller fetches the tile whole.
    `crs_of_header(header) -> (rasterio CRS, z metres per unit)`.
    """
    from rasterio.warp import transform
    t0 = time.time()
    info = tile_info(src)
    h = info["header"]
    crs, zf = crs_of_header(h)
    # The box in the tile's own units, with tile_records' margin for the bend.
    bx = [box3857[0], box3857[2], box3857[0], box3857[2], (box3857[0] + box3857[2]) / 2, (box3857[0] + box3857[2]) / 2]
    by = [box3857[1], box3857[1], box3857[3], box3857[3], box3857[1], box3857[3]]
    nx, ny = transform("EPSG:3857", crs, bx, by)
    pad = 0.02 * max(max(nx) - min(nx), max(ny) - min(ny)) + 10
    nbox = [min(nx) - pad, min(ny) - pad, max(nx) + pad, max(ny) + pad]
    # Ground metres per tile unit, from the box itself.
    lat = math.degrees(2 * math.atan(math.exp(((box3857[1] + box3857[3]) / 2) / 6378137.0)) - math.pi / 2)
    ground_w = (box3857[2] - box3857[0]) * math.cos(math.radians(lat))
    unit_m = ground_w / max(1e-9, max(nx) - min(nx)) if ground_w > 0 else 1.0
    n = len(info["table"])
    psize = info["psize"]
    raws = src.get_many([(info["starts"][k], info["starts"][k] + psize - 1) for k in range(n)])
    xs, ys, srcs = first_points(info, raws)
    picked, why = select_chunks(xs, ys, srcs, nbox, unit_m=unit_m, gps=info.get("gps"))
    if why:
        raise Unsupported(why)
    need = sum(info["table"][k][1] for k in picked)
    if need > MAX_SHARE * info["size"]:
        raise Unsupported(f"the box needs {need / info['size']:.0%} of the tile")
    have = set()
    picked = sorted({j for k in picked for j in range(max(0, k - END_PAD), min(n, k + END_PAD + 1))})
    need = sum(info["table"][k][1] for k in picked)
    if need > MAX_SHARE * info["size"]:
        raise Unsupported(f"the box needs {need / info['size']:.0%} of the tile")
    if info["size"] - need < getattr(src, "min_saving", MIN_SAVING):
        raise Unsupported(f"a part saves only {(info['size'] - need) / 1e6:.0f} MB of {info['size'] / 1e6:.0f}")
    runs = runs_of(picked)
    say(f"reading {len(picked)} of {n} chunks ({need / 1e6:.1f} of {info['size'] / 1e6:.0f} MB)")
    _fetch_runs(src, info, runs, have)
    pts = {}

    def inside(k):
        if k not in pts:
            r = _decode(info, k)
            x, y = np.asarray(r.x), np.asarray(r.y)
            pts[k] = (r, (x >= nbox[0]) & (x <= nbox[2]) & (y >= nbox[1]) & (y <= nbox[3]))
        return pts[k][1].any()

    # Until it holds: a run whose end chunk still has points in the box takes the next chunk out.
    for _ in range(MAX_ROUNDS):
        grow = set()
        for k0, k1 in runs_of(sorted(have), gap=0):
            if k0 > 0 and inside(k0):
                grow.add(k0 - 1)
            if k1 < n - 1 and inside(k1):
                grow.add(k1 + 1)
        grow -= have
        if not grow:
            break
        _fetch_runs(src, info, runs_of(sorted(grow), gap=0), have)
    else:
        raise Unsupported("the box's chunks kept growing")
    for k in sorted(have):
        inside(k)
    got = sum(info["table"][k][1] for k in have)
    if got > MAX_SHARE * info["size"]:
        raise Unsupported(f"the box needed {got / info['size']:.0%} of the tile")
    has_gps = "gps_time" in h.point_format.dimension_names
    parts = {k: [] for k in ("x", "y", "z", "intensity", "ret", "nret", "cls", "gps")}
    for k in sorted(have):
        r, m = pts[k]
        if not m.any():
            continue
        parts["x"].append(np.asarray(r.x)[m])
        parts["y"].append(np.asarray(r.y)[m])
        parts["z"].append(np.asarray(r.z)[m] * zf)
        parts["intensity"].append(np.asarray(r.intensity)[m].astype(np.uint16))
        parts["ret"].append(np.asarray(r.return_number)[m].astype(np.uint8))
        parts["nret"].append(np.asarray(r.number_of_returns)[m].astype(np.uint8))
        parts["cls"].append(np.asarray(r.classification)[m].astype(np.uint8))
        if has_gps:
            parts["gps"].append(np.asarray(r.gps_time)[m].astype(np.float64))
    stats = {"chunks": n, "chunksRead": len(have), "chunksPicked": len(picked), "bytesRead": got,
             "fileBytes": info["size"], "share": round(got / info["size"], 4),
             "requests": src.requests, "seconds": round(time.time() - t0, 1),
             "refused": getattr(src, "refused", 0), "waitedS": round(getattr(src, "waited", 0.0), 1)}
    if not parts["x"]:
        rec = {k: np.zeros(0, dtype=np.float64 if k in ("x", "y", "z", "gps") else np.uint16) for k in parts}
        rec["gps"] = np.zeros(0) if has_gps else None
        rec["stats"] = stats
        return rec
    rec = {k: np.concatenate(v) for k, v in parts.items() if v}
    if not has_gps:
        rec["gps"] = None
    mx, my = transform(crs, "EPSG:3857", rec["x"].tolist(), rec["y"].tolist())
    rec["x"], rec["y"] = np.asarray(mx, dtype=np.float64), np.asarray(my, dtype=np.float64)
    keep = (rec["x"] >= box3857[0]) & (rec["x"] <= box3857[2]) & (rec["y"] >= box3857[1]) & (rec["y"] <= box3857[3])
    rec = {k: (v[keep] if v is not None else None) for k, v in rec.items()}
    rec["stats"] = stats
    return rec


def same_records(a, b):
    """Do two record dicts hold the same points (any order)? -> (bool, words)."""
    if len(a["x"]) != len(b["x"]):
        return False, f"{len(a['x'])} points against {len(b['x'])}"
    if not len(a["x"]):
        return True, "both empty"
    def key(r):
        return np.lexsort((r["gps"] if r.get("gps") is not None else r["z"], r["z"], r["y"], r["x"]))
    ia, ib = key(a), key(b)
    for k in ("x", "y", "z", "intensity", "ret", "nret", "cls"):
        if not np.array_equal(np.asarray(a[k])[ia], np.asarray(b[k])[ib]):
            return False, f"{k} differs"
    return True, f"{len(a['x'])} points, identical"
