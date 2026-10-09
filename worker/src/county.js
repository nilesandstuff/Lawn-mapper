/**
 * County and state orthophotos for any address: which catalogued services
 * cover a point, looked at and ranked (countyChoicesAt), and one by id.
 */
import jpeg from 'jpeg-js';
import { decodePng, looksLikePhoto } from './png-probe.js';
import { isMercatorCache, pickLevel } from './tile-mosaic.js';
import { resample } from './county-picture.js';
import { extraDetail } from '../../public/lib/sharpness.js';
import { flightDate, byFlightDate, sameFlight } from '../../public/lib/flight-date.js';

/** A service's own JSON, cached at the edge for a day. */
export async function serviceMeta(url, fetcher = fetch) {
  const res = await fetcher(`${url}?f=json`, { signal: AbortSignal.timeout(8000), cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------------------------------------------- for any address */

/** The service the editor gets, as the Worker passes it around (frame.svc). */
const svcOf = (r) => (r ? {
  id: Number(r.id), url: r.url, type: r.type, title: r.title, year: r.year,
  /* When it was flown, in the catalogue's words (flight-date.js reads it). */
  flown: r.flown ?? null,
  nativeCm: r.native_cm, maxPx: r.max_px,
  /* Tiles only: the Worker stitches the frame from them (tile-mosaic.js). */
  tiled: !Number(r.export_ok) && Boolean(Number(r.tile_merc)),
} : null);

/*
 * A box bigger than this is not a county's or a state's: Virginia's VBMP
 * claimed one that took in New Jersey (2026-10-01). 40 square degrees holds
 * any state east of the Rockies.
 */
export const MAX_SERVICE_SQ_DEG = 40;

/*
 * TEN YEARS AT MOST (owner, 2026-10-02: "we can go as old as 10 years").
 * A flight with no year in it is kept; one named older is not offered.
 */
export const MAX_AGE_YEARS = 10;
export const oldestYear = (now = new Date()) => now.getUTCFullYear() - MAX_AGE_YEARS;

/* A flight's year, and "most recent" / "latest" / "current" with no year
   counted as newest (Virginia's MostRecentImagery_WGS, 2026-10-03). */
const NEWEST = `COALESCE(year, CASE WHEN lower(COALESCE(title, '') || url) LIKE '%recent%'
  OR lower(COALESCE(title, '') || url) LIKE '%latest%' OR lower(COALESCE(title, '') || url) LIKE '%current%' THEN 9999 ELSE 0 END)`;

/*
 * Sharp enough: the catalogue's line (tools/county-imagery.js
 * DETAIL_AT_12CM), between NAIP's 0.05 and the 0.16-0.33 of 5-15 cm flights.
 */
export const SHARP_AT_12CM = 0.10;

/**
 * The county or state photos for a point, from county_services, best first:
 * ones that draw an arbitrary box (export_ok) or are Web Mercator tiles,
 * whose box covers the point and is no bigger than a state, flown within the
 * last ten years.
 *
 * THE NEWEST SHARP ONE (owner, 2026-10-02: "the 2020 imagery for Marquette
 * county is much clearer than the 2025... start at the newest and work
 * backwards until there's a hit with sufficient resolution"). Each candidate
 * is looked at over the spot itself at 12 cm a pixel and its fine detail
 * measured (lib/sharpness.js, the measure the catalogue uses). Newest first,
 * passing over any that measure under SHARP_AT_12CM; those come after, still
 * newest first, as a last resort. The editor tries them in order and takes
 * the first with no gaps over the lot -- a box says where a service might
 * have pictures, not that it has one here.
 */
/*
 * HOW MANY BOXES ARE LOOKED AT THE SPOT (2026-10-03). It was twice the
 * answer's length, eight: in Manassas the eight newest boxes covering the
 * city were Fairfax's and Loudoun's 2026 services, which have no picture
 * there, so the city's own 2025 flight was never looked at. The looks run
 * at once and are cached a week by the edge.
 */
export const PROBE_CANDIDATES = 24;

/*
 * NEWEST MEANS THE DATE OF FLIGHT (owner, 2026-10-09), and the sharper wins
 * a tie. The catalogue's `flown` words date a service (flight-date.js);
 * failing that its year; a service that only calls itself "most current"
 * is undated and sorts after every dated one. Among those sharp enough at
 * the spot: newest flight first, the same flight by measured detail, undated
 * last. Then the ones that did not answer, then the soft ones in the same
 * order, as a last resort.
 *
 * AND THE NEWER FLIGHT IS STILL OFFERED when the one chosen is not the
 * newest: `recent` is the newest flight that showed ground here, whatever
 * its sharpness, when it is not the first. The editor lists it beside the
 * sharp one as "County (recent)".
 */
export async function countyChoicesAt(env, lng, lat, n = 4, opts = {}) {
  const services = await countyServicesAt(env, lng, lat, n, opts);
  const recent = services.recent && services.recent.id !== services[0]?.id ? services.recent : null;
  return { services: services.slice(0, n), recent };
}

export async function countyServicesAt(env, lng, lat, n = 4, { probe = true, fetcher = fetch, now = new Date() } = {}) {
  if (!env?.DB || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
  let rows;
  try {
    rows = (await env.DB.prepare(
      `SELECT * FROM county_services
        WHERE (export_ok = 1 OR tile_merc = 1) AND west <= ?1 AND east >= ?1 AND south <= ?2 AND north >= ?2
          AND (east - west) * (north - south) <= ?3
          AND (year IS NULL OR year >= ?5)
        ORDER BY ${NEWEST} DESC, (east - west) * (north - south) ASC, COALESCE(native_cm, 99) ASC
        LIMIT ?4`
    ).bind(lng, lat, MAX_SERVICE_SQ_DEG, probe ? PROBE_CANDIDATES : n, oldestYear(now)).all()).results || [];
  } catch { return []; }
  /* A year before 1990 in the name is a historic layer, whatever later year
     rides along (tools/county-imagery.js historic): "Niagara1972mosaic_2025"
     was offered first on Grand Island, NY (2026-10-03). */
  const historic = (r) => (`${r.title || ''} ${r.url}`.match(/(?<!\d)1[89]\d\d(?!\d)/g) || []).some((y) => Number(y) < 1990);
  const list = rows.filter((r) => !historic(r)).map(svcOf);
  if (!probe) return list.slice(0, n);
  /*
   * AND A LOOK AT THE SPOT ITSELF (owner, 2026-10-02): a box covering the
   * point is not a picture of it. 256 x 256 pixels at 12 cm, all candidates
   * at once, six seconds each, cached a week by the edge. A service that does
   * not answer in time is kept, after the ones that showed ground -- the
   * editor's own gap and sharpness checks still stand behind this.
   */
  const looks = await Promise.all(list.map((svc) => measureService(svc, lng, lat, { fetcher })));
  const yes = list.map((svc, i) => ({ svc, ...looks[i] })).filter((l) => l.ok === true);
  for (const l of yes) l.svc.detail = l.detail === null ? null : Math.round(l.detail * 1000) / 1000;
  const soft = (l) => l.detail !== null && l.detail < SHARP_AT_12CM;
  /* Newest flight first; the same flight, the sharper; undated last. */
  const order = (a, b) => byFlightDate(a.svc, b.svc)
    || ((sameFlight(a.svc, b.svc) || (flightDate(a.svc.flown, a.svc.year) === null && flightDate(b.svc.flown, b.svc.year) === null))
      ? (b.detail ?? -1) - (a.detail ?? -1) : 0);
  const sharp = yes.filter((l) => !soft(l)).sort(order);
  const unsure = list.filter((_, i) => looks[i].ok === null).sort(byFlightDate);
  const out = [...sharp.map((l) => l.svc), ...unsure, ...yes.filter(soft).sort(order).map((l) => l.svc)];
  /* The newest dated flight that showed ground, sharp or not; of a tie the
     sharper, so a tie with the first choice is no "newer" flight at all. */
  const dated = yes.filter((l) => flightDate(l.svc.flown, l.svc.year) !== null).sort(order);
  const ans = out.slice(0, n);
  ans.recent = dated[0] && dated[0].svc.id !== ans[0]?.id ? dated[0].svc : null;
  return ans;
}

/** True: ground here. False: nothing, or not a photo. Null: no answer. */
export async function probeService(svc, lng, lat, opts = {}) {
  return (await measureService(svc, lng, lat, opts)).ok;
}

const PROBE_PX = 256;
const PROBE_M = 0.12;

/**
 * The service's picture of the spot, 256 pixels at 12 cm (30.7 m across):
 * { ok } as probeService answers, and { detail }, its fine detail
 * (extraDetail), comparable between services because every one is measured
 * at the same ground size per pixel.
 */
export async function measureService(svc, lng, lat, { fetcher = fetch } = {}) {
  const R = 6378137;
  const cos = Math.cos((lat * Math.PI) / 180);
  const x = (lng * Math.PI / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
  const opts = { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 604800, cacheEverything: true } };
  const verdict = (img) => {
    if (!img) return { ok: null, detail: null };
    if (!looksLikePhoto(img)) return { ok: false, detail: null };
    return { ok: true, detail: extraDetail(img.data, img.width, img.height, 4)?.extra ?? null };
  };
  /*
   * A tile cache: the one tile over the spot at the level nearest 12 cm,
   * redrawn at 12 cm a pixel -- a coarser cache is blown up to it, which is
   * exactly the detail it does not have.
   */
  if (svc.tiled) {
    try {
      const m = await serviceMeta(svc.url, fetcher);
      if (!isMercatorCache(m)) return { ok: null, detail: null };
      const ti = m.tileInfo, size = ti.rows || 256;
      const pick = pickLevel(m, PROBE_M / cos);
      if (!pick) return { ok: null, detail: null };
      const l = pick.byRes[pick.at];
      const span = l.resolution * size;
      const res = await fetcher(`${svc.url}/tile/${l.level}/${Math.floor((ti.origin.y - y) / span)}/${Math.floor((x - ti.origin.x) / span)}`, opts);
      if (res.status === 404) return { ok: false, detail: null };
      if (!res.ok) return { ok: null, detail: null };
      const b = new Uint8Array(await res.arrayBuffer());
      const img = b[0] === 0xff ? (() => { const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true }); return { width: d.width, height: d.height, data: d.data }; })()
        : await decodePng(b);
      if (!img) return { ok: null, detail: null };
      const px = Math.max(32, Math.min(1024, Math.round((l.resolution * cos * img.width) / PROBE_M)));
      return verdict(resample(img, px, px));
    } catch { return { ok: null, detail: null }; }
  }
  const half = (PROBE_PX * PROBE_M) / 2 / cos;
  const params = new URLSearchParams({
    bbox: [x - half, y - half, x + half, y + half].join(','), bboxSR: '3857', imageSR: '3857',
    size: `${PROBE_PX},${PROBE_PX}`, format: 'png32', transparent: 'true', f: 'image',
  });
  const url = `${svc.url}/${svc.type === 'ImageServer' ? 'exportImage' : 'export'}?${params}`;
  try {
    const res = await fetcher(url, opts);
    if (!res.ok) return { ok: null, detail: null };
    return verdict(await decodePng(new Uint8Array(await res.arrayBuffer()), { maxPixels: 1 << 20 }));
  } catch { return { ok: null, detail: null }; }
}

/** The best one, or null. */
export async function countyServiceAt(env, lng, lat) {
  return (await countyServicesAt(env, lng, lat, 1, { probe: false }))[0] || null;
}

/** One service by its id, only if it is in the catalogue and can draw a box. */
export async function countyServiceById(env, id) {
  const n = Number(id);
  if (!env?.DB || !Number.isInteger(n) || n <= 0) return null;
  try {
    return svcOf(await env.DB.prepare('SELECT * FROM county_services WHERE id = ?1 AND (export_ok = 1 OR tile_merc = 1)').bind(n).first());
  } catch { return null; }
}
