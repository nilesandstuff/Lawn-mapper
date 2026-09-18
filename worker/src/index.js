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

import { lookupParcel } from './parcel.js';
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
import { recordFinished, storeImage } from './corpus.js';
import { handleAuth, isAuthPath } from './routes-auth.js';
import { handleMaps } from './routes-maps.js';
import { handleAdmin, isAdminPath } from './routes-admin.js';
import { accountsEnabled, publicUser } from './db.js';
import { currentUser } from './auth.js';
import { recordParcelGap } from './gaps.js';
// Constants and the version lookup live in their own module: a Workers
// entrypoint may only export handlers, and exporting a plain constant from
// here kills the isolate on startup.
import {
  MODELS, samVersion, samThreshold, samPrompt, normaliseModel, modelCatalogue,
  promptProblem, normaliseExclusions, exclusionPass, exclusionCatalogue,
  DEFAULT_EXCLUSIONS,
} from './sam.js';
// Which satellite picture to use, and how to ask each source for exactly our
// frame. Also lives outside the entrypoint, for the same reason as sam.js.
import {
  imageryUrl, detectionImageUrl, imageryPrompt, normaliseProvider,
  detectionProvider, providerCatalogue, providerFrame, providerAvailable,
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
async function handleParcel(request, url, env, origin, ctx) {
  const lng = parseFloat(url.searchParams.get('lng'));
  const lat = parseFloat(url.searchParams.get('lat'));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return json({ error: 'lng and lat required' }, 400, origin);
  }

  const parcel = await lookupParcel(lng, lat);
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
  } else {
    passes = [{
      id: null,
      prompt: samPrompt(modelId, imageryPrompt(provider, env), env, devPrompt),
      threshold: samThreshold(env, modelId, devThreshold),
    }];
  }

  // Every pass is a separate prediction and a separate bill, so the allowance
  // is charged for all of them at once -- all or nothing, because a detection
  // missing one exclusion is a wrong answer rather than a smaller one.
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
    passes: passes.length,
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
  const quota = await charge(request, env, {
    user, clientId, n: passes.length, dev,
    detail: `${passes.length} pass${passes.length > 1 ? 'es' : ''}`
      + `${body.address ? ` at ${String(body.address).slice(0, 60)}` : ''}`,
  });

  if (!quota.allowed) {
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
      `${quota.used} of ${quota.limit} used, wanted ${quota.wanted || passes.length}`
      + `, ${quota.reason || 'client'}${dev ? ', dev' : ''}`);
    return json(
      {
        error: 'quota_exceeded',
        used: quota.used,
        limit: quota.limit,
        // How many this press needed, so the browser can say "this one needs
        // three and you have two left" rather than a flat refusal that reads
        // as broken when the counter plainly shows some remaining.
        wanted: quota.wanted || passes.length,
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
  const served = providerFrame(provider, { lng, lat, zoom, size });
  const imageUrl = detectionImageUrl(provider, served, serverToken(env), env);

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
    await refund(request, env, { user, clientId, n: passes.length, fromDaily: quota.fromDaily });
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
   * ONE AT A TIME, AND NO RETRY. Both for the same reason: the budget is tiny.
   *
   * Replicate's own sentence, once the log carried it:
   *
   *   Request was throttled. Your rate limit for creating predictions is
   *   reduced to 6 requests per minute
   *
   * SIX A MINUTE. That is the whole constraint, and it makes every request a
   * thing worth counting rather than a thing to be clever about. Two earlier
   * diagnoses -- a burst, then a concurrency ceiling -- were both wrong, and
   * both produced fixes that spent MORE requests to work around a limit on the
   * number of requests.
   *
   * The retry was the worst of it. It waited two seconds and asked again,
   * against a window measured in minutes: it could not succeed, and a refused
   * request still counts, so every throttled press quietly cost two starts
   * instead of one and made the next press likelier to fail. That is the
   * amplification the owner spotted. It is gone.
   *
   * Sequential earns its place here on budget, NOT on the concurrency theory it
   * was first written for: going one at a time is what lets a refusal stop the
   * passes that have not been sent yet. A throttled four-box press now costs a
   * single start instead of four. In time it costs almost nothing -- a warm
   * prediction on this model returns in about 0.6s.
   *
   * The per-minute budget, spent by a press:
   *
   *   1 box   1 start    6 presses a minute
   *   2 boxes 2 starts   3
   *   3 boxes 3 starts   2
   *   throttled          1, whatever was ticked
   *
   * Replicate reduces this limit for accounts holding less than a threshold of
   * credit, so the real lever is the account balance rather than anything in
   * this file. Which is why the sentence travels to the browser intact.
   */
  const startPass = (pass) => fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REPLICATE_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({
      version,
      input: model.input(imageUrl, { prompt: pass.prompt, threshold: pass.threshold, points }),
    }),
  });

  const results = [];
  for (const pass of passes) {
    const res = await startPass(pass);
    if (!res.ok) {
      // The upstream's OWN words. Discarding the sentence that names which
      // limit was hit is what made a rate limit and a concurrency limit
      // indistinguishable, and cost two rounds of guessing.
      results.push({ pass, http: res.status, detail: await upstreamReason(res) });
      break; // spending another start to be told the same thing helps nobody
    }
    results.push({ pass, prediction: await res.json() });
  }

  /*
   * One refused pass fails the whole detection.
   *
   * Carrying on with the rest would produce a measurement with one exclusion
   * missing -- and a missing exclusion is not a smaller answer, it is a wrong
   * one: the trees stay counted as lawn and nothing on screen says so. Better
   * to hand back the allowance and say what happened.
   */
  const failed = results.find((r) => r.http);
  if (failed) {
    await refund(request, env, { user, clientId, n: passes.length, fromDaily: quota.fromDaily });
    note(failed.http === 429 ? 'rate_limited' : 'upstream_error',
      `HTTP ${failed.http}: ${failed.detail || 'no message'}`);

    // Replicate throttles low-credit accounts to a handful of predictions a
    // minute. That is an account problem, not a bug, and saying so beats a
    // generic failure that sends the owner hunting through code. It is also
    // the likeliest thing to go wrong now that one press can fire four at once.
    if (failed.http === 429) {
      return json(
        {
          error: passes.length > 1
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

  const answered = results.map(({ pass, prediction }) => ({
    exclusion: pass.id,
    prompt: pass.prompt,
    threshold: pass.threshold,
    status: prediction.status,
    id: prediction.id,
    mask: prediction.output ?? null,
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
  const pending = answered.filter((a) => a.status !== 'succeeded');
  note(pending.length ? pending[0].status : 'succeeded',
    pending.length ? `${pending.length} of ${answered.length} not ready yet` : null);

  const shape = {
    passes: answered,
    subtractive: Boolean(model.subtractive),
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
    // pixels back to lng/lat requires the exact centre, zoom, and size.
    frame: { ...served, provider }, model: modelId,
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
        id: answered[0].id,
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
      mask: answered[0].mask,
      // What was actually asked, so a developer-mode run is attributable to
      // its own settings rather than to whatever the panel says now.
      used: { prompt: answered[0].prompt, threshold: answered[0].threshold },
    },
    200,
    origin
  );
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
              models: modelCatalogue(),
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
          return await handleMask(url, origin);
        case '/api/prediction':
          return await handlePrediction(url, env, origin);
        case '/api/parcel':
          return await handleParcel(request, url, env, origin, ctx);
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
        case '/api/segment':
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
          return await handleSegment(request, env, origin, ctx);
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
          const kept = await recordFinished(env, body);
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
          if (kept.ok && kept.row) ctx.waitUntil(storeImage(env, kept.row));
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
