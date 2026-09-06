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

import { MODELS, DEFAULT_MODEL } from '../worker/src/sam.js';

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

/*
 * Every model the Worker can be asked for, not just the default.
 *
 * The one that breaks silently is the one nobody runs by accident: a person
 * who picks "Precise" once a week would be the only one to discover that its
 * field names had drifted, and they would discover it as a failed detection
 * they had already been charged for.
 */
let failures = 0;

for (const [id, model] of Object.entries(MODELS)) {
  const slug = model.slug;
  console.log(`\n=== ${id}: ${slug}`);

  const res = await fetch(`https://api.replicate.com/v1/models/${slug}`, { headers: auth });

  if (res.status === 404) {
    console.error(
      `FAIL  Replicate has no model called "${slug}" (404).\n` +
      '      It has most likely been renamed or withdrawn. To fix it:\n' +
      '        1. Run workflow 6 ("Find a promptable AI model") to see what exists\n' +
      `        2. Edit MODELS.${id}.slug in worker/src/sam.js\n` +
      '        3. Re-run this check\n' +
      (id === DEFAULT_MODEL
        ? '      Until this is fixed, detection fails for every visitor.\n'
        : `      Detection still works; only the "${model.label}" option is broken.\n`) +
      '      Drawing a lawn by hand always works.'
    );
    failures++;
    continue;
  }

  if (res.status === 401 || res.status === 403) {
    console.error(
      `FAIL  Replicate rejected the token (${res.status}).\n` +
      '      Generate a fresh one at https://replicate.com/account/api-tokens\n' +
      '      and update the REPLICATE_TOKEN repository secret.'
    );
    process.exit(1); // a bad token is not per-model; stop here
  }

  if (!res.ok) {
    console.error(`FAIL  Unexpected response from Replicate: ${res.status}`);
    console.error((await res.text()).slice(0, 400));
    failures++;
    continue;
  }

  const meta = await res.json();
  console.log(`PASS  "${slug}" exists and your token can see it.`);
  if (meta.description) console.log(`      ${meta.description.slice(0, 110)}`);
  if (meta.run_count !== undefined) {
    console.log(`      ${meta.run_count.toLocaleString()} runs to date`);
  }

  const version = meta.latest_version?.id;
  if (!version) {
    console.error(`FAIL  "${slug}" has no published version, so there is nothing to run.`);
    failures++;
    continue;
  }
  console.log(`PASS  It has a runnable version: ${version.slice(0, 16)}…`);

  const schema = meta.latest_version?.openapi_schema?.components?.schemas?.Input?.properties;
  if (!schema) {
    console.log('WARN  Could not read the input schema; skipping the field check.');
    continue;
  }

  const available = Object.keys(schema);
  console.log(`      accepts: ${available.join(', ')}`);

  const missing = model.fields.filter((f) => !available.includes(f));
  if (missing.length) {
    console.error(
      `FAIL  The Worker sends ${missing.length} field(s) this model does not accept: ` +
      `${missing.join(', ')}\n` +
      `      Fix MODELS.${id}.input() and .fields in worker/src/sam.js.`
    );
    failures++;
    continue;
  }

  console.log(`PASS  All ${model.fields.length} fields it is sent are accepted: ${model.fields.join(', ')}`);

  // A point-prompted model that stopped taking points would still pass the
  // field check above if its schema kept the name and changed nothing else,
  // but a model that lost the field entirely is caught here with a reason.
  if (model.needsPoints) {
    const pointish = available.filter((f) => /point|click|coord/i.test(f));
    console.log(pointish.length
      ? `PASS  It still takes point prompts: ${pointish.join(', ')}`
      : 'FAIL  It no longer publishes any point field, so pins cannot reach it.');
    if (!pointish.length) failures++;
  }
}

console.log('\nNote: this confirms the requests will be accepted. It does not run one --');
console.log('use workflow 5 for that, which costs a few cents.');
process.exit(failures === 0 ? 0 : 1);
