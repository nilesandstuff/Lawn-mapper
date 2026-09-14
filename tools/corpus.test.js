/**
 * The training corpus: what it keeps, and what it must never keep.
 *
 *   node tools/corpus.test.js
 *
 * The privacy checks here are the point. Everything else in this file is
 * ordinary validation; those two are a promise made to people on screen --
 * "we keep the outline, not your address" -- and the only thing standing
 * between that sentence and a lie is that nothing writes those columns.
 */

import {
  recordFinished, corpusSummary, corpusEnabled,
  imageSourceFor, imageKeyFor, storeImage,
} from '../worker/src/corpus.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

/** A D1 stand-in that records what it was asked to write. */
function fakeDB() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { writes.push({ sql, args }); return { success: true }; },
            async first() { return null; },
            async all() { return { results: [] }; },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
}

const square = (x, y, d = 0.001) => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
});

const body = (over = {}) => ({
  lng: -85.6681,
  lat: 42.9634,
  address: '123 Any Street, Grand Rapids, MI',
  clientId: 'client-abc',
  county: 'Kent County',
  provider: 'naip',
  model: 'sam3',
  mode: 'find',
  handEdited: true,
  detectedSqFt: 3000,
  squareFeet: 4200,
  parcelSqFt: 12000,
  frame: { lng: -85.6681, lat: 42.9634, zoom: 18.5, size: 1280 },
  parcel: square(-85.67, 42.96, 0.003),
  shapes: [{ geometry: square(-85.6681, 42.9634) }],
  ...over,
});

/* ------------------------------------------------------------ it is off */
{
  const off = await recordFinished({}, body());
  check('no database means no corpus, not an error',
    off.ok === false && off.reason === 'off', off.reason);
  check('and corpusEnabled says so plainly',
    corpusEnabled({}) === false && corpusEnabled({ DB: {} }) === true);
  check('a summary with no database is null, not a crash',
    (await corpusSummary({})) === null);
}

/* --------------------------------------------------------------- privacy */
/*
 * THE PROMISE ON SCREEN. index.html tells people the outline is kept and the
 * address is not. These two checks are what make that true: one proves the
 * address and the account never reach the write even when the client sends
 * them, the other proves there is nowhere to put them if they did.
 */
{
  const DB = fakeDB();
  await recordFinished({ DB }, body());
  const sent = JSON.stringify(DB.writes[0].args);

  check('the address never reaches the database',
    !sent.includes('Any Street') && !sent.includes('Grand Rapids,'),
    'the client sent one and it was dropped');

  check('and neither does the client id',
    !sent.includes('client-abc'), 'nothing identifies who measured it');

  const schema = readFileSync(join(root, 'worker/schema.sql'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS corpus'));
  const columns = table.slice(0, table.indexOf(');'));
  check('and the table has nowhere to put them anyway',
    !/\baddress\b/i.test(columns) && !/user_id|client/i.test(columns),
    'no address, user or client column exists');
}

/* ------------------------------------------------------- what it records */
{
  const DB = fakeDB();
  await recordFinished({ DB }, body());
  const { args } = DB.writes[0];

  check('a finished map is written', DB.writes.length === 1);
  check('with what the detector said and what the person ended up with',
    args.includes(3000) && args.includes(4200),
    'both numbers are needed to know how far it moved');
  check('and which imagery it was drawn on',
    args.includes('naip'), 'the export filter depends on this');
  check('and that a person corrected it',
    args.includes(1), 'hand_edited is 1');
}

/*
 * A lawn drawn entirely by hand is a good example and a DIFFERENT kind from a
 * correction, so it is kept with a null where the detector's answer would be
 * rather than a zero, which would read as "the AI found nothing".
 */
{
  const DB = fakeDB();
  await recordFinished({ DB }, body({ model: null, detectedSqFt: null }));
  check('a hand-drawn lawn is kept with no detector figure',
    DB.writes.length === 1 && DB.writes[0].args[9] === null,
    'null, not zero');
}

/* ------------------------------------------------------------- the guards */
{
  const DB = fakeDB();
  check('a map with no shapes is not worth keeping',
    (await recordFinished({ DB }, body({ shapes: [] }))).reason === 'no-shapes');

  check('nor is one with nowhere on earth to put it',
    (await recordFinished({ DB }, body({ lng: null, lat: null, frame: null }))).reason
      === 'no-location');

  /*
   * The frame is where the PHOTOGRAPH was taken, and that is the thing being
   * re-fetched to build a training tile. The geocoded point is only where the
   * address sits, which on a long lot is a different place.
   */
  const framed = fakeDB();
  await recordFinished({ DB: framed }, body({
    lng: 10, lat: 10, frame: { lng: -85.5, lat: 42.5, zoom: 18, size: 1280 },
  }));
  check('the frame decides the location, not the geocoded address',
    framed.writes[0].args[2] === -85.5 && framed.writes[0].args[3] === 42.5,
    'the photograph is what gets re-fetched');

  check('a lawn bigger than any lawn is refused',
    (await recordFinished({ DB }, body({
      shapes: Array.from({ length: 40 }, () => ({
        geometry: {
          type: 'Polygon',
          coordinates: [Array.from({ length: 6000 }, (_, i) => [-85 + i * 1e-6, 42])],
        },
      })),
    }))).reason === 'too-big');
}

/* ------------------------------------------------------------ the dedupe */
/*
 * Finishing, correcting further and finishing again must leave the BEST answer
 * behind, not two near-identical rows that would both be drawn into the same
 * training batch.
 */
{
  const DB = fakeDB();
  await recordFinished({ DB }, body({ squareFeet: 4200 }));
  await recordFinished({ DB }, body({ squareFeet: 4500 }));
  check('the same lawn twice is one row, upserted',
    DB.writes[0].args[0] === DB.writes[1].args[0]
    && /ON CONFLICT\(id\) DO UPDATE/.test(DB.writes[1].sql),
    DB.writes[0].args[0]);

  const other = fakeDB();
  await recordFinished({ DB: other }, body());
  await recordFinished({ DB: other }, body({ mode: 'exclude' }));
  check('but the same lawn measured a different way is a different example',
    other.writes[0].args[0] !== other.writes[1].args[0],
    'find and exclude are two answers worth keeping');
}

/* ------------------------------------------------------ which tile is kept */
/*
 * The owner's rule, after reading Mapbox's and Google's terms: bank the
 * Mapbox tile for anything drawn on Mapbox or Google, and the NAIP tile for
 * anything drawn on the USGS sources. Written down as a test because it is a
 * decision about licences, not a detail -- the next person to add a provider
 * has to make the same call deliberately rather than inherit a default.
 */
{
  check('a lawn drawn on Mapbox banks the Mapbox tile',
    imageSourceFor('mapbox') === 'mapbox');
  check('one drawn on NAIP banks the NAIP tile',
    imageSourceFor('naip') === 'naip');
  check('NDVI banks NAIP, being the same USGS pixels',
    imageSourceFor('ndvi') === 'naip');
  check('one drawn on Google banks Mapbox instead',
    imageSourceFor('google') === 'mapbox',
    "Google's terms are the restrictive ones");
  check('and anything unrecognised lands on Mapbox',
    imageSourceFor('esri') === 'mapbox' && imageSourceFor(undefined) === 'mapbox',
    'the one source this deployment is sure to have a key for');

  check('the bucket key is safe for a URL and a shell',
    imageKeyFor('-85.66810,42.96340:sam3:find', 'mapbox')
      === 'maps/mapbox/-85.66810_42.96340_sam3_find.png',
    imageKeyFor('-85.66810,42.96340:sam3:find', 'mapbox'));
}

/* ------------------------------------------------------------- the picture */
function fakeBucket() {
  const puts = [];
  return { puts, async put(key, body, opts) { puts.push({ key, opts }); } };
}

const frame = { lng: -85.6681, lat: 42.9634, zoom: 18.5, size: 1280 };
const png = () => new Response('x', { headers: { 'content-type': 'image/png' } });

{
  const CORPUS = fakeBucket();
  const DB = fakeDB();
  const realFetch = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (u) => { asked = String(u); return png(); };

  let r;
  try {
    r = await storeImage(
      { CORPUS, DB, MAPBOX_SERVER_TOKEN: 'pk.test' },
      { id: 'a,b:sam3:find', provider: 'google', frame }
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  check('a Google-drawn map fetches the Mapbox tile',
    r.ok && /api\.mapbox\.com/.test(asked), asked?.slice(0, 60));
  check('and the tile is put in the bucket',
    CORPUS.puts.length === 1 && CORPUS.puts[0].key === 'maps/mapbox/a_b_sam3_find.png',
    CORPUS.puts[0]?.key);
  check('and the row is pointed at it, with what was actually stored',
    DB.writes.length === 1 && DB.writes[0].args.includes('mapbox')
      && /UPDATE corpus SET image_key/.test(DB.writes[0].sql),
    'image_provider records the banked source, not the drawn one');
}

/*
 * An imagery server answering a bad request with a JSON apology and a 200 is
 * the normal failure for both of these sources. Storing it would fill the
 * bucket with 200-byte files that count as coverage and contain nothing.
 */
{
  const CORPUS = fakeBucket();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"nope"}', {
    headers: { 'content-type': 'application/json' },
  });
  let r;
  try {
    r = await storeImage(
      { CORPUS, DB: fakeDB(), MAPBOX_SERVER_TOKEN: 'pk.test' },
      { id: 'x', provider: 'mapbox', frame }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  check('an error page is not mistaken for a photograph',
    r.ok === false && r.reason === 'not-an-image' && CORPUS.puts.length === 0);
}

/*
 * No bucket is the normal state until somebody creates one, and it must not
 * look like a fault. The row still holds the frame, so the picture is
 * re-fetchable whenever the bucket turns up.
 */
{
  const r = await storeImage({ DB: fakeDB() }, { id: 'x', provider: 'mapbox', frame });
  check('no bucket bound is a reason, not an error',
    r.ok === false && r.reason === 'no-bucket');

  const noToken = await storeImage(
    { CORPUS: fakeBucket(), DB: fakeDB() },
    { id: 'x', provider: 'mapbox', frame }
  );
  check('and neither is a deployment with no Mapbox key',
    noToken.ok === false && noToken.reason === 'no-token');
}

/*
 * The row must survive the picture failing. These are two separate outcomes
 * and collapsing them would lose a perfectly good outline to somebody else's
 * image server having a bad afternoon.
 */
{
  const DB = fakeDB();
  const saved = await recordFinished({ DB }, body());
  check('recording the row hands back what the image step needs',
    saved.ok && saved.row?.id && saved.row.provider === 'naip' && saved.row.frame,
    'so the caller can defer the fetch to waitUntil');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
