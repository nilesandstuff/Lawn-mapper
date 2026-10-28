/**
 * Front, back and sides from the address (public/lib/yards.js).
 *   node tools/yards.test.js
 */
import { readFileSync } from 'node:fs';
import { autoYards, streetOf, sameStreet, fitRectangle, compassOf } from '../public/lib/yards.js';
import { makeFrame } from '../public/lib/edges.js';
import { geometryAreaSqM } from '../public/lib/area.js';

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

/* ------------------------------------------------------------ names */
check('the street of an address', streetOf('1234 Example St SE, Anytown, MI 00000') === 'Example St SE', streetOf('1234 Example St SE, Anytown, MI 00000'));
check('a unit is dropped', streetOf('12 Oak Ave Apt 3, Town') === 'Oak Ave');
check('a point with no address has no street', streetOf('42.83547, -85.70712') === null);
check('St and Street are the same street', sameStreet('Example St SE', 'Example Street Southeast'));
check('a county situs in capitals matches', sameStreet('EXAMPLE ST', 'Example Street'));
check('a direction on one side only still matches', sameStreet('Example St', 'Example Street Northwest'));
check('different directions do not', !sameStreet('Example St NE', 'Example Street Southwest'));
check('different streets do not', !sameStreet('Example St', 'Sample St'));
check('compass', compassOf([0, 1]) === 'north' && compassOf([1, -1]) === 'south-east' && compassOf([-1, 0]) === 'west');

/* ------------------------------------------------------------ a lot in metres */
const F = makeFrame([-85.6, 42.9]);
const ll = (pts) => pts.map(F.toLngLat);
const ringLL = (pts) => ll([...pts, pts[0]]);
const polyM = (pts) => ({ type: 'Polygon', coordinates: [ringLL(pts)] });
const rectM = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const sqm = (multi) => geometryAreaSqM({ type: 'MultiPolygon', coordinates: multi });
const by = (r, name) => r.sections.find((s) => s.name === name || s.name.startsWith(name));
const inside = (multi, p) => {
  const [x, y] = F.toLngLat(p);
  const inRing = (r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i]; const [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  return multi.some((poly) => inRing(poly[0]) && !poly.slice(1).some(inRing));
};
const sum = (r) => r.sections.reduce((s, x) => s + sqm(x.poly), 0);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// A 30 x 40 m lot, its street along the south at y = -8, the house 12 x 10 m
// with its front wall at y = 12, a driveway down its east side to the street.
const parcel = polyM(rectM(0, 0, 30, 40));
const house = [ringLL(rectM(9, 12, 21, 22))];
const road = (name, pts, cls = 'residential') => ({ name, cls, lines: [ll(pts)] });
const front = road('Example Street', [[-60, -8], [90, -8]]);
const lawnOf = (holes) => {
  // The lot less the house and the holes, as lawn shapes: cut with the clipper.
  const lot = [[ringLL(rectM(0, 0, 30, 40))]];
  const cut = [[house], ...holes.map((h) => [[ringLL(h)]])];
  return clip.difference(lot, ...cut).map((poly) => ({ type: 'Polygon', coordinates: poly }));
};
const driveway = rectM(21, 0, 24, 12);

{
  const r = autoYards(clip, { parcel, buildings: [house], roads: [front], address: '123 Example St, Anytown', lawn: lawnOf([driveway]) });
  check('a plain lot splits', !r.error, r.error);
  if (!r.error) {
    check('the house faces its street', r.info.facing === 'south' && r.info.matched && r.info.street === 'Example Street', JSON.stringify(r.info));
    check('front: the lawn in front of the front wall, less the driveway', near(sqm(by(r, 'Front').poly), 30 * 12 - 3 * 12), sqm(by(r, 'Front').poly).toFixed(1));
    check('back: the lawn behind the back wall', near(sqm(by(r, 'Back').poly), 30 * 18), sqm(by(r, 'Back').poly).toFixed(1));
    check('two sides, named west and east', !!by(r, 'Side (west)') && !!by(r, 'Side (east)'), r.sections.map((s) => s.name).join(', '));
    check('each side is the strip beside the house', near(sqm(by(r, 'Side (west)').poly), 90) && near(sqm(by(r, 'Side (east)').poly), 90));
    check('the sections add up to the lawn', near(sum(r), 1200 - 120 - 36, 0.5), sum(r).toFixed(1));
  }
}

/* The garage wing projects its own front line (the stepped line). */
{
  const wing = [ringLL([[9, 12], [21, 12], [21, 8], [27, 8], [27, 22], [9, 22]])]; // garage 6 m wide sticks 4 m forward on the east
  const r = autoYards(clip, { parcel, buildings: [wing], roads: [front], address: '123 Example St', lawn: lawnOf([[[9, 12], [21, 12], [21, 8], [27, 8], [27, 22], [9, 22]]]) });
  check('a wing steps the front line', !r.error, r.error);
  if (!r.error) {
    check('east of the wing, the front starts at the wing\'s front', inside(by(r, 'Front').poly, [28, 7]) && !inside(by(r, 'Front').poly, [28, 9]) && inside(by(r, 'Side (east)').poly, [28, 9]));
    check('west of the house, the front starts at the house front', inside(by(r, 'Front').poly, [5, 11]) && !inside(by(r, 'Front').poly, [5, 13]));
    check('the wing lot adds up: front 324, east side 42', near(sqm(by(r, 'Front').poly), 324) && near(sqm(by(r, 'Side (east)').poly), 42), r.sections.map((s) => `${s.name} ${sqm(s.poly).toFixed(0)}`).join(', '));
    check('in front of the recess between, lawn is front', inside(by(r, 'Front').poly, [15, 10]));
  }
}

/* A corner lot: a side street down the east. The side yard runs the full depth. */
{
  const sideSt = road('Side Avenue', [[38, -60], [38, 100]]);
  const r = autoYards(clip, { parcel, buildings: [house], roads: [front, sideSt], address: '123 Example St', lawn: lawnOf([driveway]) });
  check('a corner lot is seen', !r.error && r.info.sideStreet === 'Side Avenue' && r.info.corner && r.info.cornerStrip && !r.info.facesCorner, JSON.stringify(r.info));
  if (!r.error) {
    check('the side along the side street runs to the back of the lot', near(sqm(by(r, 'Side (east)').poly), 9 * 28), sqm(by(r, 'Side (east)').poly).toFixed(1));
    check('the back stops at the house\'s street-side wall', near(sqm(by(r, 'Back').poly), 21 * 18), sqm(by(r, 'Back').poly).toFixed(1));
    check('the other side is unchanged', near(sqm(by(r, 'Side (west)').poly), 90));
    check('corner lot: the sections add up', near(sum(r), 1044, 0.5), sum(r).toFixed(1));
  }
  // The address on the side street instead: the house faces east, and the strip runs along Example Street.
  const r2 = autoYards(clip, { parcel, buildings: [house], roads: [front, sideSt], address: '9 Side Ave', lawn: lawnOf([]) });
  check('addressed on the other street, the house faces it', !r2.error && r2.info.facing === 'east', JSON.stringify(r2.info));
}

/* A house set at an angle to the corner faces the corner: the tiebreak. */
{
  const big = polyM(rectM(0, 0, 40, 40));
  const c = [20, 20]; const u = [Math.SQRT1_2, -Math.SQRT1_2]; const v = [Math.SQRT1_2, Math.SQRT1_2]; // u: towards the south-east corner
  const pt = (a, b) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b];
  const angled = [pt(5, -6), pt(5, 6), pt(-5, 6), pt(-5, -6)]; // 10 m deep along u, 12 m wide along v
  const sideSt = road('Side Avenue', [[48, -60], [48, 100]]);
  const lawn = clip.difference([[ringLL(rectM(0, 0, 40, 40))]], [[ringLL(angled)]]).map((poly) => ({ type: 'Polygon', coordinates: poly }));
  const r = autoYards(clip, { parcel: big, buildings: [[ringLL(angled)]], roads: [front, sideSt], address: '5 Example St', lawn });
  check('an angled corner house faces the corner', !r.error && r.info.facesCorner && r.info.facing === 'south-east' && !r.info.cornerStrip, r.error || JSON.stringify(r.info));
  if (!r.error) {
    check('the corner is front, the far corner is back', inside(by(r, 'Front').poly, [36, 4]) && inside(by(r, 'Back').poly, [4, 36]));
    check('the two other corners are sides', inside(by(r, 'Side').poly, [4, 4]) || inside(r.sections.filter((s) => s.name.startsWith('Side')).at(-1).poly, [4, 4]));
    check('angled: the sections add up', near(sum(r), 1600 - 120, 0.5), sum(r).toFixed(1));
    check('the sides are named by the compass', r.sections.filter((s) => s.name.startsWith('Side')).map((s) => s.name).sort().join(',') === 'Side (north-east),Side (south-west)', r.sections.map((s) => s.name).join(', '));
  }
}

/* The barrier rule: a patio across the east side cuts that lawn off from the back, so it goes with the front. */
{
  const patio = rectM(21, 20, 30, 22);
  const r = autoYards(clip, { parcel, buildings: [house], roads: [front], address: '123 Example St', lawn: lawnOf([driveway, patio]) });
  check('a side piece walled off from the back joins the front', !r.error && near(sqm(by(r, 'Front').poly), 324 + 9 * 8) && !by(r, 'Side (east)'),
    r.error || r.sections.map((s) => `${s.name} ${sqm(s.poly).toFixed(0)}`).join(', '));
  if (!r.error) check('barrier: the sections add up', near(sum(r), 1044 - 18, 0.5), sum(r).toFixed(1));
}

/* No address: the nearest named road. */
{
  const r = autoYards(clip, { parcel, buildings: [house], roads: [front], address: null, lawn: lawnOf([]) });
  check('with no address the nearest named road is the front', !r.error && !r.info.matched && r.info.street === 'Example Street' && r.info.facing === 'south', JSON.stringify(r.info));
}

/* A shed is not the house. */
{
  const shed = [ringLL(rectM(2, 34, 6, 38))];
  const r = autoYards(clip, { parcel, buildings: [shed, house], roads: [front], address: '123 Example St', lawn: lawnOf([rectM(2, 34, 6, 38)]) });
  check('the biggest building on the lot is the house', !r.error && near(sqm(by(r, 'Back').poly), 540 - 16), r.error || sqm(by(r, 'Back').poly).toFixed(1));
}

/* Nothing to go on. */
check('no building is an error, not a guess', !!autoYards(clip, { parcel, buildings: [], roads: [front], address: '1 Example St', lawn: lawnOf([]) }).error);
check('no property line is an error', !!autoYards(clip, { parcel: null, buildings: [house], roads: [front], address: '1 Example St', lawn: lawnOf([]) }).error);
check('no road is an error', !!autoYards(clip, { parcel, buildings: [house], roads: [], address: '1 Example St', lawn: lawnOf([]) }).error);

/* The rectangle fit. */
{
  const box = fitRectangle([[0, 0], [10, 0], [10, 4], [0, 4], [5, 2]]);
  check('a rectangle fits a rectangle', box && near(box.area, 40, 0.01) && near(box.centre[0], 5, 0.01) && near(box.centre[1], 2, 0.01), JSON.stringify(box));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall yards checks passed');
process.exit(failures ? 1 : 0);
