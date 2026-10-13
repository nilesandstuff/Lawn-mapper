/**
 * One visit's field readings on the shade map (/shade.html?truth=session|t0|t1,
 * admin only): the track drawn over the property, each reading colored by
 * whether the model and the phone agree on sun or shade at that spot and
 * minute, the score, and an eraser for stretches that do not count (tank
 * and hopper fills, parking, the truck). The judging is in truth.js.
 */

import { findTrucks, truckEffect, truckOutline } from './truck.js';
import { joinTrack, usable, sunOrShadeAround, sunOffFace, sunGain, compassOffset, operatorShadow, score } from './truth.js';

const $ = (s) => document.querySelector(s);
/** The phone on the hopper cover: about 50 inches up (owner, 2026-10-13). */
const PHONE_M = 1.27;
const MIN_EDGE_M = 25; // readings nearer the modelled box's edge miss the trees beyond it
/* Yellow, blue, red, cyan: every pair well apart in normal and color-blind
   vision (the old orange sat too close to the yellow; owner, 2026-10-13). */
const COLORS = { sunSun: '#ffe600', shadeShade: '#2f5bff', sunShade: '#ff1f3d', shadeSun: '#00e0ff', out: '#9e9e9e' };

async function getJson(url, init) {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function startTruth({ map, sun, spec, bounds = null }) {
  const [session, a, b, mo, mn, ms] = String(spec).split('|');
  /* The phone's angle on the hopper, fitted on the whole day (log.js). */
  const dayMount = mo !== undefined && mo !== '' ? { offset: Number(mo), n: Number(mn), spread: Number(ms), day: true } : null;
  const t0 = Number(a), t1 = Number(b);
  const box = $('#truth');
  box.hidden = false;
  const say = (html) => { $('#truth-summary').innerHTML = html; };
  let me = null;
  try { me = (await getJson('/api/auth/me')).user; } catch { /* signed out */ }
  if (!me?.admin) { say('<span class="bad">Field readings are for admins; sign in as one.</span>'); return null; }
  sun.showDay((t0 + t1) / 2);

  const st = { samples: [], keep: [], cuts: [], undo: [], erasing: false, trucks: [] };

  async function load() {
    say('Reading the visit…');
    const d = await getJson(`/api/shade/readings/data?session=${encodeURIComponent(session)}&t0=${t0}&t1=${t1}`);
    st.cuts = d.cuts;
    const u = usable(joinTrack(d.fix, d.lux, { cuts: d.cuts.map(([x, y]) => [x, y]), orient: d.orient || [] }));
    say(`Asking the model about ${u.length} readings…`);
    const m = await sun.samples(u.map((s) => ({ lng: s.lng, lat: s.lat, t: s.t })), PHONE_M);
    /* Which way the operator faces. The phone's heading is already absolute
       (Sensor Logger's Orientation on Android fuses the magnetometer: yaw
       from magnetic north), so what is fitted is only how the phone sits on
       the hopper: the angle between its top edge and the way the machine
       goes, from straight runs -- the whole day's (log.js), else this
       visit's. Without either, the GPS track (blind to a zero-turn's spin). */
    /* This visit's own fit first: he sets the phone down afresh at every
       stop, so its angle on the hopper changes from stop to stop. */
    const cal = compassOffset(u) || dayMount;
    const heading = (s) => (cal && s.face != null ? (s.face + cal.offset) % 360 : s.heading);
    /* The truck, from his routine at each stop (truck.js), on the whole
       visit before any erasing: readings beside it or in its shadow, with
       the sun where it was at each reading, are left out. */
    st.trucks = findTrucks(joinTrack(d.fix, d.lux, { orient: d.orient || [] }));
    const why = { off: 0, behind: 0, cloud: 0, edge: 0, truck: 0 };
    const keep = u.map((s, i) => {
      if (m.edgeM && !(m.edgeM[i] >= MIN_EDGE_M)) { why.edge++; return false; }
      if (truckEffect(s, st.trucks, { elevation: m.elevation[i], azimuth: m.azimuth[i] })) { why.truck++; return false; }
      if (operatorShadow(heading(s), m.azimuth[i])) { why.behind++; return false; }
      return true;
    });
    /* How squarely the face meets the sun (flat when no orientation was
       recorded), so each reading is judged at its own angle (truth.js). */
    const kept = u.map((s, i) => ({ ...s, gain: sunGain(sunOffFace(s.up, m.elevation[i], m.azimuth[i])) })).filter((_, i) => keep[i]);
    const so = sunOrShadeAround(kept);
    const sunMeasured = new Array(u.length).fill(false);
    let j = 0;
    u.forEach((_, i) => {
      if (!keep[i]) return;
      if (so.clear && !so.judged[j]) { keep[i] = false; if (so.faint[j]) why.off++; else why.cloud++; }
      sunMeasured[i] = so.sun[j++];
    });
    const sc = score(sunMeasured, Array.from(m.T), so.clear ? keep : keep.map(() => false));
    st.samples = u.map((s, i) => ({ ...s, T: m.T[i], keep: keep[i], sun: sunMeasured[i] }));
    draw();
    if (!st.fitted && u.length) {
      st.fitted = true;
      /* The track and the lot together, seen from straight above. */
      const lngs = [...u.map((s) => s.lng), ...(bounds ? [bounds[0], bounds[2]] : [])];
      const lats = [...u.map((s) => s.lat), ...(bounds ? [bounds[1], bounds[3]] : [])];
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 24, pitch: 0, bearing: 0, duration: 0 });
    }
    const pct = (x) => `${Math.round(100 * x)}%`;
    const head = !so.clear
      ? `<p class="warn">No clear sun on this visit: its light does not split into sun and shade (bright ${Math.round(so.sunLux || 0).toLocaleString()} lux, ${so.contrast ? so.contrast.toFixed(1) : '?'}× the dim). Cloudy, or no shade crossed. Not scored.</p>`
      : `<p><b>${pct(sc.agree)}</b> of ${sc.n} readings agree on sun or shade.</p>
         <table>
           <tr><td><i class="sw" style="background:${COLORS.sunSun}"></i>Both sun</td><td>${sc.sunSun}</td></tr>
           <tr><td><i class="sw" style="background:${COLORS.shadeShade}"></i>Both shade</td><td>${sc.shadeShade}</td></tr>
           <tr><td><i class="sw" style="background:${COLORS.sunShade}"></i>Model sun, phone shade (model too bright)</td><td>${sc.sunShade}</td></tr>
           <tr><td><i class="sw" style="background:${COLORS.shadeSun}"></i>Model shade, phone sun (model too dark)</td><td>${sc.shadeSun}</td></tr>
         </table>
         <p class="dim">Phone: sun about ${Math.round(so.sunLux).toLocaleString()} lux facing it squarely, shade about ${Math.round(so.shadeLux).toLocaleString()}; each reading judged at its own angle to the sun. Model: sun where at least half the direct beam reaches the phone (${PHONE_M} m up), with the trees as they stood that day.</p>`;
    const posed = u.filter((s) => s.up).length;
    const facing = cal ? `your direction from the phone's compass, its angle on the hopper (${Math.round(cal.offset)}°) taken from ${cal.n} straight-line readings ${cal.day ? 'across the day' : 'on this visit'}, steady to ${Math.round(cal.spread)}°` : posed ? 'your direction from GPS (too few straight runs to set the compass)' : 'your direction from GPS (no orientation recorded)';
    say(`${head}<p class="dim"><i class="sw" style="background:${COLORS.out}"></i>Left out: ${why.off} with the phone's face turned too far from the sun to tell sun from shade, ${why.behind} with the sun behind you (your shadow; ${facing}), ${why.truck} by your truck (within 10 ft of it or in its shadow; ${st.trucks.length ? `${st.trucks.length} truck spot${st.trucks.length === 1 ? '' : 's'} found from your routine, outlined` : 'no truck spot found'}), ${why.cloud} in a cloud (dim for over a minute), ${why.edge ? `${why.edge} near the edge of the mapped area, ` : ''}${st.cuts.length} erased stretch${st.cuts.length === 1 ? '' : 'es'}.${posed ? '' : ' No orientation in this recording: turn it on in Sensor Logger to leave out tipped readings.'}</p>`);
  }

  function draw() {
    const fc = {
      type: 'FeatureCollection',
      features: st.samples.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { c: !s.keep ? COLORS.out : s.T >= 0.5 ? (s.sun ? COLORS.sunSun : COLORS.sunShade) : (s.sun ? COLORS.shadeSun : COLORS.shadeShade) },
      })),
    };
    const trucks = { type: 'FeatureCollection', features: st.trucks.flatMap((tr) => truckOutline(tr).map((ring) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }))) };
    if (map.getSource('truth-truck')) map.getSource('truth-truck').setData(trucks);
    else {
      map.addSource('truth-truck', { type: 'geojson', data: trucks });
      map.addLayer({ id: 'truth-truck', type: 'line', source: 'truth-truck', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1] } });
    }
    if (map.getSource('truth')) map.getSource('truth').setData(fc);
    else {
      map.addSource('truth', { type: 'geojson', data: fc });
      map.addLayer({ id: 'truth', type: 'circle', source: 'truth', paint: { 'circle-radius': 4, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 } });
    }
  }

  /* The eraser: drag across the track; every reading the finger passes within
     ~20 px of is cut, as runs of consecutive readings (one cut each). */
  let screen = [], touched = new Set();
  const start = (e) => {
    if (!st.erasing) return;
    e.preventDefault?.();
    screen = st.samples.map((s) => map.project([s.lng, s.lat]));
    touched = new Set();
    mark(e.point);
  };
  const mark = (p) => { if (!p) return; screen.forEach((q, i) => { if (Math.hypot(q.x - p.x, q.y - p.y) < 20) touched.add(i); }); };
  const move = (e) => { if (st.erasing && screen.length) mark(e.point); };
  const end = async () => {
    if (!st.erasing || !screen.length) return;
    screen = [];
    const idx = [...touched].sort((x, y) => x - y);
    if (!idx.length) return;
    const runs = [];
    for (const i of idx) {
      const r = runs[runs.length - 1];
      if (r && i === r[1] + 1) r[1] = i; else runs.push([i, i]);
    }
    const made = [];
    for (const [i0, i1] of runs) {
      const ta = st.samples[i0].t - 500, tb = st.samples[i1].t + 500;
      const r = await getJson('/api/shade/readings/cuts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, t0: ta, t1: tb }) });
      if (r.id != null) made.push(r.id);
    }
    st.undo.push(made);
    $('#truth-undo').disabled = false;
    await load();
  };
  const setErasing = (on) => {
    st.erasing = on;
    $('#truth-erase').classList.toggle('on', on);
    $('#truth-erase').textContent = on ? 'Erasing: drag across the track (tap again to stop)' : 'Eraser';
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    map.getCanvas().dataset.erasing = on ? '1' : ''; // the shade view's pin waits (sun-ui.js)
    for (const h of [map.dragPan, map.touchZoomRotate, map.dragRotate]) on ? h.disable() : h.enable();
  };
  map.on('mousedown', start); map.on('touchstart', start);
  map.on('mousemove', move); map.on('touchmove', move);
  map.on('mouseup', end); map.on('touchend', end);
  $('#truth-erase').onclick = () => setErasing(!st.erasing);
  $('#truth-undo').disabled = true;
  $('#truth-undo').onclick = async () => {
    const ids = st.undo.pop() || [];
    for (const id of ids) await getJson('/api/shade/readings/cuts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: id }) });
    $('#truth-undo').disabled = !st.undo.length;
    await load();
  };
  await load().catch((e) => say(`<span class="bad">The readings could not be compared: ${e.message}</span>`));
  return { reload: load };
}
