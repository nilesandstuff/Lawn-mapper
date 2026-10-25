/**
 * THE GROUND IN 3D (owner, 2026-10-25: "the map should have a 2d top down view, and a 3d view that shows the literal
 * slope of the ground").
 *
 * The lidar's ground surface (the analysis grid's z, metres, already on the photo's ground) as a mesh, with the 2D
 * map -- the photo and whatever view is on, soil, slope, zones, sprinklers -- draped over it as its texture, so the
 * two views always show the same thing. Lit from the south-west, so a slope reads as light and shade even under the
 * photo. Heights are multiplied by `exaggeration` (labelled on the page): a lawn is too flat to see at true scale.
 *
 * Raw WebGL 1, no library (the shade map's view3d.js is a Mapbox layer, which this page does not load). One finger
 * turns it, two pinch and move it, the wheel zooms.
 */

const VS = `attribute vec3 aPos; attribute vec2 aUv; attribute vec3 aNorm;
uniform mat4 uM; uniform float uZ;
varying vec2 vUv; varying float vLight;
void main() {
  vec3 p = vec3(aPos.xy, aPos.z * uZ);
  vec3 n = normalize(vec3(aNorm.xy * uZ, aNorm.z));
  vLight = 0.55 + 0.45 * max(0.0, dot(n, normalize(vec3(-0.5, -0.6, 0.8))));
  vUv = aUv; gl_Position = uM * vec4(p, 1.0);
}`;
const FS = `precision mediump float; uniform sampler2D uTex; varying vec2 vUv; varying float vLight;
void main() { vec4 c = texture2D(uTex, vUv); gl_FragColor = vec4(c.rgb * vLight, 1.0); }`;

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, at, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/**
 * The mesh for a grid: W x H cells of `cell` metres, z (metres, NaN where unknown), and uv(c, r) -> [u, v] in the
 * texture for a cell's middle. Every `step` cells (at most about 250 a side). Pure: exported for the tests.
 * -> { pos (x east, y north, z above the lowest ground, metres, about the middle), uv, norm, idx, w, h, zRange }
 */
export function groundMesh({ W, H, cell, z, uv }, { maxSide = 250 } = {}) {
  const step = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
  const w = Math.floor((W - 1) / step) + 1, h = Math.floor((H - 1) / step) + 1;
  const vals = [];
  for (let i = 0; i < W * H; i++) if (Number.isFinite(z[i])) vals.push(z[i]);
  vals.sort((a, b) => a - b);
  const lo = vals.length ? vals[Math.floor(vals.length * 0.01)] : 0, hi = vals.length ? vals[Math.floor(vals.length * 0.99)] : 0;
  const zAt = (c, r) => {
    // a hole (a roof, water) takes the nearest ground around it, else the lowest
    for (let d = 0; d < 6; d++) for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const v = z[rr * W + cc];
      if (Number.isFinite(v)) return Math.min(hi, Math.max(lo, v));
    }
    return lo;
  };
  const pos = new Float32Array(w * h * 3), tex = new Float32Array(w * h * 2), norm = new Float32Array(w * h * 3);
  const mx = ((W - 1) * cell) / 2, my = ((H - 1) * cell) / 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = Math.min(W - 1, i * step), r = Math.min(H - 1, j * step), k = j * w + i;
    pos.set([c * cell - mx, my - r * cell, zAt(c, r) - lo], k * 3);
    tex.set(uv(c, r), k * 2);
  }
  // normals from the neighbours (in true metres; the shader stretches them with the heights)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, Z = (ii, jj) => pos[(Math.max(0, Math.min(h - 1, jj)) * w + Math.max(0, Math.min(w - 1, ii))) * 3 + 2];
    const dx = (Z(i + 1, j) - Z(i - 1, j)) / (2 * step * cell), dy = (Z(i, j - 1) - Z(i, j + 1)) / (2 * step * cell);
    const l = Math.hypot(dx, dy, 1);
    norm.set([-dx / l, -dy / l, 1 / l], k * 3);
  }
  const idx = new (w * h > 65535 ? Uint32Array : Uint16Array)((w - 1) * (h - 1) * 6);
  let n = 0;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
    idx.set([a, c, b, b, c, d], n); n += 6;
  }
  return { pos, uv: tex, norm, idx, w, h, zRange: hi - lo, step, sizeM: [W * cell, H * cell] };
}

/**
 * A viewer on `canvas`. -> { setGround(mesh), setTexture(sourceCanvas), setExaggeration(x), reset(), destroy(), ok }
 */
export function viewer3d(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return { ok: false, setGround() {}, setTexture() {}, setExaggeration() {}, reset() {}, destroy() {} };
  const big = !!gl.getExtension('OES_element_index_uint');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  const loc = { pos: gl.getAttribLocation(prog, 'aPos'), uv: gl.getAttribLocation(prog, 'aUv'), norm: gl.getAttribLocation(prog, 'aNorm'), M: gl.getUniformLocation(prog, 'uM'), Z: gl.getUniformLocation(prog, 'uZ') };
  const buf = { pos: gl.createBuffer(), uv: gl.createBuffer(), norm: gl.createBuffer(), idx: gl.createBuffer() };
  const tex = gl.createTexture();
  let mesh = null, count = 0, idxType = gl.UNSIGNED_SHORT, ex = 3, frame = 0;
  // the camera: turned (az from north, clockwise), tilted (el above the ground), at a distance, looking at `at`
  const cam = { az: 200, el: 38, dist: 120, at: [0, 0] };
  const home = () => { const s = mesh ? Math.max(...mesh.sizeM) : 100; cam.az = 200; cam.el = 38; cam.dist = s * 0.95; cam.at = [0, 0]; };

  function draw() {
    frame = 0;
    const dpr = window.devicePixelRatio || 1, wCss = canvas.clientWidth || 300, hCss = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(wCss * dpr) || canvas.height !== Math.round(hCss * dpr)) { canvas.width = Math.round(wCss * dpr); canvas.height = Math.round(hCss * dpr); }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.13, 0.16, 0.15, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!mesh) return;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    const a = (cam.az * Math.PI) / 180, e = (cam.el * Math.PI) / 180;
    const zMid = (mesh.zRange * ex) / 2;
    const eye = [cam.at[0] - Math.sin(a) * Math.cos(e) * cam.dist, cam.at[1] - Math.cos(a) * Math.cos(e) * cam.dist, zMid + Math.sin(e) * cam.dist];
    const M = mul(perspective(Math.PI / 4, canvas.width / canvas.height, cam.dist / 50, cam.dist * 6), lookAt(eye, [cam.at[0], cam.at[1], zMid], [0, 0, 1]));
    gl.uniformMatrix4fv(loc.M, false, new Float32Array(M));
    gl.uniform1f(loc.Z, ex);
    for (const [k, n] of [['pos', 3], ['uv', 2], ['norm', 3]]) { gl.bindBuffer(gl.ARRAY_BUFFER, buf[k]); gl.enableVertexAttribArray(loc[k]); gl.vertexAttribPointer(loc[k], n, gl.FLOAT, false, 0, 0); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawElements(gl.TRIANGLES, count, idxType, 0);
  }
  const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

  /* turning, tilting, zooming and moving: one finger (or the mouse) turns and tilts, two pinch and move, the wheel
     zooms; nothing on the page beneath is touched */
  const pts = new Map();
  let last = null;
  const onDown = (ev) => { canvas.setPointerCapture?.(ev.pointerId); pts.set(ev.pointerId, [ev.clientX, ev.clientY]); last = null; ev.preventDefault(); };
  const onMove = (ev) => {
    if (!pts.has(ev.pointerId)) return;
    const prev = pts.get(ev.pointerId); pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pts.size === 1) {
      cam.az += (ev.clientX - prev[0]) * 0.4; cam.el = Math.max(8, Math.min(89, cam.el + (ev.clientY - prev[1]) * 0.3));
    } else if (pts.size === 2) {
      const [p, q] = [...pts.values()], mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (last) {
        if (last.d > 0) cam.dist = Math.max(10, Math.min(2000, cam.dist * (last.d / d)));
        // move the point looked at, across the ground, by the fingers' middle
        const k = cam.dist / (canvas.clientHeight || 300), a = (cam.az * Math.PI) / 180, mx = -(mid[0] - last.mid[0]) * k, my = (mid[1] - last.mid[1]) * k;
        cam.at = [cam.at[0] + mx * Math.cos(a) + my * Math.sin(a), cam.at[1] - mx * Math.sin(a) + my * Math.cos(a)];
      }
      last = { d, mid };
    }
    redraw();
  };
  const onUp = (ev) => { pts.delete(ev.pointerId); last = null; };
  const onWheel = (ev) => { ev.preventDefault(); cam.dist = Math.max(10, Math.min(2000, cam.dist * (ev.deltaY > 0 ? 1.15 : 1 / 1.15))); redraw(); };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const onResize = () => redraw();
  addEventListener('resize', onResize);

  return {
    ok: true,
    setGround(m) {
      if (m.idx instanceof Uint32Array && !big) throw new Error('this browser cannot draw a mesh this large');
      mesh = m; count = m.idx.length; idxType = m.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      for (const [k, data] of [['pos', m.pos], ['uv', m.uv], ['norm', m.norm]]) { gl.bindBuffer(gl.ARRAY_BUFFER, buf[k]); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
      home(); redraw();
    },
    /** The 2D map as it is drawn now, draped over the ground. */
    setTexture(src) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      // the map's canvas is not a power of two: no mipmaps, clamped
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      redraw();
    },
    setExaggeration(x) { ex = x; redraw(); },
    reset() { home(); redraw(); },
    redraw,
    destroy() {
      removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('wheel', onWheel);
    },
  };
}
