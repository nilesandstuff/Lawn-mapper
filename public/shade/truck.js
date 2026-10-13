/**
 * THE OWNER'S TRUCK, FOUND FROM HIS ROUTINE (owner, 2026-10-13). Readings
 * beside the truck or in its shadow are the truck's, not the lawn's, and
 * erasing them by hand at every stop is tedious.
 *
 * His routine at a stop: out of the cab, ramps down at the back, up the
 * ramps onto the machine, and the phone set on the machine -- in the middle
 * of the truck's box -- before he drives down the ramps; at the end the
 * same in reverse. So every stretch with the phone lying flat (on the
 * machine) starts and ends at rest in the box, and the first move off it
 * goes straight out the back. Each end of such a stretch gives an anchor:
 * where the box is (the phone at rest) and which way its back faces (the
 * first few meters moved). Anchors within a few meters are one truck.
 *
 * The truck as he describes it: a box truck, about 10 feet tall and 15 feet
 * long (taken as the box, with the phone at its middle); a cab ahead of it is
 * assumed, 8 feet long and 8 tall; 8 feet wide. Readings within 10 feet of
 * it, or whose line to the sun passes through it, are left out.
 */

import { metersBetween, bearingBetween } from './truth.js';

const FT = 0.3048;
export const TRUCK = {
  boxLong: 15 * FT, boxHigh: 10 * FT, wide: 8 * FT,
  cabLong: 8 * FT, cabHigh: 8 * FT,
  nearM: 10 * FT, // readings this close to it are left out
  shadowMarginM: 1, // the anchor's GPS error, for the shadow
};

const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const flatOf = (s, cosMax) => s.up && s.up[2] >= cosMax;

/** Circular mean of bearings in degrees. */
function meanBearing(list) {
  let x = 0, y = 0;
  for (const b of list) { x += Math.cos((b * Math.PI) / 180); y += Math.sin((b * Math.PI) / 180); }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * The stretches with the phone lying flat (within `tiltDeg`), breaks under
 * `bridgeS` seconds bridged (the hopper bounces), each at least `minS`
 * seconds long and going somewhere (`minRangeM`): the machine at work.
 */
export function flatStretches(track, { tiltDeg = 25, bridgeS = 10, minS = 60, minRangeM = 15 } = {}) {
  const cosMax = Math.cos((tiltDeg * Math.PI) / 180);
  const out = [];
  let cur = null, lastFlat = -Infinity;
  for (let i = 0; i < track.length; i++) {
    const s = track[i];
    if (!flatOf(s, cosMax)) continue;
    if (cur && s.t - lastFlat <= bridgeS * 1000) cur.b = i;
    else { if (cur) out.push(cur); cur = { a: i, b: i }; }
    lastFlat = s.t;
  }
  if (cur) out.push(cur);
  return out.filter(({ a, b }) => {
    if (track[b].t - track[a].t < minS * 1000) return false;
    const p0 = [track[a].lat, track[a].lng];
    return track.slice(a, b + 1).some((s) => metersBetween(p0, [s.lat, s.lng]) > minRangeM);
  }).map(({ a, b }) => track.slice(a, b + 1).filter((s) => flatOf(s, cosMax)));
}

/**
 * One end of a flat stretch (the samples in order from that end): where the
 * phone rested before the first move (the box), and the bearing out of it
 * over the first `outM` meters (the back of the truck). Null when it never
 * rested (`minRestS`) -- the phone was set down somewhere else.
 */
export function anchorOf(samples, { leaveM = 6, outM = 6, minRestS = 4, maxRestS = 60 } = {}) {
  if (samples.length < 3) return null;
  const head = samples.slice(0, 5);
  const p0 = [med(head.map((s) => s.lat)), med(head.map((s) => s.lng))];
  let k = samples.findIndex((s) => metersBetween(p0, [s.lat, s.lng]) > leaveM);
  if (k < 0) return null;
  const rest = samples.slice(0, k).filter((s) => Math.abs(s.t - samples[0].t) <= maxRestS * 1000);
  if (rest.length < 2 || Math.abs(rest[rest.length - 1].t - rest[0].t) < minRestS * 1000) return null;
  const at = [med(rest.map((s) => s.lat)), med(rest.map((s) => s.lng))];
  const out = samples.slice(k).find((s) => metersBetween(at, [s.lat, s.lng]) >= outM) || samples[k];
  return { lat: at[0], lng: at[1], rear: bearingBetween(at, [out.lat, out.lng]), t: rest[0].t, n: rest.length };
}

/**
 * The trucks over a track: [{ lat, lng, rear (degrees: the way out of its
 * back), t0, t1 (when it stood there), anchors }]. Anchors within `joinM`
 * meters are one truck; a truck stands from the first stretch it starts to
 * the last it ends (plus `padS` seconds either side).
 */
export function findTrucks(track, { joinM = 8, padS = 300, ...opts } = {}) {
  const anchors = [];
  for (const st of flatStretches(track, opts)) {
    const t0 = st[0].t, t1 = st[st.length - 1].t;
    const a = anchorOf(st, opts), b = anchorOf([...st].reverse(), opts);
    if (a) anchors.push({ ...a, from: a.t, to: t1 });
    if (b) anchors.push({ ...b, from: t0, to: b.t });
  }
  const trucks = [];
  for (const an of anchors) {
    const near = trucks.find((tr) => metersBetween([tr.lat, tr.lng], [an.lat, an.lng]) <= joinM);
    if (near) {
      near.anchors.push(an);
      near.lat = near.anchors.reduce((s, x) => s + x.lat, 0) / near.anchors.length;
      near.lng = near.anchors.reduce((s, x) => s + x.lng, 0) / near.anchors.length;
      near.rear = meanBearing(near.anchors.map((x) => x.rear));
      near.t0 = Math.min(near.t0, an.from - padS * 1000);
      near.t1 = Math.max(near.t1, an.to + padS * 1000);
    } else {
      trucks.push({ lat: an.lat, lng: an.lng, rear: an.rear, t0: an.from - padS * 1000, t1: an.to + padS * 1000, anchors: [an] });
    }
  }
  return trucks;
}

/* Meters east and north of (lat0, lng0). */
function local(lat0, lng0, lat, lng) {
  const k = Math.PI / 180;
  return [(lng - lng0) * k * 6371008.8 * Math.cos(lat0 * k), (lat - lat0) * k * 6371008.8];
}

/** The truck's blocks in its own frame (u toward the front, v to the side): [u0, u1, v0, v1, height]. */
function blocks(t = TRUCK) {
  const L = t.boxLong / 2, W = t.wide / 2;
  return [[-L, L, -W, W, t.boxHigh], [L, L + t.cabLong, -W, W, t.cabHigh]];
}

/**
 * Is a reading the truck's? 'near' (within nearM of it), 'shadow' (its line
 * to the sun, from the phone's height, passes through the truck), or null.
 * `sun` is { elevation, azimuth } in degrees for that reading's time and
 * place.
 */
export function truckEffect(s, trucks, sun, { phoneM = 1.27, truck = TRUCK } = {}) {
  const R = Math.PI / 180;
  for (const tr of trucks) {
    if (s.t < tr.t0 || s.t > tr.t1) continue;
    const [e, n] = local(tr.lat, tr.lng, s.lat, s.lng);
    const f = (tr.rear + 180) * R; // the front
    const fu = [Math.sin(f), Math.cos(f)], fv = [Math.cos(f), -Math.sin(f)];
    const u = e * fu[0] + n * fu[1], v = e * fv[0] + n * fv[1];
    const bl = blocks(truck);
    const dist = Math.min(...bl.map(([u0, u1, v0, v1]) => Math.hypot(Math.max(u0 - u, 0, u - u1), Math.max(v0 - v, 0, v - v1))));
    if (dist <= truck.nearM) return 'near';
    if (!sun || sun.elevation <= 0) continue;
    const tanE = Math.tan(sun.elevation * R), a = sun.azimuth * R;
    const du = Math.sin(a) * fu[0] + Math.cos(a) * fu[1], dv = Math.sin(a) * fv[0] + Math.cos(a) * fv[1];
    const m = truck.shadowMarginM;
    for (const [u0, u1, v0, v1, hgt] of bl) {
      const reach = (hgt - phoneM) / tanE;
      for (let d = 0; d <= reach; d += 0.25) {
        const pu = u + du * d, pv = v + dv * d;
        if (pu >= u0 - m && pu <= u1 + m && pv >= v0 - m && pv <= v1 + m) return 'shadow';
      }
    }
  }
  return null;
}

/** The truck's outline (box and cab) as [lng, lat] rings, for drawing. */
export function truckOutline(tr, truck = TRUCK) {
  const k = Math.PI / 180, f = (tr.rear + 180) * k;
  const fu = [Math.sin(f), Math.cos(f)], fv = [Math.cos(f), -Math.sin(f)];
  const toLL = (u, v) => {
    const e = u * fu[0] + v * fv[0], n = u * fu[1] + v * fv[1];
    return [tr.lng + e / (6371008.8 * k * Math.cos(tr.lat * k)), tr.lat + n / (6371008.8 * k)];
  };
  return blocks(truck).map(([u0, u1, v0, v1]) => [toLL(u0, v0), toLL(u1, v0), toLL(u1, v1), toLL(u0, v1), toLL(u0, v0)]);
}
