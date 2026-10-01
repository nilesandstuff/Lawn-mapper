/**
 * "Trained model (alpha release)": THE PLAN's detector, served on Modal
 * (tools/modal_serve.py). Owner, 2026-09-29.
 *
 * Shaped like the Replicate calls on purpose, so the browser needs nothing
 * new: /api/segment answers with one pass that is still running, carrying an
 * id; the browser polls /api/prediction?id=, which this answers from Modal;
 * the finished mask is kept in R2 and served at /api/alpha-mask, which the
 * mask proxy reads like any other.
 *
 * OFF UNLESS CONFIGURED. ALPHA_URL (the Modal `start` endpoint) and
 * ALPHA_TOKEN are set by workflow 2 only once a release is on Modal, and the
 * mask needs the CORPUS bucket. Without all three the model is hidden from the
 * picker and a request for it falls back to "Find grass" -- the default must
 * never be a button that fails.
 */

import { captureFrame, imageryUrl, countyExportUrl } from './imagery.js';

export const ALPHA_ID = 'alpha';
const PREFIX = 'alpha-';
const MASKS = 'alpha/masks/';

export const alphaEnabled = (env) => Boolean(env?.ALPHA_URL && env?.ALPHA_TOKEN && env?.CORPUS);

/** The `result` endpoint beside the `start` one Modal published. */
export function resultUrl(env) {
  if (env?.ALPHA_RESULT_URL) return env.ALPHA_RESULT_URL;
  return String(env.ALPHA_URL).replace(/-start(\.modal\.run)/, '-result$1');
}

/** The `cancel` endpoint, likewise. */
export function cancelUrl(env) {
  if (env?.ALPHA_CANCEL_URL) return env.ALPHA_CANCEL_URL;
  return String(env.ALPHA_URL).replace(/-start(\.modal\.run)/, '-cancel$1');
}

export const isAlphaId = (id) => typeof id === 'string' && id.startsWith(PREFIX)
  && /^alpha-[A-Za-z0-9_-]{6,80}$/.test(id);

/**
 * Begin one lot. The photograph is the one training used -- captureFrame of
 * the display frame, from Mapbox, as storeImage banks it -- and the frame
 * handed back is that capture, which is what the mask covers.
 */
export async function startAlpha(env, { frame, parcel = null, naipAlign = null, county = null }) {
  const token = env.MAPBOX_SERVER_TOKEN || env.MAPBOX_TOKEN;
  if (!token) throw new Error('no imagery token');
  const shot = captureFrame(frame);
  /* The county photo, when the lot has one and it was chosen (owner,
     2026-10-01: county photos are not view only). Same capture frame; the
     model reads whatever size comes back at its own 15 cm grid. Trained on
     Mapbox only, so how it does here is what the comparison run measures. */
  const imageUrl = county ? countyExportUrl(county, shot.frame) : imageryUrl('mapbox', shot.frame, token, env);
  if (!imageUrl) throw new Error('no imagery url');
  const res = await fetch(env.ALPHA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ALPHA_TOKEN}` },
    body: JSON.stringify({ imageUrl, frame: shot.frame, parcel, naipAlign }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`trained model start: HTTP ${res.status}`);
  const got = await res.json();
  if (!got?.id) throw new Error('trained model start: no id');
  return { id: `${PREFIX}${got.id}`, frame: shot.frame, groundM: shot.groundM, capped: shot.capped,
    provider: county ? 'county' : 'mapbox' };
}

/**
 * Where a lot has got to, in the shape /api/prediction already answers:
 * {status, mask, detail}. On success the mask goes to R2 and the answer points
 * at /api/alpha-mask on this Worker, which the mask proxy allows.
 */
export async function pollAlpha(env, id, selfOrigin) {
  const call = id.slice(PREFIX.length);
  const res = await fetch(`${resultUrl(env)}?id=${encodeURIComponent(call)}`, {
    headers: { authorization: `Bearer ${env.ALPHA_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return { status: 'failed', mask: null, detail: `trained model: HTTP ${res.status}` };
  const r = await res.json();
  if (r.status === 'running') return { status: 'processing', mask: null, detail: null };
  if (r.status !== 'succeeded' || !r.mask) {
    return { status: 'failed', mask: null, detail: r.error || 'The trained model could not read this lot.' };
  }
  const bytes = Uint8Array.from(atob(r.mask), (c) => c.charCodeAt(0));
  await env.CORPUS.put(`${MASKS}${call}.png`, bytes, { httpMetadata: { contentType: 'image/png' } });
  return {
    status: 'succeeded',
    mask: `${selfOrigin}/api/alpha-mask?id=${encodeURIComponent(id)}`,
    detail: null,
    /* For the corpus (feedback loop 1: which release drew the outline being
       corrected) and the queue (loop 2: how unsure it was). */
    version: r.version || null,
    uncertainty: Number.isFinite(r.uncertainty) ? r.uncertainty : null,
    used: r.used || null,
    seconds: r.seconds || null,
  };
}

/** The finished mask, from R2. */
export async function alphaMaskResponse(env, id, headers = {}) {
  if (!isAlphaId(id) || !env?.CORPUS) return new Response('Not found', { status: 404, headers });
  const obj = await env.CORPUS.get(`${MASKS}${id.slice(PREFIX.length)}.png`);
  if (!obj) return new Response('Not found', { status: 404, headers });
  return new Response(obj.body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', ...headers },
  });
}

/** Replicate's words for where a lot has got to, for presses.js. */
export async function alphaStatus(env, id) {
  const res = await fetch(`${resultUrl(env)}?id=${encodeURIComponent(id.slice(PREFIX.length))}`, {
    headers: { authorization: `Bearer ${env.ALPHA_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return 'unknown';
  const r = await res.json();
  return r.status === 'running' ? 'processing' : r.status === 'succeeded' ? 'succeeded' : 'failed';
}

/** Stop a lot nobody is waiting for. Best effort: a server without the
    endpoint simply finishes the lot. */
export async function cancelAlpha(env, id) {
  await fetch(`${cancelUrl(env)}?id=${encodeURIComponent(id.slice(PREFIX.length))}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ALPHA_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
}
