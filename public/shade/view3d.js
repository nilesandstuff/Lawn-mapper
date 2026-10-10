/**
 * THE POINT CLOUD, DRAWN IN 3D ON THE SAME MAPBOX MAP AS THE PHOTO, THE
 * PROPERTY LINE AND THE LAWN (shade map, features session).
 *
 * One map, so a misfit cannot hide: if the cloud's ground is off the photo's
 * ground, the kerbs, drives and roofs say so where they cross. Drawn with a
 * Mapbox custom layer and raw WebGL points -- no 3D library.
 *
 * PRECISION. A Mapbox "mercator coordinate" spans the world in 0..1, and a
 * 32-bit float there resolves about a metre. So positions are uploaded
 * RELATIVE to an origin at the property, and the origin is folded into the
 * matrix in 64-bit JavaScript every frame.
 *
 * Heights are drawn above the lot's own median ground, so the ground sits on
 * the flat map and a 10 m crown stands 10 m above it.
 */

const WORLD = 2 * Math.PI * 6378137;

/** EPSG:3857 metres -> Mapbox mercator units (0..1, y down). */
export const mercUnits = (x, y) => [(x + WORLD / 2) / WORLD, (WORLD / 2 - y) / WORLD];

/**
 * What colour a point is drawn, by what it is: RGB, opacity, and size
 * relative to the base. Ground is small and faint so the photo shows
 * through it -- drawn solid, at QL2 density it is a carpet over the lawn.
 */
export const KINDS = {
  ground: [0.62, 0.45, 0.25, 0.35, 0.6],
  low: [0.55, 0.8, 0.35, 0.7, 0.8], // under 2 m: grass, shrubs, cars
  through: [0.1, 0.85, 0.3, 1, 1], // a return from a pulse that went on: leaves, branches
  solid: [0.95, 0.3, 0.25, 1, 1], // 2 m+ and the pulse stopped there: roofs, dense crowns
};

/** Per-point kind, from class, returns and height over the ground. */
export function kindOf(cls, ret, nret, over) {
  if (cls === 2) return 'ground';
  if (over < 2) return 'low';
  if (nret > 1 && ret < nret) return 'through';
  return 'solid';
}

function mul(a, b) {
  const o = new Float64Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}

/**
 * A custom layer for `cols` (las.js columns). `heightOver(i)` is the point's
 * height above the ground beneath it; `shift` ([dx, dy], 3857 m) moves the
 * cloud (the datum correction plus the measured residual).
 */
export function pointLayer(id, cols, { heightOver, shift = [0, 0], baseZ, lat, size = 3 }) {
  const n = cols.n;
  const ox = cols.n ? cols.x[0] + shift[0] : 0, oy = cols.n ? cols.y[0] + shift[1] : 0;
  const [mx, my] = mercUnits(ox, oy);
  const unitsPerMetre = 1 / (WORLD * Math.cos(lat * Math.PI / 180));
  const perMerc = 1 / WORLD; // 3857 metres -> mercator units
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (cols.x[i] + shift[0] - ox) * perMerc;
    pos[i * 3 + 1] = -(cols.y[i] + shift[1] - oy) * perMerc;
    pos[i * 3 + 2] = (cols.z[i] - baseZ) * unitsPerMetre;
    const c = KINDS[kindOf(cols.cls[i], cols.ret[i], cols.nret[i], heightOver(i))];
    col.set(c, i * 5);
  }
  let prog, bPos, bCol, aPos, aCol, aSize, uM, uSize;
  return {
    id, type: 'custom', renderingMode: '3d',
    pointSize: size,
    onAdd(map, gl) {
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
        uniform mat4 uM; uniform float uSize;
        attribute vec3 aPos; attribute vec4 aCol; attribute float aSize; varying vec4 vCol;
        void main() { gl_Position = uM * vec4(aPos, 1.0); gl_PointSize = uSize * aSize; vCol = aCol; }`));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
        precision mediump float; varying vec4 vCol;
        void main() { gl_FragColor = vec4(vCol.rgb * vCol.a, vCol.a); }`));
      gl.linkProgram(prog);
      aPos = gl.getAttribLocation(prog, 'aPos');
      aCol = gl.getAttribLocation(prog, 'aCol');
      aSize = gl.getAttribLocation(prog, 'aSize');
      uM = gl.getUniformLocation(prog, 'uM');
      uSize = gl.getUniformLocation(prog, 'uSize');
      bPos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      bCol = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bCol); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    },
    render(gl, matrix) {
      const T = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, mx, my, 0, 1]);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uM, false, new Float32Array(mul(matrix, T)));
      gl.uniform1f(uSize, this.pointSize * (globalThis.devicePixelRatio || 1));
      gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
      gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(aSize); gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 20, 16);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, n);
    },
    onRemove(map, gl) { gl.deleteBuffer(bPos); gl.deleteBuffer(bCol); gl.deleteProgram(prog); },
  };
}
