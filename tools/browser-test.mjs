/**
 * Drives the real app in a real browser, against the real Mapbox libraries.
 *
 * The unit tests cover the maths and the stubbed-Mapbox test covers the DOM
 * wiring, but neither can catch a problem in how Mapbox GL and Mapbox GL Draw
 * actually behave together -- which is exactly where "tapping the map does
 * nothing" lives. This runs on a GitHub Actions runner, which can reach
 * api.mapbox.com.
 *
 * It stops short of pressing "Detect my lawn", so it never spends anything on
 * Replicate. Mapbox usage is a geocode and a few map tiles.
 *
 *   node tools/browser-test.mjs [base-url]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
/*
 * A real address inside Ottawa County, whose parcel the county probe returns.
 *
 * Overridable, because the default is a 3.3-acre rural lot: fine for proving
 * the plumbing, misleading for judging a detection, since most of it is field
 * rather than lawn and the frame is zoomed out far enough to coarsen the
 * imagery. Point it at an ordinary house lot to see a number worth reading.
 */
const ADDRESS = process.env.TEST_ADDRESS || '3300 Van Buren St, Hudsonville, MI';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({
  // Deliberately a phone: this is how it is being used, and touch changes how
  // Mapbox GL interprets a tap.
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text().slice(0, 200)}`);
});

console.log(`\nOpening ${BASE}\n`);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the map to be ready rather than guessing at a delay.
await page.waitForFunction(() => window.__lm !== undefined, { timeout: 30000 });
await page.waitForTimeout(4000);

check('map library loaded', await page.evaluate(() => typeof window.mapboxgl) === 'object');
check('draw library loaded', await page.evaluate(() => typeof window.MapboxDraw) === 'function');
check('address form is visible', await page.locator('#address-form').isVisible());

const drawMode = await page.evaluate(() => window.__lm.drawMode);
console.log(`      draw mode at rest: ${drawMode}`);
check('draw reports a usable mode', drawMode === 'simple_select', drawMode);

/* ------------------------------------------------------------ the flow */
await page.fill('#address', ADDRESS);
await page.click('#address-form button[type=submit]');
await page.waitForTimeout(4000);

const onCandidates = await page.locator('#step-candidates').isVisible();
if (onCandidates) {
  const n = await page.locator('#candidate-list button').count();
  console.log(`      ${n} candidates offered`);
  await page.locator('#candidate-list button').first().click();
  await page.waitForTimeout(600);
}

check('reached the confirm step', await page.locator('#step-confirm').isVisible());
console.log(`      confirming: ${await page.locator('#chosen-label').textContent()}`);

await page.click('[data-action=confirm]');
await page.waitForTimeout(6000);

check('reached the measure step', await page.locator('#step-work').isVisible());
console.log(`      status: "${await page.locator('#status').textContent()}"`);
console.log(`      hint:   "${await page.locator('#map-hint').textContent()}"`);

/*
 * `armed` means the map is listening for a tap, which is now only ever true
 * inside the edge tool. It used to mean "waiting for you to pin each patch of
 * lawn", and this check asserted the pin flow -- so it kept failing after the
 * pins went away, describing a contract the app no longer has. Assert the
 * current one: nothing on the map needs tapping before a detection.
 */
const armed = await page.evaluate(() => window.__lm.armed);
check('nothing needs tapping before detection', armed === false, `armed=${armed}`);

const busyVisible = await page.locator('#busy').isVisible();
check('loading overlay is gone', busyVisible === false, `busy visible=${busyVisible}`);

/* ---------------------------------------------- detection is one press now */
/*
 * There are no pins any more. Asking the model for "grass" finds every patch
 * in the frame at once -- including the ones a person would forget -- and the
 * result is clipped to the property line. So the only thing to check here is
 * that the button is live as soon as we have a frame.
 */
console.log('\n--- detection readiness ---');
check('Detect my lawn is enabled without any tapping',
  await page.locator('#btn-detect').isEnabled());
console.log(`      button: "${await page.locator('#btn-detect').textContent()}"`);
console.log(`      hint:   "${await page.locator('#map-hint').textContent()}"`);
check('the grass-under-trees option is offered and on by default',
  await page.locator('#toggle-trees').isChecked());

/* ------------------------------------------------------- imagery sources */
/*
 * A second photograph is only worth having if it covers the same ground.
 *
 * Everything this app reports is measured against the frame, so a source that
 * returns a rectangle a few metres off produces a lawn that traces beautifully
 * and measures wrong. That is the property under test here -- not that a layer
 * was added, which would be equally true of a picture of the next street.
 */
console.log('\n--- imagery sources ---');
const sources = await page.evaluate(() =>
  [...document.querySelectorAll('#imagery-source option')].map((o) => o.value)
);
check('more than one imagery source is offered', sources.length > 1, sources.join(', '));

if (sources.includes('naip')) {
  await page.selectOption('#imagery-source', 'naip');
  await page.waitForTimeout(2500);

  const shot = await page.evaluate(() => window.__lmImagery());
  check('choosing USGS NAIP puts a photograph on the map', shot.layer === true,
    `provider=${shot.provider} layer=${shot.layer}`);
  check('and it is fetched as one image of the frame, not tiles',
    shot.sourceType === 'image', `sourceType=${shot.sourceType}`);

  // The whole point: the picture's corners ARE the frame's corners.
  const drift = shot.corners && shot.frameCorners
    ? Math.max(...shot.corners.flatMap((c, i) =>
        [Math.abs(c[0] - shot.frameCorners[i][0]), Math.abs(c[1] - shot.frameCorners[i][1])]))
    : Infinity;
  check('and it covers exactly the frame the measurement is made against',
    drift < 1e-9, `worst corner off by ${drift} degrees`);

  /*
   * And the Worker actually got an image back.
   *
   * An image source that fails is invisible: Mapbox GL just never paints the
   * layer, the basemap shows through, and the new source looks identical to
   * the old one. Fetching the same URL the layer uses is the difference
   * between "we asked USGS" and "USGS answered".
   */
  const fetched = await page.evaluate(async () => {
    const url = window.__lmImagery().frameImageUrl;
    if (!url) return { ok: false, why: 'no url' };
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return { ok: res.ok, type: res.headers.get('content-type'), bytes: buf.byteLength };
  });
  check('USGS returned a real photograph for that frame',
    fetched.ok && /^image\//.test(fetched.type || '') && fetched.bytes > 5000,
    `${fetched.type} ${fetched.bytes} bytes`);
}

if (sources.includes('esri')) {
  await page.selectOption('#imagery-source', 'esri');
  await page.waitForTimeout(1500);

  const shot = await page.evaluate(() => window.__lmImagery());
  check('Esri is painted as tiles', shot.sourceType === 'raster',
    `sourceType=${shot.sourceType}`);
  /*
   * Esri's export operation returns a 0x0 image, so it cannot answer the
   * detector. Falling back is correct; falling back silently is not, and the
   * status line names the substitution. What is asserted here is that the
   * fallback is decided the same way in the browser as in the Worker.
   */
  check('and detection falls back to a source that can answer',
    shot.detectsWith === 'mapbox', `detectsWith=${shot.detectsWith}`);
}

await page.selectOption('#imagery-source', 'mapbox');
await page.waitForTimeout(500);
check('switching back removes the extra photograph',
  (await page.evaluate(() => window.__lmImagery())).layer === false);

/*
 * The map still has to accept a touch, because the edge tool uses it. This is
 * the regression guard for the bug that made the whole app dead on a phone:
 * Mapbox GL Draw calls preventDefault on touchend, which suppresses the click
 * event map.on('click') is built on.
 */
const box = await page.locator('#map').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

/* -------------------------------- optionally, a real end-to-end detection */
let detectedSqft = null;
if (process.env.RUN_DETECT === 'true') {
  console.log('\n--- running a REAL detection (this costs money) ---');
  await page.click('#btn-detect');

  // A cold model can take minutes; the app polls and says so.
  await page.waitForFunction(
    () => document.querySelector('#busy').hidden,
    { timeout: 240000 }
  ).catch(() => {});

  const status = await page.locator('#status').textContent();
  const sqft = await page.locator('#result-sqft').textContent();
  const detail = await page.locator('#result-sub').textContent();
  console.log(`      status: "${status}"`);
  console.log(`      RESULT: ${sqft} sq ft   (${detail})`);

  const n = Number(String(sqft).replace(/[^0-9]/g, ''));
  detectedSqft = n;
  check('a real detection produced a lawn', n > 0, `${sqft} sq ft`);
  check('and it is a plausible size, not the whole frame', n > 200 && n < 200000, `${sqft} sq ft`);

  const shapes = await page.evaluate(() => window.__lmShapes ?? null);
  if (shapes !== null) console.log(`      shapes: ${shapes}`);
}

/* --------------------------------------------- the edge extension tool */
console.log('\n--- edge extension ---');
await page.click('#btn-parcel-shape');
await page.waitForTimeout(800);

const seeded = await page.evaluate(() => window.__lmDraw ? null : document.querySelector('#result').hidden);
check('using the property line produces a measurable shape', seeded === false,
  `result panel hidden = ${seeded}`);
const parcelSqft = Number(
  (await page.locator('#result-sqft').textContent()).replace(/[^0-9]/g, '')
);
console.log(`      area from parcel: ${parcelSqft.toLocaleString()} sq ft`);
if (detectedSqft !== null && parcelSqft > 0) {
  // Not an assertion: how much of a lot is lawn varies enormously. It is here
  // because a bare square-footage says nothing about whether the detection was
  // sensible, and the ratio does.
  console.log(`      detected lawn is ${(100 * detectedSqft / parcelSqft).toFixed(1)}% of the parcel`);
}

await page.click('#btn-edges');
await page.waitForTimeout(400);
check('edge panel opens', await page.locator('#edge-panel').isVisible());
check('the edge tool arms the map for a tap',
  await page.evaluate(() => window.__lm.armed) === true);

// Tap near the parcel outline to select an edge. The parcel fills much of the
// map, so a tap near its left portion should land close to a boundary.
await page.touchscreen.tap(box.x + 12, cy);
await page.waitForTimeout(700);
const edgeInfo = await page.locator('#edge-info').textContent();
console.log(`      ${edgeInfo}`);

/*
 * The regression guard for the bug that made the app dead on a phone: Mapbox
 * GL Draw calls preventDefault on touchend, which stops the browser
 * synthesising the click that map.on('click') is built on. It survived every
 * test until someone used a real phone, because page.click() sends a mouse
 * click even under mobile emulation. So insist the tap arrived as a *touch*.
 */
const taps = await page.evaluate(() => ({
  viaTouch: window.__lm.viaTouch, viaClick: window.__lm.viaClick, clicks: window.__lm.clicks,
}));
check('a real touch reaches the map (not just a mouse click)', taps.viaTouch > 0,
  `viaTouch=${taps.viaTouch} viaClick=${taps.viaClick} handled=${taps.clicks}`);

if (await page.locator('#edge-controls').isVisible()) {
  const before = await page.locator('#result-sqft').textContent();
  await page.locator('#edge-slider').fill('25');
  await page.waitForTimeout(600);
  const after = await page.locator('#result-sqft').textContent();
  const bearing = await page.locator('#edge-bearing').textContent();
  console.log(`      ${before} sq ft -> ${after} sq ft after +25 ft   (${bearing})`);
  check('extending an edge increases the area',
    Number(after.replace(/,/g, '')) > Number(before.replace(/,/g, '')),
    `${before} -> ${after}`);
} else {
  console.log('      (no edge selected by that tap — not a failure, geometry dependent)');
}

/* ------------------------------------------------- moving corners around */
/*
 * The corner tools have to be reachable by touch and must not steal taps from
 * extending, which is the operation that preserves the surveyed bearings.
 */
console.log('\n--- corner editing ---');

const corner = await page.evaluate(() => {
  const src = window.__lmPoints?.();
  return src && src.length ? src[0] : null;
});
check('corner handles are drawn for the shape being edited', corner !== null,
  corner ? `${corner.count} corners` : 'no points source');

if (corner) {
  const before = await page.locator('#result-sqft').textContent();

  // Aim at a corner and drag it outward. A touch drag, not a mouse one: this
  // is the gesture that was dead on a phone.
  await page.touchscreen.tap(corner.x, corner.y);
  await page.waitForTimeout(500);
  check('tapping a corner selects the corner, not the edge',
    await page.locator('#point-controls').isVisible(),
    await page.locator('#edge-info').textContent());

  const dragged = await page.evaluate(async ([x, y, idx]) => {
    // The handlers live on Mapbox's canvas container, and a synthetic event
    // dispatched on #map would bubble upward, away from it.
    const el = document.querySelector('.mapboxgl-canvas-container');
    const touch = (t, cx, cy) => el.dispatchEvent(new TouchEvent(t, {
      bubbles: true, cancelable: true,
      touches: t === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
      changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
    }));
    touch('touchstart', x, y);
    for (let i = 1; i <= 6; i++) { touch('touchmove', x + i * 6, y + i * 4); await new Promise((r) => setTimeout(r, 30)); }
    touch('touchend', x + 36, y + 24);
    await new Promise((r) => setTimeout(r, 300));
    return {
      // The same corner by index, not "the widest" again.
      point: window.__lmPoints(idx)[0],
      sqft: document.querySelector('#result-sqft').textContent,
      grabbed: window.__lm.dragGrabbed,
      moved: window.__lm.dragMoved,
    };
  }, [corner.x, corner.y, corner.index]);

  /*
   * Assert on the corner, not on the area. A 61-vertex parcel puts each
   * corner's neighbours a few pixels away, so sliding one sweeps almost no
   * area -- an area check passes or fails on how finely the county digitised
   * the boundary, which is not what is being tested.
   */
  check('the press grabbed a corner', dragged.grabbed > 0, `dragGrabbed=${dragged.grabbed}`);
  check('and the drag registered as movement', dragged.moved > 0, `dragMoved=${dragged.moved}`);
  check('dragging a corner moves it',
    dragged.point.at[0] !== corner.at[0] || dragged.point.at[1] !== corner.at[1],
    `${corner.at.map((n) => n.toFixed(6))} -> ${dragged.point.at.map((n) => n.toFixed(6))}`);

  /*
   * The app hands back the corner whose neighbours are furthest apart, so this
   * assertion is not vacuous. Aimed at vertex 0 of a real Ottawa parcel it
   * would be: those neighbours are 10 cm apart, so the corner can travel 25 m
   * and legitimately change the area by nothing at all.
   */
  const span = Math.hypot(
    (dragged.point.next[0] - dragged.point.prev[0]) * 81000,
    (dragged.point.next[1] - dragged.point.prev[1]) * 111320
  );
  console.log(`      area ${before} -> ${dragged.sqft} sq ft on screen`);
  console.log(`      exact ${corner.sqft.toFixed(1)} -> ${dragged.point.sqft.toFixed(1)} sq ft`);
  console.log(`      corner ${corner.index}, whose neighbours are ${span.toFixed(1)} m apart`);
  check('the measured area tracks the corner',
    Math.abs(dragged.point.sqft - corner.sqft) > 1,
    `moved ${Math.abs(dragged.point.sqft - corner.sqft).toFixed(1)} sq ft`);

  const counts = await page.evaluate(() => window.__lmPoints?.()[0]?.count ?? null);
  const afterDelete = await page.evaluate(async () => {
    document.querySelector('#btn-point-delete').click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__lmPoints?.()[0]?.count ?? null;
  });
  check('deleting a corner removes exactly one', afterDelete === counts - 1,
    `${counts} -> ${afterDelete}`);
}

/* ------------------------------------------------- tidying the boundary */
/*
 * The real Ottawa parcel has 61 vertices with a pair 10 cm apart, so this runs
 * against exactly the mess it exists for rather than a synthetic one.
 */
const tidied = await page.evaluate(async () => {
  const before = window.__lmPoints()[0].count;
  const area = window.__lmPoints()[0].sqft;
  document.querySelector('#btn-tidy').click();
  await new Promise((r) => setTimeout(r, 500));
  return {
    before,
    after: window.__lmPoints()[0].count,
    area,
    areaAfter: window.__lmPoints()[0].sqft,
    said: document.querySelector('#edge-info').textContent,
  };
});
console.log(`      ${tidied.said}`);
check('tidying drops redundant corners from a real county boundary',
  tidied.after < tidied.before, `${tidied.before} -> ${tidied.after} corners`);
check('and leaves the measurement essentially unchanged',
  Math.abs(tidied.areaAfter - tidied.area) / tidied.area < 0.005,
  `${tidied.area.toFixed(0)} -> ${tidied.areaAfter.toFixed(0)} sq ft ` +
  `(${((100 * Math.abs(tidied.areaAfter - tidied.area)) / tidied.area).toFixed(3)}%)`);

/* -------------------------------------------------------------- undo */
/*
 * Undo that quietly does nothing is the classic way this feature ships broken,
 * so assert the number actually returns -- and that it stops at the start of
 * the step rather than unwinding into the paid-for trace.
 */
console.log('\n--- undo ---');
const undone = await page.evaluate(async () => {
  const sqft = () => document.querySelector('#result-sqft').textContent;
  const before = sqft();
  const btn = document.querySelector('#btn-undo');
  const enabledAfterEdits = !btn.disabled;

  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const afterOne = sqft();

  // Drain it: undo must bottom out, not throw or wander past the floor.
  let guard = 0;
  while (!document.querySelector('#btn-undo').disabled && guard++ < 50) {
    document.querySelector('#btn-undo').click();
    await new Promise((r) => setTimeout(r, 60));
  }
  return { before, afterOne, drained: sqft(), guard, enabledAfterEdits };
});

check('undo is offered once there is something to undo', undone.enabledAfterEdits);
check('one undo changes the measurement back',
  undone.afterOne !== undone.before, `${undone.before} -> ${undone.afterOne}`);
check('undo bottoms out instead of running forever', undone.guard < 50,
  `${undone.guard} steps to empty`);
check('and the button disables at the floor',
  await page.evaluate(() => document.querySelector('#btn-undo').disabled));
console.log(`      ${undone.before} -> ${undone.afterOne} -> ${undone.drained} sq ft`);
/*
 * Where undo bottoms out depends on where the step began. Here that is before
 * "Use property line" seeded anything, so an empty map is CORRECT -- and the
 * earlier version of this check asserted a positive square footage read off
 * #result-sqft, which passed on stale text the hidden panel had kept. Ask draw
 * how many shapes exist instead; the label is a rendering, not the state.
 */
const drainedShapes = await page.evaluate(() => window.__lmShapeCount?.() ?? null);
check('undo leaves the map in a state we can read',
  typeof drainedShapes === 'number',
  `${drainedShapes} shape(s) at the floor of the step`);

await page.click('#btn-edge-done');
await page.waitForTimeout(300);
check('edge panel closes', !(await page.locator('#edge-panel').isVisible()));
check('corner handles go away when the tool closes',
  await page.evaluate(() => (window.__lmPoints?.() ?? []).every((s) => s.count === 0)));

/* ------------------------------------------------------------ eraser */
/*
 * The eraser goes through a raster round trip -- paint the shapes, punch out
 * the stroke, re-trace -- so the way it fails is by erasing everything or
 * nothing, neither of which shows up as an exception.
 */
console.log('\n--- eraser ---');
// Undo just unwound to before the shape existed, which is correct and leaves
// nothing to rub out. Seed one again so this tests the eraser rather than the
// guard that refuses to run without shapes.
await page.click('#btn-parcel-shape');
await page.waitForTimeout(700);
check('a shape is available to erase',
  (await page.evaluate(() => window.__lmShapeCount?.() ?? 0)) > 0);

await page.click('#btn-erase');
await page.waitForTimeout(300);
check('the eraser opens', await page.evaluate(() =>
  document.querySelector('#btn-erase').textContent.includes('Done')));

const erased = await page.evaluate(async ([x, y]) => {
  const el = document.querySelector('.mapboxgl-canvas-container');
  const sqft = () => Number(document.querySelector('#result-sqft').textContent.replace(/[^0-9]/g, ''));
  const before = sqft();

  const touch = (t, cx, cy) => el.dispatchEvent(new TouchEvent(t, {
    bubbles: true, cancelable: true,
    touches: t === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
    changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
  }));

  // A stroke straight across the shape, which must remove some of it.
  touch('touchstart', x - 90, y);
  for (let i = -80; i <= 80; i += 10) { touch('touchmove', x + i, y); await new Promise((r) => setTimeout(r, 12)); }
  touch('touchend', x + 80, y);
  await new Promise((r) => setTimeout(r, 700));

  return { before, after: sqft(), said: document.querySelector('#status').textContent };
}, [cx, cy]);

console.log(`      ${erased.said}`);
check('erasing removes area', erased.after < erased.before,
  `${erased.before.toLocaleString()} -> ${erased.after.toLocaleString()} sq ft`);
check('and does not remove everything', erased.after > 0,
  `${erased.after} sq ft left`);

await page.click('#btn-erase');
await page.waitForTimeout(200);
check('the eraser closes', await page.evaluate(() =>
  document.querySelector('#btn-erase').textContent.trim() === 'Erase'));


await page.screenshot({ path: 'browser-test.png', fullPage: false });

/*
 * A 403 from api.mapbox.com means the page was handed a URL-restricted token
 * and this host is not on its list -- the restriction working, but it leaves
 * the test driving a map with no imagery. Call it out rather than letting it
 * sit in a wall of console noise.
 */
if (errors.some((e) => e.includes('403'))) {
  check('the map got its tiles (no 403 from Mapbox)', false,
    'the page is using a URL-restricted token on a host it does not allow — ' +
    'give wrangler dev the unrestricted one');
}

console.log(`\nconsole/page errors:${errors.length ? '\n  ' + errors.slice(0, 12).join('\n  ') : ' (none)'}`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
