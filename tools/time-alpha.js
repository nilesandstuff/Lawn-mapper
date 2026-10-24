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
  for (const round of ['first (cold or warm)', 'second (warm)']) {
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
  }
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

async function main(env = process.env) {
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
