/**
 * THE SHADE MAP AGAINST NEON'S GROUND LIGHT SENSORS (features session; owner
 * asked 2026-10-12). NEON's forest sites log photosynthetic light at the
 * soil surface under the canopy (DP1.00066.001, a 1 m line sensor, every 30
 * minutes, for years) and above it at the tower top (DP1.00024.001). Their
 * ratio over a clear day is the share of open-sky light that reached the
 * ground: what the shade map draws as a share of open-ground DLI.
 *
 *   NEON_TOKEN=... node tools/shade-check-neon.js SCBI,HARV,... 2023 > out.jsonl
 *
 * HOW: for each ground sensor, the page's own model at that spot (the same
 * 3DEP lidar, seasons and leaf calendar from the place's typical
 * temperatures, sky view), and for each CLEAR day of the year -- the tower's
 * own light at least 85% of its best for the time of year -- the page's
 * DLI share (dli / openDli, rays.js dayLight) against the measured one.
 * Nothing is tuned: this is the page as it stands, at points in real woods.
 * Forest, not lawns -- it tests how much light gets through a canopy, and
 * when the leaves come and go, which the owner's own lawn readings test
 * slowly.
 */

import { shadeSite } from './shade-site.js';
import { sunPath, solarNoon } from '../public/shade/sun.js';
import { dayLight, skyView, woodScale } from '../public/shade/rays.js';
import { leafCalendar, muWithLeaves } from '../public/shade/seasonal.js';
import { climateAt } from '../worker/src/shade.js';

const API = 'https://data.neonscience.org/api/v0';
const TOKEN = process.env.NEON_TOKEN || '';

async function get(u, as = 'json', tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, { headers: TOKEN ? { 'X-API-Token': TOKEN } : {} });
      if (!r.ok) throw new Error(`${r.status}`);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${e.message} ${u.slice(0, 140)}`);
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
    }
  }
}

function csv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.replace(/"/g, ''));
  return rows.map((line) => {
    const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

/** One month's files of a product at a site: [{ name, url }]. */
async function files(product, site, month) {
  const d = await get(`${API}/data/${product}/${site}/${month}?package=basic`);
  return d?.data?.files || [];
}

/** 30-minute means of a file: Map(startMs -> value) where the quality flag is clear. */
function halfHours(rows, field, qf = 'finalQF') {
  const m = new Map();
  for (const r of rows) {
    const v = Number(r[field]);
    if (r[qf] !== '0' || !Number.isFinite(v)) continue;
    m.set(Date.parse(r.startDateTime), v);
  }
  return m;
}

/** A local solar day key for a UTC time at a longitude. */
const dayKey = (ms, lng) => new Date(ms + (lng / 15) * 3600e3).toISOString().slice(0, 10);

export async function checkSite(site, year) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const below = new Map(), above = new Map();
  let positions = null;
  for (const month of months) {
    const fl = await files('DP1.00066.001', site, month).catch(() => []);
    if (!positions) {
      const p = fl.find((f) => /sensor_positions/.test(f.name));
      if (p) positions = csv(await get(p.url, 'text'));
    }
    for (const f of fl.filter((x) => /PARQL_30min/.test(x.name))) {
      const hor = f.name.split('.')[6];
      if (!below.has(hor)) below.set(hor, new Map());
      for (const [t, v] of halfHours(csv(await get(f.url, 'text')), 'linePARMean')) below.get(hor).set(t, v);
    }
    /* Above the canopy: the tower's highest PAR level. */
    const ft = (await files('DP1.00024.001', site, month).catch(() => [])).filter((x) => /PARPAR_30min/.test(x.name));
    const top = ft.sort((a, b) => Number(b.name.split('.')[7]) - Number(a.name.split('.')[7]))[0];
    if (top) for (const [t, v] of halfHours(csv(await get(top.url, 'text')), 'PARMean', 'PARFinalQF')) above.set(t, v);
  }
  if (!positions) return [{ site, year, skip: 'no sensor positions' }];
  const out = [];
  for (const [hor, series] of below) {
    const pos = positions.filter((p) => p['HOR.VER'].startsWith(hor)).pop();
    if (!pos) continue;
    const lat0 = Number(pos.locationReferenceLatitude), lng0 = Number(pos.locationReferenceLongitude);
    const lat = lat0 + Number(pos.northOffset) / 111320, lng = lng0 + Number(pos.eastOffset) / (111320 * Math.cos(lat0 * Math.PI / 180));
    try {
      out.push(...await checkSensor({ site, year, hor, lat, lng, along: Number(pos.xAzimuth) || 0, series, above }));
    } catch (e) {
      out.push({ site, year, hor, lat, lng, error: e.message });
    }
  }
  return out;
}

async function checkSensor({ site, year, hor, lat, lng, along, series, above }) {
  const s = await shadeSite(lng, lat, { halfM: 120 });
  if (!s) return [{ site, year, hor, lat, lng, skip: 'no lidar' }];
  const clim = await climateAt(lng, lat).catch(() => null);
  const flight = s.cloud.unit?.season;
  const leafOff = flight === 'off' || flight === 'mixed';
  const calendar = clim?.tMean ? leafCalendar(clim.tMean) : null;
  const seasonal = leafOff && calendar;
  /* The 1 m line sensor: five points along it. */
  const [gx, gy] = s.cellOf(lng, lat);
  const R = Math.PI / 180, xy = [];
  for (const d of [-0.4, -0.2, 0, 0.2, 0.4]) xy.push(gx + d * Math.sin(along * R), gy - d * Math.cos(along * R));
  const XY = Float32Array.from(xy);

  /* Daily sums of the clear half-hours both sensors have, in local solar days. */
  const days = new Map();
  for (const [t, b] of series) {
    const a = above.get(t);
    if (!(a > 20)) continue; // daylight
    const k = dayKey(t + 15 * 60e3, lng);
    const d = days.get(k) || { a: 0, b: 0, n: 0 };
    d.a += a; d.b += Math.max(0, b); d.n++;
    days.set(k, d);
  }
  /* Clear days: the tower's light at least 85% of the best within two weeks. */
  const list = [...days].filter(([, d]) => d.n >= 16).map(([k, d]) => ({ k, ms: Date.parse(k), ...d })).sort((x, y) => x.ms - y.ms);
  const rows = [];
  for (const d of list) {
    const near = list.filter((o) => Math.abs(o.ms - d.ms) <= 14 * 86400e3).map((o) => o.a);
    if (d.a < 0.85 * Math.max(...near)) continue;
    const doy = Math.floor((d.ms - Date.UTC(new Date(d.ms).getUTCFullYear(), 0, 1)) / 86400e3);
    /* SHADE_NOLEAVES: the trees as the laser flew them all year (what the added leaves do). */
    const f = process.env.SHADE_NOLEAVES ? 0 : seasonal ? calendar.share(Math.min(364, doy)) : 1;
    const mu = seasonal ? muWithLeaves(s.season, f) : s.model.mu;
    /* SHADE_WOODV: bare wood seen from the side (rays.js woodScale), on leaf-off days only. */
    const m = { ...s.model, mu, ...(process.env.SHADE_WOODV && f < 0.1 ? { muScale: woodScale(Number(process.env.SHADE_WOODV)) } : {}) };
    const path = sunPath(lat, lng, solarNoon(lng, d.ms + 12 * 3600e3), 10);
    const svf = skyView(m, XY);
    const L = dayLight(m, XY, path, { stepMin: 10, svf });
    const modelShare = L.dli.reduce((x, y) => x + y, 0) / L.dli.length / L.openDli;
    rows.push({ site, year, hor, lat: +lat.toFixed(6), lng: +lng.toFixed(6), day: d.k, leaves: +f.toFixed(2), measured: +(d.b / d.a).toFixed(4), model: +modelShare.toFixed(4), sky: +(svf.reduce((x, y) => x + y, 0) / svf.length).toFixed(3), flight, lidar: s.cloud.url.split('/').slice(-2)[0] });
  }
  return rows.length ? rows : [{ site, year, hor, skip: 'no clear days with both sensors' }];
}

/* -------------------------------------------------------------- run */

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!TOKEN) { console.error('NEON_TOKEN is needed (a free NEON account: data.neonscience.org).'); process.exit(1); }
  const sites = (process.argv[2] || 'SCBI').split(',');
  const year = Number(process.argv[3]) || 2023;
  for (const site of sites) {
    try {
      const rows = await checkSite(site, year);
      for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
      const ok = rows.filter((r) => r.measured != null);
      const by = (pred) => { const x = ok.filter(pred); return x.length ? `${x.length} days: measured ${(100 * avg(x.map((r) => r.measured))).toFixed(1)}%, model ${(100 * avg(x.map((r) => r.model))).toFixed(1)}%` : '-'; };
      process.stderr.write(`${site} ${year}: ${ok.length} sensor-days | leaf-off ${by((r) => r.leaves < 0.1)} | leaf-on ${by((r) => r.leaves > 0.9)} | between ${by((r) => r.leaves >= 0.1 && r.leaves <= 0.9)}${rows.filter((r) => r.skip || r.error).map((r) => ` [${r.hor || ''} ${r.skip || r.error}]`).join('')}\n`);
    } catch (e) {
      process.stderr.write(`${site}: ERROR ${e.message}\n`);
    }
  }
}
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
