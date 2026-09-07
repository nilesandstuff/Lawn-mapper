/**
 * Guards the shape of the Worker entrypoint.
 *
 * A Workers entrypoint may only export handlers. Exporting a plain constant
 * from it -- which is an entirely reasonable-looking thing to do, and which
 * every other tool in this repo accepts happily -- kills the isolate the
 * moment it starts:
 *
 *   Incorrect type for map entry 'SAM_MODEL': the provided value is not of
 *   type 'function or ExportedHandler'
 *
 * That takes the whole site down, not just the endpoint the constant belonged
 * to, and nothing else in the test suite would notice: the module imports
 * fine, the bundle builds fine, and `wrangler deploy` reports success. Only
 * starting the runtime reveals it.
 *
 *   node tools/worker.test.js
 */

import * as entrypoint from '../worker/src/index.js';
import {
  MODELS, DEFAULT_MODEL, DEFAULT_PROMPT, modelCatalogue, DEFAULT_THRESHOLD, samThreshold,
} from '../worker/src/sam.js';
import { dayKey, DAILY_LIMIT_PER_CLIENT } from '../worker/src/quota.js';
import { upstreamReason, redactSecrets } from '../worker/src/upstream.js';
import {
  providerCatalogue, providerFrame, detectionImageUrl,
} from '../worker/src/imagery.js';
import { worldSize } from '../public/lib/mercator.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const exported = Object.keys(entrypoint);
check('the entrypoint exports only a default handler',
  exported.length === 1 && exported[0] === 'default',
  `exports: ${exported.join(', ') || '(none)'}`);

check('the default export has a fetch handler',
  typeof entrypoint.default?.fetch === 'function');

/*
 * The preflight check validates each model's declared fields against that
 * model's published schema, so it is only meaningful if the declaration really
 * matches what gets sent. Every model, not just the default: the one that is
 * easy to get wrong is the one nobody runs by accident.
 */
for (const [id, model] of Object.entries(MODELS)) {
  const sent = Object.keys(model.input('https://example.com/x.png', {
    prompt: DEFAULT_PROMPT, threshold: 0.1, points: [[10, 20]],
  }));
  check(`${id}: declared input fields are exactly what it sends`,
    sent.length === model.fields.length && sent.every((f) => model.fields.includes(f)),
    `sends: ${sent.join(', ')}\n      declared: ${model.fields.join(', ')}`);

  check(`${id}: is named`,
    typeof model.slug === 'string' && model.slug.includes('/'), model.slug);
  check(`${id}: is offered to the user`, !!model.label && !!model.note);
}

check('the default model exists', !!MODELS[DEFAULT_MODEL], DEFAULT_MODEL);
check('the default model needs no pins',
  MODELS[DEFAULT_MODEL].needsPoints === false,
  'a first-time user should not have to tap anything to get a measurement');
check('there is a default prompt', !!DEFAULT_PROMPT, JSON.stringify(DEFAULT_PROMPT));


/* ------------------------------------------------------------ the quota day */
/*
 * "It does not seem to be resetting" was a real observation about a real
 * boundary. The count was keyed on the UTC date, which turns over at 7 or 8 in
 * the evening in Michigan -- so an allowance spent after dinner was already on
 * tomorrow's tally, and one spent at lunch came back the same evening. Neither
 * matches the day a person is having, which is what makes it read as broken.
 *
 * Asserted at the boundary rather than "today", because a test that asks what
 * day it is right now passes for twenty of every twenty-four hours regardless
 * of which timezone the code uses.
 */
const eveningBefore = new Date('2026-07-01T02:00:00Z'); // 22:00 Jun 30, EDT
const afterMidnight = new Date('2026-07-01T05:00:00Z'); // 01:00 Jul 1,  EDT

check('an evening measurement counts against that evening, not tomorrow',
  dayKey(eveningBefore) === '2026-06-30',
  `UTC would say ${eveningBefore.toISOString().slice(0, 10)}; dayKey says ${dayKey(eveningBefore)}`);

check('and the count rolls over at local midnight',
  dayKey(afterMidnight) === '2026-07-01', dayKey(afterMidnight));

check('the two really are different days (the boundary is being crossed)',
  dayKey(eveningBefore) !== dayKey(afterMidnight));

/* Winter, when the offset is UTC-5 rather than UTC-4. */
check('and it still holds when daylight saving is off',
  dayKey(new Date('2026-01-15T04:00:00Z')) === '2026-01-14',
  dayKey(new Date('2026-01-15T04:00:00Z')));

check('the daily allowance is 20', DAILY_LIMIT_PER_CLIENT === 20,
  String(DAILY_LIMIT_PER_CLIENT));


/* ------------------------------------------------------- the Google frame */
/*
 * Two conversions, either of which is silently catastrophic.
 *
 * TILE SCALE. Google is a 256-pixel tile scheme and Mapbox is 512, so the same
 * ground scale is Google zoom = Mapbox zoom + 1. Off by one here is a factor
 * of two in every distance and four in every area, and the picture still looks
 * like a house from above.
 *
 * INTEGER ZOOM. Google floors fractional zoom. Our frames are fractional, so
 * the frame is rebuilt at a zoom Google can serve -- downward, so a parcel
 * that fitted before still fits.
 */
{
  const frame = { lng: -85.8637, lat: 42.8703, zoom: 19.66, size: 640 };

  check('an ordinary source gets the frame untouched',
    providerFrame('mapbox', frame).zoom === 19.66);

  const g = providerFrame('google', frame);
  check('Google gets an integer zoom', Number.isInteger(g.zoom), String(g.zoom));
  check('and it is floored, never rounded up',
    g.zoom === 19, `${g.zoom} — rounding up could crop a deep lot`);
  check('the frame is otherwise identical',
    g.lng === frame.lng && g.lat === frame.lat && g.size === frame.size);

  const url = new URL(detectionImageUrl('google', g, 'MB', { GOOGLE_MAPS_KEY: 'K' }));
  const googleZoom = Number(url.searchParams.get('zoom'));
  check('the URL asks Google for one zoom level in, for its 256px tiles',
    googleZoom === g.zoom + 1, `frame z${g.zoom} -> Google z${googleZoom}`);

  /*
   * The check that would actually catch a factor-of-four: the two schemes must
   * describe the same world size at their respective zooms.
   */
  const GOOGLE_TILE = 256;
  check('and that really is the same ground scale',
    worldSize(g.zoom) === GOOGLE_TILE * 2 ** googleZoom,
    `${worldSize(g.zoom)} px vs ${GOOGLE_TILE * 2 ** googleZoom} px across the world`);

  check('Google is asked at a size that returns 1280 px, like Mapbox @2x',
    url.searchParams.get('size') === '640x640' && url.searchParams.get('scale') === '2');

  check('and the key never appears in the catalogue sent to the browser',
    !JSON.stringify(providerCatalogue({ GOOGLE_MAPS_KEY: 'SECRET' })).includes('SECRET'));

  check('Google is hidden entirely when no key is configured',
    !providerCatalogue({}).some((p) => p.id === 'google'));
  check('and offered when there is one',
    providerCatalogue({ GOOGLE_MAPS_KEY: 'K' }).some((p) => p.id === 'google'));

}

/* ------------------------------------------------------- the threshold */
/*
 * The confidence cut is the single number that decides how much shaded grass
 * gets counted, and it was lowered from 0.1 to 0.05 on measured evidence at a
 * lot with a known answer. Asserting the constant equals itself would prove
 * nothing, so this tests the function that decides what is actually SENT --
 * including the override, which is how the value gets retuned without a
 * deploy, and the clamp, which is what stops a typo'd variable being passed
 * to the model as a threshold it will reject.
 */
check('with nothing configured, the measured default is what gets sent',
  samThreshold({}) === DEFAULT_THRESHOLD, String(samThreshold({})));

check('and the default is the one the evidence chose',
  DEFAULT_THRESHOLD === 0.05,
  '0.05 recovered 7,666 sq ft of shaded lawn at Brooks Lane and then plateaued');

check('an override wins, so it can be retuned without a deploy',
  samThreshold({ SAM_THRESHOLD: '0.2' }) === 0.2);

check('a nonsense override falls back rather than being sent',
  samThreshold({ SAM_THRESHOLD: 'wide open' }) === DEFAULT_THRESHOLD);

check('and an out-of-range one is clamped to what the model accepts',
  samThreshold({ SAM_THRESHOLD: '9' }) === 1 && samThreshold({ SAM_THRESHOLD: '-3' }) === 0);


/* ------------------------------------------------- passing an error along */
/*
 * When a source refuses us, the browser is now shown what it said -- which is
 * the difference between "no photograph of this spot" (wrong, and sends you
 * hunting for a coverage problem) and Google's own "This API project is not
 * authorized to use this API" (the answer, in one sentence).
 *
 * That text comes from outside and goes to a browser, and the URL it is about
 * has our key in it. So the redaction is the part under test: an upstream that
 * echoes the request back in its error would otherwise hand out the key.
 */
{
  const echoed =
    'Request failed: https://maps.googleapis.com/maps/api/staticmap?center=1,2&key=AIzaSECRETVALUE123&size=640x640';
  const clean = redactSecrets(echoed);

  check('an echoed key is redacted out of an upstream error',
    !clean.includes('AIzaSECRETVALUE123'), clean);
  check('and the parameter name survives, so the message still reads',
    clean.includes('key=REDACTED'), clean);

  check('a Mapbox token is redacted too, by its own parameter name',
    !redactSecrets('...&access_token=pk.eyJ1SECRET&x=1').includes('pk.eyJ1SECRET'),
    redactSecrets('...&access_token=pk.eyJ1SECRET&x=1'));

  check('ordinary words are left alone',
    redactSecrets('The provided API key is invalid.') === 'The provided API key is invalid.');

  /*
   * The real shape of the failure being diagnosed, start to finish: Google
   * answers 403 with a plain sentence, and that sentence has to arrive intact.
   */
  const refusal = new Response(
    'The Google Maps Platform server rejected your request. This API project is not authorized to use this API.',
    { status: 403, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } }
  );
  check('a plain-text refusal is passed through in full',
    /not authorized to use this API/.test(await upstreamReason(refusal)));

  /* An error delivered as an image has nothing readable in it; say nothing. */
  const imageErr = new Response('\x89PNG\r\n', {
    status: 500, headers: { 'Content-Type': 'image/png' },
  });
  check('a binary error body is not paraphrased into the status line',
    (await upstreamReason(imageErr)) === null);

  const huge = new Response('x'.repeat(50000), {
    status: 500, headers: { 'Content-Type': 'text/html' },
  });
  check('and a giant error page is cut down, not pasted into the UI',
    (await upstreamReason(huge)).length <= 400);
}

/*
 * The point-prompted model is gone, and this is the check that says so.
 *
 * The first version of it read `!PROVIDERS.sam2` -- PROVIDERS is the imagery
 * table, which never had a key by that name, so it passed without ever looking
 * at the model list. It would have gone on passing if the model had been left
 * in. Assert against MODELS, which is where the thing being removed actually
 * lived, and against the catalogue the browser is handed.
 */
check('the point-prompted model is gone from the model table', !MODELS.sam2,
  Object.keys(MODELS).join(', '));
check('and is not offered to the browser',
  !modelCatalogue().some((m) => m.id === 'sam2'),
  modelCatalogue().map((m) => m.id).join(', '));
check('every remaining model works without pins',
  Object.values(MODELS).every((m) => m.needsPoints === false),
  'nothing left needs a pin, so the pin UI is dormant rather than broken');

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
