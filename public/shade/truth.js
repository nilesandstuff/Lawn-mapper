/**
 * GROUND TRUTH FOR THE SHADE MAP: the owner's light readings from the field
 * (owner, 2026-10-12). His phone (a Galaxy S21 Ultra) rides flat, screen up,
 * on the front of his spreader-sprayer, with Sensor Logger recording its light
 * sensor and GPS all day, screen off. Tested: about 98,000 lux facing the sun
 * (it does not saturate), 40,000 flat in October sun, 4,800 with the sun
 * blocked by a hand. These are the pure parts, run by the tests; the pages
 * are shade/log.js and shade/truth-ui.js.
 *
 * WHAT IS COMPARED. Not lux: a phone's sensor reads light from the side
 * poorly, sits under the screen, and here rides in a bag that collects
 * fertilizer dust. All of that dims sun and shade alike within one visit, so
 * each reading is judged against the same visit's own sunlit readings: its
 * light splits into a bright group (sun) and a dim one (shade), cut where
 * the two separate best (Otsu, in log lux). The model is then asked, for
 * that spot and that minute, how much of the direct beam got through.
 *
 * WHAT IS LEFT OUT: readings faster than the sprayer goes (the truck), with
 * a poor GPS fix, cut by the owner (the eraser: tank and hopper fills,
 * parking), with the phone tipped more than 20 degrees (in the truck's mount,
 * in a pocket, in a hand), with the sun more than 65 degrees off the phone's
 * face, with no sunlit reading within two minutes (a cloud), and with the
 * sun behind the operator (his own shadow falls on the phone). Stops count
 * once: one reading per meter moved.
 *
 * MEASURED ON HIS FIRST LOG (2026-10-12, three stops, 52 minutes):
 *   - The sensor sees the sun through a narrow cone: flat, with the sun 60
 *     degrees off its face, it read 10,000 lux in sun; tipped to 38 degrees
 *     it read 50,000 a second later. Past ~65 degrees sun and shade blur.
 *   - The light and orientation sensors stopped about a minute after the
 *     screen went off and came back for a minute at a time; GPS ran on.
 *     That is the phone's battery management, fixed in its settings
 *     (shade-log.html says how); here a gap only means fewer readings.
 *   - The phone's heading is absolute already (Sensor Logger's Orientation
 *     on Android fuses the magnetometer; yaw is from magnetic north). Taped
 *     to the hopper it read a steady ~110 degrees off the direction of
 *     travel: that is how the phone sat, not compass error. A zero-turn
 *     spins in place where GPS sees no turn, so the operator-shadow check
 *     uses the heading turned by that mounting angle, fitted once a day from
 *     the straight runs (compassOffset), the phone staying taped all day.
 */

/* ------------------------------------------------------------ reading */

/** Sensor Logger's names for a light reading and its value. */
const isLight = (name) => /light|lux|illum/i.test(String(name || ''));
const luxOf = (v) => {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  for (const k of ['lux', 'illuminance', 'light', 'brightness', 'value']) if (Number.isFinite(Number(v[k]))) return Number(v[k]);
  const n = Object.values(v).map(Number).find(Number.isFinite);
  return n === undefined ? NaN : n;
};
/** Sensor Logger times are UTC epoch nanoseconds (as numbers or strings); keep milliseconds. */
export const msOf = (t) => {
  if (typeof t === 'string' && /^\d{16,}$/.test(t)) return Number(t.slice(0, t.length - 6));
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e17 ? Math.round(n / 1e6) : n > 1e14 ? Math.round(n / 1e3) : n; // ns, us or ms
};

/**
 * One HTTP push from Sensor Logger ({ messageId, sessionId, deviceId,
 * payload: [{ name, time, values }] }) as { session, lux: [[t, lux]],
 * fix: [[t, lat, lng, acc, speed, bearing]] }.
 */
export function fromPush(body) {
  const out = { session: String(body?.sessionId || body?.session || 'push'), lux: [], fix: [], orient: [] };
  for (const e of Array.isArray(body?.payload) ? body.payload : []) {
    const t = msOf(e.time);
    if (!Number.isFinite(t)) continue;
    const v = e.values || {};
    if (/location/i.test(e.name || '') && Number.isFinite(Number(v.latitude))) {
      out.fix.push([t, Number(v.latitude), Number(v.longitude), num(v.horizontalAccuracy ?? v.accuracy), num(v.speed), num(v.bearing)]);
    } else if (isLight(e.name)) {
      const l = luxOf(v);
      if (Number.isFinite(l)) out.lux.push([t, l]);
    } else if (/orient/i.test(e.name || '')) {
      const o = poseOf(v);
      if (o) out.orient.push([t, ...o]);
    }
  }
  return out;
}

/**
 * The phone's pose from Sensor Logger's orientation quaternion (Android's
 * rotation vector: device to east-north-up): [nx, ny, nz, head], the unit
 * normal of the screen (nz 1 = flat, face up) and the compass heading in
 * degrees of the phone's top edge. Null without a quaternion.
 */
export function poseOf(v) {
  const qx = Number(v?.qx), qy = Number(v?.qy), qz = Number(v?.qz), qw = Number(v?.qw);
  if (![qx, qy, qz, qw].every(Number.isFinite)) return null;
  const nx = 2 * (qx * qz + qw * qy), ny = 2 * (qy * qz - qw * qx), nz = 1 - 2 * (qx * qx + qy * qy);
  const tx = 2 * (qx * qy - qw * qz), ty = 1 - 2 * (qx * qx + qz * qz);
  return [nx, ny, nz, (Math.atan2(tx, ty) * 180 / Math.PI + 360) % 360];
}
const num = (x) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** A Sensor Logger CSV (Location.csv, Light.csv or similar) as rows of objects. */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]?.trim().replace(/^"|"$/g, ''); });
    return o;
  });
}

/**
 * The files of one Sensor Logger export ({ name: text }) as { lux, fix }.
 * A file is a location file when it has latitude and longitude columns, a
 * light file when its name or a column says light, lux or illuminance, an
 * orientation file when it has the quaternion (qx, qy, qz, qw).
 */
export function fromExport(files) {
  const out = { lux: [], fix: [], orient: [] };
  for (const [name, text] of Object.entries(files)) {
    const rows = parseCsv(text);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    if (cols.includes('latitude') && cols.includes('longitude')) {
      for (const r of rows) {
        const t = msOf(r.time);
        if (Number.isFinite(t)) out.fix.push([t, Number(r.latitude), Number(r.longitude), num(r.horizontalAccuracy ?? r.accuracy), num(r.speed), num(r.bearing)]);
      }
    } else if (['qx', 'qy', 'qz', 'qw'].every((c) => cols.includes(c))) {
      for (const r of rows) {
        const t = msOf(r.time), o = poseOf(r);
        if (Number.isFinite(t) && o) out.orient.push([t, ...o]);
      }
    } else if (isLight(name) || cols.some(isLight)) {
      const col = cols.find((c) => /lux|illum/i.test(c)) || cols.find((c) => isLight(c)) || cols.find((c) => c !== 'time' && c !== 'seconds_elapsed');
      for (const r of rows) {
        const t = msOf(r.time), l = Number(r[col]);
        if (Number.isFinite(t) && Number.isFinite(l)) out.lux.push([t, l]);
      }
    }
  }
  return out;
}

/** Light readings averaged per whole second ([[t, lux]], t on the second). */
export function perSecond(lux) {
  const bins = new Map();
  for (const [t, l] of lux) {
    const s = Math.floor(t / 1000) * 1000;
    const b = bins.get(s) || [0, 0];
    b[0] += l; b[1]++;
    bins.set(s, b);
  }
  return [...bins].sort((a, b) => a[0] - b[0]).map(([s, [sum, n]]) => [s, sum / n]);
}

/**
 * Poses averaged per whole second ([[t, nx, ny, nz, head]]): the mean normal,
 * made unit again, and the mean heading taken on the circle. Sensor Logger
 * samples orientation up to 100 times a second; the bounce of the hopper
 * averages out here.
 */
export function posePerSecond(orient) {
  const bins = new Map();
  for (const [t, nx, ny, nz, head] of orient) {
    const s = Math.floor(t / 1000) * 1000;
    const b = bins.get(s) || [0, 0, 0, 0, 0];
    const h = (head * Math.PI) / 180;
    b[0] += nx; b[1] += ny; b[2] += nz; b[3] += Math.sin(h); b[4] += Math.cos(h);
    bins.set(s, b);
  }
  return [...bins].sort((a, b) => a[0] - b[0]).map(([s, [x, y, z, hs, hc]]) => {
    const m = Math.hypot(x, y, z) || 1;
    return [s, x / m, y / m, z / m, (Math.atan2(hs, hc) * 180 / Math.PI + 360) % 360];
  });
}

/* ------------------------------------------------------- the track */

const R = 6371008.8;
/** Meters between two [lat, lng]. */
export function metersBetween(a, b) {
  const p = Math.PI / 180, dLat = (b[0] - a[0]) * p, dLng = (b[1] - a[1]) * p;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Compass bearing in degrees from a to b ([lat, lng]). */
export function bearingBetween(a, b) {
  const p = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * p) * Math.cos(b[0] * p);
  const x = Math.cos(a[0] * p) * Math.sin(b[0] * p) - Math.sin(a[0] * p) * Math.cos(b[0] * p) * Math.cos((b[1] - a[1]) * p);
  return (Math.atan2(y, x) / p + 360) % 360;
}

/**
 * Each GPS fix with the light read within `reachMs` of it (the nearest
 * per-second mean): [{ t, lat, lng, acc, speed, bearing, lux, up, face }].
 * Fixes with no light near them are left out. Fixes inside a cut ([t0, t1])
 * too. `orient` (per-second poses, optional) gives `up` (the screen's
 * normal) and `face` (the phone's compass heading), null when none is near.
 */
export function joinTrack(fix, lux, { reachMs = 1500, cuts = [], orient = [] } = {}) {
  const L = perSecond(lux), O = [...orient].sort((a, b) => a[0] - b[0]);
  const out = [];
  let j = 0, k = 0;
  const cut = (t) => cuts.some(([a, b]) => t >= a && t <= b);
  for (const [t, lat, lng, acc, speed, bearing] of [...fix].sort((a, b) => a[0] - b[0])) {
    if (cut(t)) continue;
    while (j + 1 < L.length && Math.abs(L[j + 1][0] - t) <= Math.abs(L[j][0] - t)) j++;
    if (!L.length || Math.abs(L[j][0] - t) > reachMs) continue;
    while (k + 1 < O.length && Math.abs(O[k + 1][0] - t) <= Math.abs(O[k][0] - t)) k++;
    const o = O.length && Math.abs(O[k][0] - t) <= reachMs ? O[k] : null;
    out.push({ t, lat, lng, acc, speed, bearing, lux: L[j][1], up: o ? [o[1], o[2], o[3]] : null, face: o ? o[4] : null });
  }
  return out;
}

/**
 * Visits: the track split wherever it jumps more than `jumpM`, goes quiet
 * for more than `gapS`, or goes faster than `truckSpeed` m/s (the truck
 * between properties: its fixes come a second apart, so it never jumps),
 * keeping pieces of at least `minN` readings.
 */
export function splitVisits(track, { jumpM = 150, gapS = 300, minN = 30, truckSpeed = 7 } = {}) {
  const visits = [];
  let cur = [];
  for (const s of track) {
    if (s.speed > truckSpeed) {
      if (cur.length >= minN) visits.push(cur);
      cur = [];
      continue;
    }
    const prev = cur[cur.length - 1];
    if (prev && (s.t - prev.t > gapS * 1000 || metersBetween([prev.lat, prev.lng], [s.lat, s.lng]) > jumpM)) {
      if (cur.length >= minN) visits.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length >= minN) visits.push(cur);
  return visits;
}

/**
 * The readings worth comparing, each with its heading:
 *   - not faster than `maxSpeed` m/s (a spreader-sprayer is under ~3.5)
 *   - a fix good to `maxAcc` m
 *   - the phone within `maxTiltDeg` of flat, when its pose is known
 *   - one per `stepM` meters moved (stops count once)
 */
export function usable(track, { maxSpeed = 4.5, maxAcc = 8, stepM = 1, maxTiltDeg = 20 } = {}) {
  const out = [];
  const flat = Math.cos((maxTiltDeg * Math.PI) / 180);
  let last = null;
  for (let i = 0; i < track.length; i++) {
    const s = track[i];
    if (s.acc != null && s.acc > maxAcc) continue;
    if (s.up && s.up[2] < flat) continue;
    const prev = track[i - 1];
    const speed = s.speed != null && s.speed >= 0 ? s.speed
      : prev ? metersBetween([prev.lat, prev.lng], [s.lat, s.lng]) / Math.max(0.5, (s.t - prev.t) / 1000) : 0;
    if (speed > maxSpeed) continue;
    if (last && metersBetween([last.lat, last.lng], [s.lat, s.lng]) < stepM * 0.9) continue;
    const heading = s.bearing != null && s.speed > 0.3 ? s.bearing : last ? bearingBetween([last.lat, last.lng], [s.lat, s.lng]) : null;
    out.push({ ...s, speed, heading });
    last = s;
  }
  return out;
}

/* ----------------------------------------------- sun, shade, scores */

/**
 * Sun or shade by the visit's own light: Otsu's cut on log lux. Returns
 * { cut (lux), sunLux (the median of the bright group), contrast (bright
 * median over dim median), clear (true when the two groups are at least
 * `minContrast` apart -- a cloudy visit has one group), share: lux / sunLux
 * per reading, sun: per reading }.
 */
export function sunOrShade(luxes, { minContrast = 3 } = {}) {
  const v = luxes.map((l) => Math.log(Math.max(1, l)));
  const n = v.length;
  if (n < 10) return { cut: NaN, sunLux: NaN, contrast: NaN, clear: false, share: [], sun: [] };
  const s = [...v].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  let best = -1, cut = s[n >> 1], below = 0;
  for (let i = 1; i < n; i++) {
    below += s[i - 1];
    if (s[i] === s[i - 1]) continue;
    const m0 = below / i, m1 = (total - below) / (n - i);
    const between = i * (n - i) * (m1 - m0) ** 2;
    if (between > best) { best = between; cut = (s[i - 1] + s[i]) / 2; }
  }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  const hi = luxes.filter((l, i) => v[i] > cut), lo = luxes.filter((l, i) => v[i] <= cut);
  const sunLux = hi.length ? med(hi) : NaN, contrast = hi.length && lo.length ? med(hi) / Math.max(1, med(lo)) : 1;
  return {
    cut: Math.exp(cut), sunLux, contrast, clear: contrast >= minContrast,
    share: luxes.map((l) => l / sunLux), sun: v.map((x) => x > cut),
  };
}

/**
 * Each reading judged against the light around it in time, for clouds that
 * come and go within a visit. Around each reading (within `windowS`
 * seconds): when the light there splits clearly into sun and shade, Otsu's
 * cut of those readings decides; when it does not split and stays as bright
 * as the visit's sun (its median at least `dimShare` of the visit's 90th
 * percentile), the visit's cut decides (a sunny open stretch); otherwise the
 * light there is evenly dim and the reading is not judged (`judged` false).
 * And a run of shade lasting more than `maxShadeS` seconds is not judged
 * either: a sprayer crosses a tree's shade in seconds, while a cloud dims a
 * minute or more, and beside open sun a cloud looks just like shade. A long
 * shaded strip along a tree line is lost with it; the phone alone cannot
 * tell the two apart. Returns sunOrShade's answer for the visit, with `sun`
 * and `judged` per reading.
 */
export function sunOrShadeAround(samples, { windowS = 90, minContrast = 3, dimShare = 0.5, maxShadeS = 60 } = {}) {
  const g = sunOrShade(samples.map((s) => s.lux), { minContrast });
  const n = samples.length, sun = new Array(n).fill(false), judged = new Array(n).fill(false);
  if (!g.clear) return { ...g, sun, judged };
  const sorted = samples.map((s) => s.lux).sort((x, y) => x - y);
  const bright = sorted[Math.floor(0.9 * (n - 1))];
  const W = windowS * 1000;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const t = samples[i].t;
    while (samples[a].t < t - W) a++;
    while (b + 1 < n && samples[b + 1].t <= t + W) b++;
    const near = samples.slice(a, b + 1).map((s) => s.lux);
    const local = near.length >= 10 ? sunOrShade(near, { minContrast }) : null;
    let cut;
    if (local && local.clear) cut = local.cut;
    else {
      const m = [...near].sort((x, y) => x - y)[near.length >> 1];
      if (m < dimShare * bright) continue;
      cut = g.cut;
    }
    judged[i] = true;
    sun[i] = samples[i].lux > cut;
  }
  for (let i = 0; i < n;) {
    if (!judged[i] || sun[i]) { i++; continue; }
    let k = i;
    while (k + 1 < n && judged[k + 1] && !sun[k + 1]) k++;
    if (samples[k].t - samples[i].t > maxShadeS * 1000) for (let q = i; q <= k; q++) judged[q] = false;
    i = k + 1;
  }
  return { ...g, sun, judged };
}

/**
 * The angle in degrees between the sun and the phone's face (`up`, the
 * screen's unit normal in east-north-up; flat when unknown).
 */
export function sunOffFace(up, elevationDeg, azimuthDeg) {
  const R = Math.PI / 180, ce = Math.cos(elevationDeg * R);
  const [x, y, z] = up || [0, 0, 1];
  const d = x * Math.sin(azimuthDeg * R) * ce + y * Math.cos(azimuthDeg * R) * ce + z * Math.sin(elevationDeg * R);
  return Math.acos(Math.max(-1, Math.min(1, d))) / R;
}

/**
 * How the phone sits on the machine: the fixed turn between the phone's
 * (absolute) heading and the way the machine goes, from straight runs: readings at more than `minSpeed` m/s whose
 * neighbors within `spanS` seconds hold the same GPS bearing (within
 * `steadyDeg`). Their bearing minus the phone's heading, averaged on the
 * circle: { offset, n, spread (degrees, circular) }, or null when fewer than
 * `minN` or too scattered (`maxSpread`) -- a compass near steel can wander.
 */
export function compassOffset(samples, { minSpeed = 1.5, spanS = 2, steadyDeg = 10, minN = 8, maxSpread = 20 } = {}) {
  const d = (x, y) => ((x - y + 540) % 360) - 180;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.face == null || s.bearing == null || !(s.speed > minSpeed)) continue;
    const near = samples.filter((o) => Math.abs(o.t - s.t) <= spanS * 1000);
    if (near.length < 3 || near.some((o) => o.bearing == null || !(o.speed > minSpeed) || Math.abs(d(o.bearing, s.bearing)) > steadyDeg)) continue;
    const off = (d(s.bearing, s.face) * Math.PI) / 180;
    sx += Math.cos(off); sy += Math.sin(off); n++;
  }
  if (n < minN) return null;
  const Rbar = Math.hypot(sx, sy) / n;
  const spread = (Math.sqrt(-2 * Math.log(Math.max(1e-9, Rbar))) * 180) / Math.PI;
  if (spread > maxSpread) return null;
  return { offset: (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360, n, spread };
}

/**
 * Whether the operator's own shadow can fall on the phone: the phone rides
 * at the front, so his shadow reaches it when the sun is behind him, within
 * `withinDeg` of straight behind the way he is going.
 */
export function operatorShadow(heading, sunAzimuth, withinDeg = 35) {
  if (heading == null) return false;
  const behind = (heading + 180) % 360;
  const d = Math.abs(((sunAzimuth - behind + 540) % 360) - 180);
  return d <= withinDeg;
}

/**
 * The score of a visit: for readings the model and the phone both judged,
 * how often they agree on sun or shade. `modelT` is the share of the
 * direct beam the model lets through at each reading (sun if >= 0.5).
 * Returns { n, agree, sunSun, sunShade (model sun, phone shade), shadeSun,
 * shadeShade }.
 */
export function score(sunMeasured, modelT, keep = null) {
  const r = { n: 0, agree: 0, sunSun: 0, sunShade: 0, shadeSun: 0, shadeShade: 0 };
  for (let i = 0; i < modelT.length; i++) {
    if (keep && !keep[i]) continue;
    const m = modelT[i] >= 0.5, p = sunMeasured[i];
    r.n++;
    if (m && p) r.sunSun++; else if (m && !p) r.sunShade++; else if (!m && p) r.shadeSun++; else r.shadeShade++;
  }
  r.agree = r.n ? (r.sunSun + r.shadeShade) / r.n : NaN;
  return r;
}

/* ------------------------------------------------------------ zip */

/**
 * The files in a .zip (Sensor Logger's export), as { name: text }, using
 * the browser's own inflate (DecompressionStream 'deflate-raw'). Stored and
 * deflated entries only, which is all an export holds.
 */
export async function unzipText(buf, { inflate = defaultInflate } = {}) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + size);
    const raw = method === 0 ? data : method === 8 ? await inflate(data) : null;
    if (raw) out[name.split('/').pop()] = new TextDecoder().decode(raw);
  }
  return out;
}
async function defaultInflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const res = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}
