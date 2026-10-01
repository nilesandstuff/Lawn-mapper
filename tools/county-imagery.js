/**
 * County and state orthophotos for every corpus map, found, lined up with the
 * banked Mapbox photo, and banked beside it (owner, 2026-10-01).
 *
 * WHY. Workflow 8 ("compare on our lawns", H62) found county or state imagery
 * for 22 of 60 lots, a median 6 cm native and sharper than Mapbox wherever it
 * could be scored -- but only by looking on the server that publishes each
 * county's parcels. This is the thorough pass: every corpus map, two ways of
 * finding imagery, every candidate actually fetched over the map's own frame,
 * and the chosen one banked so a training run can swap photos.
 *
 * WHERE CANDIDATES COME FROM, both, deduplicated:
 *   - the county's own GIS host: the catalogue the parcel layer lives in and
 *     its sibling web adaptors (/image/, /imagery/, ...), every folder
 *   - ArcGIS Online's public catalogue, searched at the lot's own location
 *     for image and map services titled or tagged as orthoimagery or aerials,
 *     dropping anything that covers more than a state
 *
 * WHAT "USABLE" MEANS, per candidate, fetched over the map's image_frame at
 * the banked Mapbox photo's own pixel size:
 *   - covered: under 2% of the picture transparent or a flat no-data fill
 *   - fine enough: native 25 cm or better, from the service's metadata, or --
 *     for a map service that will not say -- from how blocky its enlargement
 *     is; an image service whose metadata says nothing must score at least
 *     0.8x Mapbox's detail (bilinear, so the measure is honest; see H62)
 *   - flown 2012 or later when it names a year
 * The newest usable flight wins, the finer one on a tie.
 *
 * LINED UP BEFORE IT IS BANKED. The outlines were traced on the banked Mapbox
 * photo, so a county photo is only useful to training if it sits exactly on
 * that one. lib/align.js -- the app's own alignment -- finds the shift and
 * scale against the banked photo; the county photo is then fetched again over
 * the frame moved by the inverse of that, which lands it on Mapbox's pixel
 * grid, and aligned once more to prove it (residual_m, which should be near
 * zero). A person checks the doubtful ones on /county.html, and a nudge made
 * there is applied by MODE=rebank.
 *
 * SLOW AND CAREFUL. One lot at a time, a pause between requests, retries,
 * and a row written for every lot looked at -- found or not -- so a run that
 * stops part-way resumes where it left off (FORCE=1 to look again).
 *
 *   MODE=find|rebank LIMIT=… FORCE=1 DRY_RUN=1 ONLY=<corpus id> node tools/county-imagery.js
 * or workflow "8. Check the free imagery sources", "find county imagery".
 * Free: public servers, the R2 bucket and D1 the app already has.
 */

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { query, wrangler, resolveDatabase } from './corpus-db.js';
import { extraDetail } from './probe-resolution.js';
import {
  catalogueRoot, siblingRoots, pickImagery, yearHints, nativeCm, greyGrid, greenShare,
} from './compare-imagery.js';
import { alignImages } from '../public/lib/align.js';
import { frameBbox3857 } from '../worker/src/imagery.js';
import { candidateCounties, ALL_COUNTIES } from '../worker/src/counties.js';

const MODE = process.env.MODE || 'find';
const LIMIT = Number(process.env.LIMIT || 500);
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || '');
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ONLY = process.env.ONLY || '';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
const MAX_TRY = Number(process.env.MAX_TRY || 12);
const MIN_YEAR = Number(process.env.MIN_YEAR || 2012);
const PAUSE_MS = Number(process.env.PAUSE_MS || 250);
const TIMEOUT_MS = 120000;

const MAX_NATIVE_CM = 25;
const MIN_COVER = 0.98;
const MIN_DETAIL = 0.8;
/* The offset search reaches 10 m: H62's medians were about 1 m, the worst
   few metres. A fit at the edge of the reach is not a fit. */
const REACH_M = 10;
/* A fit below this is not trusted to move a photo (see findFor). */
const MIN_FIT = 0.3;

const R = 20037508.342789244;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ pure parts */

/** Search ArcGIS Online's public catalogue near a point (the query only). */
export function agolSearchUrl(lng, lat, start = 1) {
  const d = 0.001;
  const q = '(title:ortho OR title:orthos OR title:orthoimagery OR title:orthophoto OR '
    + 'title:orthophotos OR title:aerial OR title:aerials OR title:imagery OR '
    + 'tags:orthoimagery OR tags:"aerial imagery") AND (type:"Image Service" OR type:"Map Service")';
  return 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
    q, bbox: [lng - d, lat - d, lng + d, lat + d].join(','), f: 'json', num: '100', start: String(start),
  });
}

/** The ArcGIS Online results worth trying here: local, over the point, a real service. */
export function agolKeep(results, lng, lat, maxArea = 30) {
  const out = [];
  for (const r of results || []) {
    if (!r?.url || !Array.isArray(r.extent) || r.extent.length !== 2) continue;
    const [[x0, y0], [x1, y1]] = r.extent;
    if ((x1 - x0) * (y1 - y0) > maxArea) continue;
    if (!(lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1)) continue;
    const m = String(r.url).match(/^(https?:\/\/.+\/(?:ImageServer|MapServer))\/?$/i);
    if (!m) continue;
    out.push({ url: m[1], type: /ImageServer$/i.test(m[1]) ? 'ImageServer' : 'MapServer', title: r.title || '' });
  }
  return out;
}

/*
 * NOT A PHOTOGRAPH OF THE GROUND AS SEEN. The first run picked
 * Massachusetts' "2025 Aerial Imagery - CIR": colour infrared, false colour.
 * Indexes, footprints and elevation layers are not photos either.
 */
export const NOT_A_PHOTO = /\bcir\b|infra.?red|\bnir\b|ndvi|false.?colou?r|color.?infrared|index|footprint|boundar|tile.?scheme|flight|\blidar|\bdem\b|hillshade|elevation|contour|parcel|topo|labels?\b|reference/i;

/**
 * Candidates in the order to try them: dropping flights named before
 * MIN_YEAR, then the newest named year first, then those naming none, a
 * "_Cached" twin after its original. Deduplicated by URL.
 */
export function rankCandidates(list, minYear = MIN_YEAR) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = c.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (NOT_A_PHOTO.test(`${c.title} ${c.url.split('/rest/services/')[1] || c.url}`)) continue;
    const years = yearHints(`${c.title} ${c.url}`);
    const year = years.length ? Math.max(...years) : null;
    if (year !== null && year < minYear) continue;
    out.push({ ...c, year });
  }
  return out.sort((a, b) => ((b.year ?? 0) - (a.year ?? 0))
    || (/cache/i.test(a.url) - /cache/i.test(b.url)));
}

/** The best of the usable: newest year, then finest. */
export function chooseBest(evaluated) {
  const usable = evaluated.filter((e) => e.usable);
  usable.sort((a, b) => ((b.year ?? 0) - (a.year ?? 0))
    || ((a.nativeCm ?? 99) - (b.nativeCm ?? 99)));
  return usable[0] || null;
}

/** Share of the picture that is real data: opaque, not a flat white or black fill. */
export function coverage(data, w, h) {
  let good = 0, n = 0;
  for (let i = 0; i < w * h; i += 5) {
    n++;
    const [r, g, b, a] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
    if (a < 250) continue;
    /* Exactly white or exactly black is a no-data fill; a bright roof is not
       (the first run turned Milwaukee's 2026 flight away at 98% for them). */
    if ((r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0)) continue;
    good++;
  }
  return n ? good / n : 0;
}

/**
 * How much a picture was enlarged by nearest-neighbour, from how many
 * neighbouring pixels are exactly equal: a source enlarged b times repeats
 * each pixel b times, so (b-1)/b of horizontal neighbours match. Only for a
 * losslessly encoded picture; 1 means "not visibly enlarged".
 */
export function blockiness(data, w, h) {
  let same = 0, n = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 250 || data[i + 7] < 250) continue;
      n++;
      if (data[i] === data[i + 4] && data[i + 1] === data[i + 5] && data[i + 2] === data[i + 6]) same++;
    }
  }
  if (!n) return 1;
  const f = same / n;
  return f < 0.3 ? 1 : 1 / Math.max(0.05, 1 - f);
}

/** Bilinear resize of RGBA. */
export function resizeRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const v = src[(y0 * sw + x0) * 4 + c] * (1 - fx) * (1 - fy)
          + src[(y0 * sw + x1) * 4 + c] * fx * (1 - fy)
          + src[(y1 * sw + x0) * 4 + c] * (1 - fx) * fy
          + src[(y1 * sw + x1) * 4 + c] * fx * fy;
        out[(y * dw + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return out;
}

/**
 * The box to ask the county service for so its photo lands on the Mapbox
 * photo's pixel grid. align.js answers "move the county photo east/north by
 * these metres and scale it about the centre by s to line up", i.e. county
 * ground Q appears at P = c + s(Q - c) + T. So the Mapbox box [P] needs county
 * ground Q = c + (P - c - T) / s. Web Mercator metres, T converted from ground
 * metres by 1/cos(lat), as movedCorners does.
 */
export function shiftedBbox(bbox, east, north, scale, lat) {
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const tx = east * k, ty = north * k;
  const inv = (x, y) => [cx + (x - cx - tx) / scale, cy + (y - cy - ty) / scale];
  const [x0, y0] = inv(w, s);
  const [x1, y1] = inv(e, n);
  return [x0, y0, x1, y1];
}

/** SQL literal. */
const lit = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))
  ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/* --------------------------------------------------------------- network */

async function getJson(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`http-${res.status}`);
      const j = await res.json();
      if (j?.error) throw new Error(`arcgis ${j.error.code || ''} ${j.error.message || ''}`.trim());
      return j;
    } catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw last;
}

async function getImage(url, decoders) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { if (res.status >= 400 && res.status < 500) return null; throw new Error(`http-${res.status}`); }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x89 && buf[1] === 0x50) {
        const p = decoders.png.PNG.sync.read(buf);
        return { data: p.data, width: p.width, height: p.height, lossless: true };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        const j = decoders.jpeg.decode(buf, { useTArray: true });
        return { data: j.data, width: j.width, height: j.height, lossless: false };
      }
      return null; // an error page or JSON
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

async function listCatalogue(root) {
  const top = await getJson(`${root}?f=json`);
  const out = (top.services || []).map((s) => ({ ...s, root }));
  for (const folder of (top.folders || []).slice(0, 40)) {
    try {
      const sub = await getJson(`${root}/${encodeURIComponent(folder)}?f=json`);
      out.push(...(sub.services || []).map((s) => ({ ...s, root })));
    } catch { /* one folder refusing is not the catalogue refusing */ }
    await sleep(PAUSE_MS);
  }
  return out;
}

const catalogueCache = new Map();
export async function countyCandidates(lng, lat) {
  const roots = [...new Set(candidateCounties(lng, lat)
    .map((k) => catalogueRoot(ALL_COUNTIES[k]?.service)).filter(Boolean))];
  const out = [];
  for (const root of roots.flatMap(siblingRoots)) {
    if (!catalogueCache.has(root)) {
      catalogueCache.set(root, await listCatalogue(root).then(pickImagery).catch(() => []));
    }
    for (const s of catalogueCache.get(root)) {
      out.push({ url: `${s.root}/${s.name}/${s.type}`, type: s.type, title: s.name, via: 'county host' });
    }
  }
  return out;
}

export async function agolCandidates(lng, lat) {
  const out = [];
  let start = 1;
  for (let page = 0; page < 8 && start > 0; page++) {
    let j;
    try { j = await getJson(agolSearchUrl(lng, lat, start)); } catch { break; }
    out.push(...agolKeep(j.results, lng, lat).map((c) => ({ ...c, via: 'ArcGIS Online' })));
    start = j.nextStart > 0 ? j.nextStart : 0;
    await sleep(PAUSE_MS);
  }
  return out;
}

const metaCache = new Map();
export async function meta(url) {
  if (!metaCache.has(url)) metaCache.set(url, await getJson(`${url}?f=json`).catch((e) => ({ failed: e.message })));
  return metaCache.get(url);
}

const isMercator = (m) => [3857, 102100, 900913].includes(m?.spatialReference?.latestWkid || m?.spatialReference?.wkid);

function exportUrl(c, bbox, w, h) {
  const params = new URLSearchParams({
    bbox: bbox.join(','), bboxSR: '3857', imageSR: '3857', size: `${w},${h}`, f: 'image',
  });
  if (c.type === 'ImageServer') {
    params.set('format', 'png');
    params.set('interpolation', 'RSP_BilinearInterpolation');
    return `${c.url}/exportImage?${params}`;
  }
  params.set('format', 'png32');
  params.set('transparent', 'true');
  params.set('dpi', '96');
  return `${c.url}/export?${params}`;
}

/*
 * A TILE-ONLY SERVICE IN ANOTHER PROJECTION. State plane in US feet is common
 * (Illinois' GISC flights are EPSG:3435), and such a cache cannot be asked
 * for a Web Mercator box at all. So each output pixel's centre is taken from
 * Web Mercator to the service's own coordinates (proj4, with the definition
 * from epsg.io) and sampled from a mosaic of its tiles.
 */
const projCache = new Map();
async function projectionFor(m) {
  const wkid = m?.spatialReference?.latestWkid || m?.spatialReference?.wkid;
  if (!wkid) return null;
  if (!projCache.has(wkid)) {
    projCache.set(wkid, (async () => {
      try {
        const def = (await (await fetch(`https://epsg.io/${wkid}.proj4`, { signal: AbortSignal.timeout(TIMEOUT_MS) })).text()).trim();
        if (!def.startsWith('+proj')) return null;
        const proj4 = (await import('proj4')).default;
        const fwd = proj4('EPSG:3857', def);
        const toMetres = /\+units=us-ft/.test(def) ? 1200 / 3937 : /\+units=ft/.test(def) ? 0.3048 : 1;
        return { forward: (x, y) => fwd.forward([x, y]), toMetres };
      } catch { return null; }
    })());
  }
  return projCache.get(wkid);
}

/** A cached service read tile by tile, for one that will not draw a box. */
async function fetchTiled(c, m, bbox, w, h, decoders) {
  const ti = m.tileInfo;
  if (!ti?.lods?.length) return null;
  const merc = isMercator(m);
  const proj = merc ? { forward: (x, y) => [x, y], toMetres: 1 } : await projectionFor(m);
  if (!proj) return null;
  const size = ti.rows || 256;
  const ox = ti.origin.x, oy = ti.origin.y;
  /* Wanted resolution in the service's own units: Mercator units are ground
     metres / cos(lat); projected units are metres or feet (toMetres). */
  const latC = (2 * Math.atan(Math.exp(((bbox[1] + bbox[3]) / 2) / 6378137)) - Math.PI / 2);
  const want = merc ? (bbox[2] - bbox[0]) / w : ((bbox[2] - bbox[0]) / w) * Math.cos(latC) / proj.toMetres;
  const lods = ti.lods.filter((l) => !(Number(m.maxScale) > 0) || l.scale >= Number(m.maxScale) - 1);
  if (!lods.length) return null;
  let lod = lods.filter((l) => l.resolution <= want).sort((a, b) => b.resolution - a.resolution)[0];
  if (!lod) lod = lods.slice().sort((a, b) => a.resolution - b.resolution)[0];
  const res = lod.resolution;
  const span = res * size;
  /* The box in the service's own coordinates: its four corners, projected. */
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
    .map(([x, y]) => proj.forward(x, y));
  const sx0 = Math.min(...corners.map((p) => p[0])), sx1 = Math.max(...corners.map((p) => p[0]));
  const sy0 = Math.min(...corners.map((p) => p[1])), sy1 = Math.max(...corners.map((p) => p[1]));
  const c0 = Math.floor((sx0 - ox) / span), c1 = Math.floor((sx1 - ox) / span);
  const r0 = Math.floor((oy - sy1) / span), r1 = Math.floor((oy - sy0) / span);
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > 400) return null;
  const mw = (c1 - c0 + 1) * size, mh = (r1 - r0 + 1) * size;
  const mosaic = new Uint8Array(mw * mh * 4);
  let got = 0;
  for (let r = r0; r <= r1; r++) {
    for (let col = c0; col <= c1; col++) {
      const t = await getImage(`${c.url}/tile/${lod.level}/${r}/${col}`, decoders);
      await sleep(60);
      if (!t) continue;
      got++;
      for (let y = 0; y < Math.min(size, t.height); y++) {
        for (let x = 0; x < Math.min(size, t.width); x++) {
          const si = (y * t.width + x) * 4;
          const di = (((r - r0) * size + y) * mw + (col - c0) * size + x) * 4;
          mosaic[di] = t.data[si]; mosaic[di + 1] = t.data[si + 1];
          mosaic[di + 2] = t.data[si + 2]; mosaic[di + 3] = t.data[si + 3];
        }
      }
    }
  }
  if (!got) return null;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const gy = bbox[3] - ((y + 0.5) * (bbox[3] - bbox[1])) / h;
    for (let x = 0; x < w; x++) {
      const gx = bbox[0] + ((x + 0.5) * (bbox[2] - bbox[0])) / w;
      const [px, py] = merc ? [gx, gy] : proj.forward(gx, gy);
      const my = (oy - py) / res - r0 * size - 0.5;
      const mx = (px - ox) / res - c0 * size - 0.5;
      if (mx < -1 || my < -1 || mx > mw || my > mh) continue; // outside the mosaic: transparent
      const y0 = Math.max(0, Math.min(mh - 1, Math.floor(my))), y1 = Math.min(mh - 1, y0 + 1), fy = Math.min(1, Math.max(0, my - y0));
      const x0 = Math.max(0, Math.min(mw - 1, Math.floor(mx))), x1 = Math.min(mw - 1, x0 + 1), fx = Math.min(1, Math.max(0, mx - x0));
      for (let k = 0; k < 4; k++) {
        out[(y * w + x) * 4 + k] = Math.round(
          mosaic[(y0 * mw + x0) * 4 + k] * (1 - fx) * (1 - fy) + mosaic[(y0 * mw + x1) * 4 + k] * fx * (1 - fy)
          + mosaic[(y1 * mw + x0) * 4 + k] * (1 - fx) * fy + mosaic[(y1 * mw + x1) * 4 + k] * fx * fy);
      }
    }
  }
  /* The tile level IS the native resolution of what was read, unless the
     cache was built finer than its data -- blockiness catches that below. */
  /* tileCm on the ground: a Mercator unit is 1/cos(lat) of a metre (applied
     by the caller); a projected unit is a foot or a metre as it says. */
  return { data: out, width: w, height: h, lossless: true, tiled: true, tileCm: res * proj.toMetres * 100, merc };
}

/** One candidate over one box, at w x h: export, or tiles when export will not. */
export async function fetchOver(c, m, bbox, w, h, decoders) {
  const maxW = Number(m.maxImageWidth) || 4096, maxH = Number(m.maxImageHeight) || 4096;
  const fw = Math.min(w, maxW), fh = Math.min(h, maxH);
  const one = async (box, bw, bh) => {
    const img = await getImage(exportUrl(c, box, bw, bh), decoders);
    /* A picture of another size is letterboxed -- not our box -- so it is
       not used; the tiles, if there are any, still can be. */
    return img && img.width === bw && img.height === bh ? img : null;
  };
  let exported = await one(bbox, fw, fh);
  /*
   * IN FOUR QUARTERS when the whole will not come: a big frame at 5 cm is a
   * large export, and some servers time out or refuse it (Ingham County's
   * 2025 flight answered a 128 px look and nothing at full size).
   */
  if (!exported && fw >= 512 && fh >= 512) {
    const hw = Math.floor(fw / 2), hh = Math.floor(fh / 2);
    const xm = bbox[0] + ((bbox[2] - bbox[0]) * hw) / fw;
    const ym = bbox[3] - ((bbox[3] - bbox[1]) * hh) / fh;
    const parts = [
      [[bbox[0], ym, xm, bbox[3]], 0, 0, hw, hh], [[xm, ym, bbox[2], bbox[3]], hw, 0, fw - hw, hh],
      [[bbox[0], bbox[1], xm, ym], 0, hh, hw, fh - hh], [[xm, bbox[1], bbox[2], ym], hw, hh, fw - hw, fh - hh],
    ];
    const out = new Uint8Array(fw * fh * 4);
    let ok = true;
    let lossless = true;
    for (const [box, ox, oy, pw, ph] of parts) {
      const part = await one(box, pw, ph);
      await sleep(PAUSE_MS);
      if (!part) { ok = false; break; }
      lossless = lossless && part.lossless;
      for (let y = 0; y < ph; y++) out.set(part.data.subarray(y * pw * 4, (y + 1) * pw * 4), ((oy + y) * fw + ox) * 4);
    }
    if (ok) exported = { data: out, width: fw, height: fh, lossless };
  }
  if (exported && coverage(exported.data, exported.width, exported.height) > 0.05) {
    return { ...exported, data: resizeRGBA(exported.data, fw, fh, w, h), width: w, height: h };
  }
  return fetchTiled(c, m, bbox, w, h, decoders);
}

/* --------------------------------------------------------------- R2 / D1 */

function r2Get(key, dir, decoders) {
  const file = join(dir, 'base.bin');
  for (let i = 1; i <= 3; i++) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      break;
    } catch { if (i === 3) return null; execFileSync('sleep', [String(i * 2)]); }
  }
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  if (b[0] === 0x89 && b[1] === 0x50) { const p = decoders.png.PNG.sync.read(b); return { data: p.data, width: p.width, height: p.height }; }
  if (b[0] === 0xff && b[1] === 0xd8) { const j = decoders.jpeg.decode(b, { useTArray: true }); return { data: j.data, width: j.width, height: j.height }; }
  return null;
}

function r2Put(key, png, dir) {
  const file = join(dir, 'county.png');
  writeFileSync(file, png);
  for (let i = 1; i <= 3; i++) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file,
        '--content-type', 'image/png', '--remote'], { stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch { if (i < 3) execFileSync('sleep', [String(i * 2)]); }
  }
  return false;
}

let dbId = null;
function exec(sql, { always = false } = {}) {
  if (DRY_RUN && !always) return;
  dbId = dbId || resolveDatabase(true);
  wrangler(['d1', 'execute', dbId, '--remote', '--command', sql.replace(/\s+/g, ' ').trim()]);
}

function ensureTable() {
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  const m = schema.match(/CREATE TABLE IF NOT EXISTS county_imagery \([\s\S]*?\n\);/);
  if (!m) throw new Error('county_imagery is not in worker/schema.sql');
  // Even on a dry run: an empty table is harmless, and the reads below join it.
  exec(m[0].replace(/--[^\n]*/g, ''), { always: true });
}

const countyKey = (id) => `maps/county/${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;

/* ----------------------------------------------------------------- align */

export function alignTo(base, img, frame) {
  const across = (frameBbox3857(frame)[2] - frameBbox3857(frame)[0]) * Math.cos((frame.lat * Math.PI) / 180);
  const cellM = Math.max(0.3, across / 320);
  const w = Math.max(64, Math.round(across / cellM));
  const h = Math.max(64, Math.round((w * base.height) / base.width));
  const maxShift = Math.max(3, Math.round(REACH_M / cellM));
  const fit = alignImages(greyGrid(base.data, base.width, base.height, w, h),
    greyGrid(img.data, img.width, img.height, w, h), w, h,
    { maxShift, scales: [0.98, 0.99, 0.995, 1, 1.005, 1.01, 1.02] });
  const atEdge = Math.abs(fit.dx) >= maxShift - 0.5 || Math.abs(fit.dy) >= maxShift - 0.5;
  return {
    east: fit.dx * cellM, north: -fit.dy * cellM, scale: fit.scale,
    fit: fit.ncc, fit0: fit.ncc0, moved: fit.moved, atEdge, cellM,
  };
}

/* ------------------------------------------------------------------ find */

export async function evaluate(c, base, frame, decoders) {
  const m = await meta(c.url);
  if (!m || m.failed) return { ...c, usable: false, why: `metadata: ${m?.failed || 'none'}` };
  const bbox = frameBbox3857(frame);
  /* A small look first: most candidates found by place are not over this
     frame at all (a catalogue box is loose), and that is cheap to learn. */
  const probe = await fetchOver(c, m, bbox, 128, Math.max(16, Math.round((128 * base.height) / base.width)), decoders);
  await sleep(PAUSE_MS);
  if (!probe) return { ...c, usable: false, why: 'no picture over this frame' };
  const probeCover = coverage(probe.data, probe.width, probe.height);
  if (probeCover < 0.9) return { ...c, usable: false, why: `covers ${(probeCover * 100).toFixed(0)}%`, cover: probeCover };
  const img = await fetchOver(c, m, bbox, base.width, base.height, decoders);
  await sleep(PAUSE_MS);
  if (!img) return { ...c, usable: false, why: 'no full picture over this frame' };
  const cover = coverage(img.data, img.width, img.height);
  const pixelCm = ((bbox[2] - bbox[0]) / img.width) * Math.cos((frame.lat * Math.PI) / 180) * 100;
  let native = nativeCm(m, frame.lat);
  /* Under 3 cm is a tile scheme talking, not a camera (New Jersey's "1 cm"). */
  if (native !== null && native < 3) native = null;
  if (img.tiled) native = Math.max(native ?? 0, img.tileCm * (img.merc ? Math.cos((frame.lat * Math.PI) / 180) : 1));
  if (img.lossless && c.type === 'MapServer') {
    const b = blockiness(img.data, img.width, img.height);
    if (b > 1.5) native = Math.max(native ?? 0, pixelCm * b);
    /* Not visibly enlarged at our grid: at least as fine as our grid. */
    else if (native === null) native = pixelCm;
  }
  const detail = c.type === 'ImageServer' && base.detail
    ? (extraDetail(img.data, img.width, img.height, 4)?.extra ?? 0) / base.detail.extra : null;
  const years = yearHints(`${c.title} ${c.url} ${m.description || ''} ${m.serviceDescription || ''} ${m.copyrightText || ''}`);
  const year = c.year ?? (years.length ? Math.max(...years) : null);
  const fine = native !== null && native > 0 ? native <= MAX_NATIVE_CM : (detail !== null && detail >= MIN_DETAIL);
  const recent = year === null || year >= MIN_YEAR;
  const usable = cover >= MIN_COVER && fine && recent;
  const why = usable ? 'usable'
    : cover < MIN_COVER ? `covers ${(cover * 100).toFixed(0)}%`
      : !fine ? `too coarse (${native ? `${Math.round(native)} cm` : `detail ${detail?.toFixed(2) ?? '?'}`})`
        : `flown ${year}`;
  return {
    ...c, year, usable, why, cover, nativeCm: native, detail,
    green: base.green ? greenShare(img.data, img.width, img.height) / base.green : null,
    img: usable ? img : null,
  };
}

async function findFor(row, decoders, dir) {
  const frame = JSON.parse(row.image_frame || row.frame);
  const base = r2Get(row.image_key, dir, decoders);
  if (!base) return { id: row.id, status: 'no banked photo' };
  base.detail = extraDetail(base.data, base.width, base.height, 4);
  base.green = greenShare(base.data, base.width, base.height);

  const found = [
    ...await countyCandidates(frame.lng, frame.lat),
    ...await agolCandidates(frame.lng, frame.lat),
  ];
  const ranked = rankCandidates(found);
  const tried = [];
  for (const c of ranked.slice(0, MAX_TRY)) {
    try { tried.push(await evaluate(c, base, frame, decoders)); } catch (e) {
      tried.push({ ...c, usable: false, why: `error: ${String(e.message || e).slice(0, 60)}` });
    }
    /* Ranked newest first, so the first usable one is the one; a couple more
       only in case a finer flight of the same year follows it. */
    if (tried.filter((t) => t.usable).length >= 2) break;
  }
  const best = chooseBest(tried);
  const candidates = JSON.stringify(tried.map((t) => ({
    url: t.url, via: t.via, year: t.year, why: t.why,
    cover: t.cover ? Math.round(t.cover * 100) / 100 : null,
    nativeCm: t.nativeCm ? Math.round(t.nativeCm) : null,
  })).concat(ranked.length > MAX_TRY ? [{ untried: ranked.length - MAX_TRY }] : []));

  if (!best) {
    exec(`INSERT INTO county_imagery (id, candidates, checked_at) VALUES (${lit(row.id)}, ${lit(candidates)}, ${lit(new Date().toISOString())})
          ON CONFLICT(id) DO UPDATE SET service = NULL, service_type = NULL, title = NULL, year = NULL,
            native_cm = NULL, image_key = NULL, candidates = excluded.candidates, checked_at = excluded.checked_at`);
    return { id: row.id, status: 'none usable', found: ranked.length,
      tried: tried.map((t) => `x ${t.title || t.url} (${t.why})`) };
  }

  /*
   * ONLY A CLEAR FIT MOVES THE PHOTO. A weak correlation, or one at the edge
   * of the search, is not evidence of an offset -- the first run "moved"
   * Massachusetts' false-colour layer 11 m on a fit of 0.14 -- so the photo is
   * banked as delivered and flagged for an eye on /county.html.
   */
  const found0 = alignTo(base, best.img, frame);
  const clear = found0.moved && !found0.atEdge && found0.fit >= MIN_FIT;
  const a = clear ? found0 : { ...found0, east: 0, north: 0, scale: 1, held: true };
  const banked = await bank(row, best, a, base, frame, decoders, dir);
  exec(`INSERT INTO county_imagery (id, service, service_type, title, year, native_cm, image_key, east, north,
          scale, fit, fit0, residual_m, detail, green, candidates, checked_at, banked_at)
        VALUES (${[row.id, best.url, best.type, best.title, best.year, round(best.nativeCm, 1), banked.key,
    round(a.east, 3), round(a.north, 3), a.scale, round(a.fit, 3), round(a.fit0, 3), round(banked.residual, 3),
    round(best.detail, 2), round(best.green, 2), candidates, new Date().toISOString(), banked.at].map(lit).join(', ')})
        ON CONFLICT(id) DO UPDATE SET
          review = CASE WHEN county_imagery.service IS excluded.service THEN county_imagery.review ELSE NULL END,
          review_east = 0, review_north = 0,
          service = excluded.service, service_type = excluded.service_type, title = excluded.title,
          year = excluded.year, native_cm = excluded.native_cm, image_key = excluded.image_key,
          east = excluded.east, north = excluded.north, scale = excluded.scale, fit = excluded.fit,
          fit0 = excluded.fit0, residual_m = excluded.residual_m, detail = excluded.detail,
          green = excluded.green, candidates = excluded.candidates, checked_at = excluded.checked_at,
          banked_at = excluded.banked_at`);
  return {
    id: row.id, status: 'banked', title: best.title, host: new URL(best.url).host, year: best.year,
    nativeCm: best.nativeCm, east: a.east, north: a.north, scale: a.scale, fit: a.fit, fit0: a.fit0,
    atEdge: a.atEdge, residual: banked.residual, found: ranked.length,
    held: Boolean(a.held), suggested: a.held ? { east: found0.east, north: found0.north } : null,
    tried: tried.map((t) => `${t.usable ? 'OK' : 'x'} ${t.title || t.url} (${t.why})`),
  };
}

const round = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Fetch the chosen service over the inverse-shifted box, check, bank. */
async function bank(row, c, a, base, frame, decoders, dir) {
  const m = await meta(c.url);
  const box = shiftedBbox(frameBbox3857(frame), a.east, a.north, a.scale, frame.lat);
  const img = await fetchOver(c, m, box, base.width, base.height, decoders);
  if (!img) return { key: null, residual: null, at: null };
  const check = alignTo(base, img, frame);
  const residual = Math.hypot(check.east, check.north);
  if (DRY_RUN) return { key: null, residual, at: null };
  const { PNG } = decoders.png;
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  const key = countyKey(row.id);
  if (!r2Put(key, PNG.sync.write(png), dir)) return { key: null, residual, at: null };
  return { key, residual, at: new Date().toISOString() };
}

/* ---------------------------------------------------------------- rebank */

async function rebank(row, decoders, dir) {
  const frame = JSON.parse(row.image_frame || row.frame);
  const base = r2Get(row.image_key, dir, decoders);
  if (!base) return { id: row.id, status: 'no banked photo' };
  const a = {
    east: Number(row.east) + Number(row.review_east), north: Number(row.north) + Number(row.review_north),
    scale: Number(row.scale) || 1,
  };
  const c = { url: row.service, type: row.service_type };
  const banked = await bank(row, c, a, base, frame, decoders, dir);
  if (!banked.key && !DRY_RUN) return { id: row.id, status: 'could not re-bank' };
  exec(`UPDATE county_imagery SET east = ${lit(round(a.east, 3))}, north = ${lit(round(a.north, 3))},
          review_east = 0, review_north = 0, residual_m = ${lit(round(banked.residual, 3))},
          banked_at = ${lit(banked.at)} WHERE id = ${lit(row.id)}`);
  return { id: row.id, status: 'rebanked', east: a.east, north: a.north, residual: banked.residual };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const decoders = { png: await import('pngjs'), jpeg: (await import('jpeg-js')).default };
  const dir = mkdtempSync(join(tmpdir(), 'county-'));
  ensureTable();

  if (MODE === 'rebank') {
    const rows = query(`SELECT ci.*, c.frame, c.image_frame, c.image_key AS mapbox_key
                          FROM county_imagery ci JOIN corpus c ON c.id = ci.id
                         WHERE ci.service IS NOT NULL AND (ci.review_east != 0 OR ci.review_north != 0)`);
    console.log(`${rows.length} nudged on /county.html to re-bank.`);
    for (const r of rows) {
      const out = await rebank({ ...r, image_key: r.mapbox_key }, decoders, dir);
      console.log(JSON.stringify(out));
    }
    return;
  }

  const rows = query(`SELECT c.id, c.county, c.status, c.frame, c.image_frame, c.image_key, ci.checked_at
                        FROM corpus c LEFT JOIN county_imagery ci ON ci.id = c.id
                       WHERE c.status IN ('approved', 'new', 'rejected') AND c.image_key IS NOT NULL
                         AND c.frame IS NOT NULL ${ONLY ? `AND c.id = ${lit(ONLY)}` : ''}
                       ORDER BY c.at DESC LIMIT ${Math.max(1, LIMIT)}`);
  const todo = rows.filter((r) => FORCE || ONLY || !r.checked_at);
  console.log(`${rows.length} corpus maps with a banked photo; ${todo.length} to look at`
    + `${FORCE ? ' (FORCE: all again)' : ''}${DRY_RUN ? ' -- DRY RUN, nothing written' : ''}.`);

  const results = [];
  for (const [n, row] of todo.entries()) {
    let out;
    try { out = await findFor(row, decoders, dir); } catch (e) {
      out = { id: row.id, status: `error: ${String(e.message || e).slice(0, 80)}` };
    }
    results.push({ ...out, county: row.county, corpusStatus: row.status });
    const say = out.status === 'banked'
      ? `${out.host} "${out.title}" ${out.year ?? '?'}, ${out.nativeCm ? Math.round(out.nativeCm) : '?'} cm; `
        + `moved ${out.east.toFixed(2)} m E ${out.north.toFixed(2)} m N x${out.scale}, fit ${out.fit.toFixed(2)} `
        + `(was ${out.fit0.toFixed(2)})${out.atEdge ? ' AT EDGE' : ''}; residual ${out.residual?.toFixed(2) ?? '?'} m`
      : `${out.status}${out.found !== undefined ? ` (${out.found} candidate${out.found === 1 ? '' : 's'}, ${out.tried?.length ?? 0} tried)` : ''}`;
    console.log(`${n + 1}/${todo.length} ${row.county || '?'} ${row.id.slice(0, 40)}: ${say}`
      + `${out.held ? ` -- FIT NOT CLEAR, banked as delivered (it suggested ${out.suggested.east.toFixed(1)} m E, ${out.suggested.north.toFixed(1)} m N)` : ''}`);
    for (const t of out.tried || []) console.log(`      ${t.slice(0, 160)}`);
  }
  writeFileSync('county-imagery.json', JSON.stringify(results, null, 2));

  /* THE PART WORTH READING. */
  const banked = results.filter((r) => r.status === 'banked');
  const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const doubtful = banked.filter((r) => r.held || r.atEdge || r.fit < MIN_FIT || (r.residual ?? 9) > 0.3);
  console.log('\n================ COUNTY IMAGERY ================');
  console.log(`Looked at ${results.length} maps: ${banked.length} with usable county or state imagery, banked;`
    + ` ${results.filter((r) => r.status === 'none usable').length} with none usable;`
    + ` ${results.filter((r) => !['banked', 'none usable'].includes(r.status)).length} could not be checked.`);
  if (banked.length) {
    console.log(`Median native ${Math.round(med(banked.map((r) => r.nativeCm)))} cm;`
      + ` median offset from Mapbox ${med(banked.map((r) => Math.hypot(r.east, r.north))).toFixed(2)} m;`
      + ` median residual after banking ${med(banked.map((r) => r.residual))?.toFixed(2)} m.`);
    const hosts = {};
    for (const r of banked) hosts[r.host] = (hosts[r.host] || 0) + 1;
    console.log(`Sources: ${Object.entries(hosts).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(', ')}`);
  }
  console.log(`To check by eye on /county.html: ${doubtful.length} doubtful (no clear fit, so banked as`
    + ' delivered; or a residual over 0.3 m) -- and every other one is worth a look too.');
  console.log('Per-map results: the county-imagery artifact.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
