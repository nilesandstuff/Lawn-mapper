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
console.log('\n--- tapping the map ---');

const box = await page.locator('#map').boundingBox();
console.log(`      map box: ${JSON.stringify(box)}`);

// Tap the middle of the map, the way a person would.
await page.locator('#map').click({ position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) } });
await page.waitForTimeout(1500);

const after = await page.evaluate(() => ({
  clicks: window.__lm.clicks,
  rejected: window.__lm.rejected,
  lastMode: window.__lm.lastMode,
  drawMode: window.__lm.drawMode,
}));
console.log(`      __lm after tap: ${JSON.stringify(after)}`);

check('the click handler fired at all', after.clicks > 0,
  after.clicks === 0
    ? 'the map click event never reached onLawnClick'
    : `${after.clicks} click(s) seen`);
check('the click was not rejected by the mode guard', after.rejected === 0,
  `rejected=${after.rejected}, mode seen = ${after.lastMode}`);

const detectEnabled = await page.locator('#btn-detect').isEnabled();
check('Detect my lawn became enabled', detectEnabled);
console.log(`      status now: "${await page.locator('#status').textContent()}"`);

// Also try a raw touch tap, which is what a phone actually sends.
if (!detectEnabled) {
  console.log('\n--- retrying as a touch tap ---');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => ({ clicks: window.__lm.clicks, rejected: window.__lm.rejected }));
  console.log(`      __lm after touch tap: ${JSON.stringify(t)}`);
  console.log(`      detect enabled now: ${await page.locator('#btn-detect').isEnabled()}`);
}

await page.screenshot({ path: 'browser-test.png', fullPage: false });

console.log(`\nconsole/page errors:${errors.length ? '\n  ' + errors.slice(0, 12).join('\n  ') : ' (none)'}`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
