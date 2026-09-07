/**
 * Audition a replacement for the detector, on a real lot, against real numbers.
 *
 * The precise model was scrapped for one reason: it could not tell a tree's
 * shadow lying across a lawn from dense woodland. That is not a prompt problem
 * and no amount of tuning fixes it, so the question is which model to move to
 * -- and that question has an answer made of numbers, not of README claims.
 *
 * So this runs each candidate through the ACTUAL pipeline, on the same house,
 * with the same frame and the same property line: segment, clip to the
 * boundary, trace, and report the square footage. Then the models can be put
 * side by side against a lot whose real answer we already have.
 *
 * Two things are checked before the square footage, because both are
 * disqualifying and neither is visible in a model's description:
 *
 *   IS IT A MASK?  Several of these return the photograph with masks drawn ON
 *   it. That looks like a segmentation result and traces into garbage -- the
 *   tracer would be reading colours off an annotated picture. A real mask is
 *   nearly all pure black and pure white; an overlay is nowhere near.
 *
 *   IS IT ON THE PARCEL?  A mask that covers a good share of the frame but
 *   almost none of the property line is misaligned, and no prompt fixes that
 *   either.
 *
 * THIS COSTS MONEY: one prediction per candidate.
 *
 *   MAPBOX_SERVER_TOKEN=pk... REPLICATE_TOKEN=r8_... node tools/probe-candidates.js
 *
 * Environment:
 *   MODELS     comma-separated candidate ids (default: all of them)
 *   PROMPT     what to ask for              (default: "grass")
 *   NEGATIVE   what to rule out, for the models that accept it
 *              (default: "trees, forest, woods, bushes, shrubs")
 *   ADDRESS    a specific house             (default: a known Ottawa County lot)
 */

import { PNG } from 'pngjs';
import { lookupParcel } from '../worker/src/parcel.js';
import { imageryUrl } from '../worker/src/imagery.js';
import { measure, geometryAreaSqM } from '../public/lib/area.js';
import { rasterizePolygon, maskToPolygons, binarize } from '../public/lib/mask.js';
import {
  zoomToFit, geometryBounds, lngLatToFramePx, framePxToLngLat, metresPerPixel,
} from '../public/lib/mercator.js';

const mapbox = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs a Mapbox token (MAPBOX_SERVER_TOKEN or MAPBOX_TOKEN) and REPLICATE_TOKEN.');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${replicate}` };

const PROMPT = process.env.PROMPT || 'grass';
const NEGATIVE = process.env.NEGATIVE ?? 'trees, forest, woods, bushes, shrubs';

/**
 * The candidates, and exactly how each one is asked.
 *
 * Drawn from what tools/find-sam-model.js can actually reach on Replicate,
 * with their real published input names -- a field invented here is a failed
 * prediction that costs money to discover.
 */
const CANDIDATES = {
  /* The incumbent, run on the same lot so every other row has a baseline. */
  sam3: {
    slug: 'mattsays/sam3-image',
    why: 'what ships today',
    input: (image) => ({
      image, prompt: PROMPT, mask_only: true, save_overlay: false,
      return_zip: false, threshold: 0.1,
    }),
  },

  /*
   * The one with a NEGATIVE prompt, which is the whole reason it is here.
   * Grounding DINO locates the phrase and SAM segments inside it, so "grass"
   * with "trees, forest" ruled out is a question the architecture can actually
   * answer -- unlike a single similarity score, where a shaded lawn and a
   * woodland edge land next to each other and one cut has to separate them.
   */
  grounded_sam: {
    slug: 'schananas/grounded_sam',
    why: 'accepts a negative prompt: say what is NOT lawn',
    input: (image) => ({
      image,
      mask_prompt: PROMPT,
      negative_mask_prompt: NEGATIVE,
      adjustment_factor: 0,
    }),
  },

  /* Same architecture, no negative prompt, but five million runs behind it. */
  langsam: {
    slug: 'tmappdev/lang-segment-anything',
    why: 'grounding + SAM, heavily used, two inputs and nothing else',
    input: (image) => ({ image, text_prompt: PROMPT }),
  },

  /*
   * Fast and text-promptable, but it publishes no mask_only, so the output is
   * expected to be the photograph with contours drawn on it. Included because
   * "expected" is not "measured", and the purity check settles it for the
   * price of one prediction.
   */
  fastsam: {
    slug: 'casia-iva-lab/fastsam',
    why: 'text prompt, but likely returns an annotated photo rather than a mask',
    input: (image) => ({
      input_image: image, text_prompt: PROMPT,
      retina: true, better_quality: true, withContours: false,
    }),
  },
};

const WANTED = (process.env.MODELS || Object.keys(CANDIDATES).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const unknown = WANTED.filter((m) => !CANDIDATES[m]);
if (unknown.length) {
  console.error(`FAIL  Unknown candidate(s): ${unknown.join(', ')}. Known: ${Object.keys(CANDIDATES).join(', ')}.`);
  process.exit(1);
}

/* ------------------------------------------- the real parcel, really fetched */
const FALLBACK = [
  { lng: -85.8637, lat: 42.8703, label: 'Hudsonville' },
  { lng: -85.8600, lat: 42.8720, label: 'Hudsonville N' },
  { lng: -85.7975, lat: 42.9075, label: 'Jenison' },
];
const HOUSE_SQFT = [3000, 30000];

let parcel = null;
let picked = null;

if (process.env.ADDRESS) {
  const res = await fetch(
    'https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({
      q: process.env.ADDRESS, access_token: mapbox,
      country: 'us', types: 'address', limit: '1',
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
    console.error(`FAIL  No county parcel at ${picked.label}. This probe clips to the property line, so it needs one.`);
    process.exit(1);
  }
}

for (const c of parcel ? [] : FALLBACK) {
  const p = await lookupParcel(c.lng, c.lat);
  if (!p) { console.log(`  ${c.label}: no parcel`); continue; }
  const a = measure(p.geometry);
  const ok = a.squareFeet >= HOUSE_SQFT[0] && a.squareFeet <= HOUSE_SQFT[1];
  console.log(`  ${c.label}: ${a.squareFeet.toLocaleString()} sq ft ${ok ? '<- using this one' : '(not house-sized)'}`);
  if (ok) { parcel = p; picked = c; break; }
}

if (!parcel) {
  console.error('FAIL  No house-sized parcel to test against.');
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

console.log(`\nparcel:  ${parcelArea.squareFeet.toLocaleString()} sq ft (${parcelArea.acres} ac) at ${picked.label}`);
console.log(`frame:   z${frame.zoom} @ ${IMG}px -> ${(metresPerPixel(frame, IMG) * 100).toFixed(1)} cm/px`);
console.log(`asking:  "${PROMPT}"   ruling out: "${NEGATIVE}"\n`);

const rings = parcel.geometry.type === 'Polygon'
  ? parcel.geometry.coordinates
  : parcel.geometry.coordinates[0];
const clipAt = (w, h) =>
  rasterizePolygon(rings, w, h, (ll) => lngLatToFramePx(frame, ll, w, h));

const imageUrl = imageryUrl('mapbox', frame, mapbox);

/**
 * How close an image is to being a bare black-and-white mask.
 *
 * This is the check that disqualifies a model outright. An overlay on the
 * photograph has grass, roof and tarmac in it, none of which is near 0 or 255,
 * so it scores low -- and tracing it would produce a confident outline of
 * something that is not a mask at all.
 */
function purity(png) {
  let pure = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const v = png.data[i];
    if (v <= 12 || v >= 243) pure++;
  }
  return pure / (png.data.length / 4);
}

const sqftOf = (ps) => Math.round(ps.reduce((s, p) => s + geometryAreaSqM(p), 0) / 0.09290304);

/** Every URL a model's output might be hiding in, in the order to try them. */
function outputUrls(out) {
  if (typeof out === 'string') return [out];
  if (Array.isArray(out)) return out.filter((u) => typeof u === 'string');
  if (out && typeof out === 'object') {
    return Object.values(out).filter((u) => typeof u === 'string' && /^https?:/.test(u));
  }
  return [];
}

const results = [];
let first = true;

for (const id of WANTED) {
  const c = CANDIDATES[id];
  // Replicate throttles low-credit accounts hard; a short gap costs nothing.
  if (!first) await new Promise((r) => setTimeout(r, 12000));
  first = false;

  console.log('-'.repeat(72));
  console.log(`${id}  (${c.slug})`);
  console.log(`  ${c.why}`);

  const meta = await (await fetch(`https://api.replicate.com/v1/models/${c.slug}`, { headers: auth })).json();
  const version = meta.latest_version?.id;
  if (!version) {
    console.log(`  SKIP  no runnable version (${meta.detail || 'unknown'})\n`);
    results.push({ id, verdict: 'no version' });
    continue;
  }

  const started = Date.now();
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ version, input: c.input(imageUrl) }),
  });

  let body;
  try { body = JSON.parse(await res.text()); } catch {
    console.log(`  FAIL  HTTP ${res.status} (non-JSON)\n`);
    results.push({ id, verdict: `HTTP ${res.status}` });
    continue;
  }
  if (res.status === 429) {
    console.log(`  RATE LIMITED: ${body.detail}\n`);
    results.push({ id, verdict: 'rate limited' });
    continue;
  }

  let final = body;
  if (final.status && !['succeeded', 'failed', 'canceled'].includes(final.status) && final.urls?.get) {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      final = await (await fetch(final.urls.get, { headers: auth })).json();
      if (['succeeded', 'failed', 'canceled'].includes(final.status)) break;
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (final.status !== 'succeeded') {
    const why = JSON.stringify(final.error || final.detail || final.status).slice(0, 200);
    console.log(`  FAIL  ${final.status}: ${why}\n`);
    results.push({ id, verdict: `${final.status}` });
    continue;
  }

  const urls = outputUrls(final.output);
  if (!urls.length) {
    console.log(`  FAIL  no image in the output: ${JSON.stringify(final.output).slice(0, 200)}\n`);
    results.push({ id, verdict: 'no image out' });
    continue;
  }
  console.log(`  ${secs}s, ${urls.length} output(s)`);

  /*
   * Read every output and keep the one that is most like a mask. Models that
   * return several images do not say which is which, and picking the first
   * would judge grounded_sam on whichever image it happened to list first.
   */
  let best = null;
  for (const [i, url] of urls.entries()) {
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    let png;
    try { png = PNG.sync.read(bytes); } catch (e) {
      console.log(`    output ${i}: not a readable PNG (${bytes.length} bytes) — ${e.message}`);
      continue;
    }
    const p = purity(png);
    console.log(`    output ${i}: ${png.width}x${png.height}, ${(p * 100).toFixed(1)}% pure black/white`);
    if (!best || p > best.purity) best = { png, purity: p, index: i };
  }

  if (!best) {
    console.log('  FAIL  nothing readable came back\n');
    results.push({ id, verdict: 'unreadable' });
    continue;
  }

  /*
   * 95% is the line, and it is not arbitrary: a bare mask is black and white
   * apart from a one-pixel antialiased rim, which on a 1280px frame is well
   * under 5% of it. Anything below that is a photograph with paint on it.
   */
  if (best.purity < 0.95) {
    console.log(`  REJECT  output ${best.index} is only ${(best.purity * 100).toFixed(1)}% pure —`);
    console.log('          this is an annotated photograph, not a mask. Tracing it would');
    console.log('          read colours off a picture and report a confident wrong number.\n');
    results.push({ id, verdict: 'not a mask', purity: best.purity });
    continue;
  }

  const png = best.png;
  const image = { width: png.width, height: png.height, data: png.data };
  const project = (x, y) => framePxToLngLat(frame, [x, y], png.width, png.height);
  const clipMask = clipAt(png.width, png.height);

  const bin = binarize(image);
  let maskPx = 0, clipPx = 0, bothPx = 0;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i]) maskPx++;
    if (clipMask[i]) clipPx++;
    if (bin[i] && clipMask[i]) bothPx++;
  }
  const onParcel = (bothPx / Math.max(1, clipPx)) * 100;
  console.log(`  mask covers ${((maskPx / bin.length) * 100).toFixed(1)}% of the frame; ` +
    `${onParcel.toFixed(1)}% of the parcel is masked`);

  const mPerPx = metresPerPixel(frame, png.width);
  const loose = maskToPolygons(image, project, {});
  const clipped = maskToPolygons(image, project, {
    clipMask, tolerance: 0.3 / mPerPx, maxVertices: 240,
  });

  const looseSqft = sqftOf(loose);
  const clipSqft = sqftOf(clipped);
  const pct = Math.round((clipSqft / parcelArea.squareFeet) * 100);

  console.log(`  unclipped: ${looseSqft.toLocaleString()} sq ft in ${loose.length} piece(s)`);
  console.log(`  clipped:   ${clipSqft.toLocaleString()} sq ft in ${clipped.length} piece(s) = ${pct}% of the lot`);
  console.log(`  outside the property line: ${(looseSqft - clipSqft).toLocaleString()} sq ft\n`);

  results.push({
    id, verdict: 'mask', purity: best.purity, clipSqft, pct,
    pieces: clipped.length, onParcel, secs,
  });
}

/* -------------------------------------------------------------- the verdict */
console.log('='.repeat(72));
console.log('candidate'.padEnd(16) + 'verdict'.padEnd(14) + 'clipped sq ft'.padStart(14) +
  '% lot'.padStart(8) + 'pieces'.padStart(8));
for (const r of results) {
  console.log(
    r.id.padEnd(16) + r.verdict.padEnd(14) +
    (r.clipSqft === undefined ? '—' : r.clipSqft.toLocaleString()).padStart(14) +
    (r.pct === undefined ? '—' : `${r.pct}%`).padStart(8) +
    (r.pieces === undefined ? '—' : String(r.pieces)).padStart(8)
  );
}
console.log('='.repeat(72));
console.log(`\nparcel is ${parcelArea.squareFeet.toLocaleString()} sq ft at ${picked.label}.`);
console.log('A believable residential lawn is roughly 30-70% of the lot: the rest is');
console.log('house, drive and beds. Near 0% found nothing; near 100% is calling the');
console.log('roof and the driveway grass.');
console.log('');
console.log('What this probe CANNOT tell you is the thing the last model failed at:');
console.log('whether a tree shadow on grass is counted as grass. That needs a lot');
console.log('where you already know the answer — run it again with ADDRESS set to');
console.log('one, and compare the square footage against what you know is mown.');
