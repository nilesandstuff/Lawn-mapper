/**
 * /api/feedback, end to end against a fake KV.
 *
 * Two things are worth testing here and neither is "does it store a string".
 *
 * The first is the SHAPE OF WHAT IS KEPT. A report is somebody's address and a
 * picture of their garden, and the promise made on the dialog is that this is
 * what is sent -- so the fields that are stored, and the fields that are
 * deliberately not, are a contract rather than an implementation detail. The
 * bug this guards against is a well-meant "while we're here, record the IP".
 *
 * The second is that NOTHING A CLIENT POSTS IS TRUSTED. The geometry goes
 * straight into a review page and onto a map; strings, nested junk and
 * unbounded arrays all arrive from a browser we do not control.
 *
 *   node tools/feedback.test.js
 */

import worker from '../worker/src/index.js';
import { RATINGS } from '../worker/src/feedback.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

function kvEnv(extra = {}) {
  const store = new Map();
  return {
    MAPBOX_TOKEN: 'pk.test',
    FEEDBACK: '1',
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
    ...extra,
  };
}

const ring = (n = 4) => {
  const pts = [[-85.6, 43.0], [-85.59, 43.0], [-85.59, 43.01], [-85.6, 43.01], [-85.6, 43.0]];
  return Array.from({ length: n }, (_, i) => pts[i % pts.length]);
};

const square = [[-85.6, 43.0], [-85.59, 43.0], [-85.59, 43.01], [-85.6, 43.01], [-85.6, 43.0]];

async function send(env, body, headers = {}) {
  const res = await worker.fetch(new Request('https://example.test/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

const read = async (env, token = 'sekret') => {
  const res = await worker.fetch(
    new Request(`https://example.test/api/feedback/list?token=${token}`), env, { waitUntil() {} }
  );
  return { status: res.status, body: await res.json() };
};

const full = {
  rating: 'bad',
  note: 'took the driveway as lawn',
  clientId: 'tester',
  address: '7315 Brooks Lane',
  lng: -85.6, lat: 43.0,
  county: 'Ottawa',
  model: 'sam3_exclude',
  modelLabel: 'Exclude objects',
  mode: 'exclude',
  provider: 'mapbox',
  exclude: ['built', 'woods'],
  edgeFt: -2,
  fillGaps: false,
  squareFeet: 42727,
  parcelSqFt: 88000,
  frame: { lng: -85.6, lat: 43.0, zoom: 19, size: 640 },
  parcel: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square] } },
  shapes: [{ geometry: { type: 'Polygon', coordinates: [square] } }],
};

/* ------------------------------------------------------- the happy path */
{
  const env = kvEnv();
  const r = await send(env, full);
  check('a report is accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  const back = await read(env);
  check('and comes back through the reading token', back.status === 200 && back.body.entries.length === 1,
    `${back.body.entries?.length} entries`);

  const e = back.body.entries[0];
  check('carrying the rating', e.rating === 'bad');
  check('and what that rating MEANS, so a reader needs no key',
    e.means === RATINGS.bad, e.means);
  check('and the sentence the person typed', e.note === 'took the driveway as lawn');
  check('and the address, which is the point of asking', e.address === '7315 Brooks Lane');
  check('and the settings that produced it',
    e.model === 'sam3_exclude' && e.mode === 'exclude'
    && e.exclude.join('+') === 'built+woods' && e.edgeFt === -2,
    `${e.model} ${e.mode} ${e.exclude} ${e.edgeFt}`);
  check('and the frame, so the same photograph can be put back',
    e.frame?.zoom === 19 && e.frame?.size === 640, JSON.stringify(e.frame));
  check('and the boundary', e.parcel?.coordinates?.[0]?.length === 5);
  check('and the lawn itself, which is the thing being complained about',
    e.shapes.length === 1 && e.shapes[0].coordinates[0].length === 5);

  /*
   * WHAT IS NOT KEPT.
   *
   * Neither helps look at a bad lawn, and both are the fields that turn a
   * testing log into something that needs a privacy policy. The client id is
   * kept because it separates one tester from another without identifying
   * anybody; the address is kept because it IS the report.
   */
  const raw = JSON.stringify(e);
  check('no IP address is stored', !/\bip\b/i.test(Object.keys(e).join(' ')),
    Object.keys(e).join(', '));
  check('and no user agent', !/agent/i.test(raw));
}

/* ------------------------------------------------- an unwanted question */
/*
 * Anyone can post here, so the rating has to be one of ours. A free-text
 * rating would go straight into the review page's category filter and into
 * whatever counts get made from it later.
 */
{
  const env = kvEnv();
  const r = await send(env, { ...full, rating: 'amazing' });
  check('a rating we do not offer is refused', r.body.ok === false && r.body.reason === 'rating',
    JSON.stringify(r.body));
  check('and nothing is stored for it', (await read(env)).body.entries.length === 0);
}

/* ---------------------------------------------------------- switched off */
/*
 * Explicit, like the test log's switch: storing where people live should be a
 * decision somebody made and can see in the settings, not a side effect of a
 * KV binding existing. A deployment that never sets FEEDBACK cannot collect
 * this by accident.
 */
{
  const env = kvEnv({ FEEDBACK: '' });
  const r = await send(env, full);
  check('with the switch off, nothing is collected',
    r.body.ok === false && r.body.reason === 'off', JSON.stringify(r.body));

  /*
   * AND IT STILL ANSWERS 202, NOT AN ERROR. The person pressed a button to do
   * somebody a favour; a red failure message is a punishment for helping, and
   * they can do nothing about a setting on the server anyway.
   */
  check('but the visitor is not shown a failure they cannot act on', r.status === 202,
    String(r.status));
}

/* ------------------------------------------------------- reading it back */
{
  const env = kvEnv();
  await send(env, full);

  const wrong = await read(env, 'guess');
  check('a wrong token gets 404, not 403', wrong.status === 404, String(wrong.status));
  check('because a refusal would confirm there is something here',
    wrong.body.error === 'Not found');

  const none = await worker.fetch(
    new Request('https://example.test/api/feedback/list'), env, { waitUntil() {} }
  );
  check('and no token at all is the same answer', none.status === 404, String(none.status));

  const unreadable = kvEnv({ LOG_TOKEN: '' });
  await send(unreadable, full);
  const shut = await read(unreadable, 'anything');
  check('a deployment with no reader configured cannot leak this at all',
    shut.status === 404, String(shut.status));
}

/* ------------------------------------------- nothing from a client is trusted */
/*
 * The geometry ends up on a map in a review page. Whatever arrives is rebuilt
 * from finite numbers rather than stored by reference, which drops ids,
 * properties, strings pretending to be coordinates and anything nested deeper
 * than a polygon -- so a report can be undrawable, but it cannot be a payload.
 */
{
  const env = kvEnv();
  await send(env, {
    ...full,
    parcel: {
      type: 'Feature',
      id: '<script>alert(1)</script>',
      properties: { evil: '<img onerror=alert(1)>' },
      geometry: {
        type: 'Polygon',
        coordinates: [[...square.slice(0, 4), ['NaN', {}], [1, 2, 'extra'], square[0]]],
      },
    },
    shapes: [{ geometry: { type: 'Polygon', coordinates: [square] }, properties: { x: 'junk' } }],
  });

  const e = (await read(env)).body.entries[0];
  const stored = JSON.stringify(e.parcel);
  check('properties and ids do not survive the trip', !/script|evil|onerror/.test(stored), stored.slice(0, 90));
  check('nor do coordinates that are not numbers',
    e.parcel.coordinates[0].every((p) => p.length === 2 && p.every(Number.isFinite)),
    stored.slice(0, 120));
  check('and a ring that survives is still a closed shape worth drawing',
    e.parcel.coordinates[0].length >= 4, `${e.parcel.coordinates[0].length} points`);
}

/* A shape with nothing drawable in it is dropped rather than stored as junk. */
{
  const env = kvEnv();
  await send(env, { ...full, parcel: { geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } } });
  const e = (await read(env)).body.entries[0];
  check('a boundary too small to be a shape is dropped, not half-stored',
    e.parcel === null, JSON.stringify(e.parcel));
}

/* ------------------------------------------------------------ the limits */
/*
 * Unbounded writes to a shared store on an unpaid request. Not a theoretical
 * worry: this route is open by design, because the answer is only worth having
 * from the person who just looked at the map.
 */
{
  const env = kvEnv();
  /*
   * TRIMMED AND STILL STORED, which is the part that nearly went wrong.
   *
   * An outline larger than the budget has to come back as a smaller outline,
   * not as no report at all: a complicated lawn is exactly the kind that
   * produces a complaint, so dropping the big ones would silently discard the
   * reports most worth reading. The first version of this stored full-precision
   * doubles and rejected such a report on size, and the check passed anyway
   * because it allowed "nothing was stored" as a result.
   */
  const big = Array.from({ length: 5000 }, (_, i) => [-85.6 + i * 1e-6, 43 + i * 1e-6]);
  const sent = await send(env, { ...full, shapes: [{ geometry: { type: 'Polygon', coordinates: [big] } }] });
  check('an enormous outline is still accepted', sent.body.ok === true, JSON.stringify(sent.body));

  const e = (await read(env)).body.entries[0];
  check('trimmed rather than stored whole',
    e.shapes[0].coordinates[0].length <= 3000,
    `${e.shapes[0].coordinates[0].length} of 5000 points`);
  // A whole number has no decimals at all, so count them as none rather than
  // as undefined -- `undefined <= 6` is false, and the first point of a lot of
  // test geometry is exactly that.
  const decimals = (v) => (String(v).split('.')[1] || '').length;
  const overPrecise = e.shapes[0].coordinates.flat()
    .filter(([lng, lat]) => decimals(lng) > 6 || decimals(lat) > 6);
  check('and at a precision finer than the pixels it was traced from',
    overPrecise.length === 0, JSON.stringify(overPrecise.slice(0, 2)));

  const many = Array.from({ length: 200 }, () => ({ geometry: { type: 'Polygon', coordinates: [square] } }));
  await send(env, { ...full, clientId: 'other', shapes: many });
  const latest = (await read(env)).body.entries[0];
  check('and a hundred shapes become a readable few',
    latest.shapes.length <= 24, `${latest.shapes.length} shapes`);
}

{
  const env = kvEnv();
  let refused = 0;
  for (let i = 0; i < 30; i++) {
    const r = await send(env, { ...full, clientId: 'spammer' });
    if (!r.body.ok) refused++;
  }
  check('one browser cannot file reports forever', refused > 0, `${refused} of 30 refused`);
  check('and the refusal names the reason, so it is debuggable',
    (await send(env, { ...full, clientId: 'spammer' })).body.reason === 'too-many');

  /* The cap is per browser, not global: one noisy tester must not silence
   * everybody else. */
  check('while another browser is unaffected',
    (await send(env, { ...full, clientId: 'someone-else' })).body.ok === true);
}

/* --------------------------------------------------------- method guard */
{
  const env = kvEnv();
  const res = await worker.fetch(
    new Request('https://example.test/api/feedback'), env, { waitUntil() {} }
  );
  check('a GET to the write route is refused', res.status === 405, String(res.status));

  const bad = await worker.fetch(new Request('https://example.test/api/feedback', {
    method: 'POST', body: 'not json',
  }), env, { waitUntil() {} });
  check('and malformed JSON is a 400, not a 500', bad.status === 400, String(bad.status));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
