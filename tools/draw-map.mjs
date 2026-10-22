/**
 * The asked map, drawn beside a run's pictures (workflow 14 `also_draw`,
 * 2026-10-22).
 *
 * THE OWNER'S REQUEST: "include the large Byron Center property ... just as
 * an evaluation map so I can see the output trace the detector gives". It
 * is one of the owner's saved maps, not a corpus row, and it must never be
 * learned from: the shape saved on it is a placeholder. So this does not
 * touch the training or the scoring at all. After the run has scored and
 * published its pictures, the step before this one trains one decoder on
 * every lot (as a release is trained, kept in RELEASE_DIR, never shipped),
 * and this:
 *
 *   1. finds the saved map by its coordinates (ALSO_DRAW = "lng,lat"),
 *      through the site's read-only route for the owner's maps
 *      (/api/admin/saved-maps, MAPS_READ_TOKEN);
 *   2. builds the press the app would send -- the capture frame, the photo
 *      URL on the site (the county photo it was drawn on, or Mapbox), the
 *      property line as saved -- and runs tools/draw_map.py: the live
 *      server's own path (prepare, photo, lidar, NAIP, backbone, decoder),
 *      on this runner's CPU;
 *   3. finishes it as the server does (serve-alpha.mjs: stage 3, the lidar
 *      veto) and draws the same four pictures train-detector.js draws, with
 *      no truth to wash green;
 *   4. uploads them under the run's folder and adds the entry to its
 *      index.json, marked `evalOnly`, so the predictions page shows it
 *      with the run, last, captioned as drawn only.
 *
 * THE ADDRESS STAYS OUT OF THE LOG. The saved map's id and address are
 * never printed; the entry carries the coordinates, as every corpus entry
 * does.
 *
 *   ALSO_DRAW="-85.70712,42.83547" SITE=https://lawnmap.example.com \
 *   MAPS_READ_TOKEN=... RELEASE_DIR=release-local RUN_FOLDER_FILE=run-folder.txt \
 *   OUT=drawn node tools/draw-map.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { liveCaptureFrame } from '../worker/src/imagery.js';
import { runKeys } from './run-folder.js';
import { parcelMask } from './serve-alpha.mjs';
import { drawLayers, drawPrediction, tracePrediction, LAYERS } from './render-prediction.js';

const SQM_PER_SQFT = 0.09290304;

/** "lng,lat" -> [lng, lat], or null. */
export function parseLngLat(s) {
  const m = String(s || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!(Math.abs(lng) <= 180 && Math.abs(lat) <= 90)) return null;
  return [lng, lat];
}

/** The saved map nearest the asked point, within `withinM` metres, or null. */
export function nearestMap(maps, [lng, lat], withinM = 150) {
  let best = null;
  for (const m of maps) {
    if (!Number.isFinite(m?.lng) || !Number.isFinite(m?.lat)) continue;
    const dx = (m.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dy = (m.lat - lat) * 110540;
    const d = Math.hypot(dx, dy);
    if (d <= withinM && (!best || d < best.d)) best = { map: m, d };
  }
  return best;
}

/** A mask (w x h, one byte a cell) resampled by nearest cell onto W x H. */
export function nearest(mask, w, h, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) {
      out[y * W + x] = mask[sy * w + Math.min(w - 1, Math.floor((x * w) / W))] ? 1 : 0;
    }
  }
  return out;
}

/** RGBA pixels of a PNG, box-averaged onto W x H (train-detector.js resize). */
export function resizeRgba(src, w, h, channels, W, H) {
  const out = new Uint8Array(W * H * 4);
  const sx = w / W;
  const sy = h / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const i = (yy * w + xx) * channels;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

/** The press payload for a saved map, as worker/src/alpha.js builds one. */
export function pressFor(map, site) {
  const shot = liveCaptureFrame(map.frame);
  const county = map.provider === 'county' && map.countySvc ? String(map.countySvc) : null;
  const q = new URLSearchParams({
    lng: shot.frame.lng, lat: shot.frame.lat, zoom: shot.frame.zoom, size: shot.frame.size,
    height: shot.frame.height || shot.frame.size, provider: county ? 'county' : 'mapbox',
    ...(county ? { svc: county } : {}),
  });
  return {
    imageUrl: `${site}/api/imagery?${q}`,
    frame: shot.frame,
    parcel: map.parcel?.geometry || map.parcel || null,
    naipAlign: county ? null : map.naipAlign || null,
    provider: county ? 'county' : 'mapbox',
    groundCm: Math.round(shot.groundM * 1000) / 10,
  };
}

/** The run index entry for a drawn-only map. */
export function evalEntry({ keys, n, map, prep, rec, trace, lawnCells, county, provider, windows }) {
  const sqft = (px) => (px * prep.mpp * prep.mpp) / SQM_PER_SQFT;
  return {
    key: keys.shapes(n), maskKey: keys.mask(n), photoKey: keys.photo(n), layersKey: keys.layers(n),
    county: county || null, tag: null,
    id: `${map.lng},${map.lat}:eval:draw`, lat: map.lat, lng: map.lng,
    evalOnly: true,
    provider,
    squareFeet: Math.round(sqft(lawnCells)),
    errorPct: null, outlineErrorPct: null, samErrorPct: null,
    foundPct: null, overPct: null, missedInferredPct: null, inferredPct: 0,
    mpp: Number(prep.mpp.toFixed(3)), metresAcross: Math.round(prep.span),
    gridPx: prep.w, gridPy: prep.h, renderPx: trace.renderPx, renderPy: trace.renderPy,
    pieces: trace.pieces, vertices: trace.vertices, droppedPieces: trace.droppedPieces,
    droppedSqFt: Math.round(sqft(trace.droppedPx)),
    windows, lidar: Boolean(rec.lidar), naip: Boolean(rec.naip), seconds: rec.seconds || null,
  };
}

function wrangler(args, opts = {}) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url.replace(/\?.*$/, '')}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const asked = parseLngLat(process.env.ALSO_DRAW);
  if (!asked) throw new Error(`ALSO_DRAW must be "lng,lat", not "${process.env.ALSO_DRAW || ''}"`);
  const site = String(process.env.SITE || '').replace(/\/$/, '');
  const token = process.env.MAPS_READ_TOKEN || '';
  if (!site || !token) throw new Error('SITE and MAPS_READ_TOKEN are needed to read the saved map');
  const out = process.env.OUT || 'drawn';
  const bucket = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
  const slug = existsSync(process.env.RUN_FOLDER_FILE || '') ? readFileSync(process.env.RUN_FOLDER_FILE, 'utf8').trim() : '';
  if (!slug) throw new Error('no run folder: the scoring step did not publish its pictures, so there is nothing to draw beside');
  mkdirSync(out, { recursive: true });

  /* 1. The saved map. The list has no coordinates, so each is read once;
        nothing printed names an address. */
  const list = (await fetchJson(`${site}/api/admin/saved-maps`, token)).maps || [];
  const maps = [];
  for (const row of list) {
    try {
      const one = await fetchJson(`${site}/api/admin/saved-maps/one?id=${encodeURIComponent(row.id)}`, token);
      if (one?.map) maps.push(one.map);
    } catch { /* one unreadable map is not the end of the search */ }
  }
  const hit = nearestMap(maps, asked);
  if (!hit) throw new Error(`none of the owner's ${maps.length} saved maps is within 150 m of ${asked.join(',')}`);
  const map = hit.map;
  console.log(`The saved map at ${map.lng},${map.lat} (${map.county || 'no county'}, ${map.provider || 'mapbox'} photo`
    + `${map.countySvc ? `, county service ${map.countySvc}` : ''}, saved ${String(map.at || '').slice(0, 10)}), `
    + `${Math.round(hit.d)} m from the point asked. Its own shapes are not read.`);
  if (!map.frame || !map.parcel) throw new Error('the saved map has no frame or no property line');

  /* 2. The press, and the live path on this machine. */
  const press = pressFor(map, site);
  writeFileSync(join(out, 'payload.json'), JSON.stringify({
    imageUrl: press.imageUrl, frame: press.frame, parcel: press.parcel, naipAlign: press.naipAlign,
  }));
  console.log(`Press: ${press.provider} photo at ${press.groundCm} cm a pixel, frame ${press.frame.size}x${press.frame.height || press.frame.size} at zoom ${press.frame.zoom}.`);
  const py = spawnSync('python3', [join('tools', 'draw_map.py')], {
    stdio: 'inherit', env: { ...process.env, OUT: out }, timeout: 3 * 3600 * 1000,
  });
  if (py.status !== 0) throw new Error(`draw_map.py exited ${py.status}`);
  const prep = JSON.parse(readFileSync(join(out, 'prep.json'), 'utf8'));
  const rec = JSON.parse(readFileSync(join(out, 'rec.json'), 'utf8'));

  /* 3. Finished as the server finishes it (stage 3, the lidar veto), then drawn. */
  const fin = spawnSync('node', [join('tools', 'serve-alpha.mjs'), 'finish'], {
    input: JSON.stringify({ dir: out, w: prep.w, h: prep.h, mpp: prep.mpp, frame: press.frame, parcel: press.parcel }),
    encoding: 'utf8', timeout: 600000,
  });
  if (fin.status !== 0) throw new Error(`serve-alpha finish: ${String(fin.stderr).slice(-400)}`);
  const finished = JSON.parse(fin.stdout);

  const { PNG } = await import('pngjs');
  const png = (name) => (existsSync(join(out, name)) ? PNG.sync.read(readFileSync(join(out, name))) : null);
  const grey = (img) => { const m = new Uint8Array(img.width * img.height); for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4] >= 128 ? 1 : 0; return m; };
  const G = prep.w, GH = prep.h;
  const onGrid = (img) => (img ? nearest(grey(img), img.width, img.height, G, GH) : null);
  const mask = onGrid(png('final.png'));
  const raw = onGrid(png('prob.png'));
  const canopy = onGrid(png('canopy.png'));
  const roof = onGrid(png('roof.png'));
  const voidMask = onGrid(png('void.png'));
  const within = parcelMask(press.parcel, press.frame, G, GH);
  const full = png('photo-full.png');

  const PX = 1280;
  const PY = Math.max(1, Math.round((PX * GH) / G));
  const scale = PX / G;
  const big = (m) => (m ? nearest(m, G, GH, PX, PY) : null);
  const photo = resizeRgba(full.data, full.width, full.height, 4, PX, PY);
  const trace = tracePrediction({ predicted: mask, within, grid: G, gridH: GH, mpp: prep.mpp });
  const rings = trace.rings.map((ring) => ring.map(([x, y]) => [x * scale, y * scale]));
  const none = new Uint8Array(PX * PY);
  const pixels = drawPrediction({ photo, truth: none, within: big(within), inferred: null, rings, grid: PX, gridH: PY });
  const rawPixels = drawPrediction({ photo, truth: none, within: big(within), inferred: null, mask: big(mask), grid: PX, gridH: PY });
  const layered = drawLayers({
    photo, within: big(within), grid: PX, gridH: PY, rings,
    masks: { canopy: big(canopy), roof: big(roof), void: big(voidMask), mask: big(raw), line: big(within) },
  });
  let lawnCells = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && (!within || within[i])) lawnCells++;

  /* 4. Beside the run. */
  const keys = runKeys(slug);
  const indexFile = join(out, 'index.json');
  wrangler(['r2', 'object', 'get', `${bucket}/${keys.index}`, '--file', indexFile, '--remote']);
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const n = entries.length;
  const write = (pix, name, h) => {
    const p = new PNG({ width: PX, height: h });
    p.data = Buffer.from(pix.buffer, pix.byteOffset, pix.length);
    const file = join(out, name);
    writeFileSync(file, PNG.sync.write(p));
    return file;
  };
  for (const [k, pix, name, h] of [
    [keys.shapes(n), pixels, `${n}.png`, PY],
    [keys.mask(n), rawPixels, `${n}-mask.png`, PY],
    [keys.photo(n), photo, `${n}-photo.png`, PY],
    [keys.layers(n), layered.sprite, `${n}-layers.png`, PY * LAYERS.length],
  ]) {
    wrangler(['r2', 'object', 'put', `${bucket}/${k}`, '--file', write(pix, name, h), '--content-type', 'image/png', '--remote']);
  }
  entries.push(evalEntry({
    keys, n, map, prep, rec, lawnCells, county: map.county, provider: press.provider, windows: rec.windows || 1,
    trace: { ...trace, renderPx: PX, renderPy: PY },
  }));
  index.entries = entries;
  index.drawnOnly = (index.drawnOnly || 0) + 1;
  writeFileSync(indexFile, JSON.stringify(index, null, 1));
  wrangler(['r2', 'object', 'put', `${bucket}/${keys.index}`, '--file', indexFile, '--content-type', 'application/json', '--remote']);

  const sqft = Math.round((lawnCells * prep.mpp * prep.mpp) / SQM_PER_SQFT);
  console.log(`\nDrawn only, never trained on or scored: ${sqft.toLocaleString()} sq ft of lawn found inside the line `
    + `(${trace.pieces} piece${trace.pieces === 1 ? '' : 's'}, ${trace.vertices} handles; uncertainty ${finished.uncertainty ?? '?'}), `
    + `read in ${rec.windows || 1} window(s)${rec.lidar ? ', lidar read' : ', NO LIDAR'}${rec.naip ? ', NAIP read' : ', no NAIP'}.`);
  console.log(`It is picture ${n + 1} of runs/${slug} on the predictions page, listed last.`);
}

if (process.argv[1] && process.argv[1].endsWith('draw-map.mjs')) {
  main().catch((e) => {
    console.log(`\nThe asked map was not drawn: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 300)}`);
    console.log('The run\'s own tables and pictures are unaffected.');
    process.exit(1);
  });
}
