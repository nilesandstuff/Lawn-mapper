/**
 * County photos: the verdict the API stores (worker/src/county.js) and the
 * compare page's filters and projection (public/county.js).
 *   node tools/county.test.js
 */
import { cleanCountyReview, MAX_NUDGE_M } from '../worker/src/county.js';
import { FILTERS, shown, stepIn, doubtful, pathFor, polygonsOf } from '../public/county.js';
import { lngLatToFramePx } from '../public/lib/mercator.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

check('a verdict of ok with a nudge is kept, to the centimetre',
  JSON.stringify(cleanCountyReview({ review: 'ok', east: 0.123, north: -0.5 })) === JSON.stringify({ review: 'ok', east: 0.12, north: -0.5 }));
check('off and null are verdicts too',
  cleanCountyReview({ review: 'off' })?.review === 'off' && cleanCountyReview({ review: null })?.review === null);
check('anything else is refused', cleanCountyReview({ review: 'maybe' }) === null && cleanCountyReview({ review: 'ok', east: 'x' }) === null);
check(`a nudge is held at ${MAX_NUDGE_M} m`, cleanCountyReview({ review: 'ok', east: 50, north: -50 }).east === MAX_NUDGE_M);

const list = [
  { id: 'a', review: null, fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'b', review: 'ok', fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'c', review: null, fit: 0.2, residual_m: 0.05, east: 1, north: 0 },
  { id: 'd', review: 'off', fit: 0.6, residual_m: 0.6, east: 1, north: 0 },
];
check('to check: the unjudged', JSON.stringify(shown(list, 'todo')) === '[0,2]');
check('doubtful: unjudged with a weak fit', JSON.stringify(shown(list, 'doubtful')) === '[2]' && doubtful(list[3]));
check('lines up / do not use', JSON.stringify(shown(list, 'ok')) === '[1]' && JSON.stringify(shown(list, 'off')) === '[3]');
check('stepping wraps within the filter', stepIn(list, 'todo', 2, 1) === 0 && stepIn(list, 'todo', 0, -1) === 2);
check('every filter is a function', Object.values(FILTERS).every((f) => typeof f === 'function'));

/* The outline is projected exactly as training rasterises it: lngLatToFramePx
   against the map's frame and the photo's own pixels. */
const frame = { lng: -85.86, lat: 42.87, zoom: 19.5, size: 640, height: 640 };
const ring = [[-85.8601, 42.8701], [-85.8599, 42.8701], [-85.8599, 42.8699], [-85.8601, 42.8701]];
const d = pathFor([ring], frame, 1280, 1280);
const [x0, y0] = lngLatToFramePx(frame, ring[0], 1280, 1280);
check('outlines use the training projection', d.startsWith(`M${x0.toFixed(1)},${y0.toFixed(1)}`), d.slice(0, 30));
check('multipolygons draw every part', polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }).length === 2);

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
