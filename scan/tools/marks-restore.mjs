/**
 * THE MARKS PUT BACK FROM A WALK (core session, 2026-11-24). The owner opened their home map on the AR page and the
 * marks were gone: they were kept only in the phone's own storage. Every walk keeps the marks it was made with in its
 * live.json (app.js pointsKept), so the newest walk on a map has them. This writes them as the marks kept WITH the
 * map (marks/<map>.json, src/twin.js marks), which the start page now reads when the map opens. A set already kept is
 * left alone unless `force` (and is kept under marks/backup/ when replaced).
 *
 *   node scan/tools/marks-restore.mjs <walk> [force]
 *
 * Counts and names only: no places.
 */
import { BUCKET, readObject, writeObject, walkOk } from './twin-r2.mjs';

async function main() {
  const [walk, force] = process.argv.slice(2);
  if (!walkOk(walk)) throw new Error('which walk?');
  const mb = await readObject(BUCKET, `twins/${walk}/meta.json`);
  const map = mb ? JSON.parse(mb.toString()).map : null;
  if (!map) throw new Error('the walk was made with no map open');
  const lb = await readObject(BUCKET, `twins/${walk}/live.json`);
  const live = lb ? JSON.parse(lb.toString()) : null;
  const points = Array.isArray(live?.points) ? live.points.filter((p) => p && Array.isArray(p.map) && p.map.length === 2 && p.map.every(Number.isFinite)) : [];
  if (!points.length) { console.log(`MARKS: the walk ${walk} kept no marks in its record. Nothing written.`); return; }
  const key = `marks/${map}.json`, old = await readObject(BUCKET, key).catch(() => null);
  if (old && force !== 'force') { console.log(`MARKS: the map already has ${JSON.parse(old.toString()).points?.length ?? '?'} marks kept with it; left alone (add :force to replace them).`); return; }
  if (old) await writeObject(BUCKET, `marks/backup/${map}-${Date.now()}.json`, old, 'application/json');
  const at = new Date().toISOString();
  await writeObject(BUCKET, key, Buffer.from(JSON.stringify({ v: 1, at, points })), 'application/json');
  const kinds = points.reduce((a, p) => ((a[p.kind || '?'] = (a[p.kind || '?'] || 0) + 1), a), {});
  console.log(`MARKS PUT BACK on the walk's map from walk ${walk}: ${points.length} (${Object.entries(kinds).map(([k, n]) => `${n} ${k === 'ref' ? 'reference corners' : k === 'check' ? 'check points' : k}`).join(', ')}; names ${points.map((p) => p.name).filter(Boolean).join(', ')}). The start page shows them when the map next opens${old ? '; the set they replace is kept as a backup' : ''}.`);
}
main().catch((e) => { console.log(`Marks: ${e.message}`); process.exit(1); });
