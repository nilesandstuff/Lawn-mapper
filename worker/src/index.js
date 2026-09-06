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
 *   GET  /api/config                   -> public Mapbox token + imagery sources
 *   GET  /api/geocode?q=<address>      -> candidate addresses (no quota)
 *   GET  /api/parcel?lng=&lat=         -> parcel boundary or null (no quota)
 *   GET  /api/imagery?...              -> satellite PNG (no quota)
 *   GET  /api/mask?url=<replicate url> -> proxied SAM mask (no quota)
 *   POST /api/segment                  -> SAM lawn mask (CONSUMES QUOTA)
 *   GET  /api/quota?clientId=          -> remaining allowance
 *
 * Secrets (wrangler secret put):
 *   MAPBOX_TOKEN        -- pk.* token handed to the browser. Restrict this one
 *                          by URL; anyone can read it out of /api/config.
 *   MAPBOX_SERVER_TOKEN -- optional. Used for the Worker's own calls, which
 *                          send no Referer and so cannot satisfy a URL
 *                          restriction. Never sent to the browser. Falls back
 *                          to MAPBOX_TOKEN when unset.
 *   REPLICATE_TOKEN  -- r8_* token. NEVER exposed to the browser.
 * Bindings:
 *   QUOTA            -- KV namespace for measurement counting
 *   ASSETS           -- the static site in public/
 */

import { lookupParcel } from './parcel.js';
import { isCovered } from './counties.js';
import { checkQuota, consumeQuota, refundQuota } from './quota.js';
// Constants and the version lookup live in their own module: a Workers
// entrypoint may only export handlers, and exporting a plain constant from
// here kills the isolate on startup.
import {
  MODELS, samVersion, samThreshold, normaliseModel, modelCatalogue,
} from './sam.js';
// Which satellite picture to use, and how to ask each source for exactly our
// frame. Also lives outside the entrypoint, for the same reason as sam.js.
import {
  imageryUrl, detectionImageUrl, imageryPrompt, normaliseProvider,
  detectionProvider, providerCatalogue,
} from './imagery.js';
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
      access_token: serverToken(env),
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
 * The token for the Worker's own calls to Mapbox.
 *
 * A URL restriction is enforced from the Referer header, and a request made
 * from a Worker has no Referer at all. So the moment MAPBOX_TOKEN is properly
 * locked to a domain, the geocode and the satellite imagery -- both made from
 * here, not the browser -- can start failing, while the map itself keeps
 * drawing perfectly because tile requests DO carry a Referer. That failure
 * reads as a broken app rather than a token setting, which is what makes it
 * worth designing out instead of watching for.
 *
 * So server-side calls use their own unrestricted token, kept as a Cloudflare
 * secret and never handed to a browser. It falls back to MAPBOX_TOKEN so that
 * a deployment without it behaves exactly as before.
 */
const serverToken = (env) => env.MAPBOX_SERVER_TOKEN || env.MAPBOX_TOKEN;

/**
 * Mapbox caps the static endpoint at 1280. Clamping is hoisted out of the URL
 * builder so /api/segment can report the size it actually used: the browser
 * converts mask pixels back to lng/lat with these exact numbers, and a frame
 * that says 1600 when the image is 1280 puts the lawn in the wrong place.
 */
const clampSize = (size) => Math.min(Math.max(size, 256), 1280);
const clampZoom = (zoom) => Math.min(Math.max(zoom, 15), 20);

/** The frame and source named by a query string, clamped and defaulted. */
function frameFromQuery(params) {
  const lng = parseFloat(params.get('lng'));
  const lat = parseFloat(params.get('lat'));
  return {
    frame: {
      lng,
      lat,
      zoom: clampZoom(parseFloat(params.get('zoom')) || 19),
      size: clampSize(parseInt(params.get('size'), 10) || 640),
    },
    // Viewing, not measuring: whatever was asked for.
    provider: normaliseProvider(params.get('provider')),
  };
}

/**
 * Proxies one satellite image request. Server-side so the frontend never needs
 * a token for this, and so we can pin the parameters -- the same frame feeds
 * SAM and the export, so it must be reproducible.
 */
async function handleImagery(url, env, origin) {
  const { frame, provider } = frameFromQuery(url.searchParams);

  if (!Number.isFinite(frame.lng) || !Number.isFinite(frame.lat)) {
    return json({ error: 'lng and lat required' }, 400, origin);
  }

  const src = imageryUrl(provider, frame, serverToken(env));
  // Esri serves tiles and nothing else; the browser paints those itself.
  if (!src) return json({ error: 'That source has no single-image form', provider }, 400, origin);

  const res = await fetch(src);
  if (!res.ok) return json({ error: 'Imagery unavailable', provider }, 502, origin);

  return new Response(res.body, {
    headers: {
      // USGS answers image/png; Mapbox answers image/png too, but take the
      // source's own word rather than asserting it for whatever gets added
      // next.
      'Content-Type': res.headers.get('Content-Type') || 'image/png',
      // Imagery for a fixed frame and source never changes. Cache hard.
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
  const provider = detectionProvider(body.provider);
  const modelId = normaliseModel(body.model);
  const model = MODELS[modelId];

  /*
   * Pins, in the pixel space of the image the model will be shown.
   *
   * The browser sends them already converted, because it is the only side that
   * knows the image's real dimensions -- Mapbox renders at @2x, so a 640
   * frame arrives as 1280 px, and a point in the wrong space lands somewhere
   * else in the photograph entirely. Validated rather than trusted: a
   * malformed point is a wasted prediction and a confusing failure.
   */
  const points = Array.isArray(body.points)
    ? body.points
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [Math.round(x), Math.round(y)])
        .slice(0, 32)
    : [];

  if (model.needsPoints && !points.length) {
    // Before the quota is touched: this one is the caller's mistake, and
    // charging a detection for it would be charging for nothing.
    return json(
      { error: 'That model needs at least one pin. Tap the lawn first.' },
      400,
      origin
    );
  }

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

  /*
   * Replicate fetches this URL itself, so it has to be publicly reachable.
   * Mapbox's carries our server token, which is why the two ArcGIS sources are
   * a small improvement as well as a new option: their URLs carry no secret.
   */
  const imageUrl = detectionImageUrl(provider, { lng, lat, zoom, size }, serverToken(env));

  // A text prompt finds every patch of grass in the frame at once, including
  // the disconnected ones a person would have to remember to point at. What
  // it also finds is the neighbours' grass, so the browser clips the result
  // to the property line before measuring anything.
  //
  // The wording belongs to the source: an infrared vegetation index has no
  // "grass" in it to find, only vegetation, so each provider carries its own.
  const prompt = imageryPrompt(provider, env);

  let version;
  try {
    version = await samVersion(env, modelId);
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
      input: model.input(imageUrl, { prompt, threshold: samThreshold(env), points }),
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
        frame: { lng, lat, zoom, size, provider }, model: modelId,
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
      frame: { lng, lat, zoom, size, provider }, model: modelId,
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
          // The imagery list ships from here rather than being written out
          // again in app.js: the browser's picker and the Worker's URL builder
          // have to agree on what "ndvi" means, and a second copy of a list is
          // a second copy that can be wrong.
          return json(
            { mapboxToken: env.MAPBOX_TOKEN || null, imagery: providerCatalogue(), models: modelCatalogue() },
            200,
            origin
          );
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
