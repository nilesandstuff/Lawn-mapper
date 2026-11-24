/**
 * A WALK'S PLANTS KEPT WITH ITS MAP (core session, 2026-11-23): plants/<map>.json in the twin bucket, from the
 * plants-map.json that scan/tools/plants.py made (the walk's plants gridded in the map's own square feet). The scan
 * page reads it when the map opens (GET /api/scan/plants?map=) and puts it into the scan tool's part of the map's
 * record (docs/MAPS.md "scan", `plants`), where the fusing reads it: one of the two sources of the fused model (the
 * owner, 2026-11-23: "built from both parts, but is seperate from either... an entirely new 3D environment, so the
 * original data is not modified in the process of fusing it"). Neither this nor the lidar's file is written over.
 *
 * ONE WALK'S PLANTS AT A TIME, for now: the newest walk whose corners vouch for it replaces what was kept (the one
 * replaced is kept as a backup). Joining several walks' plants is not built.
 *
 *   node scan/tools/plants-keep.mjs <walk> <twin dir>
 *
 * Prints counts and sizes only: no map id, no places.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET, readObject, writeObject, walkOk } from './twin-r2.mjs';

export const MAX_BYTES = 160000;  // of the 192 KB the scan tool's part of a map's record may hold (docs/MAPS.md; 64 KB until 2026-11-24); the placed things have the rest

async function main() {
  const [walk, dir] = process.argv.slice(2);
  if (!walkOk(walk) || !dir) throw new Error('which walk, and which twin directory?');
  const f = join(dir, 'plants-map.json');
  if (!existsSync(f)) { console.log('Plants NOT kept with the map: the walk has no plants on the map (no fit by three agreeing corners, or no kinds).'); return; }
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { meta = null; }
  if (!meta?.map) throw new Error('the walk was made with no map open');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const out = { ...j, walk: String(walk), at: new Date().toISOString() };
  let body = Buffer.from(JSON.stringify(out));
  // too big with where the walk saw open air (`seen`): the plants go without it, and that is said
  if (body.length > MAX_BYTES && out.clearHigh) { delete out.clearHigh; body = Buffer.from(JSON.stringify(out)); console.log(`The air seen empty in any season is LEFT OUT: with it the file is over the ${MAX_BYTES / 1e3} KB there is room for.`); }
  if (body.length > MAX_BYTES && out.seenHigh) { delete out.seenHigh; body = Buffer.from(JSON.stringify(out)); console.log(`The air seen open above 8 ft is LEFT OUT: with it the file is over the ${MAX_BYTES / 1e3} KB there is room for.`); }
  if (body.length > MAX_BYTES && out.seen) { delete out.seen; body = Buffer.from(JSON.stringify(out)); console.log(`Where the walk saw open air is LEFT OUT: with it the file is over the ${MAX_BYTES / 1e3} KB there is room for.`); }
  if (body.length > MAX_BYTES) { console.log(`Plants NOT kept with the map: ${(body.length / 1e3).toFixed(0)} KB, over the ${MAX_BYTES / 1e3} KB there is room for in the map's record.`); process.exitCode = 1; return; }
  const key = `plants/${meta.map}.json`, old = await readObject(BUCKET, key).catch(() => null);
  if (old) await writeObject(BUCKET, `plants/backup/${meta.map}-${Date.now()}.json`, old, 'application/json');
  await writeObject(BUCKET, key, body, 'application/json', { walk: String(walk) });
  console.log(`Plants kept with the map: ${j.boxes.length.toLocaleString()} boxes${out.seen ? ', with where the walk saw open air' : ''}, ${(body.length / 1e3).toFixed(0)} KB${old ? '; the ones they replace are kept as a backup' : ''}. The map's record takes them when the start page next opens the map.`);
}

if (process.argv[1] && process.argv[1].endsWith('plants-keep.mjs')) main().catch((e) => { console.log(`Plants: ${e.message}`); process.exit(1); });
