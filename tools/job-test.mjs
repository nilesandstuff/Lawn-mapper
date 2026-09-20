/**
 * Drives the paid queue in a real browser, the way a stranger on a crowd
 * platform will.
 *
 * WHY THIS ONE MATTERS MORE THAN THE OTHER BROWSER TEST. Everything else in
 * this app fails in front of somebody who can reload, come back tomorrow, or
 * email the owner. This path fails in front of somebody who has already done
 * four minutes of unpaid work and has no way to reach anybody -- and what they
 * file is not a bug report, it is a post on a worker forum about a requester
 * who wastes people's time. The whole design leans on that not happening (see
 * the note about unchanged outlines in jobs.js), and none of it is worth
 * anything if the page does not come up.
 *
 * WHAT IT COSTS: nothing on Replicate. Detection is stubbed at the network
 * rather than run, which is deliberate twice over -- it keeps a browser test
 * from spending money on every run, AND a failed detection is the case worth
 * checking anyway: a worker whose automatic outline does not arrive must still
 * be able to trace the lawn by hand and send it, because all the tools are
 * there. Mapbox usage is a few tiles.
 *
 * It needs a database with lawn_jobs in it, which is why the workflow applies
 * the schema and seeds rows before starting the app.
 *
 *   node tools/job-test.mjs [base-url]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const MTURK_PREVIEW = 'ASSIGNMENT_ID_NOT_AVAILABLE';

/* Kept in step with MIN_SECONDS in worker/src/jobs.js. See the wait below. */
const MIN_SECONDS = 60;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/*
 * CHROMIUM_PATH is an escape hatch for a machine that already has a browser
 * and cannot download the exact build this Playwright wants. CI leaves it
 * unset and gets the matching one; a sandbox with a preinstalled Chromium sets
 * it and runs the same checks rather than skipping them.
 */
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const open = [];

/**
 * A fresh browser context per worker, and that is not tidiness.
 *
 * Workers on a crowd platform are strangers to each other, and the only thing
 * separating them here is the id in the link -- no accounts, and no cookie
 * that means anything. A test that reused one context could pass while the app
 * quietly treated two workers as one, which is exactly the bug that hands two
 * people the same lawn and pays twice for one map.
 */
async function arrive(query, { stubDetect = true, blockMapbox = false, withMail = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  open.push(context);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`      [console] ${m.text().slice(0, 160)}`);
  });

  /* Stand in for an ad blocker, a corporate filter or a CDN outage. */
  if (blockMapbox) await page.route('**/api.mapbox.com/mapbox-gl-js/**', (r) => r.abort());

  /*
   * SAY THIS DEPLOYMENT CAN SEND MAIL.
   *
   * The local worker these tests drive has no RESEND_API_KEY -- the workflow
   * writes a .dev.vars with map and model tokens and nothing else -- so
   * /api/auth/me honestly answers `email: false` and the sign-in panel
   * correctly shows an explanation instead of a form.
   *
   * Which is right, and makes it impossible to test anything ABOUT the form
   * without saying otherwise. Stubbed rather than configured, because the
   * alternative is a mail provider's key in CI for a form nobody submits.
   */
  if (withMail) {
    await page.route('**/api/auth/me', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: null, email: true }),
    }));
  }

  const detects = [];
  if (stubDetect) {
    /*
     * REFUSED, NOT ANSWERED. Returning a fake mask would need a real PNG and
     * would be testing the mask pipeline, which other suites already cover.
     * What this wants is the worse case: the outline did not arrive, and the
     * person being paid must still be able to do the job.
     *
     * The request body is kept, because it carries the one thing about the
     * free detection that cannot be checked from the server side.
     */
    await page.route('**/api/segment', async (route) => {
      try {
        detects.push(JSON.parse(route.request().postData() || '{}'));
      } catch {
        detects.push({});
      }
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Segmentation unavailable', detail: 'stubbed in the test' }),
      });
    });
  }

  await page.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lmJob !== undefined, { timeout: 30000 });
  return { context, page, detects, arrivedAt: Date.now() };
}

const job = (page) => page.evaluate(() => window.__lmJob());

/** Wait for the queue to settle into either a lawn or a sheet. */
async function settled(page) {
  await page.waitForFunction(
    () => window.__lmJob().barVisible || window.__lmJob().sheet !== null,
    { timeout: 60000 }
  );
  return job(page);
}

/**
 * Paint a lawn, the way somebody with no outline to fix would.
 *
 * THREE PRESSES, NOT TWO, and the third is the whole reason this is a helper.
 * Shape mode opens on Points -- corner editing -- and the rail folds Add and
 * Erase away behind one Brushes icon while it is live, because the rail sits
 * over the map and the tools for the job you are not doing are covering the
 * lawn. So a brush is: shape, brushes, add.
 */
async function traceALawn(page) {
  await page.click('#mode-shape');
  await page.waitForTimeout(250);
  if (await page.locator('#tool-brushes').isVisible()) {
    await page.click('#tool-brushes');
    await page.waitForTimeout(250);
  }
  await page.click('#tool-add');
  await page.waitForTimeout(250);
  const mb = await page.locator('#map').boundingBox();
  const x = mb.x + mb.width / 2;
  const y = mb.y + mb.height / 2;
  await page.mouse.move(x - 40, y - 30);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 40 + i * 8, y - 30 + i * 6);
  await page.mouse.up();
  await page.waitForTimeout(800);
  return page.evaluate(() => ({
    shapes: window.__lmShapeCount(), sqft: window.__lmSqft(),
  }));
}

/* ------------------------------------------------------------- previewing */
{
  /*
   * MTurk shows a task to people who are only looking, and says so with this
   * literal string. Claiming for them would take a lawn out of the queue for
   * somebody who never agreed to do it and hold it for an hour -- once per
   * curious visitor, on the batch that is the whole point of the exercise.
   */
  const { page } = await arrive(`?w=PREVIEWER&assignmentId=${MTURK_PREVIEW}`);
  const seen = await settled(page);

  check('a preview is shown what the task is',
    seen.sheet !== null && /trace one lawn/i.test(seen.sheet),
    seen.sheet);
  check('and told nothing has been assigned yet',
    /assigned|preview/i.test(await page.textContent('#job-sheet-note')),
    await page.textContent('#job-sheet-note'));
  check('and no lawn is claimed for somebody who is only looking',
    seen.jobId === null && !seen.barVisible,
    'a claim per curious visitor would empty the queue into nobody\'s hands');
}

/* ------------------------------------------------ when the map cannot load */
{
  /*
   * THIS IS WHY THE TEST EXISTS. It was written expecting a lawn and got a
   * crash: initMap returns NORMALLY when the Mapbox CDN is unreachable -- it
   * says so on screen and stops, which is right for an ordinary visitor -- but
   * the boot chain carried on and job mode claimed a lawn for somebody whose
   * page had no map and no tools on it. The lawn was then out of the queue for
   * an hour, and the worker saw a crash.
   *
   * An ad blocker, a corporate filter or a CDN outage is exactly the case the
   * message in initMap exists for, and somebody arriving from a crowd platform
   * is more likely to be behind one of those than the average visitor, not
   * less.
   */
  const { page } = await arrive('?w=BLOCKED', { blockMapbox: true });
  const stuck = await settled(page);

  check('a worker whose browser cannot reach Mapbox is told what happened',
    stuck.sheet !== null && /map would not load/i.test(stuck.sheet),
    stuck.sheet || '(nothing said at all)');
  check('and no lawn is taken out of the queue for a page with no map on it',
    stuck.jobId === null && !stuck.barVisible,
    'claiming here holds a lawn for an hour and hands the worker a crash');
  check('and they are told they have not lost anything',
    /not been assigned|nothing has been assigned|not lost/i.test(
      await page.textContent('#job-sheet-why')
    ),
    await page.textContent('#job-sheet-why'));
}

/* --------------------------------------------------------- getting a lawn */
const one = await arrive('?w=BROWSERTEST1');
const mine = await settled(one.page);
{
  const { page, detects } = one;

  /*
   * FIRST, THAT THE MAP ITSELF CAME UP, and STOPPING if it did not.
   *
   * Every check below this line needs a map, so without one they would each
   * fail on a thirty-second timeout and the run would read like job mode being
   * broken -- when the real answer is a missing Mapbox token on whatever is
   * running this. Said once, loudly, beats twenty misleading failures and no
   * summary at the end.
   */
  const libs = await page.evaluate(() => ({
    /* An object, not a function: Mapbox GL v3 exports a namespace. Getting
       that wrong is how this check first failed against a working map. */
    gl: typeof mapboxgl,
    draw: typeof MapboxDraw,
  }));
  const haveMapbox = libs.gl !== 'undefined' && libs.draw !== 'undefined';
  check('the map library is there to trace on', haveMapbox,
    haveMapbox ? `mapboxgl: ${libs.gl}, MapboxDraw: ${libs.draw}`
      : 'no mapping library -- check MAPBOX_TOKEN on whatever is serving this');
  if (!haveMapbox) {
    console.log('\nStopping: the rest of this file needs a working map.\n');
    for (const c of open) await c.close().catch(() => {});
    await browser.close();
    process.exit(1);
  }

  check('a worker with an id in the link is handed a lawn',
    mine.barVisible && mine.jobId,
    mine.sheet ? `a sheet instead: ${mine.sheet}` : `job ${mine.jobId}`);
  check('and told what the job is asking for, on the page',
    mine.prompts >= 4,
    `${mine.prompts} prompts -- a platform's task description scrolls away the `
    + 'moment somebody clicks through to the work');
  check('and which property it is',
    (await page.textContent('#job-where')).length > 10,
    await page.textContent('#job-where'));

  /*
   * WHAT THEY ARE NOT OFFERED. Each of these is a dead end for somebody with
   * no account and a lawn chosen for them -- and #btn-finish is worse than a
   * dead end: two buttons that both look like the end of the task is how a map
   * gets saved without ever being submitted, which is work done and not paid.
   */
  check('and is shown none of the steps that do not exist for them',
    mine.offered.length === 0,
    mine.offered.join(', ') || 'none of them');

  check('and the address step is behind them rather than in front',
    await page.locator('#step-address').isHidden()
    && await page.locator('#step-work').isVisible());

  /*
   * The drawing tools are the whole reason this is the app rather than a
   * stripped page. Without them there is no task to do.
   */
  /*
   * THEY LAND ON THE PROPERTY LINE, WITH IT ARMED. The detection is clipped to
   * that boundary, so grass outside it cannot be drawn until the line is
   * moved -- and the road prompt asks for exactly that grass. Somebody who has
   * not understood that the yellow line is draggable reads the prompt, cannot
   * reach the verge, and quietly leaves it out.
   */
  /*
   * WAITED FOR, NOT ASSUMED. `settled` returns as soon as the job bar is up,
   * and the bar goes up early -- before the parcel lookup, the detection and
   * the landing tab. Read straight after, this said "address, tool off" and
   * looked like the arming had failed, when it had simply not happened yet.
   */
  const landed = await page.waitForFunction(
    () => (window.__lmTabs().on === 'address'
      && document.querySelector('#mode-parcel')?.getAttribute('aria-pressed') === 'true'),
    null,
    { timeout: 45000 }
  ).then(() => true).catch(() => false);

  check('and lands on the property line with the tool already on', landed,
    landed ? '' : `tab=${await page.evaluate(() => window.__lmTabs().on)}, `
      + `parcel=${await page.evaluate(() => document.querySelector('#mode-parcel')?.getAttribute('aria-pressed'))}`);

  check('and is told to drag the boundary out to the kerb',
    await page.locator('#coach').isVisible()
    && /kerb|boundary/i.test(await page.textContent('#coach-text')),
    (await page.textContent('#coach-title')) || '(no tip shown)');

  await page.click('#coach-ok');
  await page.click('#tab-draw');
  await page.waitForTimeout(250);
  check('and has the drawing tools, which are the entire job',
    await page.locator('#btn-draw').isEnabled()
    && await page.locator('#mode-shape').isVisible());

  /*
   * THE CLAIM RIDES ALONG WITH THE DETECTION, and this cannot be checked from
   * the server: if the browser stops sending it, every worker silently falls
   * back to a five-a-day signed-out allowance and the task breaks on their
   * sixth map -- which looks like the site being broken rather than like one
   * missing field.
   */
  check('and the automatic outline is asked for on the job\'s account, not theirs',
    detects.length > 0 && detects[0].job === mine.jobId && detects[0].worker === 'BROWSERTEST1',
    detects.length
      ? `job=${detects[0].job || '(missing)'} worker=${detects[0].worker || '(missing)'}`
      : 'no detection was attempted at all');

  check('and a failed detection does not count as them having edited anything',
    mine.handEdited === false,
    'a stale flag would let an untouched outline through as corrected');
}

/* ------------------------------------------------- doing it and sending it */
{
  const { page, arrivedAt } = one;

  /*
   * NOTHING DRAWN YET. Refused in the browser rather than at the server, and
   * said in a way that names the next move -- somebody who presses send on an
   * empty map and gets a shrug presses it again.
   */
  await page.click('#btn-job-submit');
  await page.waitForTimeout(600);
  check('sending an empty map is refused, and says what to do about it',
    /no outline|draw the lawn/i.test(await page.textContent('#status')),
    await page.textContent('#status'));
  check('and the lawn is still theirs afterwards',
    (await job(page)).jobId !== null,
    'a refusal that dropped the claim would strand them');

  const drawn = await traceALawn(page);
  check('a worker with no automatic outline can still trace the lawn by hand',
    drawn.shapes > 0 && drawn.sqft > 0,
    `${drawn.shapes} shape(s), ${Math.round(drawn.sqft).toLocaleString()} sq ft`);

  /*
   * THE FLOOR, MET HONESTLY. A test does its work in seconds, so the first
   * send is refused for being too quick -- which is worth seeing rather than
   * working around: it is the refusal a genuinely fast worker on a small
   * garden will meet, and it has to teach rather than merely say no.
   */
  await page.click('#btn-job-submit');
  await page.waitForFunction(
    () => /second|another look/i.test(document.querySelector('#status')?.textContent || ''),
    { timeout: 20000 }
  );
  const rushed = await page.textContent('#status');
  check(`a map sent inside ${MIN_SECONDS} seconds is refused`,
    /second/i.test(rushed), rushed);
  check('and the refusal says what correcting actually means',
    /drive|edges/i.test(rushed),
    'a refusal that does not teach gets the same map back');

  /*
   * AND THEN WAITED OUT, RATHER THAN REACHED AROUND.
   *
   * The floor could be skipped by winding the claim back in the database, or
   * by a test-only route -- and a route that let a caller bypass the one check
   * standing between a farmed queue and the owner's money would be a hole in
   * production to make a test faster. Ninety seconds once per run is cheaper
   * than that, and this is the only place in the suite that waits at all.
   */
  const left = MIN_SECONDS * 1000 - (Date.now() - arrivedAt) + 3000;
  if (left > 0) {
    console.log(`      (waiting ${Math.ceil(left / 1000)}s for the ${MIN_SECONDS}s floor)`);
    await page.waitForTimeout(left);
  }

  await page.click('#btn-job-submit');
  await page.waitForFunction(() => window.__lmJob().code !== null, { timeout: 40000 });
  const done = await job(page);

  check('and a traced map, after real work, comes back with a completion code',
    typeof done.code === 'string' && done.code.trim().length >= 6,
    done.code);
  check('and the code is on screen to be copied, not buried in a status line',
    await page.locator('#job-code').isVisible(),
    'a code that is hard to copy is a task abandoned after the work was done');
  check('and they are offered another lawn rather than left at a dead end',
    await page.locator('#job-sheet-go').isVisible(),
    await page.textContent('#job-sheet-go'));
  check('and the lawn they finished is no longer theirs',
    done.jobId === null && !done.barVisible);

  /* And it really reached the corpus, by the ordinary road. */
  const stored = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/job?w=BROWSERTEST1`);
    return { status: res.status, body: await res.json() };
  }, BASE);
  check('and they are handed a different lawn next, not the one they just sent',
    stored.status !== 200 || stored.body.job?.id !== mine.jobId,
    stored.body?.job?.id || stored.body?.reason || String(stored.status));
}

/* --------------------------------------------------------------- skipping */
{
  /*
   * A skip must not leave somebody holding a lawn they cannot trace. A worker
   * blocked for an hour by one awkward property is a worker who closes the tab
   * -- and the lawn goes back for somebody else, because one person being
   * unable to see a boundary says nothing about the boundary.
   */
  const { page } = await arrive('?w=BROWSERTEST2');
  const theirs = await settled(page);
  check('a second worker is handed a lawn of their own',
    theirs.jobId && theirs.jobId !== mine.jobId,
    theirs.jobId || `a sheet instead: ${theirs.sheet}`);

  page.on('dialog', (d) => d.accept());
  await page.click('#btn-job-skip');
  /*
   * WAITED OUT TO THE SETTLED STATE, not just to the id changing. Skipping
   * clears the job and then goes looking for another, so there is a moment in
   * between with no lawn and no message -- and an assertion that fired on the
   * id alone caught the app mid-stride and called it stranded.
   */
  await page.waitForFunction(
    (was) => {
      const j = window.__lmJob();
      return j.jobId !== was && (j.barVisible || j.sheet !== null);
    },
    theirs.jobId,
    { timeout: 60000 }
  );
  const next = await job(page);
  check('and skipping hands them a different one rather than stranding them',
    next.jobId !== theirs.jobId && next.barVisible,
    next.jobId
      ? `${theirs.jobId.slice(0, 8)} -> ${next.jobId.slice(0, 8)}`
      : `a sheet instead: ${next.sheet}`);
}

/* ------------------------------------------------------------- volunteers */
{
  /*
   * ONE SHARED PUBLIC LINK, WITH NO ID IN IT. That is the whole point of the
   * volunteer route -- it gets posted somewhere -- which means the browser has
   * to mint a name, or everybody would share one identity and fight over a
   * single claim.
   *
   * No gates, no time floor, and no completion code: there is no platform to
   * paste one into and no transaction to prove. A timer on donated work can
   * only ever turn it away.
   */
  const { page } = await arrive('?via=volunteer');
  const got = await settled(page);

  check('a volunteer with no id in the link is still handed a lawn',
    got.barVisible && got.jobId && got.worker?.startsWith('helper-'),
    got.worker || `a sheet instead: ${got.sheet}`);

  await page.click('#coach-ok').catch(() => {});
  await page.click('#tab-draw');
  await page.waitForTimeout(250);
  const drawn = await traceALawn(page);
  check('and can trace it',
    drawn.shapes > 0 && drawn.sqft > 0,
    `${drawn.shapes} shape(s)`);

  /*
   * SENT IMMEDIATELY. This is the check that matters: the same submission from
   * a paid stranger would be refused for being inside the floor, and refusing
   * somebody's donated work is the one outcome with nothing to recommend it.
   */
  await page.click('#btn-job-submit');
  await page.waitForFunction(
    () => window.__lmJob().sheet !== null || /look/i.test(
      document.querySelector('#status')?.textContent || ''
    ),
    { timeout: 30000 }
  );
  const sent = await job(page);
  check('and send it straight away, with no floor to clear',
    sent.sheet !== null && sent.jobId === null,
    sent.sheet || await page.textContent('#status'));

  check('and is thanked with a count rather than a completion code',
    sent.code === null && /thank you/i.test(await page.textContent('#job-sheet-why')),
    await page.textContent('#job-sheet-why'));

  /*
   * AND THE NAME STICKS. A reload that minted a new one would lose their claim
   * every time a tab was closed, and would report eleven maps from one person
   * as eleven people.
   */
  const first = sent.worker;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lmJob !== undefined, { timeout: 30000 });
  await settled(page);
  check('and keeps the same name across a reload',
    (await job(page)).worker === first,
    `${first} -> ${(await job(page)).worker}`);
}

/* ------------------------------------------------------- the paid link */
{
  /*
   * THE ONE ROUTE THAT REFUSES TO START WITHOUT AN ACCOUNT, because it is the
   * only one where an id in a URL would be a claim on somebody's earnings.
   *
   * This is also the check that would have caught the original plan: the draft
   * post asked people to replace the word "volunteer" with their Venmo handle,
   * which starts no job mode at all -- `via` is read for a route name and the
   * app decides nobody asked for a lawn.
   */
  const { page } = await arrive('?via=paid', { withMail: true });
  const stopped = await settled(page);

  check('the paid link stops somebody who is not signed in',
    stopped.sheet !== null && /sign in/i.test(stopped.sheet),
    stopped.sheet || '(no sheet at all)');
  check('and claims no lawn for them',
    stopped.jobId === null && !stopped.barVisible,
    'an unpaid claim held for an hour helps nobody');

  const why = await page.textContent('#job-sheet-why');
  check('and says what the account is for, in terms of what it buys them',
    /pay|bounce/i.test(why),
    'an account demanded with no reason reads as a data grab');
  check('and points at the unpaid version rather than ending there',
    /volunteer/i.test(why),
    'somebody who will not sign in should still be able to help');
  check('and offers the way in rather than describing it',
    await page.locator('#job-sheet-go').isVisible(),
    await page.textContent('#job-sheet-go'));

  /*
   * AND THE BUTTON IS PRESSED, which is the check this section was missing.
   *
   * It confirmed the door had a handle and never turned it. Behind that
   * handle, the sign-in sheet was opening UNDERNEATH the job sheet -- both are
   * `.sheet`, both z-index 20, and the job sheet sits later in index.html, so
   * source order decided which one was on top. The address field was covered
   * and every tap landed on the job sheet, which has no close button by
   * design. The one route where signing in is not optional was the one route
   * where it could not be done.
   *
   * TYPED INTO, not just looked at. `isVisible` is true of an element with
   * something else painted over it, which is precisely the failure here.
   */
  await page.click('#job-sheet-go');
  await page.waitForTimeout(400);

  check('and pressing it actually reaches the sign-in panel',
    await page.locator('#signin').isVisible(),
    'the button opened nothing at all');

  let typed = null;
  try {
    await page.click('#signin-email', { timeout: 4000 });
    await page.type('#signin-email', 'tracer@example.com');
    typed = await page.inputValue('#signin-email');
  } catch (err) {
    typed = `blocked: ${String(err).split('\n')[0]}`;
  }
  check('and the address field can be tapped and typed into',
    typed === 'tracer@example.com',
    `${typed} -- a field with another sheet painted over it is still "visible"`);

  /*
   * AND A HANDLE TYPED INTO THE LINK IS NOT AN IDENTITY. The whole point of
   * moving the payment address out of the URL is that a query string is typed
   * by whoever is typing.
   */
  const { page: forged } = await arrive('?via=paid&w=%40dave-smith');
  const alsoStopped = await settled(forged);
  check('and a payment handle in the link is ignored entirely',
    alsoStopped.jobId === null && /sign in/i.test(alsoStopped.sheet || ''),
    alsoStopped.sheet || '(no sheet)');
}

for (const context of open) await context.close().catch(() => {});
await browser.close();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
