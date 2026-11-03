/**
 * DRAWING OVER THE CAMERA, IN PLAIN WEBGL (core session, docs/SCAN-PLAN.md phases 1-2).
 *
 * Both engines hand over a GL context, a view matrix and a projection; this draws with them and puts the GL state
 * back (the 8th Wall engine shares its context with us). three.js comes in with the viewer (phase 4), not before.
 *
 *   items    small things rebuilt each frame: { kind: 'pin' | 'dot' | 'mark', at: {x, y, z}, color }
 *   dots     many small discs in one draw: { points: [{x, y, z}], color, r }
 *   statics  big meshes built once (the lot's lidar, SCAN-H2), each drawn through its own model matrix:
 *            { mesh (from makeMesh), model: Float32Array(16) | null, color, through: true } -- `through` draws it
 *            translucent and without writing depth, so it never hides the pins or the dots
 */
import { multiply } from './frames.js';

const VS = 'attribute vec3 p; uniform mat4 mvp; void main(){ gl_Position = mvp * vec4(p, 1.0); }';
const FS = 'precision mediump float; uniform vec4 c; void main(){ gl_FragColor = c; }';

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

/** A flat ring in the x/z plane, radii r0..r1, as triangles. */
export function ring(at, r0, r1, n = 24, y = 0, out = []) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    out.push(at.x + r0 * ca, at.y + y, at.z + r0 * sa, at.x + r1 * ca, at.y + y, at.z + r1 * sa, at.x + r1 * cb, at.y + y, at.z + r1 * sb);
    out.push(at.x + r0 * ca, at.y + y, at.z + r0 * sa, at.x + r1 * cb, at.y + y, at.z + r1 * sb, at.x + r0 * cb, at.y + y, at.z + r0 * sb);
  }
  return out;
}
/** A thin upright post: two crossed quads, so it shows from any side. */
function post(at, w, h) {
  const v = [], x = at.x, y = at.y, z = at.z, a = w / 2;
  const quad = (x0, z0, x1, z1) => v.push(x0, y, z0, x1, y, z1, x1, y + h, z1, x0, y, z0, x1, y + h, z1, x0, y + h, z0);
  quad(x - a, z, x + a, z); quad(x, z - a, x, z + a);
  return v;
}
/** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1), 12 triangles, pushed onto out. */
export function box(out, x0, y0, z0, x1, y1, z1) {
  const q = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y0, z1], D = [x0, y0, z1], E = [x0, y1, z0], F = [x1, y1, z0], G = [x1, y1, z1], H = [x0, y1, z1];
  q(A, B, C, D); q(E, F, G, H); q(A, B, F, E); q(B, C, G, F); q(C, D, H, G); q(D, A, E, H);
  return out;
}

export function makeDrawer(gl) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program');
  const aP = gl.getAttribLocation(prog, 'p'), uMvp = gl.getUniformLocation(prog, 'mvp'), uC = gl.getUniformLocation(prog, 'c');
  const buf = gl.createBuffer();

  function geometry(item) {
    const at = item.at;
    if (item.kind === 'dot') return [ring(at, 0, 0.05, 20, 0.005), ring(at, 0.09, 0.11, 24, 0.005)];
    if (item.kind === 'mark') return [ring(at, 0, 0.04, 16, 0.005), post(at, 0.015, 0.25)];
    return [ring(at, 0.07, 0.11, 24, 0.005), post(at, 0.02, 0.4), ring({ x: at.x, y: at.y + 0.4, z: at.z }, 0, 0.05, 16, 0)];
  }

  /** A mesh kept on the GPU: verts a flat array of x, y, z triangles. */
  function makeMesh(verts) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, verts instanceof Float32Array ? verts : new Float32Array(verts), gl.STATIC_DRAW);
    return { buf: b, n: verts.length / 3, free: () => gl.deleteBuffer(b) };
  }

  /** Draw with this frame's matrices. Leaves the GL state as found. */
  function draw({ view, proj, viewport, framebuffer = null, items = [], dots = [], statics = [] }) {
    if (!view || !proj || (!items.length && !dots.length && !statics.length)) return;
    const was = {
      prog: gl.getParameter(gl.CURRENT_PROGRAM), buf: gl.getParameter(gl.ARRAY_BUFFER_BINDING), fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      depth: gl.isEnabled(gl.DEPTH_TEST), blend: gl.isEnabled(gl.BLEND), cull: gl.isEnabled(gl.CULL_FACE), vp: gl.getParameter(gl.VIEWPORT), mask: gl.getParameter(gl.DEPTH_WRITEMASK),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    if (viewport) gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
    const vp = multiply(proj, view);
    gl.enableVertexAttribArray(aP);
    // the big meshes first, see-through, so what comes after draws over them
    for (const s of statics) {
      if (!s.mesh?.n) continue;
      gl.uniformMatrix4fv(uMvp, false, s.model ? multiply(vp, s.model) : vp);
      gl.uniform4fv(uC, s.color || [1, 1, 1, 0.2]);
      gl.depthMask(!s.through);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.mesh.buf);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, s.mesh.n);
    }
    gl.depthMask(true);
    gl.uniformMatrix4fv(uMvp, false, vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
    for (const d of dots) {
      if (!d.points?.length) continue;
      const v = [];
      for (const p of d.points) ring(p, 0, d.r || 0.03, 8, 0, v);
      gl.uniform4fv(uC, d.color || [0, 0, 0, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, v.length / 3);
    }
    for (const item of items) {
      gl.uniform4fv(uC, item.color || [1, 1, 1, 1]);
      for (const part of geometry(item)) {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(part), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, part.length / 3);
      }
    }
    gl.disableVertexAttribArray(aP);
    gl.bindBuffer(gl.ARRAY_BUFFER, was.buf);
    gl.useProgram(was.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, was.fb);
    gl.depthMask(was.mask);
    if (!was.depth) gl.disable(gl.DEPTH_TEST);
    if (!was.blend) gl.disable(gl.BLEND);
    if (was.cull) gl.enable(gl.CULL_FACE);
    if (was.vp) gl.viewport(was.vp[0], was.vp[1], was.vp[2], was.vp[3]);
  }
  return { draw, makeMesh };
}

/**
 * THE LOT'S LIDAR AS A MESH, in map coordinates (e, height, n), from what the worker sends (scan/public/lidar-worker.js
 * overlay): solids [e, n, z0, z1] per 0.25 m cell (walls, fences, trunks, shrubs: what the match matches against) and
 * tall [e, n, z0, z1, roof] per 1 m cell (canopy, or a roof). Returns { solids: verts, canopy: verts, roofs: verts }.
 */
export function lidarMeshes(overlay) {
  const solids = [], canopy = [], roofs = [];
  const s = overlay.solids || [], c = overlay.cell || 0.25;
  for (let i = 0; i + 3 < s.length; i += 4) box(solids, s[i], s[i + 2], s[i + 1], s[i] + c, s[i + 3], s[i + 1] + c);
  const t = overlay.tall || [];
  for (let i = 0; i + 4 < t.length; i += 5) box(t[i + 4] ? roofs : canopy, t[i], t[i + 2], t[i + 1], t[i] + 1, t[i + 3], t[i + 1] + 1);
  return { solids, canopy, roofs };
}
