/**
 * "Trained model (alpha release)": the Worker's half, and loop 2's scorer.
 *
 *   node tools/alpha.test.js
 */
import assert from 'node:assert/strict';

import { alphaEnabled, resultUrl, isAlphaId, pollAlpha, alphaMaskResponse } from '../worker/src/alpha.js';
import { MODELS, modelCatalogue, defaultModelFor, normaliseModel } from '../worker/src/sam.js';
import { updateFor, keyForFips, lotFrames } from './score-queue.js';
import { frameFor } from '../public/lib/mercator.js';
import { captureFrame } from '../worker/src/imagery.js';

const on = { ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run', ALPHA_TOKEN: 't', CORPUS: {} };

/* Off unless all three are there; hidden and not the default when off. */
assert.equal(alphaEnabled({}), false);
assert.equal(alphaEnabled({ ...on, CORPUS: null }), false);
assert.equal(alphaEnabled(on), true);
assert.ok(!modelCatalogue({}).some((m) => m.id === 'alpha'), 'hidden without a release');
assert.ok(!modelCatalogue().some((m) => m.id === 'alpha'), 'hidden when nobody says');
const listed = modelCatalogue(on);
assert.equal(listed[0].id, 'alpha', 'first in the picker where it is served');
assert.equal(listed[0].label, 'Turf Trace - alpha version 2 (79% accuracy)');
assert.equal(listed[0].fixedPolarity, true);
assert.equal(listed.find((m) => m.id === 'sam3').fixedPolarity, false);
assert.equal(defaultModelFor(on), 'alpha');
assert.equal(defaultModelFor({}), 'sam3');
assert.equal(normaliseModel('alpha'), 'alpha');
assert.ok(MODELS.alpha.modal && !MODELS.alpha.slug && !MODELS.alpha.input, 'no Replicate machinery');

/* The result endpoint sits beside the start one. */
assert.equal(resultUrl(on), 'https://ws--lawn-mapper-alpha-result.modal.run');
assert.equal(resultUrl({ ...on, ALPHA_RESULT_URL: 'https://x-result.modal.run' }), 'https://x-result.modal.run');

/* Ids: ours are prefixed; Replicate's are not; nothing odd gets through. */
assert.ok(isAlphaId('alpha-fc-01K6ABCDEF'));
assert.ok(!isAlphaId('abc123def'));
assert.ok(!isAlphaId('alpha-../../etc'));

/* A finished lot goes to R2 and comes back as this Worker's URL. */
{
  const put = [];
  const env = { ...on, CORPUS: { put: async (k, v) => put.push([k, v]) } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://ws--lawn-mapper-alpha-result.modal.run?id=fc-1234567'));
    assert.equal(init.headers.authorization, 'Bearer t');
    return new Response(JSON.stringify({ status: 'succeeded', mask: Buffer.from('png!').toString('base64'), version: 'v1', uncertainty: 0.25 }));
  };
  const got = await pollAlpha(env, 'alpha-fc-1234567', 'https://lawn.example');
  assert.equal(got.status, 'succeeded');
  assert.equal(got.mask, 'https://lawn.example/api/alpha-mask?id=alpha-fc-1234567');
  assert.equal(got.version, 'v1');
  assert.equal(put[0][0], 'alpha/masks/fc-1234567.png');
  assert.equal(Buffer.from(put[0][1]).toString(), 'png!');
  assert.equal(got.raw, null, 'no raw picture when the release did not send one');

  /* With the decoder's own picture: kept beside the mask, served with raw=1. */
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'succeeded',
    mask: Buffer.from('png!').toString('base64'), prob: Buffer.from('prob!').toString('base64'), version: 'v1' }));
  const withRaw = await pollAlpha(env, 'alpha-fc-1234567', 'https://lawn.example');
  assert.equal(withRaw.raw, 'https://lawn.example/api/alpha-mask?id=alpha-fc-1234567&raw=1');
  assert.equal(put[2][0], 'alpha/masks/fc-1234567-raw.png');
  assert.equal(Buffer.from(put[2][1]).toString(), 'prob!');

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'running' }));
  assert.equal((await pollAlpha(env, 'alpha-fc-1234567', 'x')).status, 'processing');
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'failed', error: 'no photo' }));
  const bad = await pollAlpha(env, 'alpha-fc-1234567', 'x');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.detail, 'no photo');
  globalThis.fetch = real;
}

/* The mask route answers only for our ids. */
{
  const env = { CORPUS: { get: async (k) => (k === 'alpha/masks/fc-1234567.png' ? { body: 'x' } : null) } };
  assert.equal((await alphaMaskResponse(env, 'alpha-fc-1234567')).status, 200);
  assert.equal((await alphaMaskResponse(env, 'alpha-fc-7654321')).status, 404);
  assert.equal((await alphaMaskResponse(env, '../secret')).status, 404);
  const rawEnv = { CORPUS: { get: async (k) => (k === 'alpha/masks/fc-1234567-raw.png' ? { body: 'r' } : null) } };
  assert.equal((await alphaMaskResponse(rawEnv, 'alpha-fc-1234567', {}, { raw: true })).status, 200);
  assert.equal((await alphaMaskResponse(rawEnv, 'alpha-fc-1234567')).status, 404, 'raw only when asked');
}

/* Loop 2: a lot is framed as the app frames it; scores reach SQL only when well formed. */
{
  const d = 0.0003;
  const parcel = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-85.67 - d, 42.96 - d], [-85.67 + d, 42.96 - d], [-85.67 + d, 42.96 + d], [-85.67 - d, 42.96 - d]]] } };
  const { display, shot } = lotFrames(parcel);
  assert.deepEqual(display, frameFor([-85.67 - d, 42.96 - d, -85.67 + d, 42.96 + d], 640, { marginM: 10 }));
  assert.deepEqual(shot, captureFrame(display));

  const now = '2026-09-29T20:00:00.000Z';
  const sql = updateFor({ id: '0b7c2f5e-1111-2222-3333-444455556666', uncertainty: 0.31234, version: '2026-09-29T19:00:00Z' }, now);
  assert.equal(sql, "UPDATE lawn_jobs SET uncertainty = 0.3123, scored_model = '2026-09-29T19:00:00Z', "
    + "scored_at = '2026-09-29T20:00:00.000Z' WHERE id = '0b7c2f5e-1111-2222-3333-444455556666'");
  assert.equal(updateFor({ id: "x'; DROP TABLE lawn_jobs; --", uncertainty: 0.5 }, now), null);
  assert.equal(updateFor({ id: '0b7c2f5e-1111', uncertainty: 2 }, now), null);
  assert.match(updateFor({ id: '0b7c2f5e-1111', uncertainty: 0.1, version: "'; --" }, now), /scored_model = NULL/);
  assert.equal(keyForFips('no-such-fips'), null);
}

console.log('alpha: ok');
