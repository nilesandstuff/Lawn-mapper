/**
 * The auto-front check's marks (worker/src/yard-marks.js).
 *   node tools/yard-marks.test.js
 */
import { setMark, tally, readMarks, writeMarks, MARKS_KEY } from '../worker/src/yard-marks.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

let marks = {};
marks = setMark(marks, '-85.1,42.1', 'right');
marks = setMark(marks, '-85.2,42.2', 'wrong', { note: 'faces the side street', info: { facing: 'east' } });
marks = setMark(marks, '-85.3,42.3', 'skip');
check('three marks, two judged, half right', JSON.stringify(tally(marks)) === JSON.stringify({ right: 1, wrong: 1, skip: 1, total: 3, pctRight: 50 }), JSON.stringify(tally(marks)));
check('a wrong mark keeps its note and what the rule decided', marks['-85.2,42.2'].note === 'faces the side street' && marks['-85.2,42.2'].info.facing === 'east');
marks = setMark(marks, '-85.2,42.2', 'right');
check('a lot marked again takes the new verdict', tally(marks).pctRight === 100);
marks = setMark(marks, '-85.1,42.1', '');
check('an empty verdict clears the mark', !marks['-85.1,42.1'] && tally(marks).total === 2);
check('nothing judged has no share', tally({ a: { verdict: 'skip' } }).pctRight === null);
let threw = false;
try { setMark(marks, 'x', 'maybe'); } catch { threw = true; }
check('an unknown verdict is refused', threw);

/* The bucket round trip. */
const store = new Map();
const bucket = {
  async get(k) { const v = store.get(k); return v ? { json: async () => JSON.parse(v) } : null; },
  async put(k, v) { store.set(k, v); },
};
check('an empty bucket reads as no marks', JSON.stringify(await readMarks(bucket)) === '{}');
await writeMarks(bucket, marks);
check('marks come back as written', JSON.stringify(await readMarks(bucket)) === JSON.stringify(marks) && store.has(MARKS_KEY));

console.log(failures ? `\n${failures} check(s) failed` : '\nall yard-marks checks passed');
process.exit(failures ? 1 : 0);
