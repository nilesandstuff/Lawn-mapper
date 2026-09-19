/**
 * Finding lawns worth paying to have traced.
 *
 * WHAT IS WORTH TESTING HERE is the search, not the HTTP. A county parcel
 * server is somebody else's and cannot be asserted against; the decisions this
 * file makes about WHERE to throw the next dart and WHAT to keep are ours, and
 * they are what decide whether a run costs twenty minutes or two hours.
 *
 * The expensive failure mode is quiet: a sampler that technically works but
 * finds farmland, verges and the same cul-de-sac four times would fill the
 * screening queue with rubbish, and the cost would land as the owner's time
 * rather than as an error.
 *
 *   node tools/sample.test.js
 */

import {
  sampleCounty, farEnough, lotLooksResidential, makeRandom,
  MIN_LOT_SQFT, MAX_LOT_SQFT,
} from './sample-lawns.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/* A square parcel of roughly `sqft`, centred on a point. */
const SQM_PER_SQFT = 0.09290304;
const parcelOf = (lng, lat, sqft) => {
  const metres = Math.sqrt(sqft * SQM_PER_SQFT);
  const d = metres / 111320 / 2;            // degrees, near enough at this size
  const dx = d / Math.cos((lat * Math.PI) / 180);
  return {
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - dx, lat - d], [lng + dx, lat - d],
        [lng + dx, lat + d], [lng - dx, lat + d], [lng - dx, lat - d],
      ]],
    },
  };
};

const county = { name: 'Testshire', fips: '99999', box: [-80, 40, -79.9, 40.1] };

/* ------------------------------------------------- what counts as a house */
{
  check('a verge and a sliver are not house plots',
    !lotLooksResidential(200) && !lotLooksResidential(MIN_LOT_SQFT - 1),
    `the floor is ${MIN_LOT_SQFT} sq ft`);
  check('and neither is a farm',
    !lotLooksResidential(400000) && !lotLooksResidential(MAX_LOT_SQFT + 1),
    `the ceiling is ${MAX_LOT_SQFT} sq ft`);
  check('an ordinary lot is',
    lotLooksResidential(6000) && lotLooksResidential(16487),
    'including the size the corpus calls typical');
}

/* --------------------------------------------- the same lot, twice */
{
  const taken = [[-80, 40]];
  check('a point on top of one already found is refused',
    !farEnough([-80.0001, 40.0001], taken),
    'thirty metres apart is the same garden seen twice');
  check('and one a street away is not',
    farEnough([-80.005, 40.005], taken),
    'about five hundred metres');
}

/* ------------------------------------- a hit earns its neighbours */
{
  /*
   * THE WHOLE ECONOMICS OF THE RUN IS IN THIS ONE BEHAVIOUR. Random darts into
   * a county hit a house about one time in six -- measured, on Kent County
   * Delaware. Parcels come in neighbourhoods, so a hit means the surrounding
   * half-kilometre is probably built up. If the sampler does not follow up a
   * hit it pays the one-in-six rate for every single lawn.
   *
   * This county has houses in ONE small corner and nothing anywhere else, so a
   * sampler that follows up finds them and a sampler that does not, does not.
   */
  const hot = [-79.95, 40.05];
  let lookups = 0;
  const lookup = async (key, lng, lat) => {
    lookups++;
    const near = Math.abs(lng - hot[0]) < 0.004 && Math.abs(lat - hot[1]) < 0.004;
    return near ? parcelOf(lng, lat, 8000) : null;
  };

  /*
   * SEVERAL SEEDS, NOT ONE, and this is the point of the block rather than a
   * detail of it.
   *
   * The built-up corner is well under one per cent of this county, so a run
   * either lands a dart in it or spends its whole budget on empty fields --
   * one seed in thirteen finds nothing at all, measured. Written against a
   * single seed, this check would pass today and fail on some unrelated
   * afternoon, and whoever met it would be debugging a sampler that was
   * working. Asserting that MOST runs succeed states the property that is
   * actually claimed; picking the lucky seed would have tested the seed.
   */
  const runs = [];
  for (const seed of [1, 2, 3, 7, 11]) {
    lookups = 0;
    const got = await sampleCounty('test', county, {
      want: 6, tries: 400, rand: makeRandom(seed), lookup,
    });
    runs.push({ seed, got, lookups });
  }
  const filled = runs.filter((r) => r.got.length === 6);

  check('it finds a neighbourhood and works it',
    filled.length >= 4,
    `${filled.length} of 5 seeds filled the queue `
    + `(${runs.map((r) => `${r.seed}:${r.got.length}`).join(' ')})`);

  /*
   * AND CHEAPLY, which is the whole reason for following up a hit. Landing on
   * a house here costs about 150 darts; six lawns without follow-up would cost
   * six times that. Finding them inside a couple of hundred lookups is the
   * behaviour being paid for -- in county-server requests, and in the twenty
   * minutes a real run takes.
   */
  const cost = filled.length ? Math.min(...filled.map((r) => r.lookups)) : Infinity;
  check('and converts one lucky dart into a cluster, cheaply',
    cost < 250,
    `${cost} lookups for six lawns, in a county where a dart hits about one `
    + 'time in a hundred and fifty');

  const found = filled[0]?.got || [];
  check('and every one is a distinct lot',
    found.length > 0
    && new Set(found.map((f) => `${f.lng},${f.lat}`)).size === found.length
    && found.every((f, i) => found.slice(0, i)
      .every((g) => farEnough([f.lng, f.lat], [[g.lng, g.lat]]))),
    'offering the same garden twice wastes a screening decision and, worse, '
    + 'could put one lawn into the corpus twice');

  check('and carries what the screening page needs to show',
    found.length > 0 && found.every((f) => f.id && f.county === 'Testshire'
      && f.parcelSqFt > 0 && Number.isFinite(f.lng) && Number.isFinite(f.lat)),
    JSON.stringify(found[0]));
}

/* ----------------------------------------- farmland is not kept */
{
  /*
   * But it IS followed up, and that distinction is deliberate: landing on a
   * farm says there is recorded land here, and the farmhouse plot beside it is
   * exactly what this is looking for. Only the KEEPING is filtered.
   */
  const lookup = async (key, lng, lat) => {
    if (Math.abs(lng + 79.95) > 0.004 || Math.abs(lat - 40.05) > 0.004) return null;
    // A big field, with one house plot in the middle of it.
    const house = Math.abs(lng + 79.95) < 0.0005 && Math.abs(lat - 40.05) < 0.0005;
    return parcelOf(lng, lat, house ? 9000 : 250000);
  };

  const found = await sampleCounty('test', county, {
    want: 5, tries: 300, rand: makeRandom(5), lookup,
  });

  check('a run over farmland keeps only the house plots',
    found.every((f) => lotLooksResidential(f.parcelSqFt)),
    found.length ? `${found.length} kept, all residential` : 'nothing kept, which is also correct here');
}

/* ------------------------------------------- a county that answers nothing */
{
  /*
   * A dead server must cost its try budget and then stop, not hang and not
   * throw. One county being down is normal; a run that dies on it wastes the
   * other seven hundred.
   */
  const dead = async () => { throw new Error('503'); };
  const found = await sampleCounty('test', county, {
    want: 5, tries: 25, rand: makeRandom(3), lookup: dead,
  });
  check('a county whose server is down gives nothing and moves on',
    Array.isArray(found) && found.length === 0, `${found.length} found`);

  const empty = await sampleCounty('test', { ...county, box: null }, {
    want: 5, tries: 25, rand: makeRandom(3), lookup: dead,
  });
  check('and a county with no bounding box is skipped rather than guessed at',
    empty.length === 0, 'there is nowhere to throw a dart');
}

/* --------------------------------------------------- repeatable */
{
  const lookup = async (key, lng, lat) => parcelOf(lng, lat, 7000);
  const opts = { want: 4, tries: 50, lookup };
  const a = await sampleCounty('test', county, { ...opts, rand: makeRandom(42) });
  const b = await sampleCounty('test', county, { ...opts, rand: makeRandom(42) });
  check('the same seed finds the same lawns',
    JSON.stringify(a.map((x) => [x.lng, x.lat]))
    === JSON.stringify(b.map((x) => [x.lng, x.lat])),
    'a run that cannot be repeated cannot be debugged');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
