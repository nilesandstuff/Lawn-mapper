/**
 * SPRINKLER HEADS (water session; owner, 2026-10-20: "add sprinkler mapping ... a step that happens before
 * doing anything else within the water map"). The pure part, shared by the page and the tests:
 *
 *   the catalogue   lib/heads/*.json, transcribed from the makers' performance charts (SCHEMA.md there)
 *   a head's water  its nozzle's radius and flow at the pressure it gets, for its arc
 *   a zone's water  the heads on one valve: flow, precipitation rate, the line it needs
 *   pipes           what a line carries at 5 ft/s, and its friction loss (Hazen-Williams)
 *   GPS             a calibration on a spot the person can stand on exactly, then each head averaged
 *
 * Positions are [lng, lat]; distances on the ground are metres, a lawn's scale.
 */

/* ---------------------------------------------------------------- the catalogue */

/** The catalogue from its JSON files -> { bodies, families, body(id), family(id), nozzle(id), brands }. */
export function catalogue(files) {
  const bodies = [], families = [], byNozzle = new Map(), famOf = new Map();
  for (const f of files) {
    if (!f) continue;
    for (const b of f.bodies || []) if (b?.id && !bodies.some((x) => x.id === b.id)) bodies.push(b);
    for (const fam of f.families || []) {
      if (!fam?.id || families.some((x) => x.id === fam.id)) continue;
      const nozzles = (fam.nozzles || []).filter((n) => n?.id && Array.isArray(n.rows) && n.rows.some(rowOk));
      const clean = { ...fam, nozzles };
      families.push(clean);
      for (const n of nozzles) { byNozzle.set(n.id, n); famOf.set(n.id, clean); }
    }
  }
  const famById = new Map(families.map((f) => [f.id, f]));
  const bodyById = new Map(bodies.map((b) => [b.id, b]));
  const brands = [...new Set(bodies.map((b) => b.brand))].sort();
  return {
    bodies, families, brands,
    body: (id) => bodyById.get(id) || null,
    family: (id) => famById.get(id) || null,
    nozzle: (id) => byNozzle.get(id) || null,
    familyOfNozzle: (id) => famOf.get(id) || null,
    /** The families a body takes (its swappable families, or its own built-in nozzles). */
    familiesFor(bodyId) {
      const b = bodyById.get(bodyId);
      if (!b) return [];
      const ids = [...(b.nozzleFamilies || []), ...(b.fixedNozzles ? [b.fixedNozzles] : [])];
      return ids.map((id) => famById.get(id)).filter(Boolean);
    },
  };
}

/** A chart row with a flow and a throw (a radius, or a strip's length). */
const rowOk = (r) => Number.isFinite(r?.psi) && Number.isFinite(r?.gpm) && (Number.isFinite(r?.radiusFt) || Number.isFinite(r?.lengthFt));
const lerp = (a, b, t) => (Number.isFinite(a) && Number.isFinite(b) ? a + t * (b - a) : Number.isFinite(a) ? a : b ?? null);

/** A nozzle's chart at `psi`: linear between the chart's rows, held at its ends.
    -> { psi, radiusFt, gpm, widthFt, lengthFt (strips), outside } */
export function rowAt(nozzle, psi, rows0 = nozzle.rows) {
  const rows = rows0.filter(rowOk).sort((a, b) => a.psi - b.psi);
  if (!rows.length) return null;
  const pick = (r, p, outside) => ({ psi: p, radiusFt: r.radiusFt ?? null, gpm: r.gpm, widthFt: r.widthFt ?? null, lengthFt: r.lengthFt ?? null, outside });
  if (!Number.isFinite(psi)) psi = rows[Math.floor((rows.length - 1) / 2)].psi;
  if (psi <= rows[0].psi) return pick(rows[0], rows[0].psi, psi < rows[0].psi);
  const last = rows[rows.length - 1];
  if (psi >= last.psi) return pick(last, last.psi, psi > last.psi);
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    if (psi <= b.psi) {
      const t = (psi - a.psi) / (b.psi - a.psi);
      return { psi, radiusFt: lerp(a.radiusFt, b.radiusFt, t), gpm: lerp(a.gpm, b.gpm, t), widthFt: lerp(a.widthFt, b.widthFt, t), lengthFt: lerp(a.lengthFt, b.lengthFt, t), outside: false };
    }
  }
  return pick(last, last.psi, false);
}

/**
 * An adjustable nozzle whose chart prints a table per arc (its flow is not in proportion to the arc: a
 * 4-VAN puts out more per degree at 90 than at 330): its flow at `arc`, linear between the printed arcs,
 * in proportion beyond them. -> { gpm, radiusFt, ... } for the arc itself, or null
 */
export function rowAtArc(nozzle, psi, arc) {
  const tables = (nozzle.printedByArc || []).filter((t) => Number.isFinite(t.arcDeg) && t.rows?.some(rowOk)).sort((a, b) => a.arcDeg - b.arcDeg);
  if (!tables.length) return null;
  const at = tables.map((t) => ({ arc: t.arcDeg, row: rowAt(nozzle, psi, t.rows) }));
  if (arc <= at[0].arc) return { ...at[0].row, gpm: (at[0].row.gpm * arc) / at[0].arc };
  const last = at[at.length - 1];
  if (arc >= last.arc) return { ...last.row, gpm: (last.row.gpm * arc) / last.arc };
  for (let k = 1; k < at.length; k++) {
    if (arc <= at[k].arc) {
      const a = at[k - 1], b = at[k], t = (arc - a.arc) / (b.arc - a.arc);
      return { ...b.row, gpm: lerp(a.row.gpm, b.row.gpm, t), radiusFt: lerp(a.row.radiusFt, b.row.radiusFt, t) };
    }
  }
  return null;
}

/** The pressure a head works at: the zone's, held down by a pressure-regulated body. */
export function headPsi(body, zonePsi) {
  const reg = body?.regulatedPsi;
  if (Number.isFinite(reg) && Number.isFinite(zonePsi)) return Math.min(reg, zonePsi);
  return Number.isFinite(zonePsi) ? zonePsi : Number.isFinite(reg) ? reg : null;
}

/** The arc a head waters, degrees: the nozzle's fixed pattern, else what was set, within the nozzle's range. */
export function arcOf(head, nozzle) {
  if (Number.isFinite(nozzle?.arcFixed)) return nozzle.arcFixed;
  const lo = Number.isFinite(nozzle?.arcMin) ? nozzle.arcMin : 1, hi = Number.isFinite(nozzle?.arcMax) ? nozzle.arcMax : 360;
  const a = Number.isFinite(head?.arc) ? head.arc : hi;
  return Math.max(lo, Math.min(hi, a));
}

/**
 * One head's water. head: { body, nozzle, arc }; cat: catalogue(); psi: at the zone.
 * -> { gpm, radiusFt, arc, psi, precipInH (head-to-head square spacing), kind, outside } or null
 */
export function headWater(head, cat, psi) {
  const n = cat.nozzle(head?.nozzle), fam = cat.familyOfNozzle(head?.nozzle), body = cat.body(head?.body);
  if (!n || !fam) return null;
  // a chart printed by the pressure coming in (Rain Bird's 5000 PRS) already has the regulator in it
  const p = fam.pressureIs === 'inlet' ? psi : headPsi(body, psi);
  const row = rowAt(n, p);
  if (!row) return null;
  // a strip: a rectangle, its flow as printed
  if (n.strip) {
    const L = row.lengthFt ?? n.strip.lengthFt, W = row.widthFt ?? n.strip.widthFt;
    return { gpm: row.gpm, radiusFt: L, arc: null, strip: { type: n.strip.type, corner: n.strip.corner ?? null, widthFt: W, lengthFt: L }, psi: row.psi, precipInH: L > 0 && W > 0 ? (96.25 * row.gpm) / (L * W) : null, kind: fam.kind, outside: row.outside };
  }
  const arc = arcOf(head, n);
  const byArc = fam.flow !== 'constant' && !Number.isFinite(n.arcFixed) ? rowAtArc(n, p, arc) : null;
  const gpm = byArc ? byArc.gpm : fam.flow === 'constant' ? row.gpm : (row.gpm * arc) / 360;
  const radiusFt = byArc?.radiusFt ?? row.radiusFt;
  // the gpm a full circle of this throw would carry: the rate it lays down, at head-to-head spacing
  const full = (gpm * 360) / arc;
  return { gpm, radiusFt, arc, psi: row.psi, precipInH: (96.25 * full) / (radiusFt * radiusFt), kind: fam.kind, outside: row.outside };
}

/**
 * The heads on one valve. -> { heads, gpm, precipInH (the heads' median), kinds, mixed (sprays with rotors:
 * they lay water down at very different rates), unknown (heads with no nozzle chosen) }
 */
export function zoneWater(heads, cat, psi) {
  const ws = heads.map((h) => headWater(h, cat, psi));
  const known = ws.filter(Boolean);
  const pr = known.map((w) => w.precipInH).sort((a, b) => a - b);
  const kinds = [...new Set(known.map((w) => (w.kind === 'rotor' || w.kind === 'impact' ? 'rotor' : w.kind === 'rotary' ? 'rotary' : 'spray')))];
  return {
    heads: heads.length, gpm: known.reduce((s, w) => s + w.gpm, 0),
    precipInH: pr.length ? pr[Math.floor((pr.length - 1) / 2)] : null,
    kinds, mixed: kinds.includes('spray') && kinds.length > 1, unknown: ws.length - known.length,
  };
}

/* ------------------------------------------------------------------------ pipes */

/**
 * Line presets: inside diameters (in) from the standards each is made to (PVC Sch 40 ASTM D1785; PVC
 * Class 200 SDR 21 ASTM D2241; polyethylene SIDR-15 ASTM D2239, made to Sch 40's inside diameter; PEX
 * SDR 9 ASTM F876; copper type L / K ASTM B88), and Hazen-Williams C.
 */
export const PIPES = [
  { id: 'pe-050', label: '1/2 in poly (black roll pipe)', idIn: 0.622, C: 150 },
  { id: 'pe-075', label: '3/4 in poly (black roll pipe)', idIn: 0.824, C: 150 },
  { id: 'pe-100', label: '1 in poly (black roll pipe)', idIn: 1.049, C: 150 },
  { id: 'pe-125', label: '1 1/4 in poly (black roll pipe)', idIn: 1.380, C: 150 },
  { id: 'pvc200-075', label: '3/4 in PVC Class 200', idIn: 0.930, C: 150 },
  { id: 'pvc200-100', label: '1 in PVC Class 200', idIn: 1.189, C: 150 },
  { id: 'pvc200-125', label: '1 1/4 in PVC Class 200', idIn: 1.502, C: 150 },
  { id: 'pvc200-150', label: '1 1/2 in PVC Class 200', idIn: 1.720, C: 150 },
  { id: 'pvc40-050', label: '1/2 in PVC Schedule 40', idIn: 0.622, C: 150 },
  { id: 'pvc40-075', label: '3/4 in PVC Schedule 40', idIn: 0.824, C: 150 },
  { id: 'pvc40-100', label: '1 in PVC Schedule 40', idIn: 1.049, C: 150 },
  { id: 'pvc40-125', label: '1 1/4 in PVC Schedule 40', idIn: 1.380, C: 150 },
  { id: 'pvc40-150', label: '1 1/2 in PVC Schedule 40', idIn: 1.610, C: 150 },
  { id: 'cu-l-075', label: '3/4 in copper (type L)', idIn: 0.785, C: 140 },
  { id: 'cu-l-100', label: '1 in copper (type L)', idIn: 1.025, C: 140 },
  { id: 'cu-k-075', label: '3/4 in copper (type K)', idIn: 0.745, C: 140 },
  { id: 'cu-k-100', label: '1 in copper (type K)', idIn: 0.995, C: 140 },
  { id: 'pex-075', label: '3/4 in PEX', idIn: 0.671, C: 150 },
  { id: 'pex-100', label: '1 in PEX', idIn: 0.862, C: 150 },
];
/** The supply line (backflow preventer to valve box) and the zone lines offer the same list. */
export const pipe = (id) => PIPES.find((p) => p.id === id) || null;

/** Irrigation practice keeps water in a line under 5 ft/s (water hammer, wear). */
export const MAX_FPS = 5;
/** gpm a line carries at `fps`: Q = 2.448 v d^2 (gpm, ft/s, in). */
export const gpmAt = (p, fps = MAX_FPS) => 2.448 * fps * p.idIn * p.idIn;
/** Speed of `gpm` in the line, ft/s. */
export const fpsOf = (p, gpm) => gpm / (2.448 * p.idIn * p.idIn);
/** Friction loss, psi per 100 ft (Hazen-Williams: 4.52 Q^1.852 / (C^1.852 d^4.87) psi per ft). */
export const psiPer100ft = (p, gpm) => (100 * 4.52 * gpm ** 1.852) / (p.C ** 1.852 * p.idIn ** 4.87);

/** A zone's line against its flow. -> { fps, capacityGpm, over, lossPer100 } */
export function lineCheck(pipeId, gpm) {
  const p = pipe(pipeId);
  if (!p || !(gpm > 0)) return null;
  return { fps: fpsOf(p, gpm), capacityGpm: gpmAt(p), over: fpsOf(p, gpm) > MAX_FPS, lossPer100: psiPer100ft(p, gpm) };
}

/* -------------------------------------------------------------------------- GPS */

const M_PER_DEG = 111320;
/** [lng, lat] -> metres east, north of `ref`. */
export function enu(ref, p) {
  return [(p[0] - ref[0]) * M_PER_DEG * Math.cos((ref[1] * Math.PI) / 180), (p[1] - ref[1]) * M_PER_DEG];
}
/** Metres east, north of `ref` -> [lng, lat]. */
export function unEnu(ref, [e, n]) {
  return [ref[0] + e / (M_PER_DEG * Math.cos((ref[1] * Math.PI) / 180)), ref[1] + n / M_PER_DEG];
}

/**
 * Where a run of fixes says the phone stood: their mean, after dropping fixes more than 2.5 times the
 * median distance from the first mean (a jump), weighted by the phone's own accuracy (1 / acc^2).
 * fixes: [{ lng, lat, acc (m) }] -> { at: [lng, lat], spreadM (RMS distance from it), n, dropped } or null
 */
export function settle(fixes, { near = null, withinM = 100 } = {}) {
  let ok = fixes.filter((f) => Number.isFinite(f.lng) && Number.isFinite(f.lat));
  // a fix far from where the person stands (before the GPS has locked on) is not a reading of it
  if (near) ok = ok.filter((f) => Math.hypot(...enu(near, [f.lng, f.lat])) <= withinM);
  // the coarse first fixes (from wifi or the cell tower) when better ones came in
  const fine = ok.filter((f) => (f.acc ?? 5) <= 30);
  if (fine.length) ok = fine;
  if (!ok.length) return null;
  const ref = [ok[0].lng, ok[0].lat];
  const pts = ok.map((f) => ({ xy: enu(ref, [f.lng, f.lat]), w: 1 / Math.max(1, f.acc || 5) ** 2 }));
  const mean = (list) => {
    const W = list.reduce((s, p) => s + p.w, 0);
    return [list.reduce((s, p) => s + p.w * p.xy[0], 0) / W, list.reduce((s, p) => s + p.w * p.xy[1], 0) / W];
  };
  let m = mean(pts);
  const d = pts.map((p) => Math.hypot(p.xy[0] - m[0], p.xy[1] - m[1])).sort((a, b) => a - b);
  const cut = Math.max(0.5, 2.5 * d[Math.floor((d.length - 1) / 2)]);
  const kept = pts.filter((p) => Math.hypot(p.xy[0] - m[0], p.xy[1] - m[1]) <= cut);
  if (kept.length) m = mean(kept);
  const spread = Math.sqrt(kept.reduce((s, p) => s + (p.xy[0] - m[0]) ** 2 + (p.xy[1] - m[1]) ** 2, 0) / Math.max(1, kept.length));
  return { at: unEnu(ref, m), spreadM: spread, n: kept.length, dropped: pts.length - kept.length };
}

/**
 * THE CALIBRATION (owner: "the user stands on a certain point on the property (like a driveway corner or
 * property line corner, so it's easy to recognize), so we can calibrate the offset and jitter of the gps").
 * known: the spot tapped on the map; fixes: the phone's while standing on it.
 * -> { offset: [east, north] m to add to a fix, offsetM, jitterM, n, at (when) } or null
 */
export function calibrate(known, fixes, at = Date.now()) {
  const s = settle(fixes, { near: known });
  if (!s) return null;
  const off = enu(s.at, known);
  return { offset: off, offsetM: Math.hypot(off[0], off[1]), jitterM: s.spreadM, n: s.n, at, ref: known };
}

/** A head dropped by GPS: its fixes settled, then moved by the calibration. -> { at: [lng, lat], spreadM } */
export function placeByGps(fixes, cal) {
  const s = settle(fixes);
  if (!s) return null;
  return { at: cal ? unEnu(s.at, cal.offset) : s.at, spreadM: s.spreadM };
}

/** A default direction for a part-circle head: the middle of its arc toward `toward` (the lawn's middle). */
export function facing(at, toward) {
  if (!toward) return 0;
  const [e, n] = enu(at, toward);
  return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360; // degrees clockwise from north
}
