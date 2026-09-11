/**
 * /api/segment end to end, with Replicate stubbed out.
 *
 * worker.test.js checks the tables and mask.test.js checks the arithmetic.
 * Neither can see the WIRING between them -- whether four ticked boxes actually
 * become four predictions carrying four different prompts, whether each one
 * gets its own confidence cut rather than a flattened shared number, and
 * whether the response carries the fields the browser reads.
 *
 * That gap matters more than usual here, because the only other way to find out
 * is to spend four real predictions and read the bill. Every fetch to Replicate
 * is faked, so this costs nothing and runs offline.
 *
 *   node tools/segment.test.js
 */

import worker from '../worker/src/index.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/*
 * A stand-in Replicate that records the inputs it was handed.
 *
 * Recording the INPUT rather than counting calls is the point: "it ran four
 * times" would pass just as happily if all four asked the same question, which
 * is the bug this mode was rebuilt to avoid.
 */
const calls = [];
let nextStatus = 'succeeded';
let httpStatus = 200;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/v1/models/')) {
    return new Response(JSON.stringify({ latest_version: { id: 'v1' } }), { status: 200 });
  }
  if (u.includes('/v1/predictions')) {
    if (httpStatus !== 200) return new Response('nope', { status: httpStatus });
    calls.push(JSON.parse(init.body).input);
    return new Response(JSON.stringify({
      status: nextStatus,
      id: `pred-${calls.length}`,
      output: nextStatus === 'succeeded'
        ? `https://replicate.delivery/mask-${calls.length}.png`
        : null,
    }), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const env = { REPLICATE_TOKEN: 'test', MAPBOX_SERVER_TOKEN: 'sk.test' };
// No waitUntil work is asserted here; testlog.js owns that.
const ctx = { waitUntil() {} };

async function post(payload) {
  calls.length = 0;
  const res = await worker.fetch(new Request('https://example.test/api/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lng: -85.5, lat: 43.1, zoom: 19, size: 640, clientId: 'c1', ...payload }),
  }), env, ctx);
  return { status: res.status, body: await res.json(), sent: calls.slice() };
}

/* --------------------------------------------------------- find grass */
{
  const r = await post({ model: 'sam3' });
  check('find grass runs exactly one prediction', r.sent.length === 1, String(r.sent.length));
  check('asking the imagery source for its own wording', r.sent[0].prompt === 'grass');
  check('at the grass-inclusive cut', r.sent[0].threshold === 0.05);
  check('and it is not marked subtractive', r.body.subtractive === false);

  /*
   * The single-pass shape stays alongside the new one. A browser cached from
   * before `passes` existed would otherwise read `undefined` and fail on a
   * deploy that changed nothing it uses.
   */
  check('the old top-level mask field is still served',
    typeof r.body.mask === 'string', JSON.stringify(r.body).slice(0, 90));
}

/* ------------------------------------------------------ exclude, one box */
{
  const r = await post({ model: 'sam3_exclude', exclude: ['built'] });
  check('one ticked box is one prediction', r.sent.length === 1, String(r.sent.length));
  check('asking for the concept, not for grass', r.sent[0].prompt === 'man-made');
  check('at the cut that concept was measured at', r.sent[0].threshold === 0.05);
  check('the browser is told to subtract rather than trace', r.body.subtractive === true);
  check('and each pass names the box it came from',
    r.body.passes[0].exclusion === 'built', JSON.stringify(r.body.passes[0]));
}

/* --------------------------------------------------- exclude, every box */
{
  const r = await post({ model: 'sam3_exclude', exclude: ['built', 'trees', 'forest', 'water'] });
  check('four boxes are four predictions', r.sent.length === 4, String(r.sent.length));

  /*
   * FOUR DIFFERENT CONCEPTS, which is the whole reason for the rebuild. One
   * prompt repeated four times would cost the same and answer once.
   */
  check('each pass asks a different concept',
    new Set(r.sent.map((s) => s.prompt)).size === 4,
    r.sent.map((s) => s.prompt).join(' | '));

  /*
   * AND THEIR OWN CUTS. The two measured concepts disagree by a factor of
   * four: "trees" floods the whole frame at 0.05, where "man-made" reads well.
   * A shared threshold here would be invisible on screen and wrong on one of
   * them.
   */
  check('and carries its own confidence cut, not a shared one',
    new Set(r.sent.map((s) => s.threshold)).size > 1,
    r.sent.map((s) => `${s.prompt}@${s.threshold}`).join(' | '));

  check('every pass hands back a mask for the browser to subtract',
    r.body.passes.length === 4 && r.body.passes.every((p) => p.mask));
}

/* -------------------------------------------------------- nothing ticked */
/*
 * Refused BEFORE the allowance is touched and before anything is run. The
 * answer to "remove nothing from the lot" is the lot, which the app already
 * knows for free from the property line -- charging a prediction to rediscover
 * it would be spending money on a question nobody asked.
 */
{
  const r = await post({ model: 'sam3_exclude', exclude: [] });
  check('an empty tick list spends nothing', r.sent.length === 0);
  check('and is refused with a sentence, not a silent default',
    r.status === 400 && /Tick at least one/.test(r.body.error), JSON.stringify(r.body));
}

/* ------------------------------------------------------------ the old id */
/*
 * A browser cached from before the rename must not be handed the OPPOSITE
 * question. Falling through to the default would answer "find grass" to a
 * request for subtraction, confidently, with nothing on screen saying so.
 */
{
  const r = await post({ model: 'sam3_subtract', exclude: ['trees'] });
  check('the retired id still resolves to the mode that replaced it',
    r.body.model === 'sam3_exclude' && r.body.subtractive === true, r.body.model);
  check('and it asks for trees rather than grass', r.sent[0].prompt === 'trees');
}

/* ---------------------------------------------------- the developer panel */
/*
 * A typed prompt REPLACES the boxes rather than joining them. Joining would put
 * a surprising mask beyond attribution -- which of five things produced it? --
 * on the one path whose entire job is to be readable.
 */
{
  const r = await post({ model: 'sam3_exclude', exclude: ['built', 'trees'], prompt: 'shrubs' });
  check('a typed prompt replaces the ticked boxes', r.sent.length === 1, String(r.sent.length));
  check('and sends exactly what was typed', r.sent[0].prompt === 'shrubs');
}

/* An over-long prompt errors at the encoder rather than answering badly, so it
 * must be refused before it costs a prediction and an allowance slot. */
{
  const r = await post({
    model: 'sam3_exclude',
    // 33 words plus commas: comfortably over the encoder's 32, which is where
    // it stops answering rather than answering badly.
    prompt: 'house, driveway, pool, deck, patio, shed, fence, garage, road, path, '
      + 'wall, pond, hedge, bed, border, tree, shrub, lawn, grass, turf, gravel, '
      + 'tarmac, concrete, brick, stone, mulch, bark, water, roof, wood, dirt, sand, kerb',
  });
  check('an over-long typed prompt is refused before it is paid for',
    r.status === 400 && r.sent.length === 0, `${r.status}: ${r.body.error}`);
}

/* -------------------------------------------------- the developer allowance */
/*
 * The flag has to reach the quota, not just exist in the body. Checked through
 * the real endpoint with a real KV stand-in, because the wiring is where it
 * would silently do nothing: the Worker would still answer, still detect, and
 * still refuse at twenty, with the badge cheerfully saying fifty.
 */
{
  const store = new Map();
  const kvEnv = {
    ...env,
    QUOTA: {
      async put(k, v) { store.set(k, v); },
      async get(k) { return store.get(k) ?? null; },
    },
  };
  const spend = async (n, dev) => {
    const res = await worker.fetch(new Request('https://example.test/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lng: -85.5, lat: 43.1, zoom: 19, size: 640, clientId: 'tinkerer',
        model: 'sam3_exclude', exclude: ['built', 'trees'], dev,
      }),
    }), kvEnv, ctx);
    return { status: res.status, body: await res.json() };
  };

  // Two passes a press, so eleven presses is 22 -- past the ordinary 20.
  let last;
  for (let i = 0; i < 11; i++) last = await spend(2, true);
  check('developer mode keeps going past the ordinary cap',
    last.status === 200, `${last.status}: ${JSON.stringify(last.body).slice(0, 90)}`);
  check('and the response reports the raised ceiling',
    last.body.remaining === 200 - 22, `remaining ${last.body.remaining}`);

  /* The same counter, so dropping the flag hits the ordinary line at once. */
  const plain = await spend(2, false);
  check('and dropping the flag falls straight back to the ordinary ceiling',
    plain.status === 429 && plain.body.limit === 20,
    `${plain.status}: ${JSON.stringify(plain.body)}`);
}

/* ------------------------------------------------------- unknown concepts */
{
  const r = await post({ model: 'sam3_exclude', exclude: ['built', 'unicorns'] });
  check('an unknown box is dropped and the rest still runs',
    r.sent.length === 1 && r.sent[0].prompt === 'man-made',
    'a stale cached browser should lose a box, not lose the detection');
}

/* ------------------------------------------------------- a cold model */
/*
 * `Prefer: wait` gives up after about a minute and a cold model takes several,
 * so some passes come back with an id and no mask. The client polls them; what
 * matters here is that the ids all arrive, because a pass whose id was dropped
 * is a prediction that has been paid for and can never be collected.
 */
{
  nextStatus = 'starting';
  const r = await post({ model: 'sam3_exclude', exclude: ['built', 'trees'] });
  check('a pending detection answers 202', r.status === 202, String(r.status));
  check('with an id for every pass, so none is paid for and lost',
    r.body.passes.length === 2 && r.body.passes.every((p) => p.id),
    JSON.stringify(r.body.passes));
  nextStatus = 'succeeded';
}

/* ------------------------------------------------------ a refused pass */
/*
 * ONE REFUSED PASS FAILS THE WHOLE DETECTION. Carrying on with the rest would
 * produce a measurement with an exclusion missing -- not a smaller answer, a
 * wrong one, with the trees left counted as lawn and nothing saying so.
 */
{
  httpStatus = 429;
  const r = await post({ model: 'sam3_exclude', exclude: ['built', 'trees'] });
  check('a rate-limited pass fails the detection rather than half-running it',
    r.status === 429 && r.body.rateLimited === true, JSON.stringify(r.body).slice(0, 120));
  check('and the message says what to do about it with several boxes ticked',
    /untick/i.test(r.body.error), r.body.error);
  httpStatus = 200;
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
