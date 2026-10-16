/**
 * PROPERTY LINES AND LAWNS ON THE GRID (water session): GeoJSON in lng/lat
 * -> which grid cells (lib/surface.js gridFor) fall inside, by cell centre.
 */

import { toMerc } from './ept.js';

/** Every outer ring and its holes, as [[lng, lat], ...] lists, from a Feature, a geometry or a list of either. */
export function polygonsOf(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(polygonsOf);
  const g = x.type === 'Feature' ? x.geometry : x;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** [w, s, e, n] in degrees over everything given, or null. */
export function boundsOf(...things) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of things.flatMap(polygonsOf)) for (const ring of poly) for (const [lng, lat] of ring) {
    w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Uint8Array W*H: 1 where a cell's centre is inside any of the polygons (holes honoured). */
export function maskOf(g, thing) {
  const mask = new Uint8Array(g.W * g.H);
  for (const poly of polygonsOf(thing)) {
    const rings = poly.map((ring) => ring.map((p) => { const [x, y] = toMerc(p); return g.toCell(x, y); }));
    const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1]);
    const c0 = Math.max(0, Math.floor(Math.min(...xs))), c1 = Math.min(g.W - 1, Math.ceil(Math.max(...xs)));
    const r0 = Math.max(0, Math.floor(Math.min(...ys))), r1 = Math.min(g.H - 1, Math.ceil(Math.max(...ys)));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = c + 0.5, y = r + 0.5;
      if (inRing(rings[0], x, y) && !rings.slice(1).some((h) => inRing(h, x, y))) mask[r * g.W + c] = 1;
    }
  }
  return mask;
}

/** The [col0, row0, col1, row1] box of a mask's cells, or null. */
export function maskBox(g, mask) {
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    const r = Math.floor(i / g.W), c = i % g.W;
    c0 = Math.min(c0, c); c1 = Math.max(c1, c + 1); r0 = Math.min(r0, r); r1 = Math.max(r1, r + 1);
  }
  return Number.isFinite(c0) ? [c0, r0, c1, r1] : null;
}
