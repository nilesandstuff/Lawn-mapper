/**
 * THE PHOTO UNDER A WATER MAP AND ITS PIXELS (moved here from public/app.js on 2026-11-17, unchanged, so the explorer
 * -- public/explore.js -- draws on the same photo the same way): EPSG:3857 metres, the Mapbox frame over the analysis
 * box, the photo the map was saved on, and a point's pixel on it.
 */
import { lineUpAt } from '/lib/shade/traced.js';

export const R = 6378137;
export const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
export const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
export const worldSize = (zoom) => 512 * 2 ** zoom;
export const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];

/** One Mapbox frame (Lawn Mapper's /api/imagery) covering the analysis box. */
export function frameFor(bbox, lat) {
  const k = Math.cos(lat * Math.PI / 180);
  const spanM = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * k;
  const mPerPxZ0 = (2 * Math.PI * R * k) / 512;
  const zoom = Math.max(15, Math.min(20, Math.floor(Math.log2((1280 * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, clat] = fromMerc([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  return { lng, lat: clat, zoom, size: 1280, height: 1280 };
}

export async function photoOf(frame, provider = 'mapbox', svc = null) {
  const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider });
  if (svc != null) q.set('svc', svc);
  const res = await fetch(`/api/imagery?${q}`);
  if (!res.ok) throw new Error(`the ${provider === 'county' ? 'county' : 'Mapbox'} photo would not load (${res.status})`);
  return createImageBitmap(await res.blob());
}

/**
 * The photo the map was saved on (lib/shade/traced.js, the shade map's own reading of a save): a county
 * photo moved by the editor's line-up onto the web map's ground, where the lawn was traced over it; Mapbox
 * otherwise, or when the county's will not load. -> { photo, shift: [px, py] to draw it at, name }
 */
export async function savedPhoto(frame, site) {
  const t = site.tracedOn || { provider: 'mapbox' };
  if (t.provider === 'county') {
    try {
      const photo = await photoOf(frame, 'county', t.svc);
      const move = lineUpAt(t, [frame.lng, frame.lat]);
      const k = Math.cos((frame.lat * Math.PI) / 180), s = (worldSize(frame.zoom) / (2 * Math.PI * R)) * (photo.width / frame.size);
      return { photo, shift: [(move.east / k) * s, -(move.north / k) * s], name: `the county photo the map was saved on${t.align ? ', where the editor lined it up' : ''}` };
    } catch (e) {
      const photo = await photoOf(frame).catch(() => null);
      return { photo, shift: [0, 0], name: `Mapbox's photo (the county photo the map was saved on would not load: ${e.message})` };
    }
  }
  return { photo: await photoOf(frame).catch(() => null), shift: [0, 0], name: "Mapbox's photo" };
}

/** EPSG:3857 -> pixel on the photo. */
export function toPx(frame, img, xy) {
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom);
  const w = mercToWorld(xy, frame.zoom);
  const s = img.width / frame.size;
  return [(w[0] - c[0]) * s + img.width / 2, (w[1] - c[1]) * s + img.height / 2];
}

/** A pixel on the photo -> [lng, lat]. */
export function pxToLngLat(frame, photo, [px, py]) {
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom), s = photo.width / frame.size;
  const wx = (px - photo.width / 2) / s + c[0], wy = (py - photo.height / 2) / s + c[1];
  const size = worldSize(frame.zoom);
  const x = (wx / size) * 2 * Math.PI * R - Math.PI * R, y = Math.PI * R - (wy / size) * 2 * Math.PI * R;
  return fromMerc([x, y]).map((v) => +v.toFixed(7));
}
