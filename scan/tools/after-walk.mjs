/**
 * WHAT A NEW WALK SETS GOING, BY ITSELF (core session, 2026-11-26; workflow "S4. After a walk"). The owner, 2026-11-25:
 * "Each walk should be an update to both the reference (when it's a good walk) and the fused map." The page adds a
 * walk to the reference at its end. The ground's colours and the plants were made only when the core session ran a
 * task by hand, one walk replacing the last. Now, every hour:
 *
 *   plan    the walks of the last few days that have settled (nothing new kept for half an hour), by their map; a map
 *           with a walk its marker (auto/<map>.json in the twin bucket) does not name is due. Its line in the plan:
 *           the new walks and the ones the marker names, newest first, six at the most.
 *   done    the marker written, after the workflow pooled those walks' plants and ground and kept them with the map.
 *   adopt   a walk that names no map takes another walk's (the walk of 2026-11-24 22:04 began before the page had
 *           its map); its meta.json as it was is kept beside it as meta-before.json.
 *
 *   node scan/tools/after-walk.mjs plan [out file]
 *   node scan/tools/after-walk.mjs done <walk,walk,...|left,left,...> <the first walk's twin dir> [placed.txt]
 *   node scan/tools/after-walk.mjs adopt <walk> <walk whose map it takes>
 *
 * Prints walk ids, counts and times only: a map's id is a place, and this log is public.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET, API, account, list, readObject, writeObject, walkOk } from './twin-r2.mjs';

import { SETTLED_MS, RECENT_MS, POOL_MAX, FROM_MS, prefixesOf, planOf, markerOf } from '../lib/afterplan.js';
export { SETTLED_MS, RECENT_MS, POOL_MAX, FROM_MS, prefixesOf, planOf, markerOf };

const json = async (key) => { const b = await readObject(BUCKET, key).catch(() => null); if (!b) return null; try { return JSON.parse(Buffer.from(b).toString('utf8')); } catch { return null; } };

async function plan(outFile = 'after-plan.txt') {
  const token = process.env.CLOUDFLARE_API_TOKEN, base = `${API}/accounts/${await account(token)}/r2/buckets/${BUCKET}`;
  const now = Date.now(), lo = Math.max(FROM_MS, now - RECENT_MS);
  const newest = new Map();
  for (const p of prefixesOf(lo, now)) for (const o of await list(base, token, `twins/${p}`)) {
    const m = /^twins\/(\d{13})\//.exec(o.key); if (!m || Number(m[1]) < lo) continue;
    const t = new Date(o.last_modified || o.uploaded || 0).getTime();
    newest.set(m[1], Math.max(newest.get(m[1]) || 0, t));
  }
  const walks = [];
  for (const [id, t] of newest) { const meta = await json(`twins/${id}/meta.json`); walks.push({ id, map: meta?.map || null, settled: now - t > SETTLED_MS }); }
  const markers = new Map();
  for (const map of new Set(walks.map((w) => w.map).filter(Boolean))) markers.set(map, await json(`auto/${map}.json`));
  const due = planOf(walks, markers, { repool: process.env.REPOOL === '1' });
  // a line a map: the pool, then | and the walks left out of it (the marker names them so they do not make it due again)
  writeFileSync(outFile, due.map(([pool, left]) => `${pool.join(',')}|${left.join(',')}`).join('\n') + (due.length ? '\n' : ''));
  console.log(`AFTER A WALK: ${walks.length} walk${walks.length === 1 ? '' : 's'} begun in the last ${RECENT_MS / 86400000} days; ${walks.filter((w) => !w.settled).length} still being sent, ${walks.filter((w) => !w.map).length} name no map; ${due.length} map${due.length === 1 ? '' : 's'} due${due.length ? `: ${due.map(([pool, left]) => `walks ${pool.join(', ')}${left.length ? ` (${left.length} older or placed worse left out)` : ''}`).join('; ')}` : ''}.`);
}

/** The marker: the walks pooled, the walks left out, and how each walk was placed (a file of "<walk> ref|own|none"
 *  lines from the run, over what the marker said before). planOf ranks the next pool by it. */
async function done(lineArg, dir, placedFile) {
  const [poolPart, leftPart = ''] = String(lineArg || '').split('|');
  const ids = poolPart.split(',').filter(walkOk), left = leftPart.split(',').filter(walkOk);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  if (!meta?.map || !ids.length) throw new Error('which walks, and which map?');
  const before = markerOf(await json(`auto/${meta.map}.json`));
  const placed = { ...before.placed };
  if (placedFile) {
    try { for (const l of readFileSync(placedFile, 'utf8').split('\n')) { const [w, how] = l.trim().split(/\s+/); if (walkOk(w) && ['ref', 'own', 'none'].includes(how)) placed[w] = how; } } catch { /* none */ }
  }
  await writeObject(BUCKET, `auto/${meta.map}.json`, Buffer.from(JSON.stringify({ v: 2, walks: ids, left, placed, at: new Date().toISOString() })), 'application/json');
  const by = (k) => ids.filter((w) => placed[w] === k).length;
  console.log(`Marked: this map's plants and ground are made from ${ids.length} walk${ids.length === 1 ? '' : 's'} (${ids.join(', ')}): ${by('ref')} placed through the reference, ${by('own')} by their own corners, ${by('none')} not placed; ${left.length} left out.`);
}

async function adopt(walk, from) {
  if (!walkOk(walk) || !walkOk(from)) throw new Error('which walk, and whose map?');
  const mine = await json(`twins/${walk}/meta.json`), other = await json(`twins/${from}/meta.json`);
  if (!mine) throw new Error('the walk has no meta.json');
  if (mine.map) { console.log('The walk already names a map: nothing changed.'); return; }
  if (!other?.map) throw new Error('the other walk names no map either');
  await writeObject(BUCKET, `twins/${walk}/meta-before.json`, Buffer.from(JSON.stringify(mine)), 'application/json');
  await writeObject(BUCKET, `twins/${walk}/meta.json`, Buffer.from(JSON.stringify({ ...mine, map: other.map, mapFrom: String(from) })), 'application/json');
  console.log(`Walk ${walk} now names the map of walk ${from}; its meta.json as it was is kept as meta-before.json.`);
}

/* THE OWNER'S ERASURES OF THE MAP (scan page eraser, edits/<map>.json): read for the pooling, which leaves them out. */
async function editsOf(dir, out) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const e = meta?.map ? await json(`edits/${meta.map}.json`) : null;
  writeFileSync(out, JSON.stringify(e && Array.isArray(e.erased) ? e : { v: 1, erased: [] }));
  console.log(`The owner's erasures on this map: ${e?.erased?.length ? `${e.erased.filter((x) => x[0] === 'p').length} plant squares, ${e.erased.filter((x) => x[0] === 'g').length} ground squares` : 'none'}.`);
}

if (process.argv[1] && process.argv[1].endsWith('after-walk.mjs')) {
  const [cmd, a, b, c] = process.argv.slice(2);
  (cmd === 'plan' ? plan(a) : cmd === 'done' ? done(a, b, c) : cmd === 'edits' ? editsOf(a, b) : cmd === 'adopt' ? adopt(a, b) : Promise.reject(new Error('plan, done or adopt'))).catch((e) => { console.log(`After a walk: ${e.message}`); process.exit(1); });
}
