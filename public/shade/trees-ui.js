/**
 * THE TREES AS THE SHADE MODEL SEES THEM (/shade-trees; owner, 2026-10-14:
 * "a tool, separate from the actual shade map, that just displays maps ...
 * and then generates the trees in the same way that you would use to
 * simulate their effect on shade. I'll check those against the properties I
 * go to today").
 *
 * The same lidar, the same line-up and the same model as the shade map
 * (shade.js reads and lines up the cloud; canopy.js and seasonal.js build
 * the canopy exactly as the light worker does), drawn instead of lit: every
 * 1 m column's runs of cubes that stop light, raised to the heights they
 * stand at, colored by what the model took them for and shaded by how much
 * light they stop per meter. Tap a spot for its numbers.
 *
 * Leaves: today's share from the place's typical temperatures (the
 * calendar the shade map uses), full summer leaves, or bare as the laser
 * flew. A leaf-on flight is drawn as flown.
 */

import { buildCanopy } from './canopy.js';
import { seasonalCanopy, muWithLeaves, leafCalendar, CROWN_ABOVE_M } from './seasonal.js';
import { gridOver, cellOf } from './grid.js';
import { toMerc, fromMerc } from './ept.js';

const $ = (s) => document.querySelector(s);
const NOISE = new Set([7, 18]);
/* How much a meter of each band stops: sparse lets most light through (bare
   twigs), dense stops most of it (a full crown, a spruce, a roof). */
export const BANDS = [
  { id: 'sparse', below: 0.105, opacity: 0.3, name: 'lets most through (over 90% a meter)' },
  { id: 'medium', below: 0.69, opacity: 0.6, name: 'about half to 90% a meter' },
  { id: 'dense', below: Infinity, opacity: 0.9, name: 'stops most (under half a meter)' },
];
const MIN_MU = 0.01; // a cube passing over 99% a meter is drawn as air
export const KIND_COLOR = { roof: '#9e9e9e', evergreen: '#00897b', deciduous: '#9ccc65', filled: '#d4e157', other: '#c5e1a5' };
export const KIND_NAME = { roof: 'building (or a crown nothing got through)', evergreen: 'evergreen: as the laser saw it, all year', deciduous: 'deciduous', filled: 'deciduous, leaves filled in where the laser found a gap', other: 'not sorted (a leaf-on flight)' };

/** 0-based day of the year, 29 Feb folded onto 28 Feb (as the light worker). */
export function dayOfYear(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

/** What the model took a column for. */
export function kindOf(season, k, leafy) {
  const v = season?.classified ? season.kind[k] : -1;
  if (v === 1) return 'roof';
  if (v === 2) return 'evergreen';
  if (v === 3) return 'deciduous';
  if (leafy) return 'filled';
  return v === -1 ? 'other' : 'deciduous';
}

/**
 * Every column's runs of light-stopping cubes: [{ k, base, top (m over the
 * ground), mu (mean per meter), band, kind }]. A run breaks where the cubes
 * turn to air or change band.
 */
export function treeRuns(model, mu, season, { roofs = true, cutBelow = 0 } = {}) {
  const { w, h, nz, dz, z0, ground } = model;
  const out = [];
  const bandOf = (m) => BANDS.findIndex((b) => m < b.below);
  for (let k = 0; k < w * h; k++) {
    let leafy = false;
    if (season) for (let l = 0; l < nz && !leafy; l++) if (season.muOn[k * nz + l] > season.muOff[k * nz + l]) leafy = true;
    const kind = kindOf(season, k, leafy);
    if (kind === 'roof' && !roofs) continue;
    let run = null;
    const close = () => { if (run) { run.mu /= run.n; delete run.n; out.push(run); run = null; } };
    for (let l = 0; l < nz; l++) {
      const m = mu[k * nz + l];
      const lo = z0 + l * dz - ground[k], hi = lo + dz;
      if (!(m >= MIN_MU) || hi <= cutBelow) { close(); continue; }
      const b = bandOf(m);
      if (run && run.band !== b) close();
      if (!run) run = { k, base: Math.max(0, lo, cutBelow), top: hi, mu: 0, n: 0, band: b, kind };
      run.top = hi; run.mu += m; run.n++;
    }
    close();
  }
  return out;
}

/** Share of the overhead sun reaching the grass at a column. */
export function overhead(model, mu, k) {
  const { nz, dz, z0, ground } = model;
  let tau = 0;
  for (let l = 0; l < nz; l++) if (z0 + (l + 0.5) * dz > ground[k] + 0.5) tau += mu[k * nz + l] * dz;
  return Math.exp(-tau);
}

export async function startTrees({ map, site, cols, box, shift, season: flight, flownTo }) {
  const sec = $('#trees');
  sec.hidden = false;
  const say = (html) => { $('#tr-status').innerHTML = html; };
  say('Building the trees the way the shade map does…');
  await new Promise((r) => setTimeout(r, 30));

  /* Exactly as the light worker builds them (light-worker.js build). */
  const grid = gridOver(box, 1, site.lat);
  const model = buildCanopy(cols, grid, { shift });
  const leafOff = flight === 'off' || flight === 'mixed';
  const season = seasonalCanopy(cols, model, { shift, classify: leafOff });
  let calendar = null;
  try {
    const c = await (await fetch(`/api/shade/climate?lng=${site.lng}&lat=${site.lat}`)).json();
    if (c?.tMean) calendar = leafCalendar(c.tMean);
  } catch { /* no calendar: today's button says so */ }
  const today = leafOff && calendar ? calendar.share(dayOfYear(Date.now())) : null;

  /* The laser's own lowest and highest crown return per column, for the readout. */
  const lowRet = new Float32Array(grid.w * grid.h).fill(NaN), highRet = new Float32Array(grid.w * grid.h).fill(NaN);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const over = cols.z[i] - model.ground[k];
    if (over <= CROWN_ABOVE_M || over > 80) continue;
    if (!(lowRet[k] <= over)) lowRet[k] = over;
    if (!(highRet[k] >= over)) highRet[k] = over;
  }

  const st = { leaves: today ?? (leafOff ? 1 : null), roofs: true, cut: 0 };
  const muNow = () => (st.leaves === null ? model.mu : muWithLeaves(season, st.leaves));
  const corners = (k) => {
    const x = k % grid.w, y = (k / grid.w) | 0;
    const X0 = grid.x0 + x * grid.cell, X1 = X0 + grid.cell, Y1 = grid.y1 - y * grid.cell, Y0 = Y1 - grid.cell;
    const ring = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]].map((p) => fromMerc(p));
    return [ring];
  };

  const ids = BANDS.map((b) => `trees-${b.id}`);
  function draw() {
    const runs = treeRuns(model, muNow(), leafOff ? season : null, { roofs: st.roofs, cutBelow: st.cut });
    BANDS.forEach((b, i) => {
      const fc = {
        type: 'FeatureCollection',
        features: runs.filter((r) => r.band === i).map((r) => ({
          type: 'Feature', geometry: { type: 'Polygon', coordinates: corners(r.k) },
          properties: { b: r.base, t: r.top, c: KIND_COLOR[r.kind] },
        })),
      };
      if (map.getSource(ids[i])) map.getSource(ids[i]).setData(fc);
      else {
        map.addSource(ids[i], { type: 'geojson', data: fc });
        map.addLayer({ id: ids[i], type: 'fill-extrusion', source: ids[i], paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 't'], 'fill-extrusion-opacity': b.opacity } });
      }
    });
    for (const [id, on] of [['#tr-today', st.leaves !== null && st.leaves === today], ['#tr-full', st.leaves === 1], ['#tr-bare', st.leaves === 0]]) $(id).setAttribute('aria-pressed', String(on));
    const c = season.counts || {};
    say(`${runs.length.toLocaleString()} pieces drawn. ${leafOff
      ? `The lidar was flown with the leaves off${flownTo ? ` (to ${flownTo})` : ''}; ${st.leaves === 0 ? 'drawn bare, as flown' : `deciduous crowns drawn with ${Math.round(100 * st.leaves)}% of their summer leaves`}.`
      : flight === 'on' ? 'The lidar was flown in leaf: drawn as flown.' : 'The flight season is unknown: drawn as flown.'}${c.evergreen != null ? ` Columns: ${c.deciduous || 0} deciduous, ${c.evergreen || 0} evergreen, ${c.roof || 0} building.` : ''}`);
  }

  $('#tr-today').textContent = today !== null ? `Today (${Math.round(100 * today)}% of the leaves)` : 'Today';
  $('#tr-today').disabled = today === null;
  $('#tr-full').disabled = !leafOff;
  $('#tr-bare').disabled = !leafOff;
  $('#tr-today').onclick = () => { st.leaves = today; draw(); };
  $('#tr-full').onclick = () => { st.leaves = 1; draw(); };
  $('#tr-bare').onclick = () => { st.leaves = 0; draw(); };
  $('#tr-roofs').onchange = () => { st.roofs = $('#tr-roofs').checked; draw(); };
  $('#tr-cut').onchange = () => { st.cut = Number($('#tr-cut').value) || 0; draw(); };
  $('#tr-legend').innerHTML = Object.entries(KIND_COLOR).filter(([k]) => leafOff || k === 'other' || k === 'roof')
    .map(([k, c]) => `<span class="sw" style="background:${c}"></span>${KIND_NAME[k]}`).join('<br>')
    + `<br><span class="dim">Faint to solid: ${BANDS.map((b) => b.name).join('; ')}.</span>`;

  const onClick = (e) => {
    const [x, y] = toMerc([e.lngLat.lng, e.lngLat.lat]);
    const gx = Math.floor((x - grid.x0) / grid.cell), gy = Math.floor((grid.y1 - y) / grid.cell);
    if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) { $('#tr-read').textContent = 'Outside the modelled area.'; return; }
    const k = gy * grid.w + gx, mu = muNow();
    const runs = treeRuns({ ...model, w: 1, h: 1, ground: [model.ground[k]] }, mu.subarray(k * model.nz, (k + 1) * model.nz), null, { roofs: true });
    let leafy = false;
    for (let l = 0; l < model.nz && !leafy; l++) if (season.muOn[k * model.nz + l] > season.muOff[k * model.nz + l]) leafy = true;
    const kind = kindOf(leafOff ? season : null, k, leafy);
    const pass = overhead(model, mu, k);
    const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
    $('#tr-read').innerHTML = !runs.length
      ? `Open air here: nothing over the grass stops light.${Number.isFinite(lowRet[k]) ? ` (The laser had a return ${f1(lowRet[k])} m up.)` : ''}`
      : `<b>${KIND_NAME[kind]}</b><br>Stops light from ${runs.map((r) => `${f1(r.base)}–${f1(r.top)} m (${Math.round(100 * Math.exp(-r.mu))}% a meter gets through)`).join(', ')}.<br>`
        + `Passes ${Math.round(100 * pass)}% of the sun straight overhead.<br>`
        + `<span class="dim">The laser's returns over ${CROWN_ABOVE_M} m in this square meter: ${Number.isFinite(lowRet[k]) ? `${f1(lowRet[k])} to ${f1(highRet[k])} m` : 'none (filled in from around it)'}.</span>`;
  };
  map.on('click', onClick);
  draw();
  return {
    stop() {
      map.off('click', onClick);
      for (const id of ids) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
      sec.hidden = true;
    },
  };
}
