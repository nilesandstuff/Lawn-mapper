/**
 * The lawn sections tool's cuts (public/lib/sections.js) and the size labels
 * (public/lib/size-label.js). The rule that matters: whatever is cut, the
 * sections add up to the whole lawn.
 *   node tools/sections.test.js
 */
import { readFileSync } from 'node:fs';
import {
  startSections, sliceSections, cutOutShape, joinSections, fitToLawn,
  sectionSqFt, totalSqFt, wholeOf, sectionsPart, sectionsFromPart, frameAt,
} from '../public/lib/sections.js';
import { sizeLabel, labelSpot } from '../public/lib/size-label.js';
import { geometryAreaSqM, SQM_PER_SQFT } from '../public/lib/area.js';

const clip = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../public/lib/vendor/polygon-clipping.umd.min.js', import.meta.url), 'utf8'))(module, module.exports);
  return module.exports;
})();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* A lawn in metres around a Michigan point, written as [lng, lat]. */
const F = frameAt([-85.6, 42.9]);
const ll = (pts) => pts.map(F.from);
const poly = (pts) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ll([...pts, pts[0]])] } });
const sqft = (shapes) => geometryAreaSqM({ type: 'MultiPolygon', coordinates: wholeOf(clip, shapes) }) / SQM_PER_SQFT;
const sums = (name, sections, whole) => {
  const t = totalSqFt(sections);
  check(`${name}: the sections add up to the lawn`, Math.abs(t - whole) < 0.05, `sections ${t.toFixed(3)} vs lawn ${whole.toFixed(3)}`);
};

// A 30 x 20 m lawn (6,458 sqft) and a separate 10 x 10 m one behind.
const front = poly([[0, 0], [30, 0], [30, 20], [0, 20]]);
const back = poly([[0, 40], [10, 40], [10, 50], [0, 50]]);
const lawn = [front, back];
const whole = sqft(lawn);

let S = startSections(clip, lawn);
check('each separate piece of lawn starts as a section', S.length === 2);
sums('start', S, whole);

/* Slice: a straight line across the front, from outside to outside. */
let r = sliceSections(clip, S, ll([[15, -5], [15, 25]]));
check('a slice across the front cuts it in two', r.sections?.length === 3, JSON.stringify(r.error || ''));
S = r.sections;
sums('slice', S, whole);
const halves = S.filter((s) => Math.abs(sectionSqFt(s) - 300 / SQM_PER_SQFT) < 1);
check('the two halves are 300 m2 each', halves.length === 2, S.map((s) => sectionSqFt(s).toFixed(1)).join(', '));

/* A slice that misses the lawn is refused. */
r = sliceSections(clip, S, ll([[50, -5], [50, 25]]));
check('a line that misses the lawn is refused', !!r.error && !r.sections);

/* A slice that starts and stops inside carries on straight to the edge. */
const plain = startSections(clip, [front]);
r = sliceSections(clip, plain, ll([[5, 8], [5, 12]]));
check('a short line is carried on to the edges', r.sections?.length === 2);
if (r.sections) sums('short slice', r.sections, sqft([front]));

/* An L-shaped lawn: a cut across one arm does not cut the other. */
const L = [poly([[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]])];
r = sliceSections(clip, startSections(clip, L), ll([[-5, 30], [15, 30]]));
check('a slice across one arm of an L leaves the other arm whole', r.sections?.length === 2,
  r.sections?.map((s) => sectionSqFt(s).toFixed(0)).join(', '));
if (r.sections) {
  sums('L slice', r.sections, sqft(L));
  const small = Math.min(...r.sections.map((s) => sectionSqFt(s) * SQM_PER_SQFT));
  check('the arm\'s cut-off end is 10 x 10 m', Math.abs(small - 100) < 0.5, small.toFixed(2));
}

/* A U-shaped lawn: a straight line through both arms extends across the gap, but only the drawn arm is cut. */
const U = [poly([[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]])];
r = sliceSections(clip, startSections(clip, U), ll([[-5, 20], [12, 20]]));
check('a slice across one arm of a U does not cut the other arm', r.sections?.length === 2,
  r.sections?.map((s) => (sectionSqFt(s) * SQM_PER_SQFT).toFixed(1)).join(', '));
if (r.sections) sums('U slice', r.sections, sqft(U));

/* Free draw: a wiggly line across. */
const wiggle = [];
for (let y = -5; y <= 25; y += 0.5) wiggle.push([8 + 3 * Math.sin(y / 2), y]);
r = sliceSections(clip, startSections(clip, [front]), ll(wiggle));
check('a free-drawn line cuts the lawn in two', r.sections?.length === 2);
if (r.sections) sums('free draw', r.sections, sqft([front]));

/* Square: the lawn inside a rectangle becomes its own section. */
r = cutOutShape(clip, S, ll([[20, 5], [28, 5], [28, 15], [20, 15]]));
check('a square inside a section cuts it out', r.sections?.length === 4);
S = r.sections || S;
sums('square', S, whole);
const sq = S[S.length - 1];
check('the cut-out square is 80 m2', Math.abs(sectionSqFt(sq) * SQM_PER_SQFT - 80) < 0.1, (sectionSqFt(sq) * SQM_PER_SQFT).toFixed(2));

/* A square overhanging the lawn's edge takes only the lawn. */
r = cutOutShape(clip, S, ll([[-5, -5], [5, -5], [5, 5], [-5, 5]]));
check('a square over the edge takes only the lawn inside it', r.sections && Math.abs(sectionSqFt(r.sections[r.sections.length - 1]) * SQM_PER_SQFT - 25) < 0.1);
if (r.sections) sums('square over edge', r.sections, whole);

/* Shape: points around two sections at once. */
r = cutOutShape(clip, S, ll([[10, 2], [20, 2], [20, 18], [10, 18]]));
check('a shape across the slice line takes from both halves', !!r.sections);
if (r.sections) {
  S = r.sections;
  sums('shape', S, whole);
}

/* A shape through the middle of a strip leaves its two ends as two sections. */
const strip = [poly([[0, 0], [40, 0], [40, 5], [0, 5]])];
r = cutOutShape(clip, startSections(clip, strip), ll([[15, -2], [25, -2], [25, 7], [15, 7]]));
check('a shape through a strip leaves its ends as two sections', r.sections?.length === 3);
if (r.sections) sums('strip', r.sections, sqft(strip));

/* A shape on no lawn is refused. */
r = cutOutShape(clip, S, ll([[100, 100], [110, 100], [110, 110]]));
check('a shape on no lawn is refused', !!r.error);

/* Join. */
const before = S.length;
r = joinSections(clip, S, S[0].id, S[1].id);
check('joining two sections makes one', r.sections?.length === before - 1);
if (r.sections) sums('join', r.sections, whole);

/* Names survive a cut, and the kept part reads back. */
S[0].name = 'Front';
r = cutOutShape(clip, S, ll([[1, 1], [3, 1], [3, 3], [1, 3]]));
check('a section keeps its name when a piece is cut from it', r.sections?.some((s) => s.name === 'Front'));
const back2 = sectionsFromPart(JSON.parse(JSON.stringify(sectionsPart(S))));
check('the kept part reads back', back2?.length === S.length && back2[0].name === 'Front');
check('read back, the rounding moves the sum by under a square foot', Math.abs(totalSqFt(back2) - whole) < 1, totalSqFt(back2).toFixed(3));
sums('read back and fitted to the lawn', fitToLawn(clip, back2, lawn), whole);
check('the kept part is well under 64 KB', JSON.stringify(sectionsPart(S)).length < 64000);

/* The lawn redrawn after it was cut: sections are trimmed and new lawn is added. */
const bigger = [poly([[0, 0], [35, 0], [35, 20], [0, 20]]), back];
const fitted = fitToLawn(clip, S, bigger);
sums('fitted to a bigger lawn', fitted, sqft(bigger));
check('the added strip becomes a section of its own', fitted.length === S.length + 1);
const smaller = [poly([[0, 0], [25, 0], [25, 20], [0, 20]])];
const fitted2 = fitToLawn(clip, S, smaller);
sums('fitted to a smaller lawn', fitted2, sqft(smaller));

/* Overlapping shapes are counted once. */
const overlap = [poly([[0, 0], [10, 0], [10, 10], [0, 10]]), poly([[5, 0], [15, 0], [15, 10], [5, 10]])];
check('overlapping lawn shapes count once', Math.abs(totalSqFt(startSections(clip, overlap)) * SQM_PER_SQFT - 150) < 0.1);

/* Size labels. */
check('850 sqft', sizeLabel(850) === '850 sqft', sizeLabel(850));
check('999.4 is 999 sqft', sizeLabel(999.4) === '999 sqft');
check('1,100 is 1.1 k', sizeLabel(1100) === '1.1 k sqft', sizeLabel(1100));
check('1,000 is 1.0 k', sizeLabel(1000) === '1.0 k sqft', sizeLabel(1000));
check('9,960 is 10 k, not 10.0 k', sizeLabel(9960) === '10 k sqft', sizeLabel(9960));
check('12,400 is 12 k', sizeLabel(12400) === '12 k sqft', sizeLabel(12400));
check('nothing is 0 sqft', sizeLabel(undefined) === '0 sqft');

/* Label placement: inside the shape, and not at all when it cannot fit. */
const box = [[[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]]];
const at = labelSpot(box, 60, 16);
check('a label fits in a big shape', !!at && at[0] > 30 && at[0] < 170);
check('a label is hidden on a shape too small', labelSpot([[[0, 0], [30, 0], [30, 10], [0, 10], [0, 0]]], 60, 16) === null);
// A C shape: its middle is outside, so the label goes into an arm.
const C = [[[0, 0], [200, 0], [200, 30], [30, 30], [30, 170], [200, 170], [200, 200], [0, 200], [0, 0]]];
const c = labelSpot(C, 50, 14);
check('a label is placed inside a C, not in its mouth', !!c && (c[0] < 30 || c[1] < 30 || c[1] > 170), JSON.stringify(c));

console.log(failures ? `\n${failures} check(s) failed` : '\nall sections checks passed');
process.exit(failures ? 1 : 0);
