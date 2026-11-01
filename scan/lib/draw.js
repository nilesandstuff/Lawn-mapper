/**
 * DRAWING PINS OVER THE CAMERA, IN PLAIN WEBGL (core session, docs/SCAN-PLAN.md phase 1).
 *
 * The bare test page needs a dot where the crosshair meets the ground and a
 * pin where one was dropped, on both engines. Both hand over a GL context, a
 * view matrix and a projection; this draws a few flat rings and posts with
 * them and puts the GL state back (the 8th Wall engine shares its context
 * with us). three.js comes in with the viewer (phase 4), not before.
 *
 * Items: { kind: 'pin' | 'dot' | 'mark', at: {x, y, z}, color: [r, g, b, a] }.
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
function ring(at, r0, r1, n = 24, y = 0) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    v.push(at.x + r0 * ca, at.y + y, at.z + r0 * sa, at.x + r1 * ca, at.y + y, at.z + r1 * sa, at.x + r1 * cb, at.y + y, at.z + r1 * sb);
    v.push(at.x + r0 * ca, at.y + y, at.z + r0 * sa, at.x + r1 * cb, at.y + y, at.z + r1 * sb, at.x + r0 * cb, at.y + y, at.z + r0 * sb);
  }
  return v;
}
/** A thin upright post: two crossed quads, so it shows from any side. */
function post(at, w, h) {
  const v = [], x = at.x, y = at.y, z = at.z, a = w / 2;
  const quad = (x0, z0, x1, z1) => v.push(x0, y, z0, x1, y, z1, x1, y + h, z1, x0, y, z0, x1, y + h, z1, x0, y + h, z0);
  quad(x - a, z, x + a, z); quad(x, z - a, x, z + a);
  return v;
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

  /** Draw the items with this frame's matrices. Leaves the GL state as found. */
  function draw({ view, proj, viewport, framebuffer = null, items }) {
    if (!view || !proj || !items.length) return;
    const was = {
      prog: gl.getParameter(gl.CURRENT_PROGRAM), buf: gl.getParameter(gl.ARRAY_BUFFER_BINDING), fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      depth: gl.isEnabled(gl.DEPTH_TEST), blend: gl.isEnabled(gl.BLEND), cull: gl.isEnabled(gl.CULL_FACE), vp: gl.getParameter(gl.VIEWPORT),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    if (viewport) gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(uMvp, false, multiply(proj, view));
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aP);
    gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
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
    if (!was.depth) gl.disable(gl.DEPTH_TEST);
    if (!was.blend) gl.disable(gl.BLEND);
    if (was.cull) gl.enable(gl.CULL_FACE);
    if (was.vp) gl.viewport(was.vp[0], was.vp[1], was.vp[2], was.vp[3]);
  }
  return { draw };
}
