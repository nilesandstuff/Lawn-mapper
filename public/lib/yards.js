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
 *
 *  5. SIDES ARE OPTIONAL (owner, after the first check, 2026-10-28: "the
 *     default should be to lump the side yard in with the front or back,
 *     depending on which it seems more connected to"). With `sides` off, a
 *     side goes with the front when nothing restricts it, and a BARRIER --
 *     ground that is not lawn (a driveway, a patio, a bed), or a SUDDEN
 *     pinch to under 3 ft -- cuts a side off: cut off from the back it goes
 *     with the front, cut off from the front it goes with the back, cut
 *     off from both it is secluded, and seclusion is what a back yard is.
 *     "Backyards have some degree of seclusion, front yards are what you
 *     show the world." With `sides` on, a side stays a side.
 *  6. A piece of lawn cut off from the main front and back lawns altogether
 *     (a fenced strip whose trace stops at the fence) is one thing, not
 *     three: it takes the label of most of itself. And a piece the line
 *     calls front that is walled off from the main front lawn and joined
 *     to the back's goes with the back (or the side, with sides on). The
 *     owner's first wrong mark was a strip like that, whose few feet in
 *     front of the house corner were counted as front.
 *  7. NO CLEAR ANSWER, NO ANSWER (owner: "the auto detect only works when
 *     there's a clear answer"): two sides of the house facing the street
 *     equally with no corner to decide; a house that does not face its
 *     street; a building straddling the lot line; no road named like the
 *     address on a lot with two streets. Each says why.
 *
 * Fences across grass are not seen: the trace does not stop at fences, and
 * neither does the lawn. Only a gap in the trace, or a pinch, is a barrier.
 *
 * Pure: [lng, lat] in and out, `clip` is polygon-clipping, passed in so the
 * tests run it in node. The roads and buildings are Overture's (lib/
 * overture.js themeIn, with `name` on each road). The pinch test is a
 * raster opening (lib/mask.js). Tests in tools/yards.test.js.
 */

import { makeFrame, openRing } from './edges.js';
import { rasterizePolygon, labelComponents, traceRegion } from './mask.js';

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
const polyArea = (p) => ringArea(p[0]) - p.slice(1).reduce((h, r) => h + ringArea(r), 0);
const multiArea = (m) => m.reduce((s, p) => s + polyArea(p), 0);

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

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compassOf([x, y]) {
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/* ---------------------------------------------------------- the pinch test */

/** The width under which a passage is a barrier: 3 ft (owner). */
export const PINCH_M = 0.914;

/**
 * The lawn as a grid of 10 cm cells (coarser on a big lot, so the grid stays
 * under about 1.5M cells), with the tools for the pinch rule: erode-and-
 * dilate within a mask removes every passage narrower than PINCH_M, and
 * what is left in one piece is what is joined by lawn wide enough to walk.
 */
function gridFor(whole, bounds) {
  const [x0, y0, x1, y1] = bounds;
  const cell = Math.max(0.1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 1.5e6));
  const W = Math.ceil((x1 - x0) / cell) + 4; const H = Math.ceil((y1 - y0) / cell) + 4;
  const project = ([x, y]) => [(x - x0) / cell + 2, (y - y0) / cell + 2];
  const unproject = ([px, py]) => [x0 + (px - 2) * cell, y0 + (py - 2) * cell];
  const r = Math.max(1, Math.round(PINCH_M / 2 / cell));
  const disc = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) disc.push([dx, dy]);
  const g = { W, H, cell, r, disc, project, unproject };
  g.raster = (poly) => rasterizePolygon(poly, W, H, project);
  g.rasterAll = (polys) => {
    const out = new Uint8Array(W * H);
    for (const poly of polys) { const m = g.raster(poly); for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 1; }
    return out;
  };
  /* Erode then dilate within `mask`, over its own bounding box. */
  g.open = (mask) => {
    let bx0 = W; let by0 = H; let bx1 = -1; let by1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const eroded = new Uint8Array(W * H);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      let all = true;
      for (const [dx, dy] of disc) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || !mask[yy * W + xx]) { all = false; break; }
      }
      eroded[i] = all ? 1 : 0;
    }
    const out = new Uint8Array(W * H);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      if (!eroded[y * W + x]) continue;
      for (const [dx, dy] of disc) {
        const xx = x + dx; const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) out[yy * W + xx] = 1;
      }
    }
    return out;
  };
  /* How many cells of `a` sit beside a cell of `b` (4-neighbours: a jagged
     edge must not count twice): the length of their seam, in cells. */
  g.seam = (a, b) => {
    let n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!a[i]) continue;
      if (b[i] || b[i - 1] || b[i + 1] || b[i - W] || b[i + W]) n++;
    }
    return n;
  };
  /* The longest run of seam between `a` and `b`, in cells: the extent of
     the biggest cluster of a's cells beside b, not their count, because a
     cut traced on the grid is a staircase that counts every step twice. */
  g.seamLength = (a, b) => {
    const seam = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (a[i] && (b[i] || b[i - 1] || b[i + 1] || b[i - W] || b[i + W])) seam[i] = 1;
    }
    const { labels, sizes } = labelComponents(seam, W, H);
    const box = sizes.map(() => [W, H, -1, -1]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const id = labels[y * W + x];
      if (!id) continue;
      const b0 = box[id];
      if (x < b0[0]) b0[0] = x; if (y < b0[1]) b0[1] = y; if (x > b0[2]) b0[2] = x; if (y > b0[3]) b0[3] = y;
    }
    let best = 0;
    for (let id = 1; id < box.length; id++) best = Math.max(best, Math.hypot(box[id][2] - box[id][0] + 1, box[id][3] - box[id][1] + 1));
    return best;
  };
  /* A seam shorter than the pinch width is no connection. */
  g.joined = (a, b) => g.seamLength(a, b) >= Math.max(3, PINCH_M / cell);
  /* A component of a mask, grown by one cell, as a ring in metres. */
  g.ringOf = (region) => {
    const grown = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!region[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) grown[yy * W + xx] = 1;
      }
    }
    const px = traceRegion(grown, W, H);
    if (!px || px.length < 3) return null;
    // Cell corners, not centres, so the ring covers the cells whole.
    const ring = px.map(([x, y]) => snap(unproject([x + 0.5, y + 0.5])));
    ring.push(ring[0]);
    return [ring];
  };
  return g;
}

/** How many of a mask's cells fall under each label. */
function cellsByLabel(mask, labels) {
  const by = new Map();
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    total++;
    const id = labels[i];
    if (id) by.set(id, (by.get(id) || 0) + 1);
  }
  return { by, total };
}

/**
 * A piece with a neck narrower than PINCH_M is two pieces (the owner:
 * "SUDDEN pinch points seriously restrict, to less than 3 feet wide").
 * The neck is what opening the piece removes; a neck that parts the piece
 * is cut out along a one-cell margin, and the neck itself goes to the
 * bigger part so nothing is lost. Answers the parts, or [piece] whole.
 */
function splitAtNecks(clip, piece, g) {
  const mask = g.raster(piece.poly);
  const opened = g.open(mask);
  const necks = new Uint8Array(g.W * g.H);
  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i] && !opened[i]) { necks[i] = 1; any = true; }
  if (!any) return [piece];
  const { labels: nl, sizes: ns } = labelComponents(necks, g.W, g.H);
  let polys = [piece.poly];
  const thin = [];
  let cut = false;
  for (let id = 1; id < ns.length; id++) {
    if (ns[id] < 4) continue;
    const region = new Uint8Array(g.W * g.H);
    for (let i = 0; i < nl.length; i++) if (nl[i] === id) region[i] = 1;
    const ring = g.ringOf(region);
    if (!ring) continue;
    let after; let taken;
    try { after = clip.difference(polys, ring); taken = clip.intersection(polys, ring); } catch { continue; }
    if (after.length < polys.length || !taken.length) continue;
    if (after.length > polys.length) {
      // A neck between two parts: the neck itself goes to the biggest part it touches.
      after.sort((a, b) => polyArea(b) - polyArea(a));
      for (const t of taken) {
        for (let k = 0; k < after.length; k++) {
          let u;
          try { u = clip.union([after[k]], [t]); } catch { u = null; }
          if (u && u.length === 1) { after[k] = u[0]; break; }
        }
      }
    } else {
      // A thin appendix, under 3 ft wide throughout: restricted lawn, kept
      // apart so it can go with whatever it is joined to most (the owner's
      // fenced strip's few feet in front of the house corner).
      if (multiArea(taken) < 0.3) continue;
      for (const t of taken) thin.push(t);
    }
    polys = after;
    cut = true;
  }
  if (!cut) return [piece];
  return [
    ...polys.map((p) => ({ ...piece, poly: p, area: polyArea(p) })),
    ...thin.map((p) => ({ ...piece, poly: p, area: polyArea(p), thin: true })),
  ];
}

/* ------------------------------------------------------------------- the split */

/**
 * The lawn as front, back and (optionally) sides.
 *
 *   parcel     the property line: a GeoJSON Feature or Polygon, or a ring
 *   buildings  Overture building outlines: [[outerRing, ...holes], ...] in [lng, lat]
 *   roads      [{ name, lines: [[[lng, lat], ...]], cls, sub }]
 *   address    the map's address, for its street; or `street`, the street itself
 *   point      [lng, lat] the map was made at: which building is the house
 *   lawn       the lawn shapes: GeoJSON features or geometries
 *   sides      keep the sides as sections of their own (default: lump them)
 *
 * Answers { sections: [{ name, poly }], info } with each section a
 * MultiPolygon in [lng, lat]; { error, unclear: true, info } when there is
 * no clear answer; { error } when the data is not there.
 */
export function autoYards(clip, { parcel, buildings, roads, address, street, point, lawn, sides = false }) {
  const parcelRing = ringOf(parcel);
  if (!parcelRing) return { error: 'This map has no property line. Draw or find one in the Lawn Mapper first.' };
  const frame = makeFrame(centroid(parcelRing));
  const P = [openRing(parcelRing).map((q) => snap(frame.toXY(q)))];
  P[0].push(P[0][0]);
  const at = point && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? frame.toXY(point) : null;

  /* THE HOUSE. Every building mostly on the lot is a candidate; the one
     nearest the map's point wins (the point is the address, and a barn
     bigger than the house sits away from it: the owner's fourth wrong
     mark). With no point, the biggest. */
  const candidates = [];
  for (const b of buildings || []) {
    const rings = (b || []).filter((r) => r?.length >= 4).map((r) => r.map((q) => snap(frame.toXY(q))));
    if (!rings.length) continue;
    let inside;
    try { inside = multiArea(clip.intersection([rings], P)); } catch { continue; }
    if (inside < 20) continue;
    const area = multiArea([rings]);
    const box = fitRectangle(rings.flatMap((r) => openRing(r)));
    if (!box) continue;
    candidates.push({ rings, inside, area, share: inside / area, box });
  }
  if (!candidates.length) return { error: 'No building outline was found on this lot, so there is no house to work the front out from.' };
  const onLot = candidates.filter((c) => c.share >= 0.5);
  let chosen;
  if (!onLot.length) chosen = candidates.sort((a, b) => b.inside - a.inside)[0];
  else if (at) chosen = onLot.sort((a, b) => len(sub(a.box.centre, at)) - len(sub(b.box.centre, at)))[0];
  else chosen = onLot.sort((a, b) => b.inside - a.inside)[0];
  const house = chosen.rings; const box = chosen.box; const centre = box.centre;
  const verts = house.flatMap((r) => openRing(r));
  const otherBuilding = onLot.some((c) => c !== chosen && c.area >= 0.6 * chosen.area);
  const info = { houseSqM: Math.round(chosen.area), houseShare: Math.round(chosen.share * 100) / 100, otherBuilding, sides: Boolean(sides) };
  const unclear = (why) => ({ error: `No clear answer: ${why}`, unclear: true, info: { ...info, unclear: why } });
  if (chosen.share < 0.5) return unclear('the building outline straddles the lot line.');

  /* THE STREET in the address, among the named roads. */
  const named = (roads || []).filter((r) => r.name && r.lines?.length && !['footway', 'sidewalk', 'crosswalk', 'path', 'steps', 'cycleway', 'driveway', 'parking_aisle'].includes(r.sub || r.cls));
  const inM = (r) => r.lines.map((line) => line.map(frame.toXY));
  const wanted = street || streetOf(address);
  info.hadStreet = Boolean(wanted);
  let front = wanted ? named.filter((r) => sameStreet(r.name, wanted)) : [];
  const matched = front.length > 0;
  info.matched = matched;
  if (!front.length) {
    let best = null;
    for (const r of named) {
      const n = nearestOn(inM(r), centre);
      if (n && (!best || n.d < best.d)) best = { d: n.d, name: r.name };
    }
    if (!best) return { error: 'No named street was found near this lot.' };
    front = named.filter((r) => r.name === best.name);
  }
  const frontName = front[0].name;
  info.street = frontName;
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
  info.sideStreet = side?.name || null;
  const corner = side ? crossingNear(frontLines, side.lines, centre) : null;
  info.corner = Boolean(corner);
  if (!matched && side) return unclear(wanted ? 'no road here is named like the address, and the lot has two streets.' : 'the lot has two streets and no address to say which it faces.');

  /* WHICH RECTANGLE SIDE IS THE FACADE. */
  const toStreet = unit(sub(near.at, centre));
  const normals = [box.u, mul(box.u, -1), box.v, mul(box.v, -1)];
  let scored = normals.map((n) => ({ n, s: dot(n, toStreet) })).sort((a, b) => b.s - a.s);
  let tiedToCorner = false;
  if (scored[0].s - scored[1].s < 0.25) {
    if (!corner) return unclear('two sides of the house face the street equally, and there is no corner to decide it.');
    const toCorner = unit(sub(corner.at, centre));
    scored = normals.map((n) => ({ n, s: dot(n, toCorner) })).sort((a, b) => b.s - a.s);
    tiedToCorner = true;
  }
  if (scored[0].s < 0.5) return unclear(`the house does not face ${matched ? 'the street in its address' : 'the nearest street'}.`);
  info.facesCorner = tiedToCorner;
  const F = scored[0].n; // forward: from the house to its street
  const L = perp(F); // lateral
  info.facing = compassOf(F);

  /* The building's extent across and the stepped front and back lines. */
  const fv = verts.map((p) => dot(p, F)); const lv = verts.map((p) => dot(p, L));
  const Lmin = Math.min(...lv); const Lmax = Math.max(...lv);
  const TOL = Math.max(1.5, (Lmax - Lmin) * 0.08);
  const atLeft = fv.filter((f, i) => lv[i] <= Lmin + TOL);
  const atRight = fv.filter((f, i) => lv[i] >= Lmax - TOL);
  const frontLeft = Math.max(...atLeft); const backLeft = Math.min(...atLeft);
  const frontRight = Math.max(...atRight); const backRight = Math.min(...atRight);

  const B = Math.max(...P[0].map((q) => len(sub(q, centre)))) + 100;
  const frontRegion = regionAhead(house, L, F, frontLeft, frontRight, Lmin, Lmax, B);
  const Fb = mul(F, -1); const Lb = perp(Fb);
  let backRegion = regionAhead(house, Lb, Fb, -backRight, -backLeft, -Lmax, -Lmin, B);
  backRegion = clip.difference(backRegion, frontRegion);

  /* The corner lot's side strip. */
  let cornerStrip = null;
  if (side && !tiedToCorner) {
    const ns = nearestOn(side.lines, centre);
    const toSide = unit(sub(ns.at, centre));
    const flank = dot(L, toSide) >= 0 ? 'right' : 'left';
    const faces = Math.abs(dot(L, toSide)) > 0.5;
    const along = Math.abs(dot(ns.dir, F)) > Math.cos((30 * Math.PI) / 180);
    if (faces && along) {
      cornerStrip = flank === 'right' ? rect(Lmax, B, -B, frontRight, L, F) : rect(-B, Lmin, -B, frontLeft, L, F);
      backRegion = clip.difference(backRegion, cornerStrip);
    }
  }
  info.cornerStrip = Boolean(cornerStrip);

  /* THE LAWN, CUT into pieces, each one polygon with a region. */
  const lawnM = lawnPolys(lawn).map((poly) => poly.map((r) => r.map((q) => snap(frame.toXY(q)))));
  if (!lawnM.length) return { error: 'This map has no lawn yet.' };
  let whole;
  try { whole = clip.union(...lawnM.map((p) => [p])); } catch { return { error: 'The lawn shapes could not be read.' }; }
  let pieces = [];
  for (const p of clip.intersection(whole, frontRegion)) pieces.push({ poly: p, region: 'front', area: polyArea(p) });
  for (const p of clip.intersection(whole, backRegion)) pieces.push({ poly: p, region: 'back', area: polyArea(p) });
  for (const p of clip.difference(whole, frontRegion, backRegion)) pieces.push({ poly: p, region: 'side', area: polyArea(p) });

  /* THE GRID, and the lawn opened: passages under 3 ft removed. */
  let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
  for (const p of whole) for (const [x, y] of p[0]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  const g = gridFor(whole, [bx0, by0, bx1, by1]);
  const lawnOpened = g.open(g.rasterAll(whole));
  const { labels } = labelComponents(lawnOpened, g.W, g.H);

  /* A piece with a neck is two pieces (a front sliver joined to the main
     front lawn only round the end of a fence is a piece of its own). */
  let pinched = 0;
  const split = [];
  for (const piece of pieces) {
    const parts = splitAtNecks(clip, piece, g);
    if (parts.length > 1) pinched++;
    split.push(...parts);
  }
  pieces = split;
  info.pinched = pinched;
  for (const p of pieces) {
    p.mask = g.raster(p.poly);
    const top = [...cellsByLabel(p.mask, labels).by.entries()].sort((a, b) => b[1] - a[1])[0];
    p.id = top ? top[0] : 0;
  }
  // A thin appendix goes with the piece it shares the longest seam with.
  for (const t of pieces) {
    if (!t.thin) continue;
    let best = null; let most = 2;
    for (const o of pieces) {
      if (o === t) continue;
      const n = g.seam(t.mask, o.mask);
      if (n > most) { most = n; best = o; }
    }
    if (best) t.region = best.region;
  }

  /* The main front and back lawns, and what each connected lawn holds. */
  const biggest = (region) => pieces.filter((p) => p.region === region).sort((a, b) => b.area - a.area)[0] || null;
  const MF = biggest('front'); const MB = biggest('back');
  const holds = new Map();
  for (const p of pieces) {
    if (!p.id) continue;
    const h = holds.get(p.id) || { front: 0, back: 0, side: 0 };
    h[p.region] += p.area;
    holds.set(p.id, h);
  }

  /*
   * PASS 1: a piece away from its own main lawn. A front piece that is not
   * joined to the main front lawn (the fenced strip's few feet in front of
   * the house corner), or a back piece not joined to the main back lawn,
   * when it is a small share of the lawn it IS joined to, goes with that
   * lawn: the side it is beside with sides on, else whichever of front and
   * back that lawn mostly is. A big share stays what the line said (a front
   * yard split in two by the driveway is still front on both sides).
   */
  for (const p of pieces) {
    const h = p.id ? holds.get(p.id) : null;
    if (!h || p.region === 'side') continue;
    const main = p.region === 'front' ? MF : MB;
    if (!main || p.id === main.id) continue;
    const total = h.front + h.back + h.side;
    if (h[p.region] / total >= 0.25) continue;
    if (sides && h.side > 0) p.region = 'side';
    else p.region = h.back >= h.front ? 'back' : 'front';
  }

  /*
   * PASS 2: the sides, when they are lumped. Joined to the front lawn (next
   * to it, through lawn that survived the opening) it goes with the front;
   * joined only to the back, with the back; joined to neither it is
   * secluded, and secluded is back.
   */
  if (!sides) {
    const frontCells = new Uint8Array(g.W * g.H); const backCells = new Uint8Array(g.W * g.H);
    for (const p of pieces) {
      if (p.region !== 'front' && p.region !== 'back') continue;
      const into = p.region === 'front' ? frontCells : backCells;
      for (let i = 0; i < p.mask.length; i++) if (p.mask[i] && lawnOpened[i]) into[i] = 1;
    }
    for (const p of pieces) {
      if (p.region !== 'side') continue;
      // Its own cells that survived the opening: a seam counts only where
      // the lawn is wide enough to walk on both sides of it.
      const mine = p.mask.map((v, i) => (v && lawnOpened[i] ? 1 : 0));
      p.region = g.joined(mine, frontCells) ? 'front' : g.joined(mine, backCells) ? 'back' : 'back';
    }
  }

  /* THE SECTIONS. */
  const toLL = (multi) => multi.map((poly) => poly.map((r) => r.map(frame.toLngLat)));
  const of = (region) => pieces.filter((p) => p.region === region).map((p) => p.poly);
  const out = [];
  const frontLawn = of('front'); const backLawn = of('back');
  if (frontLawn.length) out.push({ name: 'Front', poly: toLL(frontLawn) });
  if (backLawn.length) out.push({ name: 'Back', poly: toLL(backLawn) });
  if (sides) {
    const left = []; const right = [];
    for (const p of pieces.filter((x) => x.region === 'side')) (dot(centroid(p.poly[0]), L) < dot(centre, L) ? left : right).push(p.poly);
    if (left.length) out.push({ name: `Side (${compassOf(mul(L, -1))})`, poly: toLL(left) });
    if (right.length) out.push({ name: `Side (${compassOf(L)})`, poly: toLL(right) });
  }
  return { sections: out, info };
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
