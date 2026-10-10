/**
 * COUNTY PHOTOS THAT FAILED TO LOAD, one row each (owner, 2026-10-10:
 * "start collecting logs of the errors that trip when a county map fails to
 * load ... the gps, parcel number if known, street address if known, which
 * service was called, which image flight was chosen").
 *
 * Two writers. The Worker, where the county answers (a refusal with its own
 * words, a tile cache that could not be stitched). The editor, where the
 * rest is decided (a 30 s timeout, a picture with gaps, one softer than
 * Mapbox, a service passed over for the next) and where the parcel, the
 * address and the job are known. Both land here, and the admin console
 * reads them newest first.
 *
 * NEVER THROWS, like recordParcelGap and for the same reason: this runs
 * beside a route whose job is the photo, and a bookkeeping table that is
 * missing or full must not turn a working fallback into a failed request.
 */
const text = (v, max) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** A county URL with any key or token taken out of its query string. */
export function redactUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(String(u));
    for (const k of [...url.searchParams.keys()]) {
      if (/token|key|secret|sig/i.test(k)) url.searchParams.set(k, '…');
    }
    return url.toString().slice(0, 600);
  } catch { return text(u, 600); }
}

export const FAILURE_KINDS = ['refused', 'missing', 'timeout', 'blank', 'gaps', 'soft', 'no-service', 'passed-over'];

export async function recordCountyFailure(env, f) {
  if (!env?.DB || !f) return false;
  const kind = FAILURE_KINDS.includes(f.kind) ? f.kind : 'missing';
  const svc = f.svc || {};
  const frame = f.frame || {};
  let services = null;
  try { services = Array.isArray(f.services) ? JSON.stringify(f.services.slice(0, 20)) : null; } catch { services = null; }
  try {
    await env.DB.prepare(
      `INSERT INTO county_photo_failures
         (at, stage, kind, http, reason, lng, lat, zoom, frame, county, parcel_pin, address,
          svc_id, svc_url, svc_title, svc_year, svc_flown, picked, services, job_id, map_id, who, upstream, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`
    ).bind(
      new Date().toISOString(),
      f.stage === 'worker' ? 'worker' : 'editor',
      kind,
      num(f.http),
      text(f.reason, 500),
      num(f.lng ?? frame.lng), num(f.lat ?? frame.lat), num(f.zoom ?? frame.zoom),
      frame && Object.keys(frame).length ? JSON.stringify({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height }) : null,
      text(f.county, 120), text(f.parcelPin, 80), text(f.address, 200),
      num(svc.id), redactUrl(svc.url), text(svc.title, 200), num(svc.year), text(svc.flown, 80),
      text(f.picked, 10), services, text(f.jobId, 80), text(f.mapId, 80), text(f.who, 64),
      redactUrl(f.upstream), text(f.note, 500),
    ).run();
    return true;
  } catch {
    return false;
  }
}

/** The latest failures for the console, newest first. */
export async function countyFailures(env, { limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM county_photo_failures ORDER BY at DESC, id DESC LIMIT ?1`
    ).bind(n).all();
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const week = await env.DB.prepare(
      'SELECT COUNT(*) n FROM county_photo_failures WHERE at >= ?1'
    ).bind(since).first();
    const open = await env.DB.prepare("SELECT COUNT(*) n FROM county_photo_failures WHERE status = 'open'").first();
    return {
      failures: (rows.results || []).map((r) => ({
        ...r,
        services: (() => { try { return r.services ? JSON.parse(r.services) : null; } catch { return null; } })(),
        frame: (() => { try { return r.frame ? JSON.parse(r.frame) : null; } catch { return null; } })(),
      })),
      lastWeek: Number(week?.n || 0),
      open: Number(open?.n || 0),
    };
  } catch (e) {
    return { failures: [], lastWeek: 0, unavailable: String(e?.message || e).slice(0, 120) };
  }
}

/** One failure marked open or resolved, with who and why. */
export async function setFailureStatus(env, { id, status, by, resolution }) {
  if (!env?.DB || !Number.isFinite(Number(id)) || !['open', 'resolved'].includes(status)) return false;
  try {
    const r = await env.DB.prepare(
      'UPDATE county_photo_failures SET status = ?2, resolved_at = ?3, resolved_by = ?4, resolution = ?5 WHERE id = ?1'
    ).bind(Number(id), status, status === 'resolved' ? new Date().toISOString() : null,
      status === 'resolved' ? text(by, 40) : null, text(resolution, 600)).run();
    return (r.meta?.changes ?? 0) > 0;
  } catch { return false; }
}
