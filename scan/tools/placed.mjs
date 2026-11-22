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

  // 2b. IS IT ONE STEADY SLIDE? Each pair above is one place seen twice: (where, when) and (where, later). If the walk
  // slid at a steady rate per foot walked, one pair's slide foretells the others'. The pairs: a plain pin on a corner
  // against that corner's mark, and each thing pinned twice. In the walk's own frame; rates and leftovers only.
  const pairs = [];
  for (const p of pins.filter((q) => !q.kind)) {
    let best = null;
    for (const m of first.values()) { const d = Math.hypot(p.at.x - m.ar[0], -p.at.z - m.ar[1]); if (!best || d < best.d) best = { m, d }; }
    if (best && best.d < 6) pairs.push({ name: `${p.name} on its corner`, o0: best.m.odo, o1: p.odo, v: [p.at.x - best.m.ar[0], -p.at.z - best.m.ar[1]] });
  }
  { const seen = new Set();
    for (let i = 0; i < kinded.length; i++) for (let j = i + 1; j < kinded.length; j++) {
      const a = kinded[i], b = kinded[j];
      if (a.kind !== b.kind || seen.has(j) || lvl(a.at, b.at) > 8) continue;
      seen.add(j);
      pairs.push({ name: `${a.name}/${b.name}`, o0: a.odo, o1: b.odo, v: [b.at.x - a.at.x, -(b.at.z - a.at.z)] });
    } }
  if (pairs.length >= 2) {
    console.log(`  IS IT ONE STEADY SLIDE? ${pairs.length} places seen twice.`);
    for (const p of pairs) console.log(`    ${p.name}: slid ${ftIn(Math.hypot(...p.v))} over ${Math.round((p.o1 - p.o0) * FT)} ft of walking = ${(Math.hypot(...p.v) * IN / ((p.o1 - p.o0) * FT) * 100).toFixed(1)} in per 100 ft.`);
    // each pair foretold by the others' mean rate (a vector per metre walked), the walk's own frame
    for (let i = 0; i < pairs.length; i++) {
      const others = pairs.filter((_, j) => j !== i);
      const r = [0, 1].map((k) => others.reduce((a, q) => a + q.v[k] / (q.o1 - q.o0), 0) / others.length);
      const p = pairs[i], pred = [r[0] * (p.o1 - p.o0), r[1] * (p.o1 - p.o0)];
      console.log(`    ${p.name} foretold by the others' steady slide: ${ftIn(Math.hypot(p.v[0] - pred[0], p.v[1] - pred[1]))} left of its ${ftIn(Math.hypot(...p.v))}.`);
    }
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
  // 4b. THE EARLIER WALK'S SHAPE: did it place this walk, from when, and where does ITS fit put this walk's own corner
  // marks against their map places? Once it is confirmed it is the fit the page draws by (locate.js fitFor), so this
  // is what the person saw the corners do. (Walks before 2026-11-22 kept the fit without its scale: the corners' own
  // scale stands in for it, and the line says so.)
  { const P = live.prev;
    if (P && P.reference === false) console.log(`  The earlier walk's shape: none kept for this map when the walk was made.`);
    else if (P) {
      console.log(`  The earlier walk's shape: asked ${P.asks ?? '?'} times, confirmed ${P.ok ?? '?'}${P.firstOkM != null ? `, first at ${Math.round(P.firstOkM * FT)} ft walked` : ''}${P.fix ? `; the last one confirmed at ${Math.round((P.fix.walkedM || 0) * FT)} ft, landed ${P.fix.landed}` : '; NEVER PLACED THE WALK'}${!P.fix && P.lastWhy ? ` (${P.lastWhy})` : ''}.`);
      if (P.fix?.T) {
        const stand = (P.fix.T.s ?? 1) === 1 && g.ok && g.T?.s;
        const F = { ...P.fix.T, s: stand ? g.T.s : (P.fix.T.s ?? 1) };
        const off = [...first.values()].map((m) => { const q = place(F, m.ar[0], m.ar[1]); return Math.hypot(q[0] - m.map[0], q[1] - m.map[1]); });
        if (off.length) console.log(`    BY THAT FIT (what the page drew by once it was confirmed${stand ? '; its scale was not kept, the corners\' own stands in' : ''}), this walk's ${off.length} corner marks sit ${off.map(ftIn).join(', ')} from their places on the map.`);
      }
      // every confirmed fix as the walk went (kept since 2026-11-22): where each put the walk's FIRST corner mark,
      // against where the first one put it. A fit that follows a drifting walk moves; one that holds does not.
      const fx = (P.fixes || []).filter((f) => f?.T);
      const m0 = [...first.values()][0];
      if (fx.length >= 2 && m0) {
        const at0 = place(fx[0].T, m0.ar[0], m0.ar[1]);
        console.log(`    ITS ${fx.length} CONFIRMED FIXES, by how far each moved the first corner's mark on the map from where the first fix had it: ${fx.map((f) => { const q = place(f.T, m0.ar[0], m0.ar[1]); return `${ftIn(Math.hypot(q[0] - at0[0], q[1] - at0[1]))} at ${Math.round(f.walkedM * FT)} ft`; }).join(', ')}.`);
      }
    } else console.log(`  The earlier walk's shape: nothing recorded in the walk's live state (walks before 2026-11-22 dropped it at the walk's end).`);
  }
  console.log(`  As it went: ${fx} lidar fixes, ${hd} holds${live.walk ? ', a whole-walk fit' : ''}.`);
}

main().catch((e) => { console.log(`Placed: ${e.message}`); process.exit(1); });
