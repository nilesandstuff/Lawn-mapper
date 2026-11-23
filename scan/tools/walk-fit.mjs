/**
 * A WALK'S OWN FIT TO ITS MAP, KEPT BESIDE THE DOWNLOADED TWIN (core session, 2026-11-23): fit.json, for the tools in
 * Python that put what a walk saw on the map (scan/tools/plants.py). The fit is the page's own: the corners' one fit
 * with the phone's scale (refkeep.js keepPlan, goodPart). It is given as ok only when THREE corners or more agree
 * and the walk is not known to have slid (refkeep.js closingOf over CLOSE_M): the same two things a walk must show
 * before it is put into a reference (SCAN-PLAN 53, 59).
 *
 *   node scan/tools/walk-fit.mjs <twin dir>      reads <dir>/live.json, writes <dir>/fit.json
 *
 * Prints counts and distances only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepPlan, closingOf, CLOSE_M } from '../lib/refkeep.js';

export function fitOf(live) {
  const plan = keepPlan(live?.marks || [], []), g = plan.g || {};
  const c = closingOf(live?.marks || [], live?.pins || []);
  const closing = c ? { m: +c.m.toFixed(3), walkedM: +c.walkedM.toFixed(1), by: c.by } : null;
  if (!g.ok || !g.T) return { ok: false, why: `its corners vouch for nothing (${g.why || plan.why || 'fewer than three agree'})`, closing };
  if ((g.n || 0) < 3) return { ok: false, why: `only ${g.n} corners agree: three are needed to put what a walk saw on the map`, closing };
  if (c && c.m > CLOSE_M) return { ok: false, why: `the walk did not come back to itself (${(c.m * 39.37).toFixed(0)} in out at ${c.by})`, closing };
  const T = { theta: g.T.theta, tx: g.T.tx, ty: g.T.ty, s: g.T.s ?? 1 };
  return { ok: true, T, n: g.n, worstM: +g.worstM.toFixed(3), left: (g.left || []).length, closing };
}

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('which twin directory?');
  let live;
  try { live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')); } catch { throw new Error('no live.json beside the twin'); }
  const f = fitOf(live);
  writeFileSync(join(dir, 'fit.json'), JSON.stringify(f));
  console.log(f.ok ? `The walk's fit to its map: ${f.n} corners agree within ${(f.worstM * 39.37).toFixed(0)} in, the phone's distances scaled ${((f.T.s - 1) * 100).toFixed(1)}%${f.closing ? `; it came back ${(f.closing.m * 39.37).toFixed(0)} in out` : '; no reading of whether it came back to itself'}.` : `The walk has NO fit to put things on the map by: ${f.why}.`);
}

if (process.argv[1] && process.argv[1].endsWith('walk-fit.mjs')) { try { main(); } catch (e) { console.log(`Fit: ${e.message}`); process.exit(1); } }
