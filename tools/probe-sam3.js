/**
 * A full dress rehearsal of the detection pipeline, once per prompt wording.
 *
 * The prompt is the entire interface now, so choosing it by guesswork -- or by
 * comparing mask file sizes -- is not good enough. This runs what the app runs:
 * fetch the real parcel from the county, frame it the way the app frames it,
 * segment, clip to the property line, trace, and report the square footage.
 *
 * That makes the comparison judgeable. A prompt that grabs the neighbours'
 * grass shows up as a large drop when clipping is applied; one that misses
 * dormant turf shows up as an implausibly small lawn.
 *
 * THIS COSTS MONEY: one prediction per prompt.
 *
 *   MAPBOX_TOKEN=pk... REPLICATE_TOKEN=r8_... node tools/probe-sam3.js
 */

import { PNG } from 'pngjs';
import { lookupParcel } from '../worker/src/parcel.js';
import { measure, geometryAreaSqM } from '../public/lib/area.js';
import { rasterizePolygon, maskToPolygons, binarize } from '../public/lib/mask.js';
import {
  zoomToFit, geometryBounds, lngLatToFramePx, framePxToLngLat, metresPerPixel,
} from '../public/lib/mercator.js';

/*
 * Same rule as the Worker: a machine calling Mapbox sends no Referer, so it
 * cannot use a URL-restricted token. Prefer the server token when there is
 * one, and fall back for setups that still share a single unrestricted key.
 */
const mapbox = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs a Mapbox token (MAPBOX_SERVER_TOKEN or MAPBOX_TOKEN) and REPLICATE_TOKEN.');
  process.exit(1);
}

const MODEL = process.env.SAM3_MODEL || 'mattsays/sam3-image';
const auth = { Authorization: `Bearer ${replicate}` };

const PROMPTS = (process.env.PROMPTS || 'grass')
  .split('|').map((p) => p.trim()).filter(Boolean);

/**
 * Confidence thresholds to try.
 *
 * Prompt wording turned out not to be the interesting variable -- "grass",
 * "lawn" and "grass lawn" agreed to within 0.6% on a green lot. Whole sections
 * going missing is a different failure, and one that varies between runs of the
 * SAME prompt, which points at the confidence cut rather than the wording: a
 * shaded or dormant patch scores lower than a bright green one, and either
 * lands above the line or does not.
 *
 * An empty entry means "send no threshold at all", i.e. whatever the model
 * defaults to -- the behaviour in production today, and the baseline every
 * other row has to beat.
 */
const THRESHOLDS = (process.env.THRESHOLDS ?? '')
  .split(',').map((t) => t.trim());

/** Every combination to run, as the table's rows. */
const RUNS = [];
for (const prompt of PROMPTS) {
  for (const t of THRESHOLDS) {
    RUNS.push({ prompt, threshold: t === '' ? null : Number(t) });
  }
}

/* ------------------------------------------- the real parcel, really fetched */
/*
 * Pick an ordinary house, not just any parcel.
 *
 * The first run used a 3.3-acre lot, which is not what this product is for and
 * makes the numbers unreadable: a normal lawn is a rounding error on a lot
 * that size. These are candidate residential points; the first one whose
 * parcel is house-sized wins.
 */
const CANDIDATES = [
  { lng: -85.8637, lat: 42.8703, label: 'Hudsonville' },
  { lng: -85.8600, lat: 42.8720, label: 'Hudsonville N' },
  { lng: -85.7975, lat: 42.9075, label: 'Jenison' },
  { lng: -85.7940, lat: 42.9050, label: 'Jenison S' },
  { lng: -86.2100, lat: 43.0631, label: 'Grand Haven' },
];

const HOUSE_SQFT = [3000, 30000]; // roughly 0.07 to 0.7 acres

let parcel = null;
let picked = null;

/*
 * A specific address beats a candidate list when chasing a reported problem.
 * "It missed the back lawn at this house" is only reproducible at that house.
 */
if (process.env.ADDRESS) {
  const res = await fetch(
    'https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({
      q: process.env.ADDRESS,
      access_token: mapbox,
      country: 'us',
      types: 'address',
      limit: '1',
    })
  );
  const feature = (await res.json()).features?.[0];
  if (!feature) {
    console.error(`FAIL  Could not geocode "${process.env.ADDRESS}".`);
    process.exit(1);
  }
  const [lng, lat] = feature.geometry.coordinates;
  picked = { lng, lat, label: feature.properties?.full_address || process.env.ADDRESS };
  parcel = await lookupParcel(lng, lat);
  if (!parcel) {
    console.error(`FAIL  No parcel at ${picked.label}.`);
    process.exit(1);
  }
  console.log(`  ${picked.label}: ${measure(parcel.geometry).squareFeet.toLocaleString()} sq ft <- as asked`);
}

for (const c of parcel ? [] : CANDIDATES) {
  const p = await lookupParcel(c.lng, c.lat);
  if (!p) { console.log(`  ${c.label}: no parcel`); continue; }
  const a = measure(p.geometry);
  const ok = a.squareFeet >= HOUSE_SQFT[0] && a.squareFeet <= HOUSE_SQFT[1];
  console.log(`  ${c.label}: ${a.squareFeet.toLocaleString()} sq ft ${ok ? '<- using this one' : '(not house-sized)'}`);
  if (ok) { parcel = p; picked = c; break; }
}

if (!parcel) {
  console.error('FAIL  None of the candidate points returned a house-sized parcel.');
  process.exit(1);
}
console.log('');

const parcelArea = measure(parcel.geometry);
const bbox = geometryBounds(parcel);
const SIZE = 640;
const frame = {
  lng: (bbox[0] + bbox[2]) / 2,
  lat: (bbox[1] + bbox[3]) / 2,
  zoom: zoomToFit(bbox, SIZE),
  size: SIZE,
};
const IMG = SIZE * 2;

console.log(`parcel:  ${parcelArea.squareFeet.toLocaleString()} sq ft (${parcelArea.acres} ac) at ${picked.label}`);
console.log(`frame:   z${frame.zoom} @ ${IMG}px -> ${(metresPerPixel(frame, IMG) * 100).toFixed(1)} cm/px`);

const imageUrl =
  `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
  `${frame.lng},${frame.lat},${frame.zoom},0/${SIZE}x${SIZE}@2x` +
  `?access_token=${mapbox}&attribution=false&logo=false`;

/*
 * Rasterise the property line into the same pixel grid the app will use, so
 * "clipped" here means exactly what it will mean in production.
 */
const rings = parcel.geometry.type === 'Polygon'
  ? parcel.geometry.coordinates
  : parcel.geometry.coordinates[0];

const clipAt = (w, h) =>
  rasterizePolygon(rings, w, h, (ll) => lngLatToFramePx(frame, ll, w, h));

const parcelPx = clipAt(IMG, IMG).reduce((n, v) => n + v, 0);
console.log(`clip:    ${parcelPx.toLocaleString()} px inside the property line ` +
  `(${((parcelPx / (IMG * IMG)) * 100).toFixed(1)}% of frame)\n`);

const model = await (await fetch(`https://api.replicate.com/v1/models/${MODEL}`, { headers: auth })).json();
const version = model.latest_version?.id;
if (!version) {
  console.error(`FAIL  ${MODEL} has no runnable version.`);
  process.exit(1);
}
console.log(`model:   ${MODEL} @ ${version.slice(0, 12)}…`);

/*
 * Say what the threshold field actually is before sweeping it. Its default and
 * direction are the model's to define, and guessing at either turns a
 * measurement into a coin toss -- a "lower is more inclusive" assumption is
 * worth exactly nothing if the model means the opposite.
 */
const spec = model.latest_version?.openapi_schema
  ?.components?.schemas?.Input?.properties?.threshold;
if (spec) {
  console.log(`threshold: default ${spec.default ?? '(none)'}` +
    (spec.minimum !== undefined ? `, range ${spec.minimum}–${spec.maximum}` : '') +
    (spec.description ? `\n           ${spec.description.slice(0, 120)}` : ''));
} else {
  console.log('threshold: this model publishes no such input — sweeping it will do nothing.');
}
console.log('');

/* ----------------------------------------------------------------- the runs */
const results = [];
let firstPrompt = true;

for (const { prompt, threshold } of RUNS) {
  // Replicate throttles low-credit accounts hard; a short gap costs nothing
  // and keeps the comparison from collapsing into a row of 429s.
  // 6 predictions a minute means one per ten seconds; 8 was fractionally too
  // fast and still tripped the limiter.
  if (!firstPrompt) await new Promise((r) => setTimeout(r, 12000));
  firstPrompt = false;

  const label = `"${prompt}"` + (threshold === null ? ' @ default' : ` @ ${threshold}`);
  console.log(`--- ${label}`);
  const started = Date.now();

  const input = { image: imageUrl, prompt, mask_only: true, save_overlay: false, return_zip: false };
  if (threshold !== null) input.threshold = threshold;

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ version, input }),
  });

  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    console.log(`    HTTP ${res.status} (non-JSON)\n`);
    continue;
  }

  if (res.status === 429) {
    console.log(`    RATE LIMITED: ${body.detail}\n`);
    continue;
  }

  let final = body;
  if (final.status && !['succeeded', 'failed', 'canceled'].includes(final.status) && final.urls?.get) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      final = await (await fetch(final.urls.get, { headers: auth })).json();
      if (['succeeded', 'failed', 'canceled'].includes(final.status)) break;
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (final.status !== 'succeeded') {
    console.log(`    ${final.status}: ${JSON.stringify(final.error || final.detail).slice(0, 200)}\n`);
    continue;
  }

  const out = final.output;
  const url = Array.isArray(out) ? out[0] : typeof out === 'string' ? out : out?.mask || out?.image;
  if (typeof url !== 'string') {
    console.log(`    unexpected output shape: ${JSON.stringify(out).slice(0, 200)}\n`);
    continue;
  }

  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  let png;
  try {
    png = PNG.sync.read(bytes);
  } catch (e) {
    console.log(`    mask is not a readable PNG (${bytes.length} bytes): ${e.message}\n`);
    continue;
  }

  const image = { width: png.width, height: png.height, data: png.data };

  // The mask may come back at a different resolution than we asked for, so
  // everything is expressed in its own pixel grid rather than assumed.
  const project = (x, y) => framePxToLngLat(frame, [x, y], png.width, png.height);
  const clipMask = clipAt(png.width, png.height);

  /*
   * Before tracing anything: does the mask even land on the parcel?
   *
   * Comparing raw pixels answers the question the square footage cannot. If
   * the mask covers a decent share of the frame but almost none of the
   * parcel, the two are misaligned -- which no amount of prompt tuning fixes.
   */
  const bin = binarize(image);
  let maskPx = 0, clipPx = 0, bothPx = 0;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i]) maskPx++;
    if (clipMask[i]) clipPx++;
    if (bin[i] && clipMask[i]) bothPx++;
  }
  console.log(`    mask covers ${((maskPx / bin.length) * 100).toFixed(1)}% of the frame; ` +
    `${((bothPx / Math.max(1, clipPx)) * 100).toFixed(1)}% of the parcel is masked`);

  const loose = maskToPolygons(image, project, {});
  const clipped = maskToPolygons(image, project, { clipMask });

  const sqftOf = (ps) => Math.round(ps.reduce((s, p) => s + geometryAreaSqM(p), 0) / 0.09290304);
  const looseSqft = sqftOf(loose);
  const clippedVerts = clipped.reduce((n, p) => n + p.coordinates[0].length, 0);
  const clipSqft = sqftOf(clipped);
  const pctOfParcel = Math.round((clipSqft / parcelArea.squareFeet) * 100);

  console.log(`    ${secs}s   mask ${png.width}x${png.height}`);
  console.log(`    unclipped: ${looseSqft.toLocaleString()} sq ft in ${loose.length} piece(s)`);
  console.log(`    clipped:   ${clipSqft.toLocaleString()} sq ft in ${clipped.length} piece(s)` +
    `  = ${pctOfParcel}% of the parcel, ${clippedVerts} vertices`);
  console.log(`    outside the property line: ${(looseSqft - clipSqft).toLocaleString()} sq ft`);

  /*
   * How coarse can the outline be before the number moves?
   *
   * A traced 1280px mask is pixel staircase, and the default tolerance of 1.5
   * px is about 5 cm on the ground -- far finer than a lawn edge is knowable,
   * and it produces an outline of hundreds of vertices that no one can edit on
   * a phone. The question is what that detail is worth, and it is answerable
   * for free: the prediction is already paid for, so re-simplifying the same
   * mask costs nothing but a little arithmetic.
   */
  const mPerPx = metresPerPixel(frame, png.width);
  console.log(`    simplification (1 px = ${(mPerPx * 100).toFixed(1)} cm on the ground):`);
  for (const metres of [0.05, 0.15, 0.3, 0.5, 0.8, 1.2]) {
    const tol = metres / mPerPx;
    for (const cap of [240, 40]) {
      const ps = maskToPolygons(image, project, { clipMask, tolerance: tol, maxVertices: cap });
      const verts = ps.reduce((n, p) => n + p.coordinates[0].length, 0);
      const sqft = sqftOf(ps);
      const drift = clipSqft ? (100 * (sqft - clipSqft)) / clipSqft : 0;
      console.log(
        `      ${String(metres).padStart(4)} m  cap ${String(cap).padStart(3)}  ` +
        `${String(verts).padStart(4)} vertices  ${sqft.toLocaleString().padStart(7)} sq ft  ` +
        `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}%`
      );
    }
  }
  console.log('');

  results.push({ prompt, threshold, looseSqft, clipSqft, pctOfParcel, pieces: clipped.length, secs });
}

/* -------------------------------------------------------------- the verdict */
console.log('='.repeat(72));
console.log('run'.padEnd(34) + 'clipped sq ft'.padStart(14) + '% parcel'.padStart(10) + 'pieces'.padStart(8));
for (const r of results) {
  console.log(
    (`"${r.prompt}"` + (r.threshold === null ? ' @ default' : ` @ ${r.threshold}`)).padEnd(34) +
    r.clipSqft.toLocaleString().padStart(14) +
    `${r.pctOfParcel}%`.padStart(10) +
    String(r.pieces).padStart(8)
  );
}
console.log('='.repeat(72));
console.log(`\nparcel is ${parcelArea.squareFeet.toLocaleString()} sq ft.`);
console.log('A believable residential lawn is roughly 30-70% of the lot: the rest is');
console.log('house, drive and beds. Near 0% means the prompt found nothing; near 100%');
console.log('means it is calling the roof and the driveway grass.');
