/**
 * FEEDBACK LOOP 2: rank the tracing queue by how unsure the trained model is.
 *
 *   node tools/score-queue.js plan  > lots.jsonl     which lots, and what to send
 *   python3 tools/score_queue_modal.py lots.jsonl scores.jsonl   (Modal: COSTS MONEY)
 *   node tools/score-queue.js write < scores.jsonl   writes lawn_jobs.uncertainty
 *
 * Workflow 26 runs all three. The queue (routes-jobs.js, claimFor) then hands
 * out the least sure lots first.
 *
 * WHY THE LEAST SURE. A lot the model already reads well is a lot a tracer
 * spends five minutes confirming, and training on it teaches the model what
 * it knew. The lots it cannot decide about are where a correction moves it.
 * "Unsure" is the share of the lot it put between 20% and 80% lawn
 * (serve-alpha.mjs, uncertaintyOf) -- a number to sort by, not a
 * calibrated probability.
 *
 * EACH LOT IS FRAMED AS THE APP FRAMES IT: the county's parcel, its box plus
 * ten metres, 640 logical pixels on the long side (frameFor, as app.js calls
 * it), then the corpus's 10 cm capture of that (captureFrame). That is what a
 * tracer will be shown and what the model was trained on, so the number is
 * about the picture that will actually be traced.
 *
 * Only approved rows nobody has claimed, and only those not already scored by
 * this release. Env: LIMIT (default 40), RELEASE (the release's trainedAt,
 * from workflow 26), MAPBOX_TOKEN.
 */

import { readFileSync } from 'node:fs';
import { query, resolveDatabase } from './corpus-db.js';
import { queryCounty } from '../worker/src/parcel.js';
import { VERIFIED_COUNTIES } from '../worker/src/counties-verified.js';
import { frameFor, geometryBounds } from '../public/lib/mercator.js';
import { captureFrame, imageryUrl } from '../worker/src/imagery.js';

const FRAME_SIZE = 640;
const FRAME_MARGIN_M = 10;

/* Everything that goes into SQL here is checked to be one of these shapes;
   corpus-db's query takes a string, so nothing unchecked may reach it. */
const ID = /^[A-Za-z0-9-]{8,64}$/;
const VERSION = /^[0-9T:Z.-]{10,32}$/;

export const keyForFips = (fips) =>
  Object.keys(VERIFIED_COUNTIES).find((k) => VERIFIED_COUNTIES[k]?.fips === fips) || null;

/** The display frame the app would fit to this parcel, and the capture of it. */
export function lotFrames(parcel) {
  const bbox = geometryBounds(parcel);
  const display = frameFor(bbox, FRAME_SIZE, { marginM: FRAME_MARGIN_M });
  return { display, shot: captureFrame(display) };
}

/** The UPDATE for one scored lot, or null when anything about it is off. */
export function updateFor(score, now) {
  if (!score || !ID.test(String(score.id))) return null;
  const u = Number(score.uncertainty);
  if (!Number.isFinite(u) || u < 0 || u > 1) return null;
  const v = VERSION.test(String(score.version || '')) ? `'${score.version}'` : 'NULL';
  return `UPDATE lawn_jobs SET uncertainty = ${u.toFixed(4)}, scored_model = ${v}, `
    + `scored_at = '${now}' WHERE id = '${score.id}'`;
}

async function plan() {
  const limit = Math.max(1, Math.min(500, Number(process.env.LIMIT || 40)));
  const release = String(process.env.RELEASE || '');
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN is needed to build the photograph URLs');
  resolveDatabase(true);
  const fresh = VERSION.test(release) ? `AND (scored_model IS NULL OR scored_model != '${release}')` : '';
  const rows = query(`SELECT id, lng, lat, fips, county FROM lawn_jobs
                       WHERE state = 'approved' ${fresh}
                       ORDER BY (uncertainty IS NULL) DESC, RANDOM() LIMIT ${limit}`);
  console.error(`${rows.length} queued lots to score${release ? ` against release ${release}` : ''}.`);
  let sent = 0;
  for (const r of rows) {
    const key = keyForFips(r.fips);
    if (!key || !ID.test(String(r.id))) { console.error(`  ${r.id}: no verified county for ${r.fips}; skipped`); continue; }
    let parcel = null;
    try {
      parcel = await queryCounty(key, Number(r.lng), Number(r.lat));
    } catch (e) {
      console.error(`  ${r.id}: parcel lookup failed (${e.message}); skipped`);
      continue;
    }
    if (!parcel?.geometry) { console.error(`  ${r.id}: no parcel there any more; skipped`); continue; }
    const { shot } = lotFrames(parcel);
    const imageUrl = imageryUrl('mapbox', shot.frame, token, {});
    process.stdout.write(`${JSON.stringify({ id: r.id, imageUrl, frame: shot.frame, parcel: parcel.geometry })}\n`);
    sent++;
  }
  console.error(`${sent} lots ready for the model.`);
}

function write() {
  const now = new Date().toISOString();
  const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const updates = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .map((s) => updateFor(s, now)).filter(Boolean);
  if (!updates.length) { console.log('Nothing to write.'); return; }
  resolveDatabase(true);
  /* A few at a time: one wrangler call each is slow, one for everything is
     a command line nobody can read back when it fails. */
  for (let i = 0; i < updates.length; i += 20) query(updates.slice(i, i + 20).join('; '));
  const top = query(`SELECT id, county, uncertainty FROM lawn_jobs WHERE state = 'approved'
                      AND uncertainty IS NOT NULL ORDER BY uncertainty DESC LIMIT 5`);
  console.log(`Wrote ${updates.length} scores. The queue now starts with:`);
  for (const t of top) console.log(`  ${t.county || '?'}: ${(Number(t.uncertainty) * 100).toFixed(1)}% of the lot unsure`);
}

if (process.argv[1] && process.argv[1].endsWith('score-queue.js')) {
  const cmd = process.argv[2];
  (cmd === 'plan' ? plan() : cmd === 'write' ? Promise.resolve(write()) : Promise.reject(new Error('usage: score-queue.js plan|write')))
    .catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}
