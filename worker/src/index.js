/**
 * Lawn Mapper API (Cloudflare Worker).
 *
 * Endpoints:
 *   GET  /api/geocode?q=<address>      -> candidate addresses (no quota)
 *   GET  /api/parcel?lng=&lat=         -> parcel boundary or null (no quota)
 *   GET  /api/imagery?...              -> signed satellite PNG (no quota)
 *   POST /api/segment                  -> SAM lawn mask (CONSUMES QUOTA)
 *   GET  /api/quota?clientId=          -> remaining allowance
 *
 * Secrets (wrangler secret put):
 *   MAPBOX_TOKEN     -- pk.* token, also used server-side for geocoding
 *   REPLICATE_TOKEN  -- r8_* token. NEVER exposed to the browser.
 * Bindings:
 *   QUOTA            -- KV namespace for measurement counting
 */

import { lookupParcel } from './parcel.js';
import { measure } from './area.js';
import { isCovered } from './counties.js';
import { checkQuota, consumeQuota } from './quota.js';

const ALLOWED_ORIGINS = [
  'https://lawn-mapper.pages.dev',
  'http://localhost:8788',
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
 * Proxies one Mapbox Static Images request. Server-side so the frontend
 * never needs the token for this, and so we can pin the parameters --
 * the same frame feeds SAM and the PDF export, so it must be reproducible.
 */
function buildImageryUrl(lng, lat, zoom, size, token) {
  const s = Math.min(Math.max(size, 256), 1280); // Mapbox caps at 1280
  return (
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${lng},${lat},${zoom},0/${s}x${s}@2x?access_token=${token}&attribution=false&logo=false`
  );
}

async function handleImagery(url, env, origin) {
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  const zoom = Math.min(Math.max(parseFloat(url.searchParams.get('zoom')) || 19, 15), 20);
  const size = parseInt(url.searchParams.get('size'), 10) || 640;

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

/* --------------------------------------------------------------- segment */
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

  const { lng, lat, zoom = 19, size = 640, clientId, promptPoint } = body;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !clientId) {
    return json({ error: 'lng, lat, and clientId required' }, 400, origin);
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

  const imageUrl = buildImageryUrl(lng, lat, zoom, size, env.MAPBOX_TOKEN);
  const px = Math.round((size * 2) / 2); // centre of the @2x image

  const res = await fetch('https://api.replicate.com/v1/models/meta/sam-2/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REPLICATE_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        // Default prompt is the image centre -- the geocoded address, which
        // for a residential parcel is the house. The frontend should instead
        // send the parcel polygon's centroid nudged off the roof, or let the
        // user tap their lawn. SAM segments whatever is under this point.
        point_coords: promptPoint || [[px, px]],
        point_labels: [1],
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'Segmentation failed', detail }, 502, origin);
  }

  const prediction = await res.json();
  if (prediction.status !== 'succeeded') {
    return json(
      { error: 'Segmentation incomplete', status: prediction.status, id: prediction.id },
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
        case '/api/geocode':
          return await handleGeocode(url, env, origin);
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
          return json({ error: 'Not found' }, 404, origin);
      }
    } catch (err) {
      return json({ error: 'Internal error', detail: String(err.message) }, 500, origin);
    }
  },
};
