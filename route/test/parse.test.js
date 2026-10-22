// Reading stops out of a screenshot's OCR words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatMinutes, mergeStops, parseWords, readTime, slices } from '../lib/parse.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture-words.json', import.meta.url)));

// a real scroll capture's boxes (names and addresses made up): 19 jobs, every one read
const stops = parseWords(fixture.words, fixture.width);
assert.equal(stops.length, 19);
assert.deepEqual(stops[0], { address: '3581 Maple Cr SW', city: 'Byron Center', name: 'Pat Doe', minutes: 20, service: 'Fert 6 Winterizer Application' });
// an address on two lines, the second read beside the pin's number
assert.equal(stops[10].address, '5974 Oak Hollow Drive SW');
assert.equal(stops[4].address, '4644 Oak Hollow Dr SW');
assert.equal(stops[13].address, '2839 Elm Bend Dr.');
assert.equal(stops[2].name, 'Lee & Poe Alex');
assert.ok(stops.every((s) => s.city === 'Byron Center'));
assert.deepEqual(stops.map((s) => s.minutes), [20, 20, 20, 22, 20, 20, 20, 24, 20, 22, 20, 22, 22, 32, 22, 22, 20, 20, 20]);
assert.equal(stops.reduce((a, s) => a + s.minutes, 0), 408);

// the same capture read in slices, as the browser does it: same answer
const H = Math.max(...fixture.words.map((w) => w.bbox.y1));
const sliced = [];
for (const s of slices(H, 2400, 240)) {
  // what OCR of this slice would see: words wholly inside it, then kept only in the band it answers for
  for (const w of fixture.words) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    if (w.bbox.y0 >= s.top && w.bbox.y1 <= s.top + s.height && cy >= s.ownTop && cy < s.ownBottom) sliced.push(w);
  }
}
assert.deepEqual(parseWords(sliced, fixture.width), stops);
const sl = slices(7750, 2400, 240);
assert.equal(sl[0].top, 0);
assert.equal(sl.at(-1).top + sl.at(-1).height, 7750);
for (let i = 1; i < sl.length; i += 1) assert.equal(sl[i].ownTop, sl[i - 1].ownBottom, 'bands meet');
assert.deepEqual(slices(1000), [{ top: 0, height: 1000, ownTop: -Infinity, ownBottom: Infinity }]);

// two overlapping screenshots: each job once, in order
const merged = mergeStops([stops.slice(0, 12), stops.slice(9)]);
assert.equal(merged.length, 19);
assert.deepEqual(merged.map((s) => s.address), stops.map((s) => s.address));

// times as the list writes them, and as OCR misreads them
assert.equal(readTime('20m'), 20);
assert.equal(readTime('2om'), 20);
assert.equal(readTime('20rn'), 20);
assert.equal(readTime('1h'), 60);
assert.equal(readTime('1h5m'), 65);
assert.equal(readTime('1h 05m'), 65);
assert.equal(readTime('45 min'), 45);
assert.equal(readTime('NOT'), null);
assert.equal(readTime('m'), null);
assert.equal(readTime('0m'), null);

// a time read as two words ("1h" "15m") on the right
const words = [
  { text: '123', bbox: { x0: 290, y0: 100, x1: 350, y1: 130 } },
  { text: 'Main', bbox: { x0: 360, y0: 100, x1: 440, y1: 130 } },
  { text: 'St', bbox: { x0: 450, y0: 100, x1: 480, y1: 130 } },
  { text: 'NOT', bbox: { x0: 808, y0: 100, x1: 870, y1: 125 } },
  { text: 'A', bbox: { x0: 290, y0: 155, x1: 310, y1: 180 } },
  { text: 'B', bbox: { x0: 320, y0: 155, x1: 340, y1: 180 } },
  { text: '•', bbox: { x0: 350, y0: 165, x1: 356, y1: 171 } },
  { text: 'Town', bbox: { x0: 366, y0: 155, x1: 430, y1: 180 } },
  { text: '1h', bbox: { x0: 950, y0: 155, x1: 985, y1: 180 } },
  { text: '15m', bbox: { x0: 995, y0: 155, x1: 1041, y1: 180 } },
];
assert.deepEqual(parseWords(words, 1080), [{ address: '123 Main St', city: 'Town', name: 'A B', minutes: 75, service: '' }]);

assert.equal(formatMinutes(408), '6h 48m');
assert.equal(formatMinutes(45), '45m');
assert.equal(formatMinutes(60), '1h 00m');

console.log(`route parse: ok (${stops.length} stops, ${formatMinutes(408)} of jobs)`);
