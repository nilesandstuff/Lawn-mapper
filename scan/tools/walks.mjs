/**
 * Print the walks kept on the site (scan/src/walks.js) to the workflow's log, newest first, so the session
 * reads them there and nobody copies and pastes (owner, 2026-11-01). Each walk: one line of what it measured,
 * then its JSON with the event list cut to the last 30. Distances and counts only, as kept.
 *
 *   node scan/tools/walks.mjs            the last 12
 *   N=3 node scan/tools/walks.mjs        the last 3
 */
import { execFileSync } from 'node:child_process';
import { DB_NAME, parseList } from './d1.mjs';

const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };

/** One line per walk: engine, when, the walk, the pins' checks. */
export function headline(s) {
  const x = s.stats || {};
  const pins = (s.pins || []).map((p) => `${p.name}${p.anchored ? '*' : ''}:${(p.checks || []).map((c) => `${ftIn(c.offLevelM)}${c.offAnchorLevelM != null ? `/${ftIn(c.offAnchorLevelM)}` : ''}@${Math.round(c.walkedSinceM || 0)}m`).join(',') || '-'}`).join(' ');
  const tapes = (s.measures || []).filter((m) => m.shortBy != null).map((m) => `${(m.shortBy * 100).toFixed(1)}% short`).join(' ');
  const checks = (s.checks || []).map((c) => `${c.name}:${ftIn(c.errorM)} by ${c.by}${c.errorRefsM != null ? ` (refs ${ftIn(c.errorRefsM)})` : ''}`).join(' ');
  const fx = s.fix ? ` | fixes ${s.fix.fixes}/${s.fix.asks}` : '';
  const dt = s.depthType ? ` | depth ${s.depthType}` : '';
  return `${s.engine} ${s.when} ${Math.round((s.seconds || 0) / 60)} min, walked ${Math.round((x.walkedM || 0) * FT)} ft, losses ${x.losses}, resets ${x.resets}, fast turns ${x.fastTurns}${s.failed ? `, DID NOT START: ${s.failed}` : ''} | pins (as placed/anchored @ m walked since): ${pins || 'none'}${tapes ? ` | tape: ${tapes}` : ''}${checks ? ` | checks: ${checks}` : ''}${fx}${dt}`;
}

/**
 * A walk in a few lines (BRIEF=1, 2026-11-05: the owner's usage credits; the session reads these, not the 25,000-line
 * JSON). Counts and distances only, as kept.
 */
export function digest(s) {
  const x = s.stats || {}, f = s.fix || {}, L = f.asksLog || [];
  const med = (a) => { const b = a.filter(Number.isFinite).sort((p, q) => p - q); return b.length ? +b[b.length >> 1].toFixed(2) : null; };
  const top = (o, n = 4) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v} ${k}`).join('; ');
  const kept = L.filter((e) => e.kept), held = L.reduce((a, e) => { if (e.held) a[e.held] = (a[e.held] || 0) + 1; return a; }, {});
  const moves = L.map((e, i) => ({ e, i })).filter(({ e }) => e.held === 'moved' || e.held === 'first').map(({ e }) => `${e.held} at ${Math.round(e.odo)} m${e.agreeM != null ? ` (${e.agreeM} m from refs)` : ''}`);
  return [
    `id ${s.id} | ${s.recordOnly ? 'RECORD ONLY | ' : ''}tracked ${Math.round((x.trackedShare ?? 0) * 100)}% of ${x.frames ?? '?'} frames, limited ${x.limitedS ?? 0} s | depth ${s.depthType || '-'}`,
    `lidar: ${s.lidar?.error ? `ERROR ${s.lidar.error}` : `${s.lidar?.rule || 'none'}`}`,
    `fix: ${f.asks ?? 0} asks, ${f.fixes ?? 0} fixes, holds ${f.holds ?? '-'} (vouched ${f.holdsVouched ?? '-'}), what fixes did: ${JSON.stringify(held)}; refused: ${top(f.refused)}`,
    `asks: median standing ${med(L.map((e) => e.stand))}, high ${med(L.map((e) => e.high))}, ground ${med(L.map((e) => e.ground))}; kept fixes' distance from refs median ${med(kept.map((e) => e.agreeM))} m`,
    `hold changes: ${moves.join(', ') || 'none'}`,
    `marks: ${(s.references || []).map((r) => `${r.name}x${r.marks}`).join(' ') || 'no references'}; checks ${(s.checks || []).length}; pins ${(s.pins || []).length}: ${(s.pins || []).map((p) => p.name).join(' ')}`,
    `depth asked: ${s.rawAsked ? 'raw only' : 'raw, then smooth'}; got ${s.depthType || '-'}; holes ${s.depthFill ? `${Math.round(s.depthFill.holes * 100)}% of samples (past 8 m ${Math.round(s.depthFill.past8m * 100)}%${s.depthFill.weak != null ? `; under confidence ${s.depthFill.minConf}, dropped: ${Math.round(s.depthFill.weak * 100)}%` : ''}) over ${s.depthFill.frames} frames` : 'not measured'}`,
    `street view: ${s.geo ? `${s.geo.n} readings${s.geo.n ? `, ARCore's accuracy median ${s.geo.hacc} m (best ${s.geo.bestHacc ?? '-'}), heading median ${s.geo.yawAcc} deg (best ${s.geo.bestYawAcc ?? '-'})` : ''}${s.geo.firstS != null ? `; first after ${s.geo.firstS} s` : ''}${s.geo.waiting ? `; ${s.geo.waiting} frames waiting (${Object.entries(s.geo.states || {}).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${s.geo.used != null ? `; searches started from it: ${s.geo.used}` : ''}` : 'none'}`,
    `views: ${s.anchors ? `skyline in ${s.anchors.views.sky} and pavement in ${s.anchors.views.pave} of ${s.anchors.views.frames} pictures read; nudges ${s.anchors.nudges.sky} skyline, ${s.anchors.nudges.pave} pavement` : 'not kept'}`,
    `twin: ${s.twin ? `${s.twin.points} points, ${s.twin.keys} pictures, ${s.twin.poses} poses${s.twin.off ? `, OFF ${s.twin.off}` : ''}` : 'none'}`,
    `messages: ${(s.errors || []).slice(-12).join(' | ')}`,
  ];
}

/** The rows out of `wrangler d1 execute --json`. */
export function rowsOf(stdout) {
  const out = parseList(stdout);
  return out?.[0]?.results || [];
}

function main() {
  const n = Math.max(1, Math.min(50, Number(process.env.N) || 12));
  let stdout;
  try {
    stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', `--command=SELECT id, at, engine, phone, json FROM walks ORDER BY at DESC LIMIT ${n}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.log(`Could not read the walks (${String(err.stderr || err.message).split('\n')[0]}).`);
    process.exit(1);
  }
  const rows = rowsOf(stdout);
  console.log(`${rows.length} walk${rows.length === 1 ? '' : 's'} kept on the site (newest first).`);
  for (const r of rows) {
    let s = null; try { s = JSON.parse(r.json); } catch { /* raw */ }
    console.log('\n==============================================================');
    if (!s) { console.log(`${r.id}: unreadable JSON`); continue; }
    console.log(headline(s));
    if (process.env.BRIEF) { for (const line of digest(s)) console.log(`  ${line}`); continue; }
    console.log(JSON.stringify({ ...s, events: (s.events || []).slice(-30) }, null, 1));
  }
}

if (process.argv[1] && process.argv[1].endsWith('walks.mjs')) main();
