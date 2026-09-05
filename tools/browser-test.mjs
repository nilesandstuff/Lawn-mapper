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
// A real address inside Ottawa County, whose parcel the county probe returns.
const ADDRESS = '3300 Van Buren St, Hudsonville, MI';

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

const armed = await page.evaluate(() => window.__lm.armed);
check('lawn picker is armed', armed === true, `armed=${armed}`);

const busyVisible = await page.locator('#busy').isVisible();
check('loading overlay is gone', busyVisible === false, `busy visible=${busyVisible}`);

/* ------------------------------------------------------- THE TAP ITSELF */
/*
 * Touch first, and on its own terms.
 *
 * The previous version of this test called page.click(), which dispatches a
 * real mouse click even under mobile emulation -- so it passed while the app
 * was completely unusable on a phone. Mapbox GL Draw calls preventDefault on
 * touchend, which stops the browser synthesising the click event that
 * map.on('click') is built on. Only a genuine touch sequence exercises that.
 */
console.log('\n--- tapping the map (real touch events) ---');

const box = await page.locator('#map').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(1200);

const afterTouch = await page.evaluate(() => ({
  clicks: window.__lm.clicks,
  rejected: window.__lm.rejected,
  viaTouch: window.__lm.viaTouch,
  viaClick: window.__lm.viaClick,
  lastMode: window.__lm.lastMode,
}));
console.log(`      __lm after touch tap: ${JSON.stringify(afterTouch)}`);

check('a real touch tap registers', afterTouch.clicks > 0,
  afterTouch.clicks === 0
    ? 'THE BUG: touchend never reached the handler, so the map is dead to fingers'
    : `handled via ${afterTouch.viaTouch ? 'the touch path' : 'the click path'}`);
check('the tap was not rejected by the mode guard', afterTouch.rejected === 0,
  `rejected=${afterTouch.rejected}, mode = ${afterTouch.lastMode}`);
check('one tap is counted once, not twice', afterTouch.clicks === 1,
  `${afterTouch.clicks} registrations for a single tap`);
check('Detect my lawn became enabled', await page.locator('#btn-detect').isEnabled());

/* --------------------------------- several areas, as a split lawn needs */
console.log('\n--- marking a second and third area ---');
await page.touchscreen.tap(cx - 70, cy - 60);
await page.waitForTimeout(500);
await page.touchscreen.tap(cx + 70, cy + 60);
await page.waitForTimeout(800);

const pins = await page.evaluate(() => window.__lm.clicks);
const label = await page.locator('#btn-detect').textContent();
console.log(`      taps handled: ${pins}   button now: "${label}"`);
check('each extra area is marked', pins === 3, `${pins} taps handled`);
check('the button says how many areas will be sent', /3 areas/.test(label), label);

await page.click('#btn-undo-pin');
await page.waitForTimeout(400);
check('undo removes the last pin', /2 areas/.test(await page.locator('#btn-detect').textContent()));

/* --------------------------------------------- the edge extension tool */
console.log('\n--- edge extension ---');
await page.click('#btn-parcel-shape');
await page.waitForTimeout(800);

const seeded = await page.evaluate(() => window.__lmDraw ? null : document.querySelector('#result').hidden);
check('using the property line produces a measurable shape', seeded === false,
  `result panel hidden = ${seeded}`);
console.log(`      area from parcel: ${await page.locator('#result-sqft').textContent()} sq ft`);

await page.click('#btn-edges');
await page.waitForTimeout(400);
check('edge panel opens', await page.locator('#edge-panel').isVisible());

// Tap near the parcel outline to select an edge. The parcel fills much of the
// map, so a tap near its left portion should land close to a boundary.
await page.touchscreen.tap(box.x + 12, cy);
await page.waitForTimeout(700);
const edgeInfo = await page.locator('#edge-info').textContent();
console.log(`      ${edgeInfo}`);

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
