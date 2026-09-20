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

/**
 * Open the tab a control lives on before reaching for it.
 *
 * The panel is three steps in three tabs now, so a control that is not on the
 * open tab is not on the page. Written as a helper rather than a click per
 * site because the mapping of control to tab is exactly the thing under test:
 * if something moves tab, this file should need one line changed, not thirty.
 */
async function goTab(page, name) {
  await page.click(`#tab-${name}`);
  await page.waitForTimeout(150);
}

/**
 * Take the lock off the detection tab, the way a person would.
 *
 * Hand corrections lock the AI controls, which is the point of them -- so a
 * later section that wants to touch the model picker has to clear the lawn
 * first, exactly as a user would. Pressing the notice's own button rather than
 * reaching past it keeps this honest: if the button stops working, this fails.
 */
/**
 * Reach a brush, whatever the rail is currently showing.
 *
 * THREE PRESSES, NOT TWO, since the rail redesign. Shape mode opens on Points
 * -- corner editing -- and while that is live the rail folds Add and Erase
 * away behind one Brushes icon, because the rail is drawn over the map and the
 * tools for the job you are not doing are covering the lawn being worked on.
 *
 * This file was written before that and kept clicking straight at a hidden
 * button, which is what stopped the whole run at #tool-add from 11 September
 * onwards -- every check below that point went unrun for weeks, including the
 * two gesture ones this run was supposed to be about.
 */
async function armBrush(page, which) {
  /*
   * WAITED ON, NOT SLEPT THROUGH. The first version used fixed 200ms pauses
   * and lost the race about one run in two: the rail had not re-rendered, the
   * brush was never armed, and the stroke that followed painted nothing --
   * reported as "0 -> 0 shape(s), 0 sq ft", which reads like a broken brush
   * rather than a test that clicked too early.
   */
  if (await page.locator('#tool-brushes').isVisible()) {
    await page.click('#tool-brushes');
    await page.locator(`#tool-${which}`).waitFor({ state: 'visible', timeout: 5000 });
  }
  await page.click(`#tool-${which}`);

  /* And confirm it actually took. The tool buttons TOGGLE -- pressing the one
     already live drops back to Points -- so "clicked" and "armed" are two
     different claims and only the second one matters to what follows. */
  await page.waitForFunction(
    (tool) => document.querySelector(`#tool-${tool}`)?.getAttribute('aria-pressed') === 'true',
    which,
    { timeout: 5000 }
  );
}

async function unlockDetect(page) {
  await goTab(page, 'detect');
  if (await page.locator('#lock-notice').isVisible()) {
    await page.click('#btn-lock-clear');
    await page.waitForTimeout(300);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({
  // Deliberately a phone: this is how it is being used, and touch changes how
  // Mapbox GL interprets a tap.
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

/*
 * The AI notice, marked as already seen before the app starts.
 *
 * It is a `position: fixed; inset: 0` sheet, so while it is open every panel
 * button behind it resolves but cannot be clicked -- and Playwright reports
 * that as "waiting for element to be visible, enabled and stable", which reads
 * like a broken control rather than something on top of it.
 *
 * Suppressed rather than dismissed, because dismissing it would only work if
 * this script happens to reach the AI tab before any other click, and a check
 * added later in the wrong place would quietly re-introduce the problem. The
 * notice itself is covered in markup.test.js, where its words can be asserted
 * without needing a browser at all.
 */
await page.addInitScript(() => {
  try { sessionStorage.setItem('lawnmap.ai-notice.v1', '1'); } catch { /* fine */ }
});

/*
 * FAIL FAST, AND SAY WHAT YOU HAD.
 *
 * Playwright's default is to retry an action for thirty seconds before giving
 * up, then throw -- and a throw at the top level of a module is an unhandled
 * rejection that ends the process. So one control that never appears produced
 * half a minute of silent retrying, a stack trace, and NOTHING: no summary, no
 * count, and none of the two hundred checks that had already run.
 *
 * That is the worst possible failure mode for a suite whose whole job is to be
 * read on a phone from a workflow log. Ten seconds is far longer than anything
 * here legitimately takes, and the handler below turns the death into a report.
 */
page.setDefaultTimeout(10000);

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text().slice(0, 200)}`);
});

/**
 * Print what we learned before dying, rather than instead of it.
 *
 * AND NAME THE CONTROL. The first version printed only the first line of the
 * error -- "page.click: Timeout 10000ms exceeded." -- which says a press failed
 * and not which one. Playwright puts that in the call log underneath, in a
 * "waiting for locator('#x')" line, so throwing away everything after the first
 * newline discarded the single most useful fact in the message. Two runs were
 * reported with nothing but the timeout, and the answer was sitting in the part
 * that got cut.
 */
async function bailOut(err) {
  const text = String(err?.message || err);
  const waitingFor = text.match(/waiting for (.+)/);
  console.log(`\nSTOPPED  the run could not continue:\n      ${text.split('\n')[0]}`);
  if (waitingFor) console.log(`      it was waiting for ${waitingFor[1].trim()}`);
  console.log(`      ${text.split('\n').slice(1, 6).map((l) => l.trim()).filter(Boolean).join('\n      ')}`);
  console.log('      Every check above this line still ran; everything below it did not.');
  if (errors.length) console.log(`\nconsole/page errors:\n  ${errors.slice(0, 12).join('\n  ')}`);
  console.log(`\n${failures} check(s) FAILED before the run stopped.\n`);
  try { await page.screenshot({ path: 'browser-test.png', fullPage: false }); } catch { /* gone */ }
  try { await browser.close(); } catch { /* already down */ }
  process.exit(1);
}

process.on('unhandledRejection', bailOut);
process.on('uncaughtException', bailOut);

/**
 * Dismiss a coaching tip if one is up.
 *
 * Guarded rather than clicked blind: whether a tip appears depends on what the
 * county returned and on which tab you landed on, so "press OK" is a
 * conditional even when it usually happens. Clicking a hidden button is what
 * turned a missing tip into a dead run.
 */
async function dismissTip(page) {
  if (await page.locator('#coach').isVisible()) {
    await page.click('#coach-ok');
    await page.waitForTimeout(250);
  }
}

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

/* ------------------------------------------- zooming by tapping, and not */
/*
 * THE THIRD HANDLER, asserted against the real library because that is the
 * only place it exists.
 *
 * Mapbox GL v3 has three zoom-by-tapping handlers and `map.doubleClickZoom`
 * wraps only two of them. tapDragZoom -- tap, then touch and drag -- is added
 * separately, owned by touchZoomRotate, and survived both the constructor
 * flag and `.disable()`. The gesture was reported three times and "fixed"
 * twice against switches that were never connected to it.
 *
 * It cannot be caught by reading the app: every switch it sets is real and
 * does what it says. Only the running map knows which handlers are live.
 */
{
  const gz = await page.evaluate(() => {
    const h = window.__lmGestures ? window.__lmGestures() : {};
    return {
      doubleClickZoom: h.doubleClickZoom,
      tapDragZoom: h.tapDragZoom,
      pinch: h.touchZoom,
      wrapper: h.touchZoomRotateWrapper,
    };
  });
  check('double-tap zoom is off', gz.doubleClickZoom === false, String(gz.doubleClickZoom));
  check('and so is tap-then-drag zoom, which is a different handler',
    gz.tapDragZoom === false,
    'doubleClickZoom does not cover it; it read "off" for weeks while being on');
  /* The blunt fix for the above -- touchZoomRotate.disable() -- would take
     pinch with it, so the narrow one has to leave pinch alone. */
  /*
   * READ FROM THE PINCH HANDLER, NOT FROM THE WRAPPER, and that distinction is
   * the whole check rather than a detail of it.
   *
   * map.touchZoomRotate wraps THREE handlers and its isEnabled is an AND over
   * all of them, tapDragZoom included -- which we deliberately disable. So the
   * wrapper reads false for ever afterwards while pinch is perfectly alive,
   * and reading it here reported a working map as broken. That is the same
   * mistake the tapDragZoom fix was written to correct, one field over.
   */
  check('and pinch-to-zoom still works', gz.pinch === true,
    `pinch handler ${gz.pinch}, wrapper ${gz.wrapper} -- the wrapper ANDs in `
    + 'tapDragZoom, which is off on purpose, so it is not the pinch answer');
}

/*
 * A TAP REACHES THE APP WITH NO TOOL ARMED.
 *
 * `map.on('click')` used to be registered by armLawnPicker and removed by
 * disarmLawnPicker, so taps only worked while a DRAWING tool was armed. The
 * confirm step arms nothing, so the branch that moves the property pin could
 * not run however correct it was -- and the pin moved only by dragging.
 *
 * Asserted by tapping the middle of the map and watching the pin follow,
 * because a listener that is present and a listener that is reached are
 * different claims and only the second one matters.
 */
{
  const box = await page.locator('#map').boundingBox();
  const armed = await page.evaluate(() => window.__lmPlacingPin?.());
  check('the confirm step expects taps', armed === true, `placingPin=${armed}`);
  const before = await page.evaluate(() => window.__lmChosen?.());
  const dial = () => page.evaluate(() => ({ ...window.__lm }));
  const was = await dial();

  /* Off-centre, so the pin has somewhere to move to. */
  await page.touchscreen.tap(box.x + box.width * 0.35, box.y + box.height * 0.4);
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.__lmChosen?.());
  const now = await dial();

  /*
   * THE COUNTERS, IN THE FAILURE MESSAGE. "The pin did not move" has three
   * causes that look identical from outside -- the tap never reached the
   * handler at all, it reached it and was rejected mid-draw, or it ran and
   * movePin did nothing -- and the app already counts all three. Printing
   * only the coordinates threw that away and left the next person to
   * re-derive it, which is exactly what happened here.
   */
  check('tapping the map moves the property pin',
    Boolean(before && after) && (before.lng !== after.lng || before.lat !== after.lat),
    `${before?.lng},${before?.lat} -> ${after?.lng},${after?.lat}`
    + ` · reached handler ${now.clicks - was.clicks}x`
    + ` (touch ${now.viaTouch - was.viaTouch}, click ${now.viaClick - was.viaClick})`
    + `, rejected ${now.rejected - was.rejected}x, draw mode ${now.lastMode}`);
}

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

/*
 * A TIP MUST POINT AT SOMETHING THAT IS ON SCREEN.
 *
 * Moving the tools onto tabs broke this silently: the property-line tip points
 * at the map's "Line" button, which only appears on the Address step, and the
 * app used to skip straight to the AI step when the county had a boundary on
 * file. showTip declines to point at a hidden control -- correctly -- so the
 * first tip in the app simply stopped appearing, with nothing failing and
 * nothing to see. You land on step one now, and a tip whose control is a tab
 * away waits for that tab rather than pointing somewhere else.
 */
check('and it points at something that is actually on screen',
  parcelTip.targetVisible || parcelTip.targetId === null,
  `target #${parcelTip.targetId}, visible=${parcelTip.targetVisible}`);

if (parcelTip.targetId) {
  const aim = pointsAt(parcelTip);
  check(`and its arrow points at #${parcelTip.targetId}`, aim.ok, aim.why);
}

/*
 * AND IT MUST NOT SIT ON TOP OF THE TABS.
 *
 * The first attempt at the fix above pointed the tip at the TAB instead of the
 * tool, which meant letting the box out of the map -- and it landed across the
 * tab strip. Every tab became unclickable, which is a great deal worse than a
 * missing tip, and the suite hung on the next tab it tried to press rather
 * than reporting anything. Geometry, because "is it clickable" is the actual
 * question and no state flag answers it.
 */
{
  const clash = await page.evaluate(() => {
    const box = document.querySelector('#coach').getBoundingClientRect();
    return [...document.querySelectorAll('#tabs .tab')]
      .filter((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && box.left < r.right && box.right > r.left
          && box.top < r.bottom && box.bottom > r.top;
      })
      .map((t) => t.id);
  });
  check('and it does not cover the step tabs', clash.length === 0,
    clash.length ? `covering ${clash.join(', ')}` : 'the tabs stay pressable');
}

/*
 * Dismissed with its own OK button, deliberately, not by opening a tab.
 * Pressing OK is what chains on to the next tip; switching tabs is a person
 * moving on, and it takes the chain with it. The section below needs the
 * chain.
 */
await dismissTip(page);

/*
 * The imagery tip follows the property line, so it only follows the FIRST tip
 * when the county supplied one. For an address with no record the boundary has
 * to be traced first, and the tip fires from there instead -- so this is
 * conditional on what the parcel lookup actually returned, not on the test
 * address being a covered one.
 */
/*
 * Asked of the app's state rather than of a button, because reaching for the
 * button means opening the tab it lives on -- and opening a tab dismisses the
 * tip this section is about to look for. The question is whether the county
 * returned a boundary, and that is the thing to ask.
 */
const hasParcel = (await page.evaluate(() => window.__lmTabs())).hasParcel;

/*
 * SAY IT ONCE, HERE, IF THIS ADDRESS HAS NO BOUNDARY ON FILE.
 *
 * Several sections below seed a lawn with "Use property line", which does not
 * exist without one -- so an uncovered address does not fail those checks, it
 * stops the run on a button that is not there, ten seconds later and with
 * nothing saying why. The address is an input to this workflow, so that is a
 * thing somebody will do. One line here turns a mystery into an expected
 * outcome.
 */
if (!hasParcel) {
  console.log('      NOTE: no county boundary for this address. Sections that');
  console.log('            seed a lawn from the property line cannot run, and');
  console.log('            the run will stop when it reaches one. Try the');
  console.log('            default address to exercise the whole suite.');
}

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

  await dismissTip(page);
}

check('no tip is left sitting over the map',
  (await page.evaluate(() => window.__lmTip().visible)) === false);

/* --------------------------------------------------------------- accounts */
/*
 * SIGNING IN IS OPTIONAL AND MUST STAY OPTIONAL.
 *
 * Everything above this line -- finding an address, pulling a boundary, being
 * offered a detection -- happened with nobody signed in, which is the property
 * worth asserting: accounts are an addition to the app, not a gate in front of
 * it. A deployment with no account store shows no button at all, because one
 * that cannot work is worse than one less button.
 */
console.log('\n--- accounts are optional ---');
{
  const account = await page.evaluate(() => ({
    on: window.__lmAccount().accountsOn,
    user: window.__lmAccount().user,
    buttonVisible: document.querySelector('#account-btn')?.hidden === false,
  }));
  check('the app works with nobody signed in', account.user === null,
    `accounts ${account.on ? 'on' : 'off'} for this deployment`);
  check('and the sign-in button appears only where it can work',
    account.buttonVisible === account.on,
    `button ${account.buttonVisible ? 'shown' : 'hidden'}, accounts ${account.on}`);
  check('with no sheet in the way of the map',
    (await page.locator('#signin').isHidden())
    && (await page.locator('#account-sheet').isHidden()));

  if (account.on) {
    await page.click('#account-btn');
    await page.waitForTimeout(250);
    check('pressing it offers a way in', await page.locator('#signin').isVisible());

    /*
     * ONE DOOR, so there is nothing to choose between: an address and a
     * button. And no password field anywhere, which is the point -- there is
     * nothing to forget, reuse, leak or reset, and receiving the link IS the
     * verification that makes the address safe to use as the account.
     */
    check('with one way in and no password to invent',
      (await page.locator('#signin input[type=password]').count()) === 0
      && (await page.locator('#signin-email').count()) === 1);

    await page.click('#signin-close');
    await page.waitForTimeout(200);
    check('and closing it puts the map back',
      await page.locator('#signin').isHidden());
  }
}

/* ------------------------------------------------------------------ tabs */
/*
 * THE THREE STEPS, AS THREE TABS.
 *
 * The whole panel used to be one column with everything live at once, and the
 * moment that mattered most -- handing over from the machine's answer to your
 * own corrections -- was invisible.
 *
 * RUN AFTER THE TIPS, not before. Opening a tab dismisses whatever tip is on
 * screen, which is right -- you have moved on -- but it meant these checks
 * silently swallowed the first tip in the app before the tip checks could look
 * for it. A suite that destroys the thing the next section tests is worse than
 * no suite for that thing.
 */
console.log('\n--- the step tabs ---');
const tabs = await page.evaluate(() => window.__lmTabs());
check('the panel is split into steps', tabs.tabs.length >= 3, tabs.tabs.join(', '));

/*
 * YOU LAND ON STEP ONE, whether or not the county had a line on file.
 *
 * Skipping ahead to the AI when a boundary already exists looks helpful and is
 * not: the boundary is what every later number is measured against, and the
 * first tip exists to say "check it before you detect" -- advice that cannot be
 * given from a tab where the tool it names is not on screen.
 */
check('you land on step one, with the boundary in front of you',
  tabs.on === 'address', `on "${tabs.on}" with parcel=${tabs.hasParcel}`);
check('and only that step\'s tools are on screen',
  tabs.visiblePanes.length === 1 && tabs.visiblePanes[0] === tabs.on,
  tabs.visiblePanes.join(', '));

/*
 * The map's buttons are the other half of the panel, so they follow the tab.
 * Pressing "Line" while meaning to paint is not a mistake worth being able to
 * make; on the drawing tab it is not there to press.
 */
check('the map shows this step\'s tools and not another\'s',
  tabs.rail.includes('parcel') && !tabs.rail.includes('shape'),
  `rail: ${tabs.rail.join(', ') || '(empty)'} on "${tabs.on}"`);

await goTab(page, 'draw');
const drawRail = await page.evaluate(() => window.__lmTabs());
check('the drawing tab offers the shape tools and not the boundary',
  drawRail.rail.includes('shape') && !drawRail.rail.includes('parcel'),
  drawRail.rail.join(', ') || '(empty)');

/*
 * DRAWING BY HAND MUST NOT NEED THE AI AT ALL. Somebody who never presses
 * Detect has to be able to trace their lawn, and this is the step they would
 * do it from -- so the tools are live here with no detection in the session.
 */
check('and drawing by hand is available without ever detecting',
  await page.locator('#btn-draw').isEnabled());
check('with nothing locked before any work has been done',
  drawRail.locked.length === 0, drawRail.locked.join(', '));

/*
 * And it really works: a shape traced here, with no detection in the session,
 * produces a measurement. The AI is one way to fill this step, not the way in.
 */
{
  const painted = await page.evaluate(() => window.__lmShapeCount());
  await page.click('#mode-shape');
  await page.waitForTimeout(250);
  await armBrush(page, 'add');
  await page.waitForTimeout(250);
  const mb = await page.locator('#map').boundingBox();
  const x = mb.x + mb.width / 2;
  const y = mb.y + mb.height / 2;
  await page.mouse.move(x - 30, y - 20);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - 30 + i * 7, y - 20 + i * 5);
  await page.mouse.up();
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => ({
    shapes: window.__lmShapeCount(), sqft: window.__lmSqft(),
  }));
  check('painting a lawn with no detection at all measures something',
    after.shapes > painted && after.sqft > 0,
    `${painted} -> ${after.shapes} shape(s), ${after.sqft.toLocaleString()} sq ft`);

  /*
   * CORNER HANDLES, on the shape that was just painted.
   *
   * The geometry is unit tested and the placement rules with it; what cannot be
   * tested offline is whether a tap on a stalk actually reaches the corner it
   * points at. That is three separate pieces agreeing -- the planner, the
   * projection, and the hit test that has to prefer a handle over everything
   * else -- and any one of them being wrong looks identical from here: nothing
   * moves.
   */
  await page.click('#tool-points');
  await page.waitForTimeout(400);

  /*
   * OFF UNTIL ASKED FOR. A detected outline can carry a corner every few
   * pixels, so a stalk on each is unreadable -- the default is a clean map and
   * the toggle is for the fiddly lot where reaching a corner is the problem.
   */
  check('corner handles are off until switched on',
    (await page.evaluate(() => window.__lmHandles())).length === 0,
    'a hundred stalks on a traced outline is not a legible map');

  await page.click('#tool-handles');
  await page.waitForTimeout(400);

  const handles = await page.evaluate(() => window.__lmHandles());
  const crowded = await page.evaluate(() => window.__lmHandlesCrowded());
  check('corners get drag handles once the points tool is open',
    handles.length > 0 || crowded,
    crowded ? 'declined: too many corners on screen' : `${handles.length} handles`);

  if (handles.length) {
    check('and each sits out at arm\'s length from its corner',
      handles.every((h) => h.reach > 20),
      `reaches: ${[...new Set(handles.map((h) => Math.round(h.reach)))].join(', ')} px`);

    /*
     * No two within a thumb of each other -- the property the whole placement
     * search exists to guarantee, checked here against real projected geometry
     * rather than the made-up coordinates the unit tests use.
     */
    let closest = Infinity;
    for (let i = 0; i < handles.length; i++) {
      for (let j = i + 1; j < handles.length; j++) {
        closest = Math.min(closest, Math.hypot(handles[i].x - handles[j].x, handles[i].y - handles[j].y));
      }
    }
    check('and no two handles land on top of each other',
      handles.length < 2 || closest >= 15, `closest pair ${Math.round(closest)} px apart`);

    /* Drag one, and the lawn should change shape. */
    const before = await page.evaluate(() => window.__lmSqft());
    const target = handles[0];
    const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + target.x, box.y + target.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(box.x + target.x + i * 5, box.y + target.y + i * 4);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);

    const moved = await page.evaluate(() => window.__lmSqft());
    check('and dragging a handle moves the corner it points at',
      moved > 0 && Math.abs(moved - before) > 1,
      `${Math.round(before)} -> ${Math.round(moved)} sq ft`);
  }

  /*
   * THE POINT ERASER removes the corner that was tapped, without selecting it
   * first. Checked by counting corners rather than by looking at the map: a
   * delete that silently did nothing and a delete that worked look identical
   * in a screenshot.
   */
  {
    const before = await page.evaluate(() => window.__lmCornerCount());
    await page.click('#tool-unpoint');
    await page.waitForTimeout(250);

    const target = (await page.evaluate(() => window.__lmCorners()))[0];
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + target.x, box.y + target.y);
    await page.waitForTimeout(450);

    const after = await page.evaluate(() => window.__lmCornerCount());
    check('the point eraser removes the corner that was tapped',
      after === before - 1, `${before} corners -> ${after}`);

    /*
     * AND AGAIN, WHICH IS THE WHOLE BUG.
     *
     * The first delete always worked. Deleting a corner clears the selection,
     * and the tap test used to run over the SELECTED shape's corners only --
     * so every tap after the first was measured against an empty list and
     * answered "nothing there to remove" with the dots still on screen. One
     * delete is not a test of a tool whose entire purpose is removing a run of
     * strays, so this taps a second one.
     */
    const next = (await page.evaluate(() => window.__lmCorners()))[0];
    await page.mouse.click(box.x + next.x, box.y + next.y);
    await page.waitForTimeout(450);

    const twice = await page.evaluate(() => window.__lmCornerCount());
    check('and keeps removing them, tap after tap',
      twice === after - 1,
      `${after} corners -> ${twice}` +
      (twice === after ? ' — the second tap did nothing' : ''));

    /* And it is a mode, so it stays armed for the next one. */
    const armed = await page.evaluate(() => document.querySelector('#tool-unpoint').getAttribute('aria-pressed'));
    check('and stays armed, because removing strays is never one tap',
      armed === 'true', `aria-pressed=${armed}`);

    await page.click('#tool-unpoint');   // put the destructive tool away
    await page.waitForTimeout(200);
  }

  /*
   * Painting by hand is a hand correction, so it locks the AI step -- which is
   * correct, and would break every check below that expects a live Detect
   * button. Clearing through the notice is how a person gets back, and it is
   * also this section proving that the way back works.
   */
  await page.click('#mode-shape');          // close lawn mode
  await page.waitForTimeout(200);
  const locked = await page.evaluate(() => window.__lmTabs());
  check('and painting by hand locks the AI step, as correcting a detection does',
    locked.locked.includes('detect'), locked.locked.join(', ') || 'nothing locked');

  await unlockDetect(page);
  const freed = await page.evaluate(() => ({
    ...window.__lmTabs(), shapes: window.__lmShapeCount(),
  }));
  check('and clearing gives it back', freed.locked.length === 0 && freed.shapes === 0,
    `locked: ${freed.locked.join(', ') || 'nothing'}, ${freed.shapes} shape(s)`);
}

await goTab(page, 'detect');
const aiRail = await page.evaluate(() => window.__lmTabs());
check('and the AI tab offers neither the boundary nor the shape tools',
  !aiRail.rail.includes('parcel') && !aiRail.rail.includes('shape'),
  aiRail.rail.join(', ') || '(empty)');

/* ---------------------------------------------- detection is one press now */
/*
 * There are no pins any more. Asking the model for "grass" finds every patch
 * in the frame at once -- including the ones a person would forget -- and the
 * result is clipped to the property line. So the only thing to check here is
 * that the button is live as soon as we have a frame.
 */
console.log('\n--- detection readiness ---');
/* The tabs section above finishes on the AI step, which is where these live. */
check('Detect my lawn is enabled without any tapping',
  await page.locator('#btn-detect').isEnabled());
console.log(`      button: "${await page.locator('#btn-detect').textContent()}"`);
console.log(`      hint:   "${await page.locator('#map-hint').textContent()}"`);
check('the grass-under-trees option is offered and on by default',
  await page.locator('#toggle-trees').isChecked());

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
   * Exclude mode: start from the property line and take away what is ticked.
   * On offer after being withheld while its prompt was a comma list that
   * reported whole parcels as lawn.
   */
  const exclude = models.options.find((m) => m.id === 'sam3_exclude');
  check('exclude mode is offered', !!exclude, ids.join(', '));

  /*
   * The flags the mode turns on, and the one thing here that cannot be checked
   * by looking at the map: a mask combined the wrong way round draws a
   * completely plausible lawn over the house.
   */
  check('and it arrives marked as subtractive, not inverting',
    exclude?.subtractive === true && exclude?.invert === false,
    JSON.stringify(exclude));
  check('while the default one is neither',
    models.options.find((m) => m.id === models.chosen)?.subtractive === false
    && models.options.find((m) => m.id === models.chosen)?.invert === false,
    `chosen: ${models.chosen}`);

  /* The boxes belong to exclude mode, so they must not be sitting there under
   * "Find grass" doing nothing. */
  check('the tick boxes are hidden until exclude mode is chosen',
    models.excludes.visible === false, JSON.stringify(models.excludes));

  if (exclude) {
    await page.selectOption('#model-choice', 'sam3_exclude');
    await page.waitForFunction(() => window.__lmModels().excludes.visible === true,
      null, { timeout: 4000 }).catch(() => {});

    const note = await page.textContent('#model-note');
    check('picking it updates the description', note.trim() === exclude.note,
      `showing: ${note.trim().slice(0, 70)}`);
    check('and the app records the switch',
      (await page.evaluate(() => window.__lmModels().chosen)) === 'sam3_exclude');

    const boxes = (await page.evaluate(() => window.__lmModels())).excludes;
    check('the tick boxes appear with it', boxes.visible === true,
      JSON.stringify(boxes));
    check('there is more than one thing to remove', boxes.rendered.length >= 2,
      boxes.rendered.map((b) => b.id).join(', '));

    /*
     * ONE TICKED BY DEFAULT, and it is the concept that has been tried on a
     * real property. Zero would leave the button dead on arrival; all of them
     * would quietly spend four predictions on the first press.
     */
    check('exactly one starts ticked', boxes.ticked.length === 1,
      boxes.ticked.join(', '));
    check('and the rendered boxes agree with what will be sent',
      boxes.rendered.filter((b) => b.checked).map((b) => b.id).join(',')
        === boxes.ticked.slice().sort().join(','),
      `${JSON.stringify(boxes.rendered)} vs ${boxes.ticked}`);

    /*
     * THE COST HAS TO BE ON SCREEN BEFORE IT IS SPENT.
     *
     * Every tick is another prediction, another wait and another item of the
     * daily allowance. A checkbox that silently quadruples the bill of a press
     * is the one thing this panel must not be.
     */
    check('the cost of the ticked boxes is stated', /1 AI pass/.test(boxes.cost),
      boxes.cost);

    const second = boxes.rendered.find((b) => !b.checked);
    if (second) {
      await page.click(`#excl-${second.id}`);
      await page.waitForFunction(() => window.__lmModels().excludes.ticked.length === 2,
        null, { timeout: 4000 }).catch(() => {});
      const after = (await page.evaluate(() => window.__lmModels())).excludes;
      check('ticking a second box is recorded', after.ticked.length === 2,
        after.ticked.join(', '));
      check('and the stated cost goes up with it', /2 AI passes/.test(after.cost),
        after.cost);
      await page.click(`#excl-${second.id}`); // back to the default set
    }

    /*
     * AND THE GAP OPTION FLIPS WITH THE ARITHMETIC.
     *
     * "Count grass under trees" fills small holes in the lawn back in. Finding
     * grass, a hole is canopy over real grass, so it is on. Excluding objects,
     * a hole is something a ticked box removed, so filling it undoes the tick
     * -- off by default, still offered, because the trees prompt runs wide.
     * Still visible either way: withdrawing it would hide the override.
     */
    check('the gap option is still offered in exclude mode',
      await page.locator('#trees-opt').isVisible());
    check('but unticked, because a gap here is something a box removed',
      (await page.locator('#toggle-trees').isChecked()) === false);
    const exclNote = await page.textContent('#trees-note');
    check('and it says what it does HERE, not what it does in the other mode',
      /removed|asked for/.test(exclNote), exclNote.trim().slice(0, 80));

    // Back to the default method: nothing after this should be subtracting.
    await page.selectOption('#model-choice', models.chosen);
    await page.waitForTimeout(200);
    check('and the boxes go away again with it',
      (await page.evaluate(() => window.__lmModels().excludes.visible)) === false);
    check('and the gap option comes back ticked for Find grass',
      await page.locator('#toggle-trees').isChecked());
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
  /*
   * Compared against the methods the app is OFFERING, not against everything
   * in its catalogue. __lmModels lists all of them, developer-only included --
   * which is what it is for -- so comparing the dropdown to that list asserts
   * the opposite of the filter: it demands the hidden method be on screen.
   */
  const shouldBeListed = models.options.filter((m) => !m.devOnly).map((m) => m.id);
  check('and the dropdown lists exactly the methods on offer',
    optionIds.join(',') === shouldBeListed.join(','),
    `dropdown: ${optionIds.join(',')} vs offered: ${shouldBeListed.join(',')}`);

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

  /*
   * Pins are work, so undo has to reach them -- and this is the map's copy of
   * undo, not the panel's, because that is the only one available from here.
   * The panel's lives with the drawing tools, one tab away; the rail's is on
   * the map on every tab, which is the whole reason it exists.
   */
  await page.click('#rail-undo');
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

  /*
   * THE THIRD AND LAST TIP: the AI has answered, now correct it.
   *
   * It waits for the Draw step rather than firing over the AI step, because
   * the tools it explains are there. A tip about brushes is worth reading when
   * you arrive at the brushes -- and pointing at a button that is one tab away
   * is the thing that silently broke the first tip in the app.
   */
  check('the editing tip does not fire over the step it is not about',
    (await page.evaluate(() => window.__lmTip())).visible === false,
    'it is waiting for the drawing tools');

  await goTab(page, 'draw');
  await page.waitForTimeout(400);

  /*
   * THE FEEDBACK QUESTION, WHICH ONLY EXISTS ON A RUN THAT REALLY DETECTED.
   *
   * Asked at the handover, once, and it goes in front of the editing tip --
   * both want this exact moment, and a coaching box underneath a modal
   * question is a box nobody can read and a question that looks broken.
   */
  const fb = await page.evaluate(() => window.__lmFeedback());
  check('a real detection is followed by the feedback question', fb.open === true,
    `open=${fb.open} detected=${fb.detected}`);

  if (fb.open) {
    /*
     * What is being sent is on the dialog in ordinary type, above the buttons.
     * Answering uploads the map and the address; a disclosure nobody can read
     * before pressing is not a disclosure.
     */
    const why = await page.textContent('#feedback-why');
    check('and it says what answering sends, before the buttons',
      /address/i.test(why) && /map/i.test(why), why.trim().slice(0, 90));
    check('with three answers about how much correcting it took',
      (await page.locator('#feedback .fb-opt').count()) === 3);
    check('and a way out that sends nothing, and says so',
      /send nothing/i.test(await page.textContent('#feedback-skip')));

    await page.click('#feedback-skip');
    await page.waitForTimeout(300);
    check('skipping closes it', (await page.evaluate(() => window.__lmFeedback().open)) === false);
  }

  const toolTip = await page.evaluate(() => window.__lmTip());
  check('and the editing tip arrives once the question is out of the way',
    toolTip.visible && toolTip.stage === 'tools',
    `stage=${toolTip.stage} visible=${toolTip.visible}`);
  if (toolTip.visible) {
    const aim = pointsAt(toolTip);
    check('pointing at the shape tools', aim.ok, `${toolTip.targetId}: ${aim.why}`);
    await dismissTip(page);
  }
}

/* Nothing may be left covering the map before the tap-based checks below. */
check('the map is clear of tips before the editing checks',
  (await page.evaluate(() => window.__lmTip().visible)) === false);

/* --------------------------------------------- the edge extension tool */
console.log('\n--- edge extension ---');
// "Use property line" makes a lawn the size of the lot, so it sits with the
// drawing tools rather than with the boundary it is copied from.
await goTab(page, 'draw');
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

/*
 * TWO SHAPES ON THE SAME GROUND ARE ONE LAWN.
 *
 * "Use property line" defends itself by replacing rather than adding, but
 * nothing else did: geodesic area SUMS a FeatureCollection, so a shape lying on
 * another was counted twice and the panel reported a bigger lawn. The add
 * brush, drawing by hand, and re-detecting over corrections can all get there,
 * and it is invisible on the map because the copy sits exactly on the original.
 *
 * Stacked deliberately here, because no gesture produces it reliably -- which
 * is exactly why it went unnoticed.
 */
{
  const before = await page.evaluate(() => window.__lmSqft());
  const count = await page.evaluate(() => window.__lmDuplicateShape());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__lmSqft());

  check('duplicating a shape really does put two on the map',
    count === 2, `${count} shape(s)`);
  check('but the same ground is not measured twice',
    after === before, `${before.toLocaleString()} -> ${after.toLocaleString()} sq ft`);

  // And the panel says why the figure is smaller than the parts add up to,
  // rather than leaving it looking like lost lawn.
  const sub = await page.textContent('#result-sub');
  check('and the panel says the overlap was counted once',
    /overlap counted once/i.test(sub), sub.trim());

  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => window.__lmSqft());
  check('and undo puts the map back where it was',
    restored === before, `${restored.toLocaleString()} sq ft`);
}
if (detectedSqft !== null && parcelSqft > 0) {
  // Not an assertion: how much of a lot is lawn varies enormously. It is here
  // because a bare square-footage says nothing about whether the detection was
  // sensible, and the ratio does.
  console.log(`      detected lawn is ${(100 * detectedSqft / parcelSqft).toFixed(1)}% of the parcel`);
}

/* ------------------------------------------------- locks on redoing a step */
/*
 * A step cannot be redone once a later one has built on it.
 *
 * There is a lawn on the map now, put there by hand. Running the AI over it
 * would throw those corrections away and moving the property line would
 * re-trim them -- both silently, from a tab somebody wandered into. So both
 * are greyed out with the reason on them, and both are one press from being
 * available again. Refusing outright would be worse than the accident.
 */
console.log('\n--- locks ---');
{
  await goTab(page, 'detect');
  const det = await page.evaluate(() => window.__lmTabs());
  check('correcting by hand locks the AI tab', det.locked.includes('detect'),
    `locked: ${det.locked.join(', ') || 'nothing'}`);
  check('and says why, rather than just greying out',
    det.noticeVisible === true);
  check('the detect button is genuinely dead, not merely faded',
    await page.evaluate(() => document.querySelector('#btn-detect').disabled) === true);

  /*
   * BUT THE PROPERTY LINE STAYS EDITABLE, deliberately.
   *
   * It was gated too, on the reasoning that moving the boundary re-trims a
   * lawn measured against the old one. That sounded right and was wrong in
   * practice: noticing your lawn runs past the recorded line to the road is
   * something you notice AFTER seeing the detection, and the gate made fixing
   * it cost a second paid detection. Moving the line does not touch the shapes
   * on the map, so gating a free correction behind a paid one is the wrong
   * trade.
   */
  await goTab(page, 'address');
  const addr = await page.evaluate(() => window.__lmTabs());
  check('but a measured lawn does NOT lock the property line',
    !addr.locked.includes('address'),
    `locked: ${addr.locked.join(', ') || 'nothing'} (parcel=${addr.hasParcel})`);
  check('and its map tool is still there to press',
    addr.rail.includes('parcel'), addr.rail.join(', ') || '(empty)');

  /* The way out is on the notice, and it keeps the boundary. */
  await goTab(page, 'detect');
  await page.click('#btn-lock-clear');
  await page.waitForTimeout(400);
  const freed = await page.evaluate(() => ({
    ...window.__lmTabs(),
    shapes: window.__lmShapeCount(),
    parcel: Boolean(window.__lmTabs().hasParcel),
  }));
  check('clearing the lawn lifts every lock', freed.locked.length === 0,
    `still locked: ${freed.locked.join(', ') || 'nothing'}`);
  check('and takes the lawn with it', freed.shapes === 0, `${freed.shapes} shape(s)`);
  check('but keeps the property line, which is the slow thing to redo',
    freed.parcel === hasParcel, `parcel=${freed.parcel}`);
}

/* ------------------------------------------------------ feedback prompt */
/*
 * The question can only be asked at the handover, and only about a detection.
 *
 * This run has not paid for one unless RUN_DETECT was set, so what is checked
 * here is the half that holds either way: a lawn that the AI did not produce
 * must NOT be asked about. "How did the AI do?" over a shape somebody drew
 * themselves is a question with no answer, and the kind of thing that trains
 * people to dismiss the dialog without reading it.
 */
console.log('\n--- the feedback question ---');
{
  /*
   * THE HALF THAT HOLDS ON EVERY RUN: a lawn the AI did not produce must NOT
   * be asked about. "How did the AI do?" over a shape somebody drew themselves
   * is a question with no answer, and the kind of thing that teaches people to
   * dismiss dialogs without reading them. The dialog's own contents are
   * checked in the real-detection section above, which is the only place it
   * can legitimately appear.
   */
  await goTab(page, 'draw');
  await page.waitForTimeout(300);
  const fb = await page.evaluate(() => window.__lmFeedback());
  check('nothing is asked about a lawn the AI did not produce', fb.open === false,
    `open=${fb.open} detected=${fb.detected}, asked ${fb.asked} time(s)`);

  /* Asked once per detection. A dialog that returns reads as a bug. */
  check('and a detection already answered is not asked about again',
    fb.detected === false || fb.asked > 0,
    `detected=${fb.detected}, asked ${fb.asked} time(s)`);
}

/* ---------------------------------------------------------- saved maps */
/*
 * A measurement is kept without being asked to be. A save button would mean
 * losing work by forgetting to press it, and there is nothing here worth
 * making somebody decide about.
 */
console.log('\n--- saved maps ---');
{
  await goTab(page, 'draw');
  await page.click('#btn-parcel-shape');
  await page.waitForTimeout(2200); // the write is debounced: a stroke is one edit

  await goTab(page, 'saved');
  const saved = await page.evaluate(() => window.__lmSaves());
  check('a measurement is kept on its own', saved.entries.length > 0,
    `${saved.entries.length} save(s)`);
  check('and is listed under its address',
    saved.rendered.length === saved.entries.length && saved.rendered.length > 0,
    saved.rendered.join(' | '));
  check('the store is capped so it cannot grow forever',
    saved.entries.length <= saved.max, `${saved.entries.length} of ${saved.max}`);

  /*
   * ADDRESS + METHOD + ARITHMETIC IS WHAT MAKES TWO SAVES THE SAME SAVE.
   * Re-measuring the same lot the same way updates that map rather than
   * piling up a third, which is what lets one address hold two.
   */
  const before = saved.entries.length;
  await goTab(page, 'draw');
  // There are shapes on the map now, so the button asks before replacing them.
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-parcel-shape');
  await page.waitForTimeout(2200);
  const again = await page.evaluate(() => window.__lmSaves());
  check('measuring the same lot the same way updates that save, not a new one',
    again.entries.length === before, `${before} -> ${again.entries.length}`);

  /* The map goes away on the saves tab: there is nothing to edit there. */
  await goTab(page, 'saved');
  const onSaves = await page.evaluate(() => window.__lmTabs());
  check('and no editing tools are offered while browsing saves',
    onSaves.rail.length === 0, onSaves.rail.join(', '));
  await goTab(page, 'draw');
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

/*
 * SLIDING AN EDGE IS A PROPERTY-LINE TOOL AND IS NOT OFFERED ON A LAWN.
 *
 * It keeps a surveyed bearing exactly, which is worth having on a boundary a
 * county recorded and worth nothing on a lawn -- where the mowing stops is not
 * a surveyed line. Meanwhile it cost the corners their pixels: distance to a
 * segment goes to zero at its endpoints, so a corner tap that missed by a few
 * pixels grabbed the edge every time, and there was no way to aim past it.
 *
 * Asserted as "the slider did not open", not as "nothing happened": the tap
 * above still has to reach the map, which the touch check just proved.
 */
check('tapping a line in lawn mode does not open the edge slider',
  !(await page.locator('#edge-controls').isVisible()),
  'edges compete with corners for the same pixels, and only corners matter here');

/*
 * ...and it is still there on the property line, which is the half that has to
 * keep working. Taken out of lawn mode is not taken out.
 */
{
  // Property-line mode belongs to the address step, so open that step first:
  // reaching for a control on another one is how a run stops dead partway
  // through, which tools/testflow.test.js exists to catch before it does.
  await goTab(page, 'address');
  await page.click('#mode-parcel');
  await page.waitForTimeout(450);

  /*
   * Aimed at the middle of the longest segment on screen, so the tap is as far
   * from both its corners as the geometry allows. The old version tapped a
   * fixed spot twelve pixels in from the left and reported "no edge selected
   * by that tap -- not a failure, geometry dependent", which is a check that
   * cannot fail and therefore was not one.
   */
  const mid = await page.evaluate(() => {
    const pts = window.__lmCorners();
    if (pts.length < 2) return null;
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!best || len > best.len) best = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return best;
  });

  if (mid && mid.len > 60) {
    const mapBox = await page.locator('#map').boundingBox();
    await page.touchscreen.tap(mapBox.x + mid.x, mapBox.y + mid.y);
    await page.waitForTimeout(600);

    check('but tapping a line on the property line still grabs that edge',
      await page.locator('#edge-controls').isVisible(),
      await page.locator('#edge-info').textContent());

    if (await page.locator('#edge-controls').isVisible()) {
      const area = () => page.evaluate(() => window.__lmPoints()[0]?.sqft ?? 0);
      const before = await area();
      await page.locator('#edge-slider').fill('25');
      await page.waitForTimeout(600);
      const after = await area();
      const bearing = await page.locator('#edge-bearing').textContent();
      console.log(`      ${before.toFixed(0)} -> ${after.toFixed(0)} sq ft after +25 ft   (${bearing})`);
      check('and pushing it out grows the boundary', after > before,
        `${before.toFixed(0)} -> ${after.toFixed(0)} sq ft`);

      /*
       * Put it back. The slider is absolute -- every offset is measured from
       * the shape as it was when the edge was picked -- so zero restores the
       * boundary exactly, and everything downstream measures the lot rather
       * than the lot plus twenty-five feet of this test.
       */
      await page.locator('#edge-slider').fill('0');
      await page.waitForTimeout(500);
    }
  } else {
    console.log(`      (no segment long enough to aim at: ${mid ? Math.round(mid.len) : 0} px)`);
  }

  await page.click('#mode-parcel');  // out of property-line mode
  await page.waitForTimeout(250);
  await goTab(page, 'draw');
  await page.click('#mode-shape');   // and back to the lawn, where the rest runs
  await page.waitForTimeout(400);
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

await armBrush(page, 'erase');
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

await armBrush(page, 'erase');
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
await armBrush(page, 'add');
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

/* --------------------------------------------------- cutting a shape out */
/*
 * THE REPORT: "it should be possible to make subtractive shapes with the point
 * tool -- should be able to trim out a shed with points only."
 *
 * A shed has four straight sides and a fingertip does not, so rubbing one out
 * with the brush is the loose way to do an exact job. Tracing its corners is
 * the exact way, and what that produces is an ordinary hole -- which is also
 * the second half of the same report: the corners of an interior shape could
 * not be tapped at all, because the editor read coordinates[0] and holes were
 * invisible to it.
 *
 * The gesture and its result are checked separately, deliberately. Driving
 * Mapbox Draw's polygon mode from synthetic clicks fails for reasons that have
 * nothing to do with this feature, so the button is checked for arming Draw
 * and the outline it would produce is handed to the real code.
 */
console.log('\n--- cutting a shape out ---');
{
  await goTab(page, 'draw');
  await page.click('#btn-cut');
  await page.waitForTimeout(400);

  const armed = await page.evaluate(() => window.__lmDrawingHole());
  check('Cut out a shape arms Draw and marks what the outline is for',
    armed.armed === true && /^draw_polygon/.test(String(armed.drawMode)),
    `armed=${armed.armed} draw is in ${armed.drawMode}`);

  const cut = await page.evaluate(() => window.__lmCutSquare());
  check('a traced outline inside the lawn becomes a cut-out', cut.ok === true,
    cut.ok ? '' : String(cut.why));

  if (cut.ok) {
    console.log(`      ${cut.said}`);
    /*
     * The area has to fall by the size of the cut, not merely fall. A hole
     * that traced at some other size, or a shape quietly replaced by the
     * square, would both show up as "the number went down".
     */
    const lost = cut.before - cut.after;
    check('and it takes exactly its own area off the shape it was cut from',
      Math.abs(lost - cut.cutSqFt) < Math.max(1, cut.cutSqFt * 0.001),
      `lost ${Math.round(lost)} sq ft for a ${Math.round(cut.cutSqFt)} sq ft cut`);

    await page.click('#tool-points');
    await page.waitForTimeout(400);

    const rings = await page.evaluate(() => window.__lmEditable());
    check('the cut-out is an editable ring like any other', rings.holes === 1,
      `${rings.rings} ring(s) across ${rings.ids.length} shape(s), ${rings.holes} hole(s)`);

    /*
     * AND ITS CORNERS ANSWER A TAP. This is the half that was missing: the
     * dots could be drawn and the hit test still not know the ring existed,
     * which from a phone is a corner that simply does not respond.
     */
    const corners = await page.evaluate(() => window.__lmCorners());
    const onHole = corners.filter((c) => c.hole);
    check('its corners are drawn', onHole.length >= 4, `${onHole.length} corner(s) on the cut-out`);

    if (onHole.length) {
      const mapBox = await page.locator('#map').boundingBox();
      await page.touchscreen.tap(mapBox.x + onHole[0].x, mapBox.y + onHole[0].y);
      await page.waitForTimeout(500);

      const said = await page.locator('#edge-info').textContent();
      check('and tapping one selects it, naming what it belongs to',
        (await page.locator('#point-controls').isVisible()) && /cut-out/i.test(said),
        said.trim());

      /*
       * The last corner of a cut-out REMOVES the cut rather than refusing.
       * On an outline three corners is the floor and stopping is right; on a
       * hole it means "I did not want this", and refusing left undo as the
       * only way back out of a cut.
       */
      const label = await page.locator('#btn-point-delete').textContent();
      console.log(`      delete button reads: "${label.trim()}"`);
    }

    /* Put the lawn back the way the rest of the run expects to find it. */
    await page.click('#btn-undo');
    await page.waitForTimeout(500);
    check('and undo puts the cut back',
      (await page.evaluate(() => window.__lmEditable().holes)) === 0);
  }
}

/* ------------------------------------- held at the property line */
/*
 * THE REPORT: "moving points beyond the property line adds to the square
 * footage, even with measure outside property line turned off."
 *
 * It did. The option gated the Add brush and nothing else, so one of the two
 * ways to put lawn past the boundary respected it and the other did not --
 * with the option switched off and the line drawn on the map the whole time.
 *
 * Asserted on the area OUTSIDE the line rather than on the panel total. The
 * total moving is not the bug; where the ground it counts sits is.
 */
console.log('\n--- held at the property line ---');
{
  await goTab(page, 'draw');
  await page.click('#tool-points');
  await page.waitForTimeout(400);

  /*
   * The baseline is REPORTED, not asserted. Earlier sections have brushed and
   * cut this lawn about, and how much of it happens to sit outside the line
   * before this starts is not the claim -- the claim is that the drag does not
   * add to it. Asserting the starting state would be a check that fails for
   * something another section did.
   */
  const outsideBefore = await page.evaluate(() => window.__lmOutsideSqFt());
  console.log(`      ${Math.round(outsideBefore)} sq ft outside the line to begin with`);

  /*
   * Drag a corner hard towards the edge of the map, which on a lot that fills
   * the frame is well past the boundary in any direction.
   */
  const target = await page.evaluate(() => window.__lmPoints()[0] || null);
  if (target) {
    const dragged = await page.evaluate(async ([x, y]) => {
      const el = document.querySelector('.mapboxgl-canvas-container');
      const touch = (t, cx, cy) => el.dispatchEvent(new TouchEvent(t, {
        bubbles: true, cancelable: true,
        touches: t === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
      }));
      touch('touchstart', x, y);
      for (let i = 1; i <= 10; i++) {
        touch('touchmove', x - i * 22, y - i * 16);
        await new Promise((r) => setTimeout(r, 25));
      }
      touch('touchend', x - 220, y - 160);
      await new Promise((r) => setTimeout(r, 400));
      return { outside: window.__lmOutsideSqFt(), hint: document.querySelector('#map-hint')?.textContent || '' };
    }, [target.x, target.y]);

    check('a corner dragged far past the boundary adds nothing outside it',
      dragged.outside < outsideBefore + 60,
      `${Math.round(outsideBefore)} -> ${Math.round(dragged.outside)} sq ft outside, ` +
      'after a drag 270 px towards the edge of the map');
    check('and the map says why the corner stopped following the finger',
      /property line/i.test(dragged.hint), dragged.hint.trim() || '(no hint)');

    /*
     * AND THE OPTION STILL MEANS SOMETHING. A hold that cannot be lifted is
     * not a setting, it is a wall -- and going out to the kerb is the case the
     * option exists for.
     */
    await page.locator('#toggle-outside').setChecked(true);
    await page.waitForTimeout(300);
    const freed = await page.evaluate(async () => {
      const el = document.querySelector('.mapboxgl-canvas-container');
      const p = window.__lmPoints()[0];
      const touch = (t, cx, cy) => el.dispatchEvent(new TouchEvent(t, {
        bubbles: true, cancelable: true,
        touches: t === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })],
      }));
      touch('touchstart', p.x, p.y);
      for (let i = 1; i <= 10; i++) {
        touch('touchmove', p.x - i * 22, p.y - i * 16);
        await new Promise((r) => setTimeout(r, 25));
      }
      touch('touchend', p.x - 220, p.y - 160);
      await new Promise((r) => setTimeout(r, 400));
      return window.__lmOutsideSqFt();
    });
    check('switched on, the same drag goes past the line',
      freed > dragged.outside + 50,
      `${Math.round(dragged.outside)} -> ${Math.round(freed)} sq ft outside`);

    /* Back inside, which also re-trims -- and is how the rest of the run expects it. */
    await page.locator('#toggle-outside').setChecked(false);
    await page.waitForTimeout(700);
    const trimmed = await page.evaluate(() => window.__lmOutsideSqFt());
    check('and switching it back off trims to the line again',
      trimmed < outsideBefore + 60,
      `${Math.round(freed)} -> ${Math.round(trimmed)} sq ft outside`);
  } else {
    check('there was a corner to drag', false, 'no editable ring to aim at');
  }
}

/* ------------------------------------------------------- brush width */
/*
 * The only brush anyone can see is the coloured line under their finger, so
 * that line IS the brush. It used to be 24 px wide while the raster painted a
 * 22 px RADIUS -- 44 px across, near enough double what had just been drawn,
 * which is exactly how it was reported. The two numbers now come from one
 * constant, and this asserts they still agree rather than trusting that.
 */
console.log('\n--- brush width ---');
await armBrush(page, 'erase');
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

/* --------------------------------------------- moving the map with a tool on */
/*
 * THE COMPLAINT: with a brush selected the map could not be moved at all.
 *
 * It could not, and this is the exact mechanism. Mapbox's `dragPan` is ONE
 * handler covering one finger and two, so switching it off to stop a brush
 * stroke panning the map also removed the two-finger pan that would have been
 * the way out. On a phone that is a dead end: the part of the lawn that is off
 * screen cannot be reached without putting the tool down, scrolling, and
 * picking it up again.
 *
 * A tool now claims the gesture in the capture phase instead, so Mapbox's
 * handlers stay enabled throughout and a second finger gets an ordinary map.
 * "Is dragPan still enabled while a brush is live" is the whole question, and
 * nothing on screen can answer it.
 */
console.log('\n--- panning while a tool is armed ---');
const withTool = await page.evaluate(() => window.__lmGestures());
check('the map can still be panned with a brush selected',
  withTool.dragPan === true,
  'disabling this is what made two-finger panning impossible');
check('and pinch-zoom is still live alongside it', withTool.touchZoom === true);
check('a held press is offered as the one-handed way out',
  withTool.holdMs >= 300 && withTool.holdMs <= 800, `${withTool.holdMs} ms`);
check('and nothing is panning until somebody asks for it',
  withTool.panning === false);

/*
 * THE REPORT: "tap and drag shortly after and the view zooms -- very
 * disruptive if your workflow is tap, pan, tap, repeat."
 *
 * Mapbox's tap-drag zoom: a second touch inside the double-tap window, then a
 * drag, zooms instead of panning. Correcting a lawn IS tap, pan, tap, repeat,
 * so the app's main gesture and the zoom gesture were the same gesture and the
 * map had to guess which was meant.
 *
 * Asserted on the handler rather than by performing the gesture, because a
 * synthetic double-tap-and-drag that fails to zoom proves nothing: it might
 * have missed the timing window, which is how this would pass while broken.
 */
check('double-tap zoom is switched off, not merely unused',
  withTool.doubleClickZoom === false,
  'it is the same gesture as tap, pan, tap — the map cannot tell them apart');
check('and pinch is left as the way to zoom', withTool.touchZoom === true,
  'taking away the one that works is not a fix for the one that collides');

/* ------------------------------------------------------------ north is up */
/*
 * A two-finger twist is easy to trigger by accident while pinching, and there
 * is no compass on screen to undo it with. Every measurement here is read
 * against a satellite photograph, so "which way is the street" is how a person
 * checks they are looking at their own lot.
 */
console.log('\n--- north stays up ---');
const facing = await page.evaluate(() => window.__lmGestures());
check('rotation is switched off, not merely unused', facing.dragRotate === false,
  'a gesture that cannot fire cannot leave the map crooked');
check('north is up', facing.bearing === 0, `${facing.bearing}°`);
check('and the map is not tilted', facing.pitch === 0, `${facing.pitch}°`);

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
  await armBrush(page, 'add');
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
      await armBrush(page, 'add');
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
  await armBrush(page, 'add');
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

/*
 * The boundary half is done with no lawn on the map, so that "reaches only the
 * property line" means something -- with lawn shapes present, an empty result
 * and a correct one would look the same.
 */
await unlockDetect(page);
await goTab(page, 'address');
const inParcel = await reachableIn('parcel');
console.log(`      property-line mode reaches: ${JSON.stringify(inParcel.ids)}`);
check('property-line mode reaches the property line and nothing else',
  inParcel.ids.length === 1 && inParcel.ids[0] === inParcel.parcelId,
  JSON.stringify(inParcel.ids));

/* A lawn to isolate the boundary FROM, put back the way a person would. */
await goTab(page, 'draw');
await page.click('#btn-parcel-shape');
await page.waitForTimeout(800);
check('and a lawn can be put back to isolate it from',
  (await page.evaluate(() => window.__lmShapeCount())) > 0);

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

/*
 * Everything above corrected the lawn by hand, which locks the AI tab on
 * purpose. Clearing through the notice is how a person gets back to the model
 * picker, so that is how this does it.
 */
await unlockDetect(page);

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

  await goTab(page, 'draw');
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

  /* And an ordinary visitor must not be asking for the larger allowance --
   * the flag is unguarded, so the only thing keeping it honest is that the
   * app does not send it unless the mode is really on. */
  const shutBody = await page.evaluate(() => window.__lmDetectBody());
  check('and an ordinary visitor does not ask for the developer allowance',
    !('dev' in shutBody), JSON.stringify(shutBody.dev));

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

  /* ------------------------------------------------- the edge tool */
  /*
   * Buttons and a typed field replaced a slider, and the range went from 3 ft
   * to 15 -- because 3 was sized for tidying a lawn edge, not for correcting an
   * exclusion. The AI's woods at Brooks Lane runs about 25% wider than the
   * owner's, which needs roughly five feet of trim: a control that stops short
   * of the correction it exists for looks broken.
   *
   * Driven through the real setter, so this is the parsing the app actually
   * uses rather than a copy of it.
   */
  const edge = await page.evaluate(() => window.__lmEdge());
  check('the edge tool reaches far enough to trim a treeline',
    edge.max >= 10, `${edge.max} ft`);
  check('and starts at nothing', edge.ft === 0 && edge.field === '0');

  check('a typed distance is taken', await page.evaluate(() => window.__lmSetEdge('-5')) === -5);
  check('and the note says which way it went',
    /pulled in 5 ft/i.test((await page.evaluate(() => window.__lmEdge())).note),
    (await page.evaluate(() => window.__lmEdge())).note);

  check('past the range it clamps rather than refusing',
    await page.evaluate(() => window.__lmSetEdge('999')) === edge.max);
  check('in both directions',
    await page.evaluate(() => window.__lmSetEdge('-999')) === -edge.max);

  /*
   * A HALF-TYPED VALUE MUST NOT MOVE THE LAWN. "-" on the way to "-5" parses as
   * nothing, and treating nothing as zero would re-trace the outline underneath
   * somebody mid-keystroke.
   */
  await page.evaluate(() => window.__lmSetEdge('-3'));
  check('a half-typed minus leaves the setting alone',
    await page.evaluate(() => window.__lmSetEdge('-')) === -3);
  check('as does a word', await page.evaluate(() => window.__lmSetEdge('abc')) === -3);
  check('and a bare unit left behind by a half-deleted entry',
    await page.evaluate(() => window.__lmSetEdge('ft')) === -3);
  check('and an empty field', await page.evaluate(() => window.__lmSetEdge('')) === -3,
    'stripping these leaves "", and Number("") is 0 -- which flattened the outline');

  check('and a pasted unit is read, not rejected',
    await page.evaluate(() => window.__lmSetEdge('4 ft')) === 4);

  await page.evaluate(() => window.__lmSetEdge(0));
  check('back to nothing', (await page.evaluate(() => window.__lmEdge())).ft === 0);

  /*
   * THE LARGER ALLOWANCE HAS TO BE IN THE REQUEST, not just in the app.
   *
   * This shipped broken and every layer had a passing test: the Worker honoured
   * the flag, the badge asked for it and showed fifty, and the detection was
   * still refused at twenty. Nothing checked the one link between them --
   * whether the browser actually put the flag in the body it posts.
   *
   * Read off the REAL builder that detect() calls, not a copy of it. A test
   * that assembled its own body would have agreed with itself and proved
   * nothing, which is how this got through in the first place.
   */
  const devBody = await page.evaluate(() => window.__lmDetectBody());
  check('an unlocked browser asks for the developer allowance in the request',
    devBody.dev === true, `dev=${JSON.stringify(devBody.dev)}`);
  check('and still sends its client id, which is what the allowance counts',
    typeof devBody.clientId === 'string' && devBody.clientId.length > 0);

  /* And the badge has to be asking against the same ceiling, or the two
   * disagree on screen exactly as they did when this was broken. */
  const badge = await page.textContent('#quota-badge');
  check('and the badge counts against the developer ceiling too',
    /of 80 AI passes/.test(badge), badge.trim());

  /* And it must name the UNIT it counts. It said "detections" while counting
   * Replicate predictions, which are the same thing only until a second box is
   * ticked -- then one detection costs two and the number stops matching the
   * word beside it. That mislabelling is how "50" came to mean twelve. */
  check('and the badge names passes, which is what it actually counts',
    /AI passes/.test(badge) && !/detections left/.test(badge), badge.trim());

  /*
   * THE TESTING METHOD. Its reason for existing is that overriding the prompt
   * on a shipped method left that method's own settings in play, so a
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
   * On a shipped method the box must NOT decide. Exclude does not invert at
   * all -- it subtracts from the property line -- and a live control that
   * silently does nothing is a lie.
   */
  await page.evaluate(() => window.__lmSetModel('sam3_exclude'));
  await page.waitForTimeout(250);
  const sub = await page.evaluate(() => window.__lmDev());
  check('Exclude ignores the inversion box, which is not how it works',
    sub.inverts === false, `inverts=${sub.inverts}`);
  check('and the box is disabled there, rather than pretending to work',
    await page.locator('#dev-invert').isDisabled());

  await page.evaluate(() => window.__lmSetModel('sam3'));
  await page.waitForTimeout(250);
  check('Find grass does not invert either',
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
