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
 * PUT ON MAPBOX'S GROUND BEFORE IT IS BANKED. Every outline in the corpus was
 * traced on Mapbox, the property lines were drawn over Mapbox while it was
 * traced, and the detector runs on Mapbox -- so Mapbox's ground is the one
 * every photo is put on, and then a property line lands on the same kerb in
 * every photo. lib/register.js measures where Mapbox's ground is in the
 * county photo patch by patch, ON THE GROUND (roofs and trees lean
 * differently in every photo and are outvoted), and fits one map to it. The
 * county photo is fetched with a margin and resampled through that map onto
 * the banked Mapbox photo's own pixel grid, then measured again against it
 * (residual_m, near zero when it worked).
 *
 * The first version of this (owner, 2026-10-01: "consistently off, both
 * positionally and perspective") scored one shift on every edge in the frame
 * at 30 cm cells -- pulled toward the roofs -- and banked anything without a
 * clear fit as delivered. A photo the measurement is not sure of is still
 * banked as delivered, and says so (reg_confident 0); /county.html shows
 * those first, and a nudge made there is applied by MODE=rebank.
 *
 * MODE=realign does the lining-up again for every banked map without looking
 * for imagery again: the service is in the row.
 *
 * SLOW AND CAREFUL. One lot at a time, a pause between requests, retries,
 * and a row written for every lot looked at -- found or not -- so a run that
 * stops part-way resumes where it left off (FORCE=1 to look again).
 *
 *   MODE=find|realign|rebank|catalogue LIMIT=… FORCE=1 DRY_RUN=1 ONLY=<corpus id> node tools/county-imagery.js
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
  IMAGERY,
} from './compare-imagery.js';
import { registerImages, applyAffine } from '../public/lib/register.js';
import { looksLikePhoto } from '../worker/src/png-probe.js';
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
/* The offset search reaches 15 m: H62's medians were about 1 m, the worst
   few metres, and the old search's "suggestions" up to 13. */
const REACH_M = 15;
/* A banked photo re-measured further than this from Mapbox did not land. */
const MAX_RESIDUAL_M = 0.1;

const R = 20037508.342789244;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ pure parts */

/** Search ArcGIS Online's public catalogue near a point (the query only). */
export function agolSearchUrl(lng, lat, start = 1) {
  const d = 0.001;
  const q = '(title:ortho OR title:orthos OR title:orthoimagery OR title:orthophoto OR '
    + 'title:orthophotos OR title:aerial OR title:aerials OR title:imagery OR '
    + 'title:nearmap OR title:eagleview OR title:pictometry OR '
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
export const NOT_A_PHOTO = /\bcir\b|infra.?red|\bnir\b|ndvi|false.?colou?r|color.?infrared|index|footprint|boundar|tile.?scheme|flight|\blidar|\bdem\b|hillshade|elevation|contour|parcel|topo|labels?\b|reference|\bbw\d*\b|bw\d{4}|black.?(and|&|n).?white|grayscale|greyscale|panchromatic|historic|\bnaip|habitat|land.?cover|land.?use|classif/i;

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
  let clear = 0, white = 0, black = 0, n = 0;
  for (let i = 0; i < w * h; i += 5) {
    n++;
    const [r, g, b, a] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
    if (a < 250) clear++;
    else if (r === 255 && g === 255 && b === 255) white++;
    else if (r === 0 && g === 0 && b === 0) black++;
  }
  if (!n) return 0;
  /*
   * Transparent is always missing. Exactly white or black is a no-data fill
   * only in bulk: a sunlit driveway saturates to pure white too (2% of
   * Ingham County's 2025 frame, which was turned away for it), while a
   * missing corner is a large block.
   */
  const bulk = (k) => (k / n > 0.04 ? k : 0);
  return 1 - (clear + bulk(white) + bulk(black)) / n;
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

/*
 * ARCGIS ONLINE BY THE COUNTY'S NAME, WEB MAPS AND APPS INCLUDED (owner,
 * 2026-10-02: "search through arcgis"). agolCandidates asks for services
 * whose own extent covers one point, and that misses imagery published only
 * INSIDE a web map or an app -- Blaine County's 2026 Nearmap was found
 * through a county Experience Builder app, not as a listed service. So, once
 * per county: items naming the county and imagery, within the county's box,
 * services taken as they are and web maps and apps opened for the layers they
 * draw. Every layer still has to pass qualify() at a point.
 */
const NAME_TERMS = '(imagery OR aerial OR aerials OR ortho OR orthos OR orthoimagery OR orthophoto OR orthophotos '
  + 'OR nearmap OR eagleview OR pictometry OR basemap)';
const NAME_TYPES = '(type:"Web Map" OR type:"Image Service" OR type:"Map Service" '
  + 'OR type:"Web Mapping Application" OR type:"Web Experience" OR type:"Dashboard")';

/** "Mono County, CA" -> 'Mono County'; null for a statewide entry. */
export const countyWords = (entry) => (entry?.statewide || !entry?.name ? null
  : String(entry.name).split(',')[0].trim() || null);

export function agolNameSearchUrl(entry, start = 1) {
  const words = countyWords(entry);
  if (!words || !Array.isArray(entry.box)) return null;
  return 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
    q: `"${words}" AND ${NAME_TERMS} AND ${NAME_TYPES}`,
    bbox: entry.box.join(','), f: 'json', num: '100', start: String(start),
  });
}

/** Every MapServer / ImageServer a web map draws, with its title. */
export function webMapLayers(data) {
  const out = [];
  const walk = (layers) => {
    for (const l of layers || []) {
      const m = String(l?.url || '').match(/^(https?:\/\/.+\/(?:ImageServer|MapServer))(?:\/\d+)?\/?$/i);
      if (m) out.push({ url: m[1], type: /ImageServer$/i.test(m[1]) ? 'ImageServer' : 'MapServer', title: l.title || '' });
      walk(l?.layers);
    }
  };
  walk(data?.operationalLayers);
  walk(data?.baseMap?.baseMapLayers);
  return out;
}

/** The 32-hex item ids an app's configuration mentions (its web maps among them). */
export const itemIdsIn = (json) => [...new Set((JSON.stringify(json || {}).match(/\b[0-9a-f]{32}\b/g) || []))];

const nameCache = new Map();
export async function agolByName(key, entry = ALL_COUNTIES[key]) {
  if (nameCache.has(key)) return nameCache.get(key);
  const out = [];
  const seenMaps = new Set();
  const hosts = []; // servers seen in web maps, browsed below even when the layer was not imagery
  const item = (id) => `https://www.arcgis.com/sharing/rest/content/items/${id}`;
  const fromWebMap = async (id) => {
    if (seenMaps.has(id) || seenMaps.size >= 25) return;
    seenMaps.add(id);
    /* Only the layers named like imagery: a web map also draws roads,
       addresses and flood zones, and each would cost a look. Their servers
       are still browsed whole below, through the same imagery filter. */
    try {
      for (const c of webMapLayers(await getJson(`${item(id)}/data?f=json`))) {
        if (IMAGERY.test(`${c.title} ${c.url}`)) out.push({ ...c, via: 'ArcGIS Online web map' });
        else hosts.push(c.url);
      }
    } catch { /* unreadable */ }
  };
  let start = 1;
  for (let page = 0; page < 3 && start > 0; page++) {
    const url = agolNameSearchUrl(entry, start);
    if (!url) break;
    let j;
    try { j = await getJson(url); } catch { break; }
    for (const r of j.results || []) {
      if (r.type === 'Image Service' || r.type === 'Map Service') {
        const m = String(r.url || '').match(/^(https?:\/\/.+\/(?:ImageServer|MapServer))\/?$/i);
        if (m) out.push({ url: m[1], type: /ImageServer$/i.test(m[1]) ? 'ImageServer' : 'MapServer', title: r.title || '', via: 'ArcGIS Online by name' });
      } else if (r.type === 'Web Map') {
        await fromWebMap(r.id);
      } else {
        /* An app: the web maps its configuration names. */
        try {
          const data = await getJson(`${item(r.id)}/data?f=json`);
          for (const id of itemIdsIn(data).slice(0, 8)) {
            let info;
            try { info = await getJson(`${item(id)}?f=json`); } catch { continue; }
            if (info?.type === 'Web Map') await fromWebMap(id);
          }
        } catch { /* unreadable */ }
      }
      await sleep(PAUSE_MS);
    }
    start = j.nextStart > 0 ? j.nextStart : 0;
  }
  /*
   * AND EVERY SERVER THOSE CAME FROM, browsed whole, as the county's own
   * parcel server already is (countyCandidates): a search names one layer,
   * and the same server often holds a newer flight nobody tagged -- the way
   * Blaine's held its 2026 Nearmap. A handful of servers per county at most.
   */
  /* Esri's world imagery and ArcGIS Online's proxy are not a county's: the
     first is the app's own Esri source, the second a key-holding relay. */
  const notCounty = (u) => /\/\/(services|server)\.arcgisonline\.com\/|\/\/(utility|tiledbasemaps|basemaps)\.arcgis\.com\/|\/\/hazards\.fema\.gov\//i.test(u);
  for (let i = out.length - 1; i >= 0; i--) if (notCounty(out[i].url)) out.splice(i, 1);
  const roots = [...new Set([...out.map((c) => c.url), ...hosts].filter((u) => !notCounty(u))
    .map(catalogueRoot).filter(Boolean))].slice(0, 6);
  for (const root of roots.flatMap(siblingRoots)) {
    if (!catalogueCache.has(root)) {
      catalogueCache.set(root, await listCatalogue(root).then(pickImagery).catch(() => []));
    }
    for (const sv of catalogueCache.get(root)) {
      out.push({ url: `${sv.root}/${sv.name}/${sv.type}`, type: sv.type, title: sv.name, via: 'server found by name' });
    }
  }
  nameCache.set(key, out);
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
/**
 * A coordinate system as proj4 can read it: from its EPSG code (epsg.io), or
 * -- when a service gives none, only the WKT text, as Kent County MI's
 * Orthos2020 does -- the WKT itself, which proj4 parses. Without the second,
 * Kent's extent came back null and its county photo never reached the
 * catalogue (owner, 2026-10-02).
 */
const defCache = new Map();
export async function projDef(sr) {
  const wkid = sr?.latestWkid || sr?.wkid;
  const key = wkid ? `epsg:${wkid}` : sr?.wkt ? `wkt:${sr.wkt}` : null;
  if (!key) return null;
  if (!defCache.has(key)) {
    defCache.set(key, (async () => {
      if (!wkid) return sr.wkt;
      try {
        const def = (await (await fetch(`https://epsg.io/${wkid}.proj4`, { signal: AbortSignal.timeout(TIMEOUT_MS) })).text()).trim();
        return def.startsWith('+proj') ? def : (sr.wkt || null);
      } catch { return sr.wkt || null; }
    })());
  }
  return defCache.get(key);
}

/** Feet or metres, from either kind of definition. */
const unitsToMetres = (def) => (/\+units=us-ft|Foot_US|US survey foot/i.test(def) ? 1200 / 3937
  : /\+units=ft|UNIT\["Foot",0\.3048\]|"Foot"|International Foot/i.test(def) ? 0.3048 : 1);

const projCache = new Map();
async function projectionFor(m) {
  const def = await projDef(m?.spatialReference);
  if (!def) return null;
  if (!projCache.has(def)) {
    projCache.set(def, (async () => {
      try {
        const proj4 = (await import('proj4')).default;
        const fwd = proj4('EPSG:3857', def);
        return { forward: (x, y) => fwd.forward([x, y]), toMetres: unitsToMetres(def) };
      } catch { return null; }
    })());
  }
  return projCache.get(def);
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
  /* The box in the service's own coordinates: its four corners, projected. */
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
    .map(([x, y]) => proj.forward(x, y));
  const sx0 = Math.min(...corners.map((p) => p[0])), sx1 = Math.max(...corners.map((p) => p[0]));
  const sy0 = Math.min(...corners.map((p) => p[1])), sy1 = Math.max(...corners.map((p) => p[1]));
  /*
   * THE FINEST LEVEL THE CACHE ACTUALLY HOLDS. Massachusetts' 2025 and Ingham
   * County's 2025 caches list levels down to 1.9 cm and hold tiles only to a
   * coarser one, so the level asked for answered nothing at full size while a
   * 128 px look (a coarse level) worked. The centre tile is tried at the level
   * wanted and then coarser, and the first that answers is used -- which also
   * makes that level the honest native resolution.
   */
  const byRes = lods.slice().sort((a, b) => a.resolution - b.resolution);
  let at = byRes.findIndex((l) => l.resolution >= want * 0.999);
  if (at < 0) at = byRes.length - 1;
  else if (byRes[at].resolution > want * 1.001 && at > 0) at -= 1;
  const midX = (sx0 + sx1) / 2, midY = (sy0 + sy1) / 2;
  let lod = null;
  for (let k = at; k < byRes.length && k < at + 8; k++) {
    const l = byRes[k];
    const sp = l.resolution * size;
    const t = await getImage(`${c.url}/tile/${l.level}/${Math.floor((oy - midY) / sp)}/${Math.floor((midX - ox) / sp)}`, decoders);
    await sleep(60);
    if (t) { lod = l; break; }
  }
  if (!lod) return null;
  const res = lod.resolution;
  const span = res * size;
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
  /* And the columns added since it first shipped, as migrations.sql adds
     them: this can run before the deploy that would. One that exists fails,
     which is the "already there" answer. */
  const mig = readFileSync(new URL('../worker/migrations.sql', import.meta.url), 'utf8');
  for (const alter of mig.match(/ALTER TABLE county_imagery ADD COLUMN [^;]+;/g) || []) {
    try { exec(alter, { always: true }); } catch { /* already there */ }
  }
}

const countyKey = (id) => `maps/county/${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;

/* ----------------------------------------------------------------- align */

/** Ground metres across a frame. */
export const frameGroundM = (frame) => {
  const box = frameBbox3857(frame);
  return (box[2] - box[0]) * Math.cos((frame.lat * Math.PI) / 180);
};

/**
 * Where the banked Mapbox photo's ground is in `img`, a picture of the same
 * frame at the same size. A: Mapbox pixel -> img pixel. east/north: how far
 * the county photo has Mapbox's centre, in metres (east positive).
 */
export function alignTo(base, img, frame) {
  const r = registerImages(base, img, frameGroundM(frame), { reachM: REACH_M });
  return { ...r, east: r.offsetM?.east ?? 0, north: r.offsetM?.north ?? 0 };
}

/**
 * The picture Mapbox's pixel grid would show of `src`, which covers the frame
 * plus `padX`/`padY` pixels each side: out(p) = src(A(p) + pad), bilinear.
 */
export function resampleThrough(src, A, W, H, padX, padY) {
  const out = new Uint8Array(W * H * 4);
  const sw = src.width, sh = src.height, d = src.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [u0, v0] = applyAffine(A, [x + 0.5, y + 0.5]);
      const u = u0 + padX - 0.5, v = v0 + padY - 0.5;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) continue; // stays transparent
      const fx = u - x0, fy = v - y0;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const i = (y0 * sw + x0) * 4 + c;
        const top = d[i] * (1 - fx) + d[i + 4] * fx;
        const bot = d[i + sw * 4] * (1 - fx) + d[i + sw * 4 + 4] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { data: out, width: W, height: H };
}

/** How far outside the frame A reaches, in source pixels, each way. */
export function padFor(A, W, H) {
  let px = 0, py = 0;
  for (const p of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const [u, v] = applyAffine(A, p);
    px = Math.max(px, -u, u - W);
    py = Math.max(py, -v, v - H);
  }
  return [Math.ceil(Math.max(0, px)) + 4, Math.ceil(Math.max(0, py)) + 4];
}

/** A nudge of the county photo by east/north metres, folded into A. */
export function nudged(A, east, north, metresPerPx) {
  const ex = east / metresPerPx, ny = -north / metresPerPx;
  /* The photo moved by e shows at p what it showed at p - e. */
  return [A[0], A[1], A[2] - (A[0] * ex + A[1] * ny), A[3], A[4], A[5] - (A[3] * ex + A[4] * ny)];
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

  const placed = await place(row, best, base, frame, decoders, dir);
  exec(`INSERT INTO county_imagery (id, service, service_type, title, year, native_cm, detail, green,
          candidates, checked_at)
        VALUES (${[row.id, best.url, best.type, best.title, best.year, round(best.nativeCm, 1),
    round(best.detail, 2), round(best.green, 2), candidates, new Date().toISOString()].map(lit).join(', ')})
        ON CONFLICT(id) DO UPDATE SET
          review = CASE WHEN county_imagery.service IS excluded.service THEN county_imagery.review ELSE NULL END,
          service = excluded.service, service_type = excluded.service_type, title = excluded.title,
          year = excluded.year, native_cm = excluded.native_cm, detail = excluded.detail,
          green = excluded.green, candidates = excluded.candidates, checked_at = excluded.checked_at`);
  writePlacement(row.id, placed, { resetNudge: true });
  return {
    id: row.id, status: 'banked', title: best.title, host: new URL(best.url).host, year: best.year,
    nativeCm: best.nativeCm, found: ranked.length, ...summaryOf(placed),
    tried: tried.map((t) => `${t.usable ? 'OK' : 'x'} ${t.title || t.url} (${t.why})`),
  };
}

const round = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Measure, move, bank, measure again.
 *
 * `img` is the service's picture of the frame (fetched if not given); `extra`
 * is a person's nudge in metres, applied on top of the measurement.
 */
export async function place(row, c, base, frame, decoders, dir, { img = null, extra = null } = {}) {
  const m = await meta(c.url);
  const W = base.width, H = base.height;
  const box = frameBbox3857(frame);
  const look = img || c.img || await fetchOver(c, m, box, W, H, decoders);
  if (!look) return { key: null, why: 'no picture over this frame' };
  const reg = alignTo(base, look, frame);
  const metresPerPx = frameGroundM(frame) / W;
  /* A photo the measurement is not sure of is banked as delivered. */
  let A = reg.confident ? reg.A : [1, 0, 0, 0, 1, 0];
  if (extra && (extra.east || extra.north)) A = nudged(A, extra.east, extra.north, metresPerPx);
  const moved = A.some((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0][i]) > 1e-9);
  let out = look;
  if (moved) {
    const [padX, padY] = padFor(A, W, H);
    const kx = (box[2] - box[0]) / W, ky = (box[3] - box[1]) / H;
    const wide = [box[0] - padX * kx, box[1] - padY * ky, box[2] + padX * kx, box[3] + padY * ky];
    const big = await fetchOver(c, m, wide, W + 2 * padX, H + 2 * padY, decoders);
    if (!big) return { key: null, why: 'no picture over the widened frame', reg };
    out = resampleThrough(big, A, W, H, padX, padY);
  }
  /* Measured again: where is Mapbox's ground in what is about to be banked? */
  const check = alignTo(base, out, frame);
  const residual = check.confident ? Math.hypot(check.east, check.north) : null;
  const placed = { reg, A, moved, check, residual, nudge: extra, key: null, at: null, picture: out };
  if (DRY_RUN) return placed;
  const { PNG } = decoders.png;
  const png = new PNG({ width: out.width, height: out.height });
  png.data = Buffer.from(out.data);
  const key = countyKey(row.id);
  if (!r2Put(key, PNG.sync.write(png), dir)) return { ...placed, why: 'could not write to the bucket' };
  return { ...placed, key, at: new Date().toISOString() };
}

/** What the log and the artifact say about a placement. */
function summaryOf(p) {
  const r = p.reg || {};
  return {
    confident: Boolean(r.confident), why: r.why, model: r.model, inliers: r.inliers, patches: r.patches,
    rmsM: r.rmsM, east: r.east ?? 0, north: r.north ?? 0, moved: Boolean(p.moved),
    residual: p.residual, landed: p.residual !== null && p.residual !== undefined && p.residual <= MAX_RESIDUAL_M,
  };
}

/* A new picture unsettles a "lines up": that was said of the old one. A
   "don't use" stands -- it is usually about the photo itself (its year, its
   season), which lining up does not change. */
function writePlacement(id, p, { resetNudge = false, keepVerdict = false } = {}) {
  const r = p.reg || {};
  exec(`UPDATE county_imagery SET image_key = ${lit(p.key)}, banked_at = ${lit(p.at)},
          east = ${lit(round(r.east, 3))}, north = ${lit(round(r.north, 3))},
          scale = ${lit(p.A ? round(Math.sqrt(Math.abs(p.A[0] * p.A[4] - p.A[1] * p.A[3])), 5) : null)},
          fit = NULL, fit0 = NULL, residual_m = ${lit(round(p.residual, 3))},
          reg_model = ${lit(r.model || null)}, reg_affine = ${lit(p.A ? JSON.stringify(p.A.map((v) => round(v, 6))) : null)},
          reg_inliers = ${lit(r.inliers ?? null)}, reg_patches = ${lit(r.patches ?? null)},
          reg_rms_m = ${lit(round(r.rmsM, 3))}, reg_confident = ${r.confident ? 1 : 0},
          reg_why = ${lit(r.why || p.why || null)}
          ${resetNudge ? ', review_east = 0, review_north = 0' : ''}
          ${keepVerdict ? '' : ", review = CASE WHEN review = 'ok' THEN NULL ELSE review END"}
        WHERE id = ${lit(id)}`);
}

/* ---------------------------------------------------------------- rebank */

/** A person's nudge from /county.html, on top of a fresh measurement. */
async function rebank(row, decoders, dir) {
  const frame = JSON.parse(row.image_frame || row.frame);
  const base = r2Get(row.image_key, dir, decoders);
  if (!base) return { id: row.id, status: 'no banked photo' };
  const c = { url: row.service, type: row.service_type };
  const extra = { east: Number(row.review_east) || 0, north: Number(row.review_north) || 0 };
  /* The nudge was made against the photo as it was banked, so it goes on top
     of the map that banked it, not a new measurement. */
  const prior = row.reg_affine ? JSON.parse(row.reg_affine) : [1, 0, 0, 0, 1, 0];
  const placed = await placeWith(row, c, base, frame, decoders, dir, nudged(prior, extra.east, extra.north, frameGroundM(frame) / base.width));
  if (!placed.key && !DRY_RUN) return { id: row.id, status: `could not re-bank: ${placed.why || '?'}` };
  writePlacement(row.id, { ...placed, reg: { ...(placed.reg || {}), confident: true, why: 'nudged by a person' } },
    { resetNudge: true, keepVerdict: true });
  return { id: row.id, status: 'rebanked', ...summaryOf(placed) };
}

/** Bank through a given map, no measuring first. */
async function placeWith(row, c, base, frame, decoders, dir, A) {
  const m = await meta(c.url);
  const W = base.width, H = base.height;
  const box = frameBbox3857(frame);
  const [padX, padY] = padFor(A, W, H);
  const kx = (box[2] - box[0]) / W, ky = (box[3] - box[1]) / H;
  const big = await fetchOver(c, m, [box[0] - padX * kx, box[1] - padY * ky, box[2] + padX * kx, box[3] + padY * ky],
    W + 2 * padX, H + 2 * padY, decoders);
  if (!big) return { key: null, why: 'no picture over the widened frame' };
  const out = resampleThrough(big, A, W, H, padX, padY);
  const check = alignTo(base, out, frame);
  const residual = check.confident ? Math.hypot(check.east, check.north) : null;
  const placed = { reg: { model: 'nudged', inliers: check.inliers, patches: check.patches, rmsM: check.rmsM, east: 0, north: 0 }, A, moved: true, check, residual, key: null, at: null };
  if (DRY_RUN) return placed;
  const { PNG } = decoders.png;
  const png = new PNG({ width: out.width, height: out.height });
  png.data = Buffer.from(out.data);
  const key = countyKey(row.id);
  if (!r2Put(key, PNG.sync.write(png), dir)) return { ...placed, why: 'could not write to the bucket' };
  return { ...placed, key, at: new Date().toISOString() };
}

/** Line up again every banked map, from its own service: no searching. */
async function realign(row, decoders, dir) {
  const frame = JSON.parse(row.image_frame || row.frame);
  const base = r2Get(row.image_key, dir, decoders);
  if (!base) return { id: row.id, status: 'no banked photo' };
  const c = { url: row.service, type: row.service_type };
  const placed = await place(row, c, base, frame, decoders, dir);
  if (!placed.key && !DRY_RUN) return { id: row.id, status: `could not re-bank: ${placed.why || '?'}` };
  writePlacement(row.id, placed, { resetNudge: true });
  return { id: row.id, status: 'banked', title: row.title, host: new URL(row.service).host, year: row.year,
    nativeCm: row.native_cm, ...summaryOf(placed) };
}

/* ------------------------------------------------------------- catalogue */
/*
 * COUNTY PHOTOS FOR ANY ADDRESS (owner, 2026-10-01: "make the county maps
 * available for any location that has them, and have them be the default").
 *
 * The app cannot spend minutes searching while somebody waits, so the search
 * is done here, ahead of time, and kept in county_services: every service
 * that qualified -- a photo, flown 2012 or later, 25 cm or finer -- with the
 * box it covers in longitude and latitude, the biggest picture it will draw,
 * and whether it draws an arbitrary box at all (export_ok). The Worker looks
 * a point up in that table (worker/src/county.js) and the editor checks the
 * picture it gets for gaps before using it.
 *
 * Two sources: the services the corpus pass already banked from, and a sweep
 * of every county the app covers -- at the centre of its parcel layer, or on
 * a grid across a statewide one -- with the same two ways of finding
 * candidates as the corpus pass. Resumable: county_sweep records every point
 * looked at; FORCE looks again.
 */

const SWEEP_STEP = Number(process.env.SWEEP_STEP || 0.5); // degrees, statewide grids
const ONLY_KEY = process.env.ONLY_KEY || '';
const RETRY_BEFORE = '2026-10-02T02:20:00Z';
/* Every point looked at before layers named after the vendor counted as
   imagery (commit 5b7e827, 02:01 UTC) is looked at again, services found or
   not (owner, 2026-10-02: the cleanup after the first full sweep). The first
   pass, AK to IL, ran on the older code: a county there with a 2018 ortho
   found could still have a "2026_Nearmap" it never recognised. */
const VENDOR_SINCE = '2026-10-02T02:01:00Z';

/** A service's extent as [west, south, east, north] in degrees. */
export async function extentLngLat(m) {
  const ext = m?.fullExtent || m?.extent || m?.initialExtent;
  if (!ext || !Number.isFinite(Number(ext.xmin))) return null;
  const sr = (ext.spatialReference?.wkid || ext.spatialReference?.latestWkid || ext.spatialReference?.wkt)
    ? ext.spatialReference : m.spatialReference;
  const wkid = sr?.latestWkid || sr?.wkid;
  const pts = [];
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
    pts.push([ext.xmin + (ext.xmax - ext.xmin) * fx, ext.ymin + (ext.ymax - ext.ymin) * fy]);
  }
  let ll;
  if (wkid === 4326 || wkid === 4269) ll = pts;
  else if ([3857, 102100, 900913].includes(wkid)) {
    ll = pts.map(([x, y]) => [(x / 6378137) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI)]);
  } else {
    try {
      const def = await projDef(sr);
      if (!def) return null;
      const proj4 = (await import('proj4')).default;
      const inv = proj4(def, 'EPSG:4326');
      ll = pts.map((p) => inv.forward(p));
    } catch { return null; }
  }
  const xs = ll.map((p) => p[0]), ys = ll.map((p) => p[1]);
  if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Is this candidate one the app can use at (lng, lat)? Cheap: its metadata
 * and one small picture of 150 m about the point. Returns the catalogue row,
 * or { usable: false, why }.
 */
export async function qualify(c, lng, lat, decoders, { again = true } = {}) {
  const q = await qualifyAt(c, lng, lat, decoders);
  /*
   * NOT HERE IS NOT NOWHERE. A vendor flight often covers the towns, not the
   * whole county: Blaine County's 2026 Nearmap is the Wood River Valley, and
   * the sweep's point (the middle of the county's parcel layer) is open
   * country south of it (2026-10-02). So a service with nothing at the
   * sweep's point is looked at once more at the middle of its own box; the
   * Worker looks at each address's own spot before offering it anyway.
   */
  if (!q.usable && again && q.why === 'no picture here') {
    const ext = await extentLngLat(await meta(c.url)).catch(() => null);
    if (ext) {
      const mid = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
      if (Math.hypot(mid[0] - lng, mid[1] - lat) > 0.01) return qualifyAt(c, mid[0], mid[1], decoders);
    }
  }
  return q;
}

async function qualifyAt(c, lng, lat, decoders) {
  const m = await meta(c.url);
  if (!m || m.failed) return { usable: false, why: `metadata: ${m?.failed || 'none'}` };
  const years = yearHints(`${c.title} ${c.url} ${m.description || ''} ${m.serviceDescription || ''} ${m.copyrightText || ''}`);
  const year = c.year ?? (years.length ? Math.max(...years) : null);
  if (year !== null && year < MIN_YEAR) return { usable: false, why: `flown ${year}` };
  let native = nativeCm(m, lat);
  if (native !== null && native < 3) native = null;
  const [x, y] = [lng * (Math.PI / 180) * 6378137, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 6378137];
  const half = 75 / Math.cos((lat * Math.PI) / 180);
  const box = [x - half, y - half, x + half, y + half];
  const img = await getImage(exportUrl(c, box, 256, 256), decoders).catch(() => null);
  /* A flat picture is a classification or a fill, not a photo: New
     Hampshire's habitat layer drew a uniform grey (2026-10-02). */
  if (img && img.width === 256 && img.height === 256 && !looksLikePhoto(img)
    && coverage(img.data, 256, 256) >= 0.9) return { usable: false, why: 'flat, not a photo' };
  const exportOk = Boolean(img && img.width === 256 && img.height === 256 && coverage(img.data, 256, 256) >= 0.9);
  let tiled = null;
  if (!exportOk) {
    tiled = await fetchOver(c, m, box, 256, 256, decoders).catch(() => null);
    if (!tiled || coverage(tiled.data, 256, 256) < 0.9) return { usable: false, why: 'no picture here' };
    /* How fine it really is: a 256 px look over 150 m reads a coarse level
       (Blaine County's 2026 Nearmap came out "43 cm"), so look again over
       40 m at 8 cm; the cache steps coarser by itself where the fine levels
       are missing, so the level that answers is the real one. */
    if (tiled.tiled) {
      const h2 = 20 / Math.cos((lat * Math.PI) / 180);
      const fine = await fetchOver(c, m, [x - h2, y - h2, x + h2, y + h2], 512, 512, decoders).catch(() => null);
      const t = fine?.tiled ? fine : tiled;
      native = t.tileCm * (t.merc ? Math.cos((lat * Math.PI) / 180) : 1);
    }
  }
  if (native !== null && native > MAX_NATIVE_CM) return { usable: false, why: `too coarse (${Math.round(native)} cm)` };
  const ext = await extentLngLat(m);
  if (!ext || !(lng >= ext[0] && lng <= ext[2] && lat >= ext[1] && lat <= ext[3])) {
    return { usable: false, why: 'extent does not cover the point' };
  }
  /* The Worker ignores boxes bigger than a state (worker/src/county.js);
     kept anyway, marked, so the catalogue's count is honest about them. */
  const maxPx = Math.min(Number(m.maxImageWidth) || 4096, Number(m.maxImageHeight) || 4096);
  return {
    usable: true, url: c.url, type: c.type, title: c.title || m.name || null, year, nativeCm: native,
    ext, maxPx, exportOk, tileMerc: !exportOk && Boolean(tiled?.tiled && tiled.merc),
  };
}

function upsertService(q, source, key) {
  exec(`INSERT INTO county_services (url, type, title, year, native_cm, west, south, east, north, max_px,
          export_ok, tile_merc, county_key, source, checked_at)
        VALUES (${[q.url, q.type, q.title, q.year, round(q.nativeCm, 1), round(q.ext[0], 6), round(q.ext[1], 6),
    round(q.ext[2], 6), round(q.ext[3], 6), q.maxPx, q.exportOk ? 1 : 0, q.tileMerc ? 1 : 0, key, source,
    new Date().toISOString()].map(lit).join(', ')})
        ON CONFLICT(url) DO UPDATE SET type = excluded.type, title = excluded.title, year = excluded.year,
          native_cm = excluded.native_cm, west = excluded.west, south = excluded.south, east = excluded.east,
          north = excluded.north, max_px = excluded.max_px, export_ok = excluded.export_ok,
          tile_merc = excluded.tile_merc, checked_at = excluded.checked_at`);
}

/** Where to look for one county entry: its parcel layer's centre, or a grid. */
async function sweepPoints(key, entry) {
  if (!entry?.service) return [];
  const m = await meta(`${entry.service}/${entry.layer ?? 0}`);
  const ext = await extentLngLat(m);
  if (!ext) return [];
  const [w, s, e, n] = ext;
  if (!entry.statewide || (e - w <= SWEEP_STEP && n - s <= SWEEP_STEP)) return [[(w + e) / 2, (s + n) / 2]];
  const out = [];
  for (let y = s + SWEEP_STEP / 2; y < n; y += SWEEP_STEP) {
    for (let x = w + SWEEP_STEP / 2; x < e; x += SWEEP_STEP) out.push([x, y]);
  }
  return out;
}

/*
 * EVERY COUNTY IN A STATE WHOSE PARCELS COME FROM THE STATE (owner,
 * 2026-10-02: "also looking through the statewide databases for the states
 * that had statewide sources"). The point sweep reaches the state's own
 * server and any county with an entry of its own, but most counties in those
 * states have none -- Montana has 56 and four entries -- and a half-degree
 * grid steps over small counties altogether. So, by name, for each county in
 * the Census gazetteer: ArcGIS Online and the servers it leads to
 * (agolByName), each service checked at the middle of its own box rather than
 * at a grid point, and only if that middle is in the state. Resumable: one
 * county_sweep row per county ("name:<state>-<fips>").
 */
export const nameSweepKey = (st, fips) => `name:${st.toLowerCase()}-${fips}`;

async function names(decoders) {
  const { US_COUNTIES } = await import('../worker/src/us-counties.js');
  const states = [...new Set(Object.values(ALL_COUNTIES).filter((e) => e.statewide)
    .map((e) => e.state || null).filter(Boolean))];
  /* Statewide entries without a `state` field carry it in their key. */
  for (const [k, e] of Object.entries(ALL_COUNTIES)) if (e.statewide && !e.state) states.push(k.slice(0, 2).toUpperCase());
  const wanted = [...new Set(states)].filter((ab) => Object.values(US_COUNTIES).some((v) => v.ab === ab));
  const done = new Set(query("SELECT point FROM county_sweep WHERE point LIKE 'name:%'").map((r) => r.point));
  const known = new Set(query('SELECT url FROM county_services').map((r) => r.url));
  const tried = new Set();
  let added = 0, counties = 0;
  const deadline = Date.now() + Number(process.env.NAMES_MINUTES || 320) * 60000;
  for (const ab of wanted.sort()) {
    const st = Object.values(US_COUNTIES).find((v) => v.ab === ab);
    const [bw, bs, be, bn] = st.box;
    const box = [bw - 0.3, bs - 0.3, be + 0.3, bn + 0.3];
    for (const [fips, county] of Object.entries(st.counties)) {
      const point = nameSweepKey(ab, fips);
      if (done.has(point) && !FORCE) continue;
      if (Date.now() > deadline) { console.log('Out of time; the next run carries on from here.'); return report(); }
      counties++;
      const notes = [];
      let found = 0;
      const cands = rankCandidates(await agolByName(point, { name: `${county}, ${ab}`, box }).catch(() => []));
      for (const c of cands.slice(0, MAX_TRY)) {
        if (known.has(c.url)) { found++; continue; }
        if (tried.has(c.url)) continue;
        tried.add(c.url);
        const ext = await extentLngLat(await meta(c.url)).catch(() => null);
        if (!ext) { notes.push(`x ${c.title}: no extent`); continue; }
        const mid = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
        if (!(mid[0] >= box[0] && mid[0] <= box[2] && mid[1] >= box[1] && mid[1] <= box[3])) { notes.push(`x ${c.title}: not in ${ab}`); continue; }
        const q = await qualify(c, mid[0], mid[1], decoders, { again: false }).catch((e) => ({ usable: false, why: e.message }));
        await sleep(PAUSE_MS);
        if (!q.usable) { notes.push(`x ${c.title}: ${q.why}`); continue; }
        upsertService(q, 'names', point);
        known.add(c.url); added++; found++;
        notes.push(`OK ${q.title} ${q.year ?? '?'} ${q.nativeCm ? `${Math.round(q.nativeCm)} cm` : ''}${q.exportOk ? '' : ' (tiles only)'}`);
      }
      exec(`INSERT INTO county_sweep (point, county_key, lng, lat, found, checked_at)
            VALUES (${[point, point, null, null, found, new Date().toISOString()].map(lit).join(', ')})
            ON CONFLICT(point) DO UPDATE SET found = excluded.found, checked_at = excluded.checked_at`);
      console.log(`${counties} ${county}, ${ab}: ${found} service${found === 1 ? '' : 's'}`);
      for (const t of notes) console.log(`      ${t.slice(0, 150)}`);
    }
  }
  return report();
  function report() {
    const n = query("SELECT COUNT(*) n, SUM(found > 0) hit FROM county_sweep WHERE point LIKE 'name:%'")[0] || {};
    console.log('\n================ COUNTIES IN STATEWIDE STATES, BY NAME ================');
    console.log(`${added} services added this run; ${n.n ?? 0} counties looked at so far, ${n.hit ?? 0} with a county or state photo service.`);
  }
}

function ensureCatalogueTables() {
  exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS county_services \([\s\S]*?\n\);/)[0].replace(/--[^\n]*/g, ''), { always: true });
  exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS county_sweep \([\s\S]*?\n\);/)[0].replace(/--[^\n]*/g, ''), { always: true });
}

async function catalogue(decoders) {
  ensureCatalogueTables();
  /* Anything the filters now refuse comes out (a 1940 black-and-white basemap
     got in before they did). */
  for (const r of query('SELECT url, title, year FROM county_services')) {
    const old = r.year !== null && r.year !== undefined && Number(r.year) < MIN_YEAR;
    if (old || NOT_A_PHOTO.test(`${r.title || ''} ${String(r.url).split('/rest/services/')[1] || r.url}`)) {
      exec(`DELETE FROM county_services WHERE url = ${lit(r.url)}`);
      console.log(`removed ${r.title || r.url} (${old ? `flown ${r.year}` : 'not a colour photo'})`);
    }
  }
  const known = new Set(query('SELECT url FROM county_services').map((r) => r.url));
  const failed = new Set();
  let added = 0;

  /* 1. What the corpus pass already banked from. */
  for (const r of query(`SELECT ci.service, ci.service_type, ci.title, ci.year, c.lng, c.lat, c.county
                           FROM county_imagery ci JOIN corpus c ON c.id = ci.id WHERE ci.service IS NOT NULL`)) {
    if (known.has(r.service) && !FORCE) continue;
    const q = await qualify({ url: r.service, type: r.service_type, title: r.title, year: r.year }, r.lng, r.lat, decoders)
      .catch((e) => ({ usable: false, why: e.message }));
    if (q.usable) { upsertService(q, 'corpus', r.county); known.add(r.service); added++; }
    console.log(`corpus ${r.county || '?'}: ${q.usable ? `OK ${q.title} ${q.year ?? '?'}${q.exportOk ? '' : ' (tiles only)'}` : `x ${q.why}`}`);
  }

  /* 2. Every county the app covers. */
  /* Points that found nothing before the fixes of 2026-10-02 (services that
     give their projection only as WKT, Kent County's among them) are looked
     at again once. */
  const swept = new Set(query(`SELECT point FROM county_sweep
                                WHERE NOT ((found = 0 AND checked_at < '${RETRY_BEFORE}')
                                           OR checked_at < '${VENDOR_SINCE}')`).map((r) => r.point));
  /* ONLY_KEY: one county now (an owner's request), looked at again. */
  const keys = ONLY_KEY ? ONLY_KEY.split(',').map((k) => k.trim()).filter((k) => ALL_COUNTIES[k])
    : Object.keys(ALL_COUNTIES).slice(0, Math.max(1, LIMIT));
  let n = 0;
  for (const key of keys) {
    let points;
    try { points = await sweepPoints(key, ALL_COUNTIES[key]); } catch { points = []; }
    for (const [lng, lat] of points) {
      const point = `${key}@${lng.toFixed(2)},${lat.toFixed(2)}`;
      if (swept.has(point) && !FORCE && !ONLY_KEY) continue;
      n++;
      let found = 0;
      const notes = [];
      try {
        const ranked = rankCandidates([...await countyCandidates(lng, lat), ...await agolCandidates(lng, lat),
          ...await agolByName(key).catch(() => [])]);
        for (const c of ranked.slice(0, MAX_TRY)) {
          if (failed.has(c.url)) continue;
          if (known.has(c.url)) { found++; continue; }
          const q = await qualify(c, lng, lat, decoders).catch((e) => ({ usable: false, why: e.message }));
          await sleep(PAUSE_MS);
          if (!q.usable) { failed.add(c.url); notes.push(`x ${c.title || c.url}: ${q.why}`); continue; }
          upsertService(q, 'sweep', key);
          known.add(c.url); added++; found++;
          notes.push(`OK ${q.title} ${q.year ?? '?'} ${q.nativeCm ? `${Math.round(q.nativeCm)} cm` : ''}${q.exportOk ? '' : ' (tiles only)'}`);
        }
      } catch (e) { notes.push(`error ${String(e.message || e).slice(0, 60)}`); }
      exec(`INSERT INTO county_sweep (point, county_key, lng, lat, found, checked_at)
            VALUES (${[point, key, round(lng, 5), round(lat, 5), found, new Date().toISOString()].map(lit).join(', ')})
            ON CONFLICT(point) DO UPDATE SET found = excluded.found, checked_at = excluded.checked_at`);
      console.log(`${n} ${point}: ${found} service${found === 1 ? '' : 's'}`);
      for (const t of notes) console.log(`      ${t.slice(0, 150)}`);
    }
  }

  const all = query('SELECT export_ok, tile_merc, COUNT(*) n FROM county_services GROUP BY export_ok, tile_merc');
  const count = (f) => all.filter(f).reduce((a, r) => a + Number(r.n), 0);
  const pts = query("SELECT COUNT(*) n, SUM(found > 0) hit FROM county_sweep WHERE point NOT LIKE 'name:%'")[0] || {};
  console.log('\n================ COUNTY PHOTO CATALOGUE ================');
  console.log(`${added} services added this run; ${count(() => true)} in the catalogue:`
    + ` ${count((r) => Number(r.export_ok))} draw any box, ${count((r) => !Number(r.export_ok) && Number(r.tile_merc))}`
    + ` tiles only (stitched live by the Worker), ${count((r) => !Number(r.export_ok) && !Number(r.tile_merc))}`
    + ' tiles in another projection (not used live yet).');
  console.log(`Points swept: ${pts.n ?? 0}, ${pts.hit ?? 0} with a county or state photo service.`);
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

  if (MODE === 'catalogue') {
    await catalogue(decoders);
    return;
  }
  if (MODE === 'names') {
    ensureCatalogueTables();
    await names(decoders);
    return;
  }

  if (MODE === 'realign') {
    const rows = query(`SELECT ci.*, c.county, c.frame, c.image_frame, c.image_key AS mapbox_key
                          FROM county_imagery ci JOIN corpus c ON c.id = ci.id
                         WHERE ci.service IS NOT NULL AND c.status = 'approved'
                           -- never move a photo out from under outlines a person traced on it
                           AND ci.shapes IS NULL
                           ${ONLY ? `AND c.id = ${lit(ONLY)}` : ''}
                         ORDER BY c.at DESC LIMIT ${Math.max(1, LIMIT)}`);
    console.log(`${rows.length} banked county photos to line up again${DRY_RUN ? ' -- DRY RUN, nothing written' : ''}.`);
    const results = [];
    for (const [n, row] of rows.entries()) {
      let out;
      try { out = await realign({ ...row, image_key: row.mapbox_key }, decoders, dir); } catch (e) {
        out = { id: row.id, status: `error: ${String(e.message || e).slice(0, 80)}` };
      }
      results.push({ ...out, county: row.county });
      console.log(`${n + 1}/${rows.length} ${row.county || '?'} ${row.id.slice(0, 40)}: ${say(out)}`);
    }
    report(results);
    return;
  }

  /* Approved maps only: they are the training data (owner, 2026-10-01). */
  const rows = query(`SELECT c.id, c.county, c.status, c.frame, c.image_frame, c.image_key, ci.checked_at
                        FROM corpus c LEFT JOIN county_imagery ci ON ci.id = c.id
                       WHERE c.status = 'approved' AND c.image_key IS NOT NULL
                         -- never replace a photo somebody traced outlines on
                         AND ci.shapes IS NULL
                         -- nor look for one for a map made on a county photo:
                         -- that photo IS its photo (county-picture.js)
                         AND (c.image_provider IS NULL OR c.image_provider != 'county')
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
    console.log(`${n + 1}/${todo.length} ${row.county || '?'} ${row.id.slice(0, 40)}: ${say(out)}`);
    for (const t of out.tried || []) console.log(`      ${t.slice(0, 160)}`);
  }
  report(results);
}

function say(out) {
  if (out.status !== 'banked') {
    return `${out.status}${out.found !== undefined ? ` (${out.found} candidate${out.found === 1 ? '' : 's'}, ${out.tried?.length ?? 0} tried)` : ''}`;
  }
  const head = `${out.host} "${out.title}" ${out.year ?? '?'}, ${out.nativeCm ? Math.round(out.nativeCm) : '?'} cm; `;
  if (!out.confident) return `${head}NOT SURE (${out.why}), banked as delivered`;
  return `${head}Mapbox's ground ${out.east.toFixed(2)} m E ${out.north.toFixed(2)} m N in it (${out.model}, `
    + `${out.inliers}/${out.patches} patches agree to ${out.rmsM.toFixed(2)} m); `
    + `after banking ${out.residual === null ? 'NOT MEASURABLE' : `${out.residual.toFixed(2)} m`}${out.landed ? '' : ' -- DID NOT LAND'}`;
}

function report(results) {
  writeFileSync('county-imagery.json', JSON.stringify(results, null, 2));

  /* THE PART WORTH READING. */
  const banked = results.filter((r) => r.status === 'banked');
  const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const sure = banked.filter((r) => r.confident && r.landed);
  const doubtful = banked.filter((r) => !(r.confident && r.landed));
  console.log('\n================ COUNTY IMAGERY ================');
  console.log(`Looked at ${results.length} maps: ${banked.length} with usable county or state imagery, banked;`
    + ` ${results.filter((r) => r.status === 'none usable').length} with none usable;`
    + ` ${results.filter((r) => !['banked', 'none usable'].includes(r.status)).length} could not be checked.`);
  if (banked.length) {
    console.log(`Median native ${Math.round(med(banked.map((r) => r.nativeCm)))} cm;`
      + ` median offset from Mapbox ${med(sure.map((r) => Math.hypot(r.east, r.north)))?.toFixed(2) ?? '?'} m;`
      + ` median left after banking ${med(sure.map((r) => r.residual))?.toFixed(2) ?? '?'} m.`);
    console.log(`Put on Mapbox's ground and measured there: ${sure.length} of ${banked.length}`
      + ` (to within ${MAX_RESIDUAL_M} m).`);
    const hosts = {};
    for (const r of banked) hosts[r.host] = (hosts[r.host] || 0) + 1;
    console.log(`Sources: ${Object.entries(hosts).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(', ')}`);
  }
  console.log(`To check by eye on /county.html: ${doubtful.length} not sure (nothing on the ground to measure,`
    + ' so banked as delivered; or it did not land) -- they are shown first.');
  console.log('Per-map results: the county-imagery artifact.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
