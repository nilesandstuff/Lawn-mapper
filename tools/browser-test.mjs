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

/*
 * The map still has to accept a touch, because the edge tool uses it. This is
 * the regression guard for the bug that made the whole app dead on a phone:
 * Mapbox GL Draw calls preventDefault on touchend, which suppresses the click
 * event map.on('click') is built on.
 */
const box = await page.locator('#map').boundingBox();
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

await page.click('#btn-edge-done');
await page.waitForTimeout(300);
check('edge panel closes', !(await page.locator('#edge-panel').isVisible()));

await page.screenshot({ path: 'browser-test.png', fullPage: false });

console.log(`\nconsole/page errors:${errors.length ? '\n  ' + errors.slice(0, 12).join('\n  ') : ' (none)'}`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
