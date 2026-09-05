/**
 * Lawn Mapper -- Cloudflare Worker. Serves both the API and the site.
 *
 * The frontend in public/ is attached as Workers static assets (see
 * wrangler.toml), so one `wrangler deploy` ships the whole product to one
 * origin. That is not just tidiness: same-origin means no CORS to configure,
 * no second deploy target to keep in sync, and the browser can read the SAM
 * mask off a canvas without tainting it.
 *
 * Endpoints:
 *   GET  /api/config                   -> public Mapbox token for the browser
 *   GET  /api/geocode?q=<address>      -> candidate addresses (no quota)
 *   GET  /api/parcel?lng=&lat=         -> parcel boundary or null (no quota)
 *   GET  /api/imagery?...              -> satellite PNG (no quota)
 *   GET  /api/mask?url=<replicate url> -> proxied SAM mask (no quota)
 *   POST /api/segment                  -> SAM lawn mask (CONSUMES QUOTA)
 *   GET  /api/quota?clientId=          -> remaining allowance
 *
 * Secrets (wrangler secret put):
 *   MAPBOX_TOKEN     -- pk.* token, also used server-side for geocoding
 *   REPLICATE_TOKEN  -- r8_* token. NEVER exposed to the browser.
 * Bindings:
 *   QUOTA            -- KV namespace for measurement counting
 *   ASSETS           -- the static site in public/
 */

import { lookupParcel } from './parcel.js';
import { isCovered } from './counties.js';
import { checkQuota, consumeQuota, refundQuota } from './quota.js';
// Shared with the browser, which loads the same file over HTTP. See the note
// at the top of that file for why it lives outside worker/.
import { measure } from '../../public/lib/area.js';

/**
 * Only needed for `wrangler dev` and for anyone embedding the API. The
 * deployed site is same-origin, so it never sends an Origin we have to match.
 */
const ALLOWED_ORIGINS = [
  'https://lawnanswers.online',
  'https://www.lawnanswers.online',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });

/* ---------------------------------------------------------------- geocode */
/**
 * Address -> coordinates. Returns up to 5 candidates so the UI can make the
 * user confirm the right one before we spend anything on imagery. Restricted
 * to Michigan addresses; a bad geocode that lands in Ohio wastes a SAM call
 * and produces a confidently wrong number.
 */
async function handleGeocode(url, env, origin) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 4) return json({ error: 'Address too short' }, 400, origin);

  const endpoint =
    'https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({
      q,
      access_token: env.MAPBOX_TOKEN,
      country: 'us',
      types: 'address',
      limit: '5',
      // Bias toward West Michigan without hard-excluding the rest of the state.
      proximity: '-85.67,43.00',
    });

  const res = await fetch(endpoint);
  if (!res.ok) return json({ error: 'Geocoding unavailable' }, 502, origin);

  const data = await res.json();
  const results = (data.features || [])
    .map((f) => {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      return {
        label: p.full_address || p.name,
        lng,
        lat,
        // Mapbox returns 'rooftop' | 'parcel' | 'street' etc. Anything less
        // precise than a parcel/rooftop match means the pin may sit in the
        // road, which puts the SAM prompt point on asphalt.
        accuracy: p.match_code?.confidence || 'unknown',
        inCoverage: isCovered(lng, lat),
      };
    })
    .filter((r) => r.label);

  return json({ results }, 200, origin);
}

/* ----------------------------------------------------------------- parcel */
async function handleParcel(url, origin) {
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return json({ error: 'lng and lat required' }, 400, origin);
  }

  const parcel = await lookupParcel(lng, lat);
  if (!parcel) {
    // Not an error. Most of the country, and plenty of covered addresses,
    // land here. The UI drops straight to manual boundary drawing.
    return json({ parcel: null, covered: isCovered(lng, lat) }, 200, origin);
  }

  return json(
    { parcel, area: measure(parcel.geometry), covered: true },
    200,
    origin
  );
}

/* ---------------------------------------------------------------- imagery */
/**
 * Mapbox caps the static endpoint at 1280. Clamping is hoisted out of the URL
 * builder so /api/segment can report the size it actually used: the browser
 * converts mask pixels back to lng/lat with these exact numbers, and a frame
 * that says 1600 when the image is 1280 puts the lawn in the wrong place.
 */
const clampSize = (size) => Math.min(Math.max(size, 256), 1280);
const clampZoom = (zoom) => Math.min(Math.max(zoom, 15), 20);

function buildImageryUrl(lng, lat, zoom, size, token) {
  return (
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${lng},${lat},${zoom},0/${size}x${size}@2x?access_token=${token}&attribution=false&logo=false`
  );
}

/**
 * Proxies one Mapbox Static Images request. Server-side so the frontend never
 * needs the token for this, and so we can pin the parameters -- the same
 * frame feeds SAM and the export, so it must be reproducible.
 */
async function handleImagery(url, env, origin) {
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  const zoom = clampZoom(parseFloat(url.searchParams.get('zoom')) || 19);
  const size = clampSize(parseInt(url.searchParams.get('size'), 10) || 640);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return json({ error: 'lng and lat required' }, 400, origin);
  }

  const res = await fetch(buildImageryUrl(lng, lat, zoom, size, env.MAPBOX_TOKEN));
  if (!res.ok) return json({ error: 'Imagery unavailable' }, 502, origin);

  return new Response(res.body, {
    headers: {
      'Content-Type': 'image/png',
      // Imagery for a fixed point/zoom never changes. Cache hard.
      'Cache-Control': 'public, max-age=86400',
      ...cors(origin),
    },
  });
}

/* ------------------------------------------------------------------ mask */
/**
 * Proxies the SAM mask image back to the browser from our own origin.
 *
 * Required, not a nicety: the browser has to read the mask's pixels off a
 * <canvas> to trace it, and a cross-origin image taints the canvas so
 * getImageData() throws. Serving it from here keeps the canvas clean whatever
 * CORS headers Replicate's CDN happens to send.
 */
const MASK_HOST = 'replicate.delivery';

async function handleMask(url, origin) {
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'url required' }, 400, origin);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'Invalid url' }, 400, origin);
  }

  // Without this check the endpoint is an open proxy: anyone could use the
  // Worker to fetch arbitrary hosts, including addresses only reachable from
  // Cloudflare's network.
  const host = target.hostname;
  const allowed =
    target.protocol === 'https:' &&
    (host === MASK_HOST || host.endsWith(`.${MASK_HOST}`));
  if (!allowed) return json({ error: 'Host not allowed' }, 403, origin);

  const res = await fetch(target.toString());
  if (!res.ok) return json({ error: 'Mask unavailable' }, 502, origin);

  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'image/png',
      'Cache-Control': 'public, max-age=3600',
      ...cors(origin),
    },
  });
}

/* ------------------------------------------------------------ prediction */
/**
 * Poll a segmentation that outlived `Prefer: wait`.
 *
 * Replicate holds the connection for about a minute; a cold model can take
 * several. Without this the browser had nothing to wait on and the "Detecting
 * your lawn..." overlay simply stayed up forever.
 */
async function handlePrediction(url, env, origin) {
  const id = url.searchParams.get('id') || '';
  // Replicate ids are opaque alphanumeric strings; anything else is not ours.
  if (!/^[a-z0-9]{6,64}$/i.test(id)) {
    return json({ error: 'Invalid prediction id' }, 400, origin);
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
  });
  if (!res.ok) {
    return json({ error: 'Could not read the prediction', status: res.status }, 502, origin);
  }

  const p = await res.json();
  return json(
    { status: p.status, mask: p.output ?? null, detail: p.error || null },
    200,
    origin
  );
}

/* --------------------------------------------------------------- segment */

/**
 * The model, and the input fields we send it.
 *
 * Exported so tools/check-replicate.js validates the exact field names this
 * file uses against the model's published schema, rather than a copy that can
 * drift.
 */
export const SAM_MODEL = 'mattsays/sam3-image';
export const SAM_INPUT_FIELDS = ['image', 'prompt', 'mask_only', 'save_overlay', 'return_zip'];

/**
 * What we ask the model to find.
 *
 * Measured against a real 21,740 sq ft lot, "grass", "lawn" and "grass lawn"
 * agreed to within 0.6% -- the model resolves them to the same concept, so
 * elaborate wording buys nothing and the shortest one wins. Overridable via a
 * SAM_PROMPT variable so it can be retuned without a code change.
 */
const DEFAULT_PROMPT = 'grass';

/**
 * Replicate's per-model endpoint, /v1/models/{owner}/{name}/predictions, only
 * exists for *official* models. For everything else it answers 404 -- which is
 * what it did here, in 0.4 s, with a message about the resource not being
 * found rather than anything to do with segmentation.
 *
 * The general endpoint works for any model but needs a version id, so look it
 * up. Cached per isolate: the id changes only when the model is republished,
 * and paying an extra round trip on every detection to re-learn it is waste.
 */
let cachedVersion = null;

async function samVersion(env) {
  if (cachedVersion) return cachedVersion;

  const res = await fetch(`https://api.replicate.com/v1/models/${SAM_MODEL}`, {
    headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Could not look up ${SAM_MODEL} (HTTP ${res.status})`);

  const model = await res.json();
  const id = model.latest_version?.id;
  if (!id) throw new Error(`${SAM_MODEL} has no published version to run`);

  cachedVersion = id;
  return id;
}
/**
 * Runs SAM 2 against the parcel imagery to propose a lawn boundary.
 *
 * This is the only endpoint that costs money (~$0.02/run), so it is the only
 * one that consumes quota. `Prefer: wait` holds the connection open until the
 * prediction finishes rather than making the client poll -- simpler, and
 * Workers bill CPU time, not time spent waiting on a subrequest.
 */
async function handleSegment(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { lng, lat, clientId } = body;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !clientId) {
    return json({ error: 'lng, lat, and clientId required' }, 400, origin);
  }

  const zoom = clampZoom(Number(body.zoom) || 19);
  const size = clampSize(Number(body.size) || 640);

  const quota = await consumeQuota(request, env, clientId);
  if (!quota.allowed) {
    return json(
      {
        error: 'quota_exceeded',
        used: quota.used,
        limit: quota.limit,
        // Distinguishes "you used yours" from "your network used theirs",
        // which matters when a whole apartment building shares an address.
        reason: quota.reason || 'client',
      },
      429,
      origin
    );
  }

  const imageUrl = buildImageryUrl(lng, lat, zoom, size, env.MAPBOX_TOKEN);

  // A text prompt finds every patch of grass in the frame at once, including
  // the disconnected ones a person would have to remember to point at. What
  // it also finds is the neighbours' grass, so the browser clips the result
  // to the property line before measuring anything.
  const prompt = (env.SAM_PROMPT || DEFAULT_PROMPT).trim();

  let version;
  try {
    version = await samVersion(env);
  } catch (err) {
    await refundQuota(request, env, clientId);
    return json({ error: 'Segmentation unavailable', detail: err.message }, 502, origin);
  }

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REPLICATE_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({
      version,
      input: {
        image: imageUrl,
        prompt,
        // The bare mask, not an overlay on the photograph, and not zipped:
        // the browser traces these pixels directly.
        mask_only: true,
        save_overlay: false,
        return_zip: false,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await refundQuota(request, env, clientId);

    // Replicate throttles low-credit accounts to a handful of predictions a
    // minute. That is an account problem, not a bug, and saying so beats a
    // generic failure that sends the owner hunting through code.
    if (res.status === 429) {
      return json(
        {
          error: 'The detector is rate limited right now. Try again in a minute.',
          detail,
          rateLimited: true,
        },
        429,
        origin
      );
    }

    return json({ error: 'Segmentation failed', detail }, 502, origin);
  }

  const prediction = await res.json();
  if (prediction.status !== 'succeeded') {
    // Not a failure: `Prefer: wait` gives up after about a minute, and a cold
    // model can take several. The quota stays spent because the prediction is
    // running and will be billed; the client polls /api/prediction for it.
    return json(
      {
        pending: true,
        status: prediction.status,
        id: prediction.id,
        frame: { lng, lat, zoom, size },
        remaining: quota.limit - quota.used,
      },
      202,
      origin
    );
  }

  return json(
    {
      mask: prediction.output,
      remaining: quota.limit - quota.used,
      // Frame parameters must round-trip to the client: converting mask
      // pixels back to lng/lat requires the exact centre, zoom, and size.
      frame: { lng, lat, zoom, size },
    },
    200,
    origin
  );
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    try {
      switch (url.pathname) {
        // The Mapbox token is a pk.* key -- public by design; Mapbox expects
        // it in client code and rate-limits it by URL referrer. Serving it
        // from here rather than hardcoding it in public/app.js keeps it out
        // of git and lets it be rotated with `wrangler secret put` alone.
        case '/api/config':
          return json({ mapboxToken: env.MAPBOX_TOKEN || null }, 200, origin);
        case '/api/geocode':
          return await handleGeocode(url, env, origin);
        case '/api/mask':
          return await handleMask(url, origin);
        case '/api/prediction':
          return await handlePrediction(url, env, origin);
        case '/api/parcel':
          return await handleParcel(url, origin);
        case '/api/imagery':
          return await handleImagery(url, env, origin);
        case '/api/segment':
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          return await handleSegment(request, env, origin);
        case '/api/quota': {
          const clientId = url.searchParams.get('clientId') || 'anon';
          return json(await checkQuota(request, env, clientId), 200, origin);
        }
        default:
          if (url.pathname.startsWith('/api/')) {
            return json({ error: 'Not found' }, 404, origin);
          }
          // Static assets are matched before the Worker runs, so anything
          // reaching here is an unknown path. Hand back the app shell so
          // deep links and refreshes land on the site, not on JSON.
          return env.ASSETS
            ? await env.ASSETS.fetch(new Request(new URL('/', url), request))
            : json({ error: 'Not found' }, 404, origin);
      }
    } catch (err) {
      return json({ error: 'Internal error', detail: String(err.message) }, 500, origin);
    }
  },
};
