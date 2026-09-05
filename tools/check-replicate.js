/**
 * Confirms the Worker can actually run the segmentation model.
 *
 * The previous version only checked the model *existed*, and passed happily
 * while every real detection failed: Replicate's per-model endpoint,
 * /v1/models/{owner}/{name}/predictions, exists only for official models and
 * 404s for everything else. A green tick that does not mean the thing works is
 * worse than no check, so this now verifies what the Worker depends on:
 *
 *   1. the model exists and this token can see it
 *   2. it has a published version id -- what /v1/predictions needs
 *   3. the input fields the Worker sends all appear in that version's schema
 *
 * Free: it reads metadata and never starts a prediction.
 *
 *   REPLICATE_TOKEN=r8_... node tools/check-replicate.js
 */

import { SAM_MODEL, SAM_INPUT_FIELDS } from '../worker/src/index.js';

const token = process.env.REPLICATE_TOKEN;
if (!token) {
  console.error(
    'FAIL  No REPLICATE_TOKEN available.\n' +
    '      Add it as a repository secret named REPLICATE_TOKEN\n' +
    '      (Settings -> Secrets and variables -> Actions -> New repository secret).'
  );
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };
console.log(`Checking Replicate model: ${SAM_MODEL}`);

const res = await fetch(`https://api.replicate.com/v1/models/${SAM_MODEL}`, { headers: auth });

if (res.status === 404) {
  console.error(
    `FAIL  Replicate has no model called "${SAM_MODEL}" (404).\n\n` +
    '      It has most likely been renamed. To fix it:\n' +
    '        1. Search for "SAM 2" at https://replicate.com/explore\n' +
    '        2. Note the owner/name from the model page URL\n' +
    '        3. Edit worker/src/index.js on GitHub and change SAM_MODEL\n' +
    '        4. Re-run this check\n\n' +
    '      Until this is fixed, "Detect my lawn" fails for every visitor.\n' +
    '      Drawing a lawn by hand still works.'
  );
  process.exit(1);
}

if (res.status === 401 || res.status === 403) {
  console.error(
    `FAIL  Replicate rejected the token (${res.status}).\n` +
    '      Generate a fresh one at https://replicate.com/account/api-tokens\n' +
    '      and update the REPLICATE_TOKEN repository secret.'
  );
  process.exit(1);
}

if (!res.ok) {
  console.error(`FAIL  Unexpected response from Replicate: ${res.status}`);
  console.error((await res.text()).slice(0, 400));
  process.exit(1);
}

const model = await res.json();
console.log(`PASS  "${SAM_MODEL}" exists and your token can see it.`);
if (model.description) console.log(`      ${model.description.slice(0, 110)}`);

/* ------------------------------------------------- a runnable version id */
const version = model.latest_version?.id;
if (!version) {
  console.error(
    `\nFAIL  "${SAM_MODEL}" has no published version, so there is nothing to run.\n` +
    '      Pick a different SAM 2 model at https://replicate.com/explore and\n' +
    '      change SAM_MODEL in worker/src/index.js.'
  );
  process.exit(1);
}
console.log(`PASS  It has a runnable version: ${version.slice(0, 16)}…`);

/* ------------------------------------------- the fields the Worker sends */
const schema =
  model.latest_version?.openapi_schema?.components?.schemas?.Input?.properties;

if (!schema) {
  console.log('WARN  Could not read the input schema; skipping the field check.');
  console.log('      This is not fatal, but a wrong field name would only show up');
  console.log('      as a failed detection.');
  process.exit(0);
}

const available = Object.keys(schema);
console.log(`\nInput fields this model accepts:\n      ${available.join(', ')}`);

const missing = SAM_INPUT_FIELDS.filter((f) => !available.includes(f));
if (missing.length) {
  console.error(
    `\nFAIL  The Worker sends ${missing.length} field(s) this model does not accept: ` +
    `${missing.join(', ')}\n` +
    '      Edit the input object in worker/src/index.js to use the names listed\n' +
    '      above, and update SAM_INPUT_FIELDS to match.'
  );
  process.exit(1);
}

console.log(`\nPASS  All ${SAM_INPUT_FIELDS.length} fields the Worker sends are accepted: ` +
  SAM_INPUT_FIELDS.join(', '));
console.log('\nNote: this confirms the request will be accepted. It does not run one --');
console.log('use workflow 5 for that, which costs a few cents.');
