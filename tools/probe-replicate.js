/**
 * Runs one real SAM 2 prediction and reports exactly what comes back.
 *
 * "Detecting your lawn..." hangs forever on the deployed site, and none of the
 * offline tests can see why: the failure is in what Replicate actually does
 * with our request, which no amount of local mocking will tell us.
 *
 * THIS COSTS MONEY -- one prediction, a couple of cents. It is deliberately
 * not part of preflight.
 *
 *   MAPBOX_TOKEN=pk... REPLICATE_TOKEN=r8_... node tools/probe-replicate.js
 */

import { readFile } from 'node:fs/promises';

const mapbox = process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs both MAPBOX_TOKEN and REPLICATE_TOKEN.');
  process.exit(1);
}

// The same slug the Worker calls, read from the Worker so they cannot drift.
const source = await readFile(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const slug = source.match(
  /api\.replicate\.com\/v1\/models\/([A-Za-z0-9][\w.-]*\/[\w.-]+)\/predictions/
)?.[1];

// The Hudsonville parcel the county probe returns, framed the way the app does.
const frame = { lng: -85.8637, lat: 42.8703, zoom: 18, size: 640 };
const imageUrl =
  `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
  `${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frame.size}@2x` +
  `?access_token=${mapbox}&attribution=false&logo=false`;

console.log(`model:  ${slug}`);
console.log(`image:  ${imageUrl.replace(mapbox, 'pk.***')}`);

// Check the imagery is fetchable at all -- Replicate has to load it too, and a
// URL-restricted Mapbox token would fail here in a way that looks like a
// segmentation problem.
const img = await fetch(imageUrl, { method: 'GET' });
console.log(`imagery: HTTP ${img.status} ${img.headers.get('content-type')} ` +
  `${(await img.arrayBuffer()).byteLength.toLocaleString()} bytes`);
if (!img.ok) {
  console.error('\nFAIL  Replicate will not be able to read the satellite image either.');
  console.error('      A Mapbox token restricted by URL cannot be used server-side.');
  process.exit(1);
}

// Three points, as a lawn split by a driveway would send.
const points = [[640, 900], [400, 500], [900, 520]];

console.log(`\nPOST https://api.replicate.com/v1/models/${slug}/predictions`);
console.log(`points: ${JSON.stringify(points)}  labels: ${JSON.stringify(points.map(() => 1))}`);

const started = Date.now();
const res = await fetch(`https://api.replicate.com/v1/models/${slug}/predictions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${replicate}`,
    'Content-Type': 'application/json',
    Prefer: 'wait',
  },
  body: JSON.stringify({
    input: {
      image: imageUrl,
      point_coords: points,
      point_labels: points.map(() => 1),
    },
  }),
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const text = await res.text();
console.log(`\nHTTP ${res.status} after ${elapsed}s`);

let body;
try {
  body = JSON.parse(text);
} catch {
  console.log('body (not JSON):', text.slice(0, 800));
  process.exit(1);
}

console.log(`status:  ${body.status}`);
if (body.error) console.log(`error:   ${JSON.stringify(body.error)}`);
if (body.detail) console.log(`detail:  ${body.detail}`);
if (body.logs) console.log(`logs:\n${String(body.logs).slice(-1200)}`);

console.log(`\noutput shape: ${Array.isArray(body.output) ? 'array' : typeof body.output}`);
console.log(JSON.stringify(body.output, null, 2)?.slice(0, 1200));

// If it did not finish inside the wait window, poll -- a cold start can take
// minutes, and the app needs to know whether that is what is happening.
if (body.status && !['succeeded', 'failed', 'canceled'].includes(body.status)) {
  console.log(`\nNot finished inside Prefer: wait. Polling ${body.urls?.get}…`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await fetch(body.urls.get, { headers: { Authorization: `Bearer ${replicate}` } });
    const j = await p.json();
    process.stdout.write(`  ${((Date.now() - started) / 1000).toFixed(0)}s ${j.status}\n`);
    if (['succeeded', 'failed', 'canceled'].includes(j.status)) {
      console.log(`\nfinal status: ${j.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (j.error) console.log(`error: ${JSON.stringify(j.error)}`);
      console.log('output:', JSON.stringify(j.output, null, 2)?.slice(0, 1200));
      break;
    }
  }
}

console.log('\nDone.');
