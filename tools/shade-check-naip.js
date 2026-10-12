/**
 * THE SHADE MAP AGAINST AERIAL PHOTOS (features session; owner asked
 * 2026-10-12). Shadows on grass in the USDA's NAIP photo of a lot, against
 * the shade map's model of the same lot at the moment the photo was taken.
 *
 *   node tools/shade-check-naip.js [lots.csv] > results.jsonl
 *
 * Lots: data/labelled-crowns.csv's corpus lots by default (real lawns
 * across the US), one line per lot to stdout, a summary to stderr.
 *
 * HOW, AND WHY THIS WAY:
 *   - NAIP (every leaf-on year, from Microsoft's Planetary Computer) is
 *     60 cm to 1 m, four bands, and dated to the day but not the hour. Each
 *     year is scored on its own against the one lidar model. The hour is FITTED, and so is the photo's offset
 *     from the lidar (NAIP is good to a few meters) -- but only on the
 *     shadows of BUILDINGS, which the lidar gets right whatever the trees
 *     do. The trees are then scored with nothing tuned on them.
 *   - Grass: cells the lidar sees nothing above (open from the sky) that are
 *     green in the photo's near-infrared (NDVI). What shadow looks like in
 *     each photo is taken from the buildings too: grass in a building's full
 *     shadow (S) against grass in full sun (L); brightness runs S + T(L - S)
 *     with the share T of the direct beam, so the photo's shade is under
 *     (S + L) / 2, the same "under half the beam" as the model's shade (at
 *     10 cm up, leaves on, as the page draws summer). A photo whose
 *     buildings' shadows are under 1.8x darker than sun is left out.
 *   - Scores: all grass, and TREE grass -- grass the buildings leave in sun
 *     at that moment, so any shadow there is a tree's. Edges (a cell whose
 *     model neighbors disagree) are counted apart: a 60 cm photo and a 1 m
 *     model will not agree on the exact edge of a shadow.
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { shadeSite, sunDir, beamAt } from './shade-site.js';
import { solarNoon } from '../public/shade/sun.js';

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const CROP = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const HALF_M = 80; // the lot and its neighbors' trees
const SHIFT_M = 6; // NAIP's stated horizontal accuracy is a few meters
const FIT_NEAR_M = 15; // cells this close to a roof fit the time

async function getRetry(u, as = 'json', init = undefined, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, init);
      if (!r.ok) throw new Error(`${r.status}`);
      return as === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${e.message} ${u.slice(0, 120)}`);
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
    }
  }
}

/**
 * Every leaf-on NAIP frame over a point (June to September, four bands, 1 m
 * or finer), newest first: [{ id, date (ms, UTC midnight), gsd }]. From
 * Microsoft's Planetary Computer, which keeps every year (USGS's own
 * service keeps only the newest, and was timing out on 2026-10-12).
 */
async function naipFrames(lng, lat) {
  const d = await getRetry(STAC, 'json', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collections: ['naip'], intersects: { type: 'Point', coordinates: [lng, lat] }, limit: 20 }),
  });
  return (d.features || []).map((f) => ({ id: f.id, date: Date.parse(f.properties.datetime.slice(0, 10)), gsd: f.properties.gsd }))
    .filter((f) => f.gsd <= 1.01 && [5, 6, 7, 8].includes(new Date(f.date).getUTCMonth()))
    .sort((a, b) => b.date - a.date);
}

/** The frame's bands over the model's box, 2 pixels per 1 m cell. */
async function naipImage(frame, box, w, h) {
  const get = async (bands) => PNG.sync.read(await getRetry(
    `${CROP}/${box.join(',')}/${2 * w}x${2 * h}.png?collection=naip&item=${frame.id}&assets=image&asset_bidx=image%7C${bands}&coord_crs=EPSG:3857&dst_crs=EPSG:3857`, 'bytes'));
  const rgb = await get('1,2,3'), nir = await get('4');
  const step = (png) => png.data.length / (png.width * png.height); // RGBA 4, gray+alpha 4 or 2
  const sr = step(rgb), sn = step(nir);
  return {
    w: rgb.width, h: rgb.height,
    rgb: (x, y, c) => rgb.data[(y * rgb.width + x) * sr + c],
    nir: (x, y) => nir.data[(y * nir.width + x) * sn],
    alpha: (x, y) => rgb.data[(y * rgb.width + x) * sr + 3],
  };
}

/** Otsu's cut over values (log space by the caller). */
function otsu(v) {
  const s = [...v].sort((a, b) => a - b), n = s.length;
  const total = s.reduce((a, b) => a + b, 0);
  let best = -1, cut = s[n >> 1], below = 0;
  for (let i = 1; i < n; i++) {
    below += s[i - 1];
    if (s[i] === s[i - 1]) continue;
    const m0 = below / i, m1 = (total - below) / (n - i), b = i * (n - i) * (m1 - m0) ** 2;
    if (b > best) { best = b; cut = (s[i - 1] + s[i]) / 2; }
  }
  const lo = s.filter((x) => x <= cut), hi = s.filter((x) => x > cut);
  const med = (a) => a[a.length >> 1];
  return { cut, contrast: lo.length && hi.length ? Math.exp(med(hi) - med(lo)) : 1 };
}

function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Every leaf-on NAIP year of a lot, each scored against the one lidar model. */
export async function checkLot(lng, lat, { years = 4 } = {}) {
  const frames = (await naipFrames(lng, lat)).slice(0, years);
  if (!frames.length) return [{ lng, lat, skip: 'no leaf-on NAIP' }];
  const site = await shadeSite(lng, lat, { halfM: HALF_M });
  if (!site) return [{ lng, lat, skip: 'no lidar' }];
  const out = [];
  for (const frame of frames) {
    try { out.push(await checkFrame(lng, lat, site, frame)); } catch (e) { out.push({ lng, lat, frame: frame.id, error: e.message }); }
  }
  return out;
}

async function checkFrame(lng, lat, site, frame) {
  const { model, season, box } = site, { w, h, nz } = model;
  const img = await naipImage(frame, box, w, h);

  /* Per cell: brightness and NDVI from its 2 x 2 pixels. */
  const N = w * h, bright = new Float32Array(N), ndvi = new Float32Array(N), seen = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0, a = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const px = 2 * x + i, py = 2 * y + j;
      r += img.rgb(px, py, 0); g += img.rgb(px, py, 1); b += img.rgb(px, py, 2); n += img.nir(px, py); a += img.alpha(px, py);
    }
    const k = y * w + x;
    bright[k] = (0.3 * r + 0.59 * g + 0.11 * b) / 4;
    ndvi[k] = (n - r) / Math.max(1, n + r);
    seen[k] = a > 0 ? 1 : 0;
  }

  /* Grass: open to the sky in the lidar, green in the photo, inside the
     frame with room for the shift. */
  const M = SHIFT_M + 2, grass = [];
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const k = y * w + x;
    if (season.kind[k] === 0 && seen[k] && ndvi[k] > 0.1 && bright[k] > 3) grass.push(k);
  }
  if (grass.length < 300) return { lng, lat, frame: frame.id, skip: `only ${grass.length} grass cells` };

  /* Buildings only: the roof columns of the leaf-off model. */
  const muB = new Float32Array(model.mu.length);
  for (let c = 0; c < N; c++) if (season.kind[c] === 1) for (let l = 0; l < nz; l++) muB[c * nz + l] = model.mu[c * nz + l];
  /* Every open cell the shifted grass could land on. */
  const open = [];
  for (let k = 0; k < N; k++) if (season.kind[k] === 0) open.push(k);
  const where = new Int32Array(N).fill(-1);
  open.forEach((k, i) => { where[k] = i; });

  /* The moment and the offset, from buildings alone: every open cell (grass
     or paving -- a building's shadow is sharpest on a driveway) within
     FIT_NEAR_M of a roof, where at that moment the trees change nothing in
     the model. Trees enter only to leave cells out. */
  const roofNear = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (season.kind[y * w + x] !== 1) continue;
    for (let j = -FIT_NEAR_M; j <= FIT_NEAR_M; j++) for (let i = -FIT_NEAR_M; i <= FIT_NEAR_M; i++) {
      const xx = x + i, yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) roofNear[yy * w + xx] = 1;
    }
  }
  const fitCells = [];
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const k = y * w + x;
    if (season.kind[k] === 0 && seen[k] && roofNear[k] && bright[k] > 3) fitCells.push(k);
  }
  const noon = solarNoon(lng, frame.date + 12 * 3600e3);
  let fit = null;
  for (let dt = -5 * 60; dt <= 5 * 60; dt += 10) {
    const t = noon + dt * 60e3, sun = sunDir(lat, lng, t);
    if (sun.elevation < 15) continue;
    const Tb = beamAt(model, muB, open, sun.dir), Tf = beamAt(model, season.muOn, open, sun.dir);
    for (let dy = -SHIFT_M; dy <= SHIFT_M; dy++) for (let dx = -SHIFT_M; dx <= SHIFT_M; dx++) {
      const m = [], p = [];
      for (const k of fitCells) {
        const j = where[k + dy * w + dx];
        if (j < 0 || Math.abs(Tf[j] - Tb[j]) > 0.05) continue;
        m.push(Tb[j]); p.push(Math.log(bright[k]));
      }
      if (m.length < 200) continue;
      const r = corr(m, p);
      if (!fit || r > fit.r) fit = { r, n: m.length, dt, dx, dy, t, sun };
    }
  }
  if (!fit) return { lng, lat, frame: frame.id, skip: 'too few cells by buildings to fit the time' };

  /* The whole model at that moment, leaves on and bare, and buildings only. */
  const at = (mu) => {
    const T = beamAt(model, mu, open, fit.sun.dir);
    return Float32Array.from(grass, (k) => { const j = where[k + fit.dy * w + fit.dx]; return j >= 0 ? T[j] : 1; });
  };
  const Ton = at(season.muOn), Toff = at(season.muOff), Tb = at(muB);
  const shadeOn = Uint8Array.from(Ton, (v) => (v < 0.5 ? 1 : 0));
  const shadeOff = Uint8Array.from(Toff, (v) => (v < 0.5 ? 1 : 0));

  /* What shadow looks like on grass in THIS photo, from buildings: the
     median brightness of grass in a building's full shadow (S) and of grass
     the model puts in full sun (L). Brightness runs S + T (L - S) with the
     share T of the direct beam, so the photo's "under half the beam" is
     under (S + L) / 2 -- the model's own definition of shade. */
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  const inB = [], lit = [];
  grass.forEach((k, i) => { if (Tb[i] <= 0.1) inB.push(bright[k]); else if (Ton[i] >= 0.95) lit.push(bright[k]); });
  if (inB.length < 20) return { lng, lat, frame: frame.id, skip: `only ${inB.length} grass cells in a building's shadow` };
  const S = med(inB), L = med(lit), contrast = L / S;
  if (!(contrast >= 1.8)) return { lng, lat, frame: frame.id, skip: `buildings' shadows only ${contrast.toFixed(2)}x darker than sun (haze, or a cloud)` };
  const photoT = Float32Array.from(grass, (k) => Math.min(1.2, Math.max(-0.2, (bright[k] - S) / (L - S))));
  const photoShade = Uint8Array.from(photoT, (v) => (v < 0.5 ? 1 : 0));
  /* Edge cells: the model's shadow class differs within one cell. */
  const cls = new Int8Array(N).fill(-1);
  const Tall = beamAt(model, season.muOn, open, fit.sun.dir);
  open.forEach((k, i) => { cls[k] = Tall[i] < 0.5 ? 1 : 0; });
  const edge = Uint8Array.from(grass, (k) => {
    const c = k + fit.dy * w + fit.dx, v = cls[c];
    for (const d of [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1]) { const u = cls[c + d]; if (u >= 0 && u !== v) return 1; }
    return 0;
  });

  const tally = (keep, model01) => {
    const r = { n: 0, photo: 0, model: 0, both: 0, modelOnly: 0, photoOnly: 0, lit: 0 };
    grass.forEach((_, i) => {
      if (!keep(i)) return;
      const p = photoShade[i], m = model01[i];
      r.n++; r.photo += p; r.model += m;
      if (p && m) r.both++; else if (m) r.modelOnly++; else if (p) r.photoOnly++; else r.lit++;
    });
    return r;
  };
  const treeGrass = (i) => Tb[i] >= 0.5;
  /* The share of the beam itself, photo against model, on tree grass. */
  let sm = 0, sp = 0, nT = 0;
  grass.forEach((_, i) => { if (treeGrass(i)) { sm += Ton[i]; sp += Math.min(1, Math.max(0, photoT[i])); nT++; } });
  const local = new Date(fit.t);
  return {
    lng, lat, frame: frame.id, date: new Date(frame.date).toISOString().slice(0, 10), lidar: site.cloud.url.split('/').slice(-2)[0], lidarYear: Math.floor(site.cloud.epoch),
    solarTime: `${dtFmt(fit.dt)} from solar noon`, utc: local.toISOString().slice(11, 16), sunEl: +fit.sun.elevation.toFixed(1), sunAz: +fit.sun.azimuth.toFixed(0),
    shift: [fit.dx, fit.dy], fitR: +fit.r.toFixed(3), fitN: fit.n, sunLux: Math.round(L), shadeLux: Math.round(S), contrast: +contrast.toFixed(2), meanBeamTrees: { model: +(sm / nT).toFixed(3), photo: +(sp / nT).toFixed(3) },
    grass: grass.length,
    all: tally(() => true, shadeOn),
    trees: tally(treeGrass, shadeOn),
    treesInner: tally((i) => treeGrass(i) && !edge[i], shadeOn),
    treesBare: tally(treeGrass, shadeOff),
  };
}
const dtFmt = (m) => `${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}h${String(Math.abs(m) % 60).padStart(2, '0')}`;

/* -------------------------------------------------------------- run */

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || new URL('../data/labelled-crowns.csv', import.meta.url);
  const rows = readFileSync(file, 'utf8').trim().split('\n');
  const head = rows[0].split(',');
  const lots = new Map();
  for (const line of rows.slice(1)) {
    const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const o = Object.fromEntries(head.map((k, i) => [k, cells[i]]));
    const id = (o.corpus_id || `${o.lng},${o.lat}`).split(':')[0];
    if (!lots.has(id)) { const [lng, lat] = id.split(',').map(Number); lots.set(id, [lng, lat]); }
  }
  const list = [...lots.values()];
  const only = Number(process.env.LIMIT) || list.length;
  const sum = { lots: 0, all: {}, trees: {}, treesInner: {}, treesBare: {} };
  const add = (into, r) => { for (const [k, v] of Object.entries(r)) into[k] = (into[k] || 0) + v; };
  let next = 0;
  const worker = async () => {
    while (next < Math.min(only, list.length)) {
      const [lng, lat] = list[next++];
      try {
        for (const r of await checkLot(lng, lat)) {
          process.stdout.write(`${JSON.stringify(r)}\n`);
          if (!r.skip && !r.error) { sum.lots++; for (const k of ['all', 'trees', 'treesInner', 'treesBare']) add(sum[k], r[k]); }
          process.stderr.write(`${lng},${lat}: ${r.skip || r.error || `${r.date} sun ${r.sunEl}° fit ${r.fitR} trees photo ${pct(r.trees.photo, r.trees.n)} model ${pct(r.trees.model, r.trees.n)}`}\n`);
        }
      } catch (e) {
        process.stdout.write(`${JSON.stringify({ lng, lat, error: e.message })}\n`);
        process.stderr.write(`${lng},${lat}: ERROR ${e.message}\n`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  process.stderr.write(`\n${sum.lots} lot-years\n`);
  for (const k of ['all', 'trees', 'treesInner', 'treesBare']) {
    const r = sum[k];
    process.stderr.write(`${k.padEnd(11)} n ${r.n}: photo shade ${pct(r.photo, r.n)}, model ${pct(r.model, r.n)} | agree ${pct(r.both + r.lit, r.n)}; model only (too dark) ${pct(r.modelOnly, r.n)}, photo only (too bright) ${pct(r.photoOnly, r.n)}\n`);
  }
}
function pct(a, n) { return n ? `${(100 * a / n).toFixed(1)}%` : '-'; }
