/**
 * HOW LONG THE LIVE MODEL SPENDS ON EACH PART OF A LOT (owner, 2026-10-07:
 * "measure" -- before deciding whether averaging three decoders, H83, is worth
 * its cost). Sends a few approved lots straight to the live server on Modal,
 * exactly as the Worker would, and prints the server's own per-stage seconds:
 * the backbone (Scale-MAE), the tree canopy model, and the decoder + edge
 * refiner. Nothing is saved anywhere; it costs the GPU seconds it reports.
 *
 * An average of k decoders repeats only the decoder step, so its extra cost
 * per lot is about (k - 1) x that step.
 *
 *   ALPHA_URL, ALPHA_RESULT_URL, ALPHA_TOKEN, MAPBOX_TOKEN, LOTS=B01,C41,...
 *   node tools/time-alpha.js        (workflow 32)
 *
 * MAP="lng,lat" (2026-10-23) times one of the owner's saved maps instead, on
 * the photo it was saved with (a county export in tiles, as the editor sends
 * it): the way to see what a release that reads big lots at 10 cm costs on
 * the biggest one. Its address is never printed, only its size and seconds.
 */
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { pressPlan, pressBody, imageryUrl } from '../worker/src/imagery.js';
import { mapName } from '../worker/src/benchmark-ids.js';

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-lot seconds into a summary: medians of each stage, and the decoder's share. */
export function summarise(rows) {
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const pick = (k) => rows.map((r) => Number(r.seconds?.[k]));
  const out = { lots: rows.length };
  for (const k of ['total', 'waited', 'backbone', 'canopy', 'decoder', 'downloads']) out[k] = med(pick(k));
  const shares = rows.map((r) => Number(r.seconds?.decoder) / Number(r.seconds?.total)).filter(Number.isFinite);
  out.decoderShareOfTotal = med(shares);
  return out;
}

/** One lot through start/result, until it answers or `limitMs` runs out. */
async function runLot(env, r, limitMs) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` };
  const plan = pressPlan(parse(r.frame), (f) => imageryUrl('mapbox', f, env.MAPBOX_TOKEN, env));
  const t0 = Date.now();
  const res = await fetch(env.ALPHA_URL, { method: 'POST', headers, body: JSON.stringify(pressBody(plan, { parcel: parse(r.parcel) })) });
  if (!res.ok) return { got: { status: `start HTTP ${res.status}` }, wall: 0 };
  const { id } = await res.json();
  let got = null;
  while (Date.now() - t0 < limitMs) {
    await sleep(2000);
    const p = await fetch(`${env.ALPHA_RESULT_URL}?id=${encodeURIComponent(id)}`, { headers }).catch(() => null);
    if (!p?.ok) continue;
    const b = await p.json();
    if (b.status === 'running') continue;
    got = b;
    break;
  }
  if (!got && env.ALPHA_CANCEL_URL) {
    await fetch(`${env.ALPHA_CANCEL_URL}?id=${encodeURIComponent(id)}`, { method: 'POST', headers }).catch(() => {});
  }
  return { got, wall: Math.round((Date.now() - t0) / 1000) };
}

/**
 * THE WARM PRESS AT THE END OF A DEPLOY (owner, 2026-10-08). The first press
 * after a deploy has sat queued on Modal for minutes while the next one
 * answered at once, so the deploy now makes that first press itself, with
 * nobody waiting on it. Same as the app: given up at 100 s and sent once more.
 * Prints one line for the deploy's tail and never fails the deploy.
 */
export async function warm(env = process.env) {
  const name = String(env.LOTS || 'B01').split(',')[0].trim();
  const rows = query(`SELECT id, lot_no, frame, parcel FROM corpus WHERE status = 'approved' AND frame IS NOT NULL`);
  const r = rows.find((x) => mapName(x.id, x.lot_no) === name);
  if (!r) return `not warmed: lot ${name} not found`;
  const first = await runLot(env, r, 100000);
  if (first.got?.status === 'succeeded') return `warm -- the first press answered in ${first.wall}s`;
  const second = await runLot(env, r, 240000);
  if (second.got?.status === 'succeeded') {
    return `warm -- the first press stuck (${first.got?.status || 'no answer'} after ${first.wall}s); `
      + `sent again, it answered in ${second.wall}s`;
  }
  return `NOT warm -- two presses, no answer (${second.got?.status || 'timed out'} ${second.got?.error || ''}). `
    + 'The app retries a stuck press itself, but check Modal.';
}

/** One saved map, by its coordinates, through the live server; prints its seconds. */
async function timeMap(env) {
  const { parseLngLat, nearestMap, mapsOfRows, pressFor, svcOfRow } = await import('./draw-map.mjs');
  const asked = parseLngLat(env.MAP);
  const maps = mapsOfRows(query("SELECT m.key, m.lng, m.lat, m.payload, m.updated_at FROM maps m JOIN users u ON u.id = m.user_id WHERE u.role = 'admin'"));
  const hit = nearestMap(maps, asked);
  if (!hit) throw new Error(`no saved map within 150 m of ${asked.join(',')}`);
  const map = hit.map;
  const svc = map.provider === 'county' && map.countySvc
    ? svcOfRow(query(`SELECT * FROM county_services WHERE id = ${Number(map.countySvc)}`)[0]) : null;
  const body = pressFor(map, env.SITE || '', { svc, mapboxToken: env.MAPBOX_TOKEN || '' });
  const { provider, groundCm, pieces, photoFrom, ...press } = body;
  console.log(`The saved map ${Math.round(hit.d)} m from the point asked: ${provider} photo from ${photoFrom} at ${groundCm} cm a pixel in ${pieces} piece(s).`);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` };
  const patches = /^(1|on|true)$/i.test(env.PATCHES || '');
  for (const round of patches ? ['the press'] : ['first (cold or warm)', 'second (warm)']) {
    const t0 = Date.now();
    const res = await fetch(env.ALPHA_URL, { method: 'POST', headers, body: JSON.stringify(press) });
    if (!res.ok) { console.log(`${round}: start HTTP ${res.status}`); continue; }
    const { id } = await res.json();
    let got = null;
    let stage = null;
    while (Date.now() - t0 < 600000) {
      await sleep(2000);
      const p = await fetch(`${env.ALPHA_RESULT_URL}?id=${encodeURIComponent(id)}`, { headers });
      if (!p.ok) continue;
      const b = await p.json();
      if (b.status === 'running') {
        if (b.stage && b.stage !== stage) { stage = b.stage; console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s  ${stage}`); }
        continue;
      }
      got = b;
      break;
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    if (got?.status !== 'succeeded') { console.log(`${round}: ${got?.status || 'timed out'} ${got?.error || ''}`); continue; }
    console.log(`${round}: ${got.w}x${got.h} cells, wall ${wall}s, server ${JSON.stringify(got.seconds)}${got.windows ? `, read in ${got.windows} window(s)` : ''}`);
    if (got.prob) {
      try {
        const { PNG } = await import('pngjs');
        const img = PNG.sync.read(Buffer.from(got.prob, 'base64'));
        const b = banding(img.data, img.width, img.height);
        console.log(`  raw mask ${img.width}x${img.height}: lawn in ${(b.lawn * 100).toFixed(1)}% of it; row-to-row change ${b.rows.toFixed(3)}, `
          + `column-to-column ${b.cols.toFixed(3)}, ratio ${b.ratio.toFixed(2)}${b.ratio > 3 ? '  <-- STRIPES' : ' (no stripes)'}`);
      } catch (e) {
        console.log(`  raw mask not read: ${e.message}`);
      }
    }
    if (patches) await explainPatches(got, press, env.OUT || 'press-out');
  }
}

/*
 * WHY A PATCH WAS LEFT OUT (owner, 2026-10-24, the condo: "some of those
 * small areas didn't make it into the final trace. Is that because our
 * parameters for sizes of areas are too strict? Or is it because the raw
 * mask isn't as confident?"). Every patch the decoder thinks at least a
 * little is lawn, inside the property line and smaller than a yard, with
 * its size, how sure the decoder was, how much of it is tree canopy or
 * lidar roof, and how much the served mask kept; and the whole lot's lawn
 * at each cut the page's slider offers. Pictures go to OUT for the artifact.
 */
export const PATCH_CUT = 77;        // 30%: the patches worth asking about
export const PATCH_MAX_SQFT = 3000; // bigger is the main lawn, not a patch
const SQFT_PER_M2 = 10.7639;

/** 8-connected pieces of a 0/1 mask: a label per cell (0 = none) and the count. */
export function pieces(mask, w, h) {
  const label = new Int32Array(w * h);
  let n = 0;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    label[i] = ++n;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop();
      const x = c % w, y = (c / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (mask[k] && !label[k]) { label[k] = n; stack.push(k); }
      }
    }
  }
  return { label, n };
}

/**
 * The patches: pieces of (decoder >= cut, inside the lot) between minSqFt and
 * maxSqFt, each with its share of cells at 50% and above, its mean
 * confidence, its share under canopy, under lidar roof or void, and its share
 * the served mask kept; biggest first.
 */
export function patchReport({ probGrey, final, canopy, roof, voidMask, within, w, h, mpp, cut = PATCH_CUT, minSqFt = 20, maxSqFt = PATCH_MAX_SQFT }) {
  const cand = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) cand[i] = probGrey[i] >= cut && (!within || within[i]) ? 1 : 0;
  const { label, n } = pieces(cand, w, h);
  const acc = Array.from({ length: n + 1 }, () => ({ cells: 0, sure: 0, sum: 0, canopy: 0, veto: 0, kept: 0, sx: 0, sy: 0 }));
  for (let i = 0; i < w * h; i++) {
    const l = label[i];
    if (!l) continue;
    const a = acc[l];
    a.cells++; a.sum += probGrey[i]; a.sx += i % w; a.sy += (i / w) | 0;
    if (probGrey[i] >= 128) a.sure++;
    if (canopy?.[i]) a.canopy++;
    if (roof?.[i] || voidMask?.[i]) a.veto++;
    if (final?.[i]) a.kept++;
  }
  const sqft = mpp * mpp * SQFT_PER_M2;
  return acc.slice(1).map((a) => ({
    sqft: a.cells * sqft,
    meanPct: Math.round((a.sum / a.cells / 255) * 100),
    surePct: Math.round((a.sure / a.cells) * 100),
    canopyPct: Math.round((a.canopy / a.cells) * 100),
    vetoPct: Math.round((a.veto / a.cells) * 100),
    keptPct: Math.round((a.kept / a.cells) * 100),
    keptSqFt: a.kept * sqft,
    at: [Math.round((a.sx / a.cells) * mpp), Math.round((a.sy / a.cells) * mpp)],
  })).filter((p) => p.sqft >= minSqFt && p.sqft <= maxSqFt).sort((x, y) => y.sqft - x.sqft);
}

/** Why each patch of a press was kept or dropped, printed, and its pictures saved. */
async function explainPatches(got, press, out) {
  const { PNG } = await import('pngjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { finishLot, canopyMask } = await import('../public/lib/finish.js');
  const { parcelMask } = await import('./serve-alpha.mjs');
  mkdirSync(out, { recursive: true });
  const read = (b64) => (b64 ? PNG.sync.read(Buffer.from(b64, 'base64')) : null);
  const save = (name, b64) => { if (b64) writeFileSync(`${out}/${name}.png`, Buffer.from(b64, 'base64')); };
  save('prob', got.prob); save('final', got.mask);
  for (const [k, v] of Object.entries(got.parts || {})) save(k, v);
  const prob = read(got.prob);
  if (!prob) { console.log('  no decoder picture came back: the server is older than this tool'); return; }
  if (!got.parts?.canopy) console.log('  NOTE: no canopy picture came back (server not yet redeployed?); canopy shares read 0');
  const w = prob.width, h = prob.height;
  const mpp = Number(got.mpp) || null;
  if (!mpp) { console.log('  no grid size came back; cannot measure in sq ft'); return; }
  const probGrey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) probGrey[i] = prob.data[i * 4];
  const finalPng = read(got.mask);
  const final = finalPng ? canopyMask(finalPng, w, h) : null;
  const canopyPng = read(got.parts?.canopy), roofPng = read(got.parts?.roof), voidPng = read(got.parts?.void);
  const canopy = canopyPng ? canopyMask(canopyPng, w, h) : null;
  const roof = roofPng ? canopyMask(roofPng, w, h) : null;
  const voidMask = voidPng ? canopyMask(voidPng, w, h) : null;
  const within = parcelMask(press.parcel, press.frame, w, h);
  const sqft = mpp * mpp * SQFT_PER_M2;
  const inLot = (m) => { let n = 0; for (let i = 0; i < w * h; i++) if (m[i] && (!within || within[i])) n++; return n * sqft; };
  console.log(`  grid ${w}x${h} at ${(mpp * 100).toFixed(1)} cm; lot ${within ? Math.round(inLot(new Uint8Array(w * h).fill(1))) : '?'} sq ft`);
  console.log('  LAWN IN THE LOT AT EACH CUT (the page\'s slider; the page then drops pieces under 100 sq ft):');
  for (const pct of [20, 30, 40, 50, 60, 70, 80]) {
    const m = finishLot({ prob, canopy: canopyPng, roof: roofPng, voidMask: voidPng, height: null, w, h, mpp, threshold: Math.round((pct * 255) / 100) });
    console.log(`    ${String(pct).padStart(2)}%  ${Math.round(inLot(m)).toLocaleString('en-US').padStart(8)} sq ft${pct === 50 ? '   <- as served' : ''}`);
  }
  const report = patchReport({ probGrey, final, canopy, roof, voidMask, within, w, h, mpp });
  console.log(`  PATCHES the decoder is at least 30% sure of, ${PATCH_MAX_SQFT.toLocaleString('en-US')} sq ft and under, inside the lot (${report.length}):`);
  console.log('     sq ft  mean sure  >=50%  canopy  roof/void  served kept   where (m from top-left)');
  const whyOf = (p) => (p.keptPct >= 50 ? 'kept'
    : p.vetoPct >= 50 ? 'lidar veto'
      : p.surePct < 50 && p.canopyPct >= 30 ? 'under canopy, unsure'
        : p.surePct < 50 ? 'unsure'
          : p.canopyPct >= 30 ? 'tree step cleared it'
            : p.sqft < 100 ? 'too small' : '?');
  /* Every reason with its count and ground, then every small patch: the
     first press listed only the 40 biggest, all kept (2026-10-24). */
  const byWhy = new Map();
  for (const p of report) {
    const k = whyOf(p);
    const b = byWhy.get(k) || { n: 0, sqft: 0 };
    b.n++; b.sqft += p.sqft;
    byWhy.set(k, b);
  }
  console.log('  BY REASON:');
  for (const [k, b] of [...byWhy].sort((x, y) => y[1].n - x[1].n)) console.log(`    ${k.padEnd(22)} ${String(b.n).padStart(4)} patches  ${Math.round(b.sqft).toLocaleString('en-US').padStart(8)} sq ft`);
  const small = report.filter((p) => p.sqft <= 400);
  console.log(`  EVERY PATCH OF 400 sq ft AND UNDER (${small.length}), biggest first:`);
  console.log('     sq ft  mean sure  >=50%  canopy  roof/void  served kept   where (m from top-left)');
  for (const p of [...report.filter((q) => q.sqft > 400).slice(0, 10), ...small]) {
    const why = whyOf(p);
    console.log(`    ${Math.round(p.sqft).toString().padStart(6)}  ${String(p.meanPct).padStart(5)}%  ${String(p.surePct).padStart(8)}%  ${String(p.canopyPct).padStart(5)}%  `
      + `${String(p.vetoPct).padStart(7)}%  ${String(p.keptPct).padStart(7)}%  (${p.at[0]}, ${p.at[1]})  ${why}`);
  }
  writeFileSync(`${out}/patches.json`, JSON.stringify({ mpp, w, h, report }, null, 1));
}

/*
 * STRIPES, MEASURED (2026-10-24: the condo complex came back as horizontal
 * bands when the live server unpacked a native read by the wrong grid). The
 * lawn share of each row and of each column, and how much it changes from one
 * to the next: a real lawn changes about as much either way; bands across the
 * lot make rows jump while columns barely move.
 */
export function banding(rgba, w, h) {
  const at = (x, y) => (rgba[(y * w + x) * 4] >= 128 ? 1 : 0);
  const rows = new Float64Array(h);
  const cols = new Float64Array(w);
  let lawn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { const v = at(x, y); rows[y] += v; cols[x] += v; lawn += v; }
  }
  for (let y = 0; y < h; y++) rows[y] /= w;
  for (let x = 0; x < w; x++) cols[x] /= h;
  const step = (a) => { let s = 0; for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]); return a.length > 1 ? s / (a.length - 1) : 0; };
  const r = step(rows), c = step(cols);
  return { lawn: lawn / (w * h), rows: r, cols: c, ratio: c > 0 ? r / c : (r > 0 ? Infinity : 1) };
}

/*
 * THE SERVING GRID, COMPARED (owner, 2026-10-24: "That's detail being thrown
 * away"; S64). Every approved lot big enough that the training cap (1024
 * cells across) coarsens its grid is pressed twice on the live server: as
 * served, and with `gridMax` FINE_GRID. Both answers (the finished mask, as
 * the page receives it) are judged against the traced lawn on the FINE grid
 * inside the property line, the coarse one read by nearest cell, so the same
 * truth at the same resolution scores both. Wrong ground as a share of the
 * true lawn, as everywhere in this project.
 */
export const FINE_GRID = 3072;

/** A w x h mask read onto W x H cells by nearest cell (both cover the same frame). */
export function upsample(mask, w, h, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) out[y * W + x] = mask[sy * w + Math.min(w - 1, Math.floor((x * w) / W))];
  }
  return out;
}

/** Wrong cells over true-lawn cells, inside `within`. */
export function wrongShare(got, truth, within) {
  let wrong = 0, lawn = 0;
  for (let i = 0; i < truth.length; i++) {
    if (within && !within[i]) continue;
    if (truth[i]) lawn++;
    if (got[i] !== truth[i]) wrong++;
  }
  return { wrong, lawn, pct: lawn ? (100 * wrong) / lawn : null };
}

/** Two-sided sign test p for `better` against `worse`, ties dropped. */
export function signTest(better, worse) {
  const n = better + worse;
  if (!n) return 1;
  const k = Math.min(better, worse);
  let p = 0, c = 1;
  for (let i = 0; i <= n; i++) { if (i > 0) c = (c * (n - i + 1)) / i; if (i <= k) p += c; }
  return Math.min(1, (2 * p) / 2 ** n);
}

async function pressOnce(env, body, label) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` };
  const t0 = Date.now();
  const res = await fetch(env.ALPHA_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.log(`  ${label}: start HTTP ${res.status}`); return null; }
  const { id } = await res.json();
  while (Date.now() - t0 < 600000) {
    await sleep(3000);
    const p = await fetch(`${env.ALPHA_RESULT_URL}?id=${encodeURIComponent(id)}`, { headers });
    if (!p.ok) continue;
    const b = await p.json();
    if (b.status === 'running') continue;
    if (b.status !== 'succeeded') { console.log(`  ${label}: ${b.status} ${b.error || ''}`); return null; }
    return { ...b, wall: (Date.now() - t0) / 1000 };
  }
  console.log(`  ${label}: timed out`);
  return null;
}

async function compareGrids(env) {
  const { PNG } = await import('pngjs');
  const { gridDims } = await import('./train-detector.js');
  const { rasterizePolygon } = await import('../public/lib/mask.js');
  const geometriesOf = (stored) => (Array.isArray(stored) ? stored : stored?.features || [])
    .map((g) => (g?.geometry ? g.geometry : g)).filter((g) => g && g.type);
  const maskOf = (geoms, w, h, project) => {
    const out = new Uint8Array(w * h);
    for (const g of geoms) {
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polys) { const m = rasterizePolygon(rings, w, h, project); for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1; }
    }
    return out;
  };
  const { lngLatToFramePx } = await import('../public/lib/mercator.js');
  const { serveCap } = await import('./serve-alpha.mjs');
  const rows = query(`SELECT id, lot_no, frame, image_frame, parcel, shapes FROM corpus WHERE status = 'approved' AND frame IS NOT NULL`);
  const fine = serveCap(FINE_GRID);
  const lots = rows.map((r) => ({ r, frame: parse(r.image_frame) || parse(r.frame) }))
    .filter(({ frame }) => frame)
    .map((x) => ({ ...x, plan: pressPlan(x.frame, (f) => imageryUrl('mapbox', f, env.MAPBOX_TOKEN, env)) }))
    .filter(({ plan }) => {
      const a = gridDims(plan.frame), b = gridDims(plan.frame, undefined, fine);
      return Math.max(b.w, b.h) > Math.max(a.w, a.h);
    })
    .slice(0, Number(env.GRID_LOTS_MAX || 30));
  console.log(`${lots.length} approved lot(s) the training cap coarsens; each pressed as served and at ${fine} cells.`);
  const read = (b64) => { const p = PNG.sync.read(Buffer.from(b64, 'base64')); const m = new Uint8Array(p.width * p.height); for (let i = 0; i < m.length; i++) m[i] = p.data[i * 4] >= 128 ? 1 : 0; return { m, w: p.width, h: p.height }; };
  const out = [];
  for (const { r, plan } of lots) {
    const name = mapName(r.id, r.lot_no);
    const body = pressBody(plan, { parcel: parse(r.parcel) });
    const a = await pressOnce(env, body, `${name} as served`);
    const b = a && await pressOnce(env, { ...body, gridMax: fine }, `${name} at ${fine}`);
    if (!a?.mask || !b?.mask) continue;
    const A = read(a.mask), B = read(b.mask);
    const project = (ll) => lngLatToFramePx(plan.frame, ll, B.w, B.h);
    const truth = maskOf(geometriesOf(parse(r.shapes)), B.w, B.h, project);
    const parcel = parse(r.parcel);
    const within = parcel ? maskOf([parcel.geometry || parcel], B.w, B.h, project) : null;
    const coarse = wrongShare(upsample(A.m, A.w, A.h, B.w, B.h), truth, within);
    const fineS = wrongShare(B.m, truth, within);
    const cm = (g) => (Number(g.mpp) ? `${Math.round(Number(g.mpp) * 100)} cm` : `${A.w}`);
    console.log(`${name.padEnd(5)} ${A.w}x${A.h} (${cm(a)}) ${coarse.pct?.toFixed(1)}%  ->  ${B.w}x${B.h} (${cm(b)}) ${fineS.pct?.toFixed(1)}%`
      + `   GPU ${a.seconds?.total}s -> ${b.seconds?.total}s, decoder ${a.seconds?.decoder}s -> ${b.seconds?.decoder}s`);
    out.push({ name, coarse: coarse.pct, fine: fineS.pct, sec: [a.seconds, b.seconds] });
  }
  const ok = out.filter((o) => o.coarse !== null && o.fine !== null);
  const d = ok.map((o) => o.fine - o.coarse).sort((x, y) => x - y);
  const better = ok.filter((o) => o.fine < o.coarse - 0.5).length, worse = ok.filter((o) => o.fine > o.coarse + 0.5).length;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  console.log(`\nTHE FINER GRID OVER ${ok.length} LOTS: ${better} better / ${worse} worse / ${ok.length - better - worse} level (half a point), `
    + `median ${med(ok.map((o) => o.coarse)).toFixed(1)}% -> ${med(ok.map((o) => o.fine)).toFixed(1)}%, median change ${(d[d.length >> 1] ?? NaN).toFixed(2)}, `
    + `sign test p ${signTest(better, worse).toFixed(3)}.`);
}

async function main(env = process.env) {
  if (/^(1|on|true)$/i.test(env.GRIDS || '')) return compareGrids(env);
  if (env.MAP) return timeMap(env);
  const names = String(env.LOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = query(`SELECT id, lot_no, frame, parcel FROM corpus WHERE status = 'approved' AND frame IS NOT NULL`);
  const lots = rows.filter((r) => names.includes(mapName(r.id, r.lot_no)));
  if (!lots.length) throw new Error(`none of ${names.join(', ')} found`);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` };
  const results = [];
  for (const r of lots) {
    const name = mapName(r.id, r.lot_no);
    const plan = pressPlan(parse(r.frame), (f) => imageryUrl('mapbox', f, env.MAPBOX_TOKEN, env));
    const t0 = Date.now();
    const res = await fetch(env.ALPHA_URL, { method: 'POST', headers, body: JSON.stringify(pressBody(plan, { parcel: parse(r.parcel) })) });
    if (!res.ok) { console.log(`${name}: start HTTP ${res.status}`); continue; }
    const { id } = await res.json();
    let got = null;
    let stage = null;
    while (Date.now() - t0 < 300000) {
      await sleep(2000);
      const p = await fetch(`${env.ALPHA_RESULT_URL}?id=${encodeURIComponent(id)}`, { headers });
      if (!p.ok) continue;
      const b = await p.json();
      if (b.status === 'running') {
        /* The server's own line about where the lot has got to (2026-10-22),
           printed as it changes: what the app shows while a person waits. */
        if (b.stage && b.stage !== stage) { stage = b.stage; console.log(`  ${name} ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s  ${stage}`); }
        continue;
      }
      got = b;
      break;
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    if (got?.status !== 'succeeded') { console.log(`${name}: ${got?.status || 'timed out'} ${got?.error || ''}`); continue; }
    console.log(`${name.padEnd(4)} ${String(got.w)}x${got.h} cells  wall ${wall}s  server ${JSON.stringify(got.seconds)}`);
    results.push({ name, seconds: got.seconds });
  }
  const s = summarise(results.slice(1)); // the first carries the cold start's waiting
  console.log(`\nMedians over ${s.lots} warm lots (the first lot left out): total ${s.total}s, `
    + `backbone ${s.backbone}s, canopy ${s.canopy}s, decoder + refiner ${s.decoder}s, downloads waited ${s.waited}s.`);
  /* What the GPU is billed for is `total`: the time inside detect. Since
     2026-10-08 the downloads run first on a CPU (modal_serve.py `lot`), so
     `waited` should be near zero and `downloads` is the CPU's share. */
  console.log(`GPU seconds per warm lot: ${s.total}s (of which waiting on downloads ${s.waited}s). `
    + `Downloads on the CPU before the GPU was asked: ${s.downloads ?? 'not reported (older server)'}s.`);
  console.log(`Decoder + refiner = ${Math.round((s.decoderShareOfTotal ?? NaN) * 100)}% of a lot's server time. `
    + `Averaging 3 decoders would add about 2 x ${s.decoder}s = ${(2 * s.decoder).toFixed(1)}s a lot `
    + `(${Math.round(((2 * s.decoder) / s.total) * 100)}% more), less if the decoder step includes work done once.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.WARM) {
    warm().then((line) => console.log(line))
      .catch((e) => console.log(`not warmed: ${e.message}`));
  } else {
    main().catch((e) => { console.error(e.message); process.exitCode = 1; });
  }
}
