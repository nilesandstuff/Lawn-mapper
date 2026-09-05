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
import { rasterizePolygon, maskToPolygons } from '../public/lib/mask.js';
import {
  zoomToFit, geometryBounds, lngLatToFramePx, framePxToLngLat, metresPerPixel,
} from '../public/lib/mercator.js';

const mapbox = process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs both MAPBOX_TOKEN and REPLICATE_TOKEN.');
  process.exit(1);
}

const MODEL = process.env.SAM3_MODEL || 'mattsays/sam3-image';
const auth = { Authorization: `Bearer ${replicate}` };

const PROMPTS = (process.env.PROMPTS || [
  'grass',
  'lawn',
  'grass lawn',
  'mowed grass',
].join('|')).split('|').map((p) => p.trim()).filter(Boolean);

/* ------------------------------------------- the real parcel, really fetched */
const TEST = { lng: -85.8637, lat: 42.8703, label: 'Hudsonville' };

console.log(`Looking up the parcel at ${TEST.label}…`);
const parcel = await lookupParcel(TEST.lng, TEST.lat);
if (!parcel) {
  console.error('FAIL  No parcel returned; cannot rehearse the real pipeline.');
  process.exit(1);
}

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

console.log(`parcel:  ${parcelArea.squareFeet.toLocaleString()} sq ft (${parcelArea.acres} ac)`);
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

const version = (await (await fetch(`https://api.replicate.com/v1/models/${MODEL}`, { headers: auth })).json())
  .latest_version?.id;
if (!version) {
  console.error(`FAIL  ${MODEL} has no runnable version.`);
  process.exit(1);
}
console.log(`model:   ${MODEL} @ ${version.slice(0, 12)}…\n`);

/* ----------------------------------------------------------------- the runs */
const results = [];
let firstPrompt = true;

for (const prompt of PROMPTS) {
  // Replicate throttles low-credit accounts hard; a short gap costs nothing
  // and keeps the comparison from collapsing into a row of 429s.
  if (!firstPrompt) await new Promise((r) => setTimeout(r, 8000));
  firstPrompt = false;

  console.log(`--- "${prompt}"`);
  const started = Date.now();

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({
      version,
      input: { image: imageUrl, prompt, mask_only: true, save_overlay: false, return_zip: false },
    }),
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

  const loose = maskToPolygons(image, project, {});
  const clipped = maskToPolygons(image, project, { clipMask });

  const sqftOf = (ps) => Math.round(ps.reduce((s, p) => s + geometryAreaSqM(p), 0) / 0.09290304);
  const looseSqft = sqftOf(loose);
  const clipSqft = sqftOf(clipped);
  const pctOfParcel = Math.round((clipSqft / parcelArea.squareFeet) * 100);

  console.log(`    ${secs}s   mask ${png.width}x${png.height}`);
  console.log(`    unclipped: ${looseSqft.toLocaleString()} sq ft in ${loose.length} piece(s)`);
  console.log(`    clipped:   ${clipSqft.toLocaleString()} sq ft in ${clipped.length} piece(s)` +
    `  = ${pctOfParcel}% of the parcel`);
  console.log(`    outside the property line: ${(looseSqft - clipSqft).toLocaleString()} sq ft\n`);

  results.push({ prompt, looseSqft, clipSqft, pctOfParcel, pieces: clipped.length, secs });
}

/* -------------------------------------------------------------- the verdict */
console.log('='.repeat(72));
console.log('prompt'.padEnd(34) + 'clipped sq ft'.padStart(14) + '% parcel'.padStart(10) + 'pieces'.padStart(8));
for (const r of results) {
  console.log(
    `"${r.prompt}"`.padEnd(34) +
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
