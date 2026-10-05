/** Checks for tools/lidar-trees.js.   node tools/lidar-trees.test.js */
import { coveredShare, markOnLawn, patchMask, inferredRings } from './lidar-trees.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};

const W = 20, H = 20;
const sq = (x0, y0, x1, y1) => ({ polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], holes: [] });
const m = patchMask([sq(0, 0, 10, 10)], W, H);
let n = 0; for (const v of m) n += v;
check('a 10 x 10 patch fills about 100 pixels', n >= 90 && n <= 121, String(n));
const half = new Uint8Array(W * H);
for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if (x < 5) half[y * W + x] = 1;
const share = coveredShare(half, m);
check('half of a strip under the patch reads about a half', share > 0.4 && share < 0.65, String(share));
check('nothing to cover: no answer', coveredShare(new Uint8Array(4), new Uint8Array(4)) === null);
const lawn = new Uint8Array(W * H);
for (let i = 0; i < 20 * 3; i++) lawn[i] = 1; // the top three rows
const marked = markOnLawn([sq(0, 0, 10, 10), sq(12, 12, 18, 18)], lawn, W, H, 1, 1);
check('a patch over the lawn is on it, one away from it is not', marked[0].onLawn && !marked[1].onLawn, JSON.stringify(marked.map((c) => c.onLawnSqM)));
const frame = { lng: 0.5, lat: 0.5, zoom: 18, size: 640 };
const rings = inferredRings([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { type: 'Feature', properties: { inferred: true }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }], frame, W, H);
check('only the inferred shapes come back', rings.length === 1, JSON.stringify(rings));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nlidar trees: ok');
