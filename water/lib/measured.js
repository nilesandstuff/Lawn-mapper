/**
 * THE PRESSURE AT THE HEADS, MEASURED (owner, 2026-10-22: "build out 2 alternative modes for getting pressure at
 * the heads: measuring dynamic pressure at the heads; measuring throw distance, with optional GPS measurement.
 * Both methods still require placing the heads and marking their models ... But skip as much other info as
 * possible (especially stuff that's buried or in valve boxes), with as few measurements as possible").
 *
 * One reading a zone is enough; more help. A reading gives the pressure coming into that head (its inlet, before
 * any regulator in its body), and every other head of the zone is given the readings' pressure moved by the
 * height between them (0.433 psi a foot, the ground's height from the USGS lidar) -- with more than one reading,
 * weighted toward the nearest (inverse square of distance). What this leaves out is the pipe's friction between
 * heads, which is what the pipes and valves would have told; on a zone sized as installers size them it is a few
 * psi from first head to last (lib/hydraulics.js), so the reading is best taken at a head midway along the zone.
 *
 *   gauge   a pitot tube in the stream reads the nozzle's own pressure (after any regulator); a gauge screwed on
 *           in place of the nozzle, or a head with a gauge port, reads its inlet (the riser)
 *   throw   how far the water reaches, by tape or GPS, read back through the nozzle's chart to the pressure that
 *           throws that far -- with its radius screw left open (a head screwed down throws short and reads low)
 *
 * Pure.
 */

import { headFlow, regulatedOut } from './hydraulics.js';

export const PSI_PER_FT = 0.433, FT_PER_M = 3.28084;

/** A head's inlet pressure from a gauge. reading { psi, method: 'pitot' | 'riser' }. -> { psi, atLeast } or null */
export function inletFromGauge(head, reading, cat) {
  if (!reading || !Number.isFinite(reading.psi)) return null;
  if (reading.method !== 'pitot') return { psi: reading.psi, atLeast: false };
  const body = cat.body(head?.body), fam = cat.familyOfNozzle(head?.nozzle), reg = body?.regulatedPsi;
  // a pitot reads after the regulator: under its setting, the inlet is the reading plus what it needs to work;
  // at its setting, the inlet is at least that (the regulator hides the rest)
  if (!Number.isFinite(reg) || fam?.pressureIs === 'inlet') return { psi: reading.psi, atLeast: false };
  const need = reg - regulatedOut(body, reg);
  return reading.psi < reg - 0.5 ? { psi: reading.psi + need, atLeast: false } : { psi: reg + need, atLeast: true };
}

/**
 * The inlet pressure that throws `ft` feet, from the head's chart (its radius screw open). -> { psi, edge:
 * 'under' | 'over' | null (the throw is beyond the chart's range: its end is used) } or null
 */
export function inletFromThrow(head, ft, cat) {
  if (!(ft > 0)) return null;
  const open = { ...head, throw: 1 };
  const r = (psi) => headFlow(open, cat, psi)?.radiusFt;
  // the chart's own range: below its lowest row it gives that row's throw, so the search starts there
  const rows = (cat.nozzle(head?.nozzle)?.rows || []).map((x) => x.psi).filter(Number.isFinite);
  let lo = rows.length ? Math.min(...rows) : 5, hi = 150;
  const rlo = r(lo), rhi = r(hi);
  if (!Number.isFinite(rlo) || !Number.isFinite(rhi)) return null;
  if (ft < rlo - 0.05) return { psi: lo, edge: 'under' };
  if (ft >= rhi) {
    // a regulated head throws no further past its setting: the inlet is at least what it took to reach it
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (r(m) >= rhi - 1e-6) hi = m; else lo = m; }
    return { psi: hi, edge: 'over' };
  }
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (r(m) < ft) lo = m; else hi = m; }
  return { psi: (lo + hi) / 2, edge: null };
}

/**
 * Every head's inlet pressure from the readings. heads [{ id, at }]; readings [{ id, at, psi }]; elevM(at) ->
 * ground metres or null; dist(a, b) -> metres. -> Map id -> { psi, measured }
 */
export function spreadReadings(heads, readings, elevM, dist) {
  const out = new Map();
  if (!readings.length) return out;
  const zOf = (at) => { const z = elevM ? elevM(at) : null; return Number.isFinite(z) ? z * FT_PER_M : null; };
  const rz = readings.map((r) => zOf(r.at));
  for (const h of heads) {
    const own = readings.find((r) => r.id === h.id);
    if (own) { out.set(h.id, { psi: own.psi, measured: true }); continue; }
    const hz = zOf(h.at);
    let W = 0, P = 0;
    readings.forEach((r, k) => {
      const d = Math.max(1, dist(h.at, r.at)), w = 1 / (d * d);
      const lift = hz !== null && rz[k] !== null ? PSI_PER_FT * (rz[k] - hz) : 0; // downhill gains, uphill loses
      W += w; P += w * (r.psi + lift);
    });
    out.set(h.id, { psi: P / W, measured: false });
  }
  return out;
}
