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
import { EXCLUSIONS, parcelBox, parcelBoxWanted } from '../worker/src/sam.js';
import { DAILY_LIMIT_PER_CLIENT } from '../worker/src/quota.js';

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

/*
 * What the land cover service says when it is asked whether it reaches an
 * address. A class number means yes; the literal string "NoData" is what it
 * really returns outside its footprint, and is what sends a press to the AI.
 */
let landcoverValue = '28';

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('cicgis.org') || u.includes('/ImageServer/identify')) {
    return new Response(JSON.stringify({ value: landcoverValue }), { status: 200 });
  }
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

/*
 * A worker whose log is switched on and readable, for the refusal checks.
 *
 * The log used to sit AFTER the Replicate call, so the two failures most worth
 * debugging -- our allowance refusing a press, and the detector refusing us --
 * were the only outcomes it never recorded. "It says I have used today's
 * detections and I have not" was reported, and the log had nothing to say,
 * because a refused detection left no trace at all.
 */
function loggingEnv() {
  const store = new Map();
  return {
    ...env,
    LOG_TESTS: '1',
    LOG_TOKEN: 'sekret',
    QUOTA: {
      store,
      async put(k, v) { store.set(k, v); },
      async get(k) { return store.get(k) ?? null; },
      async list({ prefix, limit }) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: true };
      },
    },
  };
}

async function post(payload) {
  calls.length = 0;
  const res = await worker.fetch(new Request('https://example.test/api/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lng: -85.5, lat: 43.1, zoom: 19, size: 640, clientId: 'c1', ...payload }),
  }), env, ctx);
  return { status: res.status, body: await res.json(), sent: calls.slice() };
}

/* ------------------------------------------------------- the land cover map */
/*
 * The free method, and the substitution it makes when its raster stops.
 *
 * THE BUG THIS EXISTS FOR was found by curling the deployed endpoint, not
 * here: the Worker worked out that it had fallen back to the AI and then did
 * not put that in the response, so the browser's sentence about it could never
 * fire. A press somebody chose for being free silently cost a detection. Every
 * assertion below is about what the browser is TOLD, because that was the half
 * that was missing while everything else worked.
 */
{
  landcoverValue = '28';
  const r = await post({ model: 'landcover' });

  check('the land cover method runs no predictions at all',
    r.sent.length === 0, `${r.sent.length} prediction(s) — it should cost nothing`);
  check('and says so, so the browser can stop claiming a cost',
    r.body.free === true, JSON.stringify(r.body).slice(0, 100));
  check('it answers with a ready mask rather than something to poll',
    r.body.passes?.length === 1 && r.body.passes[0].status === 'succeeded',
    JSON.stringify(r.body.passes));
  check('from the land cover service',
    String(r.body.passes?.[0]?.mask || '').includes('cicgis.org'),
    String(r.body.passes?.[0]?.mask || '').slice(0, 60));
  check('it is traced, not subtracted', r.body.subtractive === false);
  check('and nothing claims a substitution happened',
    r.body.fellBack === undefined, JSON.stringify(r.body.fellBack));

  /*
   * A frame is not optional: the browser unprojects the mask against whatever
   * comes back here, so a missing one puts a lawn-shaped outline over the
   * wrong ground rather than failing.
   */
  check('the frame the mask was cut to comes back with it',
    Number.isFinite(r.body.frame?.lng) && Number.isFinite(r.body.frame?.lat),
    JSON.stringify(r.body.frame));
}

{
  landcoverValue = 'NoData';
  const r = await post({ model: 'landcover' });

  check('outside the raster the press falls through to the AI',
    r.sent.length === 1 && r.sent[0].prompt === 'grass',
    JSON.stringify(r.sent).slice(0, 80));
  check('AND SAYS SO — the whole point of the fallback',
    r.body.fellBack === 'landcover', JSON.stringify(r.body.fellBack));
  check('it is no longer claiming to be free, because it is not',
    !r.body.free, JSON.stringify(r.body.free));
  check('and the mask really is the AI\'s',
    String(r.body.passes?.[0]?.mask || '').includes('replicate.delivery'),
    String(r.body.passes?.[0]?.mask || '').slice(0, 60));

  landcoverValue = '28';
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
/*
 * Driven off the real table rather than a hard-coded list of ids, so removing
 * a box (as "trees" and "forest" were, collapsed into one) cannot leave this
 * asserting a count the product no longer has.
 */
{
  const every = Object.keys(EXCLUSIONS);
  const r = await post({ model: 'sam3_exclude', exclude: every });
  check('every box is its own prediction', r.sent.length === every.length,
    `${r.sent.length} for ${every.length} boxes`);

  /*
   * A DIFFERENT CONCEPT EACH, which is the whole reason for the rebuild. One
   * prompt repeated would cost the same and answer once.
   */
  check('each pass asks a different concept',
    new Set(r.sent.map((s) => s.prompt)).size === every.length,
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

  /*
   * AND THE CUT IS THE ONE IN THE TABLE, box by box. The check above only says
   * they differ from each other, which a shared-but-shuffled bug would also
   * satisfy. This says each concept arrived at the number it was measured at,
   * however many boxes were ticked alongside it.
   */
  const sentFor = (p) => r.sent.find((s) => s.prompt === p)?.threshold;
  for (const [id, e] of Object.entries(EXCLUSIONS)) {
    check(`"${id}" is sent at its own ${e.threshold}, alongside every other box`,
      sentFor(e.prompt) === e.threshold, String(sentFor(e.prompt)));
  }

  check('every pass hands back a mask for the browser to subtract',
    r.body.passes.length === every.length && r.body.passes.every((p) => p.mask));
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

  /*
   * AND THE RETIRED BOX ID STILL ASKS ITS QUESTION. "trees" and "forest" were
   * folded into one "woods" entry; dropping the ids would quietly untick a box
   * somebody had chosen, and an exclusion that stops being applied makes the
   * lawn BIGGER -- the direction nobody notices.
   */
  check('and the retired tick id still runs the box that replaced it',
    r.sent.length === 1 && r.sent[0].prompt === EXCLUSIONS.woods.prompt,
    r.sent[0]?.prompt);
  check('as does the other one it was merged with',
    (await post({ model: 'sam3_exclude', exclude: ['forest'] })).sent[0].prompt
      === EXCLUSIONS.woods.prompt);
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
    last.body.remaining === 80 - 22, `remaining ${last.body.remaining}`);

  /* The same counter, so dropping the flag hits the ordinary line at once. */
  const plain = await spend(2, false);
  check('and dropping the flag falls straight back to the ordinary ceiling',
    plain.status === 429 && plain.body.limit === DAILY_LIMIT_PER_CLIENT,
    `${plain.status}: ${JSON.stringify(plain.body)}`);

  /*
   * AND OUR REFUSAL CARRIES THE PAIR THAT IDENTIFIES IT.
   *
   * `used` and `limit` together are the only reliable way the browser can tell
   * our own accounting from a 429 raised by Replicate, by Cloudflare's edge, or
   * by anything in between -- none of which carry them. Drop them from a
   * refusal and the app goes back to blaming an allowance it never consulted,
   * which is exactly the bug that cost a night of debugging.
   */
  check('and a real quota refusal is identifiable as one',
    Number.isFinite(plain.body.used) && Number.isFinite(plain.body.limit)
    && !plain.body.rateLimited,
    JSON.stringify(plain.body));
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

  /*
   * FLAGGED AS AN UPSTREAM LIMIT, NOT OURS, and this field is the only thing
   * that separates them: both answer 429.
   *
   * The browser read every 429 as a quota refusal, so a throttled detection
   * came out as "You've used today's detections" on a counter that had just
   * reset -- reported, and exactly right. A quota body carries limit/used and
   * this one does not, so the absence of those fields is what the wrong branch
   * fell through.
   */
  check('and it carries none of the quota fields, because it is not a quota refusal',
    r.body.limit === undefined && r.body.used === undefined
    && r.body.reason === undefined,
    JSON.stringify(r.body).slice(0, 120));

  httpStatus = 200;
}

/* ------------------------------------------ a refusal costs exactly one start */
/*
 * THE BUDGET IS SIX STARTS A MINUTE, so every request is worth counting.
 *
 * Two earlier diagnoses -- a burst, then a concurrency ceiling -- both produced
 * fixes that spent MORE requests to work around a limit on the number of
 * requests. The retry was the worst: it waited two seconds and asked again
 * against a window measured in minutes, so it could not succeed, and a refused
 * request still counts. Every throttled press quietly cost two starts instead
 * of one and made the next press likelier to fail.
 *
 * So the property to hold is arithmetic, not timing: a throttled press spends
 * ONE start no matter how many boxes are ticked.
 */
{
  let starts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v1/predictions')) return realFetch(url, init);
    starts++;
    return new Response(
      '{"detail":"Request was throttled. Your rate limit for creating predictions '
      + 'is reduced to 6 requests per minute"}',
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const r = await post({ model: 'sam3_exclude', exclude: Object.keys(EXCLUSIONS) });
  check('a throttled press spends one start, not one per box',
    starts === 1, `${starts} starts for ${Object.keys(EXCLUSIONS).length} boxes`);
  check('and is not retried, because a retry cannot beat a per-minute window',
    starts === 1, 'a refused request still counts against the limit');

  /*
   * AND THE SENTENCE SURVIVES, unwrapped from Replicate's JSON envelope. It
   * names the number and, in "reduced", a condition on the account -- the only
   * part of this that anyone can act on.
   */
  check("the detector's own sentence reaches the browser",
    /reduced to 6 requests per minute/.test(r.body.detail || ''), r.body.detail);
  check('without the JSON envelope around it',
    !/[{}"]/.test(r.body.detail || ''), r.body.detail);
  check('and it is flagged as an upstream limit, not our allowance',
    r.body.rateLimited === true && r.body.used === undefined);

  globalThis.fetch = realFetch;
}

/* ------------------------------------------- refusals reach the log */
/*
 * EVERY REFUSAL IS RECORDED, AND SAYS WHICH ONE IT WAS.
 *
 * A quota refusal and an upstream throttle produce the same shape of failure on
 * screen, and until now neither appeared in the log at all -- so "it refused me
 * and I do not know why" could not be answered from the record. `detail` is
 * what separates them without another round trip through somebody's memory.
 */
{
  const { readLog } = await import('../worker/src/testlog.js');
  const spend = async (e, n) => worker.fetch(new Request('https://example.test/api/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lng: -85.5, lat: 43.1, zoom: 19, size: 640, clientId: 'logger',
      model: 'sam3_exclude', exclude: ['built', 'woods'], ...(n || {}),
    }),
  }), e, ctx);

  /* Spend the ordinary allowance, then ask for two more than exist. */
  const e1 = loggingEnv();
  for (let i = 0; i < 10; i++) await spend(e1);
  const refused = await spend(e1);
  check('a quota refusal is 429', refused.status === 429);

  const log1 = await readLog(e1, 'sekret');
  const quotaRow = log1.entries.find((r) => r.outcome === 'quota_exceeded');
  check('and it reaches the log, which it never used to',
    !!quotaRow, log1.entries.map((r) => r.outcome).join(', '));
  check('carrying the numbers that explain it',
    /\d+ of \d+ used/.test(quotaRow?.detail || ''), quotaRow?.detail);
  check('and the pass count, so the cost of the press is visible',
    quotaRow?.passes === 2, String(quotaRow?.passes));

  /* And a throttle from the detector, which looks the same on screen. */
  httpStatus = 429;
  const e2 = loggingEnv();
  const throttled = await spend(e2);
  httpStatus = 200;
  check('an upstream throttle is 429 too', throttled.status === 429);

  const log2 = await readLog(e2, 'sekret');
  const rateRow = log2.entries.find((r) => r.outcome === 'rate_limited');
  check('and it is logged as a DIFFERENT outcome, not as our allowance',
    !!rateRow && !log2.entries.some((r) => r.outcome === 'quota_exceeded'),
    log2.entries.map((r) => r.outcome).join(', '));
  check('which is the distinction the screen could not make',
    /HTTP 429/.test(rateRow?.detail || ''), rateRow?.detail);

  /*
   * EVERY PASS'S CUT REACHES THE LOG.
   *
   * It used to write the FIRST pass's threshold beside a prompt field that
   * already joined all of them, so "man-made + woods" logged 0.05 and said
   * nothing about the 0.2 the second prediction ran at. Right for one pass,
   * silently wrong for two -- and a log that misreports the settings is worse
   * than no log, because the next hour goes into debugging the wrong number.
   */
  const e3 = loggingEnv();
  await spend(e3);
  const row = (await readLog(e3, 'sekret')).entries[0];
  check('a two-box press logs both concepts with their own cuts',
    row?.prompt === `${EXCLUSIONS.built.prompt} @${EXCLUSIONS.built.threshold}`
      + ` + ${EXCLUSIONS.woods.prompt} @${EXCLUSIONS.woods.threshold}`,
    row?.prompt);
  check('and does not report one of them as if it were both',
    row?.threshold === null, String(row?.threshold));

  /* One pass still fills the numeric field, which is what it is for. */
  const e4 = loggingEnv();
  await spend(e4, { exclude: ['woods'] });
  const one = (await readLog(e4, 'sekret')).entries[0];
  check('a one-box press keeps the plain numeric threshold',
    one?.threshold === EXCLUSIONS.woods.threshold, String(one?.threshold));
}

/* ------------------------------------- how deep a tile source goes */
/*
 * THE REPORT: "esri world imagery hasn't been providing any imagery."
 *
 * Its cache stops at z19 and does not 404 past it -- it answers with a "map
 * data not yet available" tile: HTTP 200, valid JPEG, the same 2,521 bytes
 * every time. So nothing errors and the map shows that instead of the ground.
 * A lot fits the frame at about z19.4 and correcting corners goes deeper, so
 * every zoom anybody WORKS at was past the end of it.
 *
 * The ceiling has to reach the browser from here, because a valid JPEG of the
 * words "not available" is not something a client-side check can tell from
 * photography.
 */
{
  console.log('\n--- how deep each tile source really goes ---');
  const { PROVIDERS, providerCatalogue } = await import('../worker/src/imagery.js');

  check('Esri declares where its photography stops',
    PROVIDERS.esri.maxzoom === 19,
    `maxzoom ${PROVIDERS.esri.maxzoom} — measured by workflow 8, not guessed`);

  const sent = providerCatalogue({}).find((p) => p.id === 'esri');
  check('and the browser is told, rather than left to find out',
    sent?.maxzoom === 19,
    'past the cache the answer is a 200, so nothing client-side can detect it');

  check('a source with no ceiling sends null rather than a number it made up',
    providerCatalogue({}).filter((p) => p.tiles && !Number.isFinite(p.maxzoom))
      .every((p) => p.maxzoom === null),
    'an invented ceiling is the bug this fixes, in the other direction');

  check('and the note warns it softens rather than letting it look broken',
    /zoom 19/.test(PROVIDERS.esri.note),
    PROVIDERS.esri.note.slice(-70));
}

/* ------------------------------ the property line as a prompt */
/*
 * The remote-sensing work on SAM 3 says text-only prompting is the worst
 * strategy measured, "particularly for irregular targets", and that semantic
 * plus geometric cues win. A lawn is maximally irregular, and the boundary --
 * the one thing here nobody has to guess -- is currently used only to trim the
 * answer afterwards.
 *
 * OFF until a real prediction says it helps, because an unknown field on the
 * Replicate wrapper is either refused or silently ignored, and the silent case
 * looks exactly like a change that did not work.
 */
{
  console.log('\n--- the property line as a geometric prompt ---');

  check('it is off unless the deployment turns it on',
    parcelBoxWanted({}) === false && parcelBoxWanted({ SEND_PARCEL_BOX: 'false' }) === false,
    'detection costs money per press and must not change on a guess');
  check('and on when it does',
    parcelBoxWanted({ SEND_PARCEL_BOX: 'true' }) === true);

  const corners = [[100, 80], [400, 80], [400, 300], [100, 300]];
  const box = parcelBox(corners, 640);
  check('the box is the parcel in frame pixels, XYXY',
    JSON.stringify(box) === JSON.stringify([100, 80, 400, 300]), JSON.stringify(box));

  /*
   * NOT THE WHOLE FRAME. zoomToFit leaves a margin round the lot, and that
   * margin is exactly the neighbours' ground the box exists to exclude -- so a
   * box that filled the image would be no cue at all while looking like one.
   */
  check('and is smaller than the frame it sits in',
    box[2] - box[0] < 640 && box[3] - box[1] < 640);

  const spilling = parcelBox([[-50, -50], [900, -50], [900, 900], [-50, 900]], 640);
  check('a boundary running past the frame is clamped to it',
    JSON.stringify(spilling) === JSON.stringify([0, 0, 640, 640]),
    JSON.stringify(spilling));

  check('no boundary means no box, rather than a box round everything',
    parcelBox(null, 640) === null && parcelBox([], 640) === null,
    'sending one would make "we tried the hybrid" true of runs that hinted nothing');
  check('and a degenerate one is refused',
    parcelBox([[5, 5], [5, 5], [5, 5]], 640) === null,
    'a box naming a single pixel is a question about one blade of grass');
  check('as is a boundary with nonsense in it',
    parcelBox([[0, 0], [NaN, 10], [10, 10]], 640) === null);
}

/* ---------------------------- the AI is free on the two public routes */
/*
 * "FREE" HAS TO MEAN THE PERSON'S OWN ALLOWANCE IS NEVER TOUCHED, and that is
 * not something any single layer can show. The lawn has a ceiling of its own,
 * the browser has a daily allowance, and the whole question is which purse a
 * press comes out of -- so it is asked here, where both exist, by pressing the
 * real endpoint and then reading the browser's counter back to see whether it
 * moved.
 *
 * The failure this is aimed at is silent in the worst way. If an open-link
 * detection falls through to `charge`, everything still works: the outline
 * arrives, nobody is told anything, and the cost lands on a volunteer's own
 * five-a-day -- who then meets a wall halfway through a favour, on a screen
 * where job mode has hidden the counter that would have explained it.
 */
{
  const { testDb } = await import('./d1.js');
  const { FREE_DETECTS_PER_JOB, FREE_DETECTS_PER_OPEN_JOB } =
    await import('../worker/src/jobs.js');

  const jobEnv = () => ({ ...loggingEnv(), DB: testDb() });

  const claimed = (e, { id, route, worker, detections = 0 }) => e.DB.prepare(
    `INSERT INTO lawn_jobs (id, lng, lat, state, worker, route, detections, claimed_at, created_at)
     VALUES (?1, -85.5, 43.1, 'claimed', ?2, ?3, ?4, ?5, ?5)`
  ).bind(id, worker, route, detections, new Date().toISOString()).run();

  const press = async (e, over = {}) => {
    const res = await worker.fetch(new Request('https://example.test/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lng: -85.5, lat: 43.1, zoom: 19, size: 640, clientId: 'c-open',
        model: 'sam3', ...over,
      }),
    }), e, ctx);
    return { status: res.status, body: await res.json() };
  };

  /* What the badge in the corner would say -- the same question the charge
     asks, which is the point: if this moved, somebody was billed. */
  const theirOwn = async (e) => {
    const res = await worker.fetch(
      new Request('https://example.test/api/quota?clientId=c-open'), e, ctx
    );
    return res.json();
  };

  const spentOn = async (e, id) => Number((await e.DB.prepare(
    'SELECT detections FROM lawn_jobs WHERE id = ?1'
  ).bind(id).first())?.detections);

  const JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  /* ---- a volunteer pressing Detect */
  {
    const e = jobEnv();
    await claimed(e, { id: JOB, route: 'volunteer', worker: 'helper-abc' });
    const r = await press(e, { job: JOB, worker: 'helper-abc' });

    check('a volunteer\'s detection goes through', r.status === 200,
      JSON.stringify(r.body).slice(0, 120));
    check('and comes out of the lawn', (await spentOn(e, JOB)) === 1,
      `${await spentOn(e, JOB)} spent on the lawn`);

    const mine = await theirOwn(e);
    check('and not out of their own day, which is the whole of "free"',
      Number(mine.used) === 0,
      `${mine.used} of ${mine.limit} charged to them -- job mode hides the badge, `
      + 'so a charge here is a wall with no explanation attached to it');
  }

  /* ---- and twenty of them, not six */
  {
    const e = jobEnv();
    await claimed(e, {
      id: JOB, route: 'volunteer', worker: 'helper-abc',
      detections: FREE_DETECTS_PER_JOB,
    });
    const r = await press(e, { job: JOB, worker: 'helper-abc' });
    check(`a ${FREE_DETECTS_PER_JOB + 1}th press on one lawn is fine here`,
      r.status === 200,
      `the crowd ceiling is ${FREE_DETECTS_PER_JOB}; this route's is `
      + `${FREE_DETECTS_PER_OPEN_JOB}, because asking IS the interaction now`);
  }

  /* ---- and when the lawn's own are gone, it is still not their bill */
  {
    const e = jobEnv();
    await claimed(e, {
      id: JOB, route: 'volunteer', worker: 'helper-abc',
      detections: FREE_DETECTS_PER_OPEN_JOB,
    });
    const r = await press(e, { job: JOB, worker: 'helper-abc' });

    check('a lawn with no passes left refuses the press', r.status === 429,
      `${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    check('saying it is the lawn rather than their allowance',
      r.body.jobSpent === true && r.body.error === 'job_passes_spent',
      JSON.stringify(r.body).slice(0, 160));
    check('in a sentence that says nothing was charged and what to do next',
      /charged to you/i.test(r.body.reason || '')
      && /by hand|cannot do this one/i.test(r.body.reason || ''),
      r.body.reason);

    const mine = await theirOwn(e);
    check('and it did NOT quietly become a charge against their day',
      Number(mine.used) === 0,
      `${mine.used} of ${mine.limit} -- falling through to charge is the bug `
      + 'this whole block exists to catch, and it is invisible from the screen');
  }

  /* ---- while a crowd worker is unchanged: six, then the ordinary rules */
  {
    const e = jobEnv();
    await claimed(e, {
      id: JOB, route: 'crowd', worker: 'CROWD1', detections: FREE_DETECTS_PER_JOB,
    });
    const r = await press(e, { job: JOB, worker: 'CROWD1' });
    check('a crowd lawn past its six falls back to the ordinary allowance',
      r.status === 200, JSON.stringify(r.body).slice(0, 120));
    const mine = await theirOwn(e);
    check('and that press is charged, the way it always was',
      Number(mine.used) > 0,
      `${mine.used} of ${mine.limit} -- these two routes are paid platforms with `
      + 'their outline run for them, and nothing about them has changed');
  }

  /* ---- a pass handed back above the crowd ceiling really comes back */
  {
    /*
     * THE BUG THE SPLIT CEILING WOULD HAVE INTRODUCED. The hand-back is the
     * same UPDATE with a negative n, and while it had to satisfy the ceiling it
     * would have failed silently on any lawn sitting above six -- which is
     * every busy open-link lawn. The worker would be charged for a detection
     * the detector itself refused, and nothing anywhere would say so.
     */
    const e = jobEnv();
    const at = 12;
    await claimed(e, {
      id: JOB, route: 'volunteer', worker: 'helper-abc', detections: at,
    });

    httpStatus = 429;
    const r = await press(e, { job: JOB, worker: 'helper-abc' });
    httpStatus = 200;

    check('a detection the detector refuses is 429', r.status === 429,
      JSON.stringify(r.body).slice(0, 120));
    check('and the lawn gets its pass back even well above the crowd ceiling',
      (await spentOn(e, JOB)) === at,
      `${await spentOn(e, JOB)} against ${at} before the press`);
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
