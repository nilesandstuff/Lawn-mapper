/**
 * Does the point-prompted model actually give us something we can measure?
 *
 * The schema for ocg2347/sam-pointprompt is two lines long -- `image` and
 * `input_points`, both strings, no description of either, and an output typed
 * only as "uri". That leaves three things unknown that no amount of reading can
 * settle, and all three are fatal if guessed wrong:
 *
 *   1. the point format. [[x,y]] is the SAM convention, but the field is typed
 *      as a string, so it could want "[[x,y]]", "x,y", or {"points": [...]}.
 *   2. the coordinate space. Pixels of the image we send, most likely -- but a
 *      model that resizes internally might want normalised 0..1.
 *   3. the output. A binary mask is traceable; the photograph with a coloured
 *      overlay drawn on it is not, and both are "a uri".
 *
 * So this sends real pins at a real house and reports what comes back: the
 * image's size, how close it is to black-and-white, and the square footage it
 * traces to. A mask that is 40% mid-grey is an overlay, not a mask.
 *
 * THIS COSTS MONEY: one prediction per format tried.
 *
 *   REPLICATE_TOKEN=r8_... MAPBOX_SERVER_TOKEN=pk... node tools/probe-points.js
 */

import { PNG } from 'pngjs';
import { lookupParcel } from '../worker/src/parcel.js';
import { measure, geometryAreaSqM } from '../public/lib/area.js';
import { maskToPolygons, binarize, rasterizePolygon } from '../public/lib/mask.js';
import { imageryUrl, imagePixels } from '../worker/src/imagery.js';
import { MODELS, modelSlug } from '../worker/src/sam.js';
import {
  zoomToFit, geometryBounds, lngLatToFramePx, framePxToLngLat, metresPerPixel,
} from '../public/lib/mercator.js';

const mapbox = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs a Mapbox token and REPLICATE_TOKEN.');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${replicate}` };

const slug = process.env.SAM2_MODEL || modelSlug('sam2', process.env);
console.log(`model: ${slug}\n`);

/* ------------------------------------------------------- a real property */
const ADDRESS = process.env.ADDRESS || '';
let lng = -85.8637;
let lat = 42.8703;

if (ADDRESS) {
  const res = await fetch('https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({ q: ADDRESS, access_token: mapbox, country: 'us', types: 'address', limit: '1' }));
  const f = (await res.json()).features?.[0];
  if (!f) { console.error(`FAIL  Could not geocode "${ADDRESS}".`); process.exit(1); }
  [lng, lat] = f.geometry.coordinates;
  console.log(`address: ${f.properties?.full_address || ADDRESS}`);
}

const parcel = await lookupParcel(lng, lat);
if (!parcel) { console.error('FAIL  No parcel there.'); process.exit(1); }

const parcelArea = measure(parcel.geometry);
const bbox = geometryBounds(parcel);
const SIZE = 640;
const frame = {
  lng: (bbox[0] + bbox[2]) / 2,
  lat: (bbox[1] + bbox[3]) / 2,
  zoom: zoomToFit(bbox, SIZE),
  size: SIZE,
};
const IMG = imagePixels(frame);
const image = imageryUrl('mapbox', frame, mapbox);

console.log(`parcel: ${parcelArea.squareFeet.toLocaleString()} sq ft (${parcelArea.acres} ac)`);
console.log(`frame:  z${frame.zoom} @ ${IMG}px -> ${(metresPerPixel(frame, IMG) * 100).toFixed(1)} cm/px\n`);

/*
 * Pins that are actually on grass.
 *
 * A pin on the roof segments the roof, and the probe would report a model
 * failure that is really an aim failure. Rather than eyeball it, put pins at
 * points inside the parcel but away from its centre, where the house usually
 * sits -- then say where they went so a wrong answer is at least legible.
 */
const rings = parcel.geometry.type === 'Polygon'
  ? parcel.geometry.coordinates
  : parcel.geometry.coordinates[0];
const inside = rasterizePolygon(rings, IMG, IMG, (ll) => lngLatToFramePx(frame, ll, IMG, IMG));

const pins = [];
for (const [fx, fy] of [[0.5, 0.82], [0.25, 0.5], [0.75, 0.5], [0.5, 0.2]]) {
  const x = Math.round(IMG * fx);
  const y = Math.round(IMG * fy);
  if (inside[y * IMG + x]) pins.push([x, y]);
}
if (!pins.length) { console.error('FAIL  No sample point landed inside the parcel.'); process.exit(1); }
console.log(`pins:   ${JSON.stringify(pins)}  (image pixels, ${IMG}x${IMG})\n`);

/* --------------------------------------------------- the formats to try */
/*
 * Each is one paid prediction, so they are ordered most-likely first and the
 * loop stops at the first that produces a usable mask.
 */
const FORMATS = [
  { name: 'JSON [[x,y]]', build: () => JSON.stringify(pins) },
  { name: 'JSON [[x,y]] normalised 0..1', build: () => JSON.stringify(pins.map(([x, y]) => [+(x / IMG).toFixed(4), +(y / IMG).toFixed(4)])) },
  { name: 'bare "x,y;x,y"', build: () => pins.map((p) => p.join(',')).join(';') },
];

const version = await (async () => {
  const m = await (await fetch(`https://api.replicate.com/v1/models/${slug}`, { headers: auth })).json();
  return m.latest_version?.id;
})();
if (!version) { console.error(`FAIL  ${slug} has no runnable version.`); process.exit(1); }
console.log(`version: ${version.slice(0, 12)}…\n`);

const clipMask = rasterizePolygon(rings, IMG, IMG, (ll) => lngLatToFramePx(frame, ll, IMG, IMG));
let win = null;

for (const fmt of FORMATS) {
  if (win) break;
  console.log(`--- input_points as ${fmt.name}`);
  const input = MODELS.sam2.input(image, { points: [] });
  input.input_points = fmt.build();
  console.log(`    sending: ${String(input.input_points).slice(0, 90)}`);

  const started = Date.now();
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ version, input }),
  });

  let body;
  try { body = JSON.parse(await res.text()); }
  catch { console.log(`    HTTP ${res.status}, non-JSON\n`); continue; }

  if (res.status === 422 || body.detail) {
    console.log(`    REJECTED: ${JSON.stringify(body.detail || body).slice(0, 220)}\n`);
    continue;
  }

  let final = body;
  while (final.status && !['succeeded', 'failed', 'canceled'].includes(final.status) && final.urls?.get) {
    await new Promise((r) => setTimeout(r, 3000));
    final = await (await fetch(final.urls.get, { headers: auth })).json();
  }
  if (final.status !== 'succeeded') {
    console.log(`    ${final.status}: ${JSON.stringify(final.error).slice(0, 220)}\n`);
    continue;
  }

  const out = final.output;
  const url = typeof out === 'string' ? out : Array.isArray(out) ? out[0] : out?.mask || out?.image;
  if (typeof url !== 'string') {
    console.log(`    unexpected output: ${JSON.stringify(out).slice(0, 200)}\n`);
    continue;
  }

  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  let png;
  try { png = PNG.sync.read(bytes); }
  catch (e) { console.log(`    output is not a readable PNG (${bytes.length} b): ${e.message}\n`); continue; }

  /*
   * Mask or overlay?
   *
   * A binary mask is almost entirely pure black and pure white. An annotated
   * photograph is mostly mid-tones, and tracing one would produce a shape that
   * follows the JPEG artefacts rather than the lawn. Counting how much of the
   * image is neither black nor white tells them apart without looking.
   */
  let extreme = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const v = png.data[i];
    if (v < 24 || v > 231) extreme++;
  }
  const purity = extreme / (png.data.length / 4);

  console.log(`    ${((Date.now() - started) / 1000).toFixed(1)}s  output ${png.width}x${png.height}, ` +
    `${(bytes.length / 1024).toFixed(0)} KB`);
  console.log(`    ${(purity * 100).toFixed(1)}% of pixels are pure black or white ` +
    `(a real mask is >95%; an overlay on the photo is far lower)`);

  if (purity < 0.95) {
    console.log('    NOT A MASK: this is the photograph with the segmentation drawn on it.\n');
    continue;
  }

  const project = (x, y) => framePxToLngLat(frame, [x, y], png.width, png.height);
  const img = { width: png.width, height: png.height, data: png.data };
  const bin = binarize(img);
  const covered = bin.reduce((n, v) => n + (v ? 1 : 0), 0) / bin.length;

  const polys = maskToPolygons(img, project, {
    clipMask: png.width === IMG ? clipMask : null,
    tolerance: 0.8 / metresPerPixel(frame, png.width),
    maxVertices: 30,
  });
  const sqft = Math.round(polys.reduce((s, p) => s + geometryAreaSqM(p), 0) / 0.09290304);

  console.log(`    mask covers ${(covered * 100).toFixed(1)}% of the frame`);
  console.log(`    traces to ${sqft.toLocaleString()} sq ft in ${polys.length} piece(s) ` +
    `= ${Math.round((sqft / parcelArea.squareFeet) * 100)}% of the parcel`);
  console.log('    USABLE\n');
  win = { fmt: fmt.name, sqft, pieces: polys.length };
}

console.log('='.repeat(70));
if (win) {
  console.log(`WORKS: input_points as ${win.fmt}`);
  console.log(`       ${win.sqft.toLocaleString()} sq ft in ${win.pieces} piece(s)`);
  console.log('\nSet MODELS.sam2.input() in worker/src/sam.js to send that shape.');
} else {
  console.log('NONE of the formats produced a traceable mask.');
  console.log('\nThis model is not usable as it stands. The options, in order:');
  console.log('  - try casia-iva-lab/fastsam (point_prompt/point_label), accepting that');
  console.log('    its output is an annotated photo and would need colour-keying');
  console.log('  - use meta/sam-2-video, which returns real binary masks but needs a');
  console.log('    video file built from the single frame');
  console.log('  - keep pins out of the product and stay with the text prompt');
  process.exit(1);
}
