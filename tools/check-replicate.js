/**
 * Confirms the Replicate model the Worker calls actually exists.
 *
 * The slug is read out of worker/src/index.js rather than hardcoded here, so
 * this checks the model the code really calls -- if someone edits the Worker,
 * this check follows them instead of quietly passing against a stale name.
 *
 * Needs network and a Replicate token, so it runs in CI, not on the machine
 * that wrote the code:
 *   REPLICATE_TOKEN=r8_... node tools/check-replicate.js
 */

import { readFile } from 'node:fs/promises';

const SOURCE = new URL('../worker/src/index.js', import.meta.url);

function extractSlug(source) {
  const m = source.match(
    /api\.replicate\.com\/v1\/models\/([A-Za-z0-9][\w.-]*\/[\w.-]+)\/predictions/
  );
  return m ? m[1] : null;
}

const token = process.env.REPLICATE_TOKEN;
if (!token) {
  console.error(
    'FAIL  No REPLICATE_TOKEN available.\n' +
    '      Add it as a repository secret named REPLICATE_TOKEN\n' +
    '      (Settings -> Secrets and variables -> Actions -> New repository secret).'
  );
  process.exit(1);
}

const slug = extractSlug(await readFile(SOURCE, 'utf8'));
if (!slug) {
  console.error(
    'FAIL  Could not find a Replicate model URL in worker/src/index.js.\n' +
    '      Expected something like https://api.replicate.com/v1/models/owner/name/predictions'
  );
  process.exit(1);
}

console.log(`Checking Replicate model: ${slug}`);

const res = await fetch(`https://api.replicate.com/v1/models/${slug}`, {
  headers: { Authorization: `Bearer ${token}` },
});

if (res.status === 200) {
  const body = await res.json().catch(() => ({}));
  console.log(`PASS  "${slug}" exists and your token can see it.`);
  if (body.latest_version?.id) {
    console.log(`      latest version: ${body.latest_version.id.slice(0, 12)}…`);
  }
  if (body.description) console.log(`      ${body.description.slice(0, 120)}`);
  process.exit(0);
}

if (res.status === 404) {
  console.error(
    `FAIL  Replicate has no model called "${slug}" (404).\n\n` +
    '      The model has most likely been renamed. To fix it:\n' +
    '        1. Search for "SAM 2" at https://replicate.com/explore\n' +
    '        2. Note the owner/name from the model page URL\n' +
    '        3. Edit worker/src/index.js on GitHub and replace\n' +
    `           "${slug}" with the new owner/name\n` +
    '        4. Re-run this check\n\n' +
    '      Until this is fixed, "Detect my lawn" will fail for every visitor.\n' +
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

console.error(`FAIL  Unexpected response from Replicate: ${res.status}`);
console.error((await res.text()).slice(0, 400));
process.exit(1);
