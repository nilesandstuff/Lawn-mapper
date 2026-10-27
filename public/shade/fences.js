/**
 * FENCES (owner, 2026-10-27: "add support for solid wood/vinyl fences.
 * They're too narrow for lidar (i think), so users will have to mark them
 * before trees render").
 *
 * A fence is a run of straight lengths the visitor draws, a height, and a
 * build. The light model treats each length as an exact upright plane (not
 * a 1 m block of the canopy grid): a ray toward the sun or the sky that
 * crosses it below its top passes the share its boards let through at that
 * angle (lightThrough), and a lit, pale face throws some of the sun back on
 * the lawn in front of it (the reflected light, below).
 *
 * THE BUILDS (owner's words, named as the trade names them):
 *   solid      privacy fence, boards butted or tongue-and-groove, vinyl or
 *              wood: no light, no wind.
 *   spaced     spaced pickets or boards: the gaps as wide as the boards
 *              (3.5 in boards, 3.5 in gaps), half the light straight on,
 *              less as the sun comes across it at a slant.
 *   shadowbox  boards on alternate sides of the rail ("staggered"; also
 *              called board-on-board when they overlap): 5.5 in boards,
 *              3.5 in gaps on each face, the faces 1.5 in apart on a 2x4
 *              rail. Each board covers the gap behind it by an inch either
 *              side, so no light goes straight through; some slips through
 *              at a slant.
 * The light is worked out from that geometry for every angle. Rails and
 * posts are left out (a few per cent).
 *
 * WIND (for the water map; the shade map does not use it). For thin slatted
 * fences the share of the wind that passes (aerodynamic porosity) is close
 * to the share of open area seen face-on (optical porosity) (Zhou et al.
 * 2004, Agroforestry Systems, on slat fences; Heisler & DeWalle 1988): solid
 * 0, spaced 0.5. A shadowbox has no straight-through opening, but the air
 * turns through the 1.5 in channels between the faces: an ESTIMATE of 0.2
 * from that path (two channels per 9 in of fence, two right-angle turns),
 * unmeasured.
 *
 * THE FACE'S SOLAR REFLECTANCE (the share of sunlight it throws back;
 * 1 minus it is what heats the fence, for the water map). TYPICAL values,
 * not measured on fences: white vinyl about 0.70 (titanium white PVC);
 * tan/almond 0.50; gray/clay 0.40; dark vinyl 0.25 (dark vinyl is usually
 * made with infrared-reflective pigments that keep it cooler than its
 * color, ACEEE 2002); wood painted white 0.65, natural new 0.40, weathered
 * gray 0.30, dark stain 0.15. Emissivity 0.9 for all.
 */

const IN = 0.0254;

export const FENCE_STYLES = {
  solid: { label: 'Solid privacy', about: 'Boards tight together: no light or wind through', planes: [] , wind: 0, windBasis: 'no openings' },
  spaced: { label: 'Spaced boards', about: 'Gaps between the boards: about half the light straight on', planes: [{ at: 0, board: 3.5, gap: 3.5, thick: 0.75, phase: 0 }], wind: 0.5, windBasis: 'optical porosity (thin slat fence)' },
  shadowbox: { label: 'Shadowbox (staggered)', about: 'Boards on alternate sides of the rail: little light, some wind', planes: [{ at: 0, board: 5.5, gap: 3.5, thick: 0.75, phase: 0 }, { at: 2.25, board: 5.5, gap: 3.5, thick: 0.75, phase: 4.5 }], wind: 0.2, windBasis: 'estimate from the channels between the faces, unmeasured' },
};
export const FENCE_MATERIALS = {
  vinyl: { label: 'Vinyl', colors: { white: ['White', 0.70], tan: ['Tan or almond', 0.50], gray: ['Gray or clay', 0.40], dark: ['Dark brown or black', 0.25] } },
  wood: { label: 'Wood', colors: { natural: ['Natural, newer', 0.40], weathered: ['Weathered gray', 0.30], dark: ['Dark stain', 0.15], white: ['Painted white', 0.65] } },
};
export const FT = 0.3048;
export const MAX_FENCES = 40, MAX_POINTS = 40;

/**
 * The share of a beam that passes a fence of `style` when it meets it at
 * `phi` radians from straight on, horizontally (the boards stand upright,
 * so the beam's height does not matter). Worked out by sliding the beam
 * across one repeat of the boards.
 */
function passes(style, phi) {
  const s = FENCE_STYLES[style];
  if (!s || !s.planes.length) return 0;
  const t = Math.tan(Math.min(Math.abs(phi), Math.PI / 2 - 1e-6));
  const P = s.planes[0].board + s.planes[0].gap;
  const N = 720;
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const x0 = ((i + 0.5) / N) * P;
    let through = true;
    for (const pl of s.planes) {
      /* The beam crosses this face between depths at - thick/2 and at + thick/2. */
      const a = x0 + (pl.at - pl.thick / 2) * t, b = x0 + (pl.at + pl.thick / 2) * t;
      const inGap = (x) => { const u = (((x - pl.phase) % P) + P) % P; return u >= pl.board; };
      /* All of the crossing must be in one gap: both ends in a gap and no board between (a gap is narrower than a repeat). */
      if (!(inGap(a) && inGap(b) && b - a < pl.gap)) { through = false; break; }
      const ua = (((a - pl.phase) % P) + P) % P;
      if (ua + (b - a) > P) { through = false; break; }
    }
    if (through) ok++;
  }
  return ok / N;
}
const TABLES = {};
/** lightThrough(style, phi): the beam's share passing, from a table at every degree. */
export function lightThrough(style, phi) {
  if (style === 'solid' || !FENCE_STYLES[style]) return 0;
  const T = TABLES[style] || (TABLES[style] = Float32Array.from({ length: 91 }, (_, d) => passes(style, (d * Math.PI) / 180)));
  const d = Math.min(90, (Math.abs(phi) * 180) / Math.PI);
  const i = Math.floor(d), f = d - i;
  return i >= 90 ? T[90] : T[i] * (1 - f) + T[i + 1] * f;
}
/** The share of an even sky's light that passes, seen from one side (each slant weighted by how squarely it meets the fence). */
export function skyThrough(style) {
  let s = 0, n = 0;
  for (let d = 0; d < 90; d++) { const phi = ((d + 0.5) * Math.PI) / 180; s += lightThrough(style, phi) * Math.cos(phi); n += Math.cos(phi); }
  return s / n;
}

const r7 = (v) => Math.round(v * 1e7) / 1e7;
/**
 * A fence as kept with the map (the shade part's `fences`, read by the water
 * map too): { id, line: [[lng, lat], ...] straight lengths between the
 * points, heightM, style, material, color, and what follows from them:
 * light: { straight, sky } shares through, wind: { porosity, basis },
 * surface: { solarReflectance, absorptance, emissivity, basis } }. Null
 * for a line too short or a build not known.
 */
export function fenceRecord({ id = null, line, heightM, style, material, color }) {
  const pts = (line || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, MAX_POINTS).map(([a, b]) => [r7(a), r7(b)]);
  const S = FENCE_STYLES[style], M = FENCE_MATERIALS[material];
  const h = Number(heightM);
  if (pts.length < 2 || !S || !M || !(h > 0.3 && h <= 4)) return null;
  const c = M.colors[color] ? color : Object.keys(M.colors)[0];
  const rho = M.colors[c][1];
  return {
    id: id || `f${Math.random().toString(36).slice(2, 9)}`,
    line: pts, heightM: Math.round(h * 100) / 100, style, material, color: c,
    light: { straight: Math.round(lightThrough(style, 0) * 1000) / 1000, sky: Math.round(skyThrough(style) * 1000) / 1000 },
    wind: { porosity: S.wind, basis: S.windBasis },
    surface: { solarReflectance: rho, absorptance: Math.round((1 - rho) * 100) / 100, emissivity: 0.9, basis: 'typical for the material and color, not measured' },
  };
}
/** The kept list, cleaned (records rebuilt from their own fields, so old or edited ones get today's numbers). */
export function cleanFences(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FENCES).map((f) => fenceRecord(f || {})).filter(Boolean);
}
/** A fence's length in metres (along its straight lengths). */
export function fenceLengthM(f) {
  let L = 0;
  for (let i = 1; i < f.line.length; i++) {
    const [a, b] = [f.line[i - 1], f.line[i]];
    const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320;
    L += Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * 110540);
  }
  return L;
}

/* --------------------------------------------- on the light model's grid */

/**
 * The fences on a model's grid: one entry per straight length, its ends in
 * grid cells (x east, y south), its foot (the ground's height under each
 * end, metres) and top, its build and face's reflectance. `toCell([lng,
 * lat]) -> [gx, gy]`, `groundAt(gx, gy)`, `cm` metres per cell.
 */
export function fencesOnGrid(fences, toCell, groundAt, cm) {
  const out = [];
  for (const f of fences || []) {
    for (let i = 1; i < f.line.length; i++) {
      const [ax, ay] = toCell(f.line[i - 1]), [bx, by] = toCell(f.line[i]);
      const len = Math.hypot(bx - ax, by - ay) * cm;
      if (!(len > 0.05)) continue;
      const footA = groundAt(ax, ay), footB = groundAt(bx, by);
      /* The face's normal, in metres east and north: the length (east (bx - ax),
         north -(by - ay), as y runs south) turned a quarter turn. */
      const nE = ((by - ay) * cm) / len, nN = ((bx - ax) * cm) / len;
      out.push({ ax, ay, bx, by, len, footA, footB, h: f.heightM, style: f.style, rho: f.surface?.solarReflectance ?? 0.4, nE, nN, id: f.id });
    }
  }
  return out;
}

/**
 * The share of a ray along `dir` ([east, north, up]) from (gx, gy, z) that
 * the fences let through: each length it crosses below its top passes
 * lightThrough of the angle it meets it at.
 */
export function throughFences(segs, gx, gy, z, dir, cm) {
  if (!segs?.length) return 1;
  const [e, n, u] = dir;
  const hl = Math.hypot(e, n);
  if (hl < 1e-6) return 1;
  /* Along the ray, per metre of ground covered: cells moved and metres risen. */
  const hx = e / hl / cm, hy = -n / hl / cm, rise = u / hl;
  let T = 1;
  for (const s of segs) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const den = hx * dy - hy * dx;
    if (Math.abs(den) < 1e-12) continue; // running alongside it
    const qx = s.ax - gx, qy = s.ay - gy;
    const t = (qx * dy - qy * dx) / den; // metres along the ground
    const v = (qx * hy - qy * hx) / den; // where along the length, 0..1
    if (t <= 1e-3 || v < 0 || v > 1) continue;
    const foot = s.footA + (s.footB - s.footA) * v;
    const zz = z + t * rise;
    if (zz > foot + s.h || zz < foot - 0.3) continue; // over it, or (a hill) under its foot
    const cosPhi = Math.abs(e * s.nE + n * s.nN) / hl;
    T *= lightThrough(s.style, Math.acos(Math.min(1, cosPhi)));
    if (T < 1e-4) return 0;
  }
  return T;
}

/**
 * THE LIGHT A FACE THROWS BACK (owner: "a good amount of light would have a
 * diffuse reflection off of white vinyl depending on the angle of the
 * sun"). A sunlit face of reflectance rho sends rho x the sunlight on it
 * back out evenly (a matte face); a patch of lawn gets that times the view
 * factor F from the patch up to the face: the share of the patch's sky the
 * face fills, weighted as light falls on level ground (cos at the patch x
 * cos at the face / pi r^2, summed over the face). F is near 0.4 at the
 * foot of a 6 ft fence and gone by twice its height away.
 *
 * faceViews(segs, xy, groundAt, cm): for every point, the lengths whose
 * near face it sees: [{ s (index), F, side (+1 the normal's side, -1 the
 * other) }], within 3 heights. Worked out once per set of points.
 */
export function faceViews(segs, xy, groundAt, cm) {
  const n = xy.length / 2;
  const out = new Array(n);
  for (let p = 0; p < n; p++) {
    const gx = xy[2 * p], gy = xy[2 * p + 1];
    const pz = groundAt(gx, gy) + 0.1;
    let list = null;
    segs.forEach((s, i) => {
      /* Distance to the length, in metres, and which side the point is on. */
      const dx = (s.bx - s.ax) * cm, dy = (s.by - s.ay) * cm;
      const px = (gx - s.ax) * cm, py = (gy - s.ay) * cm;
      const v = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      const dist = Math.hypot(px - v * dx, py - v * dy);
      if (dist > 3 * s.h + 1 || dist < 0.02) return;
      const offE = px, offN = -py; // the point from the length's first end, east and north
      const side = offE * s.nE + offN * s.nN >= 0 ? 1 : -1;
      const nl = Math.max(4, Math.min(24, Math.ceil(s.len / 0.4))), nh = 6;
      let F = 0;
      const dA = (s.len / nl) * (s.h / nh);
      for (let a = 0; a < nl; a++) {
        const v2 = (a + 0.5) / nl;
        const qE = v2 * dx, qN = -v2 * dy;
        const foot = s.footA + (s.footB - s.footA) * v2;
        for (let b = 0; b < nh; b++) {
          const qz = foot + ((b + 0.5) / nh) * s.h;
          const rE = qE - offE, rN = qN - offN, rz = qz - pz;
          const r2 = rE * rE + rN * rN + rz * rz;
          if (rz <= 0 || r2 < 1e-4) continue;
          const r = Math.sqrt(r2);
          const cos1 = rz / r; // at the level patch
          const cos2 = -(rE * s.nE + rN * s.nN) * side / r; // at the face, its normal toward the patch
          if (cos2 <= 0) continue;
          F += (cos1 * cos2 * dA) / (Math.PI * r2);
        }
      }
      if (F > 1e-4) (list ||= []).push({ s: i, F: Math.min(0.5, F), side });
    });
    out[p] = list;
  }
  return out;
}

/**
 * The reflected light at one point for a sun along `dir`, as a share of the
 * direct beam's strength (multiply by DNI): rho x F x cos(the sun on the
 * face) x lit, for each face it sees that faces the sun. `lit(s)` is the
 * share of the face in sun (the trees before it), 1 when not given.
 */
export function reflectedBeam(views, segs, dir, lit = null) {
  if (!views) return 0;
  const hl = Math.hypot(dir[0], dir[1]);
  let out = 0;
  for (const { s, F, side } of views) {
    const g = segs[s];
    const cosFace = side * (dir[0] * g.nE + dir[1] * g.nN); // the face's normal is horizontal
    if (cosFace <= 0 || hl <= 0) continue;
    out += g.rho * F * cosFace * (lit ? lit(s) : 1);
  }
  return out;
}
/** The reflected light at one point from an even sky, as a share of the sky's light on level ground (an upright face sees half the sky). */
export function reflectedSky(views, segs) {
  if (!views) return 0;
  let out = 0;
  for (const { s, F } of views) out += segs[s].rho * F * 0.5;
  return out;
}
