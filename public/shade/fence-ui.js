/**
 * Drawing fences (step 1 of the shade map; fences.js has what they do to
 * the light). Tap along the fence, straight from point to point, then say
 * how tall it is and how it is built. Drawn flat on the photo, and standing
 * on the lidar's ground when the map is tilted.
 */

import { FENCE_STYLES, FENCE_MATERIALS, FT, MAX_POINTS, fenceLengthM } from './fences.js';
import { toMerc, fromMerc, mercScale } from './ept.js';

const SRC = 'fence-draft';
const STYLE_LINE = { solid: '#ff8a65', spaced: '#ffd54f', shadowbox: '#ce93d8' };
const FACE = { white: '#f2f2f2', tan: '#d9c9a3', gray: '#9e9e9e', dark: '#4e3b30', natural: '#c49a62', weathered: '#9a958c' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ft = (m) => Math.round(m / FT);

/** A fence in words: '6 ft solid privacy, white vinyl, 62 ft long'. */
export function fenceWords(f) {
  const M = FENCE_MATERIALS[f.material];
  return `${ft(f.heightM)} ft ${FENCE_STYLES[f.style].label.toLowerCase()}, ${(M.colors[f.color]?.[0] || f.color).toLowerCase()} ${M.label.toLowerCase()}, ${ft(fenceLengthM(f))} ft long`;
}

function drawDraft(map, pts) {
  const data = { type: 'FeatureCollection', features: [
    ...(pts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pts } }] : []),
    ...pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p } })),
  ] };
  if (map.getSource(SRC)) { map.getSource(SRC).setData(data); return; }
  map.addSource(SRC, { type: 'geojson', data });
  map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: `${SRC}-pt`, type: 'circle', source: SRC, filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
}
function clearDraft(map) {
  for (const id of [`${SRC}-pt`, `${SRC}-line`]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}
const segM = (a, b) => { const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320; return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * 110540); };

/**
 * Tap the fence's ends (and its corners, for a fence that turns) on the
 * map. Resolves to the points ([lng, lat] each), or null when cancelled.
 * `box` holds the buttons. Taps go only to the drawing while it lasts.
 */
export function drawFenceLine(map, { box, status, line = null }) {
  const pts = line ? line.map((p) => p.slice()) : [];
  const dbl = map.doubleClickZoom.isEnabled();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  const held = map.getCanvas().dataset.erasing;
  map.getCanvas().dataset.erasing = '1'; // the light's pin and the trees' readout leave the taps alone
  box.innerHTML = `
    <p><b>Tap one end of the fence, then the other.</b> For a fence that turns a corner, tap each corner on the way. Straight lines join the taps. Zoom in to place the ends on the fence in the photo.</p>
    <p class="dim" data-size>No points yet.</p>
    <div class="row">
      <button type="button" data-undo disabled>Undo</button>
      <button type="button" class="primary" data-done disabled>Done</button>
      <button type="button" data-cancel>Cancel</button>
    </div>`;
  box.hidden = false;
  const $ = (s) => box.querySelector(s);
  status?.('Mark the fence: tap its ends.');
  return new Promise((resolve) => {
    const refresh = () => {
      drawDraft(map, pts);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += segM(pts[i - 1], pts[i]);
      $('[data-undo]').disabled = !pts.length;
      $('[data-done]').disabled = pts.length < 2 || L < 0.5;
      $('[data-size]').textContent = !pts.length ? 'No points yet.' : pts.length === 1 ? 'Now tap the other end (or the next corner).' : `${pts.length - 1} straight length${pts.length > 2 ? 's' : ''}, ${Math.round(L / FT)} ft in all.`;
    };
    const tap = (e) => { if (pts.length < MAX_POINTS) { pts.push([e.lngLat.lng, e.lngLat.lat]); refresh(); } };
    const finish = (out) => {
      map.off('click', tap);
      if (dbl) map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
      map.getCanvas().dataset.erasing = held || '';
      clearDraft(map);
      box.hidden = true;
      box.replaceChildren();
      resolve(out);
    };
    map.on('click', tap);
    $('[data-undo]').onclick = () => { pts.pop(); refresh(); };
    $('[data-done]').onclick = () => { if (pts.length >= 2) finish(pts.slice()); };
    $('[data-cancel]').onclick = () => finish(null);
    refresh();
  });
}

/**
 * How tall, what build, what it is made of and its color. Resolves to
 * { heightM, style, material, color }, or null when cancelled. `was` fills
 * the answers in (editing a fence).
 */
export function askFence(box, was = null) {
  const a = { heightFt: was ? ft(was.heightM) : 6, style: was?.style || 'solid', material: was?.material || 'vinyl', color: was?.color || 'white' };
  box.hidden = false;
  return new Promise((resolve) => {
    const render = () => {
      const M = FENCE_MATERIALS[a.material];
      if (!M.colors[a.color]) a.color = Object.keys(M.colors)[0];
      box.innerHTML = `
        <p><b>About this fence</b></p>
        <div class="row" role="group" aria-label="Height">
          <span class="dim">Height</span>
          ${[4, 5, 6, 8].map((h) => `<button type="button" class="mode" data-h="${h}" aria-pressed="${a.heightFt === h}">${h} ft</button>`).join('')}
          <input type="number" data-hin min="2" max="12" step="0.5" value="${a.heightFt}" aria-label="Height in feet" style="width:5em"> ft
        </div>
        <div class="row" role="group" aria-label="How it is built">
          <span class="dim">Build</span>
          ${Object.entries(FENCE_STYLES).map(([k, s]) => `<button type="button" class="mode" data-style="${k}" aria-pressed="${a.style === k}" title="${esc(s.about)}">${esc(s.label)}</button>`).join('')}
        </div>
        <p class="dim">${esc(FENCE_STYLES[a.style].about)}.</p>
        <div class="row" role="group" aria-label="Material">
          <span class="dim">Made of</span>
          ${Object.entries(FENCE_MATERIALS).map(([k, m]) => `<button type="button" class="mode" data-mat="${k}" aria-pressed="${a.material === k}">${m.label}</button>`).join('')}
        </div>
        <div class="row" role="group" aria-label="Color">
          <span class="dim">Color</span>
          ${Object.entries(M.colors).map(([k, [label]]) => `<button type="button" class="mode" data-color="${k}" aria-pressed="${a.color === k}"><span class="sw" style="background:${FACE[k]}"></span>${esc(label)}</button>`).join('')}
        </div>
        <p class="dim">A pale face throws some sunlight back on the lawn in front of it; the color also tells the water map how hot the fence gets.</p>
        <div class="row">
          <button type="button" class="primary" data-save>Save the fence</button>
          <button type="button" data-cancel>Cancel</button>
        </div>`;
      const q = (s) => box.querySelectorAll(s);
      q('[data-h]').forEach((b) => { b.onclick = () => { a.heightFt = Number(b.dataset.h); render(); }; });
      box.querySelector('[data-hin]').onchange = (e) => { const v = Number(e.target.value); if (v >= 2 && v <= 12) a.heightFt = v; render(); };
      q('[data-style]').forEach((b) => { b.onclick = () => { a.style = b.dataset.style; render(); }; });
      q('[data-mat]').forEach((b) => { b.onclick = () => { a.material = b.dataset.mat; render(); }; });
      q('[data-color]').forEach((b) => { b.onclick = () => { a.color = b.dataset.color; render(); }; });
      box.querySelector('[data-save]').onclick = () => { box.hidden = true; box.replaceChildren(); resolve({ heightM: a.heightFt * FT, style: a.style, material: a.material, color: a.color }); };
      box.querySelector('[data-cancel]').onclick = () => { box.hidden = true; box.replaceChildren(); resolve(null); };
    };
    render();
  });
}

/**
 * The fences on the map: a line on the photo, colored by build, and, with
 * `ground` ({ grid, z, baseZ }: the model's ground, as the trees stand on
 * it), thin upright walls of the fence's own color, seen when tilted.
 */
export function showFences(map, fences, { ground = null } = {}) {
  const lines = (fences || []).map((f) => ({ type: 'Feature', properties: { c: STYLE_LINE[f.style] || '#fff' }, geometry: { type: 'LineString', coordinates: f.line } }));
  const data = { type: 'FeatureCollection', features: lines };
  if (map.getSource('fences')) map.getSource('fences').setData(data);
  else {
    map.addSource('fences', { type: 'geojson', data });
    map.addLayer({ id: 'fences', type: 'line', source: 'fences', paint: { 'line-color': ['get', 'c'], 'line-width': 4 } });
  }
  /* Over the light's colors, which are laid on later: kept on top. */
  if (map.getLayer('fences')) map.moveLayer('fences');
  const walls = [];
  if (ground) {
    const { grid, z, baseZ } = ground;
    const at = ([lng, lat]) => {
      const [x, y] = toMerc([lng, lat]);
      const gx = Math.floor((x - grid.x0) / grid.cell), gy = Math.floor((grid.y1 - y) / (grid.cellY || grid.cell));
      return gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h ? z[gy * grid.w + gx] : baseZ;
    };
    for (const f of fences || []) {
      for (let i = 1; i < f.line.length; i++) {
        const A = toMerc(f.line[i - 1]), B = toMerc(f.line[i]);
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (!(len > 0)) continue;
        const half = 0.06 / mercScale(f.line[i][1]); // 6 cm either side, in map units (real metres = map units x mercScale)
        const nx = (-(B[1] - A[1]) / len) * half, ny = ((B[0] - A[0]) / len) * half;
        const ring = [[A[0] + nx, A[1] + ny], [B[0] + nx, B[1] + ny], [B[0] - nx, B[1] - ny], [A[0] - nx, A[1] - ny], [A[0] + nx, A[1] + ny]].map((p) => fromMerc(p));
        const foot = Math.max(0, (at(f.line[i - 1]) + at(f.line[i])) / 2 - baseZ);
        walls.push({ type: 'Feature', properties: { b: foot, t: foot + f.heightM, c: FACE[f.color] || '#ccc' }, geometry: { type: 'Polygon', coordinates: [ring] } });
      }
    }
  }
  const wd = { type: 'FeatureCollection', features: walls };
  if (map.getSource('fences-3d')) map.getSource('fences-3d').setData(wd);
  else {
    map.addSource('fences-3d', { type: 'geojson', data: wd });
    map.addLayer({ id: 'fences-3d', type: 'fill-extrusion', source: 'fences-3d', minzoom: 15, paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 't'], 'fill-extrusion-opacity': 0.95 } });
  }
  const tilted = () => map.getPitch() > 5;
  const apply = () => { if (map.getLayer('fences-3d')) map.setLayoutProperty('fences-3d', 'visibility', tilted() ? 'visible' : 'none'); if (map.getLayer('fences')) map.setLayoutProperty('fences', 'visibility', tilted() && walls.length ? 'none' : 'visible'); };
  if (!map.__fencePitch) { map.__fencePitch = apply; map.on('pitchend', apply); }
  apply();
}
