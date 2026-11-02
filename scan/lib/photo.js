/**
 * THE AERIAL PHOTO AS A MAP: FRAME AND PIXELS (core session). Carried from the water session's test page
 * (water/public/ar.js, FINDINGS H64): a square photo of the lot from /api/imagery at the zoom that fits it, and the
 * conversions between map metres (east, north of the map's point) and pixels on it. Pure.
 */
import { toLocal, fromLocal } from './frames.js';

const R = 6378137;
export const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
export const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const worldSize = (zoom) => 512 * 2 ** zoom;
const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];
const worldToMerc = ([wx, wy], zoom) => [(wx / worldSize(zoom)) * 2 * Math.PI * R - Math.PI * R, Math.PI * R - (wy / worldSize(zoom)) * 2 * Math.PI * R];

/** The square frame that fits a mercator bbox: { lng, lat, zoom, size, height }. */
export function frameFor(bbox, lat, size = 1280) {
  const k = Math.cos(lat * Math.PI / 180);
  const spanM = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * k;
  const mPerPxZ0 = (2 * Math.PI * R * k) / 512;
  const zoom = Math.max(15, Math.min(20, Math.floor(Math.log2((size * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, clat] = fromMerc([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  return { lng, lat: clat, zoom, size, height: size };
}

/** The mercator bbox of local-metre points round an origin, padded. */
export function bboxOf(origin, pts, padM = 10) {
  const ll = (pts.length ? pts : [[0, 0]]).map((p) => toMerc(fromLocal(origin, p)));
  const k = Math.cos(origin[1] * Math.PI / 180), pad = padM / k;
  const xs = ll.map((p) => p[0]), ys = ll.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

/** Map metres (east, north of origin) -> pixels on a photo of w x h made for the frame. */
export function toPx(frame, origin, [e, n], w, h) {
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom), p = mercToWorld(toMerc(fromLocal(origin, [e, n])), frame.zoom), s = w / frame.size;
  return [(p[0] - c[0]) * s + w / 2, (p[1] - c[1]) * s + h / 2];
}
export function fromPx(frame, origin, [x, y], w, h) {
  const s = w / frame.size, c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom);
  const wx = (x - w / 2) / s + c[0], wy = (y - h / 2) / s + c[1];
  return toLocal(origin, fromMerc(worldToMerc([wx, wy], frame.zoom)));
}

/** GeoJSON-ish shapes to rings of [lng, lat] (outer rings only). */
export function ringsOf(shapes) {
  const out = [];
  const take = (g) => {
    if (!g) return;
    if (g.type === 'Feature') return take(g.geometry);
    if (g.type === 'FeatureCollection') return (g.features || []).forEach(take);
    if (g.type === 'Polygon' && g.coordinates?.[0]) out.push(g.coordinates[0]);
    if (g.type === 'MultiPolygon') for (const poly of g.coordinates || []) if (poly[0]) out.push(poly[0]);
  };
  (Array.isArray(shapes) ? shapes : [shapes]).forEach(take);
  return out;
}
