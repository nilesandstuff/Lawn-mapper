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
  samPrompt, NOT_LAWN_PROMPT, SUBTRACT_THRESHOLD, normaliseModel,
  EXCLUSIONS, DEFAULT_EXCLUSIONS, MAX_EXCLUSIONS, normaliseExclusions,
  exclusionPass, exclusionCatalogue,
  MAX_PROMPT_TOKENS, estimatePromptTokens, promptProblem,
} from '../worker/src/sam.js';
import {
  dayKey, DAILY_LIMIT_PER_CLIENT, DAILY_LIMIT_PER_DEV,
  DAILY_LIMIT_PER_IP, DAILY_LIMIT_PER_IP_DEV,
  consumeQuota, refundQuota, checkQuota, personalLimit, addressLimit,
} from '../worker/src/quota.js';
import { upstreamReason, redactSecrets } from '../worker/src/upstream.js';
import { logMeasurement, readLog, loggingEnabled, recordLater } from '../worker/src/testlog.js';
import {
  providerCatalogue, providerFrame, detectionImageUrl,
} from '../worker/src/imagery.js';
import { worldSize } from '../public/lib/mercator.js';
import {
  COUNTIES, COUNTY_BBOX, candidateCounties, isCovered,
} from '../worker/src/counties.js';
import { queryCounty } from '../worker/src/parcel.js';
import { VERIFIED_COUNTIES } from '../worker/src/counties-verified.js';
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';

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

/*
 * FIVE, DOWN FROM TWENTY, and the drop is the other half of making an account
 * worth having. Twenty free passes without an account and thirty with one is
 * not a reason to sign in; five is enough to measure your own lawn and see
 * whether the thing works, which is what a signed-out visitor is there for.
 *
 * This is the DEFAULT and not the policy -- the live number comes from the
 * settings table via limits.js, so the owner can move it from the console. The
 * constant is what a fresh deployment starts with and what applies when there
 * is no database to read a setting from.
 */
check('the signed-out allowance defaults to 5', DAILY_LIMIT_PER_CLIENT === 5,
  String(DAILY_LIMIT_PER_CLIENT));

/* --------------------------------------------- charging for several passes */
/*
 * ONE PRESS CAN NOW COST FOUR PREDICTIONS.
 *
 * Exclude mode runs one prediction per ticked box, and Replicate bills each of
 * them. A guardrail that counted presses rather than predictions would stop
 * guarding at exactly the moment the expensive mode is used: twenty presses of
 * four boxes is eighty predictions against a cap of twenty.
 */
{
  const kv = () => {
    const store = new Map();
    return {
      store,
      async put(k, v) { store.set(k, v); },
      async get(k) { return store.get(k) ?? null; },
    };
  };
  const req = { headers: { get: () => '203.0.113.9' } };
  const count = (env) => Number([...env.QUOTA.store].find(([k]) => k.startsWith('c:'))?.[1] || 0);

  const one = { QUOTA: kv() };
  await consumeQuota(req, one, 'someone');
  check('a single-pass detection still costs one', count(one) === 1);

  const four = { QUOTA: kv() };
  const got = await consumeQuota(req, four, 'someone', 4);
  check('four ticked boxes cost four', got.allowed && count(four) === 4, `${count(four)}`);

  /*
   * ALL OR NOTHING. Letting three of four through because that is what was
   * left would produce a measurement with one exclusion missing -- not a
   * smaller answer, a wrong one, with the trees counted as lawn and nothing
   * on screen saying so.
   */
  const nearly = { QUOTA: kv() };
  await consumeQuota(req, nearly, 'someone', DAILY_LIMIT_PER_CLIENT - 2);
  const refused = await consumeQuota(req, nearly, 'someone', 3);
  check('a press that does not fit is refused whole, not part-run',
    !refused.allowed && count(nearly) === DAILY_LIMIT_PER_CLIENT - 2,
    `${count(nearly)} used, asked for 3 with 2 left`);

  check('and the refusal says how many it needed, so the UI can say what to untick',
    refused.wanted === 3, JSON.stringify(refused));

  /* Two left and two wanted still fits: the cap is a ceiling, not a margin. */
  const exact = await consumeQuota(req, nearly, 'someone', 2);
  check('an exact fit is allowed', exact.allowed && count(nearly) === DAILY_LIMIT_PER_CLIENT);

  /*
   * A FAILED DETECTION REFUNDS EVERY PASS IT CHARGED FOR. Refunding one of
   * four would silently eat three quarters of the allowance on each broken
   * deploy -- the exact runaway the refund exists to prevent.
   */
  const broke = { QUOTA: kv() };
  await consumeQuota(req, broke, 'someone', 4);
  await refundQuota(req, broke, 'someone', 4);
  check('and a failure hands back all of them, not one', count(broke) === 0,
    `${count(broke)} left charged`);

  /* ------------------------------------------- the developer allowance */
  /*
   * Tuning a prompt means running one lot a dozen times, and exclude mode
   * spends one of these per ticked box, so the ordinary twenty is three or four
   * real experiments.
   */
  check('developer mode raises the personal ceiling',
    DAILY_LIMIT_PER_DEV === 80, String(DAILY_LIMIT_PER_DEV));
  check('and it really is higher than the ordinary one',
    DAILY_LIMIT_PER_DEV > DAILY_LIMIT_PER_CLIENT);

  const asDev = { QUOTA: kv() };
  const past = await consumeQuota(req, asDev, 'someone', DAILY_LIMIT_PER_CLIENT + 5, true);
  check('a developer run passes the ordinary cap',
    past.allowed && past.limit === DAILY_LIMIT_PER_DEV, JSON.stringify(past));

  /*
   * ONE COUNTER, NOT TWO. A separate developer bucket would let the same
   * browser spend twenty ordinary detections and then fifty more by flipping a
   * switch -- seventy against a cap of twenty.
   */
  const shared = { QUOTA: kv() };
  await consumeQuota(req, shared, 'someone', 18, true);
  const ordinary = await consumeQuota(req, shared, 'someone', 5, false);
  check('leaving developer mode does not hand back a fresh allowance',
    !ordinary.allowed && count(shared) === 18,
    `${count(shared)} already spent against a cap of ${DAILY_LIMIT_PER_CLIENT}`);

  /*
   * AND THE SHARED-NETWORK BACKSTOP IS NOT RAISED. This flag is unguarded --
   * anyone can post it -- so what actually limits the damage is the per-IP
   * ceiling, which must stay where it is.
   */
  const flood = { QUOTA: kv() };
  const ipCount = (env) => Number([...env.QUOTA.store].find(([k]) => k.startsWith('i:'))?.[1] || 0);
  /*
   * Spent in small presses across a stream of fresh client ids, which is what a
   * scraper clearing storage actually looks like. Whole-budget chunks would not
   * reach the address ceiling at all -- the second id's 80 would overshoot 120
   * and be refused with the counter still at 80, which proves nothing about the
   * backstop being the thing that binds.
   */
  let stopped = null;
  for (let i = 0; i < 40 && !stopped; i++) {
    const got = await consumeQuota(req, flood, `id-${i}`, 4, true);
    if (!got.allowed) stopped = got;
  }
  check('the per-address backstop still stops a flood of developer requests',
    stopped && stopped.reason === 'shared-network'
    && ipCount(flood) <= DAILY_LIMIT_PER_IP_DEV,
    `${ipCount(flood)} against a developer IP cap of ${DAILY_LIMIT_PER_IP_DEV}`);

  /*
   * Rotating client ids is exactly what the address ceiling is for. Each fresh
   * id gets its own personal budget; the address does not, which is what makes
   * it a backstop rather than a second copy of the same limit.
   */
  check('and it is the address, not the client id, that stops them',
    ipCount(flood) > DAILY_LIMIT_PER_DEV,
    `${ipCount(flood)} spent across ids, past the personal ${DAILY_LIMIT_PER_DEV}`);

  check('and the badge counts against the ceiling that will actually apply',
    (await checkQuota(req, asDev, 'someone', true)).limit === DAILY_LIMIT_PER_DEV
    && (await checkQuota(req, asDev, 'someone', false)).limit === DAILY_LIMIT_PER_CLIENT,
    'otherwise it reads "12 left" and then refuses at 20');

  /* ------------------------------- the badge must show the BINDING ceiling */
  /*
   * REPORTED, AND EXACTLY REPRODUCED HERE: "I'm at 30 out of 50 detections but
   * I was just told you've reached today's detections."
   *
   * Two ceilings apply and only one of them is in the way. checkQuota used to
   * hand back the personal count whenever BOTH were individually under their
   * line -- so with thirty personal detections left and one slot left on the
   * address, the badge said "30 of 50 detections left today" and the very next
   * press was refused. Every number on screen was true; none of them was about
   * the limit doing the refusing.
   *
   * `allowed` is the wrong thing to branch on, which is what made it subtle: an
   * address with one slot left is still "allowed" and still about to turn down
   * a two-pass detection. Headroom is the question.
   */
  const day = dayKey();
  const squeezed = { QUOTA: kv() };
  await squeezed.QUOTA.put(`c:${day}:owner`, '20');
  await squeezed.QUOTA.put(`i:${day}:203.0.113.9`, String(DAILY_LIMIT_PER_IP_DEV - 1));

  const badge = await checkQuota(req, squeezed, 'owner', true);
  check('the badge reports the ceiling with the least headroom, not the roomiest',
    badge.limit === DAILY_LIMIT_PER_IP_DEV && badge.reason === 'shared-network',
    `showing ${badge.limit - badge.used} of ${badge.limit}`);

  const press = await consumeQuota(req, squeezed, 'owner', 2, true);
  check('and that is the ceiling that really refuses the next press',
    !press.allowed && press.limit === badge.limit,
    `badge said ${badge.limit}, refusal said ${press.limit}`);

  /*
   * AND FIFTY HAS TO BE REACHABLE. Raising only the personal cap made it a
   * number the app could display and not honour: at four ticked boxes, fifty
   * detections is two hundred passes, and the address ceiling stopped it at
   * eighty. A promised allowance that the guardrail contradicts is worse than
   * a smaller honest one.
   */
  /*
   * The address ceiling must sit ABOVE the personal budget. Equal or below and
   * it becomes the binding one again, which is the whole bug: the personal
   * number goes back to being something the app prints and cannot honour.
   */
  check('the address ceiling leaves room for the whole personal budget',
    DAILY_LIMIT_PER_IP_DEV > DAILY_LIMIT_PER_DEV,
    `address ${DAILY_LIMIT_PER_IP_DEV} vs personal ${DAILY_LIMIT_PER_DEV}`);
  check('and the ordinary pair is the same shape',
    DAILY_LIMIT_PER_IP > DAILY_LIMIT_PER_CLIENT,
    `address ${DAILY_LIMIT_PER_IP} vs personal ${DAILY_LIMIT_PER_CLIENT}`);

  /*
   * A PASS BUDGET BUYS FEWER PRESSES AS BOXES ARE TICKED, and that is the whole
   * thing the badge used to hide by calling passes "detections". Asserted as
   * arithmetic against the real constants rather than as a fixed number, so
   * changing the budget cannot quietly make the label wrong again.
   */
  const roomy = { QUOTA: kv() };
  let pressed = 0;
  for (let i = 0; i < DAILY_LIMIT_PER_DEV; i++) {
    if ((await consumeQuota(req, roomy, 'owner', MAX_EXCLUSIONS, true)).allowed) pressed++;
  }
  check('every box ticked spends the budget four times as fast',
    pressed === Math.floor(DAILY_LIMIT_PER_DEV / MAX_EXCLUSIONS),
    `${pressed} presses at ${MAX_EXCLUSIONS} passes each, from ${DAILY_LIMIT_PER_DEV} passes`);

  const single = { QUOTA: kv() };
  let singles = 0;
  for (let i = 0; i < DAILY_LIMIT_PER_DEV + 5; i++) {
    if ((await consumeQuota(req, single, 'owner', 1, true)).allowed) singles++;
  }
  check('and one box ticked spends it one at a time',
    singles === DAILY_LIMIT_PER_DEV,
    `${singles} one-pass presses from ${DAILY_LIMIT_PER_DEV} passes`);

  /*
   * A real step up, which is the point of the mode -- tuning a prompt means
   * running one lot a dozen times.
   *
   * NO LONGER A FIXED MULTIPLE of the signed-out allowance. It was four times
   * twenty; the signed-out number is now five and the developer one is
   * unchanged, because they answer different questions -- how much does a
   * stranger get to try, and how much does it take to answer a question about
   * a prompt. Tying them together would have quietly cut the developer budget
   * to twenty when the first one moved.
   */
  check('the developer budget is a real step up from the ordinary one',
    DAILY_LIMIT_PER_DEV >= DAILY_LIMIT_PER_CLIENT * 4,
    `${DAILY_LIMIT_PER_DEV} vs ${DAILY_LIMIT_PER_CLIENT}`);

  /* The ordinary ceiling is untouched by all of this. */
  check('and an ordinary visitor still meets the original address limit',
    addressLimit(false) === DAILY_LIMIT_PER_IP && personalLimit(false) === DAILY_LIMIT_PER_CLIENT);
}


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


/* ------------------------------------------------------------ subtract mode */
/*
 * The second detection mode asks for everything that is NOT lawn and lets the
 * browser take the remainder, for warm-season turf that goes brown and stops
 * reading as "grass" at any threshold.
 *
 * What these guard is not the plumbing but the two places where the mode's
 * meaning is the REVERSE of the first one's, and where a reasonable-looking
 * change would therefore break it silently.
 */
check('exclude mode exists', !!MODELS.sam3_exclude, Object.keys(MODELS).join(', '));

/*
 * SUBTRACTIVE, NOT INVERTING, and the difference only shows up at two masks.
 *
 * For one concept they are the same pixels written from opposite ends. For two
 * they are opposites: inverting each mask and combining INTERSECTS them -- a
 * pixel would have to be both not-a-tree and not-a-building, and two
 * independently noisy masks intersect to slivers. Subtracting each from the
 * parcel accumulates, which is the whole reason the mode was rebuilt.
 */
check('it subtracts from the property rather than flipping the mask',
  MODELS.sam3_exclude.subtractive === true && !MODELS.sam3_exclude.invert,
  'inverting cannot stack: two flipped masks intersect, they do not add up');

check('and it is driven by the tick boxes',
  MODELS.sam3_exclude.exclusions === true);

/*
 * AND IT IS OFFERED, on measured evidence, having been withheld on the same
 * basis. It reported the entire parcel while its prompt was a comma list; one
 * concept per pass lands within 3% of the owner's own figure for the mown area.
 */
check('it is offered', !MODELS.sam3_exclude.hidden
  && modelCatalogue().some((m) => m.id === 'sam3_exclude'));

/*
 * The note has to say what it KEEPS, not just what it removes. This mode starts
 * from the whole lot, so anything the ticked boxes fail to find stays in the
 * total -- gravel, a bare field, a tennis court. An acceptable way to be wrong
 * (visible on the map, one tap to delete) but only for someone told to look.
 */
check('and its note warns that anything unticked counts as lawn',
  /not ticked|counts as lawn|check the result/i.test(MODELS.sam3_exclude.note),
  MODELS.sam3_exclude.note);

/*
 * A browser cached from before the rename must not be silently handed the
 * OPPOSITE question. Falling through to the default would answer "find grass"
 * to a request for "subtract", confidently, with nothing on screen saying so.
 */
check('the old id still resolves to the mode that replaced it',
  normaliseModel('sam3_subtract') === 'sam3_exclude');

check('and a genuinely unknown id still falls back to the default',
  normaliseModel('sam9_imaginary') === DEFAULT_MODEL);

check('the default model does not subtract',
  !MODELS[DEFAULT_MODEL].subtractive
  && modelCatalogue().find((m) => m.id === DEFAULT_MODEL)?.subtractive === false);

check('and the browser is always told, never left to infer',
  modelCatalogue().every((m) =>
    typeof m.invert === 'boolean' && typeof m.subtractive === 'boolean'
    && typeof m.exclusions === 'boolean'),
  'a missing flag reads as undefined, which is falsy by luck rather than by decision');

/* ------------------------------------------------------ the exclusions */
/*
 * One concept per pass. The reason this is a table of separate entries rather
 * than one longer prompt is measured, not stylistic: at Brooks Lane a
 * three-concept list masked 0% of a parcel that is 58% not-lawn, handing back
 * the entire lot as lawn in six vertices -- maximally wrong and shaped exactly
 * like a clean answer.
 */
check('every exclusion is a single concept',
  Object.values(EXCLUSIONS).every((e) => !e.prompt.includes(',')),
  Object.values(EXCLUSIONS).map((e) => e.prompt).join(' | '));

/*
 * THE DIRECTION TRAP, now per concept. 0.05 is deliberately inclusive about
 * grass, which is the safe way to be wrong when the question is "is this
 * grass". Asked "is this a tree", the same number is inclusive about TREES, and
 * every one it is confident about gets erased from the lawn.
 *
 * The two measured concepts disagree by a factor of four, which is why each
 * carries its own number rather than sharing one: "trees" flooded the entire
 * frame at 0.1 and below, while "man-made" reads well at 0.05 on a real lot.
 * A single shared threshold would have to be wrong for one of them.
 */
check('the tree concepts sit in the only band that produced anything at all',
  EXCLUSIONS.woods.threshold > 0.1 && EXCLUSIONS.woods.threshold < 0.4,
  `${EXCLUSIONS.woods.threshold}; <=0.1 masked the whole frame and >=0.4 masked nothing`);

check('and the built concept keeps the lower cut it was measured at',
  EXCLUSIONS.built.threshold === 0.05,
  'reported working on a real lot for house, drive, pool, deck and sidewalk');

check('so the concepts do not share one threshold',
  EXCLUSIONS.built.threshold !== EXCLUSIONS.woods.threshold,
  'one number for both would have to be wrong for one of them');

/*
 * DEFAULT ON is the one that has actually been tried on a real property. The
 * others are off because an untried concept that silently removes a third of
 * someone's lawn is worse than a box they had to tick themselves.
 */
/* One tree box, not two. They asked the same question at twice the price. */
check('there is a single tree box, and it is labelled for people not prompts',
  !EXCLUSIONS.trees && !EXCLUSIONS.forest
  && EXCLUSIONS.woods.label === 'Trees' && EXCLUSIONS.woods.prompt === 'woods',
  Object.keys(EXCLUSIONS).join(', '));

check('exactly one box starts ticked, and it is the measured one',
  DEFAULT_EXCLUSIONS.length === 1 && DEFAULT_EXCLUSIONS[0] === 'built',
  DEFAULT_EXCLUSIONS.join(', '));

check('the default is the man-made concept',
  EXCLUSIONS[DEFAULT_EXCLUSIONS[0]].prompt === 'man-made');

/* Every entry has to be runnable: an over-long one errors rather than
 * answering badly, and would cost a prediction to discover that. */
check('every exclusion prompt is within the encoder budget',
  Object.values(EXCLUSIONS).every((e) => promptProblem(e.prompt) === null));

check('and every threshold is a real fraction',
  Object.values(EXCLUSIONS).every((e) => e.threshold >= 0 && e.threshold <= 1));

/* The catalogue is what the browser draws the boxes from, so a missing field
 * is a box with no label rather than an error anyone would notice. */
check('the catalogue carries everything the browser needs',
  exclusionCatalogue().length === Object.keys(EXCLUSIONS).length
  && exclusionCatalogue().every((e) => e.id && e.label && typeof e.byDefault === 'boolean'));

check('and it never ships the prompts themselves',
  !JSON.stringify(exclusionCatalogue()).includes('man-made'),
  'the wording is the method; the browser picks concepts, not prompts');

/* ---------------------------------------------- normalising the tick list */
check('a normal request comes through in order',
  normaliseExclusions(['built', 'woods']).join(',') === 'built,woods');

/*
 * RETIRED IDS MIGRATE RATHER THAN VANISH. "trees" and "forest" were two boxes
 * asking one question and are now the single "woods" entry. Dropping the ids
 * would quietly untick a box somebody had chosen -- and an exclusion that stops
 * being applied makes the lawn BIGGER, which is the direction nobody notices.
 */
check('both retired tree ids resolve to the box that replaced them',
  normaliseExclusions(['trees']).join(',') === 'woods'
  && normaliseExclusions(['forest']).join(',') === 'woods');

check('and ticking both of them is still one prediction, not two',
  normaliseExclusions(['trees', 'forest']).join(',') === 'woods',
  'they measured the same ground at twice the price, which is why they merged');

/*
 * Unknown ids are DROPPED, not rejected. A browser cached from before a concept
 * was renamed should lose that box, not lose the whole detection.
 */
check('an unknown concept is dropped rather than failing the detection',
  normaliseExclusions(['built', 'unicorns']).join(',') === 'built');

check('duplicates are collapsed, so one box cannot be billed twice',
  normaliseExclusions(['woods', 'woods', 'woods']).join(',') === 'woods');

check('the list is capped, because it arrives over the wire',
  normaliseExclusions(
    Array(50).fill(0).map((_, i) => Object.keys(EXCLUSIONS)[i % MAX_EXCLUSIONS])
  ).length <= MAX_EXCLUSIONS,
  'without a cap one request could ask for a hundred predictions');

/*
 * EMPTY STAYS EMPTY. Substituting the defaults for "remove nothing" would spend
 * money on a question nobody asked; the caller refuses it with a sentence.
 */
check('an empty list is not quietly replaced with the defaults',
  normaliseExclusions([]).length === 0 && normaliseExclusions('built').length === 0);

/* ------------------------------------------------------- one pass's wiring */
check('a pass carries its own wording and its own cut',
  exclusionPass('woods', {}).prompt === 'woods'
  && exclusionPass('woods', {}).threshold === EXCLUSIONS.woods.threshold);

check('each concept is retunable without disturbing the others',
  exclusionPass('woods', { SAM_SUBTRACT_THRESHOLD: '0.35' }).threshold === 0.35
  && exclusionPass('built', { SAM_SUBTRACT_THRESHOLD: '0.35' }).threshold
     === EXCLUSIONS.built.threshold,
  'one variable moving several would make every tuning run tell you about two changes');

check('and the wording too',
  exclusionPass('built', { SAM_EXCLUDE_BUILT_PROMPT: 'rooftops' }).prompt === 'rooftops');

check('the override clamps like every other source for this number',
  exclusionPass('woods', {}, '4').threshold === 1
  && exclusionPass('woods', {}, '-1').threshold === 0);

/*
 * Zero is a legitimate cut, so the override must test for finite rather than
 * for truthy. `override || fallback` would silently ignore the entire low end.
 */
check('a zero override is honoured rather than read as "unset"',
  exclusionPass('woods', {}, 0).threshold === 0);

check('and an untouched slider leaves the concept its own number',
  exclusionPass('woods', {}, null).threshold === EXCLUSIONS.woods.threshold
  && exclusionPass('woods', {}, '').threshold === EXCLUSIONS.woods.threshold);

check('and the normal model still lets the source choose its wording',
  samPrompt(DEFAULT_MODEL, 'vegetation', {}) === 'vegetation',
  'infrared has no "grass" in it to find, only vegetation');

/*
 * ONE CONCEPT, NOT A LIST -- the finding the whole mode turns on.
 *
 * Measured at Brooks Lane, all at 0.2, on a parcel 58% not-lawn with ~28,000
 * sq ft mown:
 *
 *   "trees"                                     28,788 sq ft    38%
 *   "trees, building"                           37,537          49%
 *   "trees, building, driveway"                 76,079         100%
 *   "trees, building, driveway, swimming pool"  76,079         100%
 *   the original eight-item list                59,824          78%
 *
 * Monotonic: every word added makes it worse, and by three the mask has
 * collapsed so the whole parcel returns as lawn. So this asserts the SHAPE of
 * the prompt, which is the thing a well-meaning edit would undo -- adding
 * "building" here looks like an obvious improvement and measurably is not.
 */
check('the not-lawn prompt is a single concept',
  !NOT_LAWN_PROMPT.includes(','),
  `"${NOT_LAWN_PROMPT}" -- adding a second concept measured worse, and a third collapsed it`);

check('and it is the one that covers the most ground',
  /tree|wood|forest/i.test(NOT_LAWN_PROMPT),
  'the woods was 45% of the parcel; "building" alone masked 9.2% against 58% wanted');

/*
 * THE 32-TOKEN CEILING, learned the expensive way.
 *
 * The first version of this list ran to fifteen concepts and every prediction
 * failed outright: "Sequence length must be less than max_position_embeddings
 * (got 36 and 32)". The encoder errors rather than truncating, so a list that
 * grows past the line does not get worse -- it stops working.
 *
 * The estimator is calibrated on that one known count, which is the only real
 * measurement available offline, so this pins it. If it ever stops returning
 * 36 for that string the estimate has drifted and the budget check below is
 * measuring something else.
 */
const THE_PROMPT_THAT_FAILED =
  'building, roof, driveway, road, sidewalk, parking lot, tree, woods, forest, '
  + 'shrub, swimming pool, water, garden bed, mulch bed, car';

check('the estimator reproduces the count the model itself reported',
  estimatePromptTokens(THE_PROMPT_THAT_FAILED) === 36,
  `got ${estimatePromptTokens(THE_PROMPT_THAT_FAILED)}, model said 36`);

check('and would have caught that list before it was ever sent',
  estimatePromptTokens(THE_PROMPT_THAT_FAILED) > MAX_PROMPT_TOKENS);

check('the shipped not-lawn list fits the encoder',
  estimatePromptTokens(NOT_LAWN_PROMPT) <= MAX_PROMPT_TOKENS,
  `${estimatePromptTokens(NOT_LAWN_PROMPT)} of ${MAX_PROMPT_TOKENS} tokens`);

/*
 * And fits with room to spare. A list sitting one token under a limit
 * estimated by counting words is not safe: a single unusual word that the real
 * tokenizer splits in two puts it over, and the failure is total.
 */
check('with margin, because the estimate is not a tokenizer',
  estimatePromptTokens(NOT_LAWN_PROMPT) <= MAX_PROMPT_TOKENS - 6,
  `${estimatePromptTokens(NOT_LAWN_PROMPT)} tokens, want <= ${MAX_PROMPT_TOKENS - 6}`);

check('the grass prompt is nowhere near the ceiling',
  estimatePromptTokens(DEFAULT_PROMPT) <= MAX_PROMPT_TOKENS);


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



/* ------------------------------------------------------------- the test log */
/*
 * A record of which addresses have been measured, so a report of a bad number
 * can be turned back into a probe run. It stores street addresses, so what
 * these guard is not that it works but that it cannot be read by accident.
 */
{
  /** A KV stand-in that records what it was asked to do. */
  const fakeKv = () => {
    const store = new Map();
    return {
      store,
      async put(k, v) { store.set(k, v); },
      async get(k) { return store.get(k) ?? null; },
      async list({ prefix, limit }) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: true };
      },
    };
  };

  /*
   * OFF UNLESS SWITCHED ON. Storing where people live should be a decision
   * somebody made, not a side effect of a KV binding existing for the quota.
   */
  check('logging is off when nothing asked for it', !loggingEnabled({ QUOTA: fakeKv() }));
  check('and on when it is switched on', loggingEnabled({ QUOTA: fakeKv(), LOG_TESTS: '1' }));
  check('but never without somewhere to put it', !loggingEnabled({ LOG_TESTS: '1' }));

  const kv = fakeKv();
  const env = { QUOTA: kv, LOG_TESTS: 'true', LOG_TOKEN: 'sekret' };
  await logMeasurement(env, {
    address: '7315 Brooks Lane, Rockford, MI', lng: -85.5, lat: 43.1, zoom: 17.7,
    provider: 'mapbox', model: 'sam3', prompt: 'grass', threshold: 0.05,
    parcelSqFt: 76250, county: 'Kent County', clientId: 'abc', outcome: 'succeeded',
  });
  check('a measurement is recorded', kv.store.size === 1);

  /*
   * NOT READABLE WITHOUT THE TOKEN, and the failure is indistinguishable from
   * the route not existing -- a refusal would confirm there is something here
   * worth attacking.
   */
  check('no token, no read', (await readLog(env, null)) === null);
  check('a wrong token reads as absent', (await readLog(env, 'guess')) === null);
  check('a wrong token of the right length too',
    (await readLog(env, 'sekres')) === null);
  check('and a deployment with no token configured can never serve it',
    (await readLog({ ...env, LOG_TOKEN: '' }, 'sekret')) === null,
    'this is what makes forgetting to set one safe rather than dangerous');

  const found = await readLog(env, 'sekret');
  check('the right token reads it back', found?.entries.length === 1);
  check('and the address is what was stored',
    found.entries[0].address === '7315 Brooks Lane, Rockford, MI');
  check('with the lot size beside it, which is the yardstick',
    found.entries[0].parcelSqFt === 76250);

  /*
   * NO IP, NO USER AGENT. Neither helps reproduce a bad measurement, and
   * collecting a field because it is available is how a testing log becomes
   * something that needs a privacy policy.
   */
  const stored = JSON.stringify(found.entries[0]);
  check('and nothing was collected that cannot help reproduce a bug',
    !/\bip\b|user.?agent|referer/i.test(stored), stored);

  /* Failures are the interesting reports: "it found nothing at my house"
   * needs the address kept precisely when there is no mask to show for it. */
  await logMeasurement(env, { address: 'somewhere', outcome: 'failed' });
  const both = await readLog(env, 'sekret');
  check('a failed detection is logged too, which is the point',
    both.entries.some((e) => e.outcome === 'failed'), `${both.entries.length} entries`);

  check('newest first, so a fresh report is at the top',
    new Date(both.entries[0].at) >= new Date(both.entries[1].at));

  /* Bookkeeping must never be able to break a measurement that worked. */
  const broken = { QUOTA: { put() { throw new Error('KV down'); } }, LOG_TESTS: '1' };
  let threw = false;
  try { await logMeasurement(broken, { address: 'x' }); } catch { threw = true; }
  check('a broken log does not break the measurement', !threw);

  /* Writing nothing when logging is off is the whole of the off switch. */
  const quiet = fakeKv();
  await logMeasurement({ QUOTA: quiet }, { address: '10 Downing St' });
  check('nothing is stored while logging is off', quiet.store.size === 0);

  /* One enormous "address" must not become one enormous KV value. */
  await logMeasurement(env, { address: 'x'.repeat(5000) });
  const big = (await readLog(env, 'sekret')).entries.find((e) => e.address?.startsWith('xxx'));
  check('free text is capped', big.address.length <= 200, `${big.address.length} chars`);

  /*
   * THE BUG EVERY TEST ABOVE PASSED THROUGH.
   *
   * All of it worked here and stored nothing in production, because a Worker
   * cancels any promise still pending when the handler returns its Response.
   * The write was started and never allowed to finish. `logging: true`, zero
   * entries, and not one failing assertion -- because a test awaits, and a
   * Worker does not.
   *
   * So the thing to test is not that the write works. It is that the write is
   * HANDED TO waitUntil, which is the only part production does differently.
   */
  const registered = [];
  const fakeCtx = { waitUntil: (p) => registered.push(p) };
  const write = logMeasurement(env, { address: 'later', outcome: 'succeeded' });
  check('a write is handed to waitUntil, not merely started',
    recordLater(fakeCtx, write) === true && registered.length === 1);
  await Promise.all(registered);
  check('and it lands', (await readLog(env, 'sekret')).entries.some((e) => e.address === 'later'));

  check('with no ctx the promise comes back so a caller can await it',
    typeof recordLater(undefined, Promise.resolve()).then === 'function',
    'dropping it on the floor is what the outage was');
  check('and a ctx without waitUntil is treated as no ctx',
    typeof recordLater({}, Promise.resolve()).then === 'function');

  /*
   * Source check, because the mistake was at the CALL SITE, not in the module.
   * logMeasurement is safe to call and useless to call bare -- so the rule is
   * that index.js never calls it without recordLater around it.
   */
  const workerSrc = await readFile(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  const bareCalls = workerSrc
    .split('\n')
    .filter((l) => /logMeasurement\(/.test(l) && !/recordLater\(/.test(l) && !/^\s*import/.test(l));
  check('every log write in the worker goes through recordLater',
    bareCalls.length === 0, bareCalls.join(' | '));
  check('and the fetch handler takes the ctx that makes that possible',
    /async fetch\(request, env, ctx\)/.test(workerSrc));
}


/* ------------------------------------------------------- developer mode */
/*
 * A hidden panel that sends its own prompt and threshold, so real lots can be
 * used to try wordings this file does not contain.
 *
 * OBSCURED, NOT SECURED: the Worker takes these fields from anyone, and that
 * is deliberate -- an arbitrary prompt costs exactly one prediction and the
 * daily allowance already caps that. What the Worker owes is VALIDATION, which
 * is what these check, because a bad value is a wasted prediction whoever
 * sent it.
 */
check('a typed prompt outranks the model and the source',
  samPrompt('sam3_exclude', 'grass', { SAM_NOT_LAWN_PROMPT: 'shrubs' }, 'bermudagrass')
    === 'bermudagrass',
  'the whole point is trying a wording the code does not contain');

check('and blank falls back rather than sending an empty prompt',
  samPrompt(DEFAULT_MODEL, 'grass', {}, '') === 'grass'
  && samPrompt(DEFAULT_MODEL, 'grass', {}, '   ') === 'grass');

check('a typed threshold is used', samThreshold({}, DEFAULT_MODEL, 0.42) === 0.42);

/*
 * ZERO IS A REAL SETTING. Written as `override || fallback` this passes every
 * other case and silently ignores the bottom of the slider -- which is exactly
 * the end someone testing a stubborn lawn would reach for.
 */
check('including zero, which a truthiness check would swallow',
  samThreshold({}, DEFAULT_MODEL, 0) === 0);

check('an untouched slider leaves the model default alone',
  samThreshold({}, DEFAULT_MODEL, null) === DEFAULT_THRESHOLD);

/*
 * Exclude mode has no threshold of its own AT THE MODEL LEVEL, and that is the
 * point: the number belongs to the concept, not to the method. "man-made" reads
 * well at 0.05 and "trees" floods the frame there, so a model-wide setting
 * would have to be wrong for one of them. samThreshold is not what drives an
 * exclusion pass -- exclusionPass is -- and this asserts that nobody has
 * quietly reintroduced a single number above them.
 */
check('exclude mode carries no method-wide threshold to override its concepts',
  MODELS.sam3_exclude.threshold === undefined
  && exclusionPass('built', {}).threshold !== exclusionPass('woods', {}).threshold,
  `${exclusionPass('built', {}).threshold} vs ${exclusionPass('woods', {}).threshold}`);

check('and a typed threshold is still clamped',
  samThreshold({}, DEFAULT_MODEL, 5) === 1 && samThreshold({}, DEFAULT_MODEL, -2) === 0);

check('nonsense from the wire falls back rather than being sent',
  samThreshold({}, DEFAULT_MODEL, 'high') === DEFAULT_THRESHOLD);

/*
 * The check that saves an allowance slot. Past 32 tokens the encoder errors
 * rather than truncating, so this has to be caught BEFORE the quota is spent
 * -- a failed prediction that also cost a measurement is the worst outcome.
 */
check('an over-long prompt is refused', !!promptProblem(THE_PROMPT_THAT_FAILED),
  promptProblem(THE_PROMPT_THAT_FAILED) || '(allowed!)');

check('and the refusal says what to do about it',
  /fewer words/i.test(promptProblem(THE_PROMPT_THAT_FAILED)));

check('an empty prompt is refused too', !!promptProblem('   '));
check('a sensible prompt is allowed', promptProblem('dormant bermuda grass') === null);
check('the shipped prompts pass their own check',
  promptProblem(DEFAULT_PROMPT) === null && promptProblem(NOT_LAWN_PROMPT) === null);


/* ------------------------------------------------------ the Testing method */
/*
 * A separate entry rather than an override applied to the shipped ones.
 *
 * The reason is legibility, not tidiness: overriding the prompt on Exclude
 * leaves that method's subtraction and per-concept cuts in play, so an odd
 * result has two possible causes and the panel cannot say which. Testing starts
 * from nothing, so a result is attributable to what was typed.
 */
check('the Testing method exists', !!MODELS.sam3_testing);

check('it is developer-only', MODELS.sam3_testing.devOnly === true);

check('and the shipped methods are not',
  !MODELS[DEFAULT_MODEL].devOnly && !MODELS.sam3_exclude.devOnly);

/*
 * NOTHING OF ITS OWN. Each of these is a setting that, if it had one, would
 * silently join whatever the panel sent -- which is the confusion being fixed.
 */
check('it carries no prompt of its own', !MODELS.sam3_testing.prompt);
check('and no threshold of its own', MODELS.sam3_testing.threshold === undefined);
check('and does not invert on its own', MODELS.sam3_testing.invert === false);

check('so a blank prompt falls through to the source rather than inventing one',
  samPrompt('sam3_testing', 'grass', {}) === 'grass',
  'the Worker refuses that case outright; this pins WHY it has to');

check('and a typed prompt is sent verbatim',
  samPrompt('sam3_testing', 'grass', {}, 'dormant zoysia') === 'dormant zoysia');

/*
 * The catalogue must carry devOnly to the browser, which is what filters the
 * method out of the picker. Withholding it here would suggest a guard that
 * does not exist -- the Worker runs whatever id it is given.
 */
{
  const testing = modelCatalogue().find((m) => m.id === 'sam3_testing');
  check('the browser is told it is developer-only', testing?.devOnly === true);
  check('and the shipped ones are told they are not',
    modelCatalogue().filter((m) => m.id !== 'sam3_testing')
      .every((m) => m.devOnly === false),
    modelCatalogue().map((m) => `${m.id}:${m.devOnly}`).join(', '));
}

/* ------------------------------------------------------- county coverage */
/*
 * A BOX MAY EXIST BEFORE ITS COUNTY DOES, and must not crash when it does.
 *
 * The bounds of a county are known long before anybody has found a server
 * that answers for it, so a bbox lands in the file first and the entry follows
 * once the discovery workflow has proved an endpoint. candidateCounties read
 * `COUNTIES[key].service` unguarded, so adding Wayne's box crashed every
 * address in Detroit before a single parcel had been looked up -- an
 * exception, from the geocoder's own path, for a county nobody had claimed to
 * support yet.
 *
 * The next county will be added the same way round, which is why this is a
 * test and not a fixed comment.
 */
{
  const boxes = Object.keys(COUNTY_BBOX);
  const unfinished = boxes.filter((key) => !COUNTIES[key]?.service);

  /*
   * Deliberately tolerant of BOTH states, because both are legitimate: a box
   * with no county yet is work in progress, and none at all is the steady
   * state. What is never legitimate is throwing.
   */
  let threw = null;
  for (const [key, [w, s, e, n]] of Object.entries(COUNTY_BBOX)) {
    try {
      candidateCounties((w + e) / 2, (s + n) / 2);
      isCovered((w + e) / 2, (s + n) / 2);
    } catch (err) {
      threw = `${key}: ${err.message}`;
      break;
    }
  }
  check('a point inside every box can be looked up without throwing',
    threw === null, threw || `${boxes.length} boxes, ${unfinished.length} without a service yet`);

  check('and a county with no endpoint yet reads as not covered, not as an error',
    unfinished.every((key) => {
      const [w, s, e, n] = COUNTY_BBOX[key];
      return !candidateCounties((w + e) / 2, (s + n) / 2).includes(key);
    }),
    unfinished.join(', ') || 'none pending');

  /*
   * A TRANSPOSED BOX COVERS NOTHING AND LOOKS FINE. West must be west of east
   * and south south of north -- get either backwards and the filter silently
   * never matches, so the county is configured, verified, and unreachable.
   */
  const backwards = Object.entries(COUNTY_BBOX)
    .filter(([, [w, s, e, n]]) => !(w < e && s < n))
    .map(([key]) => key);
  check('every box has its corners the right way round',
    backwards.length === 0, backwards.join(', ') || `${boxes.length} boxes`);

  /*
   * And the reverse: a county with a working endpoint and no box can never be
   * chosen, because the box is the only thing that nominates it.
   */
  const unreachable = Object.entries(COUNTIES)
    .filter(([key, c]) => c.service && !COUNTY_BBOX[key])
    .map(([key]) => key);
  check('and every county with a server has a box to be found by',
    unreachable.length === 0, unreachable.join(', ') || 'all reachable');

  /*
   * Indiana was asked for as one county and shipped as the state, so the thing
   * worth asserting is that the other 91 actually reach it. Evansville is the
   * county that was asked about; Indianapolis, Fort Wayne and South Bend are
   * the three the discovery run proved, and all three sit outside any box a
   * Vanderburgh entry would have had.
   */
  const indianaPoints = [
    ['Evansville', -87.6100, 37.9750],
    ['Indianapolis', -86.1420, 39.8700],
    ['Fort Wayne', -85.1400, 41.1200],
    ['South Bend', -86.2400, 41.6900],
  ];
  const missed = indianaPoints
    .filter(([, lng, lat]) => !candidateCounties(lng, lat).includes('indiana'))
    .map(([name]) => name);
  check('all four verified Indiana points reach the statewide layer',
    missed.length === 0, missed.join(', ') || `${indianaPoints.length} points`);
}

/* ------------------------------------------------- the generated atlas half */
/*
 * counties-verified.js is written by a workflow, so nothing about it is under
 * review the way the hand-written entries are. These are the invariants that
 * hold whether it is empty, freshly generated, or stale.
 */
{
  const generated = Object.entries(VERIFIED_COUNTIES);

  /*
   * EVERY GENERATED ENTRY NEEDS ITS OWN BOX. The hand-written half keeps boxes
   * in a separate table and tolerates a box with no county yet; the generated
   * half carries them inline, so an entry without one is unreachable and an
   * entry whose box is transposed silently covers nothing.
   */
  const boxless = generated.filter(([, c]) => !Array.isArray(c.box) || c.box.length !== 4);
  check('every generated county carries a four-corner box',
    boxless.length === 0, boxless.map(([k]) => k).join(', ') || `${generated.length} entries`);

  const flipped = generated.filter(([, c]) => {
    if (!Array.isArray(c.box) || c.box.length !== 4) return false;
    const [w, s, e, n] = c.box;
    return !(w < e && s < n);
  });
  check('and none of them is inside out',
    flipped.length === 0, flipped.map(([k]) => k).join(', ') || 'corners in order');

  /*
   * THE HAND-WRITTEN ENTRY MUST WIN. Both halves are merged into one lookup,
   * and the examined endpoint -- the one with a paragraph saying what its test
   * points actually returned -- has to be the one tried first. A generated key
   * that collided with a curated one would silently replace it.
   */
  const collisions = generated.filter(([key]) => Object.hasOwn(COUNTIES, key));
  check('no generated key can overwrite a hand-written county',
    collisions.length === 0,
    collisions.map(([k]) => k).join(', ') || 'namespaced apart');

  /*
   * Grand Rapids is in both halves once the atlas is generated -- Kent is
   * hand-written here and in the atlas from a different service. The curated
   * one has to come first in the candidate list, because parcel.js tries them
   * in order and stops at the first that answers.
   */
  /*
   * DUPLICATE KEYS IN THE GENERATED FILE ARE SILENT AND LOSSY, so the source
   * text is checked rather than the imported object -- by the time it is an
   * object the duplicates are gone and the last one has won.
   *
   * This is not hypothetical. All five New York City boroughs carry the id
   * `ny-new-york` in the upstream atlas, the importer trusted it, and four of
   * them -- about seven million people -- were silently dropped. The only
   * trace was a build warning in the deploy log.
   */
  const generatedText = readFileSync(
    new URL('../worker/src/counties-verified.js', import.meta.url), 'utf8'
  );
  const keys = [...generatedText.matchAll(/^ {2}'([a-z0-9-]+)':\s*\{/gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  check('no county is written twice into the generated file',
    dupes.length === 0,
    dupes.length ? [...new Set(dupes)].join(', ') : `${keys.length} keys, all distinct`);

  const grandRapids = candidateCounties(-85.6681, 42.9634);
  check('and where both cover a place, the examined one is asked first',
    !grandRapids.includes('mi-kent') || grandRapids.indexOf('kent') < grandRapids.indexOf('mi-kent'),
    grandRapids.join(', ') || 'no candidates');

  /*
   * A BOX THAT STOPS SHORT OF ITS OWN COUNTY.
   *
   * Reported as "no property line in Zeeland". Nothing had failed: Ottawa's
   * box stopped at 42.83, Zeeland is at 42.81, and the county was simply never
   * asked. The point still fell inside ALLEGAN's box, so the app asked the
   * wrong county, got nothing, and reported nothing -- which is the worst
   * shape this bug can take, because it looks exactly like a county whose
   * server is down.
   *
   * Named towns rather than the middle of the box, and that is the point: the
   * middle of a box is inside it by construction, so a check built from box
   * arithmetic can only ever agree with itself. Every existing Ottawa point
   * was 42.87 or north and the probe went green throughout.
   */
  const SOUTHERN_OTTAWA = [
    ['Zeeland', -86.0192, 42.8125],
    ['Holland Township', -86.0800, 42.8200],
  ];
  for (const [town, lng, lat] of SOUTHERN_OTTAWA) {
    const tried = candidateCounties(lng, lat);
    check(`${town} is looked up in Ottawa County`,
      tried.includes('ottawa'),
      tried.join(', ') || 'no county would be asked at all');
    /*
     * And asked FIRST. Allegan's box reaches north over the line on purpose,
     * so both are candidates here; lookupParcel takes the first that answers,
     * and a wasted query is only cheap if it is the second one.
     */
    check(`  and Ottawa is asked before Allegan there`,
      !tried.includes('allegan') || tried.indexOf('ottawa') < tried.indexOf('allegan'),
      tried.join(', '));
  }
}

/* ------------------------------------------------- the retired-parcel filter */
/*
 * Champaign's layer is an Esri parcel fabric: it keeps retired parcels beside
 * live ones, so a point sits inside its current lot AND every parent that lot
 * was split from, and the first feature back is not reliably the live one.
 * The entry filters them out with `where`, and keeps an explicitly unfiltered
 * copy as a fallback so a wrong guess about the schema cannot lose a property
 * line that the old unfiltered query would have found.
 *
 * Both halves are asserted, because each fails silently on its own. A `where`
 * that never reaches the URL gives back retired parcels and looks like it
 * works. A fallback that INHERITS cfg.where instead of its own null is not a
 * fallback at all -- it is the same filtered query run twice, which is the
 * bug this arrangement exists to avoid and is invisible from the outside.
 */
{
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    // Answer nothing, so every endpoint is tried and both URLs get recorded.
    return { ok: true, json: async () => ({ features: [] }) };
  };

  try {
    await queryCounty('champaign', -88.2700, 40.1100);
  } finally {
    globalThis.fetch = realFetch;
  }

  const filtered = asked.filter((u) => u.includes('where=RetiredByRecord+IS+NULL'));
  const unfiltered = asked.filter((u) => !u.includes('where='));

  check('the retired-parcel filter reaches the query string',
    filtered.length > 0, `${filtered.length} of ${asked.length} requests carried it`);

  check('and the unfiltered fallback is genuinely unfiltered',
    unfiltered.length > 0, `${unfiltered.length} of ${asked.length} requests had no where`);

  /*
   * A county with no `where` must be untouched by any of this -- the filter is
   * one county's problem and every other entry has to query exactly as before.
   */
  const plain = [];
  globalThis.fetch = async (url) => {
    plain.push(String(url));
    return { ok: true, json: async () => ({ features: [] }) };
  };
  try {
    await queryCounty('kent', -85.6681, 42.9634);
  } finally {
    globalThis.fetch = realFetch;
  }
  check('a county without one sends no where at all',
    plain.length > 0 && plain.every((u) => !u.includes('where=')),
    `${plain.length} requests, none filtered`);
}

/* ------------------------------------------- the preflight cannot hang open */
/*
 * probe-counties.js gates every deploy, and it talks to a dozen county servers
 * that go down, move, and get republished without notice. Node's fetch has NO
 * default timeout, so one server that accepts a connection and never answers
 * hangs the whole workflow until GitHub's six-hour job limit.
 *
 * Adding Champaign's portal did exactly that: the run sat on step one for
 * thirty-five minutes and had to be cancelled by hand. Every request in that
 * file now goes through one helper carrying an abort signal, and this asserts
 * it stays that way -- the next county added is the next chance to reintroduce
 * a bare fetch, and nothing about the symptom points at the cause.
 */
{
  const src = await readFile(new URL('./probe-counties.js', import.meta.url), 'utf8');
  // Comments talk about fetch at length; only real calls matter.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const calls = code.match(/\bfetch\s*\(/g) || [];
  const timed = code.match(/\bfetch\s*\([^)]*AbortSignal\.timeout/g) || [];

  check('every fetch in the preflight probe carries a deadline',
    calls.length > 0 && calls.length === timed.length,
    `${timed.length} of ${calls.length} calls timed`);
}

/* ------------------------------------------------- tests that never ran */
/*
 * EVERY TEST FILE MUST EXIT LAST, and this check exists because two of them
 * did not.
 *
 * Appending a block to the end of a file that ends in `process.exit` puts the
 * new tests AFTER the exit, where they never run -- and the suite still says
 * "All checks passed", because as far as it knows they do not exist. Two
 * rounds of corpus tests were written, reported as passing, and committed
 * without ever having executed. One of them was guarding a silent data-loss
 * bug.
 *
 * Nothing about that failure was visible: no error, no skipped count, a green
 * suite and a rising PASS total from the files that did run. So it is checked
 * structurally instead.
 */
{
  const dir = new URL('.', import.meta.url);
  const dead = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    const lines = text.split('\n');
    /* Anchored to a real call at the start of a line: this check's own source
       mentions the name, and a naive `includes` matched itself. */
    const at = lines.findIndex((l) => /^\s*process\.exit\(/.test(l));
    if (at === -1) continue;
    /* Anything but blank lines after the exit is code that cannot run. */
    const after = lines.slice(at + 1).filter((l) => l.trim());
    if (after.length) dead.push(`${name}: ${after.length} line(s) after process.exit`);
  }
  check('no test file has tests after its own process.exit', dead.length === 0,
    dead.join('; ') || 'every file exits last, so every test in it runs');
}

/* -------------------------------- is THIS county served, or just nearby? */
{
  /*
   * A BOX IS A RECTANGLE AND A COUNTY IS NOT, and the difference produced a
   * wrong answer on a real address.
   *
   * Fulton County's extent runs east to -84.097, which is inside western
   * Gwinnett. An address there found a candidate and was called covered -- so
   * the app said "your county has records, but not for this parcel" and the
   * console filed Gwinnett under "configured, still nothing", pointing at a
   * server to debug. Gwinnett is not configured at all. Both messages sent
   * somebody looking in the wrong place.
   *
   * North Carolina's statewide rectangle is worse: its south-west corner sits
   * in Georgia, so NC OneMap is a candidate for addresses in metro Atlanta.
   */
  const { servesCounty, countyName } = await import('../worker/src/counties.js');

  /*
   * NAMED FOR NOWHERE ON PURPOSE. Gwinnett was the county this was found on,
   * and it is configured now -- the layer index was wrong, not the county --
   * so asserting against it would have this test pass or fail on whether a
   * workflow happened to add a county that morning. The rule is the subject
   * here, not the roster, and the roster is regenerated by a workflow.
   */
  check('a place no layer is named for is not "configured"',
    servesCounty(-84.39, 33.75, 'Nowhere County', 'GA') === false,
    'boxes reach this point and none of them is Nowhere County');
  check('while the county that does reach it is',
    servesCounty(-84.39, 33.75, 'Fulton County', 'GA') === true,
    'Atlanta is in Fulton and Fulton is configured');

  /*
   * A STATEWIDE LAYER IS CREDITED FOR ITS STATE. Asking whether NC OneMap is
   * "Wake County" would say no to an address it covers perfectly; asking only
   * whether its box matched would say yes to one in Georgia.
   */
  check('a statewide layer covers a county it has never been named for',
    servesCounty(-78.64, 35.78, 'Wake County', 'NC') === true,
    'NC OneMap serves every county in the state, Wake included');
  /*
   * The NC rectangle has its south-west corner in Georgia, so NC OneMap is a
   * candidate for addresses in metro Atlanta. A statewide layer must be
   * credited for its own state and not for whatever its corners reach.
   */
  check('but not for a place in the state next door',
    servesCounty(-84.39, 33.75, 'Nowhere County', 'GA') === false,
    'northcarolina is a candidate at this point and must not answer for it');

  check('with no place name at all, a box match is the best question there is',
    servesCounty(-84.39, 33.75, null, null) === true
    && servesCounty(-120.5, 44.2, null, null) === false,
    'a geocoder that returned no county must not make everything unserved');

  /* Spelling is not the question being asked. */
  check('names match through punctuation and the word "county"',
    countyName('DeKalb County') === countyName('De Kalb')
    && countyName('St. Louis County, MO') === countyName('St Louis'),
    `${countyName('DeKalb County')} / ${countyName('De Kalb')}`);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
