/**
 * THE ROOF CORNERS' DISTANCES, PHONE AGAINST MAP, OVER THE WALKS (core session, 2026-11-21; scan/lib/corners.js).
 * The owner: "frequent disagreement between the reference points... measure the exact distances between the corners
 * of my roofs to see if our lidar shapes are good or not."
 *
 *   node scan/tools/corners.mjs                 the last 40 walks the site kept
 *   node scan/tools/corners.mjs <walk>,<walk>   those
 *
 * Reads only each walk's live.json and meta.json (two small files). Prints distances, differences and counts: no
 * coordinates, no map ids (a map is "map 1"), corners by letter in the order the walks met them.
 */
import { execFileSync } from 'node:child_process';
import { BUCKET, readObject, walkOk } from './twin-r2.mjs';
import { DB_NAME } from './d1.mjs';
import { walkPairs, acrossWalks, cornerLean, shareCorners } from '../lib/corners.js';

const IN = 39.3701, FT = 3.28084;
const inch = (m) => `${m >= 0 ? '+' : '-'}${Math.abs(m * IN).toFixed(0)} in`;
const ft = (m) => `${(m * FT).toFixed(1)} ft`;

function lastWalks(n) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', `--command=SELECT id FROM walks ORDER BY at DESC LIMIT ${n}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const a = out.indexOf('['), b = out.lastIndexOf(']');
  return (JSON.parse(out.slice(a, b + 1))[0]?.results || []).map((r) => String(r.id));
}

async function main() {
  const arg = process.argv[2] || '';
  const ids = (arg ? arg.split(',') : lastWalks(40)).map((s) => s.trim()).filter(walkOk);
  console.log(`\nTHE ROOF CORNERS' DISTANCES, PHONE AGAINST MAP: ${ids.length} walks looked at.`);
  const maps = new Map();
  let none = 0, few = 0, unread = 0;
  for (const id of ids) {
    // asked again, slowly, when the bucket refuses (run 479 read 4 walks of 40 while another run was downloading a big
    // walk: a refusal looked like "kept no twin"). null = truly not there; undefined = could not be read.
    const read = async (key) => { for (let t = 0; t < 6; t++) { try { return await readObject(BUCKET, key); } catch { await new Promise((ok) => setTimeout(ok, 5000 * 2 ** t)); } } return undefined; };
    const lb = await read(`twins/${id}/live.json`), mb = lb ? await read(`twins/${id}/meta.json`) : null;
    if (lb === undefined) { unread++; continue; }
    if (!lb) { none++; continue; }
    let live, meta;
    try { live = JSON.parse(lb.toString()); meta = mb ? JSON.parse(mb.toString()) : {}; } catch { none++; continue; }
    const r = walkPairs(live.marks || []);
    if (r.corners.length < 2) { few++; continue; }
    const key = String(meta.map ?? '?');
    if (!maps.has(key)) maps.set(key, []);
    maps.get(key).push({ id, when: (meta.started || '').slice(0, 10), odo: live.odo || 0, ...r });
  }
  console.log(`  ${unread ? `${unread} COULD NOT BE READ (the bucket refused); ` : ''}${none} kept no twin, ${few} marked fewer than two corners; ${[...maps.values()].reduce((a, v) => a + v.length, 0)} walks on ${maps.size} map${maps.size === 1 ? '' : 's'} are read.`);
  console.log('  Each line: phone minus map. PLUS = the phone found the two corners farther apart than the map has them.');
  let mi = 0;
  const scales = [];
  for (const walks of [...maps.values()].sort((a, b) => b.length - a.length)) {
    mi++;
    const letters = new Map();
    const L = (k) => { if (!letters.has(k)) letters.set(k, String.fromCharCode(65 + letters.size % 26) + (letters.size >= 26 ? Math.floor(letters.size / 26) : '')); return letters.get(k); };
    walks.sort((a, b) => a.id.localeCompare(b.id));
    const distinct = shareCorners(walks);
    console.log(`\n== map ${mi}: ${walks.length} walk${walks.length === 1 ? '' : 's'}, ${distinct} different corners marked over them`);
    for (const w of walks) {
      console.log(`  walk ${w.id} (${w.when}, ${Math.round(w.odo * FT)} ft walked): ${w.corners.length} corners`);
      for (const p of w.pairs) console.log(`    ${L(p.a)}-${L(p.b)}: map ${ft(p.mapM)}, phone ${ft(p.phoneM)}, ${inch(p.diffM)} (${Math.round(p.walkedM * FT)} ft walked between the marks)`);
      if (w.scale) console.log(`    THE PHONE'S SCALE against the map's: ${((w.scale.k - 1) * 100).toFixed(1)}% (${w.scale.k < 1 ? 'the phone measures short' : 'the phone measures long'}); the pairs are off ${(w.scale.rawRmsM * IN).toFixed(0)} in as measured, ${(w.scale.rmsM * IN).toFixed(0)} in with that scale taken out.`);
      for (const a of w.again) console.log(`    ${L(a.key)} marked again after ${Math.round(a.walkedM * FT)} ft: the phone had it ${(a.movedM * IN).toFixed(0)} in from where it had it before`);
    }
    scales.push(...walks.filter((w) => w.scale && w.scale.n >= 3).map((w) => w.scale.k));
    if (walks.length < 2) { console.log('  One walk only: nothing to tell the phone\'s drift from the map\'s corners.'); continue; }
    const A = acrossWalks(walks);
    console.log('  THE SAME PAIR OVER THE WALKS:');
    const say = { map: 'the same in every walk: THE MAP\'S CORNERS, not the phone', phone: 'differs from walk to walk: the phone (drift, or the aim)', agree: 'phone and map agree', once: 'one walk only' };
    for (const p of A) console.log(`    ${L(p.a)}-${L(p.b)} (map ${ft(p.mapM)}), ${p.n} walk${p.n === 1 ? '' : 's'}: ${p.diffs.map(inch).join(', ')}${p.n > 1 ? `; median ${inch(p.medianM)}, +/- ${(p.spreadM * IN).toFixed(0)} in` : ''} -> ${say[p.verdict]}`);
    const lean = [...cornerLean(A)].sort((a, b) => Math.abs(b[1].meanM) - Math.abs(a[1].meanM));
    if (lean.length) console.log(`  BY CORNER (the mean of its steady pairs; the one that is off shows in all of its pairs): ${lean.map(([k, v]) => `${L(k)} ${inch(v.meanM)} over ${v.n}`).join(', ')}`);
    const t = { map: 0, phone: 0, agree: 0, once: 0 };
    for (const p of A) t[p.verdict]++;
    console.log(`  In all: ${t.agree} pairs agree, ${t.map} are off the same way in every walk (the map), ${t.phone} differ between walks (the phone), ${t.once} read once.`);
  }
  if (scales.length) {
    const v = scales.map((k) => (k - 1) * 100).sort((a, b) => a - b);
    console.log(`\nTHE PHONE'S SCALE OVER EVERY WALK WITH THREE CORNERS OR MORE (${v.length}): ${v.map((x) => x.toFixed(1)).join(', ')} %. Middle ${v[v.length >> 1].toFixed(1)}%. MINUS = the phone measures short of the map.`);
  }
}

main().catch((e) => { console.log(`Corners: ${e.message}`); process.exit(1); });
