/**
 * Proves each imported atlas county before this app claims it.
 *
 * Needs internet, so it runs on a GitHub Actions runner:
 *   Actions -> "6. Verify atlas counties" -> Run workflow
 *
 * Writes worker/src/counties-atlas.js, which is GENERATED and committed.
 *
 * WHY A SEPARATE STEP. counties.js says at the top that everything marked
 * `live` was confirmed by a point query returning a parcel-sized polygon.
 * Importing 160 endpoints on another project's say-so would retire that rule
 * across the whole file in one commit, and the rule is the only reason any
 * number in this app can be trusted. So the atlas supplies candidates and this
 * supplies the evidence.
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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esriToGeoJSON } from '../worker/src/parcel.js';
import { measure } from '../public/lib/area.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const TIMEOUT_MS = 15000;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

/**
 * Where this layer actually holds data, in WGS84.
 *
 * Asked of the server rather than converted from the layer metadata's own
 * spatial reference, because that arrives in whatever projection the county
 * uses -- State Plane feet, Web Mercator -- and reprojecting by hand is a
 * whole class of silent error this app has avoided everywhere else by making
 * ArcGIS do it. outSR=4326 is the same trick parcel.js uses on every query.
 */
async function extentOf(service, layer) {
  const q = new URLSearchParams({
    where: '1=1', returnExtentOnly: 'true', outSR: '4326', f: 'json',
  });
  const data = await getJson(`${service}/${layer}/query?${q}`);
  const e = data?.extent;
  if (!e || ![e.xmin, e.ymin, e.xmax, e.ymax].every(Number.isFinite)) return null;
  // A layer that spans half the planet is not a county; something is wrong
  // with its coordinates and a box that wide would nominate it for everything.
  if (e.xmax - e.xmin > 20 || e.ymax - e.ymin > 20) return null;
  return [
    Math.round(e.xmin * 1000) / 1000, Math.round(e.ymin * 1000) / 1000,
    Math.round(e.xmax * 1000) / 1000, Math.round(e.ymax * 1000) / 1000,
  ];
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

/** A point inside a ring. Parcels are near-convex, so the mean of the ring works. */
function insidePoint(geometry) {
  const ring = geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) { x += lng; y += lat; }
  return [x / ring.length, y / ring.length];
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

async function verify(c) {
  const box = await extentOf(c.service, c.layer);
  await sleep(PAUSE_MS);
  if (!box) return { ok: false, why: 'no usable extent' };

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

  for (const f of samples) {
    const geometry = esriToGeoJSON(f.geometry);
    const point = geometry && insidePoint(geometry);
    if (!point) { tally.nogeom++; continue; }

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
    tally.nogeom ? `${tally.nogeom} with no usable geometry` : null,
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

const imported = JSON.parse(readFileSync(resolve(here, 'atlas-candidates.json'), 'utf8'));
const list = only
  ? imported.candidates.filter((c) => c.key === only || c.key.startsWith(`${only}-`))
  : imported.candidates;

if (!list.length) {
  console.error(`Nothing matches ONLY="${only}".`);
  process.exit(1);
}

console.log(`Verifying ${list.length} of ${imported.candidates.length} candidates`
  + ` from atlas ${imported.atlasVersion}\n`);

const passed = [];
const failed = [];

for (const c of list) {
  const r = await verify(c);
  if (r.ok) {
    passed.push({ ...c, box: r.box, fields: r.fields });
    const lost = [
      c.fields.pin && !r.fields.pin ? `pin ${c.fields.pin}` : null,
      c.fields.address && !r.fields.address ? `address ${c.fields.address}` : null,
    ].filter(Boolean);
    console.log(`  ok   ${c.key.padEnd(22)} ${r.acres} ac`
      + (lost.length ? `  (${lost.join(', ')} not on the record)` : ''));
  } else {
    failed.push({ key: c.key, why: r.why });
    console.log(`  --   ${c.key.padEnd(22)} ${r.why}`);
  }
}

console.log(`\n${passed.length} verified, ${failed.length} not.`);

if (only) {
  console.log('\nONLY was set, so nothing was written -- this was a spot check.');
  process.exit(0);
}

const body = passed.map((c) => {
  const fb = c.fallbacks?.length
    ? `\n    fallbacks: ${JSON.stringify(c.fallbacks)},`
    : '';
  return `  '${c.key}': {
    name: ${JSON.stringify(c.name)},
    fips: ${JSON.stringify(c.fips)},
    service: ${JSON.stringify(c.service)},
    layer: ${c.layer},
    fields: ${JSON.stringify(c.fields)},${fb}
    box: ${JSON.stringify(c.box)},
  },`;
}).join('\n');

const file = `/**
 * GENERATED by tools/verify-atlas.js. Do not edit by hand.
 *
 * Every county here passed the same test: the layer handed over real parcels,
 * a point inside one of them was queried back through the app's own
 * point-in-polygon lookup, and what returned measured between ${PLAUSIBLE_ACRES.min}
 * and ${PLAUSIBLE_ACRES.max} acres. Field names were confirmed present on a record
 * that actually came back, not taken from a catalogue.
 *
 * Each box is the LAYER's own extent in WGS84, asked of the server -- where the
 * data is, which is the question the app is really asking, rather than where
 * the county legally ends.
 *
 * Candidates come from @urbankitstudio/atlas (MIT), imported by
 * tools/import-atlas.js into tools/atlas-candidates.json. Editing this file
 * directly will be overwritten; change the importer or the verifier instead.
 *
 * atlas ${imported.atlasVersion}, imported ${imported.importedAt}
 * ${passed.length} verified of ${list.length} tried, on ${new Date().toISOString().slice(0, 10)}
 */

const ATLAS_COUNTIES = {
${body}
};

export { ATLAS_COUNTIES };
`;

const target = resolve(root, 'worker/src/counties-atlas.js');
writeFileSync(target, file);
console.log(`\nwrote ${target}`);

if (failed.length) {
  console.log('\nNot verified:');
  for (const f of failed) console.log(`  ${f.key.padEnd(22)} ${f.why}`);
  console.log('\nThese are left out rather than shipped unproven.');
}
