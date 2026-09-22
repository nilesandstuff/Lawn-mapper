/**
 * Is there free LiDAR under the lawns we already have?
 *
 * PHASE ONE OF A TWO-PHASE IDEA, and the whole point of it is to be able to
 * abandon the idea cheaply. E8 in docs/DETECTOR-FINDINGS.md records the
 * mechanism: a laser pulse gets returns from under a tree canopy, which makes
 * it the first thing considered here that could MEASURE what is under a tree
 * rather than infer it. Everything else has inferred -- E3 says receptive
 * fields cannot, E7's Chesapeake class is a 20 m buffer rule whose own
 * document says the understory "is assumed to be turf grass", and our tracers
 * use their judgement.
 *
 * Phase two is the expensive half: PDAL over the public Entwine point clouds,
 * a canopy height model per frame, new feature columns, another training run.
 * That is a day of work and a new system dependency, and every bit of it is
 * wasted if the lawns we have are not flown.
 *
 * SO THIS ANSWERS THE ONE QUESTION THAT DECIDES IT, and nothing else: for each
 * approved map, is there a 3DEP project over that point, from when, and how
 * dense. It downloads one 8.7 MB file of footprints and reads the corpus. No
 * point clouds, no new dependencies, about a minute.
 *
 * WHAT IT CANNOT TELL YOU, said here because a coverage map is exactly the
 * sort of answer that gets over-read:
 *
 *   - A FOOTPRINT IS NOT A GUARANTEE. These polygons are the boundary of a
 *     collection, and a boundary can contain water, a hole where a flight line
 *     was rejected, or a parcel the returns simply missed. "Covered" here means
 *     "worth asking the point cloud", not "has points".
 *   - THE YEAR IS PARSED FROM THE PROJECT'S NAME. It is a naming convention,
 *     not a field: `USGS_LPC_MI_31Co_Kent_2016_LAS_2019` carries two years and
 *     `KY_FullState` carries none. The name is printed verbatim next to the
 *     guess so it can be checked.
 *   - THE DENSITY IS ARITHMETIC ON A FOOTPRINT, not a measurement. Total points
 *     divided by the area of the outline, so a project whose boundary encloses
 *     a lot of unflown ground reads thinner than it is.
 *   - AND THE PHOTOGRAPH'S OWN DATE IS NOT STORED ANYWHERE. The corpus records
 *     when somebody traced a map, not when the aerial was taken, so the gap
 *     between the LiDAR and the imagery cannot be computed from here. Trees
 *     grow and get felled; that gap is the thing most likely to make a canopy
 *     height feature disagree with a photograph, and we cannot yet measure it.
 *
 *   node tools/lidar-cover.js
 *
 * or, the way anybody actually runs it, workflow "17. Is there lidar under our
 * lawns".
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { geometryAreaSqM } from '../public/lib/area.js';

/**
 * Where the footprints come from.
 *
 * The Entwine copy of 3DEP publishes one polygon per project with the point
 * count and the URL of its octree. Hobu maintain the index; the bucket itself
 * has no manifest that answers "what covers this point".
 */
export const FOOTPRINTS = process.env.LIDAR_FOOTPRINTS
  || 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';

/**
 * 3DEP's own quality levels, in pulses per square metre.
 *
 * QL2 is the programme's stated minimum and QL1 is four times denser. They are
 * here to turn an opaque point count into a sentence somebody can act on: at
 * QL2 a 60 m frame holds a few thousand pulses, which is a coarse canopy
 * height model and a very coarse count of what reached the ground.
 *
 * Pulses, not points: each pulse may return three or more times, so the point
 * count these are compared against is an over-estimate of the pulse density.
 * Which makes a "below QL2" reading here strong evidence and a "QL1" reading
 * weak evidence, and that asymmetry is why both numbers are printed.
 */
export const QL2_DENSITY = 2;
export const QL1_DENSITY = 8;

/**
 * The years in a project's name, oldest first.
 *
 * Bounded to 1980–2049 so that a county FIPS code, a road number or a point
 * count cannot be read as a date. Returns every match rather than picking one:
 * `USGS_LPC_MI_31Co_Kent_2016_LAS_2019` is a 2016 collection delivered in
 * 2019, and which of those two matters depends on the question, so the guess
 * is not made here.
 */
export function parseYears(name) {
  const found = [...String(name || '').matchAll(/(?:^|[^0-9])(19[89]\d|20[0-4]\d)(?:[^0-9]|$)/g)]
    .map((m) => Number(m[1]));
  return [...new Set(found)].sort((a, b) => a - b);
}

/** The year to file a project under: the earliest, which is when it was flown. */
export const flownYear = (name) => parseYears(name)[0] ?? null;

/**
 * Is this point inside this ring?
 *
 * Ray casting, in degrees. Fine at this scale and for this purpose: the
 * question is which collection to ask, and a point within a metre of a project
 * boundary is a point whose answer was going to be unreliable either way.
 */
export function insideRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[k];
    if ((yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Is this point inside this project's footprint?
 *
 * HOLES ARE HONOURED, and they are not decoration: a footprint with a lake or
 * a rejected flight line cut out of it is exactly the case where "inside the
 * outline" and "has points" come apart, which is the thing this file is most
 * at risk of over-claiming.
 */
export function covers(geometry, lng, lat) {
  if (!geometry) return false;
  const polys = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
  return polys.some(([outer, ...holes]) => insideRing(outer || [], lng, lat)
    && !holes.some((h) => insideRing(h, lng, lat)));
}

/**
 * Points per square metre of the project's own footprint.
 *
 * Approximate, and stated as such wherever it is printed. The footprint
 * encloses everything the collection touched, so a long thin river survey or a
 * county with a lot of water reads thinner than the ground under a house
 * actually is.
 */
export function densityPerSqM(feature) {
  const count = Number(feature?.properties?.count || 0);
  const area = geometryAreaSqM(feature?.geometry);
  if (!count || !area) return null;
  return count / area;
}

/**
 * Which project to use when several overlap, and they often do.
 *
 * NEWEST FIRST, because the imagery is recent and a canopy from 2011 is a
 * different set of trees. Density breaks a tie. A project whose name carries
 * no year sorts last -- not because it is bad, but because an unknown date is
 * the one thing that cannot be reconciled with a photograph, and if a dated
 * project covers the same ground it is the better question to ask.
 */
export function pickBest(matches) {
  return matches.slice().sort((a, b) => {
    const ya = flownYear(a.name);
    const yb = flownYear(b.name);
    if (ya !== yb) {
      if (ya === null) return 1;
      if (yb === null) return -1;
      return yb - ya;
    }
    return (b.density || 0) - (a.density || 0);
  })[0] || null;
}

/**
 * The whole answer, as data. Pure, so the interesting parts can be tested
 * without a database or a network.
 */
export function planCoverage(features, lawns) {
  const rows = [];
  for (const L of lawns) {
    const matches = [];
    for (const f of features || []) {
      if (!covers(f.geometry, L.lng, L.lat)) continue;
      matches.push({
        name: f.properties?.name || '(unnamed)',
        url: f.properties?.url || null,
        points: Number(f.properties?.count || 0),
        density: densityPerSqM(f),
      });
    }
    rows.push({ ...L, matches, best: pickBest(matches) });
  }

  const covered = rows.filter((r) => r.best);
  const years = covered.map((r) => flownYear(r.best.name)).filter((y) => y !== null);
  return {
    rows,
    covered,
    uncovered: rows.filter((r) => !r.best),
    /* Below QL2 is the strong reading -- see the note on QL2_DENSITY -- so it
       is counted separately from "thin" rather than lumped in with it. */
    belowQL2: covered.filter((r) => r.best.density !== null && r.best.density < QL2_DENSITY),
    atQL1: covered.filter((r) => r.best.density !== null && r.best.density >= QL1_DENSITY),
    undated: covered.filter((r) => flownYear(r.best.name) === null),
    years,
  };
}

/* ------------------------------------------------------------------ the run */

const LAWNS = `
  SELECT id, at, county, lng, lat
    FROM corpus
   WHERE status = 'approved' AND lng IS NOT NULL AND lat IS NOT NULL
   ORDER BY at DESC
   LIMIT 500
`;

/** Retried, because one flaky download should not read as "no lidar anywhere". */
async function fetchFootprints(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => { setTimeout(r, 2000 * (i + 1)); });
    }
  }
  throw new Error(`could not fetch the footprints: ${last?.message || last}`);
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '—');

async function main() {
  console.log('Fetching the 3DEP project footprints…');
  const fc = await fetchFootprints(FOOTPRINTS);
  const features = fc?.features || [];
  console.log(`${features.length.toLocaleString()} lidar projects.\n`);

  const lawns = query(LAWNS).map((r) => ({
    id: r.id,
    at: String(r.at || '').slice(0, 10),
    county: r.county || 'traced by hand',
    lng: Number(r.lng),
    lat: Number(r.lat),
  })).filter((L) => Number.isFinite(L.lng) && Number.isFinite(L.lat));

  if (!lawns.length) {
    console.log('No approved maps with coordinates on them. Nothing to check.');
    return;
  }

  const plan = planCoverage(features, lawns);

  console.log('Lawn by lawn:\n');
  for (const r of plan.rows) {
    const d = r.best?.density;
    console.log(
      `  ${r.county.padEnd(22).slice(0, 22)} ${r.at}  `
      + (r.best
        ? `${String(flownYear(r.best.name) ?? '—').padStart(4)}  `
          + `${(d === null ? '  ?' : d.toFixed(1)).padStart(5)} pts/m²  ${r.best.name}`
          + (r.matches.length > 1 ? `  (+${r.matches.length - 1} more)` : '')
        : 'NO LIDAR')
    );
  }

  /* ------------------------------------------------------- the end of the log */
  /*
   * Everything worth knowing, repeated at the bottom. This project is read on
   * a phone and nobody scrolls back up a hundred lines to work out what the
   * table meant -- see the note about deploy logs in CLAUDE.md.
   */
  const n = plan.rows.length;
  const c = plan.covered.length;
  console.log(`\n${'='.repeat(64)}\n`);
  console.log(`${c} of ${n} approved lawns (${pct(c, n)}) have a 3DEP lidar project over them.`);

  if (plan.uncovered.length) {
    const where = {};
    for (const r of plan.uncovered) where[r.county] = (where[r.county] || 0) + 1;
    console.log(`\n${plan.uncovered.length} with nothing flown:`);
    for (const [county, k] of Object.entries(where).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${county} × ${k}`);
    }
  }

  if (plan.years.length) {
    const sorted = plan.years.slice().sort((a, b) => a - b);
    const mid = sorted[sorted.length >> 1];
    console.log(`\nFlown between ${sorted[0]} and ${sorted[sorted.length - 1]}, middle year ${mid}.`);
    console.log(`Maps traced between ${plan.rows.map((r) => r.at).sort()[0]} and `
      + `${plan.rows.map((r) => r.at).sort().pop()}.`);
    /*
     * SAID PLAINLY, because it is the one number that cannot be computed and
     * the one most likely to be assumed. The corpus stores when a map was
     * traced, not when its photograph was taken.
     */
    console.log('The gap between the lidar and the PHOTOGRAPH cannot be worked out:');
    console.log('the corpus does not store when the aerial was taken. Trees grow.');
  }
  if (plan.undated.length) {
    console.log(`\n${plan.undated.length} matched a project whose name carries no year.`);
  }

  console.log(`\nDensity, from the point count over the footprint — approximate:`);
  console.log(`  ${plan.atQL1.length} at 8 pts/m² or better (QL1-ish)`);
  console.log(`  ${plan.belowQL2.length} below 2 pts/m², which is under 3DEP's own floor`);
  console.log('  Points, not pulses: each pulse returns several times, so these');
  console.log('  read HIGH. A thin one here is thin; a thick one may not be.');

  /* -------------------------------------------------------------- the verdict */
  console.log('');
  if (c === 0) {
    console.log('PHASE TWO IS DEAD for this corpus. Nothing is flown, so there is no');
    console.log('canopy height to feed anything. Revisit if the corpus moves east.');
  } else if (c < n * 0.75) {
    /*
     * THE REASON THIS IS A WALL RATHER THAN A CAVEAT. A feature column needs a
     * value for every lawn. The uncovered ones either leave the set -- which
     * H7 says moves every number by more than the thing being tested, so the
     * result could not be compared with anything -- or need a "no data"
     * encoding, which is a second experiment sitting inside the first.
     */
    console.log(`NOT YET WORTH PHASE TWO. ${plan.uncovered.length} of ${n} lawns have no lidar,`);
    console.log('and a feature column needs a value for every one of them. Dropping');
    console.log('them changes the lawn set, which H7 says moves the table by more');
    console.log('than any feature would; keeping them needs a "no data" encoding,');
    console.log('which is a second experiment hidden inside the first.');
    console.log('\nApprove more maps in flown counties, or run phase two on the');
    console.log('covered subset as its OWN measurement with its own control row.');
  } else {
    console.log(`WORTH BUILDING PHASE TWO. ${c} of ${n} lawns are over a flown project,`);
    console.log('so a canopy height column would have a value nearly everywhere.');
    console.log('\nNext: PDAL over the Entwine octrees, bounded to each frame, and a');
    console.log('height-above-ground raster on the same 512 grid the features use.');
    console.log('Read E8 and S2 in docs/DETECTOR-FINDINGS.md first — height is not');
    console.log('species, so this separates a shrub from bare ground and does NOT');
    console.log('separate grass from mulch.');
  }
  console.log(`\n${'='.repeat(64)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
