/**
 * THE PRESSURE AT EACH HEAD (water session; owner, 2026-10-20: "the pressure at the head is estimated by
 * simulating a logic path for the lines ... sizes of pipes ... elevation gain/loss from the pvb to the heads
 * ... flow rate (factoring in the actual gpm of the heads and piping) ... initial pressure at pvb ...
 * possibly scale/rust buildup"). Pure: the page and the tests share it.
 *
 *   route     the lines an installer most likely laid: from the valve, each head joined to the nearest
 *             point of the trench already dug (a tee in the lateral, or on to the last head), so a zone is
 *             one lateral with branches -- the greedy Steiner tree, not a star of pipes to every head
 *   size      each run of pipe the smallest of the zone's material that keeps the water under 5 ft/s at
 *             the flow it carries (what the makers' design guides do), unless the person gave a size
 *   solve     from the pressure at the backflow preventer: less its loss, the supply line's friction, the
 *             valve's loss, each run's friction and fittings, each swing joint's; plus or minus the ground's
 *             rise or fall (0.433 psi per ft, from the lidar); each head's flow from its own chart at the
 *             pressure it gets -- and the pipes' flows from those, round again until they agree
 *
 * Distances in feet, pressures in psi, flows in gpm. Positions [lng, lat].
 */

import { enu, headWater, headPsi } from './heads.js';

export const PSI_PER_FT = 0.433; // a foot of water
export const FT_PER_M = 3.2808;
export const MAX_FPS = 5;

/* ---------------------------------------------------------------- pipe families */

/**
 * Inside diameters (in) by the standard each is made to, and Hazen-Williams C new. The swing-joint pipe is
 * the 1/2 in flexible "funny pipe" from a lateral to a head.
 */
export const PIPE_FAMILIES = {
  pe: { label: 'poly (black roll pipe, SIDR-15)', C: 150, sizes: [['050', 0.5, 0.622], ['075', 0.75, 0.824], ['100', 1, 1.049], ['125', 1.25, 1.380], ['150', 1.5, 1.610]] },
  pvc200: { label: 'PVC Class 200', C: 150, sizes: [['075', 0.75, 0.930], ['100', 1, 1.189], ['125', 1.25, 1.502], ['150', 1.5, 1.720]] },
  pvc40: { label: 'PVC Schedule 40', C: 150, sizes: [['050', 0.5, 0.622], ['075', 0.75, 0.824], ['100', 1, 1.049], ['125', 1.25, 1.380], ['150', 1.5, 1.610], ['200', 2, 2.067]] },
  cuL: { label: 'copper, type L', C: 140, sizes: [['075', 0.75, 0.785], ['100', 1, 1.025], ['125', 1.25, 1.265]] },
  cuK: { label: 'copper, type K', C: 140, sizes: [['075', 0.75, 0.745], ['100', 1, 0.995], ['125', 1.25, 1.245]] },
  pex: { label: 'PEX', C: 150, sizes: [['075', 0.75, 0.671], ['100', 1, 0.862]] },
  galv: { label: 'galvanized steel', C: 120, sizes: [['075', 0.75, 0.824], ['100', 1, 1.049]] },
  swing: { label: 'swing pipe (1/2 in funny pipe)', C: 150, sizes: [['050', 0.5, 0.49]] },
};

/** A family's size: { id, family, nominal, idIn, C }. */
export function pipeSize(family, nominal) {
  const f = PIPE_FAMILIES[family];
  const s = f?.sizes.find((x) => x[1] === nominal);
  return s ? { id: `${family}-${s[0]}`, family, nominal: s[1], idIn: s[2], C: f.C, label: `${fraction(s[1])} in ${f.label}` } : null;
}
export function pipeById(id) {
  const [family, code] = String(id || '').split('-');
  const f = PIPE_FAMILIES[family];
  const s = f?.sizes.find((x) => x[0] === code);
  return s ? pipeSize(family, s[1]) : null;
}
export const fraction = (n) => ({ 0.5: '1/2', 0.625: '5/8', 0.75: '3/4', 1: '1', 1.25: '1 1/4', 1.5: '1 1/2', 2: '2' }[n] || String(n));

/** Friction, psi per ft of pipe (Hazen-Williams: 4.52 Q^1.852 / (C^1.852 d^4.87)). */
export const frictionPerFt = (idIn, C, gpm) => (gpm > 0 ? (4.52 * gpm ** 1.852) / (C ** 1.852 * idIn ** 4.87) : 0);
/** Speed of the water, ft/s. */
export const fps = (idIn, gpm) => gpm / (2.448 * idIn * idIn);

/** Installers do not lay laterals under 3/4 in (1/2 in is the swing pipe to a head). */
export const MIN_LATERAL_IN = 0.75;
/** The smallest of a family, from MIN_LATERAL_IN, that keeps `gpm` under MAX_FPS (the largest if none does). */
export function sizeFor(family, gpm, minIn = MIN_LATERAL_IN) {
  const f = PIPE_FAMILIES[family] || PIPE_FAMILIES.pe;
  for (const s of f.sizes) if (s[1] >= minIn && fps(s[2], gpm) <= MAX_FPS) return pipeSize(family in PIPE_FAMILIES ? family : 'pe', s[1]);
  const last = f.sizes[f.sizes.length - 1];
  return pipeSize(family in PIPE_FAMILIES ? family : 'pe', last[1]);
}

/* ------------------------------------------------------------- devices (curves) */

/**
 * A device's loss at `gpm` from its maker's points [{ gpm, psi }]: linear between them; past the last,
 * growing with the square of the flow (a fixed opening); below the first, for a check valve (backflow
 * preventers) held at the first point (its spring), for an open valve or a meter falling with the square.
 */
export function deviceLoss(device, gpm) {
  const pts = (device?.points || []).filter((p) => Number.isFinite(p.gpm) && Number.isFinite(p.psi)).sort((a, b) => a.gpm - b.gpm);
  if (!pts.length || !(gpm > 0)) return 0;
  const check = ['pvb', 'dcva', 'rpz', 'avb'].includes(device.kind);
  if (gpm <= pts[0].gpm) return check ? pts[0].psi : pts[0].psi * (gpm / pts[0].gpm) ** 2;
  const last = pts[pts.length - 1];
  if (gpm >= last.gpm) return last.psi * (gpm / last.gpm) ** 2;
  for (let k = 1; k < pts.length; k++) if (gpm <= pts[k].gpm) {
    const a = pts[k - 1], b = pts[k];
    return a.psi + ((gpm - a.gpm) / (b.gpm - a.gpm)) * (b.psi - a.psi);
  }
  return last.psi;
}

/* -------------------------------------------------------------------- routing */

/** Metres between two [lng, lat]. */
const distM = (a, b) => Math.hypot(...enu(a, b));

/** The point on segment ab nearest p, all [lng, lat] (flat over a lawn). -> { at, t, d } */
function nearestOnSegment(a, b, p) {
  const [bx, by] = enu(a, b), [px, py] = enu(a, p);
  const L = bx * bx + by * by;
  const t = L ? Math.max(0, Math.min(1, (px * bx + py * by) / L)) : 0;
  const at = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { at, t, d: Math.hypot(px - t * bx, py - t * by) };
}

/**
 * The lines of one zone, as an installer most likely laid them (lib/hydraulics/PRACTICE.md 1a, 1d): a tree fed
 * from the valve, never a loop; the flow split near the valve -- Rain Bird calls a valve at the end of one long
 * line "the least optimum of all lateral designs", and Hunter draws the one line snaking through every head as
 * WRONG -- with each head on the lateral by a short stub. The shortest trench (a spanning tree of the heads) IS
 * that snake, so the length alone cannot choose: a head joins the tree where its own pipe plus PD_C times the
 * pipe from the valve to that point is least (Alpert et al. 1995's Prim-Dijkstra trade-off between the
 * shortest trench, PD_C 0, and a pipe of its own to every head, PD_C 1), at a node or at a tee mid-run.
 * cost(a, b) -> a multiplier on a run's length: going through a building (forbidden in practice) or under paving
 * (a sleeve; installers go round when they can) costs more.
 * heads: [{ id, at }]. -> { nodes: [{ id, at, kind: 'valve'|'tee'|'head', parent, lenFt }], order (root first) }
 */
export const PD_C = 0.5, BLOCK_COST = 4;
export function route(valveAt, heads, { blocked = null, cost: costOf = null, c = PD_C } = {}) {
  const nodes = [{ id: 'valve', at: valveAt, kind: 'valve', parent: null, lenFt: 0, path: 0 }];
  const mult = (a, b) => (costOf ? costOf(a, b) : blocked && blocked(a, b) ? BLOCK_COST : 1);
  const cost = (a, b) => distM(a, b) * mult(a, b);
  const left = heads.filter((h) => Array.isArray(h.at));
  let tees = 0;
  while (left.length) {
    let best = null;
    for (const h of left) {
      for (const n of nodes) { const k = cost(n.at, h.at) + c * n.path; if (!best || k < best.k) best = { h, k, to: n, split: null }; }
      for (const n of nodes) {
        if (n.parent === null) continue;
        const p = nodes.find((x) => x.id === n.parent);
        const sp = nearestOnSegment(p.at, n.at, h.at);
        if (sp.t <= 0.02 || sp.t >= 0.98) continue;
        const k = cost(sp.at, h.at) + c * (p.path + sp.t * (n.path - p.path)) + 0.3; // a tee is a fitting
        if (k < best.k) best = { h, k, to: n, split: sp };
      }
    }
    let to = best.to;
    if (best.split) {
      const p = nodes.find((x) => x.id === to.parent);
      const tee = { id: `tee${++tees}`, at: best.split.at, kind: 'tee', parent: to.parent, lenFt: 0, path: p.path + best.split.t * (to.path - p.path) };
      nodes.push(tee);
      to.parent = tee.id;
      to = tee;
    }
    nodes.push({ id: best.h.id, at: best.h.at, kind: 'head', parent: to.id, lenFt: 0, path: to.path + distM(to.at, best.h.at) });
    left.splice(left.indexOf(best.h), 1);
  }
  for (const n of nodes) if (n.parent !== null) n.lenFt = distM(nodes.find((x) => x.id === n.parent).at, n.at) * FT_PER_M;
  const order = [], byParent = new Map();
  for (const n of nodes) { if (!byParent.has(n.parent)) byParent.set(n.parent, []); byParent.get(n.parent).push(n); }
  const walk = (id) => { for (const ch of byParent.get(id) || []) { order.push(ch); walk(ch.id); } };
  order.push(nodes[0]); walk('valve');
  return { nodes, order };
}

/* -------------------------------------------------------------------- solving */

/** Fittings: Rain Bird's default, "10% of all pipe losses" (Landscape Irrigation Design Manual, p. 91; the
    only maker's guide with a fittings line: lib/hydraulics/PRACTICE.md 4). */
export const FITTINGS_SHARE = 0.10;

/**
 * One zone, solved. z: {
 *   tree: route(), heads: Map id -> { body, nozzle, arc }, cat (lib/heads.js catalogue), water(head, psi) ->
 *   { gpm, radiusFt, ... } (lib/heads.js headWater with its chart), elev(at) -> ground metres or null,
 *   family: the zone's pipe material, size: a pipe id to use throughout, or null (sized by flow),
 *   valve: a device, swing: { lenFt, fittingsFt }, cFactor: Hazen-Williams C multiplier (scale)
 * }
 * up: { psi at the gauge, gaugeAt, gaugeElevM, upstream(gpm) -> psi lost before the zone's valve (the
 *       backflow preventer, the supply line, a meter) }
 * -> { gpm, heads: Map id -> { psi, gpm, radiusFt, flag }, valvePsi, runs: [{ id, pipe, gpm, fps, lossPsi }],
 *      worst: the farthest head's worksheet, spread (max-min)/max, iterations }
 */
export function solveZone(z, up, { maxIter = 60, tol = 1e-4 } = {}) {
  const { tree, heads, water } = z;
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of tree.nodes) if (n.parent !== null) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const groundFt = (at) => { const e = z.elev ? z.elev(at) : null; return Number.isFinite(e) ? e * FT_PER_M : null; };
  // heights: the gauge where it was given; the lateral 8 in below the ground; a nozzle 4 in above it
  const gaugeFt = Number.isFinite(up.gaugeElevM) ? up.gaugeElevM * FT_PER_M : groundFt(up.gaugeAt);
  const flat = gaugeFt === null;
  const hNode = (n) => { const g = groundFt(n.at); return flat || g === null ? 0 : g - 8 / 12; };
  const hNozzle = (n) => { const g = groundFt(n.at); return flat || g === null ? 0 : g + 4 / 12; };
  const g0 = flat ? 0 : gaugeFt;

  // the pipes are sized once, as an installer sizes them: from each head's flow at its design pressure
  // (z.design(head) -> gpm; else the chart's at 30 psi for a spray, 45 for a rotor), not the flow that runs
  const designOf = (h) => (z.design ? z.design(h) : water(h, /rotor|impact/.test(h?.kind || '') ? 45 : 30)?.gpm ?? 0);
  const dflow = new Map();
  for (let k = tree.order.length - 1; k >= 0; k--) {
    const n = tree.order[k];
    dflow.set(n.id, (n.kind === 'head' ? designOf(heads.get(n.id)) : 0) + (kids.get(n.id) || []).reduce((t, c) => t + dflow.get(c.id), 0));
  }
  const pipeOf = new Map();
  for (const n of tree.order) if (n.parent !== null) pipeOf.set(n.id, (z.size && pipeById(z.size)) || sizeFor(z.family, dflow.get(n.id)));
  // start every head at its chart's flow at the pressure given
  const q = new Map();
  for (const n of tree.nodes) if (n.kind === 'head') q.set(n.id, water(heads.get(n.id), up.psi)?.gpm ?? 0);
  let res = null;
  for (let it = 0; it < maxIter; it++) {
    // flows down each run
    const flow = new Map();
    for (let k = tree.order.length - 1; k >= 0; k--) {
      const n = tree.order[k];
      const own = n.kind === 'head' ? q.get(n.id) : 0;
      flow.set(n.id, own + (kids.get(n.id) || []).reduce((s, c) => s + flow.get(c.id), 0));
    }
    const Q = flow.get('valve');
    // the valve's pressure: the gauge's, less what comes before it, less the valve, plus the fall to it
    const before = up.upstream ? up.upstream(Q) : 0;
    const valveLoss = deviceLoss(z.valve, Q);
    const p = new Map();
    p.set('valve', up.psi - before - valveLoss + PSI_PER_FT * (g0 - hNode(byId.get('valve'))));
    const runs = [];
    for (const n of tree.order) {
      if (n.parent === null) continue;
      const parent = byId.get(n.parent), f = flow.get(n.id);
      const pipe = pipeOf.get(n.id);
      const C = pipe.C * (z.cFactor ?? 1);
      const loss = frictionPerFt(pipe.idIn, C, f) * n.lenFt * (1 + FITTINGS_SHARE);
      p.set(n.id, p.get(parent.id) - loss + PSI_PER_FT * (hNode(parent) - hNode(n)));
      runs.push({ id: n.id, from: parent.id, pipe, gpm: f, fps: fps(pipe.idIn, f), lossPsi: loss, lenFt: n.lenFt });
    }
    // each head: through its swing joint and up to the nozzle; its flow at that pressure
    let change = 0;
    const out = new Map();
    for (const n of tree.nodes) {
      if (n.kind !== 'head') continue;
      const qh = q.get(n.id);
      const sw = z.swing || { lenFt: 1.5, fittingsFt: 2 };
      const swingLoss = frictionPerFt(PIPE_FAMILIES.swing.sizes[0][2], PIPE_FAMILIES.swing.C * (z.cFactor ?? 1), qh) * (sw.lenFt + sw.fittingsFt);
      const psi = p.get(n.id) - swingLoss + PSI_PER_FT * (hNode(n) - hNozzle(n));
      const w = water(heads.get(n.id), Math.max(0, psi));
      const next = w ? w.gpm : 0;
      change = Math.max(change, Math.abs(next - qh));
      q.set(n.id, qh + 0.6 * (next - qh)); // damped: the flows and pressures settle together
      out.set(n.id, { psi, gpm: next, radiusFt: w?.radiusFt ?? null, water: w, swingLoss });
    }
    res = { gpm: Q, valvePsi: p.get('valve'), upstreamPsi: before, valveLoss, heads: out, runs, pressures: p, iterations: it + 1 };
    if (change < tol) break;
  }
  // the farthest head (lowest pressure): its worksheet, from the gauge to the nozzle
  let worst = null;
  for (const [id, h] of res.heads) if (!worst || h.psi < worst.psi) worst = { id, ...h };
  const ps = [...res.heads.values()].map((h) => h.psi);
  res.spread = ps.length ? (Math.max(...ps) - Math.min(...ps)) / Math.max(1e-9, Math.max(...ps)) : 0;
  if (worst) {
    const path = [];
    for (let n = byId.get(worst.id); n && n.parent !== null; n = byId.get(n.parent)) path.unshift(n.id);
    const lateral = res.runs.filter((r) => path.includes(r.id)).reduce((s, r) => s + r.lossPsi, 0);
    const n = byId.get(worst.id);
    res.worksheet = {
      head: worst.id, gauge: up.psi, upstream: res.upstreamPsi, valve: res.valveLoss, lateral, swing: worst.swingLoss,
      elevation: PSI_PER_FT * (g0 - hNozzle(n)), atHead: worst.psi, flat,
    };
  }
  return res;
}

/* ---------------------------------------------------------------- the questionnaire */

/**
 * Scale and rust (owner: "possibly scale/rust buildup frictional losses (optional, with a questionnaire...)").
 * The research (lib/hydraulics/PRACTICE.md 3d) found no maker or study that gives a number for scale in PVC or
 * PE, or for its effect on nozzles or valves -- Rain Bird's tables use one C, unaged -- so the answers leave
 * plastic alone. Metal pipe (a copper or galvanized line from the street) is aged by METAL_AGED when the water
 * is hard or rusty.
 */
export const METAL_AGED = { soft: 1, moderate: 1, hard: 1, veryHard: 1, unknown: 1, iron: 1 };
export function cFactors(answers = {}) {
  const hard = METAL_AGED[answers.hardness] ?? 1;
  const metal = Math.min(hard, answers.orange ? METAL_AGED.iron : 1);
  return { metal, plastic: 1 };
}

/* ------------------------------------------------------------------- a head's flow */

/** Nozzle flow grows with the square root of the pressure (the orifice law): q = k P^NOZZLE_EXP. */
export const NOZZLE_EXP = 0.5;

/**
 * A head's water at the pressure at its inlet: its chart (lib/heads.js headWater), and beyond the chart's
 * pressures its flow by the orifice law from the nearest row (the throw held at that row's).
 * -> headWater's answer plus { inletPsi, nozzlePsi (after a pressure-regulating body), status:
 *    'ok' | 'low' (under the chart: short throw) | 'high' (over it: misting) }
 */
export function headFlow(head, cat, inletPsi) {
  const body = cat.body(head?.body), fam = cat.familyOfNozzle(head?.nozzle), n = cat.nozzle(head?.nozzle);
  if (!n || !fam) return null;
  const p = Math.max(0.1, fam.pressureIs === 'inlet' ? inletPsi : headPsi(body, inletPsi));
  const w = headWater(head, cat, p);
  if (!w) return null;
  const rows = n.rows.filter((r) => Number.isFinite(r.psi)).map((r) => r.psi);
  const lo = Math.min(...rows), hi = Math.max(...rows);
  let gpm = w.gpm;
  if (w.outside && w.psi > 0) gpm *= (p / w.psi) ** NOZZLE_EXP;
  const regulated = Number.isFinite(body?.regulatedPsi) && fam.pressureIs !== 'inlet';
  const status = p < lo - 0.5 ? 'low' : p > hi + 0.5 && !regulated ? 'high' : 'ok';
  return { ...w, gpm, inletPsi, nozzlePsi: p, chartLo: lo, chartHi: hi, regulated, status };
}
