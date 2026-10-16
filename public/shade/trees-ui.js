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
import { cellsUnder, squareRing, Erased, SIZES_M } from './erase.js';

const $ = (s) => document.querySelector(s);
const NOISE = new Set([7, 18]);
/* How much a meter of each band stops: sparse lets most light through (bare
   twigs), dense stops most of it (a full crown, a spruce, a roof). */
export const BANDS = [
  { id: 'sparse', below: 0.105, opacity: 0.55, name: 'lets most through (over 90% a meter)' },
  { id: 'medium', below: 0.69, opacity: 0.8, name: 'about half to 90% a meter' },
  { id: 'dense', below: Infinity, opacity: 0.95, name: 'stops most (under half a meter)' },
];
const MIN_MU = 0.01; // a cube passing over 99% a meter is drawn as air
/* Dark and apart from each other, to stand out on a sunny photo (owner, 2026-10-14: "I can hardly see any of them"). */
export const KIND_COLOR = { roof: '#424242', evergreen: '#0d3b8c', deciduous: '#1b6e20', filled: '#7a5c00', other: '#1b6e20' };
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

/**
 * Draw the trees on `map`. With `erase`, the eraser (erase.js) is wired to
 * the #tr-erase controls: columns brushed out vanish from the drawing and
 * `erased()` gives the mask for the light worker; `onErase()` is called at
 * the end of every stroke, undo and clear. `setActive(false)` hides the
 * trees and stops the tap readout (another step has the map).
 */
export async function startTrees({ map, site, cols, box, shift, season: flight, flownTo, erase = false, onErase = null }) {
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
    /* This year's weather when the Worker has it (climateNow), as the shade
       map's light worker reads it; the typical year alone otherwise. The
       owner saw 14% on Oct 15 here from the typical year while this year's
       weather, later, said 32%. */
    if (c?.tMean) calendar = leafCalendar(c.tMeanNow || c.tMean, c.tMeanNow ? { typical: c.tMean } : {});
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

  const st = { leaves: today ?? (leafOff ? 1 : null), roofs: true, cut: 0, active: true, erasing: false, size: SIZES_M[1] };
  const er = erase ? new Erased(grid.w * grid.h) : null;
  const muNow = () => (st.leaves === null ? model.mu : muWithLeaves(season, st.leaves));
  const corners = (k) => {
    const x = k % grid.w, y = (k / grid.w) | 0;
    const X0 = grid.x0 + x * grid.cell, X1 = X0 + grid.cell, Y1 = grid.y1 - y * grid.cell, Y0 = Y1 - grid.cell;
    const ring = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]].map((p) => fromMerc(p));
    return [ring];
  };

  const ids = BANDS.map((b) => `trees-${b.id}`);
  /* The features drawn, per band source, by cell: removed one by one as the eraser passes (a whole redraw is too slow for a stroke). */
  const byCell = new Map();
  const current = ids.map(() => ({ type: 'FeatureCollection', features: [] }));
  function draw() {
    const runs = treeRuns(model, muNow(), leafOff ? season : null, { roofs: st.roofs, cutBelow: st.cut }).filter((r) => !er?.mask[r.k]);
    byCell.clear();
    let lastK = -1, idx = 0;
    BANDS.forEach((b, i) => {
      const fc = {
        type: 'FeatureCollection',
        features: runs.filter((r) => r.band === i).map((r) => {
          idx = r.k === lastK ? idx + 1 : 0; lastK = r.k;
          const f = { type: 'Feature', id: r.k * 64 + idx, geometry: { type: 'Polygon', coordinates: corners(r.k) }, properties: { b: r.base, t: r.top, c: KIND_COLOR[r.kind] } };
          if (!byCell.has(r.k)) byCell.set(r.k, []);
          byCell.get(r.k).push({ src: i, id: f.id });
          return f;
        }),
      };
      current[i] = fc;
      if (map.getSource(ids[i])) map.getSource(ids[i]).setData(fc);
      else {
        map.addSource(ids[i], { type: 'geojson', data: fc, dynamic: true }); // dynamic: updateData (the eraser) is allowed
        map.addLayer({ id: ids[i], type: 'fill-extrusion', source: ids[i], paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 't'], 'fill-extrusion-opacity': b.opacity } });
      }
    });
    for (const [id, on] of [['#tr-today', st.leaves !== null && st.leaves === today], ['#tr-full', st.leaves === 1], ['#tr-bare', st.leaves === 0]]) $(id).setAttribute('aria-pressed', String(on));
    const c = season.counts || {};
    say(`${runs.length.toLocaleString()} pieces drawn. ${leafOff
      ? `The lidar was flown with the leaves off${flownTo ? ` (to ${flownTo})` : ''}; ${st.leaves === 0 ? 'drawn bare, as flown' : `deciduous crowns drawn with ${Math.round(100 * st.leaves)}% of their summer leaves`}.`
      : flight === 'on' ? 'The lidar was flown in leaf: drawn as flown.' : 'The flight season is unknown: drawn as flown.'}${c.evergreen != null ? ` Columns: ${c.deciduous || 0} deciduous, ${c.evergreen || 0} evergreen, ${c.roof || 0} building.` : ''}`);
    eraseNote();
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
  /* How solid the blocks are drawn, kept on this device. */
  const solid = () => Number($('#tr-solid').value) / 100;
  const applySolid = () => { BANDS.forEach((b, i) => { if (map.getLayer(ids[i])) map.setPaintProperty(ids[i], 'fill-extrusion-opacity', Math.min(1, b.opacity * solid())); }); };
  try { const v = localStorage.getItem('lawnmapper.shade.treesSolid'); if (v) $('#tr-solid').value = v; } catch { /* not kept */ }
  $('#tr-solid').oninput = () => { applySolid(); try { localStorage.setItem('lawnmapper.shade.treesSolid', $('#tr-solid').value); } catch { /* not kept */ } };
  $('#tr-legend').innerHTML = Object.entries(KIND_COLOR).filter(([k]) => leafOff || k === 'other' || k === 'roof')
    .map(([k, c]) => `<span class="sw" style="background:${c}"></span>${KIND_NAME[k]}`).join('<br>')
    + `<br><span class="dim">Faint to solid: ${BANDS.map((b) => b.name).join('; ')}.</span>`;

  const onClick = (e) => {
    if (!st.active || st.erasing) return;
    const [x, y] = toMerc([e.lngLat.lng, e.lngLat.lat]);
    const gx = Math.floor((x - grid.x0) / grid.cell), gy = Math.floor((grid.y1 - y) / grid.cell);
    if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) { $('#tr-read').textContent = 'Outside the modelled area.'; return; }
    const k = gy * grid.w + gx, mu = muNow();
    if (er?.mask[k]) { $('#tr-read').textContent = 'Erased: open air here now. Undo or "Put all back" restores it.'; return; }
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

  /* ---- The eraser: a square brush; drag to erase, one stroke per undo. ---- */
  const CURSOR = 'tr-cursor';
  function eraseNote() {
    const el = $('#tr-erase-note');
    if (!el || !er) return;
    el.textContent = er.any ? `${er.count.toLocaleString()} square meter${er.count === 1 ? '' : 's'} erased (${er.strokes.length} stroke${er.strokes.length === 1 ? '' : 's'}). The shade will be worked out without them.` : 'Nothing erased. Drag the eraser over a tree to take it out of the model; tap the eraser again when done.';
    if ($('#tr-undo')) $('#tr-undo').disabled = !er.strokes.length;
    if ($('#tr-restore')) $('#tr-restore').disabled = !er.any;
  }
  const showCursor = (lngLat) => {
    if (!er || !st.erasing || !lngLat) return;
    const [x, y] = toMerc([lngLat.lng, lngLat.lat]);
    const data = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [squareRing(grid, x, y, st.size)] } };
    if (map.getSource(CURSOR)) map.getSource(CURSOR).setData(data);
    else {
      map.addSource(CURSOR, { type: 'geojson', data });
      map.addLayer({ id: CURSOR, type: 'line', source: CURSOR, paint: { 'line-color': '#ffffff', 'line-width': 2 } });
    }
  };
  const hideCursor = () => { if (map.getLayer(CURSOR)) map.removeLayer(CURSOR); if (map.getSource(CURSOR)) map.removeSource(CURSOR); };
  /* Take the brushed cells' blocks off the map at once: a dynamic source
     (Mapbox v3.4+) drops a feature updated with no geometry; an older map
     gets the whole collection again without them. */
  const dropCells = (cells) => {
    const gone = ids.map(() => []);
    for (const k of cells) for (const f of byCell.get(k) || []) gone[f.src].push(f.id);
    gone.forEach((list, i) => {
      if (!list.length) return;
      const src = map.getSource(ids[i]);
      const set = new Set(list);
      current[i] = { type: 'FeatureCollection', features: current[i].features.filter((f) => !set.has(f.id)) };
      if (typeof src.updateData === 'function') src.updateData({ type: 'FeatureCollection', features: list.map((id) => ({ type: 'Feature', id, geometry: null, properties: {} })) });
      else src.setData(current[i]);
    });
  };
  let stroking = false;
  const brush = (lngLat) => {
    if (!er || !lngLat) return;
    const [x, y] = toMerc([lngLat.lng, lngLat.lat]);
    const fresh = er.erase(cellsUnder(grid, x, y, st.size));
    if (fresh.length) dropCells(fresh);
  };
  const strokeStart = (e) => { if (!st.erasing || !st.active) return; e.preventDefault?.(); stroking = true; showCursor(e.lngLat); brush(e.lngLat); };
  const strokeMove = (e) => { if (!st.erasing || !st.active) return; showCursor(e.lngLat); if (stroking) brush(e.lngLat); };
  const strokeEnd = () => { if (!stroking) return; stroking = false; er.end(); eraseNote(); onErase?.(); };
  const setErasing = (on) => {
    st.erasing = on;
    stroking = false;
    $('#tr-erase')?.classList.toggle('on', on);
    $('#tr-erase')?.setAttribute('aria-pressed', String(on));
    map.getCanvas().style.cursor = on ? 'none' : '';
    map.getCanvas().dataset.erasing = on ? '1' : '';
    for (const h of [map.dragPan, map.touchZoomRotate, map.dragRotate]) on ? h.disable() : h.enable();
    if (!on) hideCursor();
  };
  if (er && $('#tr-erase')) {
    map.on('mousedown', strokeStart); map.on('touchstart', strokeStart);
    map.on('mousemove', strokeMove); map.on('touchmove', strokeMove);
    map.on('mouseup', strokeEnd); map.on('touchend', strokeEnd); map.on('touchcancel', strokeEnd);
    $('#tr-erase').onclick = () => setErasing(!st.erasing);
    for (const b of document.querySelectorAll('[data-erase-m]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.eraseM) === st.size));
      b.onclick = () => { st.size = Number(b.dataset.eraseM) || SIZES_M[1]; for (const o of document.querySelectorAll('[data-erase-m]')) o.setAttribute('aria-pressed', String(o === b)); if (!st.erasing) setErasing(true); };
    }
    if ($('#tr-undo')) $('#tr-undo').onclick = () => { er.undo(); draw(); onErase?.(); };
    if ($('#tr-restore')) $('#tr-restore').onclick = () => { er.clear(); draw(); onErase?.(); };
  }

  draw();
  applySolid();
  return {
    /** The erased mask (Uint8Array per 1 m cell), or null when nothing is erased. */
    erased: () => (er?.any ? er.mask : null),
    erasedCount: () => er?.count || 0,
    /** The erased cells as a sorted list of indices (kept on the server with the map). */
    erasedCells() { if (!er?.any) return []; const out = []; for (let k = 0; k < er.mask.length; k++) if (er.mask[k]) out.push(k); return out; },
    /** Cells erased last time, back out of the model (one stroke, so one undo puts them all back). */
    restore(cells) { if (!er || !cells?.length) return; er.erase(cells.filter((k) => Number.isInteger(k) && k >= 0 && k < er.mask.length)); er.end(); draw(); },
    /** The blocks shown or hidden (another step may show them beside its own picture). */
    setVisible(on) { for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); },
    /** Shown and listening, or hidden with the map left to another step. */
    setActive(on) {
      st.active = on;
      if (!on && st.erasing) setErasing(false);
      this.setVisible(on);
      sec.hidden = !on;
    },
    stop() {
      if (st.erasing) setErasing(false);
      map.off('click', onClick);
      for (const [ev, h] of [['mousedown', strokeStart], ['touchstart', strokeStart], ['mousemove', strokeMove], ['touchmove', strokeMove], ['mouseup', strokeEnd], ['touchend', strokeEnd], ['touchcancel', strokeEnd]]) map.off(ev, h);
      for (const id of ids) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
      sec.hidden = true;
    },
  };
}
