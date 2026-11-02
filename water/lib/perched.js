/**
 * WATER PERCHED ON A SLOW LAYER, AND FLOWING DOWNHILL ALONG IT (owner, 2026-11-02: "Yes build it" -- the surface's
 * pool-or-flow-downhill rule applied to the layers below: "if water drains through the top layer faster than the layer
 * below it, it will pool up or flow down across the top of that layer"; FINDINGS H71-H73; research-perched.md,
 * research-interface.md).
 *
 * The Soil Moisture Routing model's design (Frankenberger et al. 1999, a daily grid model for soils over fragipans):
 * a perched store P (mm of water) on top of each cell's slow layer, filled by what drains out of the root zone, losing
 * water down through the slow layer (Jackson's leak, L = (h + C) / R, R the layer's resistance in days) and sideways
 * along the top of the slow layer to the cells downhill of it ON THE LAYER'S SURFACE, as an exact linear reservoir
 * (stable at any step, mass kept); what the room between the roots and the layer cannot hold goes up into the roots,
 * then out of the ground as a seep (the surface's water again). On flat ground the sideways part is nil and the store
 * drains only down through the layer and up through the grass: soil kept saturated for weeks where the layer is slow.
 *
 * The slow layer from the soil survey (no table says "perched": research-perched.md section 3):
 *   a horizon passing 1.0 um/s or less (NRCS "moderately low" or slower) and at most a tenth of the fastest above it;
 *   or a restriction row of a kind that holds water (ortstein, fragipan, densic...), or a cemented horizon (an m
 *   suffix: Bhsm, Bsm), that the survey gives no slower Ksat -- then a thin band with a published conductivity
 *   (research-interface.md: ortstein 0.5 um/s over its thickness or 10 cm; an iron crust 0.01 um/s over 0.5 cm).
 * Clay bands in sand ("E and Bt"), uncemented Bs/Bhs and a bare change of material add nothing: the survey's own
 * horizon Ksat already holds them (research-interface.md, Kent and Ottawa).
 */
import { fill } from './hydro.js';

export const PERCH = {
  slowUmS: 1.0,          // a horizon this slow or slower...
  contrast: 0.1,         // ...and at most this share of the fastest above it, perches water
  minResistDays: 1,      // the layer's resistance (days) below which no store is kept (it drains through at once)
  cMinM: 0.3,            // a slow layer at the bottom of the data: taken this thick at least
  kLFloorUmS: 0.01,
  phidDefault: 0.1, phidFloor: 0.02,
  band: { Ortstein: { umS: 0.5, cm: 10 }, Placic: { umS: 0.01, cm: 0.5 }, Fragipan: { umS: 1 / 86.4, cm: 30 }, Duripan: { umS: 1 / 86.4, cm: 30 }, 'Densic material': { umS: 1 / 86.4, cm: 30 }, 'Cemented horizon': { umS: 0.5, cm: 10 }, 'Lithic bedrock': { umS: 2 / 86.4, cm: 30 }, 'Paralithic bedrock': { umS: 2 / 86.4, cm: 30 } },
  betaDefault: 0.5,      // how much of the ground's local relief sits in the layer above the slow one (0 parallel, 1 flat)
  smoothM: 40, preSmoothM: 5,
  slopeFloor: 0.001,
  kLatMult: 1,           // sideways conductivity as a multiple of the survey's (hillslopes measured 3.2-13.7 x: Brooks 2004)
  barrierMmPerCm: 2.2,   // loam over sand holds about this much more per cm of the loam (10 cm +22 mm, 20 cm +40 mm)
};

const um2mmDay = (v) => v * 86.4;
const suffixOf = (name) => { const m = /^\d*([A-Z]+)([a-z]*)\d*$/.exec(String(name || '').replace(/\s+/g, '')); return m ? m[2] : ''; };

/**
 * A profile's slow layer -> null, or { topCm, topLoCm, topHiCm, cM (thickness, m), resistDays, kLatMmDay, phid,
 * how: 'horizon' | 'band', band: kind | null, name }.
 */
export function slowLayerOf(profile, opts = {}) {
  const P = { ...PERCH, ...opts };
  const hz = (profile?.horizons || []).filter((h) => Number.isFinite(h.topCm) && Number.isFinite(h.bottomCm) && h.bottomCm > h.topCm).sort((a, b) => a.topCm - b.topCm);
  if (hz.length < 2) return null;
  const phidOf = (h) => (Number.isFinite(h?.sat) && Number.isFinite(h?.fc) ? Math.max(P.phidFloor, (h.sat - h.fc) / 100) : P.phidDefault);
  const above = (k) => { for (let j = k - 1; j >= 0; j--) if (Number.isFinite(hz[j].ksatUmS)) return hz[j]; return null; };
  // 1. a horizon slow in itself, and a tenth or less of the fastest above
  for (let k = 1; k < hz.length; k++) {
    const h = hz[k], fastest = Math.max(...hz.slice(0, k).map((x) => x.ksatUmS).filter(Number.isFinite));
    if (!(Number.isFinite(h.ksatUmS) && h.ksatUmS <= P.slowUmS && Number.isFinite(fastest) && h.ksatUmS <= P.contrast * fastest)) continue;
    let resist = 0, thick = 0, j = k;
    for (; j < hz.length && Number.isFinite(hz[j].ksatUmS) && hz[j].ksatUmS <= P.slowUmS; j++) {
      const t = (hz[j].bottomCm - hz[j].topCm) * 10;
      resist += t / um2mmDay(Math.max(P.kLFloorUmS, hz[j].ksatUmS)); thick += t;
    }
    if (j === hz.length && thick < P.cMinM * 1000) { resist *= (P.cMinM * 1000) / thick; thick = P.cMinM * 1000; }
    if (resist < P.minResistDays) return null;
    const up = above(k);
    return { topCm: h.topCm, topLoCm: h.topLoCm ?? null, topHiCm: h.topHiCm ?? null, cM: thick / 1000, resistDays: resist, kLatMmDay: um2mmDay(up?.ksatUmS ?? 1) * P.kLatMult, phid: phidOf(up), how: 'horizon', band: null, name: h.name || null };
  }
  // 2. a named restriction or a cemented horizon the survey gives no slower Ksat: a thin band (research-interface.md)
  const bandAt = (kind, depthCm, thickCm) => {
    const b = P.band[kind] || P.band['Cemented horizon'];
    const cm = Number.isFinite(thickCm) && thickCm > 0 ? thickCm : b.cm;
    const resist = (cm * 10) / um2mmDay(b.umS);
    if (resist < P.minResistDays) return null;
    const k = hz.findIndex((h) => h.bottomCm > depthCm);
    const up = k > 0 ? above(k) || hz[k - 1] : hz[0];
    return { topCm: depthCm, topLoCm: null, topHiCm: null, cM: cm / 100, resistDays: resist, kLatMmDay: um2mmDay(up?.ksatUmS ?? 1) * P.kLatMult, phid: phidOf(up), how: 'band', band: kind, name: (k >= 0 ? hz[k].name : null) || kind };
  };
  for (const r of profile?.restrictions || []) if (r.kind && P.band[r.kind] && Number.isFinite(r.topCm)) { const b = bandAt(r.kind, r.topCm, r.thickCm); if (b) return b; }
  for (let k = 1; k < hz.length; k++) if (suffixOf(hz[k].name).includes('m')) { const b = bandAt(/h|s/.test(suffixOf(hz[k].name)) ? 'Ortstein' : 'Cemented horizon', hz[k].topCm, hz[k].bottomCm - hz[k].topCm); if (b) return b; }
  return null;
}

/**
 * THE SURVEY AS THE CHECK ON THE LAYER (research-perched.md, "the survey as a target": the layer's conductivity is the
 * least known number; a soil the survey records wet above its slow layer that never perches in the model has it too
 * high). Where the survey's wet months put water above the slow layer, the layer is held to the rate that would keep
 * the perched water at the survey's depth under those months' mean surplus of rain over the grass's use: Jackson's
 * steady state, surplus = K (h + C) / C, so K = surplus * C / (h + C). Never faster than the survey's own.
 * days: the typical years ({ date, rain, et0 }); kc: the grass's crop coefficient. -> the layer, recalibrated or not.
 */
export function calibrateLayer(L, wetByMonth, days, kc) {
  if (!L || !Array.isArray(wetByMonth) || !days?.length) return L;
  const months = new Set(), depths = [];
  wetByMonth.forEach((v, m) => { if (Number.isFinite(v) && v < L.topCm) { months.add(m); depths.push(v); } });
  if (!months.size) return L;
  let rain = 0, use = 0, n = 0;
  for (const d of days) { const m = Number(d.date.slice(5, 7)) - 1; if (!months.has(m)) continue; rain += Number.isFinite(d.rain) ? d.rain : 0; use += (Number.isFinite(d.et0) ? d.et0 : 0) * kc; n++; }
  if (!n) return L;
  const surplus = Math.max(0.1, (rain - use) / n), wet = depths.sort((a, b) => a - b)[depths.length >> 1];
  const hMm = Math.max(50, (L.topCm - Math.max(0, wet)) * 10), cMm = L.cM * 1000, kNow = cMm / L.resistDays;
  const k = (surplus * cMm) / (hMm + cMm);
  if (k >= kNow) return L;
  return { ...L, resistDays: cMm / k, calibrated: { surveyMmDay: kNow, mmDay: k, wetCm: wet, months: [...months].sort((a, b) => a - b), surplusMmDay: surplus } };
}

/** Topsoil over sand holds water above the boundary (a capillary barrier): the extra mm for `topCm` of loam, or 0. */
export function barrierExtraMm(profile, topCm, textureClass) {
  const top = (profile?.horizons || []).filter((h) => Number.isFinite(h.topCm)).sort((a, b) => a.topCm - b.topCm)[0];
  if (!top) return 0;
  const tex = textureClass(top.sand ?? 40, top.clay ?? 20);
  return tex === 'sand' || tex === 'loamy sand' ? PERCH.barrierMmPerCm * topCm : 0;
}

/** A grid smoothed by a square box `m` metres across (NaN kept out), two passes. */
function boxSmooth(g, z, m) {
  const r = Math.max(1, Math.round(m / g.cell / 2)), { W, H } = g, tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx < 0 || xx >= W) continue; const v = z[y * W + xx]; if (Number.isFinite(v)) { s += v; n++; } } tmp[y * W + x] = n ? s / n : NaN; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; const v = tmp[yy * W + x]; if (Number.isFinite(v)) { s += v; n++; } } out[y * W + x] = n ? s / n : NaN; }
  return out;
}

/**
 * The slow layer's depth under each cell (cm; NaN where its soil has none): the soil's own depth d0, plus beta times
 * the ground's height above its 40 m average (a rise holds more of the layer above, a hollow less: the owner's example, clay 6 ft
 * down at the top of a hill and 2 ft at the bottom), beta per soil from the survey's range of depths, else 0.5.
 * -> { zL (cm), beta per soil }
 */
export function layerDepths(g, z, soilAt, slow, { smoothM = PERCH.smoothM, preSmoothM = PERCH.preSmoothM } = {}) {
  const N = g.W * g.H, z5 = boxSmooth(g, z, preSmoothM), zs = boxSmooth(g, z5, smoothM);
  const rel = new Float32Array(N); for (let i = 0; i < N; i++) rel[i] = z5[i] - zs[i];
  const beta = slow.map((s, k) => {
    if (!s) return 0;
    if (!Number.isFinite(s.topLoCm) || !Number.isFinite(s.topHiCm) || s.topHiCm <= s.topLoCm) return PERCH.betaDefault;
    const v = []; for (let i = 0; i < N; i++) if (soilAt[i] === k && Number.isFinite(rel[i])) v.push(rel[i]);
    if (v.length < 10) return PERCH.betaDefault;
    const m = v.reduce((a, x) => a + x, 0) / v.length, sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
    // the layer's spread across this soil's ground should match the survey's range (low to high, about 4 sd)
    return sd > 0.01 ? Math.max(0, Math.min(1, (s.topHiCm - s.topLoCm) / 100 / (4 * sd))) : PERCH.betaDefault;
  });
  const zL = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) { const s = slow[soilAt[i]]; if (s && Number.isFinite(rel[i])) zL[i] = Math.max(10, s.topCm + beta[soilAt[i]] * rel[i] * 100); }
  return { zL, beta, z5 };
}

const N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
/**
 * Where perched water goes along the slow layer: the layer's surface (ground less zL) filled so every cell drains,
 * each perching cell's lower neighbours weighted by slope (SMR Eq. 7), its effective slope (floored), and the order,
 * uphill first. Water heading to a cell with no slow layer drops into free-draining ground there.
 */
export function perchedRoutes(g, z5, zL) {
  const { W, H, cell } = g, N = W * H;
  const E = new Float64Array(N); for (let i = 0; i < N; i++) E[i] = Number.isFinite(z5[i]) ? z5[i] - (Number.isFinite(zL[i]) ? zL[i] / 100 : 3) : -1e9;
  const Ef = fill(g, E, new Uint8Array(N), 1e-5);
  const recv = new Int32Array(N * 8).fill(-1), w = new Float32Array(N * 8), sEff = new Float32Array(N);
  const active = []; for (let i = 0; i < N; i++) if (Number.isFinite(zL[i])) active.push(i);
  for (const i of active) {
    const r = Math.floor(i / W), c = i % W;
    let sum = 0, sum2 = 0, k = 0;
    for (const [dr, dc] of N8) {
      const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const j = rr * W + cc, d = Math.hypot(dr, dc) * cell, s = (Ef[i] - Ef[j]) / d;
      if (s > 0) { recv[i * 8 + k] = j; w[i * 8 + k] = s; sum += s; sum2 += s * s; k++; }
    }
    for (let q = 0; q < k; q++) w[i * 8 + q] /= sum || 1;
    sEff[i] = Math.max(PERCH.slopeFloor, sum ? sum2 / sum : 0);
  }
  active.sort((a, b) => Ef[b] - Ef[a]);
  return { recv, w, sEff, order: Int32Array.from(active) };
}

/**
 * How fast water leaves the roots for the perched store (mm/day): the slowest horizon between the roots' bottom and
 * the slow layer's top (the survey's own Ksat; not the drainage class's factor, which already holds the perching and
 * would count it twice), else the root zone's own.
 */
export function drainToLayerMmDay(profile, rootCm, layerTopCm, fallbackMmH) {
  const v = (profile?.horizons || []).filter((h) => Number.isFinite(h.ksatUmS) && h.bottomCm > rootCm && h.topCm < layerTopCm).map((h) => h.ksatUmS);
  return v.length ? um2mmDay(Math.min(...v)) : (Number.isFinite(fallbackMmH) ? fallbackMmH * 24 : 120);
}

/**
 * Per-cell arrays for perchedDay from each soil's slow layer and the layer's depth grid.
 * slow[k]: slowLayerOf(soils[k]) or null; zL: layerDepths().zL (cm, NaN none); cells limited to `use(i)`.
 */
export function perchedCells(N, soilAt, slow, zL, use = () => true) {
  const par = { zL: new Float32Array(N).fill(NaN), resist: new Float32Array(N), cMm: new Float32Array(N), kLat: new Float32Array(N), phid: new Float32Array(N).fill(PERCH.phidDefault) };
  for (let i = 0; i < N; i++) {
    const s = slow[soilAt[i]];
    if (!s || !Number.isFinite(zL[i]) || !use(i)) continue;
    par.zL[i] = zL[i]; par.resist[i] = s.resistDays; par.cMm[i] = s.cM * 1000; par.kLat[i] = s.kLatMmDay; par.phid[i] = s.phid;
  }
  return par;
}

/**
 * One day of the perched store, uphill first. st: { P, Dr, grav, satRoom, pond } (Float32Arrays, changed in place);
 * par: perchedCells(); rootCm: today's root depth per cell (cm); wt: this month's groundwater depth per cell (cm, NaN
 * none) or null. tot gets leak, latIn, latOut, seep, toRoots (mm per cell) and fullDays. frozen: the ground frozen
 * (no leak, no sideways flow).
 */
export function perchedDay(routes, st, par, rootCm, wt, tot, { frozen = false, cellM = 1 } = {}) {
  const { recv, w, sEff, order } = routes, { P, Dr, grav, satRoom, pond } = st;
  const { zL, resist, cMm, kLat, phid } = par;
  const inflow = new Float32Array(P.length);
  for (const i of order) {
    let p = P[i] + inflow[i];
    if (!frozen && p > 0) {
      // down through the slow layer: (h + C) / R (Jackson); none where the water table already stands above its base
      const held = wt && Number.isFinite(wt[i]) && wt[i] <= zL[i] + cMm[i] / 10;
      const leak = held ? 0 : Math.min(p, (p / phid[i] + cMm[i]) / resist[i]);
      p -= leak; tot.leak[i] += leak;
      // sideways along it: an exact linear reservoir, a = K S / (phid L)
      const out = p * (1 - Math.exp(-(kLat[i] * sEff[i]) / (phid[i] * cellM * 1000)));
      if (out > 0) {
        p -= out; tot.latOut[i] += out;
        let given = 0;
        for (let k = 0; k < 8; k++) {
          const j = recv[i * 8 + k]; if (j < 0) break;
          const q = out * w[i * 8 + k]; given += q;
          if (Number.isFinite(zL[j])) { inflow[j] += q; tot.latIn[j] += q; } else tot.leak[i] += q; // into free-draining ground
        }
        if (given < out) tot.leak[i] += out - given; // off the window's edge: counted with the leak
      }
    }
    // the room between the roots and the layer; beyond it, up into the roots, then out at the surface (a seep)
    const room = Math.max(0, (zL[i] - rootCm[i]) * 10 * phid[i]);
    if (p > room) {
      let ex = p - room; p = room;
      const r = Math.min(ex, Dr[i]); Dr[i] -= r; ex -= r;
      const g2 = Math.min(ex, Math.max(0, satRoom[i] - grav[i])); grav[i] += g2; ex -= g2;
      tot.toRoots[i] += r + g2; tot.fullDays[i]++;
      if (ex > 0) { pond[i] += ex; tot.seep[i] += ex; }
    }
    P[i] = p;
  }
}
