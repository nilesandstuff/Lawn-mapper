/**
 * LAWN SECTIONS (owner, 2026-10-27: "Let's add the lawn slice tool"; the
 * to-do item it came from is docs/TODO.md item 2). The lawn is split into
 * named sections -- front, back, side -- that always add up to the whole.
 *
 * The borders have no thickness: every cut takes a piece out of one section
 * and gives exactly that piece to another, using polygon-clipping (`clip`,
 * lib/vendor, a global in the page and passed in here so the tests run it
 * the same way). Nothing is ever dropped, so the sum of the sections is the
 * lawn's area, which tools/sections.test.js checks after every kind of cut.
 *
 * A section is { id, name, poly } where poly is a MultiPolygon's coordinates
 * in [lng, lat]. The clipping is done in metres on a flat frame around the
 * lawn (the error over a lawn is far below a square foot), and the areas are
 * the geodesic ones from area.js, so they match the lawn mapper's figure.
 *
 * The four cuts:
 *   slice     a straight line across a section: it is cut in two
 *   free draw the same along a hand-drawn line
 *   square    a dragged rectangle: the lawn inside it becomes a new section
 *   shape     placed points: the lawn inside the polygon becomes a new section
 * and join, which makes two sections one.
 */

import { geometryAreaSqM, SQM_PER_SQFT } from './area.js';

/** A piece smaller than this (m2) is never made a section of its own. */
export const MIN_PIECE_SQM = 0.5;

/* ---------------------------------------------------------------- frame */

/** A flat frame in metres around a point: to(lnglat) and from(xy). */
export function frameAt([lng0, lat0]) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    to: ([lng, lat]) => [(lng - lng0) * mPerDegLng, (lat - lat0) * mPerDegLat],
    from: ([x, y]) => [lng0 + x / mPerDegLng, lat0 + y / mPerDegLat],
  };
}

/** The frame a set of sections is cut in: always the same for the same lawn. */
export function frameFor(sections) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of sections) for (const p of s.poly) for (const [x, y] of p[0]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return frameAt([(minX + maxX) / 2, (minY + maxY) / 2]);
}

const mapMulti = (multi, f) => multi.map((poly) => poly.map((ring) => ring.map(f)));

/* ---------------------------------------------------------------- areas */

/** A section's area in square feet (geodesic, as the lawn mapper measures). */
export function sectionSqFt(section) {
  return geometryAreaSqM({ type: 'MultiPolygon', coordinates: section.poly }) / SQM_PER_SQFT;
}

/** The sum of every section, square feet. */
export const totalSqFt = (sections) => sections.reduce((s, x) => s + sectionSqFt(x), 0);

/** Planar area of a MultiPolygon in metres (for the frame-side checks). */
function areaM(multi) {
  const ring = (r) => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
    return Math.abs(a) / 2;
  };
  return multi.reduce((s, p) => s + ring(p[0]) - p.slice(1).reduce((h, r) => h + ring(r), 0), 0);
}

/* ---------------------------------------------------------------- start */

/** The lawn shapes (GeoJSON features or geometries) as one MultiPolygon, overlaps counted once. */
export function wholeOf(clip, shapes) {
  const polys = [];
  for (const s of shapes || []) {
    const g = s?.geometry || s;
    if (g?.type === 'Polygon' && g.coordinates?.[0]?.length >= 4) polys.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') for (const p of g.coordinates) if (p?.[0]?.length >= 4) polys.push(p);
  }
  if (!polys.length) return [];
  return clip.union(...polys.map((p) => [p]));
}

/** The sections a lawn starts with: one for each separate piece of it. */
export function startSections(clip, shapes) {
  return wholeOf(clip, shapes).map((p, i) => ({ id: i + 1, name: '', poly: [p] }));
}

/** The next free id. */
export const nextId = (sections) => sections.reduce((m, s) => Math.max(m, s.id), 0) + 1;

/* ---------------------------------------------------------------- geometry helpers */

function insideRing(r, [x, y]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]; const [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const insideMulti = (multi, pt) => multi.some((p) => insideRing(p[0], pt) && !p.slice(1).some((h) => insideRing(h, pt)));

function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax; const dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function edgeDist(multi, pt) {
  let best = Infinity;
  for (const p of multi) for (const r of p) for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(pt, r[i - 1], r[i]));
  return best;
}

/** Points every `step` metres along a path, its two ends left out. */
function samples(path, step = 0.2) {
  const out = [];
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]; const [bx, by] = path[i];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = (i === 1 ? 1 : 0); k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Drop repeated points and keep at most a few hundred (a long finger stroke). */
function cleanPath(path) {
  const out = [];
  for (const p of path) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.05) out.push(p);
  }
  if (out.length <= 400) return out;
  const k = Math.ceil(out.length / 400);
  return out.filter((_, i) => i % k === 0 || i === out.length - 1);
}

/**
 * One side of a drawn line, as a polygon far bigger than the lawn. The line's
 * ends are carried on straight to well past the lawn, then joined round a
 * great circle, so the polygon's edge across the lawn is the drawn line and
 * nothing else.
 */
function sideOf(path, reach) {
  const unit = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const n = path.length - 1;
  const ds = unit([path[0][0] - path[1][0], path[0][1] - path[1][1]]);
  const de = unit([path[n][0] - path[n - 1][0], path[n][1] - path[n - 1][1]]);
  const e0 = [path[0][0] + ds[0] * reach, path[0][1] + ds[1] * reach];
  const en = [path[n][0] + de[0] * reach, path[n][1] + de[1] * reach];
  const R = reach * 3;
  const a0 = Math.atan2(e0[1], e0[0]);
  let an = Math.atan2(en[1], en[0]);
  while (an > a0) an -= 2 * Math.PI; // round from the end back to the start, one way
  const arc = [];
  for (let k = 0; k <= 64; k++) {
    const t = an + ((a0 - an) * k) / 64;
    arc.push([R * Math.cos(t), R * Math.sin(t)]);
  }
  const ring = [e0, ...path, en, ...arc, e0];
  return [ring];
}

/* ---------------------------------------------------------------- the remainder */

/**
 * What is left of a section once pieces are taken from it. Usually one piece.
 * When a cut leaves it in parts, the parts it did not touch and its biggest
 * new part stay the section (its id and name); every other new part becomes a
 * section of its own, because a lawn cut in two is two areas. A sliver stays
 * with the section rather than becoming one.
 */
function remainderOf(clip, before, after) {
  if (!after.length) return { own: [], extra: [] };
  const untouched = (p) => before.some((q) => Math.abs(areaM([q]) - areaM([p])) < 1e-6 && clip.xor([q], [p]).length === 0);
  const kept = []; const changed = [];
  for (const p of after) (untouched(p) ? kept : changed).push(p);
  changed.sort((a, b) => areaM([b]) - areaM([a]));
  const own = [...kept];
  const extra = [];
  changed.forEach((p, i) => {
    if (i === 0 || areaM([p]) < MIN_PIECE_SQM) own.push(p);
    else extra.push([p]);
  });
  return { own, extra };
}

/* ---------------------------------------------------------------- the cuts */

/**
 * Cut every section the line crosses in two, along the line. `pathLL` is the
 * line in [lng, lat]: two points for a straight slice, many for free draw.
 * Its ends carry on straight to the lawn's edge. Answers the new list, or
 * { error } when the line crosses no section.
 */
export function sliceSections(clip, sections, pathLL) {
  const frame = frameFor(sections);
  const path = cleanPath(pathLL.map(frame.to));
  if (path.length < 2) return { error: 'Draw a longer line across the lawn.' };
  const inM = sections.map((s) => mapMulti(s.poly, frame.to));
  let reach = 0;
  for (const m of inM) for (const p of m) for (const [x, y] of p[0]) reach = Math.max(reach, Math.hypot(x, y));
  for (const [x, y] of path) reach = Math.max(reach, Math.hypot(x, y));
  const side = sideOf(path, reach * 4 + 50);
  const pts = samples(path);

  let id = nextId(sections);
  let cut = false;
  const out = [];
  sections.forEach((s, i) => {
    const S = inM[i];
    const over = pts.filter((p) => insideMulti(S, p));
    if (!over.length) { out.push(s); return; }
    let left;
    try { left = clip.intersection(S, side); } catch { out.push(s); return; }
    // Only the pieces the drawn line runs along: the line's straight
    // extension may cross another arm of the lawn, which is not cut.
    const touched = left.filter((p) => areaM([p]) >= MIN_PIECE_SQM && over.some((q) => edgeDist([p], q) < 0.02));
    if (!touched.length) { out.push(s); return; }
    let rest;
    try { rest = clip.difference(S, ...touched.map((p) => [p])); } catch { out.push(s); return; }
    if (!rest.length || areaM(rest) < MIN_PIECE_SQM) { out.push(s); return; }
    cut = true;
    const r = remainderOf(clip, S, rest);
    out.push({ ...s, poly: mapMulti(r.own, frame.from) });
    for (const e of r.extra) out.push({ id: id++, name: '', poly: mapMulti(e, frame.from) });
    for (const p of touched) out.push({ id: id++, name: '', poly: mapMulti([p], frame.from) });
  });
  if (!cut) return { error: 'That line does not cross the lawn. Draw it from one edge to the other.' };
  return { sections: out };
}

/**
 * The lawn inside a closed shape (a square or placed points, [lng, lat])
 * becomes one new section, taken from whichever sections it covers.
 */
export function cutOutShape(clip, sections, ringLL) {
  if (!ringLL || ringLL.length < 3) return { error: 'Place at least three points.' };
  const frame = frameFor(sections);
  const ring = ringLL.map(frame.to);
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
  const R = [ring];
  let id = nextId(sections);
  const out = [];
  const taken = [];
  for (const s of sections) {
    const S = mapMulti(s.poly, frame.to);
    let inside;
    try { inside = clip.intersection(S, R); } catch { return { error: 'That shape could not be cut. Try placing the points again.' }; }
    if (!inside.length || areaM(inside) < 1e-9) { out.push(s); continue; }
    let rest;
    try { rest = clip.difference(S, R); } catch { return { error: 'That shape could not be cut. Try placing the points again.' }; }
    if (areaM(rest) < MIN_PIECE_SQM) {
      // All of it (or all but a sliver) is inside: the whole section goes.
      taken.push(S);
      continue;
    }
    taken.push(inside);
    const r = remainderOf(clip, S, rest);
    out.push({ ...s, poly: mapMulti(r.own, frame.from) });
    for (const e of r.extra) out.push({ id: id++, name: '', poly: mapMulti(e, frame.from) });
  }
  if (!taken.length) return { error: 'That shape does not cover any lawn.' };
  const piece = taken.length === 1 ? taken[0] : clip.union(...taken);
  if (areaM(piece) < MIN_PIECE_SQM) return { error: 'That shape covers almost no lawn.' };
  out.push({ id: id++, name: '', poly: mapMulti(piece, frame.from) });
  return { sections: out };
}

/** Two sections made one: the first keeps its name and id. */
export function joinSections(clip, sections, idA, idB) {
  const a = sections.find((s) => s.id === idA);
  const b = sections.find((s) => s.id === idB);
  if (!a || !b || a === b) return { error: 'Pick two different sections.' };
  const frame = frameFor(sections);
  let poly;
  try { poly = clip.union(mapMulti(a.poly, frame.to), mapMulti(b.poly, frame.to)); } catch { return { error: 'Those two could not be joined.' }; }
  return {
    sections: sections.filter((s) => s !== b).map((s) => (s === a ? { ...a, name: a.name || b.name, poly: mapMulti(poly, frame.from) } : s)),
  };
}

/**
 * Sections kept from an older lawn, fitted to the lawn as it is now: each is
 * trimmed to the new lawn, and any lawn no section covers becomes a section.
 * So a lawn redrawn after it was cut keeps its sections and still adds up.
 */
export function fitToLawn(clip, sections, shapes) {
  const whole = wholeOf(clip, shapes);
  if (!whole.length) return [];
  if (!sections?.length) return startSections(clip, shapes);
  const frame = frameAt(whole[0][0][0]);
  const W = mapMulti(whole, frame.to);
  const out = [];
  let covered = [];
  for (const s of sections) {
    let S;
    try { S = clip.intersection(mapMulti(s.poly, frame.to), W); } catch { continue; }
    if (covered.length) { try { S = clip.difference(S, covered); } catch { continue; } }
    if (areaM(S) < MIN_PIECE_SQM) continue;
    covered = covered.length ? clip.union(covered, S) : S;
    out.push({ ...s, poly: mapMulti(S, frame.from) });
  }
  let left = covered.length ? clip.difference(W, covered) : W;
  let id = nextId(out.length ? out : sections);
  const smalls = [];
  for (const p of left) {
    if (areaM([p]) >= MIN_PIECE_SQM) out.push({ id: id++, name: '', poly: mapMulti([p], frame.from) });
    else smalls.push(p);
  }
  // A sliver of new lawn goes to the biggest section rather than being lost.
  if (smalls.length && out.length) {
    const big = out.reduce((a, b) => (sectionSqFt(b) > sectionSqFt(a) ? b : a));
    big.poly = mapMulti(clip.union(mapMulti(big.poly, frame.to), ...smalls.map((p) => [p])), frame.from);
  }
  return out;
}

/* ---------------------------------------------------------------- saving */

const round8 = (v) => Math.round(v * 1e8) / 1e8;

/**
 * What the tool keeps on the server: the sections, coordinates to about a
 * millimetre. The page fits them to the lawn again on opening (fitToLawn),
 * so the rounding never shows in the sum.
 */
export function sectionsPart(sections) {
  return {
    v: 1,
    sections: sections.map((s) => ({
      id: s.id,
      name: String(s.name || '').slice(0, 40),
      poly: s.poly.map((p) => p.map((r) => r.map(([x, y]) => [round8(x), round8(y)]))),
    })),
    at: new Date().toISOString(),
  };
}

/** The sections out of a kept part, or null when it is not one. */
export function sectionsFromPart(part) {
  if (!part || part.v !== 1 || !Array.isArray(part.sections)) return null;
  const ok = part.sections.filter((s) => Number.isFinite(s?.id) && Array.isArray(s.poly) && s.poly.length);
  return ok.length ? ok.map((s) => ({ id: s.id, name: String(s.name || ''), poly: s.poly })) : null;
}
