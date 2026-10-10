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
 *   GET  /api/coverage                 -> every state and county with parcels
 *   GET  /api/geocode?q=<address>      -> candidate addresses (no quota)
 *   GET  /api/parcel?lng=&lat=         -> parcel boundary or null (no quota)
 *   GET  /api/parcel/neighbours?county=&bbox=w,s,e,n -> the parcels around one (tinker mode)
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
 *   GOOGLE_MAPS_KEY  -- optional. Enables the Google satellite source; without
 *                       it that source is not offered at all. Billed per
 *                       request, so it is never sent to the browser either.
 * Bindings:
 *   QUOTA            -- KV namespace for measurement counting
 *   ASSETS           -- the static site in public/
 */

import { countyServicesAt, countyChoicesAt, countyServiceById } from './county.js';
import { encodePng } from './tile-mosaic.js';
import { lookupParcel, lookupNeighbours } from './parcel.js';
import { isCovered, servesCounty } from './counties.js';
import { coverage, coverageSummary, NEAR_COMPLETE } from './coverage.js';
import { checkQuota, consumeQuota, refundQuota } from './quota.js';
import { charge, refund, allowance } from './allowance.js';
// Why an upstream refused us, redacted. In its own module because a Workers
// entrypoint may only export handlers, and this needs a test: it is the only
// thing between an upstream error page and a leaked API key.
import { upstreamReason } from './upstream.js';
import { logMeasurement, readLog, loggingEnabled, recordLater } from './testlog.js';
import { recordFeedback, readFeedback, feedbackEnabled } from './feedback.js';
import { recordFinished } from './corpus.js';
import { storeMapPhoto, countyPicture } from './county-picture.js';
import { handleAuth, isAuthPath } from './routes-auth.js';
import { handleMaps } from './routes-maps.js';
import { handleAdmin, isAdminPath } from './routes-admin.js';
import { handleJobs, spendJobDetection, jobDetection } from './routes-jobs.js';
import { accountsEnabled, publicUser } from './db.js';
import { currentUser } from './auth.js';
import { recordParcelGap } from './gaps.js';
import { llmsTxt } from './llms.js';

/* Named in robots.txt (see the case there): search engines, the AI
   assistants' search and on-request fetch agents, then training crawlers. */
const ROBOTS_AGENTS = [
  'Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot', 'YandexBot',
  'OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'MistralAI-User',
  // Training (owner, 2026-10-08).
  'GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot',
  'Meta-ExternalAgent', 'Amazonbot',
];
import { versionHistory } from './model-versions.js';
// Constants and the version lookup live in their own module: a Workers
// entrypoint may only export handlers, and exporting a plain constant from
// here kills the isolate on startup.
import {
  MODELS, samVersion, samThreshold, samPrompt, normaliseModel, modelCatalogue,
  SAM_INPUT_PX, samMaxTilesAcross,
  promptProblem, normaliseExclusions, exclusionPass, exclusionCatalogue,
  DEFAULT_EXCLUSIONS, DEFAULT_MODEL, defaultModelFor,
} from './sam.js';
import { alphaEnabled, startAlpha, pollAlpha, isAlphaId, alphaMaskResponse } from './alpha.js';
import { pressIdOf, openPress, releasePress, stopPrediction } from './presses.js';
import { countPress, markRefunded } from './usage.js';
import { covers, lawnMaskUrl, LANDCOVER_HOST, overlayCatalogue } from './landcover.js';
// Which satellite picture to use, and how to ask each source for exactly our
// frame. Also lives outside the entrypoint, for the same reason as sam.js.
import {
  imageryUrl, detectionImageUrl, imageryPrompt, normaliseProvider,
  detectionProvider, providerCatalogue, providerFrame, providerAvailable,
  detectionPlan, imagePixels, imageHeightPixels, frameBbox3857,
} from './imagery.js';
// Shared with the browser, which loads the same file over HTTP. See the note
// at the top of that file for why it lives outside worker/.
import { measure } from '../../public/lib/area.js';

/**
 * Only needed for `wrangler dev` and for anyone embedding the API. The
 * deployed site is same-origin, so it never sends an Origin we have to match.
 */
const ALLOWED_ORIGINS = [
  'https://lawnmap.nilesandstuff.com',
  'https://nilesandstuff.com',
  'https://www.nilesandstuff.com',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

/*
 * NO Access-Control-Allow-Credentials, deliberately.
 *
 * The app and this API are served by the same Worker on the same origin, so
 * the session cookie travels without CORS being involved at all. Allowing
 * credentials cross-origin would buy nothing and would make the allowlist
 * above load-bearing for account security rather than for convenience -- one
 * wrong entry, or one wildcard added in a hurry, and another site could spend
 * somebody's credits with their own cookie.
 *
 * It is also what lets SameSite=Lax stand in for a CSRF token: a cross-site
 * request either carries no cookie (Lax) or is refused for want of credentials
 * (here), and a form on another site can do neither.
 */
function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
 * Address -> coordinates. Returns up to 5 candidates so the user confirms the
 * right one before anything is spent on imagery.
 *
 * NO PROXIMITY BIAS. There used to be one, pinned at -85.67,43.00 -- a point
 * in West Michigan -- from when that was the entire coverage area. It is a
 * ranking thumb on the scale, not a filter, so it never blocked anything; what
 * it did was quietly sort a Raleigh street above or below its Michigan
 * namesake by distance from Grand Rapids. With North Carolina statewide and
 * Nevada in the list, that thumb is pressing for the wrong place most of the
 * time, and it would go on doing so invisibly: the user sees five plausible
 * addresses in a sensible-looking order and no sign that the order was decided
 * by a constant written for a different product.
 *
 * Nothing replaces it. The Worker has no idea where the user is -- and
 * guessing from the request would be worse than not guessing -- so the honest
 * ranking is Mapbox's own, over the whole country, with the user picking from
 * the candidates. That is what the confirm step is for.
 */
async function handleGeocode(url, env, origin) {
  /*
   * TWO WAYS IN, ONE WAY OUT.
   *
   * Typing an address and pressing "Use my location" are the same question
   * asked from different ends, and everything downstream -- the candidate
   * list, the confirm step, the parcel lookup, the gap log -- wants the same
   * answer shape. Mapbox has a separate reverse endpoint, so the branch is
   * here and nothing past this function knows which way somebody arrived.
   *
   * THE COUNTY NAME IS THE REASON THIS IS A SERVER ROUND TRIP at all. The
   * browser has the coordinates already, and the parcel lookup would take
   * them. But `servesCounty` needs the county and state to tell "your county
   * is not configured" from "your county is configured and has no record of
   * this parcel" -- and getting that wrong is exactly the Gwinnett bug, where
   * a bounding box that reached into the next county sent somebody debugging
   * a server that was never involved.
   */
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  const reverse = Number.isFinite(lng) && Number.isFinite(lat);

  const q = (url.searchParams.get('q') || '').trim();
  if (!reverse && q.length < 4) return json({ error: 'Address too short' }, 400, origin);
  if (reverse && (Math.abs(lng) > 180 || Math.abs(lat) > 90)) {
    return json({ error: 'Not a point on Earth' }, 400, origin);
  }

  const endpoint = reverse
    ? 'https://api.mapbox.com/search/geocode/v6/reverse?' +
      new URLSearchParams({
        longitude: String(lng),
        latitude: String(lat),
        access_token: serverToken(env),
        types: 'address',
        limit: '1',
      })
    : 'https://api.mapbox.com/search/geocode/v6/forward?' +
      new URLSearchParams({
        q,
        access_token: serverToken(env),
        country: 'us',
        types: 'address',
        limit: '5',
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
        /*
         * WHERE THIS IS, IN THE GEOCODER'S OWN WORDS, so a failed parcel
         * lookup can be filed under a place name.
         *
         * Taken from here rather than reverse-geocoded later, for two
         * reasons. It is free -- the answer is already in this response and
         * was being thrown away -- and it is the county of the address the
         * person actually picked, which a second lookup from a rounded
         * coordinate could disagree with.
         *
         * Mapbox calls a US county a "district". The region carries a code
         * (MI) and a name (Michigan); the code is what fits a narrow column
         * on a phone.
         */
        county: p.context?.district?.name || null,
        state: p.context?.region?.region_code || p.context?.region?.name || null,
      };
    })
    .filter((r) => r.label);

  /*
   * A COORDINATE IS STILL AN ANSWER when the geocoder has no address for it.
   *
   * Typing an address that matches nothing is a typo and should say so. A GPS
   * fix that matches nothing is somebody standing on a new-build street or a
   * long rural drive, where the coordinate is exactly right and only the
   * address is missing -- and the app's whole fallback is tracing by hand,
   * which needs nothing but a point. Refusing here would turn "we have no
   * street name for you" into "we cannot help you".
   *
   * The county still comes from the geocoder where it can: a reverse lookup
   * with no address usually still resolves the place it is in, and without it
   * the gap log files a real request under nothing.
   */
  if (reverse && !results.length) {
    const p = (data.features || [])[0]?.properties || {};
    results.push({
      label: p.full_address || p.name || 'Your current location',
      lng,
      lat,
      accuracy: 'unknown',
      inCoverage: isCovered(lng, lat),
      county: p.context?.district?.name || null,
      state: p.context?.region?.region_code || p.context?.region?.name || null,
    });
  }

  return json({ results }, 200, origin);
}

/* ----------------------------------------------------------------- parcel */
/*
 * The parcels in a box around one (tinker mode: merging a second lot, and
 * keeping a front edge moved to the road off a neighbour's). The box is
 * capped at about 400 m a side so this cannot be used to pull a county's
 * parcel layer down a tile at a time.
 */
async function handleNeighbours(url, origin) {
  const county = url.searchParams.get('county') || '';
  const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
  if (!county || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    return json({ error: 'county and bbox=w,s,e,n required' }, 400, origin);
  }
  const [w, s, e, n] = bbox;
  if (!(e > w && n > s) || e - w > 0.005 || n - s > 0.004) {
    return json({ error: 'bbox too large' }, 400, origin);
  }
  const features = await lookupNeighbours(county, bbox);
  return json({ features }, 200, origin);
}

async function handleParcel(request, url, env, origin, ctx) {
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return json({ error: 'lng and lat required' }, 400, origin);
  }

  /* What the lawn queue knows about the parcel it meant (parcel.js): its
     number, or its size when it was queued before numbers were kept. */
  const parcel = await lookupParcel(lng, lat, {
    pin: url.searchParams.get('pin') || null,
    sqft: Number(url.searchParams.get('sqft')) || null,
  });
  if (!parcel) {
    // Not an error. Most of the country, and plenty of covered addresses,
    // land here. The UI drops straight to manual boundary drawing.
    /*
     * The county the geocoder named, not just "some county's box reaches
     * here" -- see servesCounty. A box is a rectangle and a county is not, so
     * the old question said yes on an address in a neighbour of a configured
     * county and sent everybody looking in the wrong place.
     */
    const covered = servesCounty(
      lng, lat, url.searchParams.get('county'), url.searchParams.get('state'),
    );

    /*
     * BANK THE MISS. Which counties people actually ask for is the only
     * evidence that says which one to add next, and it exists for a moment
     * and then is gone -- the visitor traces by hand and nothing remembers
     * they were ever turned away.
     *
     * waitUntil, so the bookkeeping never sits between somebody and the
     * answer. recordParcelGap swallows its own failures too: this route's job
     * is to say whether there is a boundary, and it must go on doing that
     * with a missing table, a locked one, or a full one.
     *
     * Signed-in accounts count as themselves, everyone else as the browser id
     * the app already sends for its allowance. Nothing here stores an address
     * or an IP -- the question is how many people, not who.
     */
    const record = (async () => {
      const me = await currentUser(request, env, ctx).catch(() => null);
      await recordParcelGap(env, {
        county: url.searchParams.get('county'),
        state: url.searchParams.get('state'),
        who: me?.id || url.searchParams.get('clientId'),
        covered,
      });
    })();
    if (ctx?.waitUntil) ctx.waitUntil(record); else await record.catch(() => {});

    return json({ parcel: null, covered }, 200, origin);
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
      /* The frame is a rectangle since 2026-09-23: the parcel's box plus a
         margin, cropped both ways. A request without a height is the square
         it always was. */
      height: clampSize(parseInt(params.get('height'), 10) || parseInt(params.get('size'), 10) || 640),
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

  if (!providerAvailable(provider, env)) {
    return json({ error: 'That source is not configured here', provider }, 400, origin);
  }
  /* The county photo: only a service in the catalogue, by its id. */
  if (provider === 'county') {
    frame.svc = await countyServiceById(env, url.searchParams.get('svc'));
    if (!frame.svc) return json({ error: 'No county photo service by that id', provider }, 400, origin);
    if (frame.svc.tiled) return countyMosaic(url, frame, origin);
  }
  const src = imageryUrl(provider, frame, serverToken(env), env);
  // Esri serves tiles and nothing else; the browser paints those itself.
  if (!src) return json({ error: 'That source has no single-image form', provider }, 400, origin);

  const res = await fetch(src);
  if (!res.ok) {
    return json({
      error: 'Imagery unavailable', provider,
      upstream: res.status,
      reason: await upstreamReason(res),
    }, 502, origin);
  }

  return new Response(res.body, {
    headers: {
      // USGS answers image/png; Mapbox answers image/png too, but take the
      // source's own word rather than asserting it for whatever gets added
      // next.
      'Content-Type': res.headers.get('Content-Type') || 'image/png',
      // Imagery for a fixed frame and source never changes. Cache hard --
      // except a county photo, whose request can change under the same URL
      // (2026-10-09, C48: a blank picture, kept a day by the browser, went
      // on hiding the fix). An hour.
      'Cache-Control': provider === 'county' ? 'public, max-age=3600' : 'public, max-age=86400',
      ...cors(origin),
    },
  });
}

/**
 * A tiles-only county photo of exactly this frame, stitched here
 * (county-picture.js) and kept in the edge cache under its own URL: the
 * editor asks once, a detector asks again for the same frame and gets the
 * copy. The same size a Mapbox picture of the frame would be (the @2x
 * pixels, at most 2560 a side). Made here rather than in the browser since
 * the Workers Paid plan (owner, 2026-10-02): a picture made by the page for
 * one frame was detected against another when the property line moved
 * while it was being stitched.
 */
async function countyMosaic(url, frame, origin) {
  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const img = await countyPicture(frame.svc, frame, { W: imagePixels(frame), H: imageHeightPixels(frame) })
    .catch(() => null);
  if (!img) return json({ error: 'No county photo here', provider: 'county', upstream: 404 }, 502, origin);
  const res = new Response(await encodePng(img), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ...cors(origin) },
  });
  await cache.put(key, res.clone());
  return res;
}

/*
 * TILES-ONLY COUNTY PHOTOS, THE EDITOR'S SIDE -- REMOVED (2026-10-04). The
 * browser used to stitch tiles and upload the picture (/api/county-meta,
 * /api/county-tile, /api/county-frame); since the Workers Paid plan the Worker
 * makes it itself (countyMosaic), and the upload route had become an open,
 * unsigned file host on this domain. Those paths now fall through to 404.
 */

/* ------------------------------------------------------------------ mask */
/**
 * Proxies the SAM mask image back to the browser from our own origin.
 *
 * Required, not a nicety: the browser has to read the mask's pixels off a
 * <canvas> to trace it, and a cross-origin image taints the canvas so
 * getImageData() throws. Serving it from here keeps the canvas clean whatever
 * CORS headers Replicate's CDN happens to send.
 */
/*
 * The hosts this endpoint will fetch from, and nothing else.
 *
 * A LIST because masks now come from two places: Replicate's CDN, and the land
 * cover service, whose exportImage answer is a mask in every sense that
 * matters here. Both are read off a canvas by the same tracer and both need
 * the same treatment.
 *
 * This list is the whole of the open-proxy guard, so it is a list of hosts and
 * never of patterns. Anything looser and the Worker fetches arbitrary URLs for
 * anyone who asks, including addresses only reachable from inside Cloudflare's
 * network.
 */
const MASK_HOSTS = ['replicate.delivery', LANDCOVER_HOST];

async function handleMask(url, origin, env) {
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'url required' }, 400, origin);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'Invalid url' }, 400, origin);
  }

  /* The trained model's masks are this Worker's own, kept in R2: read them
     there rather than fetching ourselves over the network. Same host only --
     this is not a way to widen the list below. */
  if (target.host === url.host && target.pathname === '/api/alpha-mask') {
    return alphaMaskResponse(env, target.searchParams.get('id') || '', cors(origin),
      { raw: target.searchParams.get('raw') === '1' });
  }

  // Without this check the endpoint is an open proxy: anyone could use the
  // Worker to fetch arbitrary hosts, including addresses only reachable from
  // Cloudflare's network.
  const host = target.hostname;
  const allowed =
    target.protocol === 'https:' &&
    MASK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
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
  /* The trained model's lots, polled on Modal. See alpha.js. */
  if (isAlphaId(id)) {
    if (!alphaEnabled(env)) return json({ status: 'failed', mask: null, detail: 'The trained model is not switched on here.' }, 200, origin);
    try {
      return json(await pollAlpha(env, id, url.origin), 200, origin);
    } catch (e) {
      // A dropped poll is not a failed lot; the browser asks again.
      return json({ error: 'Could not read the trained model', detail: String(e?.message || e) }, 502, origin);
    }
  }
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
async function handleSegment(request, env, origin, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  /*
   * Who is asking, if anybody. Null is the ordinary case and must stay
   * cheap: a signed-out visitor measuring a lawn is what this app is for, and
   * accounts are an addition to that rather than a gate in front of it.
   */
  const user = await currentUser(request, env, ctx);

  const { lng, lat, clientId } = body;
  /* The browser's name for this press, so a cancel can find it. See presses.js. */
  const press = pressIdOf(body.press);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !clientId) {
    return json({ error: 'lng, lat, and clientId required' }, 400, origin);
  }

  const zoom = clampZoom(Number(body.zoom) || 19);
  const size = clampSize(Number(body.size) || 640);
  const height = clampSize(Number(body.height) || size);
  let provider = detectionProvider(body.provider);
  /*
   * THE COUNTY PHOTO is whichever service covers this lot, named by its id in
   * the catalogue (county_services) -- never a URL from the request. One that
   * is not there measures on Mapbox, and the echoed frame says so.
   */
  const svc = provider === 'county' ? await countyServiceById(env, body.svc) : null;
  /* A detector fetches a tile cache's picture from this Worker (imagery.js
     countyExportUrl -> countyMosaic), made for exactly the frame posted. A
     picture a browser stitched and uploaded (`countyFrame`, from pages
     before 2026-10-02) is no longer used: it could be of an earlier frame. */
  if (svc) svc.selfOrigin = new URL(request.url).origin;
  if (provider === 'county' && !svc) provider = 'mapbox';
  const sv = svc ? { svc } : {};
  /*
   * Not const, because the land cover method can hand the request back to the
   * AI when its raster does not reach the address. See the fallback below --
   * everything downstream reads these two, so the substitution has to happen
   * in them rather than beside them.
   */
  let modelId = normaliseModel(body.model);
  let model = MODELS[modelId];

  /*
   * THE TRAINED MODEL WHERE NO RELEASE IS SERVED falls back to "Find grass"
   * and says so, like the land cover method below. A page cached from a
   * deployment that had it, or a release pulled, must not become a button
   * that fails.
   */
  let fellBack = null;
  if (model.modal && !alphaEnabled(env)) {
    fellBack = 'alpha';
    modelId = DEFAULT_MODEL;
    model = MODELS[modelId];
  }

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

  /*
   * THE LAND COVER METHOD, answered here and never reaching Replicate.
   *
   * Before the allowance on purpose, and not as an optimisation: this method
   * costs nothing, so taking a slot and handing it back would leave a visible
   * flicker in somebody's remaining count for a press that was always free.
   *
   * Coverage is asked rather than assumed. The raster is the Chesapeake
   * watershed plus adjacent counties, which is not a rectangle and has holes
   * inside states it otherwise covers -- Roanoke has data and Bristol, in the
   * same state, does not. One identify call settles it, and a wrong box would
   * either offer the method where it cannot work or withhold it where it can.
   *
   * WHEN IT CANNOT WORK, FALL BACK rather than refuse. Dropping through to the
   * ordinary path gives the person the AI answer they would have got anyway,
   * and `fellBack` lets the browser say which one it used -- an outline with no
   * label is the one thing that must not happen here, because the whole point
   * of shipping both is finding out which is better.
   */
  if (model.local) {
    const served = providerFrame(provider, { lng, lat, zoom, size, height, ...sv });
    if (await covers(lng, lat, env)) {
      return json({
        frame: served,
        model: modelId,
        subtractive: false,
        free: true,
        passes: [{ status: 'succeeded', exclusion: null, mask: lawnMaskUrl(served, env) }],
      }, 200, origin);
    }
    fellBack = 'landcover';
    modelId = DEFAULT_MODEL;
    model = MODELS[modelId];
  }

  /*
   * Developer mode's overrides, checked BEFORE the allowance is touched.
   *
   * A prompt over the encoder's 32-token limit does not answer badly, it
   * errors -- and charging a slot of a twenty-a-day allowance for a request
   * that cannot succeed is the wrong way round. This is the caller's mistake,
   * like a missing pin, so it is refused here and costs nothing.
   *
   * Nothing about this is a security boundary: the panel is hidden, not
   * guarded, and anyone can post these fields. That is deliberate and it is
   * fine -- an arbitrary prompt costs exactly one prediction, which the quota
   * already caps. What the Worker still owes is validation, because a bad
   * value from anywhere is a wasted prediction and a confusing failure.
   */
  const devPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (devPrompt) {
    const problem = promptProblem(devPrompt);
    if (problem) return json({ error: problem, prompt: devPrompt }, 400, origin);
  }

  /*
   * The Testing method has no prompt of its own, so a blank one is not "use
   * the default" -- there is no default to use. Falling through would send the
   * imagery source's "grass" and quietly turn a test of nothing into a test of
   * something else, which is the ambiguity this method exists to remove.
   */
  if (model.devOnly && !devPrompt) {
    return json(
      { error: 'The Testing method needs a prompt; it has none of its own.' },
      400,
      origin
    );
  }

  /*
   * WHAT TO ASK, AND HOW MANY TIMES.
   *
   * "Find grass" asks one question. "Exclude objects" asks one question per
   * ticked box, because the model resolves one concept per prediction and a
   * comma list is not several concepts -- it is one vague phrase, which is the
   * finding that took three rounds of measurement to reach. See EXCLUSIONS.
   *
   * So a pass is the unit of everything downstream: one prompt, one threshold,
   * one prediction, one item of the daily allowance, one mask for the browser
   * to take away from the property.
   */
  const devThreshold = body.threshold ?? null;
  let passes;

  if (model.exclusions) {
    const wanted = normaliseExclusions(body.exclude);
    if (devPrompt) {
      /*
       * A typed prompt REPLACES the boxes rather than joining them.
       *
       * Adding to them would make a panel result unreadable in exactly the way
       * the Testing method exists to prevent: a surprising mask would have two
       * possible sources and the screen could not say which. One typed concept,
       * one pass, one thing to attribute the answer to -- which is also how
       * "man-made" was found.
       */
      passes = [{ id: 'typed', prompt: devPrompt, threshold: samThreshold(env, modelId, devThreshold) }];
    } else if (!wanted.length) {
      // Before the allowance is touched: nothing to remove means the answer is
      // the whole lot, which needs no AI and should cost nothing.
      return json(
        {
          error: 'Tick at least one thing to remove, or switch to "Find grass".',
          exclude: [],
        },
        400,
        origin
      );
    } else {
      passes = wanted.map((id) => exclusionPass(id, env, devThreshold));
    }
  } else if (model.modal) {
    /* No prompt and no cut: the trained model answers one question. */
    passes = [{ id: null, prompt: 'trained model', threshold: null }];
  } else {
    passes = [{
      id: null,
      prompt: samPrompt(modelId, imageryPrompt(provider, env), env, devPrompt),
      threshold: samThreshold(env, modelId, devThreshold),
    }];
  }

  /*
   * HOW MANY PICTURES, so that the model reads 10 cm a pixel.
   *
   * The frame the browser sent is the one on its screen -- the parcel fitted
   * into 640 logical pixels -- and SAM reads its input at a fixed size, so
   * on a big lot that picture reached the model coarser than it was built
   * for and nothing said so. The plan cuts such a lot into pieces at the
   * target and the model is asked once per piece; a lot that already fits is
   * a plan of one and goes exactly as it always did. See detectionPlan.
   *
   * Decided BEFORE the allowance is touched, because every piece is a
   * prediction and the charge has to be for all of them.
   */
  /* The trained model reads the whole lot in one picture, as it was trained:
     one piece, one pass, one slot of the allowance. */
  const plan = model.modal
    ? { tiles: [{ col: 0, row: 0 }], cols: 1, rows: 1, frame: null, groundM: 0, capped: false }
    : detectionPlan(provider, { lng, lat, zoom, size, height, ...sv }, {
      inputPx: SAM_INPUT_PX,
      maxAcross: samMaxTilesAcross(env),
    });
  const starts = passes.length * plan.tiles.length;
  const pieces = plan.tiles.length > 1
    ? ` in ${plan.tiles.length} pieces` : '';

  // Every pass is a separate prediction and a separate bill, so the allowance
  // is charged for all of them at once -- all or nothing, because a detection
  // missing one exclusion is a wrong answer rather than a smaller one. And
  // every PIECE of a pass is a prediction too, for the same reason.
  /*
   * Developer mode asks for the larger allowance by sending a flag.
   *
   * Unguarded, and deliberately not dressed up as anything else: the unlock
   * key is a plain string in app.js, so there is no client-side secret that
   * could make this a real check. It raises one person's ceiling; the per-IP
   * backstop that actually limits the damage is untouched. See quota.js.
   */
  const dev = body.dev === true;

  /*
   * Record what happened, whatever happened.
   *
   * The log sat AFTER the Replicate call, which meant the two failures most
   * worth debugging -- our own allowance refusing a press, and the detector
   * refusing us -- were the only outcomes it never captured. "It says I have
   * used today's detections and I have not" was reported, and the log had
   * nothing to say about it, because a refused detection left no trace at all.
   *
   * `detail` carries the numbers behind the refusal, which is the whole reason
   * for logging one: "refused, 20 of 20" and "refused by the detector" are
   * different problems that produce the same sentence on screen.
   *
   * EACH PASS CARRIES ITS OWN CUT, so the log has to as well. It used to write
   * `threshold: passes[0].threshold` beside a prompt field that already joined
   * every pass -- so "man-made + woods" logged 0.05 and said nothing about the
   * 0.2 that the second prediction actually used. The number was right for one
   * pass and silently wrong for two, which is the shape of bug a log is
   * supposed to catch rather than produce. Pairing the cut with the concept it
   * belongs to makes them impossible to mismatch, whatever the pass count.
   */
  const passLabel = (pass) =>
    Number.isFinite(pass.threshold) ? `${pass.prompt} @${pass.threshold}` : pass.prompt;

  const note = (outcome, detail = null) => recordLater(ctx, logMeasurement(env, {
    address: body.address,
    lng, lat, zoom,
    provider, model: modelId,
    prompt: passes.map(passLabel).join(' + '),
    // Only meaningful when there is one; the pairs above are the answer for
    // several. See testlog.js.
    threshold: passes.length === 1 ? passes[0]?.threshold : null,
    // Predictions started, not concepts asked: a two-box press on a lot cut
    // into four pieces is eight, and eight is what the bill says.
    passes: starts,
    parcelSqFt: body.parcelSqFt,
    county: body.county,
    clientId,
    outcome,
    detail,
  }));

  /*
   * WHO PAYS, AND HOW.
   *
   * Everybody spends a daily allowance of AI passes that comes back in the
   * morning; signing in makes it bigger, and bought credits are spent only
   * once the day's are gone. Every pass is one Replicate prediction either
   * way, so all of it is counted in passes and all of it refuses before any
   * money moves. See allowance.js, which owns that decision -- including why
   * making extra accounts is not a way round it -- so this handler does not.
   */
  /*
   * EXCEPT ON A LAWN SOMEBODY IS BEING PAID TO TRACE.
   *
   * A paid worker arrives signed out, from a crowd platform, and the automatic
   * outline is the thing they are paid to correct -- so they have to be able
   * to get one. The signed-out allowance is five passes a day for a whole
   * browser, which fifteen maps exhausts on the sixth, and raising it would
   * hand the same number to every visitor on the internet.
   *
   * So the JOB pays, and the claim is what makes that safe: the row has to
   * exist, be claimed, and be held by the worker whose id was sent -- and a
   * worker holds one lawn at a time. See spendJobDetection.
   *
   * ON THE PAID ROUTE THE WORKER IS THE ACCOUNT, and it is filled in here
   * rather than trusted from the request. That route has no worker id to send
   * -- the identity comes from the session, because it decides who gets paid --
   * so requiring one meant a paid tracer's passes came out of their own daily
   * allowance rather than the lawn's. Nothing is loosened by the fallback:
   * spendJobDetection still requires that this exact worker be holding that
   * exact row, and `user` was proved by a link sent to an address that received
   * it, which is stronger than anything a query string could say.
   *
   * Tried before `charge` rather than after a refusal, so a worker never
   * spends their own browser's allowance on work that has already been paid
   * for -- and the refund path below never has to know about any of this.
   */
  const claimant = body.worker || user?.id || '';
  const onLawn = body.job && claimant
    ? await jobDetection(env, body.job, claimant, starts)
    : null;
  const onTheClock = Boolean(onLawn?.spent);

  /*
   * AND ON THE TWO PUBLIC ROUTES IT NEVER FALLS THROUGH TO THEIR OWN.
   *
   * A volunteer is doing the owner a favour; somebody on the paid link is owed
   * 75c for each map that is approved and nothing for one that is not. Charging
   * either of them for the tool is the wrong way round -- and the AI is opt-in
   * on those routes now, so the one person who would meet the wall is the one
   * using it deliberately: land cover first, then SAM, then again after
   * dragging the boundary out to the kerb.
   *
   * The lawn's ceiling is twenty there rather than six, and when it is gone the
   * press is refused with a sentence saying so. It does NOT quietly become a
   * charge against their day, which is what "free in these workflows" has to
   * mean. See FREE_DETECTS_PER_OPEN_JOB for why there is a ceiling at all --
   * every pass is a Replicate prediction and these links are public.
   */
  const quota = onTheClock
    ? { allowed: true, free: true }
    : onLawn?.free
      ? {
        allowed: false,
        reason: 'job-passes',
        used: onLawn.used,
        limit: onLawn.ceiling,
        wanted: starts,
      }
      : await charge(request, env, {
        user, clientId, n: starts, dev,
        detail: `${starts} pass${starts > 1 ? 'es' : ''}${pieces}`
          + `${body.address ? ` at ${String(body.address).slice(0, 60)}` : ''}`,
      });

  /*
   * HANDING PASSES BACK WHEN THE DETECTOR REFUSES US, whichever purse paid.
   *
   * One helper rather than a branch at each of the two failure sites, because
   * those two sites are exactly where a forgotten case costs somebody their
   * allowance for a fault that was never theirs -- and a paid worker with no
   * starting outlines left cannot do the task at all.
   */
  const handBack = () => (onTheClock
    ? spendJobDetection(env, body.job, claimant, -starts, onLawn.ceiling)
    : refund(request, env, { user, clientId, n: starts, fromDaily: quota.fromDaily }));

  /*
   * REMEMBER THE PRESS, so it can be handed back if no trace reaches the
   * person (owner, 2026-09-29) -- see presses.js. A cancel that beat this
   * here is honoured now: the predictions are stopped and the passes returned.
   * True when the press was cancelled and has been handed back.
   */
  const recordPress = async (ids) => {
    const usageId = press || `u-${ids[0] || crypto.randomUUID()}`;
    await countPress(env, {
      id: usageId, passes: starts, model: modelId,
      who: onTheClock ? 'job' : user ? 'account' : 'visitor',
    });
    const got = await openPress(env, press, {
      clientId, userId: user?.id || null, n: starts, fromDaily: quota.fromDaily ?? null,
      job: onTheClock ? body.job : null, claimant: onTheClock ? claimant : null,
      ceiling: onTheClock ? onLawn.ceiling : null, ids,
    });
    if (got !== 'cancelled') return false;
    await handBack();
    await markRefunded(env, usageId);
    recordLater(ctx, Promise.all(ids.map((id) => stopPrediction(env, id))));
    note('cancelled', 'cancelled before the detector answered; handed back');
    return true;
  };

  if (!quota.allowed) {
    /*
     * THE LAWN'S OWN PASSES, AND NOT A WORD ABOUT ANYBODY'S ALLOWANCE.
     *
     * This one is answered first because it carries `used` and `limit` like the
     * two below it, and the browser's generic handler would otherwise read
     * those as the daily counter and say "you've used today's detections" to
     * somebody whose day is untouched -- on a screen with no counter on it,
     * since job mode hides the badge. Nothing was charged to them and nothing
     * will be: the way on from here is to draw it, or to skip the lawn.
     */
    if (quota.reason === 'job-passes') {
      note('job_passes_spent',
        `${quota.used} of ${quota.limit} on the lawn, wanted ${quota.wanted}`);
      return json(
        {
          error: 'job_passes_spent',
          /* Read before `used` and `limit` are, so this cannot be mistaken for
             the daily allowance refusal. */
          jobSpent: true,
          reason: `This lawn has had its ${quota.limit} goes at the AI, which is `
            + 'as far as that goes on one property. Nothing has been charged to '
            + 'you — draw the lawn by hand from here, or put it back with "I '
            + 'cannot do this one" and take another.',
          used: quota.used,
          limit: quota.limit,
          wanted: quota.wanted,
        },
        429,
        origin
      );
    }

    /*
     * An account that has spent today's allowance is refused differently from
     * a browser that has, because the account can be told about the bought
     * credits it has left -- and 402 rather than 429 because nothing is rate
     * limited here: the day's passes are simply gone.
     *
     * BOTH RESET, which is the change worth being careful about. The allowance
     * used to be a permanent balance, so this refusal meant "buy more"; it now
     * means "come back in the morning, or buy more", and sending the day's
     * numbers along is what lets the browser say which.
     */
    if (quota.reason === 'no-credits') {
      note('no_credits',
        `${quota.used} of ${quota.limit} today, ${quota.credits} bought, wanted ${quota.wanted}`);
      return json(
        {
          error: 'no_credits',
          credits: quota.credits,
          used: quota.used,
          limit: quota.limit,
          wanted: quota.wanted,
        },
        402,
        origin
      );
    }

    note('quota_exceeded',
      `${quota.used} of ${quota.limit} used, wanted ${quota.wanted || starts}`
      + `, ${quota.reason || 'client'}${dev ? ', dev' : ''}`);
    return json(
      {
        error: 'quota_exceeded',
        used: quota.used,
        limit: quota.limit,
        // How many this press needed, so the browser can say "this one needs
        // three and you have two left" rather than a flat refusal that reads
        // as broken when the counter plainly shows some remaining.
        wanted: quota.wanted || starts,
        // And WHY it needed so many, when a big lot is the reason.
        ...(plan.tiles.length > 1 ? { pieces: plan.tiles.length } : {}),
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
  /*
   * The frame the source can actually serve, which is not always the frame we
   * asked for -- Google only takes integer zoom. Whatever comes back here is
   * what the mask must be unprojected against, so it is this that gets echoed
   * to the browser below, not the requested one.
   */
  /*
   * One URL per piece. The plan's frames are already the ones the source can
   * serve (detectionPlan runs them through providerFrame), so what is echoed
   * to the browser below is exactly what each mask must be unprojected
   * against.
   */
  /*
   * THE TRAINED MODEL, handed to Modal here, after the allowance -- a lot costs
   * a GPU for a few seconds, so it is a detection like any other -- and
   * answered in the shape a still-running Replicate pass has, so the browser
   * polls it with the code it already has.
   *
   * The photograph is Mapbox's whatever the picker says: that is what every
   * lot it was trained on was photographed with (storeImage), and a model
   * shown a different camera is a different, unmeasured model.
   */
  if (model.modal) {
    let begun;
    try {
      begun = await startAlpha(env, {
        frame: { lng, lat, zoom, size, height },
        parcel: body.parcel?.geometry || body.parcel || null,
        /* NAIP's alignment was measured against Mapbox; on the county photo
           the model's pipeline aligns NAIP to that photo itself. */
        naipAlign: svc ? null : body.naipAlign || null,
        county: svc,
      });
    } catch (err) {
      await handBack();
      note('upstream_error', `trained model: ${err.message}`);
      return json({ error: 'The trained model could not start', detail: err.message }, 502, origin);
    }
    if (await recordPress([begun.id])) {
      return json({ error: 'cancelled', cancelled: true }, 409, origin);
    }
    note('processing', `trained model at ${(begun.groundM * 100).toFixed(1)} cm/px`);
    const pass = { exclusion: null, prompt: 'trained model', threshold: null, status: 'processing', id: begun.id, mask: null };
    return json({
      passes: [{ ...pass, tiles: [{ col: 0, row: 0, status: 'processing', id: begun.id, mask: null }] }],
      subtractive: false,
      remaining: quota.unlimited ? null
        : (Number.isFinite(quota.remaining)
          ? quota.remaining
          : Math.max(0, (quota.limit || 0) - (quota.used || 0))),
      frame: { ...begun.frame, provider: begun.provider || 'mapbox' },
      model: modelId,
      tiling: { cols: 1, rows: 1, groundCm: Math.round(begun.groundM * 1000) / 10, capped: Boolean(begun.capped) },
      pending: true,
      status: 'processing',
      id: begun.id,
    }, 202, origin);
  }

  const served = plan.frame;
  const pictures = plan.tiles.map((tile) => ({
    col: tile.col,
    row: tile.row,
    url: detectionImageUrl(provider, tile.frame, serverToken(env), env),
  }));

  // A text prompt finds every patch of grass in the frame at once, including
  // the disconnected ones a person would have to remember to point at. What
  // it also finds is the neighbours' grass, so the browser clips the result
  // to the property line before measuring anything.
  //
  // The wording belongs to the source: an infrared vegetation index has no
  // "grass" in it to find, only vegetation, so each provider carries its own.
  //
  // Unless the MODEL owns it. Exclude mode asks for buildings and trees and
  // lets the browser take them off the property, so for it the prompt is the
  // method rather than a description of the picture, and the provider does not
  // get a vote. See samPrompt and EXCLUSIONS.

  let version;
  try {
    version = await samVersion(env, modelId);
  } catch (err) {
    await handBack();
    note('no_version', err.message);
    return json({ error: 'Segmentation unavailable', detail: err.message }, 502, origin);
  }

  /*
   * All passes at once, not one after another.
   *
   * Replicate holds each connection for about a minute under `Prefer: wait`.
   * Four sequential passes would be four minutes of somebody watching a
   * spinner, and would blow past every timeout between here and the browser.
   * In parallel the wait is the slowest single pass -- the same wait a
   * one-concept detection has always had.
   */
  /*
   * AND NO RETRY. A refused request still counts against the rate limit, so
   * asking again inside the same window cannot succeed and makes the next
   * press likelier to fail -- the amplification the owner spotted when the
   * account was throttled to six a minute. It is gone and it stays gone.
   *
   * THE STARTS WENT ONE AT A TIME while that six-a-minute limit held, so a
   * refusal could stop the ones not yet sent: a throttled four-box press cost
   * one start instead of four. The account is at the standard limit now
   * (2026-09-23, six hundred a minute), and the arithmetic reversed the day
   * big lots were cut into pieces: a sixteen-piece lot on a cold model is
   * sixteen minute-long waits in a row, which no timeout between here and
   * the browser survives. In parallel the wait is the slowest single start,
   * which is the wait a one-picture press has always had.
   *
   * The upstream's OWN words still travel to the browser on a refusal.
   * Discarding the sentence that names which limit was hit is what made a
   * rate limit and a concurrency limit indistinguishable, and cost two
   * rounds of guessing.
   */
  const startPass = (pass, picture) => fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REPLICATE_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({
      version,
      input: model.input(picture.url, { prompt: pass.prompt, threshold: pass.threshold, points }),
    }),
  });

  /* Every piece of every pass, started together. */
  const started = await Promise.all(passes.flatMap((pass) => pictures.map(async (picture) => {
    const res = await startPass(pass, picture);
    if (!res.ok) return { pass, picture, http: res.status, detail: await upstreamReason(res) };
    return { pass, picture, prediction: await res.json() };
  })));
  const failed = started.find((s) => s.http) || null;
  const results = passes.map((pass) => ({
    pass,
    tiles: started
      .filter((s) => s.pass === pass && s.prediction)
      .map((s) => ({ col: s.picture.col, row: s.picture.row, prediction: s.prediction })),
  }));

  /*
   * One refused pass fails the whole detection.
   *
   * Carrying on with the rest would produce a measurement with one exclusion
   * missing -- and a missing exclusion is not a smaller answer, it is a wrong
   * one: the trees stay counted as lawn and nothing on screen says so. Better
   * to hand back the allowance and say what happened.
   */
  if (failed) {
    await handBack();
    note(failed.http === 429 ? 'rate_limited' : 'upstream_error',
      `HTTP ${failed.http}: ${failed.detail || 'no message'}${pieces}`);

    // Replicate throttles low-credit accounts to a handful of predictions a
    // minute. That is an account problem, not a bug, and saying so beats a
    // generic failure that sends the owner hunting through code. It is also
    // the likeliest thing to go wrong now that one press can fire four at
    // once -- or, on a big lot, four per box.
    if (failed.http === 429) {
      return json(
        {
          error: plan.tiles.length > 1
            ? `This lot is big enough to need ${plan.tiles.length} pictures per box, and the `
              + 'detector is rate limited. Untick a box or two, or wait a minute.'
            : passes.length > 1
              ? 'The detector is rate limited. Untick a box or two, or wait a minute.'
              : 'The detector is rate limited right now. Wait a minute and try again.',
          // Verbatim, because it names the account-level cause -- "reduced to 6
          // requests per minute" is a fact about the Replicate account that no
          // amount of care in this file can work around, and the owner is the
          // only person who can act on it.
          detail: failed.detail,
          rateLimited: true,
        },
        429,
        origin
      );
    }

    return json({ error: 'Segmentation failed', detail: failed.detail }, 502, origin);
  }

  if (await recordPress(started.map((s) => s.prediction?.id).filter(Boolean))) {
    return json({ error: 'cancelled', cancelled: true }, 409, origin);
  }

  /*
   * One entry per pass, still, with its pieces inside it.
   *
   * A pass of one piece also carries that piece's status, id and mask at the
   * top level, which is the shape every browser before tiling read -- and the
   * shape the current one reads too when there is nothing to stitch. A pass
   * of several pieces deliberately does NOT: an old tab tracing the first
   * quarter of a lot against the whole lot's frame would draw the lawn in
   * the wrong place and say nothing, and "no mask" is the better failure.
   */
  const answered = results.map(({ pass, tiles }) => ({
    exclusion: pass.id,
    prompt: pass.prompt,
    threshold: pass.threshold,
    tiles: tiles.map(({ col, row, prediction }) => ({
      col, row,
      status: prediction.status,
      id: prediction.id,
      mask: prediction.output ?? null,
    })),
    ...(tiles.length === 1
      ? {
        status: tiles[0].prediction.status,
        id: tiles[0].prediction.id,
        mask: tiles[0].prediction.output ?? null,
      }
      : { status: tiles.every((t) => t.prediction.status === 'succeeded') ? 'succeeded' : 'processing' }),
  }));

  /*
   * Record the attempt, whatever happens next.
   *
   * Logged here rather than after a successful trace because the interesting
   * reports are the failures: "it found nothing at my house" needs the address
   * kept precisely when there is no mask to show for it.
   *
   * Through waitUntil, NOT fire-and-forget. A Worker cancels any promise still
   * pending when the handler returns, so calling this and moving on wrote
   * nothing at all: the endpoint reported logging as on and stored zero
   * entries. waitUntil keeps the request alive for the write without making
   * the response wait for it, which is what "must not wait on bookkeeping"
   * should have meant.
   *
   * ONE ENTRY PER PRESS, not per pass. What a report needs to be reproduced is
   * the whole request -- four passes of one detection are one thing that
   * happened at one address, and splitting them across four rows would make
   * the log harder to read for no gain.
   */
  const pending = answered.flatMap((a) => a.tiles).filter((t) => t.status !== 'succeeded');
  note(pending.length ? pending[0].status : 'succeeded',
    pending.length
      ? `${pending.length} of ${starts} not ready yet${pieces}`
      : (plan.tiles.length > 1
        ? `${plan.cols}x${plan.rows} pieces at ${(plan.groundM * 100).toFixed(1)} cm/px`
          + (plan.capped ? ' (capped)' : '')
        : null));

  const shape = {
    passes: answered,
    subtractive: Boolean(model.subtractive),
    /*
     * WHICH METHOD ACTUALLY ANSWERED, when it was not the one asked for.
     *
     * Omitted on an ordinary press so nothing downstream has to distinguish
     * false from absent, and present only on the substitution -- which is the
     * case the browser has to speak up about. A person who chose the free
     * method and silently got the paid one has been charged a detection
     * without being told, and the comparison these two are shipped for cannot
     * be made from outlines nobody can attribute.
     *
     * This was missing from the first version of the fallback: the Worker
     * worked out the substitution and then did not mention it, so the
     * sentence in the browser could never fire. Caught by smoke-testing the
     * deployed endpoint at an address outside the raster, not by a test.
     */
    ...(fellBack ? { fellBack } : {}),
    /*
     * What is left after this press. `null` for an unlimited account, because
     * there is no number -- and a `0` there would be a wrong one rather than
     * an absent one, which is the sort of field that is fine until the day
     * something starts reading it.
     */
    remaining: quota.unlimited ? null
      : (Number.isFinite(quota.remaining)
        ? quota.remaining
        : Math.max(0, (quota.limit || 0) - (quota.used || 0))),
    // Frame parameters must round-trip to the client: converting mask
    // pixels back to lng/lat requires the exact centre, zoom, and size. On a
    // tiled detection this is the frame of the STITCHED picture, which is
    // what the pasted-together mask is a picture of.
    frame: { ...served, provider, svc: served.svc?.id ?? undefined }, model: modelId,
    /*
     * How the lot was photographed, so the browser can paste the pieces on
     * the right grid and say what resolution the model actually read. Always
     * present, so nothing downstream has to distinguish "one piece" from
     * "an older Worker that did not say".
     */
    tiling: {
      cols: plan.cols,
      rows: plan.rows,
      groundCm: Math.round(plan.groundM * 1000) / 10,
      capped: Boolean(plan.capped),
    },
  };

  if (pending.length) {
    // Not a failure: `Prefer: wait` gives up after about a minute, and a cold
    // model can take several. The quota stays spent because the predictions
    // are running and will be billed; the client polls /api/prediction.
    return json(
      {
        ...shape,
        pending: true,
        // The single-pass shape, still, for a browser cached from before
        // `passes` existed. Sending only the new field would leave such a tab
        // polling `undefined` forever rather than failing visibly.
        status: answered[0].status,
        id: answered[0].id ?? null,
      },
      202,
      origin
    );
  }

  return json(
    {
      ...shape,
      // Likewise: the first mask under the old name, so an old tab measuring
      // with "Find grass" keeps working through the deploy.
      mask: answered[0].mask ?? null,
      // What was actually asked, so a developer-mode run is attributable to
      // its own settings rather than to whatever the panel says now.
      used: { prompt: answered[0].prompt, threshold: answered[0].threshold },
    },
    200,
    origin
  );
}

/* ------------------------------------------------------ cancel a press */
/**
 * The person gave up on a press, or it failed or ran out of time in the
 * browser: hand the passes back if no trace was to be had. See presses.js
 * for what is checked; this only pays back whoever paid.
 */
async function handleCancelPress(request, env, origin, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }
  const press = pressIdOf(body?.press);
  const clientId = typeof body?.clientId === 'string' ? body.clientId : '';
  if (!press || !clientId) return json({ error: 'press and clientId required' }, 400, origin);

  const user = await currentUser(request, env, ctx);
  const got = await releasePress(env, press, { clientId, userId: user?.id || null });
  if (got.forbidden) return json({ error: 'Not your press' }, 403, origin);
  if (got.refunded) {
    const row = got.row;
    if (row.job) await spendJobDetection(env, row.job, row.claimant, -row.n, row.ceiling);
    else await refund(request, env, { user, clientId: row.client_id, n: row.n, fromDaily: row.from_daily });
    await markRefunded(env, press);
    recordLater(ctx, Promise.all((got.stop || []).map((id) => stopPrediction(env, id))));
    return json({ refunded: true, n: row.n }, 200, origin);
  }
  return json({
    refunded: false,
    finished: Boolean(got.finished),
    pending: Boolean(got.pending),
  }, 200, origin);
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    try {
      /*
       * Sign-in first, and outside the switch.
       *
       * These are the only routes that answer with a redirect and a cookie
       * rather than JSON, and the only ones reached by following a link from
       * somewhere else -- Google, or a mail client. Their paths are also
       * patterned (`/api/auth/<provider>/callback`) rather than fixed, which a
       * switch cannot express. See routes-auth.js.
       */
      if (isAuthPath(url.pathname)) {
        return await handleAuth(request, env, url, origin, ctx, json);
      }

      /*
       * The console, likewise patterned rather than fixed, and refused as a
       * 404 to anybody who is not an administrator -- see routes-admin.js.
       */
      if (isAdminPath(url.pathname)) {
        return await handleAdmin(request, env, url, origin, ctx, json);
      }

      /*
       * The paid queue: give me a lawn, I could not do this one, here is my
       * map. Open to anybody with a worker id, because that is what a crowd
       * platform puts in the link -- see routes-jobs.js for why there is
       * nothing here worth forging.
       */
      if (url.pathname === '/api/job' || url.pathname.startsWith('/api/job/')) {
        return await handleJobs(request, url, env, origin, ctx, json);
      }

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
            {
              mapboxToken: env.MAPBOX_TOKEN || null,
              imagery: providerCatalogue(env),
              /*
               * Things to draw ON TOP of the photograph, as opposed to
               * photographs to choose between -- so a separate list, not more
               * entries in `imagery`. Picking a different aerial replaces what
               * you are looking at; switching one of these on adds to it, and a
               * radio group cannot express that.
               */
              overlays: overlayCatalogue(env),
              models: modelCatalogue(env),
              /* The live model's releases, for the picker's "Version
                 history" (owner, 2026-10-06). */
              modelVersions: versionHistory(),
              /* Which method a fresh page starts on: the trained model where
                 a release is being served, "Find grass" where it is not. */
              defaultModel: defaultModelFor(env),
              // The things exclude mode can remove, and which start ticked.
              // Same reasoning as the imagery list: the browser draws the boxes
              // and the Worker runs the prompts, so one list, sent once.
              exclusions: exclusionCatalogue(),
              defaultExclusions: DEFAULT_EXCLUSIONS,
              // Whether this deployment has an account store at all. Without
              // one the app is what it was before accounts existed, and the
              // browser needs to know that rather than offering a sign-in
              // button that cannot work.
              accounts: accountsEnabled(env),
              /*
               * WHERE PROPERTY LINES COME FROM, counted rather than written
               * down. The address step says this out loud before anybody
               * types anything, and the sentence that used to be there named
               * six counties and was three years out of date within a month.
               *
               * The summary only: four numbers and two short lists of state
               * names. The full roster is thousands of counties and lives
               * behind /api/coverage, fetched when somebody asks to see it.
               */
              coverage: coverageSummary(),
            },
            200,
            origin
          );
        /*
         * The full list, for the dialog behind the link. Public, like the
         * summary and for the same reason: it is a list of public records
         * offices, and a visitor deciding whether this site can help them
         * should not need an account to find out.
         */
        case '/api/coverage':
          return json({ states: coverage(), nearComplete: NEAR_COMPLETE }, 200, origin);
        case '/api/geocode':
          return await handleGeocode(url, env, origin);
        case '/api/mask':
          return await handleMask(url, origin, env);
        case '/api/alpha-mask':
          return await alphaMaskResponse(env, url.searchParams.get('id') || '', cors(origin),
            { raw: url.searchParams.get('raw') === '1' });
        case '/api/prediction':
          return await handlePrediction(url, env, origin);
        case '/api/parcel':
          return await handleParcel(request, url, env, origin, ctx);
        case '/api/parcel/neighbours':
          return await handleNeighbours(url, origin);
        /*
         * THE TRAINED MODEL'S WEIGHTS, a few hundred numbers.
         *
         * Served from the bucket rather than shipped with the site, so a
         * retrained model is live the moment workflow 12 writes it and a
         * deploy is not in the loop. Developer mode is the only thing that
         * asks for it, but it is not gated: these are weights, not a secret,
         * and a 404 is the honest answer before the first training run.
         */
        case '/api/model': {
          if (!env.CORPUS) return json({ error: 'No bucket' }, 404, origin);
          const object = await env.CORPUS.get('model/lawn-head.json');
          if (!object) return json({ error: 'No model published yet' }, 404, origin);
          return new Response(object.body, {
            headers: {
              'Content-Type': 'application/json',
              /* Short: the whole point is that a new one appears without a
                 deploy, and an hour of staleness would hide that. */
              'Cache-Control': 'public, max-age=60',
              ...cors(origin),
            },
          });
        }
        case '/api/imagery':
          return await handleImagery(url, env, origin);
        /* Is there a county or state photo for this point? The catalogue's
           answer (worker/src/county.js), for the editor to offer it. */
        case '/api/county-imagery': {
          const { services: all, recent } = await countyChoicesAt(env, parseFloat(url.searchParams.get('lng')), parseFloat(url.searchParams.get('lat')));
          const pub = (at) => ({ id: at.id, title: at.title, year: at.year, flown: at.flown ?? null, nativeCm: at.nativeCm, maxPx: at.maxPx, tiled: at.tiled, detail: at.detail ?? null });
          /* `recent`: the newest flight here when the sharp choice is an older one (county.js). */
          return json({ service: all[0] ? pub(all[0]) : null, services: all.map(pub), recent: recent ? pub(recent) : null }, 200, origin);
        }
        case '/api/segment':
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          return await handleSegment(request, env, origin, ctx);
        case '/api/segment/cancel':
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          return await handleCancelPress(request, env, origin, ctx);
        /*
         * The test log, readable only with the token.
         *
         * 404 rather than 403 when the token is missing or wrong: a refusal
         * confirms there is something here worth the trouble of guessing at.
         * With no LOG_TOKEN configured this route simply does not exist.
         */
        case '/api/log': {
          const found = await readLog(env, url.searchParams.get('token'));
          if (!found) return json({ error: 'Not found' }, 404, origin);
          return json({ ...found, logging: loggingEnabled(env) }, 200, origin);
        }
        /*
         * "Was the AI's answer any good?"
         *
         * Writable by anyone, like the detection itself -- the answer is only
         * worth having from the person who just looked at the map. Readable
         * only with the token, because a report is a street address and a
         * picture of somebody's garden. See feedback.js.
         */
        case '/api/feedback': {
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          let body;
          try {
            body = await request.json();
          } catch {
            return json({ error: 'Invalid JSON' }, 400, origin);
          }
          const saved = await recordFeedback(env, body, request);
          // "off" is not an error the visitor can do anything about, and a
          // failure here must never make a working measurement look broken:
          // the app says thank you either way and this says what happened.
          return json({ ok: saved.ok, reason: saved.reason || null }, saved.ok ? 200 : 202, origin);
        }
        case '/api/feedback/list': {
          const found = await readFeedback(env, url.searchParams.get('token'));
          if (!found) return json({ error: 'Not found' }, 404, origin);
          return json({ ...found, enabled: feedbackEnabled(env) }, 200, origin);
        }
        /*
         * A finished map, kept to train a segmentation model on later.
         *
         * Answers 200 whatever happens, like the feedback route and for the
         * same reason: this is bookkeeping for a model that does not exist
         * yet, and somebody who has just finished measuring their lawn must
         * never see it fail. The reason rides along for the console.
         */
        case '/api/finished': {
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          let body;
          try {
            body = await request.json();
          } catch {
            return json({ error: 'Invalid JSON' }, 400, origin);
          }
          /* Who saved it, from the session: an admin's save marks the map
             (the console's "Edited by an admin" queue). Never fatal. */
          const saver = await currentUser(request, env, ctx).catch(() => null);
          const kept = await recordFinished(env, body, {
            adminId: saver?.role === 'admin' ? saver.id : null,
          });
          /*
           * The picture comes after the row and outside the response.
           *
           * A megabyte or two fetched from somebody else's imagery server, for
           * bookkeeping, while the person who just finished measuring waits --
           * no. The row is already safe; this fills in image_key when it
           * lands, and the row stays perfectly usable if it never does,
           * because the frame re-fetches.
           *
           * waitUntil rather than a bare call: a Worker cancels any promise
           * still pending when the handler returns, which is exactly how the
           * detection log once reported itself enabled and stored nothing.
           */
          /* A map made on a county photo keeps that photo instead (county-picture.js). */
          /* An admin's save (a review edit) waits for it: they go straight
             back to the console, whose card should show the photo the
             outlines were saved on, not the one it replaces. */
          if (kept.ok && kept.row) {
            const photo = storeMapPhoto(env, kept.row, body).catch(() => null);
            if (saver?.role === 'admin') await photo; else ctx.waitUntil(photo);
          }
          return json({ ok: kept.ok, reason: kept.reason || null }, kept.ok ? 200 : 202, origin);
        }
        case '/api/quota': {
          const clientId = url.searchParams.get('clientId') || 'anon';
          return json(
            // The badge has to count against the same ceiling the detection
            // will, or it reads "12 left" and then refuses at 20 -- which now
            // means asking the same question the charge will ask, including
            // which of the two arrangements this visitor is under.
            await allowance(request, env, {
              user: await currentUser(request, env, ctx),
              clientId,
              dev: url.searchParams.get('dev') === '1',
            }),
            200,
            origin
          );
        }
        /* The saved maps, once they belong to an account. See routes-maps.js. */
        case '/api/maps':
          return await handleMaps(request, env, url, origin, ctx, json);
        /*
         * FOR SEARCH ENGINES (owner, 2026-09-30). Written from the address that
         * was asked for, so they are right on the custom domain and on
         * workers.dev alike. One public page; the consoles carry noindex.
         */
        /*
         * AND FOR AI (owner, 2026-10-04: "so users can find the site for LLM
         * conversations"). Every crawler is allowed, AI ones included; the
         * Content-Signal line (contentsignals.org) says this page may be used
         * for search results, as input to an AI's answer, and for training
         * (owner, 2026-10-08).
         * /llms.txt is the plain-words summary for them (llms.js).
         *
         * /api/config and /api/coverage ARE ALLOWED, though /api/ is not
         * (2026-10-08). Google renders the page and runs app.js, and a fetch
         * robots.txt forbids reaches the page as a failed request -- Search
         * Console's screenshot showed "The map didn't load. Request failed
         * (499)" over the landing. Both are read-only and the same for
         * everybody; the longer rule wins, so the rest of /api/ stays shut.
         */
        /*
         * THE CRAWLERS BY NAME (owner, 2026-10-08), in ONE group with the
         * wildcard. A crawler that finds a group naming it ignores the `*`
         * group entirely, so separate groups would each need every rule
         * repeated, and one forgotten would quietly open /api/ to it. Several
         * User-agent lines over one set of rules is the standard way to name
         * them without that risk. Search engines, the AI assistants' search
         * and fetch agents, and -- owner, 2026-10-08: "allow them" -- the
         * TRAINING crawlers too, with ai-train=yes in the Content-Signal: the
         * public pages are a sales page meant to be repeated, and nothing a
         * person saved is reachable from here.
         */
        case '/robots.txt':
          return new Response(
            '# Search engines and AI assistants are welcome. A plain-language summary\n'
            + `# of this site for AI assistants: ${url.origin}/llms.txt\n`
            + ROBOTS_AGENTS.map((a) => `User-agent: ${a}\n`).join('')
            + `User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\nAllow: /api/config\nAllow: /api/coverage\nDisallow: /api/\n\nSitemap: ${url.origin}/sitemap.xml\n`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
          );
        /* For AI assistants: what the site is, in plain words (llms.js). */
        case '/llms.txt':
          return new Response(llmsTxt(url.origin), {
            headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
          });
        case '/sitemap.xml':
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + `  <url><loc>${url.origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n`
            + '</urlset>\n',
            { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
          );
        default:
          if (url.pathname.startsWith('/api/')) {
            return json({ error: 'Not found' }, 404, origin);
          }
          /*
           * A FILE THAT IS NOT HERE IS A 404, not the app (Lighthouse,
           * 2026-10-04): an agent asking for /.well-known/ai-catalog.json got
           * the app's HTML and reported a malformed manifest. Only paths
           * without an extension are deep links into the app.
           */
          if (url.pathname.startsWith('/.well-known/') || /\.[a-z0-9]{1,8}$/i.test(url.pathname)) {
            return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
