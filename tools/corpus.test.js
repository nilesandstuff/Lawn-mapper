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


/* ------------------------------------------------- what is still needed */
/*
 * THE POINT OF THIS GROUP is the lopsided corpora, not the tidy one. A count
 * that says "412 maps" reads like progress whether those are spread over four
 * states or sitting in one cul-de-sac, and the whole reason the panel exists
 * is to tell those two apart. So each case below is a pile that looks healthy
 * by total and is not.
 */
{
  const { corpusGaps, TARGETS } = await import('../worker/src/corpus.js');
  const top = (stats) => corpusGaps(stats)[0].key;

  check('an empty corpus asks for corrections first',
    top({}) === 'corrected',
    'the scarce kind, and the one that decides when there is enough');

  check('a pile of accepted maps with no corrections still asks for corrections',
    top({ total: 900, corrected: 4, blocks: 200, counties: 9, heavyCanopy: 400 }) === 'corrected',
    '900 maps and nothing that says what the detector gets wrong');

  check('many maps down one street asks for spread',
    top({ total: 900, corrected: 400, blocks: 3, counties: 4, heavyCanopy: 300 }) === 'blocks',
    'twenty maps from one street count for little more than one');

  /*
   * The hard slice: lawns where CANOPY DECIDED THE EDGE, not lawns with trees
   * on them. Asked which it meant, the honest answer was the ambiguous-cover
   * one -- and on a wooded street that is every lawn, so a flag for it would
   * have been true everywhere and counted nothing. Only the top grade counts.
   */
  check('a corpus with no heavy canopy asks for heavy canopy',
    top({ total: 900, corpus: 0, corrected: 400, blocks: 200, counties: 9, heavyCanopy: 2 }) === 'heavyCanopy',
    'the known fault is a tree line overshooting, and this cannot tell whether it was fixed');

  check('one county asks for another county',
    top({ total: 900, corrected: 400, blocks: 200, counties: 1, heavyCanopy: 400 }) === 'counties');

  /*
   * Met targets are kept and sorted last rather than dropped. A page that only
   * ever shows what is missing cannot show progress, and "enough" is the thing
   * somebody is working towards seeing.
   */
  const full = corpusGaps({
    total: 2000, corrected: 900, blocks: 300, counties: 20, heavyCanopy: 900,
  });
  check('everything met is reported as met rather than hidden',
    full.length === 5 && full.every((g) => g.done),
    JSON.stringify(full.map((g) => `${g.key}:${g.done}`)));

  const mixed = corpusGaps({
    total: 2000, corrected: 900, blocks: 300, counties: 1, heavyCanopy: 900,
  });
  check('and a met target never outranks an unmet one',
    mixed[0].key === 'counties' && mixed.slice(1).every((g) => g.done),
    mixed.map((g) => g.key).join(', '));

  check('progress never reads over 100%',
    corpusGaps({ total: 99999 }).find((g) => g.key === 'maps').share === 1);
  check('and nonsense counts do not produce a negative bar',
    corpusGaps({ total: 'banana' }).find((g) => g.key === 'maps').share === 0);

  check('the targets are the ones the doc argues for',
    TARGETS.corrected === 300 && TARGETS.counties === 5 && TARGETS.blocks === 60,
    JSON.stringify(TARGETS));
}

/* ------------------------------------ the three things that were not logged */
{
  const { testDb } = await import('./d1.js');
  const { recordFinished } = await import('../worker/src/corpus.js');
  const env = { DB: testDb() };

  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  const poly = (lng) => ({ type: 'Polygon', coordinates: [ring(lng)] });

  await recordFinished(env, {
    lng: -85.7, lat: 42.9, model: 'sam-3', mode: 'exclude',
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.7)] }],
    detectedShapes: [{ geometry: poly(-85.7001) }],
    parcelSource: 'county',
    exclusions: ['woods', 'driveway'],
    detectedSqFt: 6000, squareFeet: 4000,
  });
  const row = await env.DB.prepare('SELECT * FROM corpus').first();

  /*
   * THE DETECTOR'S OWN OUTLINE, which was being thrown away. `detected_sq_ft`
   * says how far the answer moved; only this says WHERE it was wrong, and the
   * overshoot cannot be measured from two totals.
   */
  check('the AI\'s own outline is kept, not just its total',
    JSON.parse(row.detected_shapes)[0].coordinates[0].length === 5,
    row.detected_shapes?.slice(0, 40));
  check('and it is a different shape from the finished one',
    row.detected_shapes !== row.shapes,
    'otherwise there is nothing to compare');

  check('the property line records where it came from', row.parcel_source === 'county');

  /* THE LINE THE AI TRACED AGAINST (owner, 2026-10-02): kept with the trace,
     and a later finish with the line moved but no new detection leaves it. */
  await recordFinished(env, {
    lng: -85.6, lat: 42.9, model: 'alpha', mode: 'find',
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.6)] }],
    detectedShapes: [{ geometry: poly(-85.6) }],
    parcel: poly(-85.6005), detectedParcel: poly(-85.6005), squareFeet: 4000,
  });
  await recordFinished(env, {
    lng: -85.6, lat: 42.9, model: 'alpha', mode: 'find',
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.6)] }],
    parcel: poly(-85.6009), squareFeet: 4000,
  });
  const moved = await env.DB.prepare('SELECT parcel, detected_parcel FROM corpus WHERE lng = ?1').bind(-85.6).first();
  check('the property line the AI traced against is kept, and a later move does not rewrite it',
    JSON.parse(moved.detected_parcel).coordinates[0][0][0] === -85.6005
    && JSON.parse(moved.parcel).coordinates[0][0][0] === -85.6009,
    JSON.stringify(moved).slice(0, 160));
  check('and which exclusions ran', row.exclusions === 'woods,driveway');

  /* A hand-drawn lawn has no detection to compare against -- null, not empty. */
  await recordFinished(env, {
    lng: -85.8, lat: 42.9, mode: 'manual',
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.8)] }],
    parcelSource: 'hand',
    squareFeet: 3000,
  });
  const drawn = await env.DB.prepare(
    'SELECT * FROM corpus WHERE parcel_source = ?1'
  ).bind('hand').first();
  check('a hand-drawn lawn stores no detected outline at all',
    drawn.detected_shapes === null,
    '"never detected" and "detected nothing" are different examples');

  /*
   * A DETECTION THAT FOUND NOTHING is the detector being wrong in the most
   * complete way available, and is stored as an empty list rather than
   * collapsed into the null above.
   */
  await recordFinished(env, {
    lng: -85.9, lat: 42.9, model: 'sam-3', mode: 'find',
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.9)] }],
    detectedShapes: [],
    detectedSqFt: 0, squareFeet: 5000,
  });
  const nothing = await env.DB.prepare(
    'SELECT detected_shapes FROM corpus WHERE lng = ?1'
  ).bind(-85.9).first();
  check('but a detection that found nothing is stored as nothing found',
    nothing.detected_shapes === '[]',
    'which is a real example, not a missing one');

  check('a junk parcel source is dropped rather than stored as a third kind',
    (await (async () => {
      await recordFinished(env, {
        lng: -86.1, lat: 42.9, mode: 'manual',
        shapes: [{ type: 'Polygon', coordinates: [ring(-86.1)] }],
        parcelSource: 'whatever', squareFeet: 100,
      });
      const r = await env.DB.prepare('SELECT parcel_source FROM corpus WHERE lng = ?1')
        .bind(-86.1).first();
      return r.parcel_source;
    })()) === null);
}

/* ------------------------------------------------ the review queue's order */
/*
 * SCARCITY DECIDES, not the map's own merits. A tree-line lawn is worth a lot
 * when there are nine and very little when there are four hundred, so each
 * term switches off once its target is met -- otherwise the queue spends
 * somebody's afternoon deepening a pile that is already deep enough.
 */
{
  const { candidateScore } = await import('../worker/src/corpus.js');
  const bare = { detected_sq_ft: 5000, square_feet: 5000, image_key: 'k' };
  const score = (row, have) => candidateScore({ ...bare, ...row }, have).score;

  const nothingYet = {};
  check('a correction outranks an accepted map',
    score({ detected_sq_ft: 6000, square_feet: 4000 }, nothingYet) > score({}, nothingYet));
  check('a hand-drawn lawn counts as a correction',
    score({ detected_sq_ft: null, square_feet: 4000 }, nothingYet) > score({}, nothingYet),
    'there was no detection to agree with');
  check('a tree line is worth surfacing',
    score({ exclusions: 'woods' }, nothingYet) > score({}, nothingYet));
  check('and a county with nothing approved in it outranks a tree line',
    score({ new_county: 1 }, nothingYet) > score({ exclusions: 'woods' }, nothingYet));

  /*
   * THE PART THAT MAKES IT A QUEUE RATHER THAN A RANKING. Once 300 corrections
   * are in, another correction stops being the most valuable thing in the
   * world and a thin county takes over.
   */
  const plenty = { corrected: 400, heavyCanopy: 400, blocks: 200, counties: 40 };
  check('a met target stops pulling rows to the top',
    score({ detected_sq_ft: 6000, square_feet: 4000 }, plenty) === score({}, plenty),
    'another correction is worth nothing once there are four hundred');
  check('and with everything met, nothing is prioritised over anything',
    score({ exclusions: 'woods', new_county: 1, new_block: 1 }, plenty) === score({}, plenty));

  check('a map with no photograph sinks',
    score({ image_key: null }, nothingYet) < score({}, nothingYet),
    'still reviewable, but nothing can be trained on it as it stands');
  check('though a valuable one with no photograph still beats a dull one with',
    score({ image_key: null, detected_sq_ft: null, new_county: 1 }, nothingYet)
      > score({}, nothingYet));

  const { why } = candidateScore(
    { ...bare, detected_sq_ft: null, exclusions: 'woods', new_county: 1 }, nothingYet
  );
  check('and it says why it was surfaced', why.length === 3, why.join(' / '));
}

/* ------------------------------------------- inferred, not seen */
/*
 * THE FLAG HAS TO SURVIVE THE ONE LINE THAT NEARLY ATE IT.
 *
 * cleanShapes reduced every feature to a bare geometry, which was harmless
 * while there was nothing on a feature worth keeping. The moment a shape could
 * be marked "I know this is lawn, I cannot see it", that line became a place
 * where the mark left the browser, crossed the wire, and disappeared one step
 * before the database -- set by the reviewer, absent from the training, with
 * nothing anywhere saying so.
 *
 * The training cannot tell a detector that bridges what cannot be seen from
 * one that has stopped looking at what can, unless this arrives.
 */
{
  const DB = fakeDB();
  await recordFinished({ DB }, body({
    shapes: [
      { geometry: square(-85.6681, 42.9634) },
      { properties: { inferred: true }, geometry: square(-85.6691, 42.9634) },
    ],
  }));
  const args = DB.writes[0].args;
  /* The parcel is a Polygon too, so match the shapes array by its shape: a
     JSON list, which the parcel never is. */
  const stored = JSON.parse(args.find(
    (a) => typeof a === 'string' && a.startsWith('[') && a.includes('Feature')
  ));

  check('the inferred mark reaches the database',
    stored.some((f) => f.properties?.inferred === true),
    `stored ${JSON.stringify(stored).slice(0, 120)} -- a mark that does not `
    + 'arrive is a mark the reviewer set for nothing');
  check('and an unmarked shape is not quietly marked with it',
    stored.filter((f) => f.properties?.inferred === true).length === 1,
    'marking visible ground as inferred is what teaches a detector to stop '
    + 'looking, so the flag must never spread');
  check('every shape is stored as a Feature so there is somewhere to put it',
    stored.every((f) => f.type === 'Feature' && f.geometry?.type === 'Polygon'),
    'bare geometries have no properties, which is how the flag was lost');

  check('one marked shape settles that somebody looked at this map',
    args.some((a) => typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a)),
    'without a checked-at the map sits in the catch-up queue for ever, '
    + 'however many areas were marked on it');
}

{
  /*
   * And the reverse does NOT hold. A map with nothing marked is either one
   * with nothing to mark or one nobody has been asked about, and only a person
   * can tell those apart -- so it stays unchecked and stays in the queue.
   */
  const DB = fakeDB();
  await recordFinished({ DB }, body());
  const args = DB.writes[0].args;
  check('but no marks does not count as having looked',
    args.filter((a) => typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a)).length === 1,
    'nothing marked would then mean checked, the queue would start empty, and '
    + 'no existing map would ever be examined');
}

/* ------------------------------------------ re-saving the row you opened */
{
  /*
   * THE DUPLICATE-LAWN BUG, as a test.
   *
   * The id is built from the frame centre at five decimal places -- about a
   * metre -- and the upsert UPDATES the frame while leaving the id alone. So a
   * map whose frame moved since it was created carries an id that no longer
   * matches its own coordinates, and re-saving it derived a different key and
   * wrote a SECOND row. Two rows seen in the database, same lawn, same model,
   * same mode, longitudes -85.64033 and -85.64029: three metres apart, one
   * carrying the reviewer's inferred marks and one not, both approved.
   *
   * Leave-one-out then trains on one copy and tests on its twin, and reports a
   * number far better than the model has earned. This is not untidiness, it is
   * a lie in the measurement.
   */
  const DB = fakeDB();
  const opened = '-85.64033,43.07105:sam3:find';
  await recordFinished({ DB }, body({
    id: opened,
    /* The frame has drifted since the row was made, exactly as it does on the
       round trip through a review. */
    frame: { lng: -85.64029, lat: 43.07105, zoom: 18.5, size: 1280 },
  }));

  check('a re-save lands on the row it opened, not a new one three metres away',
    DB.writes[0].args.includes(opened),
    `wrote ${DB.writes[0].args[0]} -- deriving the key again is what made the `
    + 'same lawn exist twice');

  const fresh = fakeDB();
  await recordFinished({ DB: fresh }, body());
  check('and a fresh measurement still derives its own',
    typeof fresh.writes[0].args[0] === 'string'
    && fresh.writes[0].args[0].includes(':sam3:find'),
    `${fresh.writes[0].args[0]} -- a new map has no row yet to be told about`);

  const junk = fakeDB();
  await recordFinished({ DB: junk }, body({ id: 'DROP TABLE corpus' }));
  check('an id that is not id-shaped is ignored rather than written',
    junk.writes[0].args[0] !== 'DROP TABLE corpus',
    'a key nothing can find again scatters rows worse than a duplicate does');
}

/* ------------------------------------------ the owner's not-lawn traces */
/*
 * Tinker mode (2026-09-29): a finish that sends traces stores them; one that
 * sends none -- every ordinary finish -- sends null, which the upsert's
 * COALESCE reads as "leave what is stored alone".
 */
{
  const withTraces = fakeDB();
  await recordFinished({ DB: withTraces }, body({ notLawn: [square(-85.667, 42.963)] }));
  const w = withTraces.writes[0];
  const stored = w.args[20];
  check('not-lawn traces are stored as ?21',
    typeof stored === 'string' && JSON.parse(stored).length === 1 && JSON.parse(stored)[0].type === 'Polygon',
    String(stored).slice(0, 80));
  check('and the upsert keeps the stored traces when a finish sends none',
    /not_lawn = COALESCE\(\?21, corpus\.not_lawn\)/.test(w.sql), 'COALESCE on ?21');

  const without = fakeDB();
  await recordFinished({ DB: without }, body());
  const none = without.writes[0].args;
  check('an ordinary finish sends null, not an empty list',
    none[20] === null, String(none[20]));

  const emptied = fakeDB();
  await recordFinished({ DB: emptied }, body({ notLawn: [] }));
  const e = emptied.writes[0].args;
  check('removing them all sends an empty list, which replaces them',
    e[20] === '[]', String(e[20]));

  const schema = readFileSync(join(root, 'worker/schema.sql'), 'utf8');
  const migrations = readFileSync(join(root, 'worker/migrations.sql'), 'utf8');
  check('the column is in the CREATE and has its ALTER for databases already out there',
    /\bnot_lawn\s+TEXT/.test(schema) && /ALTER TABLE corpus ADD COLUMN not_lawn TEXT/.test(migrations));
}

/* ---------------------------- which trained-model release drew it (loop 1) */
{
  const alpha = fakeDB();
  await recordFinished({ DB: alpha }, body({ model: 'alpha', modelVersion: '2026-09-29T20:00:00Z', detectedShapes: [square(-85.667, 42.963)] }));
  const a = alpha.writes[0];
  check('the release is stored as ?22', a.args[21] === '2026-09-29T20:00:00Z', String(a.args[21]));
  check('and it travels with the detector outline, not on its own',
    /model_version = CASE WHEN \?16 IS NOT NULL THEN \?22 ELSE corpus\.model_version END/.test(a.sql));
  const sam = fakeDB();
  await recordFinished({ DB: sam }, body());
  check('a SAM finish stores no release', sam.writes[0].args[21] === null, String(sam.writes[0].args[21]));
  const schema = readFileSync(join(root, 'worker/schema.sql'), 'utf8');
  const migrations = readFileSync(join(root, 'worker/migrations.sql'), 'utf8');
  check('model_version is in the CREATE and has its ALTER',
    /\bmodel_version\s+TEXT/.test(schema) && /ALTER TABLE corpus ADD COLUMN model_version TEXT/.test(migrations));
  for (const col of ['uncertainty REAL', 'scored_model TEXT', 'scored_at TEXT']) {
    const [name, type] = col.split(' ');
    check(`lawn_jobs.${name} is in the CREATE and has its ALTER`,
      new RegExp(`\\b${name}\\s+${type}`).test(schema)
      && migrations.includes(`ALTER TABLE lawn_jobs ADD COLUMN ${col};`));
  }
}

/* ---------------------------- the county photo a map was made on, and its line-up */
/*
 * Owner, 2026-10-04: saved on a lined-up county photo, the map reopened with
 * the photo measured afresh and the outlines off it. The service and the
 * line-up are kept with the row so the editor can put the photo back.
 */
{
  const { testDb } = await import('./d1.js');
  const DB = testDb();
  const { row: { id } } = await recordFinished({ DB }, body({ provider: 'county', countySvc: 7,
    countyAlign: { east: 1.234567, north: -0.5, scale: 1.0025, source: 'person' } }));
  let r = await DB.prepare('SELECT county_svc, county_align FROM corpus WHERE id = ?1').bind(id).first();
  check('a map saved on a county photo keeps which photo and how it was lined up',
    r?.county_svc === '7' && JSON.parse(r.county_align || 'null')?.source === 'person'
      && JSON.parse(r.county_align).east === 1.23, JSON.stringify(r));
  await recordFinished({ DB }, body({ provider: 'mapbox' }));
  r = await DB.prepare('SELECT county_svc, county_align FROM corpus WHERE id = ?1').bind(id).first();
  check('saved again on Mapbox, the county line-up is left alone', r?.county_svc === '7' && Boolean(r.county_align), JSON.stringify(r));
  await recordFinished({ DB }, body({ provider: 'county', countySvc: 9, countyAlign: null }));
  r = await DB.prepare('SELECT county_svc, county_align FROM corpus WHERE id = ?1').bind(id).first();
  check('saved on another county photo, its line-up replaces the old one, even with none',
    r?.county_svc === '9' && r.county_align === null, JSON.stringify(r));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
