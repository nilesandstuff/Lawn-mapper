/**
 * OVERTURE MAPS: ROADS, SIDEWALKS AND BUILDINGS OVER A LOT (water session, 2026-10-19).
 *
 * Owner, 2026-10-19: "it even shows sidewalks (it calls it road segment, with no street name)... So yes,
 * let's use that on top of current system. It doesn't show driveways, so we'll still have to use the
 * current system to find driveways."
 *
 * Overture (overturemaps.org; ODbL / CDLA, with OpenStreetMap, Microsoft and others behind it) publishes
 * each release's themes as PMTiles archives -- one file of vector tiles, read a piece at a time by HTTP
 * range requests, open to browsers (Access-Control-Allow-Origin: *). Its STAC catalog names the latest
 * release. This reads the transportation theme (segments: roads, sidewalks, footways, service roads...)
 * and the buildings theme over a box, at the archives' deepest zoom, with no library: PMTiles v3
 * (github.com/protomaps/PMTiles spec) and Mapbox Vector Tiles (protobuf) are both small formats.
 *
 * Everything comes back in [lng, lat].
 */

import { toMerc, fromMerc } from './ept.js';

export const STAC = 'https://stac.overturemaps.org/catalog.json';

/* ------------------------------------------------------------ bytes */

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}
const decompress = (bytes, kind) => (kind === 2 ? gunzip(bytes) : kind === 1 || kind === 0 ? bytes : Promise.reject(new Error(`compression ${kind} not read`)));

/** A protobuf varint at p.i (Numbers, safe past 32 bits up to 2^53). */
function varint(buf, p) {
  let v = 0, mul = 1, b;
  do { b = buf[p.i++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return v;
}
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

/* ------------------------------------------------------------ PMTiles v3 */

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) { xy[0] = n - 1 - xy[0]; xy[1] = n - 1 - xy[1]; }
    const t = xy[0]; xy[0] = xy[1]; xy[1] = t;
  }
}

/** z/x/y -> the PMTiles tile id (Hilbert order within each zoom). */
export function tileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  const xy = [x, y];
  let d = 0;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return acc + d;
}

function readDirectory(buf) {
  const p = { i: 0 };
  const n = varint(buf, p);
  const e = Array.from({ length: n }, () => ({ id: 0, run: 0, len: 0, off: 0 }));
  let last = 0;
  for (const x of e) { last += varint(buf, p); x.id = last; }
  for (const x of e) x.run = varint(buf, p);
  for (const x of e) x.len = varint(buf, p);
  e.forEach((x, k) => { const v = varint(buf, p); x.off = v === 0 && k > 0 ? e[k - 1].off + e[k - 1].len : v - 1; });
  return e;
}

export class PMTiles {
  constructor(url, fetchFn = fetch) { this.url = url; this.fetchFn = (u, o) => fetchFn(u, o); this.dirs = new Map(); this.h = null; } // unbound: a browser refuses fetch called as a method

  async range(off, len) {
    const res = await this.fetchFn(this.url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
    if (!(res.status === 206 || res.status === 200)) throw new Error(`Overture tiles answered ${res.status}`);
    const b = new Uint8Array(await res.arrayBuffer());
    return res.status === 200 ? b.subarray(off, off + len) : b;
  }

  async header() {
    if (this.h) return this.h;
    const b = await this.range(0, 16384);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles' || b[7] !== 3) throw new Error('not a PMTiles v3 archive');
    this.h = {
      rootOff: u64(dv, 8), rootLen: u64(dv, 16), leafOff: u64(dv, 40), dataOff: u64(dv, 56),
      internal: b[97], tileComp: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
    };
    this.dirs.set(`${this.h.rootOff}`, readDirectory(await decompress(b.subarray(this.h.rootOff, this.h.rootOff + this.h.rootLen), this.h.internal)));
    return this.h;
  }

  async dir(off, len) {
    const key = `${off}`;
    if (!this.dirs.has(key)) this.dirs.set(key, readDirectory(await decompress(await this.range(off, len), this.h.internal)));
    return this.dirs.get(key);
  }

  /** The tile's decompressed bytes, or null when the archive has none there. */
  async tile(z, x, y) {
    const h = await this.header();
    const id = tileId(z, x, y);
    let entries = await this.dir(h.rootOff, h.rootLen);
    for (let depth = 0; depth < 4; depth++) {
      let lo = 0, hi = entries.length - 1, hit = null;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (entries[m].id <= id) { hit = entries[m]; lo = m + 1; } else hi = m - 1; }
      if (!hit) return null;
      if (hit.run === 0) { entries = await this.dir(h.leafOff + hit.off, hit.len); continue; }
      if (id >= hit.id + hit.run) return null;
      return decompress(await this.range(h.dataOff + hit.off, hit.len), h.tileComp);
    }
    return null;
  }
}

/* ------------------------------------------------------------ vector tiles */

function readValue(buf, end, p) {
  let v = null;
  while (p.i < end) {
    const key = varint(buf, p), f = key >> 3, w = key & 7;
    if (w === 2) { const l = varint(buf, p); if (f === 1) v = new TextDecoder().decode(buf.subarray(p.i, p.i + l)); p.i += l; }
    else if (w === 5) { v = new DataView(buf.buffer, buf.byteOffset + p.i, 4).getFloat32(0, true); p.i += 4; }
    else if (w === 1) { v = new DataView(buf.buffer, buf.byteOffset + p.i, 8).getFloat64(0, true); p.i += 8; }
    else if (w === 0) { const n = varint(buf, p); v = f === 6 ? (n % 2 ? -(n + 1) / 2 : n / 2) : f === 7 ? !!n : n; }
  }
  return v;
}

const packed = (buf, p, end) => { const out = []; while (p.i < end) out.push(varint(buf, p)); return out; };

/** A vector tile -> { layerName: { extent, features: [{ type, props, geom: [[[x, y], ...], ...] }] } }. */
export function decodeMvt(buf) {
  const layers = {};
  const p = { i: 0 };
  while (p.i < buf.length) {
    const key = varint(buf, p);
    if ((key >> 3) !== 3 || (key & 7) !== 2) { skip(buf, p, key & 7); continue; }
    const len = varint(buf, p), end = p.i + len;
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (p.i < end) {
      const k = varint(buf, p), f = k >> 3, w = k & 7;
      if (f === 1 && w === 2) { const l = varint(buf, p); name = new TextDecoder().decode(buf.subarray(p.i, p.i + l)); p.i += l; }
      else if (f === 2 && w === 2) { const l = varint(buf, p); feats.push([p.i, p.i + l]); p.i += l; }
      else if (f === 3 && w === 2) { const l = varint(buf, p); keys.push(new TextDecoder().decode(buf.subarray(p.i, p.i + l))); p.i += l; }
      else if (f === 4 && w === 2) { const l = varint(buf, p); const e = p.i + l; values.push(readValue(buf, e, p)); p.i = e; }
      else if (f === 5 && w === 0) extent = varint(buf, p);
      else skip(buf, p, w);
    }
    layers[name] = { extent, features: feats.map(([a, b]) => feature(buf, a, b, keys, values)) };
  }
  return layers;
}

function skip(buf, p, w) {
  if (w === 0) varint(buf, p); else if (w === 1) p.i += 8; else if (w === 5) p.i += 4; else if (w === 2) { const l = varint(buf, p); p.i += l; } else throw new Error(`wire type ${w}`);
}

function feature(buf, a, b, keys, values) {
  const p = { i: a };
  let type = 0, tags = [], geom = [];
  while (p.i < b) {
    const k = varint(buf, p), f = k >> 3, w = k & 7;
    if (f === 2 && w === 2) { const l = varint(buf, p); tags = packed(buf, p, p.i + l); }
    else if (f === 3 && w === 0) type = varint(buf, p);
    else if (f === 4 && w === 2) { const l = varint(buf, p); geom = packed(buf, p, p.i + l); }
    else skip(buf, p, w);
  }
  const props = {};
  for (let t = 0; t + 1 < tags.length; t += 2) props[keys[tags[t]]] = values[tags[t + 1]];
  const parts = [];
  let x = 0, y = 0, cur = null;
  for (let i = 0; i < geom.length;) {
    const cmd = geom[i] & 7, count = geom[i] >> 3;
    i++;
    if (cmd === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
    for (let c = 0; c < count; c++) {
      const dx = geom[i++], dy = geom[i++];
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2; y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      if (cmd === 1) { cur = [[x, y]]; parts.push(cur); } else cur.push([x, y]);
    }
  }
  return { type, props, geom: parts };
}

/* ------------------------------------------------------------ the lot */

const R = 6378137;
let latest = null;

/** The latest release's PMTiles URL for a theme, from Overture's STAC catalog. */
export async function themeUrl(theme, fetchFn = fetch) {
  if (!latest) {
    const cat = await (await fetchFn(STAC)).json();
    const child = cat.links.find((l) => l.rel === 'child' && l.latest) || cat.links.filter((l) => l.rel === 'child').pop();
    latest = child.href.replace(/\/catalog\.json$/, '');
  }
  const t = await (await fetchFn(`${latest}/${theme}/catalog.json`)).json();
  const link = t.links.find((l) => l.rel === 'pmtiles');
  if (!link) throw new Error(`no PMTiles for ${theme}`);
  return link.href;
}

/** The features of one theme over an EPSG:3857 box, in [lng, lat]: [{ layer, type, props, parts }]. */
export async function themeIn(theme, bbox, { fetchFn = fetch } = {}) {
  const pm = new PMTiles(await themeUrl(theme, fetchFn), fetchFn);
  const h = await pm.header();
  const z = h.maxZoom, n = 2 ** z, W = 2 * Math.PI * R;
  const tx = (x) => Math.floor(((x + Math.PI * R) / W) * n), ty = (y) => Math.floor(((Math.PI * R - y) / W) * n);
  const out = [];
  for (let x = tx(bbox[0]); x <= tx(bbox[2]); x++) for (let y = ty(bbox[3]); y <= ty(bbox[1]); y++) {
    const bytes = await pm.tile(z, x, y);
    if (!bytes) continue;
    for (const [layer, L] of Object.entries(decodeMvt(bytes))) for (const f of L.features) {
      const parts = f.geom.map((ring) => ring.map(([px, py]) => fromMerc([((x + px / L.extent) / n) * W - Math.PI * R, Math.PI * R - ((y + py / L.extent) / n) * W])));
      out.push({ layer, type: f.type, props: f.props, parts });
    }
  }
  return out;
}

/* Paved width, metres, by Overture road class (and subclass), for a line drawn as a band. Typical US
   curb-to-curb widths; a first cut, scored in FINDINGS against the Chesapeake land use. */
export const WIDTH = {
  motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 9, residential: 8, living_street: 6, unclassified: 7,
  service: 4, pedestrian: 4, footway: 1.5, sidewalk: 1.5, crosswalk: 3, steps: 1.5, path: 1.2, cycleway: 2, track: 0, bridleway: 0,
  driveway: 3.5, alley: 4, parking_aisle: 6, unknown: 5,
};

/** What a lot needs: paved bands from the transportation segments, and building outlines. */
export async function overtureFor(bbox, opts = {}) {
  const [tr, bl] = await Promise.all([themeIn('transportation', bbox, opts), themeIn('buildings', bbox, opts)]);
  const roads = tr.filter((f) => f.type === 2 && (f.props.subtype === 'road' || !f.props.subtype)).map((f) => {
    const cls = f.props.class || 'unknown', sub = f.props.subclass || null;
    const width = WIDTH[sub] ?? WIDTH[cls] ?? WIDTH.unknown;
    return { cls, sub, width, walk: ['footway', 'sidewalk', 'crosswalk', 'steps', 'path', 'pedestrian', 'cycleway'].includes(sub || cls), lines: f.parts };
  }).filter((r) => r.width > 0);
  const buildings = bl.filter((f) => f.type === 3 && f.layer === 'building').map((f) => f.parts);
  return { roads, buildings };
}

/**
 * On a grid (lib/surface.js gridFor: W, H, cell, toCell): Uint8Arrays of cells under a paved band (1 road,
 * 2 walk) and under a building, by cell centre.
 */
export function overtureMasks(g, ov) {
  const N = g.W * g.H, paved = new Uint8Array(N), building = new Uint8Array(N);
  for (const r of ov.roads) {
    const half = r.width / 2 / g.cell;
    for (const line of r.lines) {
      const pts = line.map((p) => { const [x, y] = toMerc(p); return g.toCell(x, y); });
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
        const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)), c1 = Math.min(g.W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
        const r0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)), r1 = Math.min(g.H - 1, Math.ceil(Math.max(ay, by) + half + 1));
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
          const px = cc + 0.5, py = rr + 0.5;
          const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
          if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= half) { const i = rr * g.W + cc; if (!paved[i] || !r.walk) paved[i] = r.walk ? 2 : 1; }
        }
      }
    }
  }
  const outlines = [];
  for (const poly of ov.buildings) {
    const rings = poly.map((ring) => ring.map((p) => { const [x, y] = toMerc(p); return g.toCell(x, y); }));
    if (!rings.length || rings[0].length < 3) continue;
    outlines.push(rings[0]);
  }
  fillOutlines(building, g.W, g.H, outlines, 0, 0, 1);
  return { paved, building, outlines };
}

/** Outlines (rings in grid cells) filled into a W x H raster at `scale` cells per grid cell, moved (dx, dy) grid cells. */
function fillOutlines(out, W, H, outlines, dx, dy, scale) {
  for (const ring0 of outlines) {
    const ring = ring0.map(([x, y]) => [(x + dx) * scale, (y + dy) * scale]);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    for (let rr = Math.max(0, Math.floor(Math.min(...ys))); rr <= Math.min(H - 1, Math.ceil(Math.max(...ys))); rr++) {
      for (let cc = Math.max(0, Math.floor(Math.min(...xs))); cc <= Math.min(W - 1, Math.ceil(Math.max(...xs))); cc++) {
        if (inRing(ring, cc + 0.5, rr + 0.5)) out[rr * W + cc] = 1;
      }
    }
  }
  return out;
}

/* OVERTURE'S BUILDINGS SIT OFF THE ROOFS (the core session's H101 in docs/DETECTOR-FINDINGS.md, 2026-10-20:
   on 104 lots a median 0.87 m from the lidar's roofs, over 2 m on 9, one shift per lot in a direction that
   changes lot by lot -- Microsoft's outlines carry their imagery's offset; the owner saw it in the field).
   The same cure as the core's tools/overture-frames.js fitToRoof, at a quarter cell rather than whole
   cells (the error is under a cell): the one shift, within ALIGN_REACH_M, that best overlaps the lidar's
   own roofs, used only when it is a fit -- an overlap of ALIGN_MIN_IOU and clearly better than as
   published. Roads and sidewalks are OpenStreetMap's and do not share the shift; they are left alone. */
export const ALIGN_MIN_IOU = 0.3, ALIGN_MIN_GAIN = 0.02, ALIGN_REACH_M = 4, ALIGN_STEP = 4, ALIGN_MIN_ROOF_M2 = 50;

/**
 * masks: overtureMasks' answer; roof: the lidar's roof mask on the same grid.
 * -> { building (moved, or as published), dxM, dyM (east, south, metres), iou0, iou, applied }
 */
export function alignBuildings(g, masks, roof) {
  const { W, H } = g, S = ALIGN_STEP, FW = W * S, FH = H * S;
  let roofN = 0;
  for (let i = 0; i < W * H; i++) if (roof[i]) roofN++;
  const asIs = { building: masks.building, dxM: 0, dyM: 0, iou0: null, iou: null, applied: false };
  if (!masks.outlines?.length || roofN * g.cell * g.cell < ALIGN_MIN_ROOF_M2) return asIs;
  const fine = fillOutlines(new Uint8Array(FW * FH), FW, FH, masks.outlines, 0, 0, S);
  const cells = [];
  for (let i = 0; i < FW * FH; i++) if (fine[i]) cells.push(i);
  if (!cells.length) return asIs;
  const bN = cells.length / (S * S);
  const iou = (sx, sy) => {
    let inter = 0;
    for (const i of cells) {
      const r = Math.floor((Math.floor(i / FW) + sy) / S), c = Math.floor(((i % FW) + sx) / S);
      if (r >= 0 && c >= 0 && r < H && c < W && roof[r * W + c]) inter++;
    }
    inter /= S * S;
    return inter / (bN + roofN - inter);
  };
  const reach = Math.round((ALIGN_REACH_M / g.cell) * S);
  const better = (v, sx, sy, b) => v > b.iou + 1e-9 || (Math.abs(v - b.iou) <= 1e-9 && Math.hypot(sx, sy) < Math.hypot(b.sx, b.sy));
  const iou0 = iou(0, 0);
  let best = { sx: 0, sy: 0, iou: iou0 };
  // whole cells first, then quarter cells round the best
  for (let sy = -reach; sy <= reach; sy += S) for (let sx = -reach; sx <= reach; sx += S) { const v = iou(sx, sy); if (better(v, sx, sy, best)) best = { sx, sy, iou: v }; }
  const c0 = best;
  for (let sy = c0.sy - S; sy <= c0.sy + S; sy++) for (let sx = c0.sx - S; sx <= c0.sx + S; sx++) {
    if (Math.abs(sx) > reach || Math.abs(sy) > reach) continue;
    const v = iou(sx, sy); if (better(v, sx, sy, best)) best = { sx, sy, iou: v };
  }
  const dx = best.sx / S, dy = best.sy / S;
  const fits = best.iou >= ALIGN_MIN_IOU && best.iou >= iou0 + ALIGN_MIN_GAIN;
  if (!fits) return { ...asIs, iou0, iou: best.iou };
  return { building: fillOutlines(new Uint8Array(W * H), W, H, masks.outlines, dx, dy, 1), dxM: dx * g.cell, dyM: dy * g.cell, iou0, iou: best.iou, applied: true };
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
