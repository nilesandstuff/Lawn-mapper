/**
 * WHAT A WALK'S OWN RECORD SAYS OF ITSELF (core session, 2026-11-25). The owner's two walks of 2026-11-24: one's twin
 * "names no map" though its reference was saved, and "I remarked r3 a handful of times because it drifted several
 * times... the shape fixing to the reference walk should've corrected it." Reads meta.json and live.json and prints:
 * whether the twin names a map and whether it is the same map as the other walks given; what the match against the
 * earlier walk did (asked, confirmed, why not); each corner's marks in order, with how far each later mark of a corner
 * lies from its first IN THE WALK'S OWN FRAME (the phone's drift, nothing else in it).
 *
 *   node scan/tools/walk-info.mjs <walk> [other walk ...]
 *
 * Counts, distances and yes/no only: no map id, no places.
 */
import { BUCKET, readObject, walkOk } from './twin-r2.mjs';

const FT = 3.28084, IN = 39.3701;
const ftIn = (m) => { const i = Math.round(m * IN); return i < 24 ? `${i} in` : `${Math.floor(i / 12)} ft ${i % 12} in`; };
const read = async (k) => { const b = await readObject(BUCKET, k).catch(() => null); if (!b) return null; try { return JSON.parse(b.toString()); } catch { return undefined; } };

async function main() {
  const [walk, ...others] = process.argv.slice(2);
  if (!walkOk(walk)) throw new Error('which walk?');
  const meta = await read(`twins/${walk}/meta.json`), live = await read(`twins/${walk}/live.json`);
  console.log(`\nWHAT THE WALK'S RECORD SAYS (walk ${walk}):`);
  console.log(`  meta.json: ${meta === null ? 'NOT in the bucket' : meta === undefined ? 'unreadable' : `names a map: ${meta.map ? 'yes' : `NO (${JSON.stringify(meta.map)})`}; engine ${meta.engine}; camera ${meta.camera ? 'known' : 'not known'}; started ${meta.started}`}.`);
  if (!live) { console.log('  live.json: not in the bucket.'); return; }
  const lm = live.map ?? live.site ?? null;
  console.log(`  live.json: keys ${Object.keys(live).join(', ')}.${lm ? ' It names a map.' : ''}`);
  for (const o of others) {
    const m2 = await read(`twins/${o}/meta.json`);
    console.log(`  The same map as walk ${o}? ${meta?.map && m2?.map ? (meta.map === m2.map ? 'YES' : 'NO, another map') : 'cannot say (one names none)'}.`);
  }
  const P = live.prev;
  if (P) { const { fix, fixes, ...rest } = P; console.log(`  The earlier walk's shape: ${JSON.stringify(rest)}; fixes confirmed ${fixes?.length ?? 0}${fixes?.length ? ` at ${fixes.map((f) => Math.round(f.walkedM * FT)).join(', ')} ft walked, landing ${fixes.map((f) => f.landed).join(', ')}` : ''}.`); }
  else console.log('  The earlier walk\'s shape: nothing in the record.');
  const marks = (live.marks || []).filter((m) => m.ar);
  const by = new Map();
  for (const m of marks) { if (!by.has(m.id)) by.set(m.id, []); by.get(m.id).push(m); }
  const names = new Map((live.points || []).map((p) => [p.id, p.name]));
  console.log(`  Marks: ${marks.length} on ${by.size} points, ${Math.round((live.odo || 0) * FT)} ft walked.`);
  for (const [id, ms] of by) {
    const a = ms[0];
    console.log(`    ${names.get(id) || id} (${a.kind}${a.by ? `, by ${a.by}` : ''}): marked ${ms.length} time${ms.length === 1 ? '' : 's'} at ${ms.map((m) => Math.round((m.odo || 0) * FT)).join(', ')} ft walked`
      + (ms.length > 1 ? `; each later mark from the first, in the walk's own frame: ${ms.slice(1).map((m) => ftIn(Math.hypot(m.ar[0] - a.ar[0], m.ar[1] - a.ar[1]))).join(', ')}; each from the one before: ${ms.slice(1).map((m, i) => ftIn(Math.hypot(m.ar[0] - ms[i].ar[0], m.ar[1] - ms[i].ar[1]))).join(', ')}` : '') + '.');
  }
}
main().catch((e) => { console.log(`Walk info: ${e.message}`); process.exit(1); });
