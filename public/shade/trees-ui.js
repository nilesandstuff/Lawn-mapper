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
import { cellsUnder, squareRing, Erased, SIZES_M, rayHit, brushTargets } from './erase.js';

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
/* Buildings black (owner, 2026-10-29), apart from every tree. */
export const KIND_COLOR = { roof: '#0a0a0a', evergreen: '#0d3b8c', deciduous: '#1b6e20', filled: '#7a5c00', other: '#1b6e20' };
export const KIND_NAME = { roof: 'building (or a crown nothing got through)', evergreen: 'evergreen: as the laser saw it, all year', deciduous: 'deciduous', filled: 'deciduous, leaves filled in where the laser found a gap', other: 'tree, in leaf as the laser saw it (no leaves added)' };

/** 0-based day of the year, 29 Feb folded onto 28 Feb (as the light worker). */
export function dayOfYear(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

/** What the model took a column for. */
export function kindOf(season, k, leafy) {
  if (season?.kind?.[k] === 1) return 'roof'; // on every flight
  if (!season?.classified || season.inLeaf?.[k]) return 'other'; // in leaf as flown: not sorted, no leaves added
  const v = season.kind[k];
  if (v === 2) return 'evergreen';
  if (v === 3) return 'deciduous';
  return leafy ? 'filled' : 'deciduous';
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
      if (!run) run = { k, base: Math.max(0, lo, cutBelow), top: hi, mu: 0, n: 0, band: b, kind, l0: l, l1: l };
      run.top = hi; run.mu += m; run.n++; run.l1 = l;
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
export async function startTrees({ map, site, cols, box, shift, season: flight, flownTo, erase = false, onErase = null, baseZ = null }) {
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

  const st = { leaves: today ?? (leafOff ? 1 : null), roofs: true, cut: 0, active: true, erasing: false, size: SIZES_M[1], mode: 'tree', cubeVersion: 0 };
  const er = erase ? new Erased(grid.w * grid.h, model.nz) : null;
  /* The canopy as drawn: the leaves as chosen (worked out once per choice,
     not per brush stroke: that was half of the lag), less the single blocks
     the branches brush took. */
  let baseCache = { leaves: undefined, mu: null };
  const baseMu = () => {
    if (baseCache.leaves !== st.leaves) baseCache = { leaves: st.leaves, mu: st.leaves === null ? model.mu : muWithLeaves(season, st.leaves) };
    return baseCache.mu;
  };
  let muCache = { key: null, mu: null };
  const muNow = () => {
    const base = baseMu();
    if (!er?.cubeCount) return base;
    const key = `${st.leaves}:${st.cubeVersion}`;
    if (muCache.key !== key) {
      const mu = Float32Array.from(base);
      for (let i = 0; i < mu.length; i++) if (er.cubes[i]) mu[i] = 0;
      muCache = { key, mu };
    }
    return muCache.mu;
  };
  /* On the tilted map the photo lies on the lidar's ground (shade.js
     drapePhoto, relative to the lot's median ground baseZ), so each block
     stands on its own column's ground, not on the flat map. */
  const lift = (k) => (baseZ === null ? 0 : model.ground[k] - baseZ);
  const corners = (k) => {
    const x = k % grid.w, y = (k / grid.w) | 0;
    const X0 = grid.x0 + x * grid.cell, X1 = X0 + grid.cell, Y1 = grid.y1 - y * grid.cell, Y0 = Y1 - grid.cell;
    const ring = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]].map((p) => fromMerc(p));
    return [ring];
  };

  /* Per band, a source for the runs and a small one for single cubes (the
     branches brush splits a column into those): a stroke only ever rewrites
     the small ones, so the 30,000 runs are never re-read mid-stroke. */
  const NB = BANDS.length;
  const ids = [...BANDS.map((b) => `trees-${b.id}`), ...BANDS.map((b) => `trees-${b.id}-cubes`)];
  const bandAt = (i) => BANDS[i % NB];
  /* The features drawn, per band source, by cell: removed one by one as the
     eraser passes (a whole redraw is too slow for a stroke). `removed`
     remembers what went, for a map without updateData. */
  const byCell = new Map();
  const current = ids.map(() => ({ type: 'FeatureCollection', features: [] }));
  const removed = ids.map(() => new Set());
  const CUBE_ID = 1 << 30; // single-cube features live above the runs' ids
  const bandOf = (m) => BANDS.findIndex((b) => m < b.below);
  function draw() {
    const runs = treeRuns(model, muNow(), season, { roofs: st.roofs, cutBelow: st.cut }).filter((r) => !er?.mask[r.k]);
    byCell.clear();
    removed.forEach((s) => s.clear());
    let lastK = -1, idx = 0;
    ids.forEach((id, i) => {
      const b = bandAt(i);
      const fc = {
        type: 'FeatureCollection',
        features: i >= NB ? [] : runs.filter((r) => r.band === i).map((r) => {
          idx = r.k === lastK ? idx + 1 : 0; lastK = r.k;
          const f = { type: 'Feature', id: r.k * 64 + idx, geometry: { type: 'Polygon', coordinates: corners(r.k) }, properties: { b: r.base + lift(r.k), t: r.top + lift(r.k), c: KIND_COLOR[r.kind] } };
          if (!byCell.has(r.k)) byCell.set(r.k, []);
          byCell.get(r.k).push({ src: i, id: f.id, l0: r.l0, l1: r.l1, base: r.base, top: r.top, kind: r.kind, cube: false });
          return f;
        }),
      };
      current[i] = fc;
      if (map.getSource(ids[i])) map.getSource(ids[i]).setData(fc);
      else {
        map.addSource(ids[i], { type: 'geojson', data: fc, dynamic: true }); // dynamic: updateData (the eraser) is allowed
        /* An erased block is flattened by its feature state (`gone`), which
           the map applies without re-reading the source. */
        map.addLayer({ id: ids[i], type: 'fill-extrusion', source: ids[i], paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['case', ['boolean', ['feature-state', 'gone'], false], ['get', 'b'], ['get', 't']], 'fill-extrusion-opacity': b.opacity } });
      }
      map.removeFeatureState({ source: ids[i] });
    });
    for (const [id, on] of [['#tr-today', st.leaves !== null && st.leaves === today], ['#tr-full', st.leaves === 1], ['#tr-bare', st.leaves === 0]]) $(id).setAttribute('aria-pressed', String(on));
    const c = season.counts || {};
    const asFlown = season.inLeafColumns || 0;
    const columns = c.evergreen == null ? ''
      : season.classified
        ? ` Columns: ${(c.deciduous || 0) - asFlown} deciduous, ${c.evergreen || 0} evergreen, ${asFlown ? `${asFlown} in leaf as flown, ` : ''}${c.roof || 0} building.`
        : ` Columns: ${c.deciduous || 0} tree, ${c.roof || 0} building.`;
    say(`${runs.length.toLocaleString()} pieces drawn. ${leafOff
      ? `${flight === 'mixed' ? 'Part of the lidar here was flown with the leaves off and part in leaf; leaves are added only where the laser saw bare branches' : 'The lidar was flown with the leaves off'}${flownTo ? ` (to ${flownTo})` : ''}; ${st.leaves === 0 ? 'drawn bare, as flown' : `deciduous crowns drawn with ${Math.round(100 * st.leaves)}% of their summer leaves`}.`
      : flight === 'on' ? 'The lidar was flown in leaf: drawn as flown, no leaves added.' : 'The flight season is unknown: drawn as flown.'}${columns}`);
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
  const applySolid = () => { ids.forEach((id, i) => { if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-opacity', Math.min(1, bandAt(i).opacity * solid())); }); };
  try { const v = localStorage.getItem('lawnmapper.shade.treesSolid'); if (v) $('#tr-solid').value = v; } catch { /* not kept */ }
  $('#tr-solid').oninput = () => { applySolid(); try { localStorage.setItem('lawnmapper.shade.treesSolid', $('#tr-solid').value); } catch { /* not kept */ } };
  $('#tr-legend').innerHTML = Object.entries(KIND_COLOR).filter(([k]) => (leafOff ? k !== 'other' || season.inLeafColumns > 0 : k === 'other' || k === 'roof'))
    .map(([k, c]) => `<span class="sw" style="background:${c}"></span>${KIND_NAME[k]}`).join('<br>')
    + `<br><span class="dim">Faint to solid: ${BANDS.map((b) => b.name).join('; ')}.</span>`;

  const onClick = (e) => {
    if (!st.active || st.erasing) return;
    /* The column of the block under the finger; the ground's when none is. */
    const hit = hitUnder(e.lngLat);
    const [x, y] = toMerc([e.lngLat.lng, e.lngLat.lat]);
    const gx = hit ? hit.k % grid.w : Math.floor((x - grid.x0) / grid.cell), gy = hit ? Math.floor(hit.k / grid.w) : Math.floor((grid.y1 - y) / grid.cell);
    if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) { $('#tr-read').textContent = 'Outside the modelled area.'; return; }
    const k = gy * grid.w + gx, mu = muNow();
    if (er?.mask[k]) { $('#tr-read').textContent = 'Erased: open air here now. Undo or "Put all back" restores it.'; return; }
    const runs = treeRuns({ ...model, w: 1, h: 1, ground: [model.ground[k]] }, mu.subarray(k * model.nz, (k + 1) * model.nz), null, { roofs: true });
    let leafy = false;
    for (let l = 0; l < model.nz && !leafy; l++) if (season.muOn[k * model.nz + l] > season.muOff[k * model.nz + l]) leafy = true;
    const kind = kindOf(season, k, leafy);
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
    const parts = [];
    if (er.count) parts.push(`${er.count.toLocaleString()} square meter${er.count === 1 ? '' : 's'} of whole columns`);
    if (er.cubeCount) parts.push(`${er.cubeCount.toLocaleString()} block${er.cubeCount === 1 ? '' : 's'}`);
    el.textContent = er.any ? `${parts.join(' and ')} erased (${er.strokes.length} stroke${er.strokes.length === 1 ? '' : 's'}). The shade will be worked out without them.`
      : st.mode === 'branch' ? 'Nothing erased. Drag over a tree to take off the blocks facing you, one layer per stroke: the top from above, the near side from a low camera.'
        : 'Nothing erased. Drag the eraser over a tree to take it out of the model, whole columns at a time; tap the eraser again when done.';
    if ($('#tr-undo')) $('#tr-undo').disabled = !er.strokes.length;
    if ($('#tr-restore')) $('#tr-restore').disabled = !er.any;
  }
  const showCursor = (lngLat, centre = null) => {
    if (!er || !st.erasing || !lngLat) return;
    const [x, y] = centre || toMerc([lngLat.lng, lngLat.lat]);
    const data = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [squareRing(grid, x, y, st.size)] } };
    if (map.getSource(CURSOR)) map.getSource(CURSOR).setData(data);
    else {
      map.addSource(CURSOR, { type: 'geojson', data });
      map.addLayer({ id: CURSOR, type: 'line', source: CURSOR, paint: { 'line-color': '#ffffff', 'line-width': 2 } });
    }
  };
  const hideCursor = () => { if (map.getLayer(CURSOR)) map.removeLayer(CURSOR); if (map.getSource(CURSOR)) map.removeSource(CURSOR); };
  /* Changes to the drawn blocks, gathered through a frame and sent once per
     source: a dynamic source (Mapbox v3.4+) drops a feature updated with no
     geometry and adds one given; an older map gets the whole collection
     again (owner, 2026-10-17: erasing was "jittery/laggy" -- every move
     used to rebuild the 30,000-feature list). */
  const batch = ids.map(() => ({ drop: [], add: [] }));
  const flush = () => {
    batch.forEach((b, i) => {
      if (!b.drop.length && !b.add.length) return;
      /* A cube added and taken away in the same frame (a column split and
         its nearest cube erased at once) was never on the map: neither
         goes to the source, which would otherwise choke on it. */
      const dropped = new Set(b.drop), added = new Set(b.add.map((f) => f.id));
      b.add = b.add.filter((f) => !dropped.has(f.id));
      b.drop = b.drop.filter((id) => !added.has(id));
      const src = map.getSource(ids[i]);
      for (const id of b.drop) removed[i].add(id);
      for (const f of b.add) removed[i].delete(f.id);
      if (typeof src?.updateData === 'function') {
        src.updateData({ type: 'FeatureCollection', features: [...b.drop.map((id) => ({ type: 'Feature', id, geometry: null, properties: {} })), ...b.add] });
      } else if (src) {
        current[i] = { type: 'FeatureCollection', features: [...current[i].features.filter((f) => !removed[i].has(f.id)), ...b.add] };
        src.setData(current[i]);
      }
      b.drop = []; b.add = [];
    });
  };
  /* Erased blocks already on the map are flattened by feature state (no
     source update, so no re-tiling: the other half of the lag); a block
     added in this same frame never reaches the source. */
  const freshIds = ids.map(() => new Set());
  const hide = (src, id) => {
    if (freshIds[src].has(id)) { batch[src].drop.push(id); return; }
    map.setFeatureState({ source: ids[src], id }, { gone: true });
  };
  const dropCells = (cells) => { for (const k of cells) for (const f of byCell.get(k) || []) hide(f.src, f.id); };
  /* THE BRANCHES BRUSH WORKS ON SINGLE CUBES (owner, 2026-10-17: "it
     deletes a whole column up to the sky... we need to break them into
     cubes for this step. if a homeowner trimmed the lowest branches on a
     tree, they need to be able to erase those branches"). A column is
     drawn as runs of cubes; the first time the brush touches it, its runs
     are hidden and redrawn as one block per cube in the small sources, and
     then the blocks the camera's rays meet first go. */
  const splitColumn = (k) => {
    const entries = byCell.get(k) || [];
    if (!entries.length || entries.every((e) => e.cube)) return;
    const mu = baseMu();
    const fresh = [];
    for (const e of entries) {
      hide(e.src, e.id);
      for (let l = e.l0; l <= e.l1; l++) {
        const m = er.cubes[k * model.nz + l] ? 0 : mu[k * model.nz + l];
        if (!(m >= MIN_MU)) continue;
        const lo = model.z0 + l * model.dz - model.ground[k], base = Math.max(e.base, lo), top = Math.min(e.top, lo + model.dz);
        if (top <= base) continue;
        const src = NB + bandOf(m);
        const f = { type: 'Feature', id: CUBE_ID + k * 128 + l, geometry: { type: 'Polygon', coordinates: corners(k) }, properties: { b: base + lift(k), t: top + lift(k), c: KIND_COLOR[e.kind] } };
        batch[src].add.push(f);
        freshIds[src].add(f.id);
        fresh.push({ src, id: f.id, l0: l, l1: l, base, top, kind: e.kind, cube: true });
      }
    }
    byCell.set(k, fresh);
  };
  /* Where the camera stands, in grid cells and meters over the ground (the
     blocks are drawn on a flat map, so the ground is 0). */
  const cameraCell = () => {
    const fc = map.getFreeCameraOptions();
    const ll = fc.position.toLngLat();
    const [mx, my] = toMerc([ll.lng, ll.lat]);
    return [(mx - grid.x0) / grid.cell, (grid.y1 - my) / (grid.cellY || grid.cell), fc.position.toAltitude()];
  };
  /* A block as drawn: its layer at a height over the flat map, and whether it is there to be hit. */
  const isRoof = (k) => season?.kind?.[k] === 1;
  const cubeAt = (k, z) => {
    const l = Math.floor((z - lift(k) + model.ground[k] - model.z0) / model.dz);
    return l >= 0 && l < model.nz ? l : -1;
  };
  const visible = (k, l) => {
    if (er?.mask[k]) return false;
    const i = k * model.nz + l;
    if (er?.cubes?.[i] || !(baseMu()[i] >= MIN_MU)) return false;
    if (!st.roofs && isRoof(k)) return false;
    return model.z0 + (l + 1) * model.dz - model.ground[k] > st.cut;
  };
  const camera3 = () => cameraCell();
  const groundCell = (lngLat) => { const [mx, my] = toMerc([lngLat.lng, lngLat.lat]); return [(mx - grid.x0) / grid.cell, (grid.y1 - my) / (grid.cellY || grid.cell), 0]; };
  const hitOpts = (taken = null) => ({ w: grid.w, h: grid.h, nz: model.nz, cubeAt, visible, taken });
  /** The block under the finger (the first a ray from the camera through it meets), or null. */
  function hitUnder(lngLat) { return lngLat ? rayHit(camera3(), groundCell(lngLat), hitOpts()) : null; }
  const cellCentre = (k) => [grid.x0 + ((k % grid.w) + 0.5) * grid.cell, grid.y1 - (Math.floor(k / grid.w) + 0.5) * (grid.cellY || grid.cell)];

  let stroking = false, strokeTaken = new Set();
  /** One frame of the brush at the finger; returns the centre to draw the cursor at (3857). */
  const brush = (lngLat) => {
    if (!er || !lngLat) return null;
    const cam = camera3();
    const hit = rayHit(cam, groundCell(lngLat), hitOpts());
    if (st.mode !== 'branch') {
      /* Whole tree: the columns round the block under the finger (the ground's when nothing is). */
      const [x, y] = hit ? cellCentre(hit.k) : toMerc([lngLat.lng, lngLat.lat]);
      if (stroking) { const fresh = er.erase(cellsUnder(grid, x, y, st.size)); if (fresh.length) dropCells(fresh); }
      return [x, y];
    }
    /* Branches: the blocks facing the camera under the brush, each the first
       its ray meets; a ray stops at a block taken earlier in this stroke,
       so one swipe takes one layer and the next swipe the one behind. */
    const first = hit || rayHit(cam, groundCell(lngLat), hitOpts(strokeTaken));
    if (!first) return toMerc([lngLat.lng, lngLat.lat]);
    if (!stroking) return cellCentre(first.k);
    const seen = new Set();
    for (const target of brushTargets(cam, first.at, st.size)) {
      const r = rayHit(cam, target, hitOpts(strokeTaken));
      if (!r) continue;
      const i = r.k * model.nz + r.l;
      if (seen.has(i)) continue;
      seen.add(i);
      splitColumn(r.k);
      const entry = (byCell.get(r.k) || []).find((o) => o.l0 === r.l);
      if (!er.eraseCubes([i]).length) continue;
      strokeTaken.add(i);
      st.cubeVersion++;
      if (entry) { byCell.set(r.k, byCell.get(r.k).filter((o) => o !== entry)); hide(entry.src, entry.id); }
    }
    return cellCentre(first.k);
  };
  /* Pointer moves are gathered and worked once a frame: the brush, the
     cursor and the map's changes together. */
  let frame = null, lastAt = null;
  const onFrame = () => { frame = null; const at = lastAt; lastAt = null; if (!at) return; const centre = brush(at); showCursor(at, centre); flush(); freshIds.forEach((s) => s.clear()); };
  const queue = (lngLat) => { lastAt = lngLat; if (!frame) frame = requestAnimationFrame(onFrame); };
  const strokeStart = (e) => { if (!st.erasing || !st.active) return; e.preventDefault?.(); stroking = true; strokeTaken = new Set(); queue(e.lngLat); };
  const strokeMove = (e) => { if (!st.erasing || !st.active) return; queue(e.lngLat); };
  const strokeEnd = () => { if (!stroking) return; stroking = false; if (frame) { cancelAnimationFrame(frame); onFrame(); } flush(); er.end(); eraseNote(); onErase?.(); };
  /* While the brush is down the page must not move (owner, 2026-10-17:
     "swiping down can refresh the page... dragging/swiping in any direction
     pans the whole page"): the map's own pan is off, so the browser would
     scroll; these hold it. */
  const holdTouch = (ev) => { if (st.erasing) ev.preventDefault(); };
  const setErasing = (on) => {
    st.erasing = on;
    stroking = false;
    $('#tr-erase')?.classList.toggle('on', on);
    $('#tr-erase')?.setAttribute('aria-pressed', String(on));
    map.getCanvas().style.cursor = on ? 'none' : '';
    map.getCanvas().dataset.erasing = on ? '1' : '';
    map.getContainer().classList.toggle('held', on);
    for (const h of [map.dragPan, map.touchZoomRotate, map.dragRotate]) on ? h.disable() : h.enable();
    if (!on) { hideCursor(); flush(); }
  };
  if (er && $('#tr-erase')) {
    for (const ev of ['touchstart', 'touchmove']) map.getContainer().addEventListener(ev, holdTouch, { passive: false });
    map.on('mousedown', strokeStart); map.on('touchstart', strokeStart);
    map.on('mousemove', strokeMove); map.on('touchmove', strokeMove);
    map.on('mouseup', strokeEnd); map.on('touchend', strokeEnd); map.on('touchcancel', strokeEnd);
    $('#tr-erase').onclick = () => setErasing(!st.erasing);
    for (const b of document.querySelectorAll('[data-erase-m]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.eraseM) === st.size));
      b.onclick = () => { st.size = Number(b.dataset.eraseM) || SIZES_M[1]; for (const o of document.querySelectorAll('[data-erase-m]')) o.setAttribute('aria-pressed', String(o === b)); if (!st.erasing) setErasing(true); };
    }
    /* Whole tree (every block in the column) or branches (the block facing the camera). */
    for (const b of document.querySelectorAll('[data-erase-mode]')) {
      b.setAttribute('aria-pressed', String(b.dataset.eraseMode === st.mode));
      b.onclick = () => { st.mode = b.dataset.eraseMode === 'branch' ? 'branch' : 'tree'; for (const o of document.querySelectorAll('[data-erase-mode]')) o.setAttribute('aria-pressed', String(o === b)); eraseNote(); if (!st.erasing) setErasing(true); };
    }
    if ($('#tr-undo')) $('#tr-undo').onclick = () => { er.undo(); st.cubeVersion++; draw(); onErase?.(); };
    if ($('#tr-restore')) $('#tr-restore').onclick = () => { er.clear(); st.cubeVersion++; draw(); onErase?.(); };
  }

  draw();
  applySolid();
  return {
    /** The erased mask (Uint8Array per 1 m cell), or null when nothing is erased. */
    erased: () => (er?.any ? er.mask : null),
    erasedCount: () => er?.count || 0,
    /** The erased cells as a sorted list of indices (kept on the server with the map). */
    erasedCells() { if (!er?.count) return []; const out = []; for (let k = 0; k < er.mask.length; k++) if (er.mask[k]) out.push(k); return out; },
    /** The erased single blocks (indices k * nz + l), likewise. */
    erasedCubes: () => er?.cubeList() || [],
    /** The model's cube layers per column: a kept list of blocks fits only a model with the same. */
    nz: model.nz,
    /** The block under a point on the map's ground plane as the camera sees it ({ k, l }), or null. */
    hitAt: (lngLat) => { const h = hitUnder(lngLat); return h && { k: h.k, l: h.l }; },
    /** What was erased last time, back out of the model (one stroke, so one undo puts it all back): a list of cells, or { cells, cubes }. */
    restore(what) {
      if (!er) return;
      const cells = Array.isArray(what) ? what : what?.cells || [], cubes = Array.isArray(what) ? [] : what?.cubes || [];
      const a = er.erase(cells.filter((k) => Number.isInteger(k) && k >= 0 && k < er.mask.length));
      const b = er.eraseCubes(cubes.filter((i) => Number.isInteger(i)));
      er.end();
      if (a.length || b.length) { st.cubeVersion++; draw(); }
    },
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
      for (const ev of ['touchstart', 'touchmove']) map.getContainer().removeEventListener(ev, holdTouch);
      map.off('click', onClick);
      for (const [ev, h] of [['mousedown', strokeStart], ['touchstart', strokeStart], ['mousemove', strokeMove], ['touchmove', strokeMove], ['mouseup', strokeEnd], ['touchend', strokeEnd], ['touchcancel', strokeEnd]]) map.off(ev, h);
      for (const id of ids) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
      sec.hidden = true;
    },
  };
}
