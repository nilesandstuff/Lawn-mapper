/**
 * OVERCAST READINGS (owner, 2026-10-14: "overcast days still count for
 * something... there's still light"). Under a sky with no sun every lux the
 * phone reads came from the sky at large, so the readings test the half of
 * the light budget sunny days cannot: the SKY VIEW (rays.js skyView, the
 * diffuse half of climate.js dliOn) -- how much of the sky the crowns
 * hide, at every angle at once, with no shadow edge for the GPS to miss.
 *
 *   node tools/shade-overcast.js <Sensor Logger export folder or .zip>
 *
 * Prints counts and fits only, never a place (the export is a track over a
 * customer's lawn). For each reading while moving, with the phone near flat:
 *
 *   SKY VIEW. The model's sky view at the phone (1 m up) under four
 *   weightings of the sky -- the map's (an even sky on a level surface), the
 *   CIE overcast sky (three times brighter overhead than at the horizon),
 *   that sky through the phone's own cos^2.5 sensor (SHADE-FINDINGS 8), and
 *   only the top 30 degrees -- and through the cos^2.5 sensor at leaf shares
 *   from bare to full. The sky's own brightness drifts minute to minute, so
 *   each reading is set against its neighbours within 45 s: the fit is how
 *   well the model's sky view explains the light's rises and falls along
 *   the track (corr), and how far it is off (median miss, as a factor).
 *
 *   BAROMETER (when the export has one). Its relative altitude against the
 *   lidar ground under each GPS fix, with a straight-line drift for the
 *   weather; then the same with the track shifted up to 6 m each way, to
 *   see whether the GPS sits where the ground says it does.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fromExport, posePerSecond, joinTrack, usable, parseCsv, msOf, unzipText } from '../public/shade/truth.js';
import { shadeSite } from './shade-site.js';
import { transmittance, groundAt, cellMetres } from '../public/shade/rays.js';
import { muWithLeaves, leafCalendar } from '../public/shade/seasonal.js';
import { climateAt } from '../worker/src/shade.js';

export const PHONE_H = 1.0; // the phone on the hopper, meters over the grass
export const WINDOW_S = 45;
export const MIN_LUX = 300; // under this the phone is in a pocket or the truck
export const MIN_SPEED = 0.5;
export const SHARES = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1];

/** Sky directions (12 bands x 24) with the weightings compared. */
export function skyWeights() {
  const dirs = [];
  for (let b = 0; b < 12; b++) {
    const el = ((b + 0.5) / 12) * (Math.PI / 2);
    for (let a = 0; a < 24; a++) {
      const az = ((a + 0.5) / 24) * 2 * Math.PI;
      dirs.push({ dir: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)], el });
    }
  }
  const s = (x) => Math.sin(x.el), dOm = (x) => Math.cos(x.el), cie = (x) => (1 + 2 * s(x)) / 3;
  const W = {
    map: (x) => dOm(x) * s(x),
    cie: (x) => dOm(x) * s(x) * cie(x),
    phone: (x) => dOm(x) * s(x) ** 2.5 * cie(x),
    top30: (x) => (x.el > Math.PI / 3 ? dOm(x) * s(x) : 0),
  };
  const sets = {};
  for (const [k, f] of Object.entries(W)) {
    const w = dirs.map(f), t = w.reduce((a, v) => a + v, 0);
    sets[k] = dirs.map((d, i) => ({ dir: d.dir, w: w[i] / t })).filter((d) => d.w > 0);
  }
  return sets;
}

/** The share of the weighted sky reaching (gx, gy) `heightM` over the ground. */
export function skyAt(model, gx, gy, set, heightM = PHONE_H) {
  const z = groundAt(model, gx, gy) + heightM, cm = cellMetres(model);
  let s = 0;
  for (const d of set) s += d.w * transmittance(model, gx, gy, z, d.dir, { cm });
  return s;
}

const median = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
function corr(A, B) {
  const n = A.length, ma = A.reduce((s, x) => s + x, 0) / n, mb = B.reduce((s, x) => s + x, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += (A[i] - ma) * (B[i] - mb); aa += (A[i] - ma) ** 2; bb += (B[i] - mb) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : NaN;
}

/**
 * How well a sky view `sv` per reading explains the light: each reading's
 * log lux and log sky view less their medians over the neighbours within
 * `windowS` (the sky's drift out), correlated; and the median miss of lux
 * against sky view x the neighbours' median lux per sky view, as a factor.
 */
export function skyFit(rows, sv, windowS = WINDOW_S) {
  const L = rows.map((r) => Math.log(Math.max(1, r.lux))), S = sv.map((v) => Math.log(Math.max(0.02, v)));
  const dl = [], ds = [], miss = [];
  rows.forEach((r, i) => {
    const nl = [], ns = [], nr = [];
    rows.forEach((q, j) => { if (j !== i && Math.abs(q.t - r.t) <= windowS * 1000) { nl.push(L[j]); ns.push(S[j]); nr.push(L[j] - S[j]); } });
    if (nr.length < 8) return;
    dl.push(L[i] - median(nl)); ds.push(S[i] - median(ns)); miss.push(Math.abs(L[i] - S[i] - median(nr)));
  });
  return { n: dl.length, corr: corr(dl, ds), miss: Math.exp(median(miss)) };
}

/** Barometer altitude against the ground under the fixes: y - g = c + drift x minutes. */
export function baroFit(pts) {
  const X = pts.map((p) => (p.t - pts[0].t) / 60000), Y = pts.map((p) => p.baro - p.g);
  const n = X.length, mx = X.reduce((a, v) => a + v, 0) / n, my = Y.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0;
  X.forEach((v, i) => { sxy += (v - mx) * (Y[i] - my); sxx += (v - mx) ** 2; });
  const drift = sxx ? sxy / sxx : 0, c = my - drift * mx;
  const res = Y.map((y, i) => y - c - drift * X[i]);
  return { n, drift, sd: Math.sqrt(res.reduce((a, v) => a + v * v, 0) / n), corr: corr(pts.map((p, i) => p.baro - drift * X[i]), pts.map((p) => p.g)) };
}

async function readExport(path) {
  if (statSync(path).isDirectory()) return Object.fromEntries(readdirSync(path).filter((f) => f.endsWith('.csv')).map((f) => [f, readFileSync(join(path, f), 'utf8')]));
  return unzipText(readFileSync(path));
}

export async function overcast(path) {
  const files = await readExport(path);
  const pick = (re) => Object.entries(files).find(([k]) => re.test(k))?.[1] || '';
  const d = fromExport({ 'Light.csv': pick(/light/i), 'Location.csv': pick(/location/i), 'Orientation.csv': pick(/orientation/i) });
  const track = joinTrack(d.fix, d.lux, { orient: posePerSecond(d.orient) });
  const u = usable(track, { stepM: 0, maxAcc: 8, maxTiltDeg: 15 });
  const out = [`${track.length} seconds with a fix and light; ${u.length} with the phone within 15 degrees of flat and the fix good to 8 m.`];
  if (u.length < 20) return out;
  const lat = u.reduce((a, r) => a + r.lat, 0) / u.length, lng = u.reduce((a, r) => a + r.lng, 0) / u.length;
  const site = await shadeSite(lng, lat, { halfM: 140 });
  if (!site) return [...out, 'No lidar here.'];
  const climate = await climateAt(lng, lat).catch(() => null);
  const t0 = new Date(u[0].t), doy = Math.floor((u[0].t - Date.UTC(t0.getUTCFullYear(), 0, 0)) / 864e5);
  const flight = site.cloud.unit?.season;
  const leaf = climate?.tMean && (flight === 'off' || flight === 'mixed') ? leafCalendar(climate.tMean).share(doy) : 1;
  const sets = skyWeights();
  const atShare = (f) => ({ ...site.model, mu: muWithLeaves(site.season, f) });
  const cal = atShare(leaf);
  const rows = u.map((r) => { const [gx, gy] = site.cellOf(r.lng, r.lat); return { ...r, gx, gy, g: groundAt(cal, gx, gy) }; });
  const moving = rows.filter((r) => r.lux >= MIN_LUX && (r.speed ?? 0) >= MIN_SPEED);
  out.push(`Lidar ${flight || '?'} flight; the calendar's leaves ${Math.round(100 * leaf)}% on. ${moving.length} readings while moving (${MIN_LUX}+ lux), light ${Math.round(median(moving.map((r) => r.lux)))} lux at the median.`);
  if (moving.length >= 20) {
    out.push('\nSKY VIEW against the light (detrended over 45 s; corr 1 = the model explains every rise and fall):');
    const line = (name, sv) => { const f = skyFit(moving, sv); out.push(`  ${name.padEnd(34)} corr ${f.corr.toFixed(2)}, median miss x${f.miss.toFixed(2)}, sky view median ${median(sv).toFixed(2)}`); };
    line('none (the light is the sky alone)', moving.map(() => 1));
    for (const k of ['map', 'cie', 'phone', 'top30']) line(`${k}, the calendar's leaves`, moving.map((r) => skyAt(cal, r.gx, r.gy, sets[k])));
    for (const f of SHARES) { const m = atShare(f); line(`phone, leaves ${Math.round(100 * f)}% on`, moving.map((r) => skyAt(m, r.gx, r.gy, sets.phone))); }
  }
  const baroText = pick(/barometer/i);
  if (baroText) {
    const b = parseCsv(baroText).map((r) => [msOf(r.time), Number(r.relativeAltitude)]).filter((x) => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    let j = 0;
    const at = (t) => { while (j > 0 && b[j][0] > t - 500) j--; while (j < b.length && b[j][0] < t - 500) j++; const v = []; for (let k = j; k < b.length && b[k][0] <= t + 500; k++) v.push(b[k][1]); return median(v); };
    const pts = moving.map((r) => ({ t: r.t, gx: r.gx, gy: r.gy, g: r.g, baro: at(r.t) })).filter((p) => Number.isFinite(p.baro));
    if (pts.length >= 20) {
      const f = baroFit(pts), gs = pts.map((p) => p.g);
      out.push(`\nBAROMETER: ${pts.length} readings over ${((pts.at(-1).t - pts[0].t) / 60000).toFixed(1)} min; the lidar ground under them spans ${(Math.max(...gs) - Math.min(...gs)).toFixed(1)} m.`);
      out.push(`  against the ground: off by ${f.sd.toFixed(2)} m (SD), corr ${f.corr.toFixed(2)}, weather drift ${f.drift.toFixed(2)} m/min`);
      const cm = cellMetres(cal);
      let best = null;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
        const s = baroFit(pts.map((p) => ({ ...p, g: groundAt(cal, p.gx + dx / cm, p.gy - dy / cm) }))).sd;
        if (!best || s < best.s) best = { dx, dy, s };
      }
      out.push(`  the track shifted to fit the ground best: ${best.dx} m east, ${best.dy} m north (off by ${best.s.toFixed(2)} m)`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) { console.error('usage: node tools/shade-overcast.js <export folder or .zip>'); process.exit(2); }
  console.log((await overcast(path)).join('\n'));
}
