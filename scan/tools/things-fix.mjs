/**
 * A BAD WALK'S DOUBLED THINGS TAKEN AWAY (core session, 2026-11-23). The owner: "the gutter placements are still on the
 * page, despite it being determined that the walk was bad." The walk in the rain (SCAN-PLAN 59) pinned one gutter's
 * two ends at its start and again at its end; the walk had slid 6-7 ft between, so the page kept each end as TWO
 * things. The page's rules have since changed (a thing placed late in a walk that did not close is "unsure"), but the
 * things already kept were kept under the old ones.
 *
 * For a walk that DID NOT COME BACK TO ITSELF (refkeep.js closingOf over CLOSE_M): among the things seen on that walk
 * and no other, where two of one kind lie within DOUBLE_M of each other, the one placed LATER is taken away (marked
 * gone, kept in the list: the start page's "Put back" undoes it). The earlier one, placed nearer the corner marks,
 * stays. A walk that closed, or gives no reading, is left alone. The list it replaces is kept as a backup.
 *
 *   node scan/tools/things-fix.mjs <walk> [dry]
 *
 * Prints ids, kinds and distances only: no places, no map ids.
 */
import { BUCKET, readObject, writeObject, walkOk } from './twin-r2.mjs';
import { closingOf, CLOSE_M } from '../lib/refkeep.js';
import { decodeThings, encodeThings, takeAway, pairGutters, kindOf } from '../lib/things.js';

export const DOUBLE_M = 3;
const IN = 39.3701;
const ftIn = (m) => { const i = Math.round(m * IN); return i < 24 ? `${i} in` : `${Math.floor(i / 12)} ft ${i % 12} in`; };
const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;

/** The things to take away: of two of one kind within DOUBLE_M, both seen on this walk alone, the later. -> [{ id, of, m }] */
export function doubled(things, walk) {
  const mine = (things || []).filter((t) => t?.at && !t.gone && (t.seen || []).length && t.seen.every((s) => s.walk === String(walk))).sort((a, b) => num(a.id) - num(b.id));
  const out = [], gone = new Set();
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
    const a = mine[i], b = mine[j];
    if (a.kind !== b.kind || gone.has(a.id) || gone.has(b.id)) continue;
    const m = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
    if (m <= DOUBLE_M) { gone.add(b.id); out.push({ id: b.id, of: a.id, m }); }
  }
  return out;
}

async function main() {
  const walk = process.argv[2], dry = process.argv[3] === 'dry';
  if (!walkOk(walk)) throw new Error('which walk?');
  const json = async (k) => { const b = await readObject(BUCKET, k).catch(() => null); if (!b) return null; try { return JSON.parse(b.toString()); } catch { return null; } };
  const live = await json(`twins/${walk}/live.json`), meta = await json(`twins/${walk}/meta.json`);
  if (!live || !meta?.map) throw new Error('the walk kept no live state or no map');
  const c = closingOf(live.marks || [], live.pins || []);
  console.log(`\nA WALK'S DOUBLED THINGS (walk ${walk}): ${c ? `it came back ${ftIn(c.m)} out at ${c.by}, after ${Math.round(c.walkedM * 3.28084)} ft of walking` : 'it gives no reading of whether it came back to itself (no plain pin on a marked corner, no corner marked twice)'}.`);
  if (!c || c.m <= CLOSE_M) { console.log('  Left alone: only a walk shown NOT to have come back to itself has its things looked over.'); return; }
  const key = `things/${meta.map}.json`, old = await readObject(BUCKET, key).catch(() => null);
  const things = old ? decodeThings(old.toString()) : [];
  const d = doubled(things, walk);
  console.log(`  The map has ${things.length} things, ${things.filter((t) => (t.seen || []).some((s) => s.walk === String(walk))).length} seen on this walk; ${d.length} are a second placing of one already there.`);
  if (!d.length) return;
  let next = things;
  for (const x of d) { const t = things.find((q) => q.id === x.id); console.log(`  ${x.id} (${kindOf(t.kind)?.short || t.kind}): ${ftIn(x.m)} from ${x.of}, the same kind, placed later on this walk -> ${dry ? 'WOULD BE taken away' : 'TAKEN AWAY'} (kept in the list; "Put back" on the start page undoes it).`); next = takeAway(next, x.id, `did not close: ${walk}`); }
  next = pairGutters(next);
  if (dry) { console.log('  A dry run: nothing written.'); return; }
  await writeObject(BUCKET, `things/backup/${meta.map}-${Date.now()}.json`, old, 'application/json');
  await writeObject(BUCKET, key, Buffer.from(encodeThings(next)), 'application/json', { walk: String(walk) });
  console.log(`  Kept: ${next.filter((t) => !t.gone).length} things stand, ${next.filter((t) => t.gone).length} taken away; the list it replaced is kept as a backup. The map's record catches up when the start page next opens the map.`);
}

if (process.argv[1] && process.argv[1].endsWith('things-fix.mjs')) main().catch((e) => { console.log(`Things: ${e.message}`); process.exit(1); });
