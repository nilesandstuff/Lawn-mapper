/**
 * A split day on the page (route session, 2026-11-06): one card per person,
 * and every route on one map. Used by the planner (app.js) and by the page a
 * shared link opens (share.js), so both show the same thing.
 *
 * A plan is { at, shop: { label, lng, lat }, people: [person] } and a person
 *   { stops: [{ address, city, name, minutes, sqft, label, lng, lat }],
 *     legs: [{ duration, distance }]   stop 1 -> 2, ..., last stop -> shop
 *     geometry: [[lng, lat]] | null }
 * Each person starts at their first stop: getting there is not counted.
 */

import { formatMinutes } from './lib/parse.js';

export const COLORS = ['#1f7a4d', '#2f6fde', '#c2410c', '#7c3aed', '#a16207', '#0e7490', '#be185d', '#4d7c0f', '#475569', '#b91c1c'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const miles = (m) => `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
const mins = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const sqft = (n) => `${Math.round(n).toLocaleString()} sq ft`;

/** A person's job minutes, driving seconds, metres, and their whole day in minutes. */
export function totals(person) {
  const jobs = person.stops.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  const drive = person.legs.reduce((a, l) => a + (l.duration || 0), 0);
  const dist = person.legs.reduce((a, l) => a + (l.distance || 0), 0);
  const area = person.stops.reduce((a, s) => a + (Number(s.sqft) || 0), 0);
  return { jobs, drive, dist, area, total: jobs + Math.round(drive / 60) };
}

const nav = (label) => `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: label, travelmode: 'driving' })}`;

/** Google Maps trips for one person: from where they are, through their stops, to the shop; 10 stops a trip. */
export function trips(person, shop) {
  const seq = [null, ...person.stops.map((s) => s.label || `${s.address}, ${s.city}`), shop.label];
  const out = [];
  for (let a = 0; a < seq.length - 1; a += 10) {
    const b = Math.min(seq.length - 1, a + 10);
    const p = new URLSearchParams({ api: '1', destination: seq[b], travelmode: 'driving' });
    if (seq[a]) p.set('origin', seq[a]);
    const way = seq.slice(a + 1, b);
    if (way.length) p.set('waypoints', way.join('|'));
    out.push({ label: `${a === 0 ? 'Start' : `Stop ${a}`} → ${b === seq.length - 1 ? 'the shop' : `stop ${b}`}`, href: `https://www.google.com/maps/dir/?${p}` });
  }
  return out;
}

/** The short line for a person: "3 stops · 1h 05m jobs · 42 min driving · 1h 47m". */
export function summary(person) {
  const t = totals(person);
  return `${person.stops.length} stop${person.stops.length === 1 ? '' : 's'} · ${formatMinutes(t.jobs)} jobs · ${formatMinutes(Math.round(t.drive / 60))} driving · ${miles(t.dist)}`;
}

/**
 * One person's card. done: a Set of "k:i" for stops ticked off.
 * share: true to show a Share button (data-share="k").
 */
export function personCard(plan, k, { done = new Set(), share = false, open = true } = {}) {
  const person = plan.people[k];
  const t = totals(person);
  const name = person.name || `Person ${k + 1}`;
  const rows = person.stops.map((s, i) => {
    const leg = i === 0 ? null : person.legs[i - 1];
    return `<li class="${done.has(`${k}:${i}`) ? 'done' : ''}" data-tick="${k}:${i}">
      <span class="num" style="background:${COLORS[k % COLORS.length]}">${i + 1}</span>
      <div class="body">
        <div class="addr">${esc(s.address)}</div>
        <div class="meta">${esc([s.name, s.city].filter(Boolean).join(' · '))}</div>
        <div class="chips">${leg ? `<span>🚗 ${mins(leg.duration || 0)} · ${miles(leg.distance || 0)}</span>` : '<span>first stop</span>'}${s.minutes != null ? `<span>⏱ ${s.minutes}m job</span>` : ''}${s.sqft ? `<span>📐 ${sqft(s.sqft)}</span>` : ''}</div>
      </div>
      <a class="go" target="_blank" rel="noopener" href="${esc(nav(s.label || `${s.address}, ${s.city}`))}" aria-label="Directions to stop ${i + 1}">Go</a>
    </li>`;
  });
  const back = person.legs[person.stops.length - 1];
  if (person.stops.length) {
    rows.push(`<li class="home"><span class="num">⌂</span><div class="body"><div class="addr">Back to the shop</div>
      <div class="chips"><span>🚗 ${mins(back?.duration || 0)} · ${miles(back?.distance || 0)}</span></div></div>
      <a class="go" target="_blank" rel="noopener" href="${esc(nav(plan.shop.label))}" aria-label="Directions to the shop">Go</a></li>`);
  }
  return `<details class="card person" ${open ? 'open' : ''} data-person="${k}">
    <summary><h2><span class="dot" style="background:${COLORS[k % COLORS.length]}"></span>${esc(name)} <small>${formatMinutes(t.total)}</small></h2></summary>
    <p class="meta">${esc(summary(person))}${t.area ? ` · ${sqft(t.area)}` : ''}</p>
    ${person.stops.length ? `<ol class="legs">${rows.join('')}</ol>
    <div class="gm">${trips(person, plan.shop).map((x) => `<a class="btn small" target="_blank" rel="noopener" href="${esc(x.href)}">Google Maps: ${esc(x.label)}</a>`).join('')}</div>` : '<p class="meta">No stops.</p>'}
    ${share ? `<div class="row-btns"><button type="button" class="btn small" data-share="${k}">Share ${esc(name)}'s route</button></div>` : ''}
  </details>`;
}

/** Every person's route on a Leaflet map (only: one person's index, or null for all). Returns the map. */
export function drawPlan(L, el, plan, only = null, map = null) {
  if (!map) {
    map = L.map(el);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  } else map.eachLayer((l) => { if (!(l instanceof L.TileLayer)) map.removeLayer(l); });
  const all = [];
  plan.people.forEach((p, k) => {
    if (only != null && only !== k) return;
    if (!p.stops.length) return;
    const color = COLORS[k % COLORS.length];
    const line = p.geometry ? p.geometry.map(([lng, lat]) => [lat, lng]) : [...p.stops, plan.shop].map((s) => [s.lat, s.lng]);
    L.polyline(line, { color, weight: 5, opacity: 0.85 }).addTo(map);
    p.stops.forEach((s, i) => L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: 'pin2', html: `<span style="background:${color}">${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).addTo(map));
    all.push(...line);
  });
  L.marker([plan.shop.lat, plan.shop.lng], { icon: L.divIcon({ className: 'pin2 home', html: '<span>⌂</span>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
  all.push([plan.shop.lat, plan.shop.lng]);
  map.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
  return map;
}

/** Geometry thinned for sharing: points closer than ~12 m to the last kept one dropped, 5 decimals. */
export function thin(geometry) {
  if (!geometry) return null;
  const out = [];
  for (const [lng, lat] of geometry) {
    const p = out.at(-1);
    if (p && Math.hypot((lng - p[0]) * 73000, (lat - p[1]) * 111000) < 12) continue;
    out.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  }
  const last = geometry.at(-1);
  if (last && out.at(-1) !== last) out.push([Math.round(last[0] * 1e5) / 1e5, Math.round(last[1] * 1e5) / 1e5]);
  return out;
}
