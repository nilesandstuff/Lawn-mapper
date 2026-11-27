/**
 * A WALK'S GROUND KEPT WITH ITS MAP (core session, 2026-11-24; scan/tools/surfaces.py): surfaces/<map>.json in the twin
 * bucket, the walk's paving and grass by the phone's own labels, one byte a foot square on the map's own grid. The
 * start page reads it when the map opens (GET /api/scan/surfaces?map=) and draws it under the traced lawn, for the
 * owner's eyes on where the trace and the walk disagree (the goal's "refine the lawn trace"). The one it replaces is
 * kept as a backup. Counts and sizes only are printed.
 *
 *   node scan/tools/surfaces-keep.mjs <walk> <twin dir>
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET, readObject, writeObject, walkOk } from './twin-r2.mjs';

async function main() {
  const [walk, dir] = process.argv.slice(2);
  if (!walkOk(walk) || !dir) throw new Error('which walk, and which twin directory?');
  const f = join(dir, 'surfaces-map.json');
  if (!existsSync(f)) { console.log('Ground NOT kept with the map: the walk has no ground on the map (no fit by three agreeing corners).'); return; }
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  if (!meta?.map) throw new Error('the walk was made with no map open');
  const body = Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), walk: String(walk), at: new Date().toISOString() }));
  const key = `surfaces/${meta.map}.json`, old = await readObject(BUCKET, key).catch(() => null);
  if (old) await writeObject(BUCKET, `surfaces/backup/${meta.map}-${Date.now()}.json`, old, 'application/json');
  await writeObject(BUCKET, key, body, 'application/json', { walk: String(walk) });
  console.log(`Ground kept with the map: ${(body.length / 1e3).toFixed(0)} KB${old ? '; the one it replaces is kept as a backup' : ''}. The start page draws it when the map next opens.`);
  /* THE BUILT THINGS FOR THE FUSED MODEL (agreed with the features session, 2026-11-27; docs/MAPS.md plants.structures):
     put into BOTH plants files beside the map (the whole one and the record's copy), with a new `at` for both, so the
     scan page puts the record's copy into the map's record when the map next opens and the fusing sees a new walk side */
  const sf = join(dir, 'structures.json');
  if (!existsSync(sf)) return;
  const structures = JSON.parse(readFileSync(sf, 'utf8'));
  const at = new Date().toISOString();
  let n = 0;
  for (const k of [`plants/${meta.map}.json`, `plants/${meta.map}-record.json`]) {
    const b = await readObject(BUCKET, k).catch(() => null);
    if (!b) continue;
    const doc = JSON.parse(Buffer.from(b).toString('utf8'));
    const next = JSON.stringify({ ...doc, structures, at });
    if (k.endsWith('-record.json') && Buffer.byteLength(next) > 180000) { console.log(`Built things NOT put into the record's copy: it would be ${(Buffer.byteLength(next) / 1e3).toFixed(0)} KB, over the 180 KB the plants may take of the record.`); continue; }
    await writeObject(BUCKET, k, Buffer.from(next), 'application/json', { walk: String(doc.walk || walk) });
    n++;
  }
  const sz = Buffer.byteLength(JSON.stringify(structures));
  console.log(n ? `Built things put with the map's plants (${n} files, ${(sz / 1e3).toFixed(0)} KB): the scan page puts them into the map's record when the map next opens, for the fused model.` : 'Built things NOT put with the plants: the map has no plants kept.');
}
main().catch((e) => { console.log(`Ground: ${e.message}`); process.exit(1); });
