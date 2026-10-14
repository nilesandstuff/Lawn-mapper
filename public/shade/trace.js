/**
 * TRACING THE PROPERTY BY HAND, when an address has no property line (owner,
 * 2026-10-14: "we have to have them trace their property so that we map their
 * property entirely, without wasting resources and load time on rendering a
 * massive frame that isn't needed").
 *
 * Without a county parcel the page used to build a 30 m box round the
 * geocoder's point: too small for most lots (the back yard left out) and
 * placed wherever the geocoder put the pin. The visitor knows where their
 * lines are, so they tap the corners on the photo; that outline then does
 * what a county parcel does -- it sets the frame (the outline and the build's
 * margin, no more) and the lot the light is measured on.
 *
 * The pure parts (closing the ring, its size, the URL form) are exported for
 * tools/shade.test.js; traceLot() is the map part.
 */

import { ringAreaSqM, SQM_PER_SQFT } from '../lib/area.js';

/** Corners allowed, and the widest outline accepted (a lot, not a neighborhood). */
export const MAX_CORNERS = 60, MAX_SPAN_M = 300;

const M_PER_DEG = 111320;

/** [w, s, e, n] of a list of [lng, lat]. */
const boundsOf = (pts) => [
  Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])),
];

/** The longest side of the corners' box, in meters. */
export function spanM(pts) {
  if (!pts.length) return 0;
  const [w, s, e, n] = boundsOf(pts);
  const lat = (s + n) / 2;
  return Math.max((e - w) * M_PER_DEG * Math.cos(lat * Math.PI / 180), (n - s) * M_PER_DEG);
}

/** The tapped corners as a closed GeoJSON Polygon Feature (null under 3 corners). */
export function lotFeature(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  const ring = pts.map((p) => [p[0], p[1]]);
  ring.push([ring[0][0], ring[0][1]]);
  return { type: 'Feature', properties: { traced: 'by hand' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Square feet inside the corners. */
export function lotSqFt(pts) {
  const f = lotFeature(pts);
  return f ? Math.abs(ringAreaSqM(f.geometry.coordinates[0])) / SQM_PER_SQFT : 0;
}

/** Why an outline cannot be used, or null when it can. */
export function lotProblem(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 'Tap at least three corners.';
  if (pts.length > MAX_CORNERS) return `At most ${MAX_CORNERS} corners.`;
  if (spanM(pts) > MAX_SPAN_M) return `That is over ${MAX_SPAN_M} m across. Trace just the property.`;
  if (lotSqFt(pts) < 100) return 'That outline has almost no area. Tap the corners in order round the edge.';
  return null;
}

/** The outline in a link, so a reload or a shared link does not ask again: "lng,lat;lng,lat;...". */
export function lotParam(pts) {
  return pts.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
}

/** A link's outline back as corners, or null when it is not a usable one. */
export function parseLot(s) {
  if (typeof s !== 'string' || !s) return null;
  const pts = s.split(';').map((pair) => pair.split(',').map(Number));
  if (!pts.every((p) => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85)) return null;
  return lotProblem(pts) ? null : pts;
}

/* ----------------------------------------------------------------- the map */

const SRC = 'trace';

function draw(map, pts) {
  const features = [];
  const f = lotFeature(pts);
  if (f) features.push(f);
  else if (pts.length === 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  for (const p of pts) features.push({ type: 'Feature', properties: { corner: 1 }, geometry: { type: 'Point', coordinates: p } });
  const data = { type: 'FeatureCollection', features };
  if (map.getSource(SRC)) { map.getSource(SRC).setData(data); return; }
  map.addSource(SRC, { type: 'geojson', data });
  map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffeb3b', 'fill-opacity': 0.15 } });
  map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, filter: ['!=', '$type', 'Point'], paint: { 'line-color': '#ffeb3b', 'line-width': 2.5 } });
  map.addLayer({ id: `${SRC}-corner`, type: 'circle', source: SRC, filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#ffeb3b', 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
}

function clear(map) {
  for (const id of [`${SRC}-corner`, `${SRC}-line`, `${SRC}-fill`]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

/**
 * Ask the visitor to tap their property's corners on the map, centered on
 * the address. Resolves to the outline's corners ([lng, lat] each), or null
 * when they cancel. `box` is the element the buttons go in.
 */
export function traceLot(map, { lng, lat, box, status }) {
  const pts = [];
  map.jumpTo({ center: [lng, lat], zoom: 19, pitch: 0, bearing: 0 });
  const dbl = map.doubleClickZoom.isEnabled();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';

  box.innerHTML = `
    <p><b>There is no property line on file for this address.</b> Tap each corner of the property, in order round its edge,
    so the shade is worked out for the whole lot and nothing more. Zoom and drag to see it all.</p>
    <p class="dim" data-size>No corners yet.</p>
    <div class="row">
      <button type="button" data-undo disabled>Undo</button>
      <button type="button" data-clear disabled>Clear</button>
      <button type="button" class="primary" data-done disabled>Done</button>
      <button type="button" data-cancel>Cancel</button>
    </div>`;
  box.hidden = false;
  const $ = (s) => box.querySelector(s);
  status('Trace the property: tap its corners.');

  return new Promise((resolve) => {
    const refresh = () => {
      draw(map, pts);
      const problem = lotProblem(pts);
      $('[data-undo]').disabled = !pts.length;
      $('[data-clear]').disabled = !pts.length;
      $('[data-done]').disabled = !!problem;
      $('[data-size]').textContent = !pts.length ? 'No corners yet.'
        : problem && pts.length >= 3 ? problem
          : `${pts.length} corner${pts.length === 1 ? '' : 's'}${pts.length >= 3 ? `, about ${Math.round(lotSqFt(pts)).toLocaleString()} sq ft` : ''}.`;
    };
    const tap = (e) => {
      if (pts.length >= MAX_CORNERS) return;
      pts.push([e.lngLat.lng, e.lngLat.lat]);
      refresh();
    };
    const finish = (out) => {
      map.off('click', tap);
      if (dbl) map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
      clear(map);
      box.hidden = true;
      box.replaceChildren();
      resolve(out);
    };
    map.on('click', tap);
    $('[data-undo]').onclick = () => { pts.pop(); refresh(); };
    $('[data-clear]').onclick = () => { pts.length = 0; refresh(); };
    $('[data-done]').onclick = () => { if (!lotProblem(pts)) finish(pts.slice()); };
    $('[data-cancel]').onclick = () => finish(null);
    refresh();
  });
}
