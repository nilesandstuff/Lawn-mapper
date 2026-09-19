/**
 * Find lawns worth paying somebody to trace.
 *
 *   node tools/sample-lawns.js
 *
 * WHY THIS EXISTS. The corpus is the constraint on everything (S3), the
 * detector cannot help build it until it beats SAM and it does not (H11), so
 * the corpus grows by paying people. Before anybody can be paid there has to
 * be a queue of places worth tracing, and that queue cannot be a list of
 * addresses typed by hand.
 *
 * NO ADDRESSES, ANYWHERE IN THIS. A worker is handed a point on a map, and the
 * parcel lookup the app already does turns that point into a property line.
 * That is not a shortcut, it is the better design: no address database to
 * license, no geocoding bill, no house number sitting in a queue that is shown
 * to strangers by design. Every county here publishes its own parcels, so a
 * point that lands on one IS a property, verified by the authority that owns
 * the record.
 *
 * HOW A LAWN IS FOUND, and the second half is what makes it affordable.
 *
 * A random point in a county is mostly farmland, wood or road -- the first
 * test of this hit a parcel one time in six across Kent County, Delaware. So:
 * throw a dart, and WHEN IT LANDS ON A HOUSE, throw the next few nearby.
 * Parcels come in neighbourhoods; a hit means the surrounding half-kilometre
 * is probably built up, and sampling there converts one lucky dart into a
 * handful of candidates. Random darts find the neighbourhoods, the local walk
 * empties them.
 *
 * WHAT IS THROWN AWAY BEFORE A PERSON SEES IT: anything outside a plausible
 * house plot. A quarter-section of maize and a two-metre strip of verge are
 * both parcels, and neither is worth sixty seconds of the owner's screening.
 */

import { randomUUID } from 'node:crypto';
import { queryCounty } from '../worker/src/parcel.js';
import { VERIFIED_COUNTIES } from '../worker/src/counties-verified.js';
import { geometryAreaSqM } from '../public/lib/area.js';
import { query, resolveDatabase } from './corpus-db.js';

const SQM_PER_SQFT = 0.09290304;

/**
 * What counts as a house plot, in square feet.
 *
 * The floor is above a verge, a median strip and the slivers a county records
 * between two properties. The ceiling is below a farm and below the kind of
 * estate whose lawn would take an hour rather than five minutes -- the corpus
 * already carries a 158,000 sq ft lot and does not need more of them.
 *
 * These are deliberately generous at both ends. A screen that is too tight
 * throws away good lawns silently, and the owner's eye on the next step is
 * both cheaper and better than a number here.
 */
export const MIN_LOT_SQFT = 1500;
export const MAX_LOT_SQFT = 60000;

/** How far a follow-up dart lands from the one that hit, in degrees (~400 m). */
const NEIGHBOUR_SPREAD = 0.004;
/** How many follow-ups one hit earns. */
const NEIGHBOURS_PER_HIT = 8;
/** How close two candidates may be before they are probably the same lot. */
const TOO_CLOSE = 0.00035; // ~35 m

export const lotLooksResidential = (sqft) => sqft >= MIN_LOT_SQFT && sqft <= MAX_LOT_SQFT;

/** Deterministic randomness, so a run can be repeated exactly. */
export function makeRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Is this point far enough from everything found so far?
 *
 * A flat scan rather than an index: a run collects a few hundred points, and a
 * grid would be more code than the thing it saves.
 */
export function farEnough(point, taken, limit = TOO_CLOSE) {
  for (const [lng, lat] of taken) {
    if (Math.abs(lng - point[0]) < limit && Math.abs(lat - point[1]) < limit) return false;
  }
  return true;
}

/**
 * One county, up to `want` candidates.
 *
 * `lookup` is injected so the tests can run this whole search without a
 * network: the search is the part worth testing and the HTTP is not.
 */
export async function sampleCounty(key, county, { want, tries, rand, lookup, onHit }) {
  const [w, s, e, n] = county.box || [];
  if (![w, s, e, n].every(Number.isFinite)) return [];

  const found = [];
  const taken = [];
  const queue = [];
  let spent = 0;

  while (found.length < want && spent < tries) {
    const at = queue.length
      ? queue.pop()
      : [w + rand() * (e - w), s + rand() * (n - s)];
    spent++;

    let parcel = null;
    try {
      parcel = await lookup(key, at[0], at[1]);
    } catch {
      continue;                       // a county server having a bad minute
    }
    if (!parcel?.geometry) continue;

    const sqft = geometryAreaSqM(parcel.geometry) / SQM_PER_SQFT;
    /*
     * A HIT EARNS ITS NEIGHBOURS EVEN IF IT IS THE WRONG SIZE. Landing on a
     * farm still says there is recorded land here, and the farmhouse plot next
     * to it is exactly what this is looking for. Only the KEEPING is filtered.
     */
    for (let i = 0; i < NEIGHBOURS_PER_HIT; i++) {
      queue.push([
        at[0] + (rand() - 0.5) * NEIGHBOUR_SPREAD,
        at[1] + (rand() - 0.5) * NEIGHBOUR_SPREAD,
      ]);
    }

    if (!lotLooksResidential(sqft)) continue;
    if (!farEnough(at, taken)) continue;

    taken.push(at);
    found.push({
      id: randomUUID(),
      lng: Number(at[0].toFixed(6)),
      lat: Number(at[1].toFixed(6)),
      county: county.name || key,
      fips: county.fips || null,
      parcelSqFt: Math.round(sqft),
    });
    if (onHit) onHit(found.length, spent);
  }

  return found;
}

/* ------------------------------------------------------------------ main */

const esc = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function main() {
  const want = Number(process.env.WANT || 60);
  const perCounty = Number(process.env.PER_COUNTY || 12);
  const tries = Number(process.env.TRIES_PER_COUNTY || 90);
  const seed = Number(process.env.SEED || Date.now() % 100000);

  const keys = Object.keys(VERIFIED_COUNTIES);
  console.log(`${keys.length} verified counties. Looking for ${want} lawns, `
    + `up to ${perCounty} from any one county.\n`);

  resolveDatabase();

  /*
   * Already-known points, so a second run does not offer the same lot again.
   * Every state counts, rejected included -- the whole reason a rejection is
   * kept is to stop the sampler finding that car park a third time.
   */
  const seen = query('SELECT lng, lat FROM lawn_jobs')
    .map((r) => [Number(r.lng), Number(r.lat)]);
  console.log(`${seen.length} already in the queue; those spots are off the table.\n`);

  const rand = makeRandom(seed);
  /* Shuffled, so a run does not always start in Alaska. */
  const order = keys.slice().sort(() => rand() - 0.5);

  const all = [];
  for (const key of order) {
    if (all.length >= want) break;
    const county = VERIFIED_COUNTIES[key];
    if (!county?.box) continue;

    const got = await sampleCounty(key, county, {
      want: Math.min(perCounty, want - all.length),
      tries,
      rand,
      lookup: queryCounty,
    });
    /* Against this run AND against the database. */
    const fresh = got.filter((g) => farEnough([g.lng, g.lat], seen));
    for (const g of fresh) seen.push([g.lng, g.lat]);

    if (fresh.length) {
      console.log(`  ${county.name || key}: ${fresh.length}`);
      all.push(...fresh);
    }
  }

  if (!all.length) {
    console.log('\nNothing found. Every county server may be having a bad day,');
    console.log('or TRIES_PER_COUNTY is too low for how rural these counties are.');
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  const values = all.map((c) => `(${[
    esc(c.id), c.lng, c.lat, esc(c.county), esc(c.fips), c.parcelSqFt,
    esc('candidate'), esc(now),
  ].join(',')})`).join(',');

  query(`INSERT INTO lawn_jobs (id, lng, lat, county, fips, parcel_sqft, state, created_at)
         VALUES ${values}`);

  console.log(`\nAdded ${all.length} candidates, from ${new Set(all.map((c) => c.county)).size} counties.`);
  console.log('Open /screen.html to say which of them have a lawn worth tracing.');
}

if (process.argv[1] && process.argv[1].endsWith('sample-lawns.js')) {
  main().catch((e) => {
    console.log('Sampling stopped:', e.message);
    process.exitCode = 1;
  });
}
