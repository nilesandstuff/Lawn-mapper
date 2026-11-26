/**
 * WHAT A NEW WALK SETS GOING, BY ITSELF (core session, 2026-11-26; workflow "S3. After a walk"). The owner, 2026-11-25:
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
 *   node scan/tools/after-walk.mjs done <walk,walk,...> <the first walk's twin dir>
 *   node scan/tools/after-walk.mjs adopt <walk> <walk whose map it takes>
 *
 * Prints walk ids, counts and times only: a map's id is a place, and this log is public.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET, API, account, list, readObject, writeObject, walkOk } from './twin-r2.mjs';

import { SETTLED_MS, RECENT_MS, POOL_MAX, FROM_MS, prefixesOf, planOf } from '../lib/afterplan.js';
export { SETTLED_MS, RECENT_MS, POOL_MAX, FROM_MS, prefixesOf, planOf };

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
  for (const map of new Set(walks.map((w) => w.map).filter(Boolean))) markers.set(map, (await json(`auto/${map}.json`))?.walks || []);
  const due = planOf(walks, markers);
  writeFileSync(outFile, due.map((ids) => ids.join(',')).join('\n') + (due.length ? '\n' : ''));
  console.log(`AFTER A WALK: ${walks.length} walk${walks.length === 1 ? '' : 's'} begun in the last ${RECENT_MS / 86400000} days; ${walks.filter((w) => !w.settled).length} still being sent, ${walks.filter((w) => !w.map).length} name no map; ${due.length} map${due.length === 1 ? '' : 's'} due${due.length ? `: ${due.map((ids) => `walks ${ids.join(', ')}`).join('; ')}` : ''}.`);
}

async function done(idsArg, dir) {
  const ids = String(idsArg || '').split(',').filter(walkOk);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  if (!meta?.map || !ids.length) throw new Error('which walks, and which map?');
  await writeObject(BUCKET, `auto/${meta.map}.json`, Buffer.from(JSON.stringify({ v: 1, walks: ids, at: new Date().toISOString() })), 'application/json');
  console.log(`Marked: this map's plants and ground are made from ${ids.length} walk${ids.length === 1 ? '' : 's'} (${ids.join(', ')}).`);
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

if (process.argv[1] && process.argv[1].endsWith('after-walk.mjs')) {
  const [cmd, a, b] = process.argv.slice(2);
  (cmd === 'plan' ? plan(a) : cmd === 'done' ? done(a, b) : cmd === 'adopt' ? adopt(a, b) : Promise.reject(new Error('plan, done or adopt'))).catch((e) => { console.log(`After a walk: ${e.message}`); process.exit(1); });
}
