/**
 * FRONT, BACK AND SIDES, WORKED OUT FROM THE ADDRESS (owner, 2026-10-28,
 * docs/TODO.md "sections cut automatically"). The rule, in the order it runs:
 *
 *  1. The house faces the street in its address. A rectangle is fitted to
 *     the building outline; of its four sides, the facade is the one that
 *     faces the nearest point of that street most directly. When two sides
 *     tie (a house set at an angle to a corner faces both streets equally)
 *     the direction to the street corner decides, which picks the side that
 *     faces the corner.
 *  2. The front line is the building's own forward edge, stepped: on each
 *     flank, the front edge of the building corner nearest that flank is
 *     carried out to the lot line. Lawn in front of that is FRONT. The
 *     owner's two drawings both do this (a garage wing projects its own
 *     line, the main house its own).
 *  3. The back line the same way, from the rear edge. Lawn behind it is
 *     BACK. Between the lines, on each flank, is a SIDE.
 *  4. On a corner lot whose house flank runs along the side street (within
 *     30 degrees), the side yard along that street runs the full depth of
 *     the lot, bounded inward by the house's wall line, and the back yard
 *     stops there. A house set at an angle to the corner skips this: the
 *     strip would be a diagonal nonsense.
 *  5. The barrier rule: a piece of side lawn that is walled off from the
 *     back lawn by something that is not lawn (a driveway, a patio) but
 *     joins the front lawn goes with the front; the other way round, with
 *     the back. A fence across grass is not seen: the trace does not stop
 *     at fences.
 *
 * Pure: [lng, lat] in and out, `clip` is polygon-clipping, passed in so the
 * tests run it in node. The roads and buildings are Overture's (lib/
 * overture.js overtureFor, with `name` on each road). Tests in
 * tools/yards.test.js.
 */

import { makeFrame, openRing } from './edges.js';

/* ------------------------------------------------------------ street names */

const WORDS = {
  st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', dr: 'drive', ct: 'court', ln: 'lane', blvd: 'boulevard',
  pl: 'place', cir: 'circle', trl: 'trail', ter: 'terrace', terr: 'terrace', pkwy: 'parkway', hwy: 'highway',
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  mt: 'mount', ft: 'fort', sq: 'square', xing: 'crossing', hts: 'heights', pt: 'point', ext: 'extension',
};
const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

/** A street name as words, abbreviations spelt out: "Burton St SE" -> ['burton', 'street', 'southeast']. */
export function streetWords(name) {
  return String(name || '').toLowerCase().replace(/[.,#'"()]/g, ' ').split(/\s+/).filter(Boolean).map((w) => WORDS[w] || w);
}

/** The street in an address: "1234 Example St SE, Anytown, MI" -> "Example St SE". Null when there is none. */
export function streetOf(address) {
  const first = String(address || '').split(',')[0].trim();
  const m = first.match(/^\s*\d+[a-z]?(?:\s*-\s*\d+)?\s+(.+)$/i);
  if (!m) return null;
  const rest = m[1].replace(/\s+(apt|unit|ste|suite|#)\s*\S*$/i, '').trim();
  return rest || null;
}

/** Do two street names name the same street? Directions count only when both have them. */
export function sameStreet(a, b) {
  const A = streetWords(a); const B = streetWords(b);
  if (!A.length || !B.length) return false;
  if (A.join(' ') === B.join(' ')) return true;
  const core = (w) => w.filter((x) => !DIRECTIONS.has(x)).join(' ');
  const ca = core(A); const cb = core(B);
  if (!ca || ca !== cb) return false;
  const da = A.filter((x) => DIRECTIONS.has(x)).join(' '); const db = B.filter((x) => DIRECTIONS.has(x)).join(' ');
  return !da || !db || da === db;
}

/* --------------------------------------------------------------- geometry */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const perp = (a) => [-a[1], a[0]];

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a) / 2;
}
const multiArea = (m) => m.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);

function convexHull(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = []; for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = []; for (const p of [...P].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest rectangle round a set of points: its centre and its two axes (unit vectors). */
export function fitRectangle(pts) {
  const hull = convexHull(pts);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const u = unit(sub(hull[(i + 1) % hull.length], hull[i]));
    if (!len(u)) continue;
    const v = perp(u);
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (const p of hull) { const a = dot(p, u); const b = dot(p, v); if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < v0) v0 = b; if (b > v1) v1 = b; }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, u, v, centre: add(mul(u, (u0 + u1) / 2), mul(v, (v0 + v1) / 2)) };
  }
  return best;
}

/** The nearest point of a polyline to p, with the line's direction there. */
function nearestOn(lines, p) {
  let best = null;
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]; const b = line[i];
    const ab = sub(b, a); const L = dot(ab, ab);
    const t = L ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L)) : 0;
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (!best || d < best.d) best = { d, at: q, dir: unit(ab) };
  }
  return best;
}

/** Where two polylines cross, nearest to p, or null. */
function crossingNear(linesA, linesB, p) {
  let best = null;
  for (const A of linesA) for (let i = 1; i < A.length; i++) for (const B of linesB) for (let j = 1; j < B.length; j++) {
    const a = A[i - 1]; const r = sub(A[i], a); const c = B[j - 1]; const s = sub(B[j], c);
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) continue;
    const ac = sub(c, a);
    const t = (ac[0] * s[1] - ac[1] * s[0]) / den; const u = (ac[0] * r[1] - ac[1] * r[0]) / den;
    if (t < -0.02 || t > 1.02 || u < -0.02 || u > 1.02) continue;
    const q = add(a, mul(r, t));
    const d = len(sub(p, q));
    if (!best || d < best.d) best = { d, at: q };
  }
  return best;
}

/*
 * THE REGIONS ARE BUILT AS ONE RING EACH, not as unions of pieces. The
 * clipper is exact but brittle: a union of twenty swept quads with shared
 * edges at an angle threw "Unable to complete output ring" on the angled
 * house. So the front region is drawn directly: from far left along the
 * left flank's line, then along the building's forward silhouette, then
 * along the right flank's line to far right, and closed far forward. Work
 * is done in (lateral, forward) coordinates and rotated back.
 */

/** The building's silhouette seen from the front: for each run of lateral positions, the topmost edge. */
function silhouette(rings, L, F) {
  const edges = [];
  const ls = [];
  for (const ring of rings) {
    const r = openRing(ring).map((p) => [dot(p, L), dot(p, F)]);
    for (let i = 0; i < r.length; i++) {
      const a = r[i]; const b = r[(i + 1) % r.length];
      ls.push(a[0]);
      if (Math.abs(b[0] - a[0]) > 1e-9) edges.push(a[0] < b[0] ? [a, b] : [b, a]);
    }
  }
  const stops = [...new Set(ls.map((v) => Math.round(v * 1e6) / 1e6))].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const l0 = stops[i]; const l1 = stops[i + 1]; const mid = (l0 + l1) / 2;
    let top = null; let topF = -Infinity;
    for (const [a, b] of edges) {
      if (a[0] - 1e-9 > mid || b[0] + 1e-9 < mid) continue;
      const f = a[1] + ((b[1] - a[1]) * (mid - a[0])) / (b[0] - a[0]);
      if (f > topF) { topF = f; top = [a, b]; }
    }
    if (!top) continue;
    const at = (l) => top[0][1] + ((top[1][1] - top[0][1]) * (l - top[0][0])) / (top[1][0] - top[0][0]);
    out.push([l0, at(l0)], [l1, at(l1)]);
  }
  return out;
}

/** The region in front of the building (its silhouette, with the flank lines carried out), as x/y rings. */
function regionAhead(rings, L, F, fLeft, fRight, lmin, lmax, B) {
  const sil = silhouette(rings, L, F);
  const lf = [[-B, B], [-B, fLeft], [lmin, fLeft], ...sil, [lmax, fRight], [B, fRight], [B, B]];
  return [lf.map(([l, f]) => snap(add(mul(L, l), mul(F, f))))];
}

function rect(l0, l1, f0, f1, L, F) {
  const at = (l, f) => snap(add(mul(L, l), mul(F, f)));
  return [[at(l0, f0), at(l1, f0), at(l1, f1), at(l0, f1), at(l0, f0)]];
}

/* Coordinates to a tenth of a millimetre: near-coincident points are the clipper's bane. */
const snap = ([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];

const touches = (clip, a, b) => a.length && b.length && clip.union(a, b).length < a.length + b.length;

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compassOf([x, y]) {
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/* ------------------------------------------------------------------- the split */

/**
 * The lawn as front, back and sides.
 *
 *   parcel     the property line: a GeoJSON Feature or Polygon, or a ring
 *   buildings  Overture building outlines: [[outerRing, ...holes], ...] in [lng, lat]
 *   roads      [{ name, lines: [[[lng, lat], ...]], cls }]
 *   address    the map's address, for its street
 *   lawn       the lawn shapes: GeoJSON features or geometries
 *
 * Answers { sections: [{ name, poly }], info } with each section a
 * MultiPolygon in [lng, lat], or { error } when it cannot be worked out.
 */
export function autoYards(clip, { parcel, buildings, roads, address, lawn }) {
  const parcelRing = ringOf(parcel);
  if (!parcelRing) return { error: 'This map has no property line. Draw or find one in the Lawn Mapper first.' };
  const frame = makeFrame(centroid(parcelRing));
  const P = [openRing(parcelRing).map((q) => snap(frame.toXY(q)))];
  P[0].push(P[0][0]);

  /* The house: the building with the most of itself inside the lot. */
  let house = null; let houseIn = 0;
  for (const b of buildings || []) {
    const rings = (b || []).filter((r) => r?.length >= 4).map((r) => r.map((q) => snap(frame.toXY(q))));
    if (!rings.length) continue;
    let inside;
    try { inside = multiArea(clip.intersection([rings], P)); } catch { continue; }
    if (inside > houseIn) { houseIn = inside; house = rings; }
  }
  if (!house || houseIn < 20) return { error: 'No building outline was found on this lot, so there is no house to work the front out from.' };
  const houseArea = multiArea([house]);
  const verts = house.flatMap((r) => openRing(r));
  const box = fitRectangle(verts);
  if (!box) return { error: 'The building outline could not be read.' };
  const centre = box.centre;

  /* The street in the address, among the named roads. */
  const named = (roads || []).filter((r) => r.name && r.lines?.length && !['footway', 'sidewalk', 'crosswalk', 'path', 'steps', 'cycleway', 'driveway', 'parking_aisle'].includes(r.sub || r.cls));
  const inM = (r) => r.lines.map((line) => line.map(frame.toXY));
  const street = streetOf(address);
  let front = street ? named.filter((r) => sameStreet(r.name, street)) : [];
  let matched = front.length > 0;
  if (!front.length) {
    // No address, or no road by that name here: the named road nearest the lot.
    let best = null;
    for (const r of named) {
      const n = nearestOn(inM(r), centre);
      if (n && (!best || n.d < best.d)) best = { d: n.d, name: r.name };
    }
    if (!best) return { error: 'No named street was found near this lot.' };
    front = named.filter((r) => r.name === best.name);
  }
  const frontName = front[0].name;
  const frontLines = front.flatMap(inM);
  const near = nearestOn(frontLines, centre);
  if (!near) return { error: 'The street could not be placed.' };

  /* The other street of a corner lot, if any: a different name, within 20 m of the lot. */
  const others = named.filter((r) => !sameStreet(r.name, frontName));
  let side = null;
  for (const r of others) {
    const lines = inM(r);
    let d = Infinity;
    for (const q of P[0]) { const n = nearestOn(lines, q); if (n && n.d < d) d = n.d; }
    if (d <= 20 && (!side || d < side.d)) side = { d, name: r.name, lines };
  }
  const corner = side ? crossingNear(frontLines, side.lines, centre) : null;

  /* Which rectangle side is the facade. */
  const toStreet = unit(sub(near.at, centre));
  const normals = [box.u, mul(box.u, -1), box.v, mul(box.v, -1)];
  let scored = normals.map((n) => ({ n, s: dot(n, toStreet) })).sort((a, b) => b.s - a.s);
  let tiedToCorner = false;
  if (corner && scored[0].s - scored[1].s < 0.25) {
    const toCorner = unit(sub(corner.at, centre));
    scored = normals.map((n) => ({ n, s: dot(n, toCorner) })).sort((a, b) => b.s - a.s);
    tiedToCorner = true;
  }
  const F = scored[0].n; // forward: from the house to its street
  const L = perp(F); // lateral

  /* The building's extent across and the stepped front and back lines. */
  const fv = verts.map((p) => dot(p, F)); const lv = verts.map((p) => dot(p, L));
  const Lmin = Math.min(...lv); const Lmax = Math.max(...lv);
  const TOL = Math.max(1.5, (Lmax - Lmin) * 0.08);
  const atLeft = verts.filter((p, i) => lv[i] <= Lmin + TOL).map((p, i) => dot(p, F));
  const atRight = verts.filter((p, i) => lv[i] >= Lmax - TOL).map((p, i) => dot(p, F));
  const frontLeft = Math.max(...atLeft); const backLeft = Math.min(...atLeft);
  const frontRight = Math.max(...atRight); const backRight = Math.min(...atRight);

  const B = Math.max(...P[0].map((q) => len(sub(q, centre)))) + 100;
  const frontRegion = regionAhead(house, L, F, frontLeft, frontRight, Lmin, Lmax, B);
  // The back: the same, looking the other way (the lateral axis flips with it).
  const Fb = mul(F, -1); const Lb = perp(Fb);
  let backRegion = regionAhead(house, Lb, Fb, -backRight, -backLeft, -Lmax, -Lmin, B);
  backRegion = clip.difference(backRegion, frontRegion);

  /* The corner lot's side strip. */
  let cornerStrip = null;
  if (side && !tiedToCorner) {
    const ns = nearestOn(side.lines, centre);
    const toSide = unit(sub(ns.at, centre));
    const flank = dot(L, toSide) >= 0 ? 'right' : 'left';
    const faces = Math.abs(dot(L, toSide)) > 0.5; // the side street is off a flank, not behind
    const along = Math.abs(dot(ns.dir, F)) > Math.cos((30 * Math.PI) / 180); // the flank wall runs with it
    if (faces && along) {
      cornerStrip = flank === 'right' ? rect(Lmax, B, -B, frontRight, L, F) : rect(-B, Lmin, -B, frontLeft, L, F);
      backRegion = clip.difference(backRegion, cornerStrip);
    }
  }

  /* The lawn, cut. */
  const lawnM = lawnPolys(lawn).map((poly) => poly.map((r) => r.map((q) => snap(frame.toXY(q)))));
  if (!lawnM.length) return { error: 'This map has no lawn yet.' };
  let whole;
  try { whole = clip.union(...lawnM.map((p) => [p])); } catch { return { error: 'The lawn shapes could not be read.' }; }
  let frontLawn = clip.intersection(whole, frontRegion);
  let backLawn = clip.intersection(whole, backRegion);
  let sideLawn = clip.difference(whole, frontRegion, backRegion);

  /* The barrier rule, piece by piece. */
  const keep = [];
  for (const piece of sideLawn) {
    const p = [piece];
    const f = touches(clip, p, frontLawn); const b = touches(clip, p, backLawn);
    if (f && !b) frontLawn = clip.union(frontLawn, p);
    else if (b && !f) backLawn = clip.union(backLawn, p);
    else keep.push(piece);
  }
  sideLawn = keep;

  /* Sides by flank, named by the compass. */
  const left = []; const right = [];
  for (const piece of sideLawn) {
    const c = centroid(piece[0]);
    (dot(c, L) < dot(centre, L) ? left : right).push(piece);
  }
  const out = [];
  const toLL = (multi) => multi.map((poly) => poly.map((r) => r.map(frame.toLngLat)));
  if (frontLawn.length) out.push({ name: 'Front', poly: toLL(frontLawn) });
  if (backLawn.length) out.push({ name: 'Back', poly: toLL(backLawn) });
  if (left.length) out.push({ name: `Side (${compassOf(mul(L, -1))})`, poly: toLL(left) });
  if (right.length) out.push({ name: `Side (${compassOf(L)})`, poly: toLL(right) });

  return {
    sections: out,
    info: {
      street: frontName, matched, sideStreet: side?.name || null, corner: Boolean(corner), facesCorner: tiedToCorner,
      cornerStrip: Boolean(cornerStrip), facing: compassOf(F), houseSqM: Math.round(houseArea),
    },
  };
}

/* ------------------------------------------------------------------ helpers */

function ringOf(parcel) {
  const g = parcel?.geometry || parcel;
  if (Array.isArray(g) && g.length >= 4 && Array.isArray(g[0])) return g;
  if (g?.type === 'Polygon') return g.coordinates[0];
  if (g?.type === 'MultiPolygon') return g.coordinates[0]?.[0] || null;
  return null;
}

function centroid(ring) {
  const r = openRing(ring);
  let x = 0; let y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

function lawnPolys(lawn) {
  const out = [];
  for (const s of lawn || []) {
    const g = s?.geometry || s;
    if (g?.type === 'Polygon' && g.coordinates?.[0]?.length >= 4) out.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') for (const p of g.coordinates) if (p?.[0]?.length >= 4) out.push(p);
  }
  return out;
}
