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
  /* TWO FILES (2026-11-26; the owner: "can we do anything to get back to the 1ft resolution? Make the file size cap
     bigger? Split files? Only a fraction of my yard has been mapped"). plants/<map>.json holds them WHOLE, a foot a
     square, with all the open air: the scan page draws it and fuses from it, and the bucket has no small cap.
     plants/<map>-record.json is the copy that goes into the map's record (docs/MAPS.md, the scan part, 192 KB in all),
     for the tools that read the record: the squares made 2, 4, 8 ft until it fits, the open air left out only when
     even 8 ft is too much. Both say their cellM. */
  const whole = Buffer.from(JSON.stringify(out));
  const key = `plants/${meta.map}.json`, old = await readObject(BUCKET, key).catch(() => null);
  if (old) await writeObject(BUCKET, `plants/backup/${meta.map}-${Date.now()}.json`, old, 'application/json');
  await writeObject(BUCKET, key, whole, 'application/json', { walk: String(walk) });
  console.log(`Plants kept with the map: ${j.boxes.length.toLocaleString()} squares of ${Math.round((j.cellM || 0.3048) * 3.281)} ft${out.seen ? ', with where the walks saw open air' : ''}, ${(whole.length / 1e3).toFixed(0)} KB${old ? '; the ones they replace are kept as a backup' : ''}. The scan page draws them and fuses from them.`);
  const rec = recordCopy(out);
  await writeObject(BUCKET, `plants/${meta.map}-record.json`, Buffer.from(JSON.stringify(rec.doc)), 'application/json', { walk: String(walk) });
  console.log(`For the map's record: ${rec.doc.boxes.length.toLocaleString()} squares of ${Math.round(rec.doc.cellM * 3.281)} ft, ${(rec.bytes / 1e3).toFixed(0)} KB${rec.left.length ? `; LEFT OUT to fit: ${rec.left.join(', ')}` : ''}. The start page puts it into the record when the map next opens.`);
}

/** The plants made coarse enough for the map's record. -> { doc, bytes, left: [what was left out] } */
export function recordCopy(doc, max = MAX_BYTES) {
  let out = { ...doc };
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (size() > max && (out.cellM || 0.3048) < 2.4) {
    const m = new Map();
    for (const [i, j, lo, hi] of out.boxes) { const k = `${Math.floor(i / 2)},${Math.floor(j / 2)}`, o = m.get(k); if (o) { o[0] = Math.min(o[0], lo); o[1] = Math.max(o[1], hi); } else m.set(k, [lo, hi]); }
    out = { ...out, boxes: [...m].map(([k, [lo, hi]]) => { const [i, j] = k.split(',').map(Number); return [i, j, lo, hi]; }), cellM: (out.cellM || 0.3048) * 2 };
  }
  const left = [];
  for (const [f, said] of [['clearHigh', 'the air seen empty in any season'], ['seenHigh', 'the air seen open above 8 ft'], ['seen', 'where the walks saw open air']]) {
    if (size() > max && out[f]) { const { [f]: _, ...rest } = out; out = rest; left.push(said); }
  }
  return { doc: out, bytes: size(), left };
}

if (process.argv[1] && process.argv[1].endsWith('plants-keep.mjs')) main().catch((e) => { console.log(`Plants: ${e.message}`); process.exit(1); });
