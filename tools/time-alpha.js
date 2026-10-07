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
 */
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { liveCaptureFrame, imageryUrl } from '../worker/src/imagery.js';
import { mapName } from '../worker/src/benchmark-ids.js';

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-lot seconds into a summary: medians of each stage, and the decoder's share. */
export function summarise(rows) {
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const pick = (k) => rows.map((r) => Number(r.seconds?.[k]));
  const out = { lots: rows.length };
  for (const k of ['total', 'waited', 'backbone', 'canopy', 'decoder']) out[k] = med(pick(k));
  const shares = rows.map((r) => Number(r.seconds?.decoder) / Number(r.seconds?.total)).filter(Number.isFinite);
  out.decoderShareOfTotal = med(shares);
  return out;
}

async function main(env = process.env) {
  const names = String(env.LOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = query(`SELECT id, lot_no, frame, parcel FROM corpus WHERE status = 'approved' AND frame IS NOT NULL`);
  const lots = rows.filter((r) => names.includes(mapName(r.id, r.lot_no)));
  if (!lots.length) throw new Error(`none of ${names.join(', ')} found`);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` };
  const results = [];
  for (const r of lots) {
    const name = mapName(r.id, r.lot_no);
    const shot = liveCaptureFrame(parse(r.frame));
    const imageUrl = imageryUrl('mapbox', shot.frame, env.MAPBOX_TOKEN, env);
    const t0 = Date.now();
    const res = await fetch(env.ALPHA_URL, { method: 'POST', headers, body: JSON.stringify({ imageUrl, frame: shot.frame, parcel: parse(r.parcel) }) });
    if (!res.ok) { console.log(`${name}: start HTTP ${res.status}`); continue; }
    const { id } = await res.json();
    let got = null;
    while (Date.now() - t0 < 300000) {
      await sleep(2000);
      const p = await fetch(`${env.ALPHA_RESULT_URL}?id=${encodeURIComponent(id)}`, { headers });
      if (!p.ok) continue;
      const b = await p.json();
      if (b.status === 'running') continue;
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
  console.log(`Decoder + refiner = ${Math.round((s.decoderShareOfTotal ?? NaN) * 100)}% of a lot's server time. `
    + `Averaging 3 decoders would add about 2 x ${s.decoder}s = ${(2 * s.decoder).toFixed(1)}s a lot `
    + `(${Math.round(((2 * s.decoder) / s.total) * 100)}% more), less if the decoder step includes work done once.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
