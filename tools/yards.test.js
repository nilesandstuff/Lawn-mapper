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
const area = (r, name) => (by(r, name) ? sqm(by(r, name).poly) : 0);
const names = (r) => r.sections.map((s) => s.name).join(', ');
const sizes = (r) => r.error || r.sections.map((s) => `${s.name} ${sqm(s.poly).toFixed(1)}`).join(', ');
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
const lawnOf = (holes, building = house) => {
  const lot = [[ringLL(rectM(0, 0, 30, 40))]];
  const cut = [[building], ...holes.map((h) => [[ringLL(h)]])];
  return clip.difference(lot, ...cut).map((poly) => ({ type: 'Polygon', coordinates: poly }));
};
const driveway = rectM(21, 0, 24, 12);
const ADDRESS = '123 Example St, Anytown';
const lot = (extra = {}) => ({ parcel, buildings: [house], roads: [front], address: ADDRESS, lawn: lawnOf([driveway]), ...extra });

/* ---------------------------------------------------- the default: front and back only */
{
  const r = autoYards(clip, lot());
  check('a plain lot splits into front and back', !r.error && names(r) === 'Front, Back', sizes(r));
  if (!r.error) {
    check('the house faces its street', r.info.facing === 'south' && r.info.matched && r.info.street === 'Example Street', JSON.stringify(r.info));
    check('open sides go with the front', near(area(r, 'Front'), 324 + 90 + 90), sizes(r));
    check('the back is the lawn behind the back wall', near(area(r, 'Back'), 540), sizes(r));
    check('the sections add up to the lawn', near(sum(r), 1200 - 120 - 36, 0.5), sum(r).toFixed(1));
  }
}

/* ---------------------------------------------------- sides kept */
{
  const r = autoYards(clip, lot({ sides: true }));
  check('with sides on, four sections', !r.error && names(r) === 'Front, Back, Side (west), Side (east)', sizes(r));
  if (!r.error) {
    check('front: the lawn in front of the front wall, less the driveway', near(area(r, 'Front'), 324), sizes(r));
    check('each side is the strip beside the house', near(area(r, 'Side (west)'), 90) && near(area(r, 'Side (east)'), 90), sizes(r));
    check('sides on: the sections add up', near(sum(r), 1044, 0.5), sum(r).toFixed(1));
  }
}

/* The garage wing projects its own front line (the stepped line). */
{
  const wingPts = [[9, 12], [21, 12], [21, 8], [27, 8], [27, 22], [9, 22]];
  const wing = [ringLL(wingPts)];
  const r = autoYards(clip, lot({ buildings: [wing], lawn: lawnOf([], wing), sides: true }));
  check('a wing steps the front line', !r.error, r.error);
  if (!r.error) {
    check('east of the wing, the front starts at the wing\'s front', inside(by(r, 'Front').poly, [28, 7]) && !inside(by(r, 'Front').poly, [28, 9]) && inside(by(r, 'Side (east)').poly, [28, 9]));
    check('west of the house, the front starts at the house front', inside(by(r, 'Front').poly, [5, 11]) && !inside(by(r, 'Front').poly, [5, 13]));
    check('in front of the recess between, lawn is front', inside(by(r, 'Front').poly, [15, 10]));
    check('the wing lot adds up: front 324, east side 42', near(area(r, 'Front'), 324) && near(area(r, 'Side (east)'), 42), sizes(r));
  }
}

/* A corner lot: a side street down the east. The side yard runs the full depth. */
{
  const sideSt = road('Side Avenue', [[38, -60], [38, 100]]);
  const r = autoYards(clip, lot({ roads: [front, sideSt], sides: true }));
  check('a corner lot is seen', !r.error && r.info.sideStreet === 'Side Avenue' && r.info.corner && r.info.cornerStrip && !r.info.facesCorner, r.error || JSON.stringify(r.info));
  if (!r.error) {
    check('the side along the side street runs to the back of the lot', near(area(r, 'Side (east)'), 9 * 28), sizes(r));
    check('the back stops at the house\'s street-side wall', near(area(r, 'Back'), 21 * 18), sizes(r));
    check('corner lot: the sections add up', near(sum(r), 1044, 0.5), sum(r).toFixed(1));
  }
  const r2 = autoYards(clip, lot({ roads: [front, sideSt] }));
  check('lumped, the open corner strip goes with the front', !r2.error && near(area(r2, 'Front'), 324 + 252 + 90) && near(area(r2, 'Back'), 378), sizes(r2));
  const r3 = autoYards(clip, lot({ roads: [front, sideSt], address: '9 Side Ave', lawn: lawnOf([]) }));
  check('addressed on the other street, the house faces it', !r3.error && r3.info.facing === 'east', r3.error || JSON.stringify(r3.info));
}

/* A house set at an angle to the corner faces the corner: the tiebreak. */
{
  const big = polyM(rectM(0, 0, 40, 40));
  const c = [20, 20]; const u = [Math.SQRT1_2, -Math.SQRT1_2]; const v = [Math.SQRT1_2, Math.SQRT1_2];
  const pt = (a, b) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b];
  const angled = [pt(5, -6), pt(5, 6), pt(-5, 6), pt(-5, -6)];
  const sideSt = road('Side Avenue', [[48, -60], [48, 100]]);
  const lawn = clip.difference([[ringLL(rectM(0, 0, 40, 40))]], [[ringLL(angled)]]).map((poly) => ({ type: 'Polygon', coordinates: poly }));
  const r = autoYards(clip, { parcel: big, buildings: [[ringLL(angled)]], roads: [front, sideSt], address: '5 Example St', lawn, sides: true });
  check('an angled corner house faces the corner', !r.error && r.info.facesCorner && r.info.facing === 'south-east' && !r.info.cornerStrip, r.error || JSON.stringify(r.info));
  if (!r.error) {
    check('the corner is front, the far corner is back', inside(by(r, 'Front').poly, [36, 4]) && inside(by(r, 'Back').poly, [4, 36]));
    check('angled: the sections add up', near(sum(r), 1600 - 120, 0.5), sum(r).toFixed(1));
    check('the sides are named by the compass', r.sections.filter((s) => s.name.startsWith('Side')).map((s) => s.name).sort().join(',') === 'Side (north-east),Side (south-west)', names(r));
  }
  const r2 = autoYards(clip, { parcel: big, buildings: [[ringLL(angled)]], roads: [front], address: '5 Example St', lawn });
  check('the same house with no corner to decide it is no clear answer', r2.unclear && /equally/.test(r2.error), r2.error || sizes(r2));
}

/* The barrier rule: a patio across the east side cuts that lawn off from the back. */
{
  const patio = rectM(21, 20, 30, 22);
  const r = autoYards(clip, lot({ lawn: lawnOf([driveway, patio]) }));
  check('lumped: a side cut off from the back joins the front, the open one too', !r.error && near(area(r, 'Front'), 324 + 72 + 90) && near(area(r, 'Back'), 540), sizes(r));
  const r2 = autoYards(clip, lot({ lawn: lawnOf([driveway, patio]), sides: true }));
  check('sides on: it stays a side', !r2.error && near(area(r2, 'Side (east)'), 72) && near(area(r2, 'Front'), 324), sizes(r2));
}

/* A sudden pinch: a bed leaves a 0.7 m passage beside the house, and the side is two pieces. */
{
  const bed = rectM(21.7, 15, 30, 17);
  const r = autoYards(clip, lot({ lawn: lawnOf([bed]) }));
  check('a pinch under 3 ft is a barrier: the near part goes front, the far part back',
    !r.error && r.info.pinched === 1 && near(area(r, 'Front'), 360 + 90 + 27, 2) && near(area(r, 'Back'), 540 + 45 + 1.4, 2), sizes(r) + (r.info ? ` pinched ${r.info.pinched}` : ''));
  if (!r.error) check('pinched: the sections add up', near(sum(r), 1200 - 120 - 16.6, 0.5), sum(r).toFixed(1));
  const wide = rectM(23, 15, 30, 17); // a 2 m passage is not a pinch
  const r2 = autoYards(clip, lot({ lawn: lawnOf([wide]) }));
  check('a 2 m passage is not a pinch', !r2.error && r2.info.pinched === 0 && near(area(r2, 'Front'), 360 + 90 + 90 - 14), sizes(r2));
}

/* The owner's first wrong mark: a fenced strip whose few feet in front of the house corner were counted as front. */
{
  const fence = rectM(0, 11.3, 9, 11.6); // the trace stops at the fence, a little in front of the house corner
  const drive = rectM(21, 0, 30, 22); // the east flank is all driveway: the strip joins only the back
  const r = autoYards(clip, lot({ lawn: lawnOf([fence, drive]), sides: true }));
  check('the sliver in front of the corner goes with the strip, not the front', !r.error && near(area(r, 'Side (west)'), 90 + 3.6) && near(area(r, 'Front'), 101.7 + 144), sizes(r));
  if (!r.error) check('fenced strip: the sections add up', near(sum(r), 879.3, 0.5), sum(r).toFixed(1));
  const r2 = autoYards(clip, lot({ lawn: lawnOf([fence, drive]) }));
  check('lumped, the strip is secluded: back', !r2.error && near(area(r2, 'Back'), 540 + 93.6) && near(area(r2, 'Front'), 245.7), sizes(r2));
}

/* The house is the building at the map's point, not the biggest. */
{
  const barn = [ringLL(rectM(2, 26, 17, 38))]; // 180 m2, bigger than the house
  const lawn = lawnOf([rectM(2, 26, 17, 38)]);
  const r = autoYards(clip, lot({ buildings: [barn, house], lawn, point: F.toLngLat([15, 17]) }));
  check('with the point on the house, the house is the house', !r.error && r.info.houseSqM === 120 && r.info.otherBuilding && r.info.facing === 'south', r.error || JSON.stringify(r.info));
  const shed = [ringLL(rectM(2, 34, 6, 38))];
  const r2 = autoYards(clip, lot({ buildings: [shed, house], lawn: lawnOf([rectM(2, 34, 6, 38)]) }));
  check('with no point, the biggest building is the house, and a shed is not another', !r2.error && r2.info.houseSqM === 120 && !r2.info.otherBuilding, r2.error || JSON.stringify(r2.info));
}

/* No address: the nearest named road, when there is only one. */
{
  const r = autoYards(clip, lot({ address: null }));
  check('with no address the nearest named road is the front', !r.error && !r.info.matched && !r.info.hadStreet && r.info.street === 'Example Street' && r.info.facing === 'south', JSON.stringify(r.info));
  const sideSt = road('Side Avenue', [[38, -60], [38, 100]]);
  const r2 = autoYards(clip, lot({ address: null, roads: [front, sideSt] }));
  check('with no address on a corner lot there is no clear answer', r2.unclear && /two streets/.test(r2.error), r2.error);
  const r3 = autoYards(clip, lot({ address: '1 Nowhere Rd', roads: [front, sideSt] }));
  check('an address no road matches on a corner lot is no clear answer', r3.unclear && /named like the address/.test(r3.error), r3.error);
  const r4 = autoYards(clip, lot({ address: null, street: 'Example Street' }));
  check('a street given on its own is matched', !r4.error && r4.info.matched && r4.info.hadStreet, r4.error || JSON.stringify(r4.info));
}

/* A building straddling the lot line is no clear answer. */
{
  const straddle = [ringLL(rectM(-15, 12, 7, 22))]; // two thirds off the lot
  const r = autoYards(clip, lot({ buildings: [straddle], lawn: lawnOf([], straddle) }));
  check('a building half off the lot is no clear answer', r.unclear && /straddles/.test(r.error), r.error);
}

/* Nothing to go on. */
check('no building is an error, not a guess', !!autoYards(clip, lot({ buildings: [] })).error);
check('no property line is an error', !!autoYards(clip, lot({ parcel: null })).error);
check('no road is an error', !!autoYards(clip, lot({ roads: [] })).error);

/* The rectangle fit. */
{
  const box = fitRectangle([[0, 0], [10, 0], [10, 4], [0, 4], [5, 2]]);
  check('a rectangle fits a rectangle', box && near(box.area, 40, 0.01) && near(box.centre[0], 5, 0.01) && near(box.centre[1], 2, 0.01), JSON.stringify(box));
}

/* A fence from the shade map is a barrier: across the east side, it cuts the side in two. */
{
  const fence = ll([[21, 17], [30, 17]]);
  const r = autoYards(clip, lot({ lawn: lawnOf([]), fences: [fence] }));
  check('a fence across a side cuts it: the near part front, the far part back', !r.error && near(area(r, 'Front'), 360 + 90 + 45, 2) && near(area(r, 'Back'), 540 + 45, 2), sizes(r));
  if (!r.error) check('the fence gap is given back: the sections add up', near(sum(r), 1080, 0.5), sum(r).toFixed(1));
  const r2 = autoYards(clip, lot({ lawn: lawnOf([]), fences: [fence], sides: true }));
  check('with sides kept the fence still leaves one side section of two pieces', !r2.error && near(area(r2, 'Side (east)'), 90, 1) && near(sum(r2), 1080, 0.5), sizes(r2));
}

/* A COMPLEX: six buildings round a loop road on one lot. */
{
  const big = polyM(rectM(0, 0, 160, 120));
  const loop = { name: null, cls: 'residential', width: 6, lines: [ll([[40, 30], [120, 30], [120, 90], [40, 90], [40, 30]])] };
  const spec = { A: rectM(70, 39, 90, 51), B: rectM(70, 69, 90, 81), C: rectM(48, 52, 62, 68), D: rectM(70, 9, 90, 21), E: rectM(70, 99, 90, 111), F: rectM(128, 52, 142, 68) };
  const bldgs = Object.values(spec).map((pts) => [ringLL(pts)]);
  const bands = [[40, 27, 120, 33], [40, 87, 120, 93], [37, 27, 43, 93], [117, 27, 123, 93]].map((b) => [[ringLL(rectM(...b))]]);
  const lawn = clip.difference([[ringLL(rectM(0, 0, 160, 120))]], ...bldgs.map((b) => [b]), ...bands).map((poly) => ({ type: 'Polygon', coordinates: poly }));
  const lawnSqM = lawn.reduce((t, f) => t + geometryAreaSqM(f), 0);
  const r = autoYards(clip, { parcel: big, buildings: bldgs, roads: [loop], address: null, lawn });
  check('six buildings round a loop are a complex', !r.error && r.info.complex && r.info.buildings === 6 && r.info.grouping === 'loop', r.error || JSON.stringify(r.info));
  if (!r.error) {
    const n = names(r);
    check('the sections are front and back, inside and outside the loop', /Front \(inside the loop\)/.test(n) && /Back \(inside the loop\)/.test(n) && /Front \(outside the loop\)/.test(n) && /Back \(outside the loop\)/.test(n), n);
    check('in front of an inner building is front, inside', inside(by(r, 'Front (inside the loop)').poly, [80, 36]) && inside(by(r, 'Back (inside the loop)').poly, [80, 56]));
    check('in front of an outer building is front, outside', inside(by(r, 'Front (outside the loop)').poly, [80, 24]) && inside(by(r, 'Front (outside the loop)').poly, [125, 60]));
    check('far from every building is common', !!by(r, 'Common') && inside(by(r, 'Common').poly, [5, 5]), n);
    check('a complex adds up to its lawn within a cell\'s worth', Math.abs(sum(r) - lawnSqM) / lawnSqM < 0.01, `${sum(r).toFixed(0)} vs ${lawnSqM.toFixed(0)}`);
    const overlap = (() => { const t = r.sections.map((s) => s.poly); let o = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { try { o += sqm(clip.intersection(t[i], t[j])); } catch { o += 1e9; } } return o; })();
    check('no section overlaps another', overlap < 0.01 * lawnSqM, `overlap ${overlap.toFixed(1)} m2`);
  }
  /* Two roads straight through: three blocks, numbered. */
  const roads3 = [{ name: null, cls: 'residential', width: 6, lines: [ll([[50, -10], [50, 130]])] }, { name: null, cls: 'residential', width: 6, lines: [ll([[110, -10], [110, 130]])] }];
  const spec3 = { A: rectM(15, 40, 35, 52), B: rectM(15, 70, 35, 82), C: rectM(70, 40, 90, 52), D: rectM(70, 70, 90, 82), E: rectM(125, 40, 145, 52), F: rectM(125, 70, 145, 82) };
  const bldgs3 = Object.values(spec3).map((pts) => [ringLL(pts)]);
  const lawn3 = clip.difference([[ringLL(rectM(0, 0, 160, 120))]], ...bldgs3.map((b) => [b]), [[ringLL(rectM(47, 0, 53, 120))]], [[ringLL(rectM(107, 0, 113, 120))]]).map((poly) => ({ type: 'Polygon', coordinates: poly }));
  const r3 = autoYards(clip, { parcel: big, buildings: bldgs3, roads: roads3, address: null, lawn: lawn3 });
  check('two roads through a lot make three numbered blocks', !r3.error && r3.info.grouping === '3 blocks' && /Front \(block 1\)/.test(names(r3)) && /block 3/.test(names(r3)), r3.error || `${JSON.stringify(r3.info)} ${names(r3)}`);
  /* Buildings but no road inside: no clear answer. */
  const r4 = autoYards(clip, { parcel: big, buildings: bldgs, roads: [road('Example Street', [[-60, -8], [200, -8]])], address: null, lawn });
  check('a complex with no road inside is no clear answer', r4.unclear && /no road inside/.test(r4.error), r4.error);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall yards checks passed');
process.exit(failures ? 1 : 0);
