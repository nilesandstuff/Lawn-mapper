/**
 * Ground-truth tests for scoring the detector.
 *
 * THIS IS THE FILE THAT DECIDES THINGS. Once there is a number, the number
 * gets believed: "the trim improved it by four points" will be acted on
 * without anybody re-deriving where four came from. So every check here builds
 * outlines whose true areas are known by construction and compares against
 * what the arithmetic must say, rather than against what the code happens to
 * return.
 *
 * The case worth the most care is the one where the total is right and the
 * answer is wrong -- a detection that grabs the neighbour's hedge and misses
 * the same area of back lawn. A scorer that only subtracts totals calls that
 * perfect, which is how a model gets shipped that prices lawns correctly on
 * average and wrongly one at a time.
 *
 *   node tools/score.test.js
 */

import {
  scoreMap, summarise, verdict, median, areaSqFt, CANOPY_LABEL,
} from '../worker/src/score.js';
import { makeFrame } from '../public/lib/edges.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}
function closeTo(got, want, tol, name) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  check(name, ok, `got ${got?.toFixed?.(1) ?? got}  expected ~${want.toFixed(1)}`);
}

/*
 * A lot in Hudsonville, built in metres so every expected number below is
 * arithmetic rather than something read off the implementation.
 */
const frame = makeFrame([-85.8637, 42.8703]);
const SQ_M_PER_SQ_FT = 0.09290304;
const sqFt = (sqm) => sqm / SQ_M_PER_SQ_FT;

const box = (x, y, w, h) => ({
  type: 'Polygon',
  coordinates: [[
    frame.toLngLat([x, y]),
    frame.toLngLat([x + w, y]),
    frame.toLngLat([x + w, y + h]),
    frame.toLngLat([x, y + h]),
    frame.toLngLat([x, y]),
  ]],
});

/* ------------------------------------------------------------- the basics */
{
  console.log('--- a perfect answer, and an obvious one ---');

  const lawn = box(0, 0, 30, 20); // 600 m²
  closeTo(areaSqFt([lawn]), sqFt(600), 20, 'the fixture really is 600 square metres');

  const perfect = scoreMap({ truth: [lawn], detected: [lawn] });
  check('an outline scored against itself is not wrong anywhere',
    perfect.wrongSqFt < sqFt(2) && Math.abs(perfect.signedSqFt) < sqFt(2),
    `${perfect.wrongSqFt.toFixed(0)} sq ft of disagreement`);
  closeTo(perfect.errorPct, 0, 0.6, 'and scores zero per cent out');

  /*
   * A quarter too much, all of it on one side. Both numbers should say the
   * same thing here, which is the easy case -- and the case that hides the
   * difference between them, hence the one after it.
   */
  const greedy = scoreMap({ truth: [lawn], detected: [box(0, 0, 37.5, 20)] });
  closeTo(greedy.signedPct, 25, 1.5, 'a detection a quarter too big reads as +25%');
  closeTo(greedy.errorPct, 25, 1.5, 'and is wrong about a quarter of the lawn');
  check('the extra is recorded as invented grass, not as missed grass',
    greedy.extraSqFt > sqFt(140) && greedy.missedSqFt < sqFt(5),
    `extra ${greedy.extraSqFt.toFixed(0)}, missed ${greedy.missedSqFt.toFixed(0)} sq ft`);

  const mean = scoreMap({ truth: [lawn], detected: [box(0, 0, 22.5, 20)] });
  closeTo(mean.signedPct, -25, 1.5, 'and one a quarter too small reads as -25%');
}

/* --------------------------------------- right total, wrong everywhere */
{
  console.log('\n--- the total that is right for the wrong reasons ---');

  /*
   * THE CASE THE SECOND NUMBER EXISTS FOR.
   *
   * The lawn is the left half of a strip; the detector drew the right half.
   * Identical areas, zero ground in common. Subtracting totals calls this a
   * flawless detection -- and a model tuned on that metric would be free to
   * put the lawn anywhere at all as long as it was the right size.
   */
  const truth = box(0, 0, 20, 20);
  const detected = box(20, 0, 20, 20);
  const s = scoreMap({ truth: [truth], detected: [detected] });

  closeTo(s.signedPct, 0, 1, 'the invoice total is exactly right');
  closeTo(s.errorPct, 200, 3,
    'and the ground is 100% missed plus 100% invented, so 200% wrong');
  check('which is the whole reason the score is not just a subtraction',
    s.errorPct > 100 && Math.abs(s.signedPct) < 1,
    'a detector free to put the lawn anywhere would pass a totals-only check');
}

/* ------------------------------------------------- clipping to the parcel */
{
  console.log('\n--- the property line is part of the comparison ---');

  /*
   * The app never shows lawn outside the property line, so scoring an
   * unclipped detection against a clipped truth would charge the model for
   * grass it was never allowed to keep -- an error it did not make and cannot
   * fix, which would then be chased by whoever read the number.
   */
  const parcel = box(0, 0, 30, 20);
  const truth = box(0, 0, 30, 20);
  const spilling = box(0, 0, 45, 20); // half of it over the neighbour's line

  const clipped = scoreMap({ truth: [truth], detected: [spilling], parcel });
  closeTo(clipped.errorPct, 0, 1,
    'grass outside the line is not counted against the detector');

  const unclipped = scoreMap({ truth: [truth], detected: [spilling] });
  check('and without a property line the same detection scores badly',
    unclipped.errorPct > 40,
    `${unclipped.errorPct.toFixed(0)}% wrong with nothing to clip to`);
}

/* ------------------------------------------------------ holes are honest */
{
  console.log('\n--- a shed cut out of the lawn ---');

  const lawn = box(0, 0, 30, 20);
  const withShed = {
    type: 'Polygon',
    coordinates: [lawn.coordinates[0], box(10, 8, 4, 3).coordinates[0]],
  };

  closeTo(areaSqFt([withShed]), sqFt(600 - 12), 20,
    'a cut-out really is subtracted from the area');

  /*
   * The detector that missed the shed counts the shed as wrong, and nothing
   * else. The editor can cut holes now, so truth carries them -- and a scorer
   * that rasterised only the outer ring would quietly forgive every shed in
   * the corpus.
   */
  const s = scoreMap({ truth: [withShed], detected: [lawn] });
  closeTo(s.extraSqFt, sqFt(12), sqFt(3), 'a missed shed is 12 m² of invented lawn');
  check('and nothing is recorded as missed', s.missedSqFt < sqFt(2),
    `${s.missedSqFt.toFixed(0)} sq ft`);
}

/* --------------------------------------------------------- refusing to lie */
{
  console.log('\n--- what it will not score ---');

  const lawn = box(0, 0, 30, 20);
  check('a map with no stored AI outline scores nothing rather than zero',
    scoreMap({ truth: [lawn], detected: [] }) === null,
    'counting it as perfect would improve every average by adding nothing');
  check('and one with no approved outline likewise',
    scoreMap({ truth: [], detected: [lawn] }) === null);
  check('and neither throws on rubbish',
    scoreMap({ truth: null, detected: undefined }) === null);
}

/* ------------------------------------------------------- the summary */
{
  console.log('\n--- what the run says at the end ---');

  check('median is the middle value, not the mean',
    median([1, 2, 100]) === 2 && median([1, 3]) === 2);
  check('and an empty list has no median rather than a zero',
    median([]) === null, 'zero would read as a perfect score');

  /*
   * A pile where the fault has a DIRECTION: nine overshoots and one
   * undershoot. That is the shape of the real complaint -- the tree line
   * running about a quarter wide, every time -- and it is the finding that
   * says a trim is worth building.
   */
  const rows = [];
  for (let i = 0; i < 9; i++) {
    rows.push({
      errorPct: 20 + i, signedPct: 20 + i, signedSqFt: 500,
      extraSqFt: 500, missedSqFt: 0, canopy: i < 4 ? 2 : 0,
    });
  }
  rows.push({
    errorPct: 5, signedPct: -5, signedSqFt: -100,
    extraSqFt: 0, missedSqFt: 100, canopy: 0,
  });

  const summary = summarise(rows);
  check('the summary counts every scorable map', summary.overall.maps === 10);
  check('and reports that the fault has a direction',
    summary.overall.overshootShare === 0.9,
    `${summary.overall.overshootShare} overshoot`);

  const said = verdict(summary).join(' ');
  check('the verdict says which way it is wrong, in words',
    /overshoots/.test(said), said.slice(0, 90));
  check('and says a trim can fix a fault with a direction',
    /trim/.test(said),
    'that is the finding: days of work rather than months of training');

  /*
   * AND IT MUST BE ABLE TO SAY THE UNWELCOME THING. The premise of the hard
   * slice is that the fault lives in the tree cases. If the two grades score
   * the same, the grade is measuring nothing, and the honest report says so
   * rather than repeating the premise back.
   */
  const flat = summarise([
    { errorPct: 20, signedPct: 20, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 2 },
    { errorPct: 21, signedPct: 21, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 2 },
    { errorPct: 19, signedPct: 19, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
    { errorPct: 20, signedPct: 20, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
  ]);
  check('it reports when the canopy cases are NOT the hard ones',
    /NOT mostly about trees/.test(verdict(flat).join(' ')),
    'a report that can only confirm the premise is not a measurement');

  const steep = summarise([
    { errorPct: 40, signedPct: 40, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 2 },
    { errorPct: 42, signedPct: 42, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 2 },
    { errorPct: 8, signedPct: 8, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
    { errorPct: 9, signedPct: 9, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
  ]);
  check('and confirms it when they are',
    /really are the hard ones/.test(verdict(steep).join(' ')));

  /*
   * Ungraded maps are their own bucket. Folding them into "no canopy" would
   * make the easy column look bigger and better than it is, which is the
   * direction that flatters the detector.
   */
  const mixed = summarise([
    { errorPct: 10, signedPct: 10, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
    { errorPct: 50, signedPct: 50, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 'ungraded' },
  ]);
  check('an ungraded map is never counted as treeless',
    mixed.byCanopy[0].maps === 1 && mixed.byCanopy.ungraded.maps === 1,
    JSON.stringify(Object.keys(mixed.byCanopy)));

  check('a corpus with nothing scorable says so rather than reporting zero error',
    /could not be scored/.test(verdict(summarise([null, null])).join(' ')));
  check('and says how many maps it had to leave out',
    /left out/.test(verdict(summarise([
      null,
      { errorPct: 10, signedPct: 10, signedSqFt: 1, extraSqFt: 1, missedSqFt: 0, canopy: 0 },
    ])).join(' ')));

  check('every canopy grade has a label a person can read',
    [0, 1, 2, 'ungraded'].every((k) => typeof CANOPY_LABEL[k] === 'string'));
}

/* ------------------------------------------ reading what wrangler printed */
{
  console.log('\n--- getting the rows out of wrangler ---');
  const { parseRows, reasonFrom, wranglerError } = await import('./score-detector.js');

  /*
   * Wrangler prints banners, proxy warnings and update notices before the
   * JSON, which is the same lesson tools/ci-prepare.js learned about `d1
   * list`. Trusting the whole of stdout to parse is how a run reports an empty
   * corpus on a database that is full.
   */
  const noisy = `
 ⛅️ wrangler 4.0.0
 ------------------
▲ [WARNING] Proxy environment variables detected.

[{"results":[{"id":"a","tree_line":2},{"id":"b","tree_line":null}],"success":true}]
`;
  const rows = parseRows(noisy);
  check('the rows survive the banner above them',
    rows.length === 2 && rows[0].id === 'a',
    JSON.stringify(rows.map((r) => r.id)));

  check('and output with no JSON at all is no rows rather than a crash',
    parseRows('command not found').length === 0);
  check('as is empty output', parseRows('').length === 0 && parseRows(null).length === 0);

  /*
   * THE FIRST LINE OF STDERR IS A PROXY WARNING on every run, so reporting it
   * turned "your token cannot read D1" into a true sentence about something
   * else -- which reads as the answer and sends somebody after the wrong
   * thing entirely.
   */
  const stderr = '▲ [WARNING] Proxy environment variables detected.\n'
    + '✘ [ERROR] Authentication error [code: 10000]\n';
  check('the reason is the error, not the warning printed before it',
    /Authentication error/.test(reasonFrom({ stderr })),
    reasonFrom({ stderr }));
  check('and something unrecognised still says something',
    reasonFrom({ stderr: 'it broke' }) === 'it broke');
  check('rather than an empty line', reasonFrom({}) === 'no reason given');

  /*
   * WRANGLER PUTS ITS ERROR ON STDOUT, AS JSON, and stderr carries only the
   * proxy warning. The first real run of this reported "no reason given" for
   * exactly that reason -- the same empty diagnostic the corpus counter sat
   * behind for six deploys, reproduced in the tool built to avoid it.
   */
  const jsonFailure = {
    stdout: '\n{\n  "error": {\n    "text": "In a non-interactive environment, '
      + "it's necessary to set a CLOUDFLARE_API_TOKEN environment variable"
      + '"\n  }\n}\n',
    stderr: '▲ [WARNING] Proxy environment variables detected.\n',
  };
  check('a failure printed as JSON on stdout is read, not ignored',
    /CLOUDFLARE_API_TOKEN/.test(reasonFrom(jsonFailure)),
    reasonFrom(jsonFailure).slice(0, 70));
  check('and the proxy warning never wins',
    !/proxy/i.test(reasonFrom(jsonFailure)));

  /*
   * AND IT IS DETECTED WHEN THE EXIT CODE IS ZERO, which is the dangerous
   * shape: no throw, no rows, and a run that announces an empty corpus on a
   * database that is full. A confident wrong number does more damage than an
   * error message.
   */
  check('the same payload is recognised as a refusal rather than as no rows',
    wranglerError(jsonFailure.stdout) !== null
    && parseRows(jsonFailure.stdout).length === 0,
    'exiting zero must not read as "nothing approved yet"');
  check('and real output is not mistaken for a refusal',
    wranglerError('[{"results":[{"id":"a"}]}]') === null);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
