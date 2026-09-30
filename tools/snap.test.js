/**
 * Where New shape and Cut out put a tapped point (public/lib/snap.js).
 *   node tools/snap.test.js
 */
import { snapPoint, inRing, SNAP_PX } from '../public/lib/snap.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

// A 200 x 100 lawn with a 20 x 20 shed hole, in pixels.
const outer = [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]];
const hole = [[90, 40], [110, 40], [110, 60], [90, 60], [90, 40]];
const lawn = { rings: [outer, hole], areas: [{ outer, holes: [hole] }] };

check('the ring test knows inside from outside', inRing([50, 50], outer) && !inRing([250, 50], outer));

let r = snapPoint([50, 50], lawn);
check('a point well inside stays where it was tapped', !r.snapped && same(r.point, [50, 50]));

r = snapPoint([50, 5], lawn);
check('a point near an edge lands on it', r.snapped && same(r.point, [50, 0]), JSON.stringify(r.point));

r = snapPoint([50, -60], lawn);
check('a point outside every lawn is pulled onto the nearest edge, however far',
  r.snapped && same(r.point, [50, 0]), JSON.stringify(r.point));

r = snapPoint([196, 97], lawn);
check('a corner within reach wins over the edge', r.snapped && same(r.point, [200, 100]), JSON.stringify(r.point));

r = snapPoint([100, 50], lawn);
check('inside the hole counts as outside the lawn, so it goes to the hole edge',
  r.snapped && (r.point[0] === 90 || r.point[0] === 110 || r.point[1] === 40 || r.point[1] === 60),
  JSON.stringify(r.point));

r = snapPoint([50, SNAP_PX + 5], lawn);
check('just beyond reach inside is left alone', !r.snapped);

r = snapPoint([10, 10], { rings: [], areas: [] });
check('with nothing to snap to, nothing moves', !r.snapped && same(r.point, [10, 10]));

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
