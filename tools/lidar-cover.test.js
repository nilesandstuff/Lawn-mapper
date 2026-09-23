/**
 * The lidar coverage check, without the network or the database.
 *
 * WHAT THESE ARE FOR. This tool produces one sentence -- build phase two, or
 * do not -- and every way it can be wrong is quiet. A point-in-polygon with the
 * arguments the wrong way round reports "no lidar anywhere" on a corpus that is
 * entirely flown, and reads as a fact about the country rather than as a bug. A
 * year regex that catches a county code dates a 2016 collection to 3101. A
 * density that forgets the holes in a footprint over-states every project.
 *
 * None of those throw. All of them would end a line of work.
 *
 *   node tools/lidar-cover.test.js
 */

import {
  parseYears, flownYear, insideRing, covers, densityPerSqM, pickBest,
  planCoverage, QL2_DENSITY,
} from './lidar-cover.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/* A square of side `d` degrees about a point, counter-clockwise. */
const box = (lng, lat, d) => [[
  [lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d],
]];
const project = (name, lng, lat, d, count) => ({
  type: 'Feature',
  properties: { name, count, url: `https://example.test/${name}/ept.json` },
  geometry: { type: 'MultiPolygon', coordinates: [box(lng, lat, d)] },
});

/* --------------------------------------------------------------- the years */
{
  /*
   * REAL NAMES FROM THE REAL INDEX, because the convention is not a spec and
   * the only way to be right about it is to use what is actually in the file.
   */
  check('a collection year and a delivery year are both kept',
    JSON.stringify(parseYears('USGS_LPC_MI_31Co_Kent_2016_LAS_2019')) === '[2016,2019]',
    JSON.stringify(parseYears('USGS_LPC_MI_31Co_Kent_2016_LAS_2019')));

  check('and the earliest is the one we file it under',
    flownYear('USGS_LPC_MI_31Co_Kent_2016_LAS_2019') === 2016,
    'the flight is what the trees looked like; the delivery is paperwork');

  check('a name with no year says so rather than inventing one',
    parseYears('KY_FullState').length === 0 && flownYear('KY_FullState') === null,
    'a real entry in the index, and the honest answer is "unknown"');

  /*
   * THE FAILURE THAT WOULD LOOK LIKE DATA. A county count, a lane number or a
   * point total inside a name are all digits, and a loose regex turns one into
   * a date that then sorts the project to the top as the "newest".
   */
  check('a county count is not a year', flownYear('MI_31Co_Barry_2016') === 2016,
    `31Co must not read as 3100-something: ${JSON.stringify(parseYears('MI_31Co_Barry_2016'))}`);
  check('and neither is a long number',
    JSON.stringify(parseYears('XX_Survey_529285317')) === '[]',
    JSON.stringify(parseYears('XX_Survey_529285317')));
  check('nor a date out of range',
    JSON.stringify(parseYears('XX_1899_2099')) === '[]',
    'bounded to 1980-2049, because anything else is a number that looks like a year');
}

/* ------------------------------------------------------ inside and outside */
{
  const ring = box(-85, 43, 1)[0];
  check('a point in the middle is inside', insideRing(ring, -85, 43));
  check('and one well outside is not', !insideRing(ring, -70, 43));

  /*
   * LONGITUDE FIRST. GeoJSON is [lng, lat] and almost everything a person says
   * out loud is "lat, lon", so this is the transposition that reports an empty
   * country. Checked with a point whose swap lands in the sea rather than in
   * another polygon, so the check cannot pass by luck.
   */
  check('the arguments are (lng, lat), not (lat, lng)',
    covers(project('P', -85, 43, 1).geometry, -85, 43)
    && !covers(project('P', -85, 43, 1).geometry, 43, -85),
    'swapped, every lawn in Michigan reads as "no lidar" and it looks like a fact');

  /*
   * A HOLE IS WHERE "inside the outline" AND "has points" COME APART -- a
   * lake, or a flight line that was rejected. Ignoring holes is the optimistic
   * failure, which is the worse one here: it sends phase two to fetch a point
   * cloud that has nothing over the house.
   */
  const holed = {
    type: 'Polygon',
    coordinates: [box(-85, 43, 1)[0], box(-85, 43, 0.1)[0]],
  };
  check('a hole in the footprint is a hole in the coverage',
    covers(holed, -85.5, 43.5) && !covers(holed, -85, 43),
    'a rejected flight line inside a boundary is exactly this shape');
}

/* -------------------------------------------------------------- the density */
{
  /*
   * The arithmetic is only worth anything if it lands in the right ORDER of
   * magnitude -- the whole use of it is "is this QL2 or QL1". A box of about
   * 0.01 degrees at this latitude is roughly a kilometre square.
   */
  const small = project('XX_Dense_2020', -85, 43, 0.005, 20_000_000);
  const d = densityPerSqM(small);
  check('density is points over the footprint, in per-square-metre',
    d > 5 && d < 40, `${d?.toFixed(1)} pts/m² over about a square kilometre`);

  check('and a project with no count does not read as zero density',
    densityPerSqM(project('XX_NoCount_2020', -85, 43, 0.005, 0)) === null,
    'null means "not known"; 0 would sort it below a real thin one');

  /* Holes come off the area, so they RAISE the density. Forgetting them is the
     same mistake as ignoring them in `covers`, one layer down. */
  const withHole = {
    type: 'Feature',
    properties: { name: 'XX_Holed_2020', count: 20_000_000 },
    geometry: { type: 'Polygon', coordinates: [box(-85, 43, 0.005)[0], box(-85, 43, 0.002)[0]] },
  };
  check('a hole is taken out of the area the points are spread over',
    densityPerSqM(withHole) > d,
    `${densityPerSqM(withHole).toFixed(1)} against ${d.toFixed(1)}`);
}

/* ------------------------------------------------------ choosing between them */
{
  const here = (name, count = 10_000_000) => ({
    name, count, density: densityPerSqM(project(name, -85, 43, 0.005, count)),
  });

  check('the newest flight wins, because a 2011 canopy is different trees',
    pickBest([here('XX_A_2011'), here('XX_B_2021'), here('XX_C_2016')]).name === 'XX_B_2021');

  check('density only breaks a tie',
    pickBest([here('XX_A_2021', 1_000_000), here('XX_B_2021', 40_000_000)]).name === 'XX_B_2021');

  /*
   * An undated project is not worse data. It is data that cannot be reconciled
   * with a photograph, which is a different complaint and is why it loses only
   * when something dated covers the same ground.
   */
  check('an undated project sorts last when a dated one covers the same ground',
    pickBest([here('KY_FullState'), here('XX_B_2009')]).name === 'XX_B_2009');
  check('but is still chosen when it is all there is',
    pickBest([here('KY_FullState')]).name === 'KY_FullState');

  check('and nothing at all is null rather than a throw', pickBest([]) === null);
}

/* ------------------------------------------------------------- the whole plan */
{
  /* The two Michigan projects are a county-sized box with a county's worth of
     points in it, so they land above QL2; the Carolina one is deliberately a
     huge boundary with almost nothing in it, which is the shape of a project
     that would be useless to ask. */
  const features = [
    project('MI_Kent_2016', -85, 43, 0.05, 4_000_000_000),
    project('MI_Kent_2021', -85, 43, 0.05, 4_000_000_000),
    project('NC_Thin_2018', -78, 35, 0.5, 1_000),
  ];
  const lawns = [
    { id: 'a', at: '2026-09-01', county: 'Kent County', lng: -85, lat: 43 },
    { id: 'b', at: '2026-09-02', county: 'Kent County', lng: -85.02, lat: 43.02 },
    { id: 'c', at: '2026-09-03', county: 'North Carolina', lng: -78, lat: 35 },
    { id: 'd', at: '2026-09-04', county: 'Utah', lng: -111, lat: 40 },
  ];
  const plan = planCoverage(features, lawns);

  check('every lawn gets a row, covered or not', plan.rows.length === 4);
  check('the covered ones are counted', plan.covered.length === 3, `${plan.covered.length}`);
  check('and the one with nothing over it is named',
    plan.uncovered.length === 1 && plan.uncovered[0].county === 'Utah',
    JSON.stringify(plan.uncovered.map((r) => r.county)));

  check('overlapping projects are all kept, with the newest chosen',
    plan.rows[0].matches.length === 2 && plan.rows[0].best.name === 'MI_Kent_2021',
    `${plan.rows[0].matches.length} matches, picked ${plan.rows[0].best.name}`);

  /*
   * THE READING THAT DECIDES THE WHOLE THING. A project below 3DEP's own floor
   * is one where a canopy height model would be guessing between pulses, and
   * this is the row that has to be visible in the summary rather than averaged
   * away with the good ones.
   */
  check('a project thinner than 3DEP\'s own floor is flagged',
    plan.belowQL2.length === 1 && plan.belowQL2[0].county === 'North Carolina',
    `${QL2_DENSITY} pts/m² is the programme minimum`);

  check('the flight years are collected for the summary',
    JSON.stringify(plan.years.slice().sort((a, b) => a - b)) === '[2018,2021,2021]',
    JSON.stringify(plan.years));

  /* And nonsense in, nothing out -- rather than a throw halfway down a run. */
  check('no features is "nothing is flown", not an error',
    planCoverage([], lawns).covered.length === 0);
  check('and no lawns is not an error either', planCoverage(features, []).rows.length === 0);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
