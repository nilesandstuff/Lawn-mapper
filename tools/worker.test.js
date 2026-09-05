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
import { SAM_MODEL, SAM_INPUT_FIELDS, samInput, DEFAULT_PROMPT } from '../worker/src/sam.js';

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

/* The preflight check validates SAM_INPUT_FIELDS against the model's schema,
 * so it is only meaningful if it really matches what gets sent. */
const sent = Object.keys(samInput('https://example.com/x.png', DEFAULT_PROMPT));
check('the declared input fields are exactly what samInput sends',
  sent.length === SAM_INPUT_FIELDS.length && sent.every((f) => SAM_INPUT_FIELDS.includes(f)),
  `sends: ${sent.join(', ')}\n      declared: ${SAM_INPUT_FIELDS.join(', ')}`);

check('the model is named', typeof SAM_MODEL === 'string' && SAM_MODEL.includes('/'), SAM_MODEL);
check('there is a default prompt', !!DEFAULT_PROMPT, JSON.stringify(DEFAULT_PROMPT));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
