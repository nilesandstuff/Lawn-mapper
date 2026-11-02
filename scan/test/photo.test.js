// scan/lib/photo.js: the photo as a map. node scan/test/photo.test.js
import assert from 'node:assert/strict';
import { frameFor, bboxOf, toPx, fromPx, toMerc, ringsOf } from '../lib/photo.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const O = [-85.70712, 42.83547];
const bbox = bboxOf(O, [[-20, -15], [25, 30]], 10);
const f = frameFor(bbox, O[1]);
assert.ok(f.zoom >= 15 && f.zoom <= 20, `a zoom that fits: ${f.zoom}`);
near(f.lng, -85.70712 + ((2.5 / (6378137 * Math.cos(O[1] * Math.PI / 180))) * 180) / Math.PI, 1e-6, 'centred on the points');
// pixels and back
const px = toPx(f, O, [10, -5], 1280, 1280);
const back = fromPx(f, O, px, 1280, 1280);
near(back[0], 10, 1e-6, 'east back'); near(back[1], -5, 1e-6, 'north back');
// north is up: a point farther north is higher on the photo (smaller y); east is right
const a = toPx(f, O, [0, 0], 1280, 1280), b = toPx(f, O, [0, 10], 1280, 1280), c = toPx(f, O, [10, 0], 1280, 1280);
assert.ok(b[1] < a[1] && c[0] > a[0]);
// the frame covers the bbox: its corners fall inside the photo
const corners = [[-30, -25], [35, 40]].map((p) => toPx(f, O, p, 1280, 1280));
for (const [x, y] of corners) assert.ok(x >= 0 && x <= 1280 && y >= 0 && y <= 1280, `inside: ${x},${y}`);
// a photo at half size scales the same points
const half = toPx(f, O, [10, -5], 640, 640);
near(half[0], px[0] / 2, 1e-9, 'half x');
assert.ok(Number.isFinite(toMerc(O)[0]));
// rings out of what the map record keeps
const rings = ringsOf([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }, { type: 'MultiPolygon', coordinates: [[[[2, 2], [3, 2], [3, 3], [2, 2]]]] }, null]);
assert.equal(rings.length, 2);
assert.deepEqual(rings[1][0], [2, 2]);
console.log('photo: ok');
