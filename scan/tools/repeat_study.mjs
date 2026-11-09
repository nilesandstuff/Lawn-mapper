/**
 * DO REPEAT WALKS AGREE WITH EACH OTHER? (core session, 2026-11-08). The owner asked whether the check marks, put on
 * the aerial photo, point where the lidar has those things; SCAN-H29 found that cannot be measured to a foot on the
 * lot. The research report of 2026-11-08 says what to do instead: a fit's score "is a residual, not an accuracy. It
 * needs held-out checks: surveyed corners, or agreement between repeat walks."
 *
 * Each walk is placed on its own (the consensus study's best fit, the after-the-walk placement); each check mark the
 * phone was stood on is carried through that walk's placement onto the map. Then, mark by mark, across walks:
 *   - how far apart the walks put it: the placement's own repeatability, with no photo in it at all;
 *   - where they put it on average against the photo's mark: a gap that every walk shares, in the same direction,
 *     is the yardstick's (the photo against the lidar, or the lidar model's own bias), not the placements'.
 *
 * Reads live.json, consensus.json and placement.json of each walk from the twin bucket (kept by task place).
 * Prints distances only.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/repeat_study.mjs <walk>,<walk>[,<walk>...]
 */
import { readObject, BUCKET } from './twin-r2.mjs';
import { checkMarks } from '../lib/postfix.js';

const FT = 3.281;
const ft = (m) => (m * FT).toFixed(1);
const place = ([th, tx, ty], [u, v]) => [Math.cos(th) * u - Math.sin(th) * v + tx, Math.sin(th) * u + Math.cos(th) * v + ty];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

async function json(walk, name) {
  const b = await readObject(BUCKET, `twins/${walk}/${name}`);
  if (!b) return null;
  try { return JSON.parse(Buffer.from(b).toString('utf8')); } catch { return null; }
}

async function main() {
  const walks = (process.argv[2] || '').split(/[,\s]+/).filter(Boolean);
  if (walks.length < 2) throw new Error('give two walks or more, comma separated');
  const per = [];
  for (const w of walks) {
    const live = await json(w, 'live.json'), cons = await json(w, 'consensus.json'), pl = await json(w, 'placement.json'), reg = await json(w, 'registration.json');
    const checks = checkMarks(live?.marks);   // a point marked twice: its last mark
    const placements = {};
    if (reg?.T) placements['registered to the lidar (small_gicp, ground first)'] = reg.T;
    if (cons?.weights?.all?.T) placements['best fit overall (all)'] = cons.weights.all.T;
    if (cons?.weights?.['ground + buildings + things']?.T) placements['best fit (ground + buildings + things)'] = cons.weights['ground + buildings + things'].T;
    if (pl && Number.isFinite(pl.theta)) placements['after the walk (placement.json)'] = [pl.theta, pl.tx, pl.ty];
    if (cons?.truth?.T) placements["the marks' own fit"] = cons.truth.T;
    per.push({ w, checks, placements });
    console.log(`Walk ${w}: ${checks.length} check marks with the phone's spot; placements: ${Object.keys(placements).join(', ') || 'none (run task place on it)'}.`);
  }
  const kinds = [...new Set(per.flatMap((p) => Object.keys(p.placements)))];
  for (const kind of kinds) {
    const used = per.filter((p) => p.placements[kind]);
    if (used.length < 2) continue;
    // every mark, where each walk puts it
    const byMark = new Map();
    for (const p of used) for (const c of p.checks) {
      const at = place(p.placements[kind], c.ar);
      if (!byMark.has(c.id)) byMark.set(c.id, { photo: c.map, at: [] });
      byMark.get(c.id).at.push({ w: p.w, at });
    }
    const rows = [], spreads = [], shared = [], own = [];
    for (const [id, m] of byMark) {
      if (m.at.length < 2) continue;
      const mean = [m.at.reduce((s, x) => s + x.at[0], 0) / m.at.length, m.at.reduce((s, x) => s + x.at[1], 0) / m.at.length];
      const spread = Math.max(...m.at.map((x) => Math.hypot(x.at[0] - mean[0], x.at[1] - mean[1])));
      const gap = [mean[0] - m.photo[0], mean[1] - m.photo[1]];
      const each = m.at.map((x) => Math.hypot(x.at[0] - m.photo[0], x.at[1] - m.photo[1]));
      spreads.push(spread); shared.push(Math.hypot(...gap)); own.push(...each);
      rows.push(`    ${id}: walks ${m.at.length}, apart up to ${ft(2 * spread)} ft (each from their mean at most ${ft(spread)}); their mean from the photo's mark ${ft(Math.hypot(...gap))} ft (east ${gap[0] >= 0 ? '+' : ''}${ft(gap[0])}, north ${gap[1] >= 0 ? '+' : ''}${ft(gap[1])}); each from the mark ${each.map(ft).join(', ')} ft`);
    }
    if (!rows.length) { console.log(`  ${kind}: no mark on two walks.`); continue; }
    console.log(`  ${kind}: ${rows.length} marks on ${used.length} walks. Median: from the photo's mark ${ft(med(own))} ft; the walks from their own mean ${ft(med(spreads))} ft; the mean from the photo's mark ${ft(med(shared))} ft.`);
    for (const r of rows) console.log(r);
  }
  console.log('Reading it: walks that agree with each other but sit off the photo\'s mark the same way say the yardstick (the photo against the lidar) is off there; walks scattered round the mark say the placements are.');
}

main().catch((e) => { console.error(`Repeat walks: ${e.message}`); process.exit(1); });
