/**
 * The "Sun and shade" section of /shade.html: drives light-worker.js and
 * paints its answers onto the map (shade map, step 2).
 *
 *   Hours of sun        per 0.5 m of lot, hours of direct sun on the chosen
 *                       day, dappled light counted for the share that
 *                       gets through
 *   Light (DLI)         mol/m2 of photosynthetic light that day, clear sky
 *   Shadows at a time   the shade at one moment, to hold against the
 *                       shadows in the photo
 *   Season light        the average DLI through the growing season, with
 *                       NASA's typical clouds (step 3, climate.js)
 *   Trees               which crowns read as evergreen and which as
 *                       deciduous (step 4, seasonal.js), to check by eye
 *
 * Plus the lawn's (or lot's) split into full sun / part shade / shade, and
 * a month-by-month table of clear-sky DLI against open ground.
 */

import { reportError } from './usage.js';
import { gridOver, gridBox } from './grid.js';
import { fromMerc, toMerc } from './ept.js';
import { sunPath } from './sun.js';
import { GRASS, dayLabel } from './climate.js';
import { heat, bandsFor, rasterOf, smooth, valueAt, boxStats } from './readout.js';
import { groundLayer } from './view3d.js';

const $ = (s) => document.querySelector(s);
const SQFT = 10.7639;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The light ramp: dark and cool in shade to bright and warm in sun (readout.js). */
export const ramp = heat;
const ALPHA = 215; // solid enough for the colors, thin enough for the ground under the darkest shade
 /* Lawn and open ground in the year chart: categorical slots 1 and 2 of the
    dataviz reference palette, dark steps, validated on this page's #161616. */
const LAWN = '#3987e5', OPEN = '#d95926';
/* Tree kinds on the map: aqua and yellow slots of the same palette, and gray for buildings. */
const KIND_RGBA = { 1: [140, 140, 140, 200], 2: [25, 158, 112, 210], 3: [201, 133, 0, 210] };
const KIND_NAME = { 0: 'open ground', 1: 'a building', 2: 'evergreen', 3: 'deciduous' };

/* Light bands for the season map's area split, mol/m2/day. A rough guide
   only: cool-season turf grows best at 20-30, slows at 10-15 and survives
   below 6 (ICL turf guidance); bermudagrass greens needed ~33 (Clemson). */
export const BANDS = {
  cool: [[20, Infinity, '20 or more'], [10, 20, '10 to 20'], [0, 10, 'under 10']],
  warm: [[30, Infinity, '30 or more'], [15, 30, '15 to 30'], [0, 15, 'under 15']],
};

/* A stepped legend bar: one hard-edged block per band. */
const bandsCss = (b) => `linear-gradient(90deg, ${b.colors.map((c, i) => `rgb(${c.join(',')}) ${((100 * i) / b.n).toFixed(2)}% ${((100 * (i + 1)) / b.n).toFixed(2)}%`).join(', ')})`;
const fmt = (v, step) => (Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(1));

/**
 * About what a clock there would say: the standard offset from the
 * longitude, plus US daylight time between the second Sunday of March and
 * the first of November. "About" because a time zone is a line on a map,
 * not a longitude.
 */
export function aboutLocal(ms, lng) {
  let off = Math.round(lng / 15);
  const d = new Date(ms);
  if (lng < -50 && lng > -170) {
    const y = d.getUTCFullYear();
    const nth = (m, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + ((7 - first) % 7) + 7 * (n - 1), 7); };
    if (ms >= nth(2, 2) && ms < nth(10, 1)) off += 1;
  }
  const t = new Date(ms + off * 3600000);
  const h = t.getUTCHours(), m = t.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

const polysOf = (g) => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : []);

export function startSun({ map, site, cols, box, shift, heightM, season, beforeLayer, ground = null }) {
  const st = {
    worker: null, mode: 'hours', day: null, now: null, ids: 0, path: [],
    grid: gridOver(box, 1, site.lat),
  };
  st.drape = ground && ground.length === st.grid.w * st.grid.h ? groundLayer('light-3d', { grid: st.grid, ground, baseZ: heightM, lat: site.lat }) : null;
  const onPitch = () => drapeMode();
  map.on('pitchend', onPitch);
  const sec = $('#sun');
  sec.hidden = false;
  const status = (t) => { $('#sun-status').textContent = t; };
  const today = new Date();
  $('#sun-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dayMs = () => {
    const [y, m, d] = $('#sun-date').value.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12 - Math.round(site.lng / 15)); // about local noon
  };

  function corners() {
    const [x0, y0, x1, y1] = gridBox(st.grid);
    return [fromMerc([x0, y1]), fromMerc([x1, y1]), fromMerc([x1, y0]), fromMerc([x0, y0])];
  }

  /* Paints the answers at 0.5 m and keeps them (st.shown) for the pin and
     the box: smoothed for the light views, as they are for the shadows at a
     moment and the trees. */
  /* Lawn only (owner, 2026-10-12; on by default when a lawn is traced): the
     light views keep only the pixels whose 1 m cell is inside a traced lawn,
     for the colors, the pin and the box alike. The trees are shown
     everywhere. */
  const lawnOnly = (read) => st.lawnOnly && st.lawnMask && read && !read.kind;
  function paint(values, xy, color, { span = 1, smoothed = false, read } = {}) {
    const W = st.grid.w * 2, H = st.grid.h * 2;
    let r = rasterOf(values, xy, W, H, { span });
    if (smoothed) r = smooth(r, W, H);
    if (lawnOnly(read)) for (let k = 0; k < r.length; k++) if (!st.lawnMask[((k / W / 2) | 0) * st.grid.w + ((k % W) >> 1)]) r[k] = NaN;
    st.shown = { r, W, H, read, lawn: lawnOnly(read) };
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    for (let k = 0; k < r.length; k++) {
      if (Number.isNaN(r[k])) continue;
      const rgba = color(r[k]);
      if (rgba) img.data.set(rgba, k * 4);
    }
    g.putImageData(img, 0, 0);
    const url = c.toDataURL();
    if (map.getSource('light')) map.getSource('light').updateImage({ url, coordinates: corners() });
    else {
      map.addSource('light', { type: 'image', url, coordinates: corners() });
      map.addLayer({ id: 'light', type: 'raster', source: 'light', paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, beforeLayer());
    }
    /* Tilted, the same picture lies on the lidar's ground (view3d.js groundLayer). */
    if (st.drape) {
      try {
        if (!map.getLayer(st.drape.id)) map.addLayer(st.drape, beforeLayer());
        st.drape.setImage(c);
        drapeMode();
      } catch (e) { st.drape = null; reportError('ground layer', e.message); if (map.getLayer('light')) map.setPaintProperty('light', 'raster-opacity', 1); }
    }
  }
  /* Flat picture looking straight down; on the ground when the map is tilted. */
  function drapeMode() {
    if (!st.drape || !map.getLayer(st.drape.id) || !map.getLayer('light')) return;
    const tilted = map.getPitch() > 5;
    map.setLayoutProperty(st.drape.id, 'visibility', tilted ? 'visible' : 'none');
    map.setPaintProperty('light', 'raster-opacity', tilted ? 0 : 1);
  }

  function legend(b, unit) {
    $('#sun-legend').innerHTML = `<span>0</span><span class="ramp" style="background:${bandsCss(b)}"></span><span>${fmt(b.edges[b.n], b.step)} ${unit}</span><span class="dim">steps of ${b.step}</span>`;
  }

  /* A light view: banded colors over the smoothed values, 0 to `top`. */
  function paintLight(values, xy, top, unit, read, span = 1, step) {
    const b = bandsFor(top, { step });
    legend(b, unit);
    paint(values, xy, (v) => [...b.colors[b.of(v)], ALPHA], { span, smoothed: true, read });
  }

  function draw() {
    if (st.mode === 'trees') {
      if (!st.kinds) return;
      $('#sun-legend').innerHTML = '<span><i class="sw" style="background:#199e70"></i>evergreen</span> <span><i class="sw" style="background:#c98500"></i>deciduous</span> <span><i class="sw" style="background:#8c8c8c"></i>building</span>';
      const xy = new Float32Array(st.grid.w * st.grid.h * 2), vals = new Uint8Array(st.grid.w * st.grid.h);
      for (let k = 0; k < vals.length; k++) { xy[2 * k] = k % st.grid.w; xy[2 * k + 1] = Math.floor(k / st.grid.w); vals[k] = st.kinds[k]; }
      paint(vals, xy, (v) => KIND_RGBA[v] || null, { span: 2, read: { kind: true } });
      readouts();
      return;
    }
    if (st.mode === 'season') {
      const se = st.season;
      if (!se?.stats.open) { $('#sun-legend').innerHTML = '<span class="dim">No growing season to show yet.</span>'; return; }
      paintLight(se.mean, se.xy, Math.max(1, se.stats.open.mean), 'mol/m²/day, season average', { unit: 'mol/m²/day', what: 'season average, typical weather', dp: 1 }, 2);
    } else if (st.mode === 'now' && st.now) {
      $('#sun-legend').innerHTML = '<span class="dim">Dark = shade from the lidar at that moment</span>';
      paint(st.now.T, st.now.xy, (T) => [0, 0, 20, Math.round((1 - T) * 170)], { read: { share: true } });
    } else if (st.day) {
      const d = st.day;
      if (st.mode === 'dli') paintLight(d.dli, d.xy, Math.max(1, d.openDli), 'mol/m²/day', { unit: 'mol/m²/day', what: 'clear day', dp: 1 });
      else paintLight(d.sunHours, d.xy, Math.max(1, d.dayHours), 'hours of sun', { unit: 'hours of sun', what: 'clear day, dappled sun counted for the share that gets through', dp: 1 }, 1, 1);
    }
    readouts();
  }

  /* ---- Pin and box: read the map where it is tapped or boxed. ---- */
  const pixelOf = (lngLat) => {
    const [mx, my] = toMerc([lngLat.lng, lngLat.lat]);
    return [((mx - st.grid.x0) / st.grid.cell) * 2, ((st.grid.y1 - my) / st.grid.cell) * 2];
  };
  const sqft = (pixels) => Math.round(pixels * 0.25 * SQFT).toLocaleString();
  function pinText() {
    const sh = st.shown;
    if (!sh?.read) return '';
    const [x, y] = pixelOf(st.pin.lngLat);
    const v = valueAt(sh.r, sh.W, sh.H, x, y);
    if (Number.isNaN(v)) return sh.lawn ? 'Not on the traced lawn. Turn off "Lawn only" to read the whole lot.' : 'No grass to light here: a building, under a crown nothing gets through, or outside the lot.';
    if (sh.read.kind) return `Trees: <b>${KIND_NAME[v] || 'open ground'}</b>`;
    if (sh.read.share) return `<b>${Math.round(v * 100)}%</b> of the sun at that moment`;
    return `<b>${v.toFixed(sh.read.dp)}</b> ${sh.read.unit}<br><span class="dim">${sh.read.what}, averaged over about a meter</span>`;
  }
  function boxText() {
    const sh = st.shown;
    if (!sh?.read || !st.box) return '';
    const [ax, ay] = pixelOf(st.box[0]), [bx, by] = pixelOf(st.box[1]);
    const s = boxStats(sh.r, sh.W, sh.H, [ax, ay, bx, by], { counts: !!sh.read.kind });
    if (!s.n) return sh.lawn ? 'No traced lawn in this box. Turn off "Lawn only" to measure the whole lot.' : 'Nothing to measure in this box: light is worked out only on the lot, and not under roofs.';
    if (sh.read.kind) {
      return `In the box (${sqft(s.n)} sq ft): ${Object.entries(s.tally).sort((p, q) => q[1] - p[1]).map(([k, c]) => `${KIND_NAME[k] || 'open ground'} ${Math.round((100 * c) / s.n)}%`).join(', ')}`;
    }
    const f = (v) => (sh.read.share ? `${Math.round(v * 100)}%` : v.toFixed(sh.read.dp));
    const unit = sh.read.share ? 'of the sun' : sh.read.unit;
    return `In the box (${sqft(s.n)} sq ft of ${sh.lawn ? 'lawn' : 'the lot'} measured), ${unit}: lowest <b>${f(s.min)}</b>, highest <b>${f(s.max)}</b>, average <b>${f(s.mean)}</b>`;
  }
  function readouts() {
    if (st.pin) st.pin.popup.setHTML(pinText() || 'Pick a view above to read it here.');
    $('#sun-box-stats').innerHTML = boxText();
  }
  function showBox() {
    const [a, b] = st.box;
    const ring = [[a.lng, a.lat], [b.lng, a.lat], [b.lng, b.lat], [a.lng, b.lat], [a.lng, a.lat]];
    const data = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
    if (map.getSource('light-box')) map.getSource('light-box').setData(data);
    else {
      map.addSource('light-box', { type: 'geojson', data });
      map.addLayer({ id: 'light-box', type: 'line', source: 'light-box', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1] } });
    }
  }
  function clearReadouts() {
    st.pin?.marker.remove();
    st.pin = null;
    st.box = null;
    if (map.getLayer('light-box')) map.removeLayer('light-box');
    if (map.getSource('light-box')) map.removeSource('light-box');
    $('#sun-box-stats').innerHTML = '';
  }
  const onClick = (e) => {
    if (st.boxing || Date.now() - (st.boxEnded || 0) < 400 || map.getCanvas().dataset.erasing === '1') return;
    if (!st.pin) {
      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 28, className: 'light-pin' });
      st.pin = { marker: new mapboxgl.Marker({ color: '#ffffff' }).setLngLat(e.lngLat).setPopup(popup).addTo(map), popup };
    }
    st.pin.lngLat = e.lngLat;
    st.pin.marker.setLngLat(e.lngLat);
    if (!st.pin.popup.isOpen()) st.pin.marker.togglePopup();
    readouts();
  };
  /* Drawing a box: one drag, with the map held still while it lasts. */
  const boxStart = (e) => {
    if (!st.boxing) return;
    e.preventDefault?.();
    st.drag = e.lngLat;
    st.box = [e.lngLat, e.lngLat];
  };
  const boxMove = (e) => {
    if (!st.boxing || !st.drag || !e.lngLat) return;
    st.box = [st.drag, e.lngLat];
    showBox();
  };
  const boxEnd = () => {
    if (!st.boxing || !st.drag) return;
    st.drag = null;
    setBoxing(false);
    st.boxEnded = Date.now();
    if (st.box && (st.box[0].lng !== st.box[1].lng || st.box[0].lat !== st.box[1].lat)) { showBox(); readouts(); }
  };
  function setBoxing(on) {
    st.boxing = on;
    $('#sun-box').classList.toggle('on', on);
    $('#sun-box').textContent = on ? 'Drag across the map…' : 'Draw a box';
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    for (const h of [map.dragPan, map.touchZoomRotate, map.dragRotate]) on ? h.disable() : h.enable();
  }
  map.on('click', onClick);
  map.on('mousedown', boxStart); map.on('touchstart', boxStart);
  map.on('mousemove', boxMove); map.on('touchmove', boxMove);
  map.on('mouseup', boxEnd); map.on('touchend', boxEnd);
  $('#sun-box').onclick = () => setBoxing(!st.boxing);
  st.lawnOnly = true;
  $('#t-lawn').setAttribute('aria-pressed', 'true');
  $('#t-lawn').onclick = () => {
    st.lawnOnly = !st.lawnOnly;
    $('#t-lawn').setAttribute('aria-pressed', String(st.lawnOnly));
    if (st.mode === 'now') runNow(); else draw();
  };
  $('#sun-clear').onclick = () => { setBoxing(false); clearReadouts(); };

  function summary() {
    const d = st.day;
    if (!d) return;
    const what = site.lawn.length ? 'The lawn' : 'The lot (open ground)';
    const a = d.areaM2, tot = a.full + a.part + a.shade || 1;
    const row = (label, m2) => `<tr><td>${label}</td><td>${Math.round(m2 * SQFT).toLocaleString()} sq ft</td><td class="dim">${Math.round((100 * m2) / tot)}%</td></tr>`;
    $('#sun-summary').innerHTML = `
      <p><b>${what}</b> on ${new Date(dayMs()).toUTCString().slice(5, 11)}${st.canopy === 'seasonal' && d.leaves < 1 ? ` (deciduous leaves ${Math.round(d.leaves * 100)}% out)` : ''}: on average <b>${d.meanSun.toFixed(1)} hours</b> of direct sun of ${d.dayHours.toFixed(1)} the day has
      (sunrise about ${aboutLocal(d.sunrise, site.lng)}, sunset about ${aboutLocal(d.sunset, site.lng)}), and <b>${d.meanDli.toFixed(0)} mol/m²</b> of light
      against ${d.openDli.toFixed(0)} on open ground here (${Math.round((100 * d.meanDli) / d.openDli)}%).</p>
      <table>${row('Full sun, 6 h or more', a.full)}${row('Part shade, 3 to 6 h', a.part)}${row('Shade, under 3 h', a.shade)}</table>`;
  }

  function months(rows) {
    $('#sun-months').innerHTML = `<h2>Through the year <span class="dim">clear-sky DLI on the 21st, mol/m²/day</span></h2>
      <table><tr><th>Month</th><th>${site.lawn.length ? 'Lawn' : 'Lot'}</th><th>Open ground</th><th>Share</th><th>Sun h</th>${st.canopy === 'seasonal' ? '<th>Leaves</th>' : ''}</tr>
      ${rows.map((r) => `<tr><td>${MONTHS[r.month]}</td><td>${r.dli.toFixed(0)}</td><td class="dim">${r.openDli.toFixed(0)}</td><td>${Math.round((100 * r.dli) / r.openDli)}%</td><td class="dim">${r.sunHours.toFixed(1)} / ${r.dayHours.toFixed(1)}</td>${st.canopy === 'seasonal' ? `<td class="dim">${Math.round(r.leaves * 100)}%</td>` : ''}</tr>`).join('')}</table>`;
  }

  function send(msg) {
    msg.id = ++st.ids;
    st.worker.postMessage(msg);
    return msg.id;
  }

  function runDay() {
    status('Working out the day…');
    st.path = sunPath(site.lat, site.lng, dayMs(), 10);
    const slider = $('#sun-time');
    slider.max = String(Math.max(1, st.path.length - 1));
    if (Number(slider.value) > Number(slider.max)) slider.value = String(Math.floor(st.path.length / 2));
    st.dayId = send({ type: 'day', dayMs: dayMs() });
    if (st.mode === 'now') runNow();
  }

  function runNow() {
    const s = st.path[Number($('#sun-time').value)] || st.path[Math.floor(st.path.length / 2)];
    if (!s) return;
    $('#sun-time-label').textContent = `about ${aboutLocal(s.t, site.lng)}, sun ${s.elevation.toFixed(0)}° up`;
    st.nowId = send({ type: 'now', t: s.t });
  }

  function canopyNote(m) {
    const c = m.counts, total = c ? c.evergreen + c.deciduous : 0;
    const how = 'tree by tree: evergreen when its crown let less than a fifth of the overhead sun through in winter (an evergreen still has its needles when the laser flies, so it needs no summer leaves) and is not a broad, flat-topped dome (an open-grown oak or maple, which can hold its dead leaves into a late-autumn flight). Checked on 177 hand-labelled trees: an evergreen called deciduous comes out about twice too dark under it in summer, so the rule leans that way rather than leave a broadleaf bare, nine times too bright';
    const split = c && m.classified && total
      ? ` Of the tree cover here, ${Math.round((100 * c.evergreen) / total)}% reads as evergreen and ${Math.round((100 * c.deciduous) / total)}% as deciduous, ${how}. A tree so dense that nothing got through (a big spruce) is solid all year, told from a roof by its rough top. The "Trees" view shows which is which. It matters from leaf-out to leaf-fall: a deciduous tree called evergreen gets no summer leaves.`
      : '';
    let text;
    if (m.canopy === 'seasonal') {
      const cal = m.calendar;
      const when = cal.always ? 'Deciduous trees here keep their leaves all year in a typical year.'
        : cal.never ? 'It never gets warm enough here, in a typical year, for deciduous trees to leaf out.'
          : `Leaves estimated coming out ${dayLabel(cal.out)} to ${dayLabel(cal.full)} (half out ${dayLabel(cal.halfOut)}) and falling to bare by ${dayLabel(cal.bare)} (half gone ${dayLabel(cal.halfFall)}), from ${weatherWords(st.climate)}, matched to the shade measured under eleven US forests through two years (NEON's ground light sensors).`;
      text = `Trees through the seasons: ${when} In the leaf-off months every tree is as the laser measured it, evergreens included. In leaf, deciduous crowns get leaves that stop light by the crown's depth (leaf area 1 m² per m³ of crown, up to a leaf area index of 5.5, as measured on solitary maples and oaks): a full crown passes about 6% of the sun straight down and 2% at 45°, and the model puts the floor of a closed forest at about 3–5% of the day's light in summer, within the 2.4–6.2% measured under closed canopies (Canham et al. 1994). Late summer is darker because the sun is lower, not because there are more leaves. Evergreens stay as measured: the winter flight already saw their foliage.${split}`;
    } else if (m.canopy === 'solid') {
      text = 'Trees as solid: no light gets through any crown. The darkest the shade could be.';
    } else {
      text = `Trees as the laser saw them, all year${m.seasonsWhy ? ` (seasons are off: ${m.seasonsWhy})` : ''}.${split}`;
    }
    $('#sun-canopy-note').textContent = text;
  }

  /** Where the calendar's temperatures came from: this year's weather, or the typical year alone. */
  function weatherWords(c) {
    const w = c?.weather;
    if (!c?.tMeanNow || !w) return 'the typical temperature here';
    const md = (iso) => (iso ? dayLabel(Math.round((Date.parse(iso) - Date.UTC(Number(iso.slice(0, 4)), 0, 1)) / 86400000)) : null);
    const parts = [];
    if (w.observedThrough) parts.push(`this year's weather as observed through ${md(w.observedThrough)}`);
    if (w.forecastTo) parts.push(`the forecast to ${md(w.forecastTo)}`);
    parts.push(`then the typical year${Math.abs(w.anomaly) >= 0.5 ? ` ${w.anomaly > 0 ? 'warmed' : 'cooled'} by the recent ${Math.abs(w.anomaly).toFixed(1)} °C, fading` : ''}`);
    return parts.join(', ');
  }

  function runSeason() {
    if (!st.built || !st.climate) return;
    const grass = $('#grass').value, threshold = Number($('#gp').value);
    st.seasonId = send({ type: 'season', climate: st.climate, grass, threshold, bands: BANDS[grass].map(([lo, hi]) => [lo, hi]) });
  }

  function seasonSummary() {
    const se = st.season, c = st.climate;
    const grass = $('#grass').value, g = GRASS[grass];
    const strict = Number($('#gp').value) >= 0.5;
    $('#season-status').textContent = '';
    const how = `estimated from NASA's daily temperatures ${c.years} (growth potential at least ${strict ? '0.5' : '0.1'}, the PACE Turf model); Turf Tools' season will replace this estimate`;
    if (!se.stats.lawn) {
      $('#season-summary').innerHTML = `<p>In a typical year it is never warm enough here for ${g.label.toLowerCase()} grass to ${strict ? 'grow strongly' : 'grow'} (${how}).</p>`;
      $('#season-chart').innerHTML = chart(se, c);
      return;
    }
    const L = se.stats.lawn, O = se.stats.open;
    const when = se.season.allYear ? 'all year' : `${dayLabel(se.season.start)} to ${dayLabel(se.season.end)} (${se.season.days.length} days)`;
    const what = site.lawn.length ? 'the lawn' : 'the lot';
    const total = se.stats.bands.reduce((a, b) => a + b, 0) || 1;
    $('#season-summary').innerHTML = `
      <p><b>Growing season</b> for ${g.label.toLowerCase()} grass: <b>${when}</b>, ${how}.</p>
      <p><b>Light on ${what}</b> through it, on a typical day (mol/m²/day):</p>
      <table>
        <tr><th></th><th>${site.lawn.length ? 'Lawn' : 'Lot'}</th><th>Open ground</th></tr>
        <tr><td>Average</td><td><b>${L.mean.toFixed(1)}</b></td><td class="dim">${O.mean.toFixed(1)}</td></tr>
        <tr><td>Lowest</td><td><b>${L.min.toFixed(1)}</b> <span class="dim">${dayLabel(L.minDay)}</span></td><td class="dim">${O.min.toFixed(1)}</td></tr>
        <tr><td>Highest</td><td><b>${L.max.toFixed(1)}</b> <span class="dim">${dayLabel(L.maxDay)}</span></td><td class="dim">${O.max.toFixed(1)}</td></tr>
      </table>
      <p class="dim">On a dull day around the lowest point (the dullest 1 in 10), ${what} gets about ${se.stats.dullAtMin.toFixed(1)}.</p>
      <table>${BANDS[grass].map(([, , label], i) => `<tr><td>Season average ${label}</td><td>${Math.round(se.stats.bands[i] * SQFT).toLocaleString()} sq ft</td><td class="dim">${Math.round((100 * se.stats.bands[i]) / total)}%</td></tr>`).join('')}</table>
      <p class="dim">A rough guide: cool-season turf grows best at 20–30 mol/m²/day, slows at 10–15 and only survives below about 6 (ICL turf guidance); bermudagrass putting greens needed about 33 (Clemson). Species, mowing height and wear move these.</p>`;
    $('#season-chart').innerHTML = chart(se, c);
    hover();
  }

  /* The typical year: the lawn's light and open ground's, the season shaded. */
  function chart(se) {
    const W = 360, H = 170, l = 30, r = 8, t = 8, b = 22;
    const max = Math.max(10, ...se.open) * 1.08;
    const X = (k) => l + (k / 364) * (W - l - r), Y = (v) => t + (1 - v / max) * (H - t - b);
    const line = (arr) => Array.from(arr, (v, k) => `${k ? 'L' : 'M'}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const step = max > 50 ? 20 : 10;
    let grid = '';
    for (let v = 0; v <= max; v += step) grid += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#2c2c2c"/><text x="${l - 4}" y="${Y(v) + 3}" text-anchor="end" fill="#999" font-size="9">${v}</text>`;
    const starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const months = starts.map((k, i) => `<text x="${X(k + 15)}" y="${H - 8}" text-anchor="middle" fill="#999" font-size="9">${MONTHS[i][0]}</text>`).join('');
    /* The season as one block per run of days (two when it wraps New Year). */
    let band = '';
    const on = new Set(se.season.days);
    for (let k = 0; k < 365; k++) {
      if (!on.has(k) || on.has(k - 1)) continue;
      let e = k;
      while (e + 1 < 365 && on.has(e + 1)) e++;
      band += `<rect x="${X(k)}" y="${t}" width="${Math.max(1, X(e) - X(k))}" height="${H - t - b}" fill="#fff" fill-opacity=".07"/>`;
    }
    return `<div class="key"><span><i style="background:${LAWN}"></i>${site.lawn.length ? 'Lawn' : 'Lot'}</span><span><i style="background:${OPEN}"></i>Open ground</span><span><b class="band"></b>Growing season</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Typical daily light through the year on the ${site.lawn.length ? 'lawn' : 'lot'} and on open ground, mol per square meter per day">
        ${band}${grid}${months}
        <path d="${line(se.open)}" fill="none" stroke="${OPEN}" stroke-width="2" stroke-linejoin="round"/>
        <path d="${line(se.lawn)}" fill="none" stroke="${LAWN}" stroke-width="2" stroke-linejoin="round"/>
        <line class="xh" x1="0" x2="0" y1="${t}" y2="${H - b}" stroke="#bbb" stroke-width="1" visibility="hidden"/>
        <circle class="d1" r="4" fill="${LAWN}" stroke="#161616" stroke-width="2" visibility="hidden"/>
        <circle class="d2" r="4" fill="${OPEN}" stroke="#161616" stroke-width="2" visibility="hidden"/>
        <rect class="hit" x="${l}" y="${t}" width="${W - l - r}" height="${H - t - b}" fill="transparent"/>
      </svg><div class="tip" hidden></div>`;
  }

  function hover() {
    const box = $('#season-chart'), svg = box.querySelector('svg'), tip = box.querySelector('.tip');
    const se = st.season;
    if (!svg || !se) return;
    const W = 360, l = 30, r = 8, t = 8, H = 170, b = 22;
    const max = Math.max(10, ...se.open) * 1.08;
    const Y = (v) => t + (1 - v / max) * (H - t - b);
    const show = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const k = Math.min(364, Math.max(0, Math.round(((px - l) / (W - l - r)) * 364)));
      const x = l + (k / 364) * (W - l - r);
      svg.querySelector('.xh').setAttribute('x1', x); svg.querySelector('.xh').setAttribute('x2', x);
      svg.querySelector('.d1').setAttribute('cx', x); svg.querySelector('.d1').setAttribute('cy', Y(se.lawn[k]));
      svg.querySelector('.d2').setAttribute('cx', x); svg.querySelector('.d2').setAttribute('cy', Y(se.open[k]));
      for (const c of ['.xh', '.d1', '.d2']) svg.querySelector(c).setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `${dayLabel(k)}${se.season.days.includes(k) ? ' · in season' : ''}<br><span style="color:${LAWN}">●</span> ${site.lawn.length ? 'Lawn' : 'Lot'} ${se.lawn[k].toFixed(1)} · <span style="color:${OPEN}">●</span> Open ${se.open[k].toFixed(1)} mol/m²`;
      const left = ((x / W) * rect.width);
      tip.style.left = `${Math.min(Math.max(0, left - 80), rect.width - 170)}px`;
      tip.style.top = '-6px';
    };
    const hide = () => { tip.hidden = true; for (const c of ['.xh', '.d1', '.d2']) svg.querySelector(c).setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  function build() {
    if (st.worker) st.worker.terminate();
    st.built = false;
    st.season = null; st.day = null; st.now = null;
    st.worker = new Worker('/shade/light-worker.js', { type: 'module' });
    st.worker.onerror = (e) => { status(`The light calculation stopped: ${e.message || 'unknown error'}`); reportError('light worker', e.message || 'unknown error'); };
    st.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'error') { status(`The light calculation stopped: ${m.message}`); reportError('light worker', m.message); }
      else if (m.type === 'built') { st.readyWaiters.splice(0).forEach((f) => f()); st.canopy = m.canopy; status(''); st.built = true; st.kinds = m.kinds; st.lawnMask = m.lawnMask || null; $('#t-lawn').hidden = !st.lawnMask; canopyNote(m); if (st.mode === 'trees') draw(); runDay(); st.monthsId = send({ type: 'months', year: new Date(dayMs()).getUTCFullYear() }); runSeason(); }
      else if (m.type === 'day' && m.id === st.dayId) { st.day = m; status(''); summary(); if (st.mode !== 'now') draw(); }
      else if (m.type === 'now' && m.id === st.nowId) { st.now = m; if (st.mode === 'now') draw(); }
      else if (m.type === 'progress' && m.what === 'season') $('#season-status').textContent = `Tracing the sun through the year: ${m.done} of ${m.of} dates…`;
      else if (m.type === 'progress') status(`Working out the year: ${m.done} of ${m.of} months…`);
      else if (m.type === 'season' && m.id === st.seasonId) { st.season = m; seasonSummary(); if (st.mode === 'season') draw(); }
      else if (m.type === 'months' && m.id === st.monthsId) { months(m.rows); status(''); }
      else if (m.type === 'samples' && st.pending.has(m.id)) { st.pending.get(m.id)(m); st.pending.delete(m.id); }
    };
    status('Building the 3D canopy and the sky over every half meter…');
    const pick = ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls'];
    const c = { n: cols.n };
    for (const k of pick) c[k] = cols[k].slice(0, cols.n);
    send({
      type: 'build', cols: c, box, lat: site.lat, lng: site.lng, shift, heightM,
      canopy: $('#sun-canopy').value, flight: season || null, tMean: st.climate?.tMeanNow || st.climate?.tMean || null,
      /* A field-readings check (site.area: the whole track's box) draws the
         light over everything he treated -- neighbors' lots of a
         multi-property stop and the street -- not the one parcel. */
      lot: site.area ? [[[[site.area[0], site.area[1]], [site.area[2], site.area[1]], [site.area[2], site.area[3]], [site.area[0], site.area[3]], [site.area[0], site.area[1]]]]] : polysOf(site.parcel?.geometry),
      lawn: site.lawn.flatMap((f) => polysOf(f.geometry)),
    });
  }

  const setMode = (mode) => {
    st.mode = mode;
    for (const [id, m] of [['#m-hours', 'hours'], ['#m-dli', 'dli'], ['#m-now', 'now'], ['#m-season', 'season'], ['#m-trees', 'trees']]) $(id).setAttribute('aria-pressed', String(m === mode));
    $('#time-row').hidden = mode !== 'now';
    if (mode === 'now') runNow(); else draw();
  };
  $('#m-hours').onclick = () => setMode('hours');
  $('#m-dli').onclick = () => setMode('dli');
  $('#m-now').onclick = () => setMode('now');
  $('#m-season').onclick = () => setMode('season');
  $('#m-trees').onclick = () => setMode('trees');
  $('#grass').value = Math.abs(site.lat) >= 37 ? 'cool' : 'warm';
  $('#grass').onchange = () => runSeason();
  $('#gp').onchange = () => runSeason();
  $('#season-status').textContent = 'Fetching ten years of NASA weather…';
  $('#season-summary').innerHTML = ''; $('#season-chart').innerHTML = '';
  fetch(`/api/shade/climate?lng=${site.lng}&lat=${site.lat}`)
    .then((r) => r.json())
    .then((c) => {
      if (c.error) throw new Error(c.detail || c.error);
      st.climate = c;
      $('#season-status').textContent = 'Waiting for the 3D model…';
    })
    .catch((e) => { $('#season-status').textContent = `The NASA weather could not be read (${e.message}); the clear-sky figures above still stand, with the trees as the laser saw them.`; })
    /* The seasons need the typical temperatures (leaf-out, leaf-fall), so
       the model is built once they are in, or once they have failed. */
    .finally(() => build());
  $('#sun-time').oninput = () => runNow();
  $('#sun-date').onchange = () => runDay();
  for (const b of document.querySelectorAll('[data-preset]')) {
    b.onclick = () => {
      const [m, d] = b.dataset.preset.split('-').map(Number);
      $('#sun-date').value = `${new Date(dayMs()).getUTCFullYear()}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      runDay();
    };
  }
  $('#sun-canopy').value = 'seasonal';
  $('#sun-canopy').onchange = () => build();
  $('#sun-canopy-note').textContent = '';
  st.pending = new Map();
  st.readyWaiters = [];
  const ready = () => (st.built ? Promise.resolve() : new Promise((r) => st.readyWaiters.push(r)));
  return {
    /** The share of the direct beam at each { lng, lat, t } for a phone heightM up (the field readings). */
    async samples(points, heightM = 1) {
      await ready();
      const pts = new Float64Array(points.length * 3);
      points.forEach((p, i) => {
        const [mx, my] = toMerc([p.lng, p.lat]);
        pts[3 * i] = (mx - st.grid.x0) / st.grid.cell;
        pts[3 * i + 1] = (st.grid.y1 - my) / st.grid.cell;
        pts[3 * i + 2] = p.t;
      });
      /* How far inside the modelled box each point is, in meters (1 m
         cells): trees beyond the box are not in the model, so a point near
         its edge reads too much sun (truth-ui leaves those out). */
      const edgeM = Float32Array.from(points, (_, i) => Math.min(pts[3 * i], pts[3 * i + 1], st.grid.w - pts[3 * i], st.grid.h - pts[3 * i + 1]));
      return new Promise((resolve) => { const id = send({ type: 'samples', pts, heightM }); st.pending.set(id, (r) => resolve({ ...r, edgeM })); });
    },
    /** Show a given day (its date in local time). */
    showDay(ms) {
      const d = new Date(ms);
      $('#sun-date').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (st.built) runDay();
    },
    stop() {
      st.worker?.terminate();
      if (map.getLayer('light')) map.removeLayer('light');
      if (map.getSource('light')) map.removeSource('light');
      if (st.drape && map.getLayer(st.drape.id)) map.removeLayer(st.drape.id);
      map.off('pitchend', onPitch);
      setBoxing(false);
      clearReadouts();
      $('#t-lawn').hidden = true;
      for (const [ev, h] of [['click', onClick], ['mousedown', boxStart], ['touchstart', boxStart], ['mousemove', boxMove], ['touchmove', boxMove], ['mouseup', boxEnd], ['touchend', boxEnd]]) map.off(ev, h);
      sec.hidden = true;
    },
  };
}
