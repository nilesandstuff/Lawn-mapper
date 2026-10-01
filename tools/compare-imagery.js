/**
 * Which aerial photographs exist for our lawns, and are any better than Mapbox?
 *
 * THE QUESTION (owner, 2026-10-01): should the app use USGS high-resolution
 * orthoimagery, or the photographs counties fly for themselves -- and is
 * Google worth keeping, when its pictures are often warped in ways that
 * cannot be lined up? Every claim about those sources so far has been general
 * knowledge, not a measurement here, and this project has argued for two
 * improvements at length that then measured as nothing. So: measured first.
 *
 * FOR EACH APPROVED LOT, fetch the same frame from every source we can find
 * and record, per source:
 *
 *   covered   it answered with a picture that is not blank
 *   detail    lib extraDetail (tools/probe-resolution.js) on the same pixel
 *             grid as Mapbox, as a RATIO to Mapbox's on the same lot. Same
 *             frame, same pixel count, so above 1 is sharper than Mapbox
 *             there and well below is upsampled from something coarser
 *   native    the service's own ground resolution, from its metadata, when
 *             its units can be told (cm)
 *   offset    how far it sits from Mapbox, from public/lib/align.js -- the
 *             app's own alignment -- in metres, and whether the fit was clear
 *   year      any year the service's name or description mentions
 *   green     the share of clearly green pixels, against Mapbox's. A rough
 *             hint at season (leaf-off, dormant grass) and NOTHING MORE: it
 *             has not been checked against a single photograph's real date
 *
 * WHERE THE SOURCES COME FROM, discovered rather than guessed:
 *   - Mapbox, the baseline, and NAIP, which the app already offers
 *   - every imagery-looking service in the USGS National Map catalogues
 *   - every imagery-looking service on the SAME SERVER as the lot's county
 *     parcel layer (worker/src/counties.js) -- counties that publish parcels
 *     over ArcGIS very often publish their orthophotos beside them
 *
 * AND THE GOOGLE QUESTION: how many maps were drawn on each source, from the
 * corpus itself.
 *
 *   node tools/compare-imagery.js            (needs the corpus, like any probe)
 * or workflow "8. Check the free imagery sources", "compare on our lawns". Free: public servers
 * and the Mapbox static tier the app already uses.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

import { query } from './corpus-db.js';
import { extraDetail } from './probe-resolution.js';
import { alignImages } from '../public/lib/align.js';
import { frameBbox3857, imagePixels, imageHeightPixels, groundPerPixel } from '../worker/src/imagery.js';
import { candidateCounties, ALL_COUNTIES } from '../worker/src/counties.js';

const TOKEN = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN || '';
const HOW_MANY = Number(process.env.HOW_MANY || 60);
const MAX_COUNTY_SERVICES = Number(process.env.MAX_COUNTY_SERVICES || 2);
const TIMEOUT_MS = 45000;

const USGS_CATALOGUES = [
  'https://imagery.nationalmap.gov/arcgis/rest/services',
  'https://basemap.nationalmap.gov/arcgis/rest/services',
];

/* ------------------------------------------------------------ pure parts */

const IMAGERY = /ortho|imagery|image|aerial|photo|naip|hro|leaf.?off|leafoff|sid|ecw|mosaic/i;
const NOT_IMAGERY = /topo|index|footprint|boundar|grid|tile.?scheme|dates?$|flight|outline|extent|lidar|dem|hillshade|elevation|contour|parcel|address|zoning|landcover|land.?cover|ndvi|cir\b|infrared|cache_status|labels?/i;

/** The catalogue root ("…/rest/services") a service URL lives under. */
export function catalogueRoot(serviceUrl) {
  const m = String(serviceUrl || '').match(/^(https?:\/\/.+?\/rest\/services)(\/|$)/i);
  return m ? m[1] : null;
}

/**
 * The catalogue roots worth asking on a county's host. ArcGIS Enterprise sites
 * often publish imagery from a separate web adaptor on the same host -- Ottawa
 * County, Michigan keeps parcels under /arcgis/ and its aerials, 1962 to 2024,
 * under /image/ -- so the parcel layer's own root is only the first place.
 */
export const SIBLING_ADAPTORS = ['arcgis', 'image', 'imagery', 'server', 'arcgisimage', 'raster', 'gis'];
export function siblingRoots(root) {
  const m = String(root || '').match(/^(https?:\/\/[^/]+)\/([^/]+)\/rest\/services$/i);
  if (!m) return root ? [root] : [];
  if (/arcgis\.com$/i.test(new URL(m[1]).host)) return [root]; // ArcGIS Online: one org, one root
  return [...new Set([root, ...SIBLING_ADAPTORS.map((a) => `${m[1]}/${a}/rest/services`)])];
}

/**
 * Newest first. A county that has flown fourteen times lists fourteen
 * services, and the one worth comparing is the latest: highest year in the
 * name first, then ones naming no year (often "current"), then older years.
 * A "_Cached" twin of the same flight is a duplicate, so it goes after.
 */
export function newestFirst(services = []) {
  const year = (s) => Math.max(0, ...yearHints(s.name));
  const newest = Math.max(0, ...services.map(year));
  const rank = (s) => {
    const y = year(s);
    const tier = y && y === newest ? 0 : !y ? 1 : 2;
    return [tier, -y, /cache/i.test(s.name) ? 1 : 0];
  };
  return services.slice().sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

/** Imagery-looking image or map services in one catalogue listing. */
export function pickImagery(services = []) {
  return services.filter((s) => (s.type === 'ImageServer' || s.type === 'MapServer')
    && IMAGERY.test(s.name) && !NOT_IMAGERY.test(s.name));
}

/** Plausible years named in some text: 1950 (county archives go back that far) to next year. */
export function yearHints(text) {
  const max = new Date().getUTCFullYear() + 1;
  /* From 1900: a 1940 flight is a year to reject, not a year to miss (Oakland
     County's "OC Ortho BW1940" passed as undated, 2026-10-01). */
  const found = String(text || '').match(/(?<!\d)(19\d\d|20[0-4]\d)(?!\d)/g) || [];
  return [...new Set(found.map(Number).filter((y) => y >= 1900 && y <= max))].sort();
}

/**
 * A service's native ground resolution in cm at `lat`, when its units can be
 * told. Null rather than a guess: a state-plane service in US feet and one in
 * metres look the same from pixelSizeX alone.
 */
export function nativeCm(meta, lat) {
  if (!meta) return null;
  const wkid = meta.spatialReference?.latestWkid || meta.spatialReference?.wkid
    || meta.extent?.spatialReference?.latestWkid || meta.extent?.spatialReference?.wkid;
  let size = Number(meta.pixelSizeX);
  if (!Number.isFinite(size) || size <= 0) {
    /*
     * A tile cache's finest level is the SCHEME, not the photograph: USGS
     * Imagery Only tiles go to 1.9 cm while its photos stop at 1:9,028. So
     * the finest level the service will actually draw (scale >= maxScale).
     */
    const lods = (meta.tileInfo?.lods || [])
      .filter((l) => !(Number(meta.maxScale) > 0) || Number(l.scale) >= Number(meta.maxScale) - 1);
    size = lods.length ? Number(lods[lods.length - 1].resolution) : NaN;
  }
  if (!Number.isFinite(size) || size <= 0) return null;
  const cos = Math.cos((lat * Math.PI) / 180);
  if (wkid === 3857 || wkid === 102100 || wkid === 900913) return size * cos * 100;
  if (wkid === 4326) return size * 111320 * cos * 100;
  const units = String(meta.units || '');
  if (/Meters/i.test(units)) return size * 100;
  if (/Feet/i.test(units)) return size * 30.48;
  return null;
}

/** Is this decoded picture blank -- one colour, or mostly transparent? */
export function isBlank(data, width, height) {
  let opaque = 0, sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < width * height; i += 7) {
    const a = data[i * 4 + 3];
    if (a < 16) continue;
    opaque++;
    const g = data[i * 4 + 1];
    sum += g; sum2 += g * g; n++;
  }
  if (opaque < (width * height) / 7 / 2) return true;
  const mean = sum / n;
  return sum2 / n - mean * mean < 4; // a flat colour: "no data" tiles and fills
}

/** Share of pixels that are clearly green. */
export function greenShare(data, width, height) {
  let green = 0, n = 0;
  for (let i = 0; i < width * height; i += 3) {
    const [r, g, b, a] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
    if (a < 16) continue;
    n++;
    if (g > r * 1.05 && g > b * 1.05) green++;
  }
  return n ? green / n : 0;
}

/** Greyscale on a w x h grid, box-averaged from a decoded picture. */
export function greyGrid(data, width, height, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4;
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      out[y * w + x] = n ? s / n : 0;
    }
  }
  return out;
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Per lot, the best county source that covered it: the finest native
 * resolution. One line for "how many of our lots have county imagery at all".
 */
export function countyReach(lots) {
  let covered = 0;
  const native = [], offset = [];
  for (const lot of lots) {
    const hits = lot.sources.filter((s) => s.county && s.covered);
    if (!hits.length) continue;
    covered++;
    const best = hits.slice().sort((a, b) => (a.nativeCm ?? 1e9) - (b.nativeCm ?? 1e9))[0];
    native.push(best.nativeCm);
    if (best.offsetM !== null && best.offsetM !== undefined) offset.push(best.offsetM);
  }
  return { lots: lots.length, covered, nativeCm: median(native), offsetM: median(offset) };
}

/** One line per source, from every lot's results. */
export function summarise(lots) {
  const by = new Map();
  for (const lot of lots) {
    for (const s of lot.sources) {
      if (s.key === 'mapbox') continue;
      const e = by.get(s.key) || { key: s.key, label: s.label, tried: 0, covered: 0, detail: [], offset: [], native: [], years: new Set(), green: [] };
      e.tried++;
      if (s.covered) {
        e.covered++;
        if (s.detailVsMapbox !== null && s.detailVsMapbox !== undefined) e.detail.push(s.detailVsMapbox);
        if (s.offsetM !== null) e.offset.push(s.offsetM);
        e.native.push(s.nativeCm);
        e.green.push(s.greenVsMapbox);
        for (const y of s.years || []) e.years.add(y);
      }
      by.set(s.key, e);
    }
  }
  return [...by.values()].map((e) => ({
    key: e.key,
    label: e.label,
    tried: e.tried,
    covered: e.covered,
    detailVsMapbox: median(e.detail),
    sharperThanMapbox: e.detail.filter((d) => d > 1.1).length,
    offsetM: median(e.offset),
    nativeCm: median(e.native),
    greenVsMapbox: median(e.green),
    years: [...e.years].sort(),
  })).sort((a, b) => b.covered - a.covered || (b.detailVsMapbox || 0) - (a.detailVsMapbox || 0));
}

/* --------------------------------------------------------------- network */

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

/** Every service in a catalogue, one folder deep. */
async function listCatalogue(root) {
  const top = await getJson(`${root}?f=json`);
  const out = (top.services || []).map((s) => ({ ...s, root }));
  for (const folder of (top.folders || []).slice(0, 25)) {
    try {
      const sub = await getJson(`${root}/${encodeURIComponent(folder)}?f=json`);
      out.push(...(sub.services || []).map((s) => ({ ...s, root })));
    } catch { /* one folder refusing is not the catalogue refusing */ }
  }
  return out;
}

const serviceUrl = (s) => `${s.root}/${s.name}/${s.type}`;

function exportUrl(s, frame) {
  const params = new URLSearchParams({
    bbox: frameBbox3857(frame).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${imagePixels(frame)},${imageHeightPixels(frame)}`,
    format: 'png',
    f: 'image',
  });
  if (s.type === 'MapServer') params.set('transparent', 'true');
  /*
   * SMOOTH ENLARGEMENT, OR THE DETAIL FIGURE LIES. The first run asked with
   * the servers' default resampling, which is nearest-neighbour: a 23 cm NAIP
   * picture enlarged to our 5 cm grid became hard-edged blocks, and the block
   * edges read as fine detail -- NAIP "1.73x sharper than Mapbox", the 1.8 m
   * USGS basemap "2.75x". Bilinear makes a coarse source look as soft as it
   * is. Map services cannot be asked, so their detail is not scored at all.
   */
  if (s.type === 'ImageServer') params.set('interpolation', 'RSP_BilinearInterpolation');
  return `${serviceUrl(s)}/${s.type === 'ImageServer' ? 'exportImage' : 'export'}?${params}`;
}

const mapboxUrl = (f) =>
  'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/'
  + `${f.lng},${f.lat},${f.zoom},0/${f.size}x${f.height || f.size}@2x`
  + `?access_token=${TOKEN}&attribution=false&logo=false`;

async function fetchImage(url, decoders) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (/json|html|xml/.test(type)) return { ok: false, reason: 'not-an-image' };
  try {
    const png = buf[0] === 0x89 && buf[1] === 0x50;
    const img = png ? decoders.png.PNG.sync.read(buf) : decoders.jpeg.decode(buf, { useTArray: true });
    return { ok: true, img };
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

/** Measure one source against the Mapbox picture of the same frame. */
function measure(img, base, frame) {
  const { data, width, height } = img;
  if (isBlank(data, width, height)) return { covered: false, reason: 'blank' };
  const detail = extraDetail(data, width, height, 4);
  const across = groundPerPixel(frame) * imagePixels(frame);
  const cellM = Math.max(0.6, across / 192);
  const w = Math.max(48, Math.round(across / cellM));
  const h = Math.max(48, Math.round((across * height) / width / cellM));
  const fit = alignImages(base.grey(w, h), greyGrid(data, width, height, w, h), w, h, {
    maxShift: Math.max(2, Math.round(8 / cellM)),
    scales: [0.99, 0.995, 1, 1.005, 1.01],
  });
  return {
    covered: true,
    detailVsMapbox: detail && base.detail ? detail.extra / base.detail.extra : null,
    offsetM: fit.moved ? Math.hypot(fit.dx, fit.dy) * cellM : 0,
    offsetClear: fit.moved,
    fit: Math.round(fit.ncc * 100) / 100,
    greenVsMapbox: base.green ? greenShare(data, width, height) / base.green : null,
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  if (!TOKEN) {
    console.log('No MAPBOX_TOKEN, so there is no baseline to compare against.');
    process.exitCode = 1;
    return;
  }
  const decoders = { png: await import('pngjs'), jpeg: (await import('jpeg-js')).default };

  /* THE GOOGLE QUESTION FIRST: it needs no fetching at all. */
  const drawnOn = query(`SELECT COALESCE(provider, 'unknown') provider, COUNT(*) n
                           FROM corpus GROUP BY 1 ORDER BY n DESC`);

  const rows = query(`SELECT id, county, frame FROM corpus
                       WHERE status = 'approved' AND frame IS NOT NULL
                       ORDER BY at DESC LIMIT ${Math.max(1, HOW_MANY)}`)
    .map((r) => { try { return { ...r, f: JSON.parse(r.frame) }; } catch { return null; } })
    .filter((r) => r?.f && Number.isFinite(r.f.zoom));

  /* USGS, once. */
  const usgs = [];
  for (const root of USGS_CATALOGUES) {
    try {
      const found = pickImagery(await listCatalogue(root));
      usgs.push(...found);
      console.log(`USGS catalogue ${root}: ${found.map((s) => `${s.name} (${s.type})`).join(', ') || 'no imagery services'}`);
    } catch (e) {
      console.log(`USGS catalogue ${root}: unreachable (${e.message})`);
    }
  }
  const naip = { root: 'https://imagery.nationalmap.gov/arcgis/rest/services', name: 'USGSNAIPPlus', type: 'ImageServer' };
  if (!usgs.some((s) => s.name === naip.name)) usgs.unshift(naip);

  const metaCache = new Map();
  const meta = async (s) => {
    const url = serviceUrl(s);
    if (!metaCache.has(url)) metaCache.set(url, getJson(`${url}?f=json`).catch(() => null));
    return metaCache.get(url);
  };
  const countyCache = new Map();
  const countyServices = async (root) => {
    if (!countyCache.has(root)) {
      countyCache.set(root, (async () => {
        const found = [];
        for (const r of siblingRoots(root)) {
          try { found.push(...pickImagery(await listCatalogue(r))); } catch { /* no such adaptor */ }
        }
        const ranked = newestFirst(found);
        console.log(`  county imagery at ${new URL(root).host}: ${ranked.map((x) => x.name).join(', ') || 'none found'}`);
        return ranked;
      })());
    }
    return countyCache.get(root);
  };

  const lots = [];
  for (const [n, row] of rows.entries()) {
    const f = row.f;
    const got = await fetchImage(mapboxUrl(f), decoders);
    if (!got.ok) { console.log(`${row.id}: Mapbox ${got.reason}, skipped`); continue; }
    const bd = got.img;
    const greyCache = new Map();
    const base = {
      detail: extraDetail(bd.data, bd.width, bd.height, 4),
      green: greenShare(bd.data, bd.width, bd.height),
      grey: (w, h) => {
        const k = `${w}x${h}`;
        if (!greyCache.has(k)) greyCache.set(k, greyGrid(bd.data, bd.width, bd.height, w, h));
        return greyCache.get(k);
      },
    };

    const candidates = usgs.map((s) => ({ s, key: `usgs:${s.name}`, label: `USGS ${s.name}` }));
    const roots = [...new Set(candidateCounties(f.lng, f.lat)
      .map((k) => catalogueRoot(ALL_COUNTIES[k]?.service)).filter(Boolean))];
    for (const root of roots) {
      for (const s of (await countyServices(root)).slice(0, MAX_COUNTY_SERVICES)) {
        const label = `county ${new URL(root).host} ${s.name}`;
        candidates.push({ s, key: `county:${label}`, label, county: true });
      }
    }

    const sources = [{ key: 'mapbox', label: 'Mapbox', covered: true, detailVsMapbox: 1 }];
    for (const c of candidates) {
      const m = await meta(c.s);
      const entry = {
        key: c.key,
        label: c.label,
        service: serviceUrl(c.s),
        years: yearHints(`${c.s.name} ${m?.description || ''} ${m?.serviceDescription || ''} ${m?.copyrightText || ''}`),
        nativeCm: nativeCm(m, f.lat),
      };
      const img = await fetchImage(exportUrl(c.s, f), decoders).catch((e) => ({ ok: false, reason: e.message }));
      if (!img.ok) { sources.push({ ...entry, covered: false, reason: img.reason }); continue; }
      try {
        const m2 = measure(img.img, base, f);
        if (c.s.type !== 'ImageServer') m2.detailVsMapbox = null; // see exportUrl
        sources.push({ ...entry, county: Boolean(c.county), ...m2 });
      } catch (e) {
        sources.push({ ...entry, covered: false, reason: `measure: ${e.message}` });
      }
    }
    lots.push({ id: row.id, county: row.county, sources });
    const line = sources.filter((s) => s.key !== 'mapbox')
      .map((s) => (s.covered
        ? `${s.label} ${s.detailVsMapbox?.toFixed(2) ?? '?'}x detail, ${s.offsetM?.toFixed(1)} m off`
        : `${s.label} -- ${s.reason}`)).join('; ');
    console.log(`${n + 1}/${rows.length} ${row.county || row.id}: ${line}`);
  }

  const summary = summarise(lots);
  writeFileSync('imagery-probe.json', JSON.stringify({ drawnOn, summary, lots }, null, 2));

  /* THE PART WORTH READING, at the end where a phone can find it. */
  console.log('\n================ IMAGERY: WHAT EXISTS AND HOW IT COMPARES ================');
  console.log(`Lots measured: ${lots.length}. Detail is against Mapbox on the same lot and pixel grid`);
  console.log('(1.00 = as sharp as Mapbox). Offset is how far it sits from Mapbox.\n');
  for (const s of summary) {
    const pct = (x) => (x === null ? '?' : `${x.toFixed(2)}x`);
    console.log(`${s.label}: covers ${s.covered}/${s.tried}; detail ${pct(s.detailVsMapbox)}`
      + ` (sharper than Mapbox on ${s.sharperThanMapbox}); offset ${s.offsetM === null ? '?' : `${s.offsetM.toFixed(1)} m`}`
      + `; native ${s.nativeCm === null ? 'unknown' : `${Math.round(s.nativeCm)} cm`}`
      + `; green ${pct(s.greenVsMapbox)}${s.years.length ? `; years ${s.years.join(', ')}` : ''}`);
  }
  const reach = countyReach(lots);
  console.log(`\nANY county imagery: ${reach.covered} of ${reach.lots} lots; best per lot median `
    + `${reach.nativeCm === null ? '?' : `${Math.round(reach.nativeCm)} cm`} native, `
    + `${reach.offsetM === null ? '?' : `${reach.offsetM.toFixed(1)} m`} from Mapbox.`);
  console.log('\nMaps drawn on each source (the Google question):');
  for (const d of drawnOn) console.log(`  ${d.provider}: ${d.n}`);
  console.log('\n"green" is a rough season hint only; it has not been checked against real flight dates.');
  console.log('Full per-lot results: the imagery-probe artifact.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
