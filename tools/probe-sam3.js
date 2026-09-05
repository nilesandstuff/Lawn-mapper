/**
 * Tries several prompt wordings against the text-promptable segmenter.
 *
 * The wording is the whole interface now, and it has to survive things we
 * cannot control: grass that is dormant and brown when the imagery was
 * captured, tree canopy hiding the lawn underneath, and woodland at the back
 * of a lot that is emphatically not mowed. Guessing at that from a schema is
 * pointless -- run the real prompts and look.
 *
 * THIS COSTS MONEY: one prediction per prompt, a few cents in total.
 *
 *   MAPBOX_TOKEN=pk... REPLICATE_TOKEN=r8_... node tools/probe-sam3.js
 */

const mapbox = process.env.MAPBOX_TOKEN;
const replicate = process.env.REPLICATE_TOKEN;
if (!mapbox || !replicate) {
  console.error('FAIL  Needs both MAPBOX_TOKEN and REPLICATE_TOKEN.');
  process.exit(1);
}

const MODEL = process.env.SAM3_MODEL || 'mattsays/sam3-image';

/**
 * Prompt candidates, simplest first.
 *
 * SAM 3 takes a concept, not an instruction, so the long descriptive ones may
 * do worse than the short ones -- which is exactly what this is measuring.
 */
const PROMPTS = (process.env.PROMPTS || [
  'grass',
  'lawn',
  'grass lawn including dry brown dormant grass',
  'mowed lawn grass, not trees or woods',
].join('|')).split('|');

// A real residential parcel in Hudsonville, framed the way the app frames one.
const frame = { lng: -85.8637, lat: 42.8703, zoom: 18, size: 640 };
const imageUrl =
  `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
  `${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frame.size}@2x` +
  `?access_token=${mapbox}&attribution=false&logo=false`;

const auth = { Authorization: `Bearer ${replicate}` };

const meta = await (await fetch(`https://api.replicate.com/v1/models/${MODEL}`, { headers: auth })).json();
const version = meta.latest_version?.id;
if (!version) {
  console.error(`FAIL  ${MODEL} has no runnable version.`);
  process.exit(1);
}

console.log(`model:   ${MODEL}`);
console.log(`version: ${version.slice(0, 16)}…`);
console.log(`image:   ${frame.size * 2}px of ${frame.lng},${frame.lat} @ z${frame.zoom}`);
console.log(`prompts: ${PROMPTS.length}\n`);

// Replicate throttles hard on low-credit accounts: 6 predictions a minute
// with a burst of one. Without this pause every prompt after the first came
// back 429 and the comparison was meaningless.
let firstPrompt = true;
for (const prompt of PROMPTS) {
  if (!firstPrompt) await new Promise((r) => setTimeout(r, 12000));
  firstPrompt = false;
  const started = Date.now();
  process.stdout.write(`--- "${prompt}"\n`);

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({
      version,
      input: {
        image: imageUrl,
        prompt,
        // The bare mask is what the tracer wants; an overlay would have to be
        // separated from the photograph again.
        mask_only: true,
        save_overlay: false,
        // A zip would have to be unpacked in the browser before the tracer
        // could touch it. Ask for the bare image instead.
        return_zip: false,
      },
    }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`    HTTP ${res.status}, non-JSON: ${text.slice(0, 300)}\n`);
    continue;
  }

  let final = body;
  // Poll if it outlived the wait window; a cold start can take minutes.
  if (final.status && !['succeeded', 'failed', 'canceled'].includes(final.status) && final.urls?.get) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      final = await (await fetch(final.urls.get, { headers: auth })).json();
      if (['succeeded', 'failed', 'canceled'].includes(final.status)) break;
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`    HTTP ${res.status}  status=${final.status}  ${secs}s`);
  if (final.error) console.log(`    error: ${JSON.stringify(final.error).slice(0, 300)}`);
  if (final.detail) console.log(`    detail: ${String(final.detail).slice(0, 300)}`);

  const out = final.output;
  if (res.status === 429) {
    console.log('    RATE LIMITED — add credit at https://replicate.com/account/billing\n');
    continue;
  }
  console.log(`    output: ${Array.isArray(out) ? `array(${out.length})` : typeof out}`);
  console.log(`    ${JSON.stringify(out)?.slice(0, 400)}`);

  // Fetch the mask itself: size and type tell us whether it is a usable
  // single-channel mask or an overlay we would have to unpick.
  const maskUrl = Array.isArray(out) ? out[0] : typeof out === 'string' ? out : out?.mask || out?.image;
  if (typeof maskUrl === 'string' && maskUrl.startsWith('http')) {
    try {
      const m = await fetch(maskUrl);
      const buf = await m.arrayBuffer();
      console.log(`    mask: HTTP ${m.status} ${m.headers.get('content-type')} ${buf.byteLength.toLocaleString()} bytes`);
    } catch (e) {
      console.log(`    mask fetch failed: ${e.message}`);
    }
  }
  console.log('');
}

console.log('Done. Compare the mask sizes: a near-empty mask means the prompt found nothing.');
