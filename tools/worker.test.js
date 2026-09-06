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
import { MODELS, DEFAULT_MODEL, DEFAULT_PROMPT } from '../worker/src/sam.js';
import { dayKey, DAILY_LIMIT_PER_CLIENT } from '../worker/src/quota.js';

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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
