/**
 * The "Sun and shade" section of /shade.html: drives light-worker.js and
 * paints its answers onto the map (shade map, step 2).
 *
 *   Hours of sun        per 0.5 m of lot, hours with at least half the
 *                       direct beam getting through, on the chosen day
 *   Light (DLI)         mol/m2 of photosynthetic light that day, clear sky
 *   Shadows at a time   the shade at one moment, to hold against the
 *                       shadows in the photo
 *
 * Plus the lawn's (or lot's) split into full sun / part shade / shade, and
 * a month-by-month table of clear-sky DLI against open ground.
 */

import { gridOver, gridBox } from './grid.js';
import { fromMerc } from './ept.js';
import { sunPath } from './sun.js';

const $ = (s) => document.querySelector(s);
const SQFT = 10.7639;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A dark-to-bright ramp (viridis's ends and middle), readable over a photo. */
const STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export function ramp(t) {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  return STOPS[i].map((v, j) => Math.round(v + (STOPS[i + 1][j] - v) * f));
}
const rampCss = `linear-gradient(90deg, ${STOPS.map((c) => `rgb(${c.join(',')})`).join(', ')})`;

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

export function startSun({ map, site, cols, box, shift, heightM, season, beforeLayer }) {
  const st = {
    worker: null, mode: 'hours', day: null, now: null, opaque: false, ids: 0, path: [],
    grid: gridOver(box, 1, site.lat),
  };
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

  function paint(values, xy, colour) {
    const W = st.grid.w * 2, H = st.grid.h * 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    for (let p = 0; p < values.length; p++) {
      const x = Math.floor(xy[2 * p] * 2), y = Math.floor(xy[2 * p + 1] * 2);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const rgba = colour(values[p]);
      if (!rgba) continue;
      img.data.set(rgba, (y * W + x) * 4);
    }
    g.putImageData(img, 0, 0);
    const url = c.toDataURL();
    if (map.getSource('light')) map.getSource('light').updateImage({ url, coordinates: corners() });
    else {
      map.addSource('light', { type: 'image', url, coordinates: corners() });
      map.addLayer({ id: 'light', type: 'raster', source: 'light', paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, beforeLayer());
    }
  }

  function legend(lo, hi, unit) {
    $('#sun-legend').innerHTML = `<span>${lo}</span><span class="ramp" style="background:${rampCss}"></span><span>${hi} ${unit}</span>`;
  }

  function draw() {
    if (st.mode === 'now' && st.now) {
      legend('lit', 'shade', '');
      $('#sun-legend').innerHTML = '<span class="dim">Dark = shade from the lidar at that moment</span>';
      paint(st.now.T, st.now.xy, (T) => [0, 0, 20, Math.round((1 - T) * 170)]);
    } else if (st.day) {
      const d = st.day;
      if (st.mode === 'dli') {
        legend(0, Math.round(d.openDli), 'mol/m²/day');
        paint(d.dli, d.xy, (v) => [...ramp(v / d.openDli), 200]);
      } else {
        legend(0, d.dayHours.toFixed(1), 'hours of sun');
        paint(d.sunHours, d.xy, (v) => [...ramp(v / d.dayHours), 200]);
      }
    }
  }

  function summary() {
    const d = st.day;
    if (!d) return;
    const what = site.lawn.length ? 'The lawn' : 'The lot (open ground)';
    const a = d.areaM2, tot = a.full + a.part + a.shade || 1;
    const row = (label, m2) => `<tr><td>${label}</td><td>${Math.round(m2 * SQFT).toLocaleString()} sq ft</td><td class="dim">${Math.round((100 * m2) / tot)}%</td></tr>`;
    $('#sun-summary').innerHTML = `
      <p><b>${what}</b> on ${new Date(dayMs()).toUTCString().slice(5, 11)}: on average <b>${d.meanSun.toFixed(1)} hours</b> of direct sun of ${d.dayHours.toFixed(1)} the day has
      (sunrise about ${aboutLocal(d.sunrise, site.lng)}, sunset about ${aboutLocal(d.sunset, site.lng)}), and <b>${d.meanDli.toFixed(0)} mol/m²</b> of light
      against ${d.openDli.toFixed(0)} on open ground here (${Math.round((100 * d.meanDli) / d.openDli)}%).</p>
      <table>${row('Full sun, 6 h or more', a.full)}${row('Part shade, 3 to 6 h', a.part)}${row('Shade, under 3 h', a.shade)}</table>`;
  }

  function months(rows) {
    $('#sun-months').innerHTML = `<h2>Through the year <span class="dim">clear-sky DLI on the 21st, mol/m²/day</span></h2>
      <table><tr><th>Month</th><th>${site.lawn.length ? 'Lawn' : 'Lot'}</th><th>Open ground</th><th>Share</th><th>Sun h</th></tr>
      ${rows.map((r) => `<tr><td>${MONTHS[r.month]}</td><td>${r.dli.toFixed(0)}</td><td class="dim">${r.openDli.toFixed(0)}</td><td>${Math.round((100 * r.dli) / r.openDli)}%</td><td class="dim">${r.sunHours.toFixed(1)} / ${r.dayHours.toFixed(1)}</td></tr>`).join('')}</table>`;
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

  function build() {
    if (st.worker) st.worker.terminate();
    st.worker = new Worker('/shade/light-worker.js', { type: 'module' });
    st.worker.onerror = (e) => status(`The light calculation stopped: ${e.message || 'unknown error'}`);
    st.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'error') status(`The light calculation stopped: ${m.message}`);
      else if (m.type === 'built') { status(''); runDay(); st.monthsId = send({ type: 'months', year: new Date(dayMs()).getUTCFullYear() }); }
      else if (m.type === 'day' && m.id === st.dayId) { st.day = m; status(''); summary(); if (st.mode !== 'now') draw(); }
      else if (m.type === 'now' && m.id === st.nowId) { st.now = m; if (st.mode === 'now') draw(); }
      else if (m.type === 'progress') status(`Working out the year: ${m.done} of ${m.of} months…`);
      else if (m.type === 'months' && m.id === st.monthsId) { months(m.rows); status(''); }
    };
    status('Building the 3D canopy and the sky over every half metre…');
    const pick = ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls'];
    const c = { n: cols.n };
    for (const k of pick) c[k] = cols[k].slice(0, cols.n);
    send({
      type: 'build', cols: c, box, lat: site.lat, lng: site.lng, shift, heightM, opaque: st.opaque,
      lot: polysOf(site.parcel?.geometry), lawn: site.lawn.flatMap((f) => polysOf(f.geometry)),
    });
  }

  const setMode = (mode) => {
    st.mode = mode;
    for (const [id, m] of [['#m-hours', 'hours'], ['#m-dli', 'dli'], ['#m-now', 'now']]) $(id).setAttribute('aria-pressed', String(m === mode));
    $('#time-row').hidden = mode !== 'now';
    if (mode === 'now') runNow(); else draw();
  };
  $('#m-hours').onclick = () => setMode('hours');
  $('#m-dli').onclick = () => setMode('dli');
  $('#m-now').onclick = () => setMode('now');
  $('#sun-time').oninput = () => runNow();
  $('#sun-date').onchange = () => runDay();
  for (const b of document.querySelectorAll('[data-preset]')) {
    b.onclick = () => {
      const [m, d] = b.dataset.preset.split('-').map(Number);
      $('#sun-date').value = `${new Date(dayMs()).getUTCFullYear()}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      runDay();
    };
  }
  $('#sun-opaque').onclick = () => {
    st.opaque = !st.opaque;
    $('#sun-opaque').setAttribute('aria-pressed', String(st.opaque));
    build();
  };
  $('#sun-note')?.remove();
  if (season === 'off' || season === 'mixed') {
    $('#sun-summary').insertAdjacentHTML('beforebegin', `<p class="warn" id="sun-note">This lidar was flown ${season === 'off' ? 'with the leaves off' : 'partly with the leaves off'}:
      broadleaf trees read as more see-through than they are in summer, so summer shade under them is
      understated. "Trees as solid" shows the other limit; the truth lies between.</p>`);
  }
  build();
  return {
    stop() {
      st.worker?.terminate();
      if (map.getLayer('light')) map.removeLayer('light');
      if (map.getSource('light')) map.removeSource('light');
      sec.hidden = true;
    },
  };
}
