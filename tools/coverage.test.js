/**
 * What the site says it can do, checked against what it can do.
 *
 * THE FAULT THIS EXISTS FOR was a paragraph, not a crash. The address step
 * named five Michigan counties and one in Nevada, and it was true the week it
 * was typed. Nothing failed as the registry grew past a hundred and fifty
 * entries in forty-five states -- the sentence simply went on turning visitors
 * away from a service that would have worked for them, and no test could
 * notice because nothing was wrong with the code.
 *
 * So these checks are all the same shape: is the claim the same thing as the
 * registry. Not "does it render".
 *
 *   node tools/coverage.test.js
 */

import { coverage, coverageSummary, NEAR_COMPLETE } from '../worker/src/coverage.js';
import { ALL_COUNTIES } from '../worker/src/counties.js';
import { US_COUNTIES } from '../worker/src/us-counties.js';
import { coverageSentence, listOf, shownList } from '../public/lib/coverage-ui.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const states = coverage();
const summary = coverageSummary();
const by = (ab) => states.find((s) => s.ab === ab);

/* ------------------------------------------------------- the denominator */
{
  const totals = Object.values(US_COUNTIES)
    .reduce((n, s) => n + Object.keys(s.counties).length, 0);
  check('the country has about three thousand counties',
    totals > 3100 && totals < 3200, String(totals));

  /*
   * CONNECTICUT IS THE ONE THAT CATCHES A STALE ROSTER. It replaced its eight
   * counties with nine planning regions, and the atlas carries the new codes.
   * Against the 2020 codes file every one of them joined nothing and the whole
   * state disappeared from the page -- a state served completely, reported as
   * not served at all, with no error anywhere.
   */
  check('and knows Connecticut by its planning regions',
    Object.keys(US_COUNTIES['09'].counties).length === 9
    && US_COUNTIES['09'].counties['110'] === 'Capitol Planning Region',
    JSON.stringify(Object.keys(US_COUNTIES['09'].counties)));

  check('and does not count the territories',
    !Object.values(US_COUNTIES).some((s) => s.ab === 'PR'),
    'a district the app cannot measure a lawn in is not missing coverage');
}

/* ---------------------------------------------- every entry is accounted for */
{
  /*
   * NOTHING IN THE REGISTRY MAY FALL THROUGH SILENTLY. An entry with a FIPS
   * code that joins nothing is invisible here: the county is served, the page
   * never says so, and the only symptom is a number quietly too low. Which is
   * precisely how Connecticut was lost.
   */
  const orphans = [];
  for (const [key, entry] of Object.entries(ALL_COUNTIES)) {
    if (!entry?.service || entry.statewide) continue;
    const f = String(entry.fips || '');
    const state = /^\d{5}$/.test(f) ? US_COUNTIES[f.slice(0, 2)] : null;
    if (!state?.counties[f.slice(2)]) orphans.push(`${key} (${f || 'no fips'})`);
  }
  check('every county entry joins a real county by its FIPS code',
    orphans.length === 0,
    orphans.length ? orphans.join(', ') : 'no orphans');

  const statewide = Object.values(ALL_COUNTIES).filter((c) => c.statewide && c.service);
  check('and every statewide layer names a state that exists',
    statewide.every((c) => Object.values(US_COUNTIES).some((s) => s.ab === c.state)),
    statewide.map((c) => c.state).join(','));
}

/* --------------------------------------------------- the three kinds of claim */
{
  check('Maryland is the one statewide layer promising the whole state',
    by('MD')?.kind === 'whole', by('MD')?.kind);

  /*
   * THE MOSAICS SAY "MOST OF", and this is not pedantry. Monroe County's own
   * layer has a parcel at a coordinate where IndianaMap has nothing, so
   * "every county in Indiana" would be the app overstating itself on the
   * first screen to somebody about to type an address into it.
   */
  for (const ab of ['NC', 'VT', 'NH', 'IN']) {
    check(`${ab} is reported as most of the state, not all of it`,
      by(ab)?.kind === 'most', by(ab)?.kind);
  }

  check('a statewide state lists no missing counties',
    by('NC').missing.length === 0 && by('NC').covered === by('NC').total,
    'the gaps in a mosaic exist and are not knowable from here');

  check('and Connecticut is whole by having every one of its regions',
    by('CT')?.kind === 'whole' && by('CT').counties.length === 9,
    `${by('CT')?.kind}, ${by('CT')?.counties.length} named`);

  const some = states.filter((s) => s.kind === 'some');
  check('a partly covered state counts only what it has',
    some.every((s) => s.covered === s.counties.length
      && s.covered + s.missing.length === s.total),
    'covered plus missing is the state');
}

/* ------------------------------------------------------------ the ordering */
{
  const kinds = states.map((s) => ({ whole: 0, most: 1, some: 2 }[s.kind]));
  check('whole states come first, then most, then the rest',
    kinds.every((k, i) => i === 0 || k >= kinds[i - 1]),
    kinds.join(''));
}

/* ------------------------------------------------------------ the sentence */
{
  check('an English list, not a join',
    listOf(['a']) === 'a'
    && listOf(['a', 'b']) === 'a and b'
    && listOf(['a', 'b', 'c']) === 'a, b and c',
    listOf(['a', 'b', 'c']));

  const line = coverageSentence(summary);
  console.log(`      ${line}`);
  check('the sentence names the whole states',
    summary.whole.every((n) => line.includes(n)), summary.whole.join(', '));
  check('and says "most of" for the mosaics',
    line.includes(`most of ${listOf(summary.most)}`), line);
  check('and counts the rest separately, as other states',
    line.includes(`plus ${summary.someCounties} counties in ${summary.someStates} other states`),
    line);
  /*
   * "all of Connecticut and Maryland and most of Indiana..." came out of the
   * first version: each clause ends in an "and" of its own, so joining the
   * clauses with another gives three ands in one breath doing two different
   * jobs. It reads as a typo rather than as a list.
   */
  check('and never joins two clauses that each already end in "and"',
    !/ and [A-Z][a-z]+ and (most|all) of /.test(line), line);

  check('a deployment with no counties at all still says something',
    coverageSentence({ whole: [], most: [], someStates: 0, someCounties: 0 })
      === 'Property lines come from public records.',
    coverageSentence({ whole: [], most: [], someStates: 0, someCounties: 0 }));

  check('and one county is a county, not 1 counties',
    coverageSentence({ whole: [], most: [], someStates: 1, someCounties: 1 })
      .includes('1 county in 1 state'),
    coverageSentence({ whole: [], most: [], someStates: 1, someCounties: 1 }));
}

/* -------------------------------------------------- the near-complete rule */
{
  /*
   * The threshold is what decides which side of the subtraction a reader is
   * shown. It is only useful if it is small: a state missing five is a
   * sentence, a state missing two hundred is a number pretending to be one.
   */
  check('the near-complete threshold is a handful, not a hundred',
    NEAR_COMPLETE > 0 && NEAR_COMPLETE <= 10, String(NEAR_COMPLETE));

  /*
   * THE ROW ALWAYS SHOWS THE SHORTER LIST. The threshold on its own does not
   * give you that: Hawaii has two of five counties, so "missing three" is
   * longer than "has two" while still being under the threshold, and the
   * first version of this rule would have printed the longer one. Delaware,
   * one of three, is the same shape.
   */
  const longer = states.filter((s) => {
    const { mode, names } = shownList(s, NEAR_COMPLETE);
    if (mode !== 'missing' && mode !== 'has') return false;
    const other = mode === 'missing' ? s.counties : s.missing;
    return other.length && names.length > other.length;
  });
  check('and every row shows whichever list is shorter',
    longer.length === 0,
    longer.map((s) => `${s.ab} ${s.counties.length} have / ${s.missing.length} missing`)
      .join(', ') || 'no row prints the longer side');

  check('Hawaii names the two it has rather than the three it lacks',
    shownList(by('HI'), NEAR_COMPLETE).mode === 'has',
    JSON.stringify(shownList(by('HI'), NEAR_COMPLETE)));

  /* A statewide state with its own county servers says so rather than
     pretending the state layer is the only thing serving it. */
  check('Indiana still names the counties verified one at a time',
    shownList(by('IN'), NEAR_COMPLETE).mode === 'also'
    && shownList(by('IN'), NEAR_COMPLETE).names.length === by('IN').counties.length,
    JSON.stringify(shownList(by('IN'), NEAR_COMPLETE).names));

  /*
   * Maryland is statewide AND has Prince George's County in the atlas, so its
   * row opens too -- which is the point of `also` and was worth finding out:
   * the first version of this check assumed a statewide state had nothing of
   * its own and asserted the wrong mode on it.
   */
  check('Maryland opens as well, because it has a county server of its own',
    shownList(by('MD'), NEAR_COMPLETE).mode === 'also',
    shownList(by('MD'), NEAR_COMPLETE).mode);

  check('and a statewide state with no county servers has nothing to open',
    shownList({ kind: 'whole', counties: [], missing: [] }, NEAR_COMPLETE).mode === 'none',
    'a triangle that discloses nothing is a promise the row cannot keep');

  /* The rule at the threshold itself, which no real state may currently sit
     on -- so it is asserted directly rather than left to the roster. */
  const made = (have, miss) => ({
    kind: 'some', counties: have, missing: miss, covered: have.length,
    total: have.length + miss.length,
  });
  check(`missing exactly ${NEAR_COMPLETE} still subtracts`,
    shownList(made(Array(40).fill('x'), Array(NEAR_COMPLETE).fill('y')), NEAR_COMPLETE)
      .mode === 'missing');
  check('and one more than that does not',
    shownList(made(Array(40).fill('x'), Array(NEAR_COMPLETE + 1).fill('y')), NEAR_COMPLETE)
      .mode === 'has');
}

/* ---------------------------------------------- the summary matches the list */
{
  check('the summary counts the same states the list contains',
    summary.states === states.length, `${summary.states} vs ${states.length}`);
  check('and the same counties',
    summary.someCounties === states.filter((s) => s.kind === 'some')
      .reduce((n, s) => n + s.counties.length, 0),
    String(summary.someCounties));
  /*
   * The headline is a promise made before anybody has typed anything, so it
   * must never be the hopeful number.
   */
  check('and never claims more counties than have been verified one by one',
    summary.someCounties <= Object.values(ALL_COUNTIES).filter((c) => c.service && !c.statewide).length,
    String(summary.someCounties));
}

/* ------------------------------------------- two catalogues, joined and sliced */
{
  const { candidatePool } = await import('./candidates.js');
  const pool = candidatePool();

  /*
   * NEITHER CATALOGUE IS A SUPERSET, which is the entire argument for carrying
   * both and the thing most likely to be quietly undone by someone tidying up.
   * If one ever does contain the other, this check says so rather than letting
   * the merge silently become a no-op.
   */
  check('both catalogues contribute candidates',
    pool.sources.atlas > 0 && pool.sources.openaddresses > 0,
    JSON.stringify(pool.sources));
  check('and each holds counties the other does not',
    pool.sources.fresh > 0
    && pool.sources.atlas > pool.sources.joined,
    `${pool.sources.fresh} only in OpenAddresses, `
      + `${pool.sources.atlas - pool.sources.joined} only in the atlas`);

  /*
   * ONE ENTRY PER COUNTY. Two candidates for one place means two bounding
   * boxes nominating the same address, and the generated registry is an object
   * literal where a duplicate key is not an error -- it is the second one
   * silently winning. That is how New York once lost four boroughs.
   */
  const seen = new Map();
  const dupeKey = [];
  const dupeFips = [];
  for (const c of pool.candidates) {
    if (seen.has(c.key)) dupeKey.push(c.key);
    seen.set(c.key, c);
  }
  const byFips = new Map();
  for (const c of pool.candidates) {
    if (!c.fips) continue;
    if (byFips.has(c.fips)) dupeFips.push(`${c.fips} (${byFips.get(c.fips)} / ${c.key})`);
    byFips.set(c.fips, c.key);
  }
  check('no county appears twice under two keys',
    dupeKey.length === 0, dupeKey.join(', ') || `${seen.size} distinct keys`);
  check('and no FIPS code is claimed by two candidates',
    dupeFips.length === 0, dupeFips.join(', ') || `${byFips.size} distinct counties`);

  /*
   * A COUNTY IN BOTH KEEPS THE SECOND ENDPOINT. Falling through to it costs
   * one timeout and saves the property line, which is the failure this
   * registry has seen more than any other -- so the merge must not be throwing
   * the loser away.
   */
  check('a county listed by both carries the other endpoint as a fallback',
    pool.candidates.filter((c) => c.fallbacks.length).length >= pool.sources.joined * 0.5,
    `${pool.candidates.filter((c) => c.fallbacks.length).length} carry a fallback, `
      + `${pool.sources.joined} are in both`);

  /* Every candidate has to be usable: the app builds `${service}/${layer}/query`
     and nothing else. */
  const broken = pool.candidates.concat(pool.statewide).filter((c) =>
    !/^https:\/\/.+\/(Map|Feature)Server$/i.test(String(c.service))
    || !Number.isInteger(c.layer));
  check('every candidate splits into a service and a layer index',
    broken.length === 0,
    broken.slice(0, 5).map((c) => `${c.key}: ${c.service}/${c.layer}`).join(', ')
      || `${pool.candidates.length + pool.statewide.length} usable`);

  /* The statewide ones are a different claim and must say so. */
  check('every statewide candidate names its state',
    pool.statewide.length > 0
    && pool.statewide.every((c) => c.statewide === true && /^[A-Z]{2}$/.test(c.state)),
    pool.statewide.map((c) => c.state).join(' '));
  /*
   * AND NONE OF THEM IS `complete`. A state republishing what its counties
   * send it has holes that look exactly like a working service from here, so
   * nothing imported may promise a whole state -- that flag is for Maryland,
   * which answered at four points and is set by hand.
   */
  check('and none of them promises a whole state',
    pool.statewide.every((c) => !c.complete),
    'an imported statewide layer is a mosaic until somebody proves otherwise');
}

/* ------------------------------------------ what the verifier actually shipped */
{
  const { VERIFIED_COUNTIES } = await import('../worker/src/counties-verified.js');
  const entries = Object.entries(VERIFIED_COUNTIES);

  /*
   * EVERY ENTRY CARRIES ITS OWN DATE, which is what makes the slicing safe.
   * A run checks two hundred of a thousand and leaves the rest alone, so
   * "when was this file written" says nothing about any particular county --
   * only `checked` does.
   */
  const undated = entries.filter(([, e]) => !/^\d{4}-\d{2}-\d{2}$/.test(String(e.checked)));
  check('every verified entry records when it was last proved',
    undated.length === 0,
    undated.slice(0, 5).map(([k]) => k).join(', ') || `${entries.length} dated`);

  /* A statewide entry is a state; a county entry is a county. Mixing the two
     shapes would put a state-sized box under a county's name. */
  const wrong = entries.filter(([, e]) => (e.statewide
    ? !/^[A-Z]{2}$/.test(String(e.state)) || e.fips
    : !/^\d{5}$/.test(String(e.fips)) || e.state));
  check('and is either a county with a FIPS code or a state with a postcode',
    wrong.length === 0, wrong.slice(0, 5).map(([k]) => k).join(', '));

  check('nothing generated promises a whole state',
    entries.every(([, e]) => !e.complete),
    'only Maryland carries that, and it is written by hand');
}

/* ------------------------------------------------- the routes that carry it */
{
  /*
   * THROUGH THE WORKER, not by calling the function again.
   *
   * Every check above proves the numbers are right; none of them proves the
   * browser can get them. A route that was never added, or added under the
   * wrong path, fails exactly like a deployment with no counties -- the page
   * keeps its placeholder sentence and says nothing is wrong.
   */
  const entry = await import('../worker/src/index.js');
  const env = { MAPBOX_TOKEN: 'pk.test' };
  const ctx = { waitUntil() {} };
  const get = async (path) => {
    const res = await entry.default.fetch(
      new Request(`https://site.test${path}`), env, ctx
    );
    return { status: res.status, body: await res.json() };
  };

  const config = await get('/api/config');
  check('/api/config carries the coverage summary',
    config.status === 200 && Number(config.body.coverage?.states) === states.length,
    JSON.stringify(config.body.coverage));

  const full = await get('/api/coverage');
  check('and /api/coverage carries every state',
    full.status === 200 && full.body.states?.length === states.length,
    `${full.status}, ${full.body.states?.length} states`);
  check('with the threshold the page needs to read them',
    full.body.nearComplete === NEAR_COMPLETE, String(full.body.nearComplete));
  check('and the county names, which is the whole reason to ask for it',
    full.body.states.some((s) => s.counties.length || s.missing.length),
    'a list of states with no counties in it is the summary again');

  /*
   * PUBLIC, and deliberately. It is a list of public records offices, and
   * somebody deciding whether this site can help them should not have to make
   * an account to find out.
   */
  check('and it needs no account',
    full.status === 200, 'no session was sent with that request');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
