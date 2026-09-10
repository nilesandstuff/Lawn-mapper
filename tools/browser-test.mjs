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
/* Same reason as the confirm below: a geocode is a network call, so wait for
 * whichever step it lands on rather than for a guess at how long it takes. */
await page.waitForFunction(
  () => document.querySelector('#step-candidates')?.hidden === false
    || document.querySelector('#step-confirm')?.hidden === false,
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(400);

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
/*
 * Wait for the app to be READY, not for a guess at how long that takes.
 *
 * This was a flat 6000 ms, and a county GIS server is not a thing with a
 * predictable latency: one run logged `GET /api/parcel 200 OK (6602ms)` and
 * the test began asserting while the confirm step was still on screen. Three
 * checks failed -- the busy overlay, the detect button, the first tip -- all
 * reporting a working app as broken because Ottawa was half a second slower
 * than a number someone typed.
 *
 * The condition is the thing to wait for. The generous ceiling costs nothing
 * on a fast run, because it returns the moment the overlay goes.
 */
await page.waitForFunction(
  () => document.querySelector('#busy')?.hidden === true
    && document.querySelector('#step-work')?.hidden === false,
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(1200); // let the first tip settle after the load

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

/* ----------------------------------------------------------------- tips */
/*
 * A tip that appears is not the feature. The feature is a tip that POINTS at
 * the control it is talking about: every button on this map is an unlabelled
 * icon, so "press Layers" is useless unless the reader can tell which of nine
 * icons that is. So the arrow's own rectangle is compared against the target
 * button's, which is the only way this can fail -- the words are static text
 * and cannot drift, the aim can.
 */
console.log('\n--- tips ---');
check('tips are on by default', await page.locator('#toggle-tutorials').isChecked());

/** Does the arrow actually touch the button it claims to point at? */
const pointsAt = (tip) => {
  if (!tip.arrow || !tip.target) return { ok: false, why: 'no arrow or no target' };
  const t = tip.target;
  const gapLeft = t.left - tip.arrow.x;   // arrow to the left of the button
  const gapRight = tip.arrow.x - t.right; // arrow to the right of it
  const near = Math.max(gapLeft, gapRight);
  const vertical = tip.arrow.y >= t.top - 6 && tip.arrow.y <= t.bottom + 6;
  return {
    ok: near >= 0 && near < 40 && vertical,
    why: `horizontal gap ${Math.round(near)}px, arrow y ${Math.round(tip.arrow.y)} vs button ${Math.round(t.top)}–${Math.round(t.bottom)}`,
  };
};

const parcelTip = await page.evaluate(() => window.__lmTip());
check('the first tip is about the property line',
  parcelTip.visible && parcelTip.stage === 'parcel',
  `stage=${parcelTip.stage} visible=${parcelTip.visible}`);
console.log(`      "${parcelTip.text}"`);

if (parcelTip.targetId) {
  const aim = pointsAt(parcelTip);
  check(`and its arrow points at #${parcelTip.targetId}`, aim.ok, aim.why);
}

await page.click('#coach-ok');
await page.waitForTimeout(250);

/*
 * The imagery tip follows the property line, so it only follows the FIRST tip
 * when the county supplied one. For an address with no record the boundary has
 * to be traced first, and the tip fires from there instead -- so this is
 * conditional on what the parcel lookup actually returned, not on the test
 * address being a covered one.
 */
// "Use property line" is only offered when the county actually returned one.
const hasParcel = await page.locator('#btn-parcel-shape').isVisible();
const layerTip = await page.evaluate(() => window.__lmTip());
check(hasParcel
  ? 'dismissing it leads to the imagery tip'
  : 'with no county line, the imagery tip waits until one is drawn',
  hasParcel
    ? (layerTip.visible && layerTip.stage === 'layers')
    : layerTip.visible === false,
  `stage=${layerTip.stage} visible=${layerTip.visible} parcel=${hasParcel}`);
if (layerTip.text) console.log(`      "${layerTip.text}"`);

if (layerTip.stage === 'layers') {
  const aim = pointsAt(layerTip);
  check('and its arrow points at the Layers button',
    aim.ok && layerTip.targetId === 'btn-layers', `${layerTip.targetId}: ${aim.why}`);

  /*
   * The one fact a person cannot discover for themselves: some of these
   * photographs can be measured from and some cannot. Built from the live
   * catalogue, so it is checked against what this deployment actually offers
   * rather than against a list written down here.
   */
  const catalogue = await page.evaluate(() => window.__lmImageryCatalogue());
  const named = catalogue.filter((p) => p.detect).every((p) => layerTip.text.includes(p.label));
  check('and it names exactly the sources the AI can be given', named,
    catalogue.map((p) => `${p.label}${p.detect ? '' : ' (view only)'}`).join(', '));
}

/* The switch has to actually switch it off, and back on. */
if (layerTip.visible) {
  await page.uncheck('#toggle-tutorials');
  await page.waitForTimeout(200);
  check('unticking "show me tips" puts the tip away',
    (await page.evaluate(() => window.__lmTip().visible)) === false);

  await page.check('#toggle-tutorials');
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => window.__lmTip());
  check('and ticking it brings tips back, at the step you are actually on',
    back.visible && back.stage === layerTip.stage,
    `was ${layerTip.stage}, came back as ${back.stage}`);

  await page.click('#coach-ok');
  await page.waitForTimeout(200);
}

check('no tip is left sitting over the map',
  (await page.evaluate(() => window.__lmTip().visible)) === false);

/* ------------------------------------------------------ the detection modes */
console.log('\n--- detection modes ---');
{
  const models = await page.evaluate(() => window.__lmModels());
  const ids = models.options.map((m) => m.id);

  check('the deployment offers at least one detection method', models.options.length >= 1,
    ids.join(', ') || '(none)');
  check('every offered method is labelled and explained',
    models.options.every((m) => m.label && m.note),
    ids.join(', '));

  /*
   * Subtract mode is back on offer, with a one-word prompt, after being
   * withheld while its prompt was a list that reported whole parcels as lawn.
   */
  const subtract = models.options.find((m) => m.id === 'sam3_subtract');
  check('subtract mode is offered', !!subtract, ids.join(', '));

  /*
   * The flag the mode turns on, and the one thing here that cannot be checked
   * by looking at the map: a mask traced the wrong way round draws a
   * completely plausible lawn over the house.
   */
  check('and it arrives marked as inverting', subtract?.invert === true,
    JSON.stringify(subtract));
  check('while the default one does not',
    models.options.find((m) => m.id === models.chosen)?.invert === false,
    `chosen: ${models.chosen}`);

  if (subtract) {
    await page.selectOption('#model-choice', 'sam3_subtract');
    await page.waitForTimeout(200);
    const note = await page.textContent('#model-note');
    check('picking it updates the description', note.trim() === subtract.note,
      `showing: ${note.trim().slice(0, 70)}`);
    check('and the app records the switch',
      (await page.evaluate(() => window.__lmModels().chosen)) === 'sam3_subtract');

    // Back to the default: nothing after this should be measuring inverted.
    await page.selectOption('#model-choice', models.chosen);
    await page.waitForTimeout(200);
  }

  /*
   * The developer-only method must not be in the REAL dropdown for an
   * ordinary visitor. Checked against the rendered <option> list rather than
   * app state, because that list is what a person can actually reach -- and
   * this section runs with the measure step on screen, which is the only place
   * the picker is visible.
   */
  const optionIds = await page.$$eval('#model-choice option', (o) => o.map((x) => x.value));
  check('the Testing method is not in the dropdown an ordinary visitor sees',
    !optionIds.includes('sam3_testing'), optionIds.join(', '));
  check('and the dropdown matches what the app thinks it is offering',
    optionIds.join(',') === ids.join(','), `${optionIds.join(',')} vs ${ids.join(',')}`);

  /* One model means no picker: an empty dropdown is worse than none. */
  check('the picker hides itself when there is nothing to choose between',
    models.panelVisible === (models.options.length > 1),
    `${models.options.length} option(s), panel ${models.panelVisible ? 'shown' : 'hidden'}`);

  /* Whatever is selected must be something the Worker actually offers. */
  check('the selected method is one of the offered ones', ids.includes(models.chosen),
    `chosen: ${models.chosen}`);
}

/* ------------------------------------------------------- the Layers button */
console.log('\n--- the Layers button ---');
const layersBefore = await page.evaluate(() => window.__lmLayers());
check('the Layers button is on the map', layersBefore.buttonVisible);
check('and its list starts closed', layersBefore.open === false);

await page.click('#btn-layers');
await page.waitForTimeout(200);
const opened = await page.evaluate(() => window.__lmLayers());
check('pressing it opens the source list', opened.open === true);
check('the list offers every source the panel does',
  opened.options.length === (await page.evaluate(() =>
    document.querySelectorAll('#imagery-source option').length)),
  opened.options.map((o) => o.id).join(', '));
check('and exactly one is ticked',
  opened.options.filter((o) => o.checked).length === 1,
  opened.options.filter((o) => o.checked).map((o) => o.id).join(', '));

/*
 * Choosing from the on-map list must be the same act as choosing from the
 * panel, not a second, parallel setting. Two controls for one choice is how a
 * detection ends up running against a photograph the user is not looking at.
 */
const other = opened.options.map((o) => o.id).find((id) => id !== 'mapbox');
if (other) {
  await page.click(`#layer-list button[data-provider="${other}"]`);
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    provider: window.__lmImagery().provider,
    select: document.querySelector('#imagery-source').value,
    open: window.__lmLayers().open,
  }));
  check(`picking ${other} from the map list selects it`, after.provider === other,
    `provider=${after.provider}`);
  check('and the panel picker agrees', after.select === after.provider,
    `list=${after.provider} select=${after.select}`);
  check('and the list closes behind you', after.open === false);

  await page.selectOption('#imagery-source', 'mapbox');
  await page.waitForTimeout(400);
  check('choosing from the panel ticks the map list too',
    (await page.evaluate(() =>
      window.__lmLayers().options.find((o) => o.id === 'mapbox')?.checked)) === true);
}

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

/*
 * Waiting on the condition, not on a guess.
 *
 * A fixed sleep failed here for a reason worth keeping: USGS took 6.7 seconds
 * to answer a cold request for one frame, and a 2.5-second wait reported the
 * feature broken when it was merely slow. The second attempt then passed
 * because the image was cached -- which is exactly how a flaky test is born.
 */
const waitForPhoto = async (ms = 25000) => {
  try {
    await page.waitForFunction(() => window.__lmImagery().layer === true, { timeout: ms });
    return true;
  } catch { return false; }
};

if (sources.includes('naip')) {
  await page.selectOption('#imagery-source', 'naip');
  const arrived = await waitForPhoto();
  check('the USGS photograph arrives (however slowly)', arrived);

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

/*
 * The bug that made this whole feature useless: choosing USGS imagery hid
 * every shape on the map, and switching back to Mapbox brought them all
 * back. Nothing was lost -- the photograph was being inserted ABOVE the draw
 * layers, because Mapbox GL Draw adds its own when the control is added, which
 * is before the app adds any of its own.
 *
 * Asserted structurally rather than by screenshot: the photograph must sit
 * below every gl-draw layer in the style. A pixel check would pass on a lawn
 * that happens to be dark.
 */
if (sources.includes('naip')) {
  await page.selectOption('#imagery-source', 'naip');
  await waitForPhoto();

  const order = await page.evaluate(() => {
    const ids = window.__lmLayerOrder();
    return {
      photo: ids.indexOf('imagery-alt'),
      firstDraw: ids.findIndex((id) => id.startsWith('gl-draw')),
      ids,
    };
  });
  check('the photograph is on the map', order.photo >= 0);
  check('and it sits UNDER the drawn shapes, not over them',
    order.firstDraw === -1 || order.photo < order.firstDraw,
    `photo at ${order.photo}, first draw layer at ${order.firstDraw}`);
}

/* NDVI was measured against real lawns and rejected, so it must not be
 * offered to the detector -- and must say so rather than just failing. */
if (sources.includes('ndvi')) {
  await page.selectOption('#imagery-source', 'ndvi');
  await waitForPhoto();
  const shot = await page.evaluate(() => ({
    ...window.__lmImagery(),
    note: document.querySelector('#imagery-note').textContent,
    bold: document.querySelector('#imagery-note strong')?.textContent || '',
  }));
  check('NDVI is view-only', shot.detectsWith === 'mapbox', `detectsWith=${shot.detectsWith}`);
  check('and says so in bold',
    /AI detection not available for this imagery source/.test(shot.bold),
    JSON.stringify(shot.bold));
  check('and the NDVI preview really is NDVI, not Mapbox in disguise',
    /provider=ndvi/.test(shot.frameImageUrl || ''), shot.frameImageUrl);
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

if (sources.includes('mapbox')) {
  await page.selectOption('#imagery-source', 'mapbox');
  await page.waitForTimeout(500);
  check('switching back removes the extra photograph',
    (await page.evaluate(() => window.__lmImagery())).layer === false);
}

/* ----------------------------------------------------------- the AI method */
/*
 * There is one model again. The point-prompted one was removed because it
 * could not tell a tree's shadow on a lawn from woodland, and the check that
 * used to be here asserted "more than one method is offered" -- which would
 * now fail on a deliberate removal and read as a regression.
 *
 * What is worth asserting is the rule that survives either way: a picker with
 * a single option is not a choice, so it is not shown, and detection must be
 * ready without one.
 */
console.log('\n--- AI method ---');
const methods = await page.evaluate(() =>
  [...document.querySelectorAll('#model-choice option')].map((o) => o.value));
check('a one-option picker is not shown at all',
  methods.length > 1 || (await page.locator('#model-panel').isHidden()),
  `${methods.length} option(s)`);
check('and detection is ready regardless',
  await page.locator('#btn-detect').isEnabled());

if (methods.includes('sam2')) {
  await page.selectOption('#model-choice', 'sam2');
  await page.waitForTimeout(500);

  const armed = await page.evaluate(() => ({
    disabled: document.querySelector('#btn-detect').disabled,
    text: document.querySelector('#btn-detect').textContent.trim(),
    panel: !document.querySelector('#pin-panel').hidden,
    pins: window.__lmPins().length,
  }));
  check('choosing the pin model asks for pins before it will spend anything',
    armed.disabled && /pin/i.test(armed.text), `"${armed.text}" disabled=${armed.disabled}`);
  check('and the pin panel appears', armed.panel);

  // Place one by tapping the map, the way a person would. (The shared cx/cy
  // are computed further down, after this section.)
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    pins: window.__lmPins().length,
    disabled: document.querySelector('#btn-detect').disabled,
    text: document.querySelector('#btn-detect').textContent.trim(),
  }));
  check('tapping the map places a pin', after.pins === 1, `${after.pins} pin(s)`);
  check('and that unlocks detection', after.disabled === false, `"${after.text}"`);

  // Pins are work, so undo has to reach them.
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  check('undo removes a pin',
    (await page.evaluate(() => window.__lmPins().length)) === 0);

  await page.selectOption('#model-choice', 'sam3');
  await page.waitForTimeout(400);
  check('switching back to the quick method needs no pins',
    (await page.evaluate(() => document.querySelector('#btn-detect').disabled)) === false);
}

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

  /* The third and last tip: the AI has answered, now correct it. */
  const toolTip = await page.evaluate(() => window.__lmTip());
  check('a detection is followed by the editing tip',
    toolTip.visible && toolTip.stage === 'tools',
    `stage=${toolTip.stage} visible=${toolTip.visible}`);
  if (toolTip.visible) {
    const aim = pointsAt(toolTip);
    check('and it points at the shape tools', aim.ok, `${toolTip.targetId}: ${aim.why}`);
    await page.click('#coach-ok');
    await page.waitForTimeout(200);
  }
}

/* Nothing may be left covering the map before the tap-based checks below. */
check('the map is clear of tips before the editing checks',
  (await page.evaluate(() => window.__lmTip().visible)) === false);

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

/*
 * Pressing it twice must not measure the lot twice.
 *
 * It used to: the button added a whole-parcel polygon every time, so a second
 * press doubled the total and a third tripled it, with nothing on the map
 * looking wrong because each duplicate sat exactly on top of the last. The old
 * check pressed it once from an empty map, which is the one sequence that
 * cannot see the bug.
 */
page.once('dialog', (d) => d.accept());
await page.click('#btn-parcel-shape');
await page.waitForTimeout(900);

const twice = Number(
  (await page.locator('#result-sqft').textContent()).replace(/[^0-9]/g, '')
);
const shapesNow = await page.evaluate(() => window.__lmShapeCount());
check('pressing "use property line" twice does not count the lot twice',
  twice === parcelSqft, `${parcelSqft.toLocaleString()} -> ${twice.toLocaleString()} sq ft`);
check('and leaves exactly one shape, not a stack of them',
  shapesNow === 1, `${shapesNow} shape(s)`);
if (detectedSqft !== null && parcelSqft > 0) {
  // Not an assertion: how much of a lot is lawn varies enormously. It is here
  // because a bare square-footage says nothing about whether the detection was
  // sensible, and the ratio does.
  console.log(`      detected lawn is ${(100 * detectedSqft / parcelSqft).toFixed(1)}% of the parcel`);
}

/*
 * Lawn mode, not property-line mode.
 *
 * These checks read #result-sqft, which is the area of the LAWN shapes. Since
 * each mode now owns exactly one thing, editing the property line here would
 * leave that figure untouched and every assertion below would be measuring
 * something it did not move -- passing or failing for reasons unrelated to the
 * edit. The property line gets its own check further down.
 */
await page.click('#mode-shape');
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
/*
 * ASSERT ON WHAT THE LAST EDIT ACTUALLY MOVED.
 *
 * This read #result-sqft, which is the area of the LAWN. Every edit
 * immediately above it -- dragging a corner, deleting one, tidying -- is an
 * edit to the PROPERTY LINE, and undoing one of those correctly leaves the
 * lawn figure alone. So the check failed while the feature worked, reporting
 * "41,010 -> 41,010" as a bug in undo.
 *
 * The file already warns about exactly this a few hundred lines up, where the
 * modes were split: a check that reads a number the edit does not touch
 * "passes or fails for reasons unrelated to the edit". This is that, missed
 * when the warning was written.
 *
 * The corner count is the honest quantity here, because every edit above it
 * changes one. Asserted as "it changed", not as "+1": the entry undo actually
 * pops is whichever came last, and tidying a real county boundary removes
 * fifty-three corners in one go. A first version of this demanded exactly one
 * back and would have failed on the very lot it was written against.
 */
const cornersBeforeUndo = await page.evaluate(() => window.__lmPoints?.()[0]?.count ?? null);
const undone = await page.evaluate(async () => {
  const sqft = () => document.querySelector('#result-sqft').textContent;
  const before = sqft();
  const btn = document.querySelector('#btn-undo');
  const enabledAfterEdits = !btn.disabled;

  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const afterOne = sqft();
  const cornersAfterOne = window.__lmPoints?.()[0]?.count ?? null;

  // Drain it: undo must bottom out, not throw or wander past the floor.
  let guard = 0;
  while (!document.querySelector('#btn-undo').disabled && guard++ < 50) {
    document.querySelector('#btn-undo').click();
    await new Promise((r) => setTimeout(r, 60));
  }
  return { before, afterOne, cornersAfterOne, drained: sqft(), guard, enabledAfterEdits };
});

check('undo is offered once there is something to undo', undone.enabledAfterEdits);
check('one undo reverses the last boundary edit',
  cornersBeforeUndo !== null && undone.cornersAfterOne !== cornersBeforeUndo,
  `${cornersBeforeUndo} -> ${undone.cornersAfterOne} corners` +
  `, lawn ${undone.before} -> ${undone.afterOne}`);
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

await page.click('#mode-shape');
await page.waitForTimeout(300);
check('the lawn tools appear inside lawn mode',
  await page.locator('#shape-tools').isVisible());

await page.click('#tool-erase');
await page.waitForTimeout(300);
check('the eraser opens', await page.evaluate(() =>
  document.querySelector('#tool-erase').getAttribute('aria-pressed') === 'true'));

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

await page.click('#tool-erase');
await page.waitForTimeout(200);
check('pressing the live brush drops back to Points', await page.evaluate(() =>
  document.querySelector('#tool-erase').getAttribute('aria-pressed') === 'false' &&
  document.querySelector('#tool-points').getAttribute('aria-pressed') === 'true'));
check('and the other brushes stay reachable',
  await page.locator('#shape-tools').isVisible());

/*
 * The same stroke in the other direction.
 *
 * Add is the eraser with one bit flipped, so the thing worth asserting is that
 * the bit is actually flipped: the identical gesture over the identical shape
 * must move the measurement UP, not down. A test that only checked "the area
 * changed" would pass on a mislabelled button that erased twice.
 */
console.log('\n--- add (the inverse brush) ---');
await page.click('#tool-add');
await page.waitForTimeout(300);
check('the add brush opens', await page.evaluate(() =>
  document.querySelector('#tool-add').getAttribute('aria-pressed') === 'true'));

const added = await page.evaluate(async ([x, y]) => {
  const el = document.querySelector('.mapboxgl-canvas-container');
  const sqft = () => Number(document.querySelector('#result-sqft').textContent.replace(/[^0-9]/g, ''));
  const before = sqft();

  const touch = (t, cx, cy) => el.dispatchEvent(new TouchEvent(t, {
    bubbles: true, cancelable: true,
    touches: t === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
    changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
  }));

  // Straight back across the gap the eraser just cut.
  touch('touchstart', x - 90, y);
  for (let i = -80; i <= 80; i += 10) { touch('touchmove', x + i, y); await new Promise((r) => setTimeout(r, 12)); }
  touch('touchend', x + 80, y);
  await new Promise((r) => setTimeout(r, 900));

  return { before, after: sqft(), said: document.querySelector('#status').textContent };
}, [cx, cy]);

console.log(`      ${added.said}`);
check('painting with the add brush increases the area', added.after > added.before,
  `${added.before.toLocaleString()} -> ${added.after.toLocaleString()} sq ft`);

/* ------------------------------------------------------- brush width */
/*
 * The only brush anyone can see is the coloured line under their finger, so
 * that line IS the brush. It used to be 24 px wide while the raster painted a
 * 22 px RADIUS -- 44 px across, near enough double what had just been drawn,
 * which is exactly how it was reported. The two numbers now come from one
 * constant, and this asserts they still agree rather than trusting that.
 */
console.log('\n--- brush width ---');
await page.click('#tool-erase');
await page.waitForTimeout(300);

const bulk = await page.evaluate(() => window.__lmBrush());
check('the preview line is exactly as wide as the brush paints',
  bulk.previewWidth === bulk.diameterPx,
  `preview ${bulk.previewWidth} px vs brush ${bulk.diameterPx} px`);

check('the size control appears with the brush', await page.locator('#brush-sizes').isVisible());

await page.click('#size-fine');
await page.waitForTimeout(250);
const fine = await page.evaluate(() => window.__lmBrush());
check('a fine brush is genuinely narrower', fine.diameterPx < bulk.diameterPx,
  `fine ${fine.diameterPx} px vs bulk ${bulk.diameterPx} px`);
check('and the preview follows it', fine.previewWidth === fine.diameterPx,
  `preview ${fine.previewWidth} px vs brush ${fine.diameterPx} px`);

/* ------------------------------- a stroke must not disturb what it missed */
/*
 * The reported symptom was that using a brush "subtly shifts every point in
 * the whole shape". It did: every feature on the map was rasterised and
 * re-traced on every stroke, so vertices far from the brush were resnapped to
 * the pixel grid.
 *
 * Asserted on the coordinates themselves. A centroid barely moves when every
 * vertex shifts a fraction of a pixel outward, so a centroid check would have
 * passed straight through this bug.
 */
console.log('\n--- a stroke leaves distant shapes alone ---');
const ringsBefore = await page.evaluate(() => window.__lmRings());

if (ringsBefore.length) {
  // Paint a small new blob in a far corner, well away from the existing lawn.
  await page.click('#tool-add');
  await page.waitForTimeout(250);
  const mb = await page.locator('#map').boundingBox();
  const fx = mb.x + mb.width * 0.10;
  const fy = mb.y + mb.height * 0.88;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 26, fy, { steps: 6 });
  await page.mouse.move(fx + 26, fy - 22, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const ringsAfter = await page.evaluate(() => window.__lmRings());
  const same = (a, b) => a.length === b.length &&
    a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
  const survived = ringsBefore.filter((ring) => ringsAfter.some((r) => same(ring, r)));

  check('every shape the brush never reached is preserved to the coordinate',
    survived.length === ringsBefore.length,
    `${survived.length} of ${ringsBefore.length} untouched shapes came back identical`);
}

/* ---------------------------------- a stroke that changes nothing does nothing */
/*
 * The half the bounding-box fix missed, reported as: "it even happens if the
 * swipe doesn't actually change anything -- + swipe within an existing shape,
 * or - swipe outside of a shape".
 *
 * Both are strokes with no effect on the lawn, and both used to send the
 * shapes they overlapped through rasterise-and-retrace anyway. That loop is
 * lossy -- corners land on pixel centres and the simplifier trims them -- so
 * every idle swipe shaved the shape a little, and it accumulated.
 *
 * Coordinates again, not area: a square losing a pixel off each corner barely
 * moves its total, which is exactly how this survived an area check.
 */
console.log('\n--- an idle stroke changes nothing at all ---');
{
  const before = await page.evaluate(() => window.__lmRings());
  const beforeSqFt = await page.evaluate(() => window.__lmSqft());

  if (before.length) {
    /*
     * Aim inside a shape that is really there, rather than at the middle of
     * the map and hoping. The largest ring's own vertices give a point that
     * is certainly interior: the average of a convex-ish ring.
     */
    const biggest = before.reduce((a, b) => (b.length > a.length ? b : a));
    const centre = biggest.reduce(
      (acc, p) => [acc[0] + p[0] / biggest.length, acc[1] + p[1] / biggest.length],
      [0, 0]
    );
    const at = await page.evaluate((ll) => {
      const pt = window.__lmProject(ll);
      return pt ? { x: pt.x, y: pt.y } : null;
    }, centre);

    if (at) {
      const mb = await page.locator('#map').boundingBox();
      await page.click('#tool-add');
      await page.waitForTimeout(250);
      // A short swipe entirely inside ground already counted as lawn.
      await page.mouse.move(mb.x + at.x, mb.y + at.y);
      await page.mouse.down();
      await page.mouse.move(mb.x + at.x + 12, mb.y + at.y, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(900);

      const after = await page.evaluate(() => window.__lmRings());
      const afterSqFt = await page.evaluate(() => window.__lmSqft());
      const same = (a, b) => a.length === b.length &&
        a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

      check('adding inside existing lawn leaves every coordinate untouched',
        after.length === before.length && before.every((r, i) => same(r, after[i])),
        `${before.length} rings before, ${after.length} after`);
      check('and the measurement does not drift',
        afterSqFt === beforeSqFt, `${beforeSqFt} -> ${afterSqFt} sq ft`);
    }
  }
}

await page.click('#mode-shape');
await page.waitForTimeout(200);
check('the Lawn button is what closes lawn mode', await page.evaluate(() =>
  document.querySelector('#mode-shape').getAttribute('aria-pressed') === 'false' &&
  document.querySelector('#shape-tools').hidden === true));

/* ------------------------------------- the brush stops at the boundary */
/*
 * Painting past the property line put someone else's ground into the total,
 * and a brush is loose by nature -- a wide stroke along the frontage picks up
 * the verge without anyone meaning it. The detection is already trimmed to
 * this line, so the brush honouring it is what makes the two agree.
 *
 * Tested by painting somewhere definitely outside: the far corner of the map,
 * well beyond a suburban lot. Inside the line, that stroke must add nothing.
 */
console.log('\n--- the Add brush respects the property line ---');
/*
 * Tied to whether this address actually has a boundary, rather than to
 * whatever the page happens to be showing. Written the other way first --
 * a bare `if (visible)` around a `check(..., true)` -- which asserted nothing
 * and would have skipped the entire section in silence had the toggle failed
 * to appear, reporting a green run that had tested none of this.
 */
const outsideVisible = await page.locator('#outside-opt').isVisible();
check('the outside-the-line toggle appears exactly when there is a boundary',
  outsideVisible === hasParcel,
  `toggle visible=${outsideVisible}, county parcel=${hasParcel}`);

if (outsideVisible) {
  check('and it is off by default, so the boundary is honoured',
    (await page.locator('#toggle-outside').isChecked()) === false);

  await page.click('#mode-shape');
  await page.waitForTimeout(250);
  await page.click('#tool-add');
  await page.waitForTimeout(250);

  const mapBox = await page.locator('#map').boundingBox();
  const paintFarCorner = async () => {
    const x = mapBox.x + mapBox.width * 0.06;
    const y = mapBox.y + mapBox.height * 0.08;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 10, { steps: 8 });
    await page.mouse.move(x + 70, y + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(900);
  };

  const beforePaint = await page.evaluate(() => window.__lmSqft());
  await paintFarCorner();
  const afterPaint = await page.evaluate(() => window.__lmSqft());

  check('painting outside the property line adds nothing to the total',
    Math.abs(afterPaint - beforePaint) < 1,
    `${Math.round(beforePaint).toLocaleString()} -> ${Math.round(afterPaint).toLocaleString()} sq ft`);

  /* With the toggle on, the same stroke is allowed. */
  await page.check('#toggle-outside');
  await page.waitForTimeout(300);
  await paintFarCorner();
  const allowed = await page.evaluate(() => window.__lmSqft());
  check('turning the toggle on lets the same stroke through',
    allowed > afterPaint,
    `${Math.round(afterPaint).toLocaleString()} -> ${Math.round(allowed).toLocaleString()} sq ft`);

  /*
   * And back. The detection must survive the round trip -- that is the whole
   * reason this re-clips in place instead of asking for a fresh prediction.
   */
  await page.uncheck('#toggle-outside');
  await page.waitForTimeout(1200);
  const back = await page.evaluate(() => window.__lmSqft());
  check('turning it off trims back to the line again',
    Math.abs(back - afterPaint) < Math.max(50, afterPaint * 0.02),
    `${Math.round(allowed).toLocaleString()} -> ${Math.round(back).toLocaleString()} sq ft ` +
    `(was ${Math.round(afterPaint).toLocaleString()} before going outside)`);
  check('and the lawn is still there — trimming is not re-detecting',
    back > 0 && (await page.evaluate(() => window.__lmShapeCount())) > 0,
    `${Math.round(back).toLocaleString()} sq ft still measured`);

  await page.click('#mode-shape');
  await page.waitForTimeout(200);
}

/* --------------------------------------------------- phantom midpoints */
/*
 * Adding a corner used to mean tapping the line, scrolling the panel below the
 * map, and pressing a button -- three actions and a trip away from the thing
 * being edited. A hollow dot on the line does it in one tap.
 */
console.log('\n--- phantom midpoints ---');
await page.click('#mode-shape');
await page.waitForTimeout(300);
await page.click('#tool-points');
await page.waitForTimeout(500);

const mids = await page.evaluate(() => window.__lmMidpoints());
check('phantom midpoints are offered on the lines', mids.length > 0, `${mids.length} shown`);

if (mids.length) {
  const cornersBefore = await page.evaluate(() =>
    window.__lmRings().reduce((n, r) => n + r.length, 0));

  const m = mids[Math.floor(mids.length / 2)];
  await page.mouse.click(m.x, m.y);
  await page.waitForTimeout(600);

  const cornersAfter = await page.evaluate(() =>
    window.__lmRings().reduce((n, r) => n + r.length, 0));

  check('tapping one adds a corner, without opening the panel',
    cornersAfter === cornersBefore + 1,
    `${cornersBefore} -> ${cornersAfter} corners`);

  check('and the new corner is selected, ready to drag',
    (await page.evaluate(() => window.__lmEditable().mode)) === 'shape' &&
    (await page.locator('#point-controls').isVisible()));
}


/* ------------------------------------------------------- mode isolation */
/*
 * The reason modes exist: one thing at a time responds to a touch.
 *
 * Aimed with __lmPoints() rather than at a guessed coordinate. The first
 * version tapped a fixed spot near the left edge, which worked earlier in this
 * run and missed by the time the shape had been erased and repainted -- so it
 * reported "modes are broken" when it had simply stopped hitting anything.
 * __lmPoints() returns the corners of whatever the CURRENT mode owns, which is
 * both a reliable target and the fact under test: in property-line mode it can
 * only offer property-line corners.
 */
console.log('\n--- mode isolation ---');

/*
 * The sub-tools only exist inside lawn mode, so reaching one means opening
 * lawn mode first. Skipping that step made the check wait thirty seconds on a
 * hidden button -- which is the UI behaving correctly, since a person cannot
 * press it from Move mode either.
 */
const reachableIn = async (mode, tool) => {
  if (tool) {
    const inShape = await page.evaluate(() =>
      document.querySelector('#mode-shape').getAttribute('aria-pressed') === 'true');
    if (!inShape) {
      await page.click('#mode-shape');
      await page.waitForTimeout(350);
    }
    await page.click(`#tool-${tool}`);
  } else {
    await page.click(`#mode-${mode}`);
  }
  await page.waitForTimeout(450);
  return page.evaluate(() => window.__lmEditable());
};

const inParcel = await reachableIn('parcel');
console.log(`      property-line mode reaches: ${JSON.stringify(inParcel.ids)}`);
check('property-line mode reaches the property line and nothing else',
  inParcel.ids.length === 1 && inParcel.ids[0] === inParcel.parcelId,
  JSON.stringify(inParcel.ids));

const inLawn = await reachableIn('shape');
console.log(`      lawn mode reaches:          ${inLawn.ids.length} lawn outline(s)`);
check('lawn mode reaches the lawn outlines',
  inLawn.ids.length > 0 && !inLawn.ids.includes(inLawn.parcelId),
  JSON.stringify(inLawn.ids));

check('and never the property line, which is what stops the two being confused',
  !inLawn.ids.includes(inLawn.parcelId));

/*
 * Shapes are locked unless you asked to move one.
 *
 * The reported bug: a single tap with the eraser grabbed the lawn and slid it
 * across the map. That is Mapbox Draw's own simple_select dragging, which was
 * live in every mode. Asserted twice -- that Draw is in `static` (the
 * mechanism), and that a real drag across a shape leaves it where it was (the
 * consequence, which is what the person actually experienced).
 */
check('shapes are locked while a corner tool is live',
  inLawn.drawMode === 'lm_locked', `draw is in ${inLawn.drawMode}`);

const before = await page.evaluate(() => window.__lmCentroids());
await page.mouse.move(cx - 40, cy);
await page.mouse.down();
await page.mouse.move(cx + 40, cy + 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
const afterDrag = await page.evaluate(() => window.__lmCentroids());
const moved = before.some((c, i) =>
  !afterDrag[i] || Math.hypot(afterDrag[i][0] - c[0], afterDrag[i][1] - c[1]) > 1e-7);
check('and dragging across one does not slide it', moved === false,
  moved ? 'a shape moved when it should have been locked' : 'nothing moved');

const inMove = await reachableIn('move');
check('Move mode unlocks dragging, and only Move mode',
  inMove.drawMode === 'simple_select', `draw is in ${inMove.drawMode}`);

/* A brush is not a corner tool: nothing should be grabbable while painting. */
const inBrush = await reachableIn('shape', 'erase');
check('no corner is grabbable while a brush is live',
  inBrush.ids.length === 0, JSON.stringify(inBrush.ids));
check('and shapes stay locked under the brush too',
  inBrush.drawMode === 'lm_locked', `draw is in ${inBrush.drawMode}`);
await page.click('#tool-points');
await page.waitForTimeout(300);

const hasPinModel = await page.evaluate(() =>
  [...document.querySelectorAll('#model-choice option')].some((o) => o.value === 'sam2'));

if (hasPinModel) {
  await page.selectOption('#model-choice', 'sam2');
  await page.waitForTimeout(500);
  check('choosing the precise method drops you into placing pins',
    await page.evaluate(() =>
      document.querySelector('#mode-pins').getAttribute('aria-pressed') === 'true'));

  /*
   * A real click, not a synthesised one.
   *
   * Mapbox GL builds its own event objects from the listeners it installs, so
   * a hand-made MouseEvent dispatched at the canvas container never reaches
   * map.on('click') -- the first version of this check did that and concluded
   * pins could not be placed, when nothing had actually been clicked.
   */
  const mb = await page.locator('#map').boundingBox();
  await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.waitForTimeout(500);

  const placed = await page.evaluate(() => window.__lmPins().length);
  check('a pin can be placed there', placed > 0, `${placed} pin(s)`);
  check('and it is drawn while that is the mode',
    await page.evaluate(() => window.__lmPinsDrawn()) === true);

  await page.click('#mode-shape');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    drawn: window.__lmPinsDrawn(), kept: window.__lmPins().length,
  }));
  check('leaving the step takes the numbered pins off the map', after.drawn === false);
  check('without discarding them — they are still there to detect with',
    after.kept === placed, `${after.kept} of ${placed} kept`);
}

await page.screenshot({ path: 'browser-test.png', fullPage: false });

/*
 * A 403 from api.mapbox.com means the page was handed a URL-restricted token
 * and this host is not on its list -- the restriction working, but it leaves
 * the test driving a map with no imagery. Call it out rather than letting it
 * sit in a wall of console noise.
 */
/*
 * LAST ON PURPOSE. This section navigates, which resets the app to a blank
 * address bar -- run it any earlier and every check after it would be driving
 * a page that never got past step one, passing or failing for reasons that
 * have nothing to do with what they claim to test.
 */
/* -------------------------------------------------------- developer mode */
/*
 * A hidden panel for trying prompts and thresholds on a real lot.
 *
 * The property worth testing is the one that fails silently: that an ordinary
 * visitor never sees it. A stray `hidden` removed, or a key that matches too
 * easily, and every friend testing their lawn gets a box of knobs that produce
 * confidently wrong numbers -- and nothing else in the suite would notice,
 * because the app works perfectly with the panel showing.
 */
console.log('\n--- developer mode ---');
{
  const shut = await page.evaluate(() => window.__lmDev());
  check('the developer panel is not shown to an ordinary visitor',
    shut.on === false && shut.panelVisible === false,
    JSON.stringify(shut));
  check('and nothing is being sent with a detection',
    Object.keys(shut.overrides).length === 0, JSON.stringify(shut.overrides));
  check('and the Testing method is not among the ones offered',
    !shut.offered.includes('sam3_testing'), shut.offered.join(', '));

  /* Unlocking is by URL, which is the only thing typeable on a phone. */
  await page.goto(`${BASE}#tinker`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__lmDev !== undefined, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const open = await page.evaluate(() => window.__lmDev());
  check('the key unlocks it', open.on === true && open.panelVisible === true,
    JSON.stringify(open));

  /* The key is taken back out of the address bar, so a screenshot or a copied
   * link does not hand it to someone who was not looking for it. */
  check('and the key is removed from the address bar',
    !(await page.evaluate(() => location.hash)).includes('tinker'),
    await page.evaluate(() => location.href));

  /* It is remembered, so the key is needed once rather than every visit. */
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__lmDev !== undefined, { timeout: 30000 });
  await page.waitForTimeout(1500);
  check('and it is remembered on the next visit without the key',
    (await page.evaluate(() => window.__lmDev())).on === true);

  /*
   * The panel is reachable from the address step, which is the point of it
   * living outside the measure step: the key has to show something the moment
   * it is entered, not once an address has been confirmed.
   */
  check('and it is usable straight away, without confirming an address first',
    await page.locator('#dev-prompt').isVisible());

  /* A typed prompt reaches the request; an untouched panel sends nothing. */
  await page.fill('#dev-prompt', 'dormant bermuda');
  await page.waitForTimeout(200);
  const typed = await page.evaluate(() => window.__lmDev());
  check('a typed prompt is what would be sent', typed.overrides.prompt === 'dormant bermuda',
    JSON.stringify(typed.overrides));
  check('and it is not blocked', typed.blocked === null);

  /*
   * Past 32 tokens the encoder errors rather than answering, so this has to be
   * caught before a prediction and an allowance slot are spent on it.
   */
  await page.fill('#dev-prompt', Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => window.__lmDev());
  check('an over-long prompt is refused before it can be spent',
    typeof over.blocked === 'string' && /fewer words/i.test(over.blocked),
    String(over.blocked));

  await page.fill('#dev-prompt', '');
  await page.waitForTimeout(200);

  /* The slider only overrides once moved: blank means "let the model decide". */
  const idle = await page.evaluate(() => window.__lmDev());
  check('an untouched panel overrides nothing',
    Object.keys(idle.overrides).length === 0, JSON.stringify(idle.overrides));

  await page.evaluate(() => {
    const s = document.querySelector('#dev-threshold');
    s.value = '0';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  /*
   * Zero specifically. Written as `override || fallback` anywhere along this
   * path it would be dropped, and zero is the end of the slider someone
   * testing a stubborn lawn reaches for first.
   */
  const zero = await page.evaluate(() => window.__lmDev());
  check('and a threshold of zero survives, which truthiness would drop',
    zero.overrides.threshold === 0, JSON.stringify(zero.overrides));

  /*
   * THE TESTING METHOD. Its reason for existing is that overriding the prompt
   * on Subtract left Subtract's inversion and threshold in play, so a
   * surprising result had two possible causes and nothing on screen said
   * which. Testing starts from nothing.
   */
  const withDev = await page.evaluate(() => window.__lmDev());
  check('the Testing method is offered once unlocked',
    withDev.offered.includes('sam3_testing'), withDev.offered.join(', '));

  await page.evaluate(() => window.__lmSetModel('sam3_testing'));
  await page.waitForTimeout(250);

  /* It has no prompt of its own, so a blank box is "nothing to ask" rather
   * than "use the default" -- and must be refused before it costs anything. */
  await page.fill('#dev-prompt', '');
  await page.waitForTimeout(200);
  const blank = await page.evaluate(() => window.__lmDev());
  check('Testing refuses to run without a prompt',
    typeof blank.blocked === 'string' && /no prompt of its own/i.test(blank.blocked),
    String(blank.blocked));

  /* And it always sends a cut, even untouched: a server-side default would be
   * a setting in play that the panel does not show. */
  await page.fill('#dev-prompt', 'clover');
  await page.waitForTimeout(200);
  const testing = await page.evaluate(() => window.__lmDev());
  check('and sends an explicit cut even with the slider untouched',
    typeof testing.overrides.threshold === 'number',
    JSON.stringify(testing.overrides));
  check('with the typed prompt', testing.overrides.prompt === 'clover');

  /* The inversion checkbox is the control the shipped methods do not expose. */
  check('Testing does not invert until asked', testing.inverts === false);
  await page.check('#dev-invert');
  await page.waitForTimeout(200);
  check('and ticking the box inverts it',
    (await page.evaluate(() => window.__lmDev())).inverts === true);

  /*
   * On a shipped method the box must NOT decide -- Subtract owns its own
   * inversion, and a live control that silently does nothing is a lie.
   */
  await page.evaluate(() => window.__lmSetModel('sam3_subtract'));
  await page.waitForTimeout(250);
  const sub = await page.evaluate(() => window.__lmDev());
  check('Subtract keeps its own inversion regardless of the box',
    sub.inverts === true, `inverts=${sub.inverts}`);
  check('and the box is disabled there, rather than pretending to work',
    await page.locator('#dev-invert').isDisabled());

  await page.evaluate(() => window.__lmSetModel('sam3'));
  await page.waitForTimeout(250);
  check('Quick does not invert either', 
    (await page.evaluate(() => window.__lmDev())).inverts === false);
  await page.fill('#dev-prompt', '');
  await page.waitForTimeout(200);

  /* Leaving must actually forget it, or "off" is a lie until storage clears. */
  await page.click('#dev-exit');
  await page.waitForTimeout(300);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__lmDev !== undefined, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const left = await page.evaluate(() => window.__lmDev());
  check('leaving developer mode is remembered too',
    left.on === false && left.panelVisible === false, JSON.stringify(left));
}

if (errors.some((e) => e.includes('403'))) {
  check('the map got its tiles (no 403 from Mapbox)', false,
    'the page is using a URL-restricted token on a host it does not allow — ' +
    'give wrangler dev the unrestricted one');
}

/*
 * An uncaught exception is a failure, not a footnote.
 *
 * These were collected and printed and never asserted on, so the run that
 * introduced "There is already a source with ID imagery-alt" reported All
 * checks passed with the exception sitting in the output directly above it.
 * A thrown error means some code did not run, and what did not run is by
 * definition not covered by the checks that passed.
 *
 * Console errors stay advisory: third-party libraries log them for things
 * that are not ours and not fatal. A PAGEERROR is ours.
 */
const thrown = errors.filter((e) => e.startsWith('PAGEERROR'));
check('the page threw no uncaught errors', thrown.length === 0,
  thrown.join('\n      '));

console.log(`\nconsole/page errors:${errors.length ? '\n  ' + errors.slice(0, 12).join('\n  ') : ' (none)'}`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
