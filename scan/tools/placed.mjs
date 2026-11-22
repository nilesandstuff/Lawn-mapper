/**
 * WHAT A WALK'S PINS SAY ABOUT THE WALK (core session, 2026-11-22). The owner's walk in the rain: "the live fix to the
 * roof corners and the points I placed all shifted pretty badly. For your reference, I placed the both ends of the
 * gutters for the same set twice so you can see how far away they are", and "there actually wasn't a way to mark a
 * roof corner a 2nd time... So i placed a point ('just a point') on r1."
 *
 * Two different things can move a pin, and this tells them apart:
 *   - IN THE WALK'S OWN FRAME (where the phone had it): two pins on one physical thing lie apart by the walk's own
 *     drift between them. No map, no fit, no lidar in it.
 *   - ON THE MAP (through the walk's fit at each moment): they lie apart by that drift AND by whatever the fit did.
 *
 *   node scan/tools/placed.mjs <walk>
 *
 * Reads the walk's live.json and meta.json and the map's things. Prints distances and counts only: no places.
 */
import { BUCKET, readObject, walkOk } from './twin-r2.mjs';
import { keepPlan } from '../lib/refkeep.js';
import { place } from '../lib/walkref.js';
import { decodeThings, kindOf } from '../lib/things.js';

const FT = 3.28084, IN = 39.3701;
const ftIn = (m) => { const i = Math.round(m * IN); return i < 24 ? `${i} in` : `${Math.floor(i / 12)} ft ${i % 12} in`; };
const lvl = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function main() {
  const walk = process.argv[2];
  if (!walkOk(walk)) throw new Error('which walk?');
  const read = async (k) => { const b = await readObject(BUCKET, k).catch(() => null); if (!b) return null; try { return JSON.parse(b.toString()); } catch { return null; } };
  const live = await read(`twins/${walk}/live.json`), meta = await read(`twins/${walk}/meta.json`);
  if (!live) throw new Error('the walk kept no live.json');
  const pins = (live.pins || []).filter((p) => p?.at && Number.isFinite(p.at.x));
  const marks = (live.marks || []).filter((m) => m?.ar && m?.map && m.kind === 'ref');
  console.log(`\nWHAT THE WALK'S PINS SAY (walk ${walk}, ${Math.round((live.odo || 0) * FT)} ft walked): ${pins.length} pins (${pins.map((p) => `${p.name}${p.kind ? ` ${kindOf(p.kind)?.short || p.kind}` : ' plain'}`).join(', ')}); ${marks.length} corner marks.`);

  // the walk's own corners
  const plan = keepPlan(live.marks || [], []), g = plan.g;
  console.log(`  Its corners: ${g.ok ? `${g.n} agree within ${ftIn(g.worstM)} after one fit${g.T?.s && g.T.s !== 1 ? `, the phone's distances scaled ${((g.T.s - 1) * 100).toFixed(1)}% to the map's` : ''}${g.left?.length ? `, ${g.left.length} left out` : ''}` : `vouch for nothing (${g.why})`}.`);

  // 1. A PLAIN PIN ON A MARKED CORNER: the closing error, in the walk's own frame
  const first = new Map(); for (const m of marks) if (!first.has(m.id)) first.set(m.id, m);
  for (const p of pins.filter((q) => !q.kind)) {
    let best = null;
    for (const m of first.values()) { const d = Math.hypot(p.at.x - m.ar[0], -p.at.z - m.ar[1]); if (!best || d < best.d) best = { m, d }; }
    if (best) console.log(`  PLAIN PIN ${p.name} (${Math.round(p.odo * FT)} ft walked): ${ftIn(best.d)} on the level from where the phone had the nearest corner when it was marked (${Math.round((p.odo - best.m.odo) * FT)} ft of walking earlier)${best.d < 6 ? ': if the pin was put on that corner, this is THE WALK\'S CLOSING ERROR, in its own frame' : ''}.`);
  }

  // 2. THE SAME KIND PLACED TWICE: in the walk's own frame, and on the map through the corners' one fit
  const kinded = pins.filter((p) => p.kind);
  const T = g.ok ? g.T : plan.ok ? plan.C : null;
  const onMap = (p) => (T ? place(T, p.at.x, -p.at.z) : null);
  const used = new Set();
  for (let i = 0; i < kinded.length; i++) for (let j = i + 1; j < kinded.length; j++) {
    const a = kinded[i], b = kinded[j];
    if (a.kind !== b.kind || used.has(j)) continue;
    const d = lvl(a.at, b.at);
    if (d > 8) continue;                       // two different things of one kind, not one thing twice
    used.add(j);
    const A = onMap(a), B = onMap(b);
    console.log(`  ${a.name} AND ${b.name}, both a ${kindOf(a.kind)?.short || a.kind}, ${Math.round(Math.abs(b.odo - a.odo) * FT)} ft of walking apart: ${ftIn(d)} apart on the level in the walk's own frame, ${ftIn(Math.abs((a.at.y ?? 0) - (b.at.y ?? 0)))} in height`
      + (A && B ? `; on the map by the corners' one fit ${ftIn(Math.hypot(A[0] - B[0], A[1] - B[1]))}` : '') + '. If they are one thing, that is the walk\'s own drift between the two.');
  }

  // 3. what was kept with the map
  if (meta?.map) {
    const b = await readObject(BUCKET, `things/${meta.map}.json`).catch(() => null);
    const things = b ? decodeThings(b.toString()) : [];
    const mine = things.filter((t) => (t.seen || []).some((s) => s.walk === String(walk)));
    console.log(`  Kept with the map: ${things.length} things in all, ${mine.length} seen on this walk (${mine.map((t) => `${t.id} ${kindOf(t.kind)?.short || t.kind}, ${t.grade}${t.pair ? `, pair ${t.pair}` : ''}`).join('; ') || 'none'}).`);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      if (mine[i].kind !== mine[j].kind) continue;
      const d = Math.hypot(mine[i].at[0] - mine[j].at[0], mine[i].at[1] - mine[j].at[1]);
      if (d < 8) console.log(`    ${mine[i].id} and ${mine[j].id}, both a ${kindOf(mine[i].kind)?.short}: ${ftIn(d)} apart on the map AS THE PAGE PLACED THEM (kept as two things: over 3 ft apart).`);
    }
  }
  // 4. what placed the walk as it went
  const fx = live.fixes?.length || 0, hd = live.holds?.length || 0;
  console.log(`  As it went: ${fx} lidar fixes, ${hd} holds${live.walk ? ', a whole-walk fit' : ''}; the earlier walk's shape ${live.prev ? 'placed it' : 'is not recorded in the walk\'s live state'}.`);
}

main().catch((e) => { console.log(`Placed: ${e.message}`); process.exit(1); });
