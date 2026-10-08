/**
 * Two settings, compared the way a small noisy corpus can bear
 * (owner, 2026-09-27: "make the most of the training data").
 *
 * WHY NOT THE HEADLINE MEDIAN. Each run's table is a median over lots, and
 * two medians can move a point apart while the lots underneath are 18
 * better against 7 (H48), or two points apart on the very same lots when
 * one veto misfires (H49). The comparison that uses every lot is the PAIRED
 * one: the same lot under A and under B.
 *
 * WHY SEVERAL RUNS. One seed moves a decoder by about a point (H28), the
 * size of several effects in this file. So each setting can be run more than
 * once with different seeds (in parallel: minutes are no object), and a lot's
 * figure for a setting is its mean over that setting's runs. The spread of
 * the runs' medians is printed, so a difference can be set beside the noise.
 *
 * WHAT IT PRINTS, for all lots and then for the frozen 32 and for the lots
 * approved since (the 32 are the ones every rule so far was tuned on; the
 * rest are the nearest thing to an untouched test):
 *   wins / losses / ties (a tie is within half a point),
 *   the median paired change and a 95% bootstrap interval for it,
 *   a two-sided sign-test p on wins against losses.
 * B minus A: negative is B better.
 *
 *   node tools/compare-runs.js --a a1.json,a2.json --b b1.json,b2.json [--row "…"] [--row-b "…"]
 */

import { readFileSync } from 'node:fs';

// THE PLAN's row since 2026-09-29 (H60): the edge-refined decoder. Runs from
// before it name the old row, 'decoder, canopy on lawn + stage 3, span, lidar
// veto' -- pass it with --row when comparing against those.
export const PLAN_ROW = 'decoder, edge refined + stage 3, span, lidar veto';
const TIE = 0.5;

/** lot id -> { error, benchmark, tag } for one row of one results file. */
export function rowLots(results, rowName) {
  const row = results.rows.find((r) => r.name === rowName);
  if (!row) return null;
  const out = new Map();
  for (const l of row.lots) if (Number.isFinite(l.error)) out.set(l.id, l);
  return out;
}

/** A setting's per-lot mean over its runs, and each run's median. */
export function pool(files, rowName) {
  const sums = new Map();
  const medians = [];
  for (const f of files) {
    const lots = rowLots(f, rowName);
    if (!lots) continue;
    const errs = [...lots.values()].map((l) => l.error).sort((x, y) => x - y);
    medians.push(errs.length ? errs[Math.floor((errs.length - 1) / 2)] / 2 + errs[Math.ceil((errs.length - 1) / 2)] / 2 : null);
    for (const [id, l] of lots) {
      const s = sums.get(id) || { total: 0, n: 0, benchmark: l.benchmark, tag: l.tag, photo: l.photo || null };
      s.total += l.error;
      s.n += 1;
      sums.set(id, s);
    }
  }
  const mean = new Map([...sums].map(([id, s]) => [id, { error: s.total / s.n, benchmark: s.benchmark, tag: s.tag, photo: s.photo }]));
  return { mean, medians };
}

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Seeded so the same inputs print the same interval. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

export function bootstrapMedianCI(ds, { reps = 5000, seed = 7 } = {}) {
  if (ds.length < 3) return [null, null];
  const r = rng(seed);
  const meds = [];
  for (let k = 0; k < reps; k++) {
    const sample = ds.map(() => ds[Math.floor(r() * ds.length)]);
    meds.push(median(sample));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(0.025 * reps)], meds[Math.floor(0.975 * reps)]];
}

/** Two-sided exact sign test. */
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  const k = Math.min(wins, losses);
  let p = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

/** Paired comparison of B against A over the lots both have. */
export function compare(a, b, { only = null, photo = null, photos = null } = {}) {
  const ds = [];
  for (const [id, la] of a.mean) {
    const lb = b.mean.get(id);
    if (!lb) continue;
    if (only === 'benchmark' && !la.benchmark) continue;
    if (only === 'new' && la.benchmark) continue;
    if (photo && photoOf(id, la, photos) !== photo) continue;
    ds.push({ id, tag: lb.tag || la.tag, a: la.error, b: lb.error, d: lb.error - la.error });
  }
  const wins = ds.filter((x) => x.d < -TIE).length;
  const losses = ds.filter((x) => x.d > TIE).length;
  const d = ds.map((x) => x.d);
  return {
    lots: ds.length, wins, losses, ties: ds.length - wins - losses,
    medianA: median(ds.map((x) => x.a)), medianB: median(ds.map((x) => x.b)),
    medianChange: median(d), ci: bootstrapMedianCI(d), p: signTestP(wins, losses),
    worst: [...ds].sort((x, y) => y.d - x.d).slice(0, 5),
    best: [...ds].sort((x, y) => x.d - y.d).slice(0, 5),
  };
}

/*
 * WHICH PHOTO A LOT WAS DRAWN ON (owner, 2026-10-08: most of the newest maps
 * were drawn and saved on county photos, and the two rarely line up). Training
 * reads each map's saved photo, so the corpus is a mix; this splits a
 * comparison by it. From the lot's own record when the run wrote one
 * (`photo`), else from --photos, a {id: provider} file workflow 24 reads out
 * of the database.
 */
export function photoOf(id, lot, photos) {
  const p = lot?.photo || photos?.[id] || 'mapbox';
  return p === 'county' ? 'county' : 'mapbox';
}

function fmt(c, label) {
  const f = (v) => (v === null ? '  n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
  return `  ${label.padEnd(26)} ${String(c.lots).padStart(3)} lots   B better on ${c.wins}, worse on ${c.losses}, level on ${c.ties}`
    + `   median ${c.medianA?.toFixed(1)}% -> ${c.medianB?.toFixed(1)}%, paired change ${f(c.medianChange)}`
    + ` [95% ${f(c.ci[0])} to ${f(c.ci[1])}]   sign test p = ${c.p.toFixed(3)}`;
}

function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const files = (k) => (get(k) || '').split(',').filter(Boolean).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const A = files('--a');
  const B = files('--b');
  const rowA = get('--row') || PLAN_ROW;
  const rowB = get('--row-b') || rowA;
  if (!A.length || !B.length) {
    console.log('usage: --a a1.json,a2.json --b b1.json [--row "row name"] [--row-b "row name"]');
    process.exit(2);
  }
  const a = pool(A, rowA);
  const b = pool(B, rowB);
  const spread = (m) => (m.length > 1 ? ` (runs' medians ${m.map((v) => v.toFixed(1)).join(', ')})` : '');
  console.log(`A: ${A.length} run(s) of "${rowA}"${spread(a.medians)}`);
  console.log(`B: ${B.length} run(s) of "${rowB}"${spread(b.medians)}`);
  if (A[0].fingerprint !== B[0].fingerprint) console.log('WARNING: the two sides were run on different lot sets; only shared lots are compared.');
  console.log('');
  const all = compare(a, b);
  console.log(fmt(all, 'all lots'));
  console.log(fmt(compare(a, b, { only: 'benchmark' }), 'the frozen 32 (tuned on)'));
  console.log(fmt(compare(a, b, { only: 'new' }), 'approved since (untuned)'));
  const photosFile = get('--photos');
  const photos = photosFile ? JSON.parse(readFileSync(photosFile, 'utf8')) : null;
  const county = compare(a, b, { photo: 'county', photos });
  if (county.lots) {
    console.log('\n  By the photo each lot was drawn and trained on:');
    console.log(fmt(county, 'county photo'));
    console.log(fmt(compare(a, b, { photo: 'mapbox', photos }), 'Mapbox photo'));
    /* Few enough to read one by one, and worth it while they are few. */
    console.log('  The county-photo lots:');
    for (const [id, la] of [...a.mean].filter(([i, l]) => photoOf(i, l, photos) === 'county').sort((x, y) => y[1].error - x[1].error)) {
      const lb = b.mean.get(id);
      console.log(`    ${(la.tag || id.split(':')[0]).padEnd(24)} ${la.error.toFixed(1)}%${lb ? ` -> ${lb.error.toFixed(1)}%` : ''}`);
    }
  }
  const name = (x) => (x.tag || x.id.split(':')[0]).padEnd(24);
  console.log('\n  Most improved in B:');
  for (const x of all.best) console.log(`    ${name(x)} ${x.a.toFixed(1)}% -> ${x.b.toFixed(1)}%`);
  console.log('  Most worsened in B:');
  for (const x of all.worst) console.log(`    ${name(x)} ${x.a.toFixed(1)}% -> ${x.b.toFixed(1)}%`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
