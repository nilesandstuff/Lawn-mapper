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

import { recordFinished, corpusSummary, corpusEnabled } from '../worker/src/corpus.js';
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
