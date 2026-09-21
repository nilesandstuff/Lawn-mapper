/**
 * Proves each imported county before this app claims it.
 *
 * Needs internet, so it runs on a GitHub Actions runner:
 *   Actions -> "10. Verify county parcel servers" -> Run workflow
 *
 * Writes worker/src/counties-verified.js, which is GENERATED and committed.
 *
 * WHY A SEPARATE STEP. counties.js says at the top that everything marked
 * `live` was confirmed by a point query returning a parcel-sized polygon.
 * Importing a thousand endpoints on another project's say-so would retire that
 * rule across the whole file in one commit, and the rule is the only reason any
 * number in this app can be trusted. So the catalogues supply candidates and
 * this supplies the evidence.
 *
 * IT RUNS IN SLICES, because the pool outgrew a single run. 165 candidates took
 * about twenty-five minutes against a forty-five minute ceiling; adding
 * OpenAddresses took the pool to 960, which is something like two and a half
 * hours. A run that cannot finish is a run that commits a half-empty registry,
 * and this file IS the coverage -- a county missing from it is a county the app
 * stops serving.
 *
 * So each run takes the LEAST RECENTLY CHECKED slice, verifies it, and merges
 * the result into what is already there. Counties outside the slice are left
 * exactly as they were. Run it enough times and it works through everything;
 * keep running it and the oldest results are the ones refreshed, which is the
 * re-verification this never had.
 *
 * tools/verify-log.json remembers when each candidate was last tried and what
 * happened. Without it a county that FAILS has no record at all -- it is simply
 * absent from the registry -- so it would be picked first every single run, and
 * the eight hundred behind it would never be reached.
 *
 * HOW IT VERIFIES, and why this is stronger than the hand-aimed points the
 * existing entries use.
 *
 * test-points.js is a list of coordinates picked from memory off a map, and
 * its own header is a catalogue of them landing on university land, a
 * right-of-way, a road, and the wrong side of a county line. A point that
 * returns nothing proves nothing, so every hand-verified county here needed
 * three to five of them and a paragraph explaining the misses.
 *
 * This asks the layer for real parcels first, then queries a point inside one.
 * The point CANNOT land in a river or on unplatted land, because it was
 * derived from a lot the server itself just handed over. One round trip
 * replaces the guesswork:
 *
 *   1. ask for a handful of parcels               -- does the layer answer at all?
 *   2. take a point inside one of them
 *   3. run the app's own point query there        -- does lookup work?
 *   4. measure what comes back                    -- is it parcel-shaped?
 *
 * A county passes only if step 4 gives something between a shed and a farm.
 *
 * THE BOUNDING BOX COMES FROM THE LAYER, not from a county boundary file. The
 * app picks a county by asking which box an address falls in, and what matters
 * there is where the DATA is, not where the county legally is: a layer that
 * covers three townships should not be nominated for the whole county. Asking
 * the service for its own extent answers the question actually being asked.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { esriToGeoJSON } from '../worker/src/parcel.js';
import { measure } from '../public/lib/area.js';
import { candidatePool } from './candidates.js';
import { US_COUNTIES } from '../worker/src/us-counties.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const TIMEOUT_MS = 15000;
/*
 * The one request that walks every record in the layer, so it gets its own
 * budget. See extentOf: a county with a million parcels cannot answer
 * "what is your extent" inside a timeout meant for reading metadata.
 */
const SCAN_TIMEOUT_MS = 60000;
/** Between requests. These are small public assets, not something to hammer. */
const PAUSE_MS = 120;
/** A residential or small rural parcel, matching discover-counties.js. */
const PLAUSIBLE_ACRES = { min: 0.01, max: 160 };
/*
 * How many sample parcels to try before giving up on a county.
 *
 * Raised from 5 by the first spot check, which failed Kent -- a county this
 * app has served correctly for months. Its atlas endpoint is named
 * ParcelsWithCondos, and `where=1=1` hands back records in whatever order the
 * server keeps them, which is usually oldest object id first. A run of condo
 * records at the front of the table is a run of stacked or degenerate
 * footprints, and five of those in a row look exactly like a broken layer.
 *
 * Twelve samples costs twelve small requests on the counties that need them
 * and nothing on the ones that pass first try.
 */
const SAMPLES = 12;

const only = (process.env.ONLY || '').trim();
/*
 * HOW MANY TO CHECK THIS RUN. 200 is about half an hour at the rate above,
 * inside a forty-five minute ceiling with room for the slow ones. Raise it if
 * the runner's limit ever does; do not raise it to finish the pool in one go,
 * because a run that gets cut off partway commits whatever it had.
 */
const LIMIT = Math.max(1, Number(process.env.LIMIT) || 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * A STATEWIDE CLAIM IS TESTED ACROSS THE STATE, not read off an extent.
 *
 * OpenAddresses lists an Ohio statewide source whose URL is one county's own
 * server. Real data, wrongly labelled -- and taken at its word the app would
 * claim most of Ohio on the strength of Trumbull County, then tell everybody
 * else in the state their parcel is simply missing. So the claim has to be
 * checked, and the honest way to check "serves the whole state" is to ask it
 * in several places that are nowhere near each other.
 *
 * WHY NOT THE LAYER'S EXTENT, which is how counties are done. Five of the
 * nineteen report theirs in UTM or State Plane -- Arizona in wkid 26912,
 * Washington in 2927 -- which this deliberately does not convert, because
 * reprojecting by hand is the silent-error factory this app refuses
 * everywhere. Reading the extent would fail all five, and they are real
 * statewide layers. Meanwhile the alternative is better anyway: an extent is
 * the server's claim about itself, and a point query is a measurement.
 *
 * It is also how every hand-written statewide entry in counties.js was
 * proved: four to six coordinates, far apart, and a paragraph about what came
 * back. This is that, with the coordinates derived from the state instead of
 * picked from memory -- which is the half those entries got wrong, repeatedly.
 */
const GRID = 5;               // 5x5 points across the state
const GRID_INSET = 0.12;      // kept off the border, where a point is in the sea
const STATEWIDE_HITS = 5;     // how many must come back with a real parcel
/*
 * A HIT IS ANY REAL PARCEL, not a residential-sized one, and getting this
 * wrong failed three states that work.
 *
 * The 0.01-160 acre range is the right test for a COUNTY, where the sample
 * point comes from inside a lot the server just handed over and anything
 * enormous means the layer is returning outlines instead of parcels. Here the
 * points are a grid over a whole state, so most of them land in countryside:
 * eight of sixteen in Arizona and nine of sixteen in Idaho came back as
 * ranches and range land, which is not a broken layer, it is Arizona.
 *
 * So the only thing worth rejecting is a polygon the size of the state -- a
 * layer handing back a county or state boundary rather than a parcel. A
 * hundred thousand acres is 156 square miles, larger than any real parcel and
 * far smaller than any state.
 */
const MAX_PROBE_ACRES = 100000;
/*
 * And they must be SPREAD. Four hits in one corner is a county server; the
 * span is measured against the state's own box, so it means the same thing in
 * Texas as in Delaware. 0.5 is comfortably clear for anything genuinely
 * statewide and unreachable for one county out of eighty-eight.
 */
const STATEWIDE_SPAN = 0.5;

async function getJson(url, timeout = TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    // ArcGIS answers a bad path with an HTML error page and a 200.
    if (/^\s*</.test(text)) return { error: 'returned HTML, not JSON' };
    try { return JSON.parse(text); } catch { return { error: 'unparseable' }; }
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}

const describe = (e) => (typeof e === 'string' ? e : e?.message || JSON.stringify(e).slice(0, 120));

/*
 * ROUNDED OUTWARD, never inward.
 *
 * A bounding box decides which counties an address is offered to, so shrinking
 * one drops real addresses along its edge -- silently, and only for the people
 * who live there. Three decimals is about 110 m, so a box rounded the ordinary
 * way loses up to that on every side. Floors and ceilings can only ever give
 * the box away, which is the harmless direction: a slightly large box costs one
 * query that returns nothing.
 */
const tidy = (e) => [
  Math.floor(e.xmin * 1000) / 1000, Math.floor(e.ymin * 1000) / 1000,
  Math.ceil(e.xmax * 1000) / 1000, Math.ceil(e.ymax * 1000) / 1000,
];

/*
 * The smallest a county's data can plausibly span, in degrees. About 550 m.
 *
 * Chittenden County, Vermont shipped with [-71.802, 44.786, -71.801, 44.786]:
 * eighty metres wide and, after rounding, exactly zero tall. It passed because
 * the old check ran on the RAW extent and the rounding collapsed it
 * afterwards -- so the stored box was never the thing validated.
 *
 * Both halves are fixed. Validation now runs on the rounded box, because that
 * is what ships; and a floor is imposed, because a degenerate extent is worse
 * than a missing county. A county with a box nothing falls inside is verified,
 * listed, and unreachable -- coverage on paper that never answers.
 *
 * 0.005 is far below any real county (the smallest in the US is several km
 * across) and far above the collapsed boxes this is here to catch.
 */
const MIN_SPAN_DEG = 0.005;

const sane = (box) => {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return false;
  const [w, s, e, n] = box;
  return w < e && s < n
    // A layer spanning half the planet is not a county; something is wrong
    // with its coordinates and a box that wide would nominate it for
    // everything.
    && e - w <= 20 && n - s <= 20
    && e - w >= MIN_SPAN_DEG && n - s >= MIN_SPAN_DEG
    && Math.abs(w) <= 180 && Math.abs(e) <= 180
    && Math.abs(s) <= 90 && Math.abs(n) <= 90;
};

/** An Esri envelope, rounded and checked in the order they actually matter. */
const boxFrom = (envelope) => {
  if (!envelope || ![envelope.xmin, envelope.ymin, envelope.xmax, envelope.ymax]
    .every(Number.isFinite)) return null;
  const box = tidy(envelope);
  return sane(box) ? box : null;
};

/**
 * Web Mercator to WGS84, for servers that ignore outSR on an extent query.
 *
 * The only projection converted by hand, and only because it is the one ArcGIS
 * hands back when it decides to ignore the request -- the numbers arrive in
 * metres from the equator with a wkid of 3857 or 102100. Everything else
 * (State Plane feet and friends) is left to the server, which is the rule the
 * rest of this app follows: reprojecting by hand is a silent-error factory,
 * and two formulas is already one more than is comfortable.
 */
const MERCATOR = new Set([3857, 102100, 900913]);
function fromMercator(e) {
  const lng = (x) => (x / 20037508.34) * 180;
  const lat = (y) => {
    const d = (y / 20037508.34) * 180;
    return (180 / Math.PI) * (2 * Math.atan(Math.exp((d * Math.PI) / 180)) - Math.PI / 2);
  };
  return { xmin: lng(e.xmin), xmax: lng(e.xmax), ymin: lat(e.ymin), ymax: lat(e.ymax) };
}

/**
 * Where this layer actually holds data, in WGS84.
 *
 * THE FIRST FULL SWEEP LOST 46 COUNTIES HERE, including Los Angeles, Cook,
 * Harris, San Diego and Broward -- which is not 46 broken counties, it is one
 * broken assumption. The old version asked for the extent one way, returned
 * null on anything unexpected, and threw the reason away, so every distinct
 * fault arrived as the same four words.
 *
 * Three ways of asking now, because servers disagree about all of them, and
 * whatever goes wrong is reported rather than swallowed.
 */
async function extentOf(service, layer) {
  /*
   * 1. THE LAYER'S OWN METADATA, FIRST, because it is free.
   *
   * This used to ask the query below first and it cost eighteen counties --
   * Cook, Harris, San Diego, Broward, three in New Jersey, three in North
   * Carolina -- every one of them "extent query: timed out". They are not slow
   * servers, they are BIG ones: `where=1=1&returnExtentOnly=true` makes the
   * server walk every record, and Cook County has around 1.8 million parcels.
   * The order punished exactly the counties most worth having.
   *
   * The metadata is a static document with the extent already in it and no
   * scan behind it. Its only drawback is arriving in whatever the layer is
   * stored in, which is why the query is still here as the fallback -- between
   * WGS84 and Web Mercator this covers most services, and a projection this
   * cannot convert is the one case worth paying for a scan.
   */
  const meta = await getJson(`${service}/${layer}?f=json`);
  const raw = meta?.extent;
  const wkid = raw?.spatialReference?.latestWkid || raw?.spatialReference?.wkid;
  if (raw && Number.isFinite(wkid)) {
    if (wkid === 4326) {
      const box = boxFrom(raw);
      if (box) return { box };
    }
    if (MERCATOR.has(wkid)) {
      const box = boxFrom(fromMercator(raw));
      if (box) return { box };
    }
  }
  await sleep(PAUSE_MS);

  /*
   * 2. Make the server do the projection, and the scan, only if it must.
   *
   * GIVEN A MINUTE, because this is the one request here that is expensive by
   * nature and the timeout was costing real counties. Reordering to try the
   * metadata first recovered only one -- the failures still said "extent
   * query: timed out", which means the metadata ANSWERED and its extent was
   * simply in a projection this will not convert. State Plane, almost
   * certainly, on Cook, Harris, three in New Jersey and three in North
   * Carolina.
   *
   * So the scan is genuinely needed for these, and fifteen seconds is not
   * enough to walk 1.8 million parcels. Converting State Plane by hand instead
   * would mean dozens of projections and a class of silent error this app
   * refuses everywhere else; waiting is the cheaper correctness.
   *
   * It only costs time on layers that get this far, and only on a workflow
   * somebody runs by hand.
   */
  /*
   * DO NOT TRY TO MAKE THIS CHEAPER. Two attempts in one night, both of which
   * shipped a worse map than doing nothing:
   *
   *   skipped on a retry     142 -> 135, taking all five New York City
   *                          boroughs, Onondaga, Suffolk, Westchester, Duval,
   *                          Hamilton and Wake
   *   a six-minute pot       142 -> 77
   *
   * Both failed the same way. For the largest counties this scan is the ONLY
   * path to an extent -- their metadata reports it in State Plane, which this
   * deliberately does not convert -- so anything that rations it does not slow
   * those counties down, it deletes them. And rationing first-come across an
   * alphabetical sweep is not "whoever needs it most", it is Alabama and
   * Arizona spending the pot before Cook County is reached.
   *
   * A full sweep takes about twenty-five minutes and the ceiling is
   * forty-five. There is no problem here to solve.
   */
  const q = new URLSearchParams({
    where: '1=1', returnExtentOnly: 'true', outSR: '4326', f: 'json',
  });
  const query = await getJson(`${service}/${layer}/query?${q}`, SCAN_TIMEOUT_MS);
  const scanned = boxFrom(query?.extent);
  if (scanned) return { box: scanned };

  const why = meta?.error
    ? `layer metadata: ${describe(meta.error)}`
    : query?.error
      ? `extent query: ${describe(query.error)}`
      : wkid
        ? `extent is in wkid ${wkid}, which this does not convert, and the extent query gave nothing`
        : 'no extent in either the layer metadata or the query';
  return { error: why };
}

/** A few real parcels, however this server likes to be asked. */
async function sampleParcels(service, layer) {
  const base = {
    where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json',
  };
  /*
   * resultRecordCount first, then without. Several of these servers answer
   * "Pagination is not supported" and return nothing at all -- the bug that
   * made Allegan's and Muskegon's layers look dead in an earlier tool.
   */
  for (const params of [{ ...base, resultRecordCount: String(SAMPLES) }, base]) {
    const data = await getJson(`${service}/${layer}/query?${new URLSearchParams(params)}`);
    if (data.error) continue;
    if (data.features?.length) return data.features.slice(0, SAMPLES);
  }
  return [];
}

/**
 * A point inside a ring. Parcels are near-convex, so the mean of the ring works.
 *
 * BOTH GEOMETRY TYPES, which the first version got wrong. esriToGeoJSON hands
 * back a MultiPolygon whenever a record has more than one outer ring -- a split
 * parcel, or a condo block stored as one row per building -- and there
 * `coordinates[0]` is a POLYGON, an array of rings, not a ring. Averaging it
 * destructures arrays as numbers and produces NaN.
 *
 * It failed closed rather than loudly: a one-ring polygon inside that array has
 * length 1, which trips the `< 3` guard, so the county was reported as having
 * no usable geometry. Kent -- which this app has measured correctly for months
 * -- failed all twelve samples that way.
 */
function insidePoint(geometry) {
  if (!geometry) return null;
  const ring = geometry.type === 'MultiPolygon'
    ? geometry.coordinates?.[0]?.[0]
    : geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let x = 0;
  let y = 0;
  let n = 0;
  for (const p of ring) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    x += p[0];
    y += p[1];
    n++;
  }
  return n >= 3 ? [x / n, y / n] : null;
}

/** The app's own point query, not a variant of it. */
async function parcelAt(service, layer, [lng, lat]) {
  const q = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
  });
  const data = await getJson(`${service}/${layer}/query?${q}`);
  if (data.error || !data.features?.length) return null;
  const geometry = esriToGeoJSON(data.features[0].geometry);
  return geometry ? { geometry, attributes: data.features[0].attributes || {} } : null;
}

/**
 * What layers this service actually publishes, for a candidate that failed.
 *
 * A REASON WITHOUT A REMEDY IS HALF AN ANSWER. "extent query: 400" says the
 * layer index is wrong at least as often as it says the server is broken --
 * point at a table rather than the parcel polygons and the metadata comes back
 * perfectly happy with no extent in it, because a table has no geometry to
 * have an extent of. Gwinnett County, Georgia failed exactly that way on
 * layer 3 of a service called Property_and_Tax.
 *
 * So when one fails, print what else is in there. The service root lists every
 * layer with its name and index, and the right answer is usually sitting in
 * that list with the word "Parcel" in it -- which turns a dead candidate into
 * a one-character edit rather than an afternoon.
 */
async function layersOf(service) {
  const root = await getJson(`${service}?f=json`);
  const all = [...(root?.layers || []), ...(root?.tables || [])];
  return all
    .filter((l) => Number.isFinite(l?.id))
    .map((l) => `${l.id}: ${l.name}${l.type ? ` (${l.type})` : ''}`);
}

/**
 * A layer in this service that looks like it holds parcels.
 *
 * THE CATALOGUE CAN NAME A TABLE. Gwinnett County, Georgia arrived pointing at
 * layer 3 of a service called Property_and_Tax -- the Tax Master Table. A table
 * has no geometry, so it has no extent and cannot compute one, which is a 400
 * on the extent query and looked exactly like a broken county. The parcels
 * were at layer 0, one index away, and the county was counted as a failure.
 *
 * A HAND-EDIT TO THE CANDIDATES FILE DOES NOT SURVIVE, because the importer
 * regenerates it from the catalogue and the catalogue still says 3. So the
 * correction belongs here, where it is applied every run and costs nothing on
 * the counties that never needed it.
 *
 * Named "parcel" and a feature layer, both. "Property" alone matches
 * "Property Improvements Table", and a type check alone would pick Zoning.
 */
function parcelLayerIn(layers) {
  for (const line of layers) {
    const m = String(line).match(/^(\d+):\s*(.+?)\s*\((Feature Layer)\)$/);
    if (m && /parcel/i.test(m[2])) return Number(m[1]);
  }
  return null;
}

/**
 * Does this layer really serve the whole state?
 *
 * See GRID above for why this is a probe rather than an extent read. It asks
 * at sixteen points spread across the state, and passes only if enough of them
 * come back with a parcel-sized polygon AND those hits are far enough apart to
 * rule out one county answering for all of them.
 *
 * THE BOX IT STORES IS THE STATE'S, grown a little, which is what every
 * hand-written statewide entry already uses. The layer's own extent is the
 * right answer for a county -- where the data is, rather than where the county
 * legally ends -- but for a state the two are the same question, and the one
 * measured here is the one that has been checked.
 */
async function verifyStatewide(c) {
  const state = Object.values(US_COUNTIES).find((s) => s.ab === c.state);
  if (!state?.box) return { ok: false, why: `no such state as ${c.state}` };

  const [w, s, e, n] = state.box;
  const at = (i, span, lo) => lo + span * (GRID_INSET + (i * (1 - 2 * GRID_INSET)) / (GRID - 1));
  const points = [];
  for (let ix = 0; ix < GRID; ix++) {
    for (let iy = 0; iy < GRID; iy++) {
      points.push([at(ix, e - w, w), at(iy, n - s, s)]);
    }
  }

  const hits = [];
  let attributes = null;
  let acres = Infinity;
  const tally = { nothing: 0, tiny: 0, huge: 0 };

  for (const p of points) {
    const hit = await parcelAt(c.service, c.layer, p);
    await sleep(PAUSE_MS);
    if (!hit) { tally.nothing++; continue; }
    const m = measure(hit.geometry);
    if (m.acres < PLAUSIBLE_ACRES.min) { tally.tiny++; continue; }
    if (m.acres > MAX_PROBE_ACRES) { tally.huge++; continue; }
    hits.push(p);
    /* The SMALLEST hit is the one worth reporting: it is the evidence that
       this layer holds house-sized lots and not just range land. */
    if (!attributes || m.acres < acres) { attributes = hit.attributes; acres = m.acres; }
  }

  if (hits.length < STATEWIDE_HITS) {
    return {
      ok: false,
      why: `${hits.length} of ${points.length} points across ${c.state} returned a `
        + `parcel (${tally.nothing} nothing, ${tally.tiny} under `
        + `${PLAUSIBLE_ACRES.min} ac, ${tally.huge} over ${MAX_PROBE_ACRES} ac)`,
    };
  }

  const xs = hits.map((p) => p[0]);
  const ys = hits.map((p) => p[1]);
  const dx = (Math.max(...xs) - Math.min(...xs)) / (e - w);
  const dy = (Math.max(...ys) - Math.min(...ys)) / (n - s);
  if (dx < STATEWIDE_SPAN || dy < STATEWIDE_SPAN) {
    return {
      ok: false,
      why: `${hits.length} hits but all within ${Math.round(dx * 100)}% x `
        + `${Math.round(dy * 100)}% of ${c.state} -- a local layer wearing a `
        + 'statewide name',
    };
  }

  /* Grown by a tenth of a degree, because the grid is inset and the state's
     own box is drawn through county centroids: both stop short of the border,
     and a box that stops short of the border loses the people living on it. */
  const box = [
    Math.floor((w - 0.1) * 1000) / 1000, Math.floor((s - 0.1) * 1000) / 1000,
    Math.ceil((e + 0.1) * 1000) / 1000, Math.ceil((n + 0.1) * 1000) / 1000,
  ];
  const has = (name) => name && Object.prototype.hasOwnProperty.call(attributes, name);
  return {
    ok: true,
    box,
    acres,
    hits: hits.length,
    of: points.length,
    fields: {
      pin: has(c.fields.pin) ? c.fields.pin : null,
      address: has(c.fields.address) ? c.fields.address : null,
    },
  };
}

/**
 * Endpoints that MOVED, corrected on the way past.
 *
 * Same reasoning as parcelLayerIn below: the importer regenerates the
 * candidates file from the catalogue, so a hand-edit there does not survive,
 * and the correction has to live where it is applied every run.
 *
 * Virginia is the case this was written for. VGIN renamed the host --
 * gismaps.vdem.virginia.gov no longer resolves at all, vginmaps.vdem.
 * virginia.gov serves the same service at the same path -- and the catalogue
 * still carries the old name. Proved by hand first: eight points from Bristol
 * to Virginia Beach, seven parcels back, across seven different localities.
 *
 * A HOST ONLY, never a path. Rewriting more than the name of the machine
 * would be inventing an endpoint rather than following one that moved, and the
 * verifier's whole job is to be the thing that does not take a URL on trust.
 */
const MOVED_HOSTS = new Map([
  ['gismaps.vdem.virginia.gov', 'vginmaps.vdem.virginia.gov'],
]);

/*
 * THE OTHER FOUR STATEWIDE CANDIDATES ARE NOT RECOVERABLE, checked 2026-09-21.
 *
 * All five failed on the same day with the same line -- "0 of 25 points, 25
 * nothing" -- which is what a dead endpoint looks like rather than a bad
 * dataset, so it was worth asking whether any had simply moved. Only Virginia
 * had. Written down so the next person reading that identical failure does
 * not spend the afternoon finding out again:
 *
 *   MD  geodata.md.gov answers 503, twice, hours apart
 *   OH  webgis.co.trumbull.oh.us does not resolve -- and it is a Trumbull
 *       COUNTY service that the key promoted to statewide, so even alive it
 *       should fail the spread test
 *   OR  the service is there and answers "Token Required": not public
 *   TX  stratmap24_land_parcels_48 is gone and the folder now offers
 *       stratmap_land_parcels_48_most_recent, but that one answers
 *       "Requested operation is not supported by this service" -- a cached
 *       tile service with query disabled, so the rename leads nowhere
 *
 * No replacements were invented for any of them. A URL nobody has proved is
 * the thing this whole file exists to refuse.
 */

function followMove(service) {
  try {
    const url = new URL(String(service));
    const to = MOVED_HOSTS.get(url.hostname);
    if (!to) return service;
    url.hostname = to;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return service;
  }
}

/*
 * THE URL THAT PASSED IS THE URL THAT SHIPS.
 *
 * The first version of this followed the move on the way into verify and then
 * let the caller write the entry from the original candidate, so Virginia was
 * proved against the live host and recorded against the dead one -- a registry
 * claiming coverage it had just disproved, which is worse than no entry at
 * all. So a move is reported back on the result, and the caller records
 * r.service rather than c.service.
 */
async function verify(c) {
  const moved = followMove(c.service);
  if (moved !== c.service) {
    const out = await verify({ ...c, service: moved });
    return out.ok ? { ...out, service: moved, movedFrom: c.service } : out;
  }

  if (c.statewide) return verifyStatewide(c);
  /*
   * THE CATALOGUE ALREADY SAID SO, so do not spend a request finding out.
   *
   * An endpoint whose layerName reads "Tax Master Table" is a table: no
   * geometry, no extent, and a 400 on any attempt to compute one. Gwinnett
   * County, Georgia was written off as a broken county on exactly that 400,
   * with the explanation sitting in the source data the whole time.
   *
   * layerName is null on anything imported before it was carried through, and
   * null falls straight past this into the ordinary path -- so an old
   * candidates file behaves as it always did.
   */
  if (/\btable\b/i.test(String(c.layerName || ''))) {
    const layers = await layersOf(c.service).catch(() => []);
    await sleep(PAUSE_MS);
    const better = parcelLayerIn(layers);
    if (better === null) {
      return { ok: false, why: `the catalogue names layer ${c.layer} a table `
        + 'and no parcel layer was found beside it', layers };
    }
    /* layerName cleared, or this would look at itself again for ever. */
    const out = await verify({ ...c, layer: better, layerName: null });
    await sleep(PAUSE_MS);
    if (out.ok) return { ...out, correctedLayer: better, wasLayer: c.layer };
    return { ok: false, why: `named a table; layer ${better} was no better`, layers };
  }

  const extent = await extentOf(c.service, c.layer);
  await sleep(PAUSE_MS);
  if (extent.error) {
    const layers = await layersOf(c.service).catch(() => []);
    await sleep(PAUSE_MS);

    /*
     * One retry, and only at a layer that names itself parcels. Not a sweep of
     * every index: this runs against public county servers and guessing its
     * way through a service is exactly the sort of traffic that gets a tool
     * blocked.
     */
    const better = parcelLayerIn(layers);
    if (better !== null && better !== c.layer) {
      const second = await verify({ ...c, layer: better });
      await sleep(PAUSE_MS);
      if (second.ok) return { ...second, correctedLayer: better, wasLayer: c.layer };
      return { ok: false, why: `${extent.error} (layer ${better} was no better)`, layers };
    }
    return { ok: false, why: extent.error, layers };
  }
  const box = extent.box;

  const samples = await sampleParcels(c.service, c.layer);
  await sleep(PAUSE_MS);
  if (!samples.length) return { ok: false, why: 'returned no parcels' };

  /*
   * SAY WHY EACH SAMPLE FAILED, not just that they all did.
   *
   * The first spot check reported "no sample point returned a parcel-sized
   * polygon" for Kent and that sentence covers four different faults -- bad
   * geometry, a point that missed, a polygon too small, one too big -- which
   * need four different responses. The same blankness cost a run on Champaign
   * and on Indiana. A tally is cheap and turns a re-run into a diagnosis.
   */
  const tally = { nogeom: 0, missed: 0, tiny: 0, huge: 0 };
  let biggest = 0;
  /*
   * WHAT the unusable geometry actually was. Kent still failed all twelve
   * samples after the MultiPolygon fix, which means the guess about condo
   * rings was not the whole story -- and "no usable geometry" cannot tell a
   * feature with no geometry key from one whose rings are empty from one this
   * still cannot read. One example beats another round of guessing.
   */
  let firstBad = null;

  for (const f of samples) {
    const geometry = esriToGeoJSON(f.geometry);
    const point = geometry && insidePoint(geometry);
    if (!point) {
      tally.nogeom++;
      if (!firstBad) {
        firstBad = !f.geometry
          ? 'the feature carried no geometry at all'
          : !geometry
            ? `esri geometry had keys [${Object.keys(f.geometry).join(', ')}]`
            : `${geometry.type} with ${geometry.coordinates?.length ?? 0} part(s)`;
      }
      continue;
    }

    const hit = await parcelAt(c.service, c.layer, point);
    await sleep(PAUSE_MS);
    if (!hit) { tally.missed++; continue; }

    const { acres } = measure(hit.geometry);
    biggest = Math.max(biggest, acres);
    if (acres < PLAUSIBLE_ACRES.min) { tally.tiny++; continue; }
    if (acres > PLAUSIBLE_ACRES.max) { tally.huge++; continue; }

    /*
     * Confirm the named fields exist on a record that really came back, rather
     * than trusting the atlas's field list. A name that is right in the
     * catalogue and absent from the response prints "undefined" under a
     * measurement -- which is how Kent shipped once before.
     */
    const has = (n) => n && Object.prototype.hasOwnProperty.call(hit.attributes, n);
    return {
      ok: true,
      box,
      acres,
      fields: {
        pin: has(c.fields.pin) ? c.fields.pin : null,
        address: has(c.fields.address) ? c.fields.address : null,
      },
    };
  }
  const parts = [
    tally.nogeom ? `${tally.nogeom} with no usable geometry [${firstBad}]` : null,
    tally.missed ? `${tally.missed} whose own point found nothing` : null,
    tally.tiny ? `${tally.tiny} under ${PLAUSIBLE_ACRES.min} ac` : null,
    tally.huge ? `${tally.huge} over ${PLAUSIBLE_ACRES.max} ac` : null,
  ].filter(Boolean);
  return {
    ok: false,
    why: `${samples.length} samples, none parcel-sized: ${parts.join(', ')}`
      + (biggest ? ` (largest ${Math.round(biggest * 100) / 100} ac)` : ''),
  };
}

const pool = candidatePool();
/*
 * Statewide first, always, and never rationed. Nineteen of them and each is
 * worth more than any county in the pool -- Texas alone is 254 counties -- so
 * spending twenty of the run's two hundred slots on them every time is the
 * best trade available. They are also the entries whose breakage is loudest,
 * which is a reason to re-check them often rather than occasionally.
 */
const everything = [...pool.statewide, ...pool.candidates];

const LOG = resolve(here, 'verify-log.json');
/*
 * WHEN EACH CANDIDATE WAS LAST TRIED, and what happened.
 *
 * Load-bearing for the slicing, not a nicety. A county that FAILS leaves no
 * trace in the registry -- it is simply not there -- so without this it looks
 * unchecked for ever, gets picked first every run, and the pool behind it is
 * never reached. The eight hundred newest candidates would sit behind a
 * handful of broken servers indefinitely.
 */
let log = {};
if (existsSync(LOG)) {
  try { log = JSON.parse(readFileSync(LOG, 'utf8')); } catch { log = {}; }
}

/*
 * THE REGISTRY IS ITS OWN BACKUP. Every verified entry carries the date it was
 * proved, so a log that is lost, corrupted or has simply never seen a county
 * can be seeded from the file the log exists to describe.
 *
 * Without this, deleting verify-log.json would make nine hundred proven
 * counties look untried and send the next several runs re-checking work that
 * was already done, while the genuinely unproven ones waited behind them.
 */
try {
  const existing = await import(
    pathToFileURL(resolve(root, 'worker/src/counties-verified.js')).href
  );
  for (const [key, e] of Object.entries(existing.VERIFIED_COUNTIES || {})) {
    if (!log[key]?.at && e.checked) log[key] = { at: e.checked, ok: true };
  }
} catch { /* First run, or a file too broken to import. Nothing to seed from. */ }

const matches = (c) => c.key === only || c.key.startsWith(`${only}-`);
const chosen = only ? everything.filter(matches) : everything;

if (!chosen.length) {
  console.error(`Nothing matches ONLY="${only}".`);
  process.exit(1);
}

/*
 * OLDEST FIRST, with anything never tried at the very front. `''` sorts before
 * any date, so a new import is worked through before anything is re-checked --
 * which is the right order: an unproven county is coverage the app does not
 * have yet, and a re-check is coverage it already has.
 *
 * The key breaks ties, so a run is reproducible rather than depending on which
 * order two catalogues happened to merge in.
 */
const when = (c) => log[c.key]?.at || '';
/*
 * STATEWIDE ENTRIES JUMP THE QUEUE, every run, and the sort is where that
 * actually happens -- putting them first in the array does nothing once
 * everything is sorted by date, because on a fresh log every candidate has the
 * same empty date and the tie-break is alphabetical. New York would have sat
 * behind four hundred counties beginning with "a".
 *
 * They earn it twice over: each is worth more than any county in the pool --
 * Texas alone is 254 of them -- and each is the entry whose breakage is
 * loudest, so re-checking nineteen of them on every run is the cheapest
 * insurance here.
 */
const list = only
  ? chosen
  : [...chosen]
    .sort((a, b) => (b.statewide ? 1 : 0) - (a.statewide ? 1 : 0)
      || when(a).localeCompare(when(b))
      || a.key.localeCompare(b.key))
    .slice(0, LIMIT);

const never = chosen.filter((c) => !when(c)).length;
console.log(`${everything.length} candidates: ${pool.sources.atlas} from the atlas, `
  + `${pool.sources.openaddresses} from OpenAddresses `
  + `(${pool.sources.joined} in both), ${pool.statewide.length} statewide`);
console.log(`${never} have never been tried; ${chosen.length - never} have.`);
console.log(`\nVerifying ${list.length} this run${only ? ` (ONLY="${only}")` : ''}:\n`);

const passed = [];
const failed = [];
const today = new Date().toISOString().slice(0, 10);

for (const c of list) {
  const r = await verify(c);
  log[c.key] = r.ok
    ? { at: today, ok: true, acres: r.acres }
    : { at: today, ok: false, why: String(r.why).slice(0, 200) };
  if (r.ok) {
    /* The layer that actually answered, which is not always the one the
       catalogue named. See parcelLayerIn. */
    passed.push({
      ...c,
      /* The host that answered, not the one the catalogue named. See verify. */
      service: r.service ?? c.service,
      fallbacks: (c.fallbacks || []).map(followMove),
      layer: r.correctedLayer ?? c.layer,
      box: r.box,
      fields: r.fields,
    });
    const lost = [
      c.fields.pin && !r.fields.pin ? `pin ${c.fields.pin}` : null,
      c.fields.address && !r.fields.address ? `address ${c.fields.address}` : null,
    ].filter(Boolean);
    console.log(`  ok   ${c.key.padEnd(22)} ${r.acres} ac`
      + (r.correctedLayer !== undefined
        ? `  (the catalogue said layer ${r.wasLayer}; parcels are at ${r.correctedLayer})`
        : '')
      + (r.movedFrom ? `  (moved: ${new URL(r.movedFrom).hostname} -> ${new URL(r.service).hostname})` : '')
      + (lost.length ? `  (${lost.join(', ')} not on the record)` : ''));
  } else {
    failed.push({ key: c.key, why: r.why });
    console.log(`  --   ${c.key.padEnd(22)} ${r.why}`);
    /* What else is in that service, so a wrong layer index is a one-character
       fix rather than an afternoon. See layersOf. */
    for (const line of (r.layers || []).slice(0, 12)) {
      console.log(`         ${line}`);
    }
  }
}

console.log(`\n${passed.length} verified, ${failed.length} not.`);


if (only) {
  console.log('\nONLY was set, so nothing was written -- this was a spot check.');
  process.exit(0);
}

const target = resolve(root, 'worker/src/counties-verified.js');

/*
 * WHAT THIS RUN IS ABOUT TO CHANGE, before it changes it.
 *
 * This file IS the coverage. A county that passed last time and whose server
 * happens to be down this morning is simply absent from the new one, and the
 * only symptom is addresses in that county quietly losing their property line
 * -- for everybody, until somebody notices and runs this again on a better
 * day. Nothing in "142 verified of 165" says which 142.
 *
 * There is no vote here about whether to write: a re-verification that refused
 * to record a genuine loss would be worse. What there is, is a sentence naming
 * the counties going out, at the end of the log, where it gets read.
 */
let before = {};
try {
  const old = await import(pathToFileURL(target).href);
  before = old.VERIFIED_COUNTIES || {};
} catch { /* First run, or a file too broken to import. Either way: no report. */ }

/*
 * MERGED, NOT REPLACED, and this is the whole point of running in slices.
 *
 * A run sees two hundred of nine hundred and seventy-nine candidates. Writing
 * only what it proved would delete the other seven hundred and seventy-nine --
 * every one of them a county that verified perfectly last week and would lose
 * its property line tonight. So the previous entries stand, and this run
 * changes only the keys it actually tried.
 */
const kept = {};
const triedNow = new Set(list.map((c) => c.key));
const stillOffered = new Set(everything.map((c) => c.key));
const dropped = [];

for (const [key, entry] of Object.entries(before)) {
  if (triedNow.has(key)) continue; // this run has the last word on these
  /*
   * A county both catalogues have stopped listing cannot be re-verified ever
   * again, so keeping it would be shipping an endpoint nothing can re-check.
   * Rare, and worth a line rather than a silent removal.
   */
  if (!stillOffered.has(key)) { dropped.push(key); continue; }
  kept[key] = entry;
}
for (const c of passed) {
  kept[c.key] = {
    name: c.name,
    ...(c.statewide ? { state: c.state, statewide: true } : { fips: c.fips }),
    service: c.service,
    layer: c.layer,
    fields: c.fields,
    ...(c.fallbacks?.length ? { fallbacks: c.fallbacks } : {}),
    box: c.box,
    checked: today,
  };
}

/* Sorted by key, so a run that changes two counties produces a diff of two
   counties rather than a reshuffle nobody can read. */
const body = Object.keys(kept).sort().map((key) => {
  const e = kept[key];
  const line = (k) => (e[k] === undefined ? '' : `\n    ${k}: ${JSON.stringify(e[k])},`);
  return `  '${key}': {`
    + line('name')
    + line('fips')
    + line('state')
    + line('statewide')
    + line('service')
    + `\n    layer: ${e.layer},`
    + line('fields')
    + line('fallbacks')
    + line('box')
    + line('checked')
    + '\n  },';
}).join('\n');

const statewideCount = Object.values(kept).filter((e) => e.statewide).length;

const file = `/**
 * GENERATED by tools/verify-counties.js. Do not edit by hand.
 *
 * Every entry here passed the same test: the layer handed over real parcels, a
 * point inside one of them was queried back through the app's own
 * point-in-polygon lookup, and what returned measured between ${PLAUSIBLE_ACRES.min}
 * and ${PLAUSIBLE_ACRES.max} acres. Field names were confirmed present on a record
 * that actually came back, not taken from a catalogue.
 *
 * Each box is the LAYER's own extent in WGS84, asked of the server -- where the
 * data is, which is the question the app is really asking, rather than where
 * the county legally ends.
 *
 * WRITTEN IN SLICES. The pool is too big for one run, so each run re-checks the
 * least recently verified part of it and leaves the rest exactly as it was.
 * \`checked\` is when THAT entry was last proved, not when this file was written,
 * and the two are rarely the same day.
 *
 * A STATEWIDE ENTRY IS A MOSAIC, never a promise of the whole state: these are
 * states republishing what each county sends them, and a county that has sent
 * nothing looks identical to a working service from here. Nothing generated
 * carries \`complete\`.
 *
 * Candidates come from @urbankitstudio/atlas (MIT) and from
 * openaddresses/openaddresses (CC0/BSD), imported by tools/import-atlas.js and
 * tools/import-openaddresses.js. Editing this file directly will be
 * overwritten; change an importer or the verifier instead.
 *
 * ${Object.keys(kept).length} entries (${statewideCount} statewide), of ${everything.length} candidates.
 * Last run ${today}: ${passed.length} verified of ${list.length} tried.
 */

const VERIFIED_COUNTIES = {
${body}
};

export { VERIFIED_COUNTIES };
`;

writeFileSync(target, file);
writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
console.log(`\nwrote ${target}`);
console.log(`wrote ${LOG}`);

const now = new Set(Object.keys(kept));
const had = new Set(Object.keys(before));
const gained = [...now].filter((k) => !had.has(k));
/*
 * ONLY THE ONES THIS RUN TRIED can have been lost by it. A county outside the
 * slice is still in `kept` and cannot appear here, which is the difference
 * between "your server failed today" and "we did not get to you".
 */
const lost = [...had].filter((k) => !now.has(k) && triedNow.has(k));

if (gained.length) console.log(`\nNEWLY COVERED (${gained.length}): ${gained.join(', ')}`);
if (dropped.length) {
  console.log(`\nNO LONGER IN ANY CATALOGUE (${dropped.length}): ${dropped.join(', ')}`);
  console.log('Removed, because nothing can re-verify an endpoint nobody lists.');
}
if (lost.length) {
  console.log(`\n${'!'.repeat(64)}`);
  console.log(`\n${lost.length} JUST LOST COVERAGE: ${lost.join(', ')}`);
  console.log('\nThey verified before and did not today. If their servers were');
  console.log('merely having a bad morning, run this again before deploying --');
  console.log('what ships now is a map with those counties missing.');
  console.log(`\n${'!'.repeat(64)}`);
}
if (!gained.length && !lost.length && !dropped.length) console.log('\nCoverage unchanged.');

const untried = everything.filter((c) => !log[c.key]?.at).length;
console.log(`\n${Object.keys(kept).length} covered. ${untried} candidates still never tried.`);
if (untried) {
  console.log(`Run this again to take the next ${Math.min(untried, LIMIT)}.`);
}

if (failed.length) {
  console.log('\nNot verified this run:');
  for (const f of failed) console.log(`  ${f.key.padEnd(22)} ${f.why}`);
  console.log('\nThese are left out rather than shipped unproven.');
}
