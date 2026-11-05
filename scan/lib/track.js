/**
 * ONE TRACKING INTERFACE, TWO ENGINES (core session, docs/SCAN-PLAN.md 3.1).
 *
 * The page asks for "a camera pose each frame, a hit under the crosshair,
 * the points the engine sees, and the GL context to draw on", and gets it
 * from whichever engine this phone has:
 *
 *   webxr     Chrome on Android (ARCore): WebXR's immersive-ar session with
 *             hit-test, as the water session's test page used it
 *             (water/public/ar.js, FINDINGS H64-H68; its session set-up is
 *             carried here).
 *   8thwall   iPhone Safari (and any phone, for comparison): the 8th Wall
 *             engine binary's SLAM (scan/vendor/xr/xr.js, copied from
 *             @8thwall/engine-binary at deploy time; its notice stays in the
 *             file and the page credits it). It runs in "standalone mode":
 *             the binary's own words, with no app key and no 8th Wall server.
 *
 * Both report in the SESSION frame: metres, y up, -z ahead at the start
 * (scan/lib/frames.js). The crosshair is the exact centre of the view, so one
 * hit test serves both.
 *
 * Every frame the page gets:
 *   { t, pose: { position, quaternion } | null, tracking: 'normal' | 'limited' | 'lost',
 *     reset, hit: { position, type, distance, plane? } | null, depth: { at(x, y) } | null, points,
 *     gl, framebuffer, viewport, view, proj }
 *
 * THE GROUND UNDER THE CROSSHAIR, on WebXR, comes from the phone's depth picture first (type 'DEPTH': the
 * distance the camera measures to what the crosshair is on, SCAN-H1) and from the engine's hit test only when
 * there is no depth (type 'SURFACE'). The hit test accepts planes, and ARCore stretches a plane far past where
 * it saw it: on the owner's first walk the front yard's plane reached under the back yard, 6 ft lower, and pins
 * went "several feet under ground". With depth, the plane's answer rides along as `plane` for comparison.
 *
 * ANCHORS (WebXR): tracker.anchor(position) asks the engine to hold a point; tracker.anchorAt(a) is where the
 * engine now says it is. ARCore moves anchors when it corrects its map, which is what carried two pins 3 m on
 * the first walk; whether anchors would have followed is what the second walk measures.
 *
 * The pure helpers (rankHits, trackingOf8w, engineChoice) are exported for
 * Node's tests; nothing touches the DOM until start() is called.
 */
import { dist3, matFromPose, invertRigid, unproject } from './frames.js';

export const CROSS = { x: 0.5, y: 0.5 };
/** 8th Wall, responsive scale: how high the phone is held over the ground when the walk starts (it sets the scale). */
export const PHONE_HEIGHT_M = 1.4;
const HIT_NEAR = 0.3, HIT_FAR = 20; // m: a hit closer or farther is noise

/** 8th Wall's hit test answers several estimates; the best is a found surface, then an estimated one, then the nearest point. */
export function rankHits(results, from = null) {
  if (!Array.isArray(results) || !results.length) return null;
  const order = { DETECTED_SURFACE: 0, ESTIMATED_SURFACE: 1, FEATURE_POINT: 2, UNSPECIFIED: 3 };
  const ok = results.filter((r) => r?.position && Number.isFinite(r.position.x) && (r.distance == null || (r.distance >= HIT_NEAR && r.distance <= HIT_FAR)));
  if (!ok.length) return null;
  ok.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || (a.distance ?? 1e9) - (b.distance ?? 1e9));
  const h = ok[0];
  const distance = h.distance ?? (from ? dist3(from, h.position) : null);
  return { position: { x: h.position.x, y: h.position.y, z: h.position.z }, type: h.type || 'UNSPECIFIED', distance };
}

/** 8th Wall's world points as plain session points: confident, finite ones only (the engine's own `confidence`, 0-1). */
export function worldPointsOf(list, minConfidence = 0.5) {
  const out = [];
  for (const w of list || []) {
    const p = w?.position || w;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    if (w.confidence != null && w.confidence < minConfidence) continue;
    out.push({ x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/** 8th Wall says LIMITED or NORMAL, with a reason; before it has found its feet (INITIALIZING) nothing it says is a place. */
export function trackingOf8w(status, reason) {
  if (status === 'NORMAL') return 'normal';
  return reason === 'INITIALIZING' ? 'lost' : 'limited';
}

/** Which engines to offer and which to start by default. */
export function engineChoice({ hasXR = false, has8w = false, ios = false, prefer = null } = {}) {
  const offered = [];
  if (hasXR) offered.push('webxr');
  if (has8w) offered.push('8thwall');
  if (prefer && offered.includes(prefer)) return { offered, start: prefer };
  if (offered.length) return { offered, start: offered[0] };
  return { offered, start: null, why: ios ? 'no8w-ios' : 'none' };
}

export const isIOS = (ua = navigator.userAgent, touchMac = navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || '')) => /iPhone|iPad|iPod/.test(ua) || touchMac;

/** What this phone offers. eightWallUrl: where the binary is served from (null when the site has none). */
export async function detect({ eightWallUrl = null } = {}) {
  const out = { webxr: false, eightWall: !!eightWallUrl, ios: isIOS(), secure: !!window.isSecureContext, why: null };
  if (!out.secure) { out.why = 'AR needs the secure (https) page.'; return out; }
  if (navigator.xr) { try { out.webxr = await navigator.xr.isSessionSupported('immersive-ar'); } catch { out.webxr = false; } }
  return out;
}

/** The 8th Wall binary, loaded once, on demand (1 MB, then the 5.5 MB SLAM chunk it preloads). */
export function load8thWall(url) {
  if (window.XR8) return Promise.resolve(window.XR8);
  if (load8thWall.p) return load8thWall.p;
  load8thWall.p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = true; s.crossOrigin = 'anonymous'; s.setAttribute('data-preload-chunks', 'slam');
    const timer = setTimeout(() => reject(new Error('the 8th Wall engine did not load in 90 s')), 90000);
    s.onerror = () => { clearTimeout(timer); reject(new Error('the 8th Wall engine did not load')); };
    window.addEventListener('xrloaded', () => { clearTimeout(timer); resolve(window.XR8); }, { once: true });
    document.head.appendChild(s);
  });
  return load8thWall.p;
}

/**
 * Start tracking. { engine, overlay (WebXR's dom overlay root), canvas (8th Wall draws on it), onFrame, onEvent, eightWallUrl }
 * -> { engine, stop(), features }
 */
export async function start(opts) {
  if (opts.engine === 'webxr') return startWebXR(opts);
  if (opts.engine === '8thwall') return start8thWall(opts);
  throw new Error(`no such engine: ${opts.engine}`);
}

/* ---------------------------------------------------------------- WebXR */

/**
 * THE CAMERA'S PICTURE (WebXR camera-access), for the twin. The picture is a GL texture good only during the frame,
 * so it is drawn into a small framebuffer of our own, read back and made a JPEG off the frame. At most `maxW` wide.
 * -> grab(view, restoreTo) -> { blob: Promise<Blob>, w, h, proj, view } or null. GL state the page's drawing relies on
 * (program, framebuffer, viewport, the array buffer, attribute 0) is put back.
 */
export function cameraGrabber(session, gl, maxW = 640) {
  let binding = null, prog = null, buf = null, fbo = null, tex = null, fw = 0, fh = 0, loc = -1, uloc = null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  return (view, restoreTo) => {
    try {
      binding ||= new XRWebGLBinding(session, gl);
      const cam = view.camera, src = binding.getCameraImage(cam);
      if (!src) return null;
      const scale = Math.min(1, maxW / cam.width), w = Math.round(cam.width * scale), h = Math.round(cam.height * scale);
      if (!prog) {
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }'));
        gl.linkProgram(prog); loc = gl.getAttribLocation(prog, 'p'); uloc = gl.getUniformLocation(prog, 't');
        buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      }
      if (!fbo || fw !== w || fh !== h) {
        tex = tex || gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        fbo = fbo || gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        fw = w; fh = h;
      }
      const prevProg = gl.getParameter(gl.CURRENT_PROGRAM), prevBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING), prevVp = gl.getParameter(gl.VIEWPORT);
      const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D), blend = gl.isEnabled(gl.BLEND), depthT = gl.isEnabled(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prog); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(uloc, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.disableVertexAttribArray(loc);
      gl.bindTexture(gl.TEXTURE_2D, prevTex); gl.useProgram(prevProg); gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, restoreTo); gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      if (blend) gl.enable(gl.BLEND); if (depthT) gl.enable(gl.DEPTH_TEST);
      // GL reads bottom row first: flip into a picture the right way up
      const img = new ImageData(w, h), row = w * 4;
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      // the JPEG only when asked for (a picture for the twin); the colours alone need none
      let jpeg = null;
      const blobOf = () => jpeg || (jpeg = (() => {
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        canvas.getContext('2d').putImageData(img, 0, 0);
        return canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) : new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.8));
      })());
      // pixels: the picture the right way up (RGBA rows from the top), for the ground's colour (scan/lib/surface.js)
      return { get blob() { return blobOf(); }, w, h, pixels: img.data, proj: Array.from(view.projectionMatrix), view: Array.from(view.transform.matrix) };
    } catch {
      return null;
    }
  };
}

async function startWebXR({ overlay, onFrame, onEvent }) {
  let session;
  const base = { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'anchors'], domOverlay: { root: overlay } };
  try {
    // the extra sensors the water session found Chrome grants (H68): asked for, not required
    session = await navigator.xr.requestSession('immersive-ar', { ...base, optionalFeatures: [...base.optionalFeatures, 'depth-sensing', 'camera-access', 'plane-detection'],
      /* depthTypeRequest (the owner's reading, 2026-11-04: low-confidence depth can be filtered): "raw" depth comes with
         the least processing, and the runtime marks what it is not confident of invalid (0, which depth.at drops);
         "smooth" fills those in, and the fill across plain grass is the likeliest source of SCAN-H7's invented points.
         A request only; the runtime may give smooth anyway, and the walk's log says which (depthType). */
      depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'], depthTypeRequest: ['raw', 'smooth'] } });
  } catch {
    session = await navigator.xr.requestSession('immersive-ar', base);
  }
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const ref = await session.requestReferenceSpace('local');
  const viewer = await session.requestReferenceSpace('viewer');
  let hits;
  try { hits = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane', 'point'] }); } catch { hits = await session.requestHitTestSource({ space: viewer }); }
  const features = session.enabledFeatures ? [...session.enabledFeatures] : null;
  let reset = false, live = true, depthType = null;
  const hasDepth = !!features?.includes('depth-sensing') && typeof XRFrame !== 'undefined' && 'getDepthInformation' in XRFrame.prototype;
  const anchorsOn = !!features?.includes('anchors') && typeof XRFrame !== 'undefined' && 'createAnchor' in XRFrame.prototype;
  const anchorQueue = [], anchorPos = new Map();
  const grabber = features?.includes('camera-access') && typeof XRWebGLBinding !== 'undefined' ? cameraGrabber(session, gl) : null;
  ref.addEventListener?.('reset', () => { reset = true; });
  session.addEventListener('end', () => { live = false; onEvent?.({ type: 'end' }); });
  overlay?.addEventListener('beforexrselect', (ev) => ev.preventDefault());
  const frame = (t, xrFrame) => {
    if (!live) return;
    session.requestAnimationFrame(frame);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pose = xrFrame.getViewerPose(ref);
    const tracking = !pose ? 'lost' : pose.emulatedPosition ? 'limited' : 'normal';
    const view = pose?.views[0] || null;
    let hit = null, plane = null, depth = null;
    if (pose) {
      const c = pose.transform.position;
      const rs = xrFrame.getHitTestResults(hits);
      if (rs.length) {
        const hp = rs[0].getPose(ref);
        if (hp) {
          const p = hp.transform.position, d = dist3(p, c);
          if (d >= HIT_NEAR && d <= HIT_FAR) plane = { position: { x: p.x, y: p.y, z: p.z }, type: 'SURFACE', distance: d };
        }
      }
      if (hasDepth && view) {
        try {
          const di = xrFrame.getDepthInformation(view);
          if (di && depthType == null) depthType = di.depthType || 'not said';
          const z = di ? di.getDepthInMeters(CROSS.x, CROSS.y) : 0;
          if (z >= HIT_NEAR && z <= HIT_FAR) {
            const p = unproject(CROSS.x, CROSS.y, z, view.projectionMatrix, view.transform.matrix);
            hit = { position: p, type: 'DEPTH', distance: dist3(p, c), plane: plane?.position || null };
          }
          // the whole depth picture, for the lidar match: a point at any screen spot (0-1), 0.4-8 m, or null
          if (di) {
            const P = view.projectionMatrix, M = view.transform.matrix;
            depth = { at: (x, y) => { let d = 0; try { d = di.getDepthInMeters(x, y); } catch { return null; } return d >= 0.4 && d <= 8 ? unproject(x, y, d, P, M) : null; } };
          }
        } catch { /* no depth this frame */ }
      }
      if (!hit && plane) hit = { ...plane, plane: null };
      // anchors asked for since the last frame, and where the engine now puts the ones it holds
      while (anchorQueue.length) {
        const q = anchorQueue.shift();
        if (!anchorsOn) { q.resolve(null); continue; }
        try {
          xrFrame.createAnchor(new XRRigidTransform(q.position), ref).then((a) => { anchorPos.set(a, { ...q.position }); q.resolve(a); }, () => q.resolve(null));
        } catch { q.resolve(null); }
      }
      if (xrFrame.trackedAnchors) {
        for (const a of anchorPos.keys()) {
          if (!xrFrame.trackedAnchors.has(a)) continue;
          const ap = xrFrame.getPose(a.anchorSpace, ref);
          if (ap) { const q = ap.transform.position; anchorPos.set(a, { x: q.x, y: q.y, z: q.z }); }
        }
      }
    }
    const vp = view ? layer.getViewport(view) : null;
    const p = pose?.transform.position, q = pose?.transform.orientation;
    onFrame({
      t, tracking, reset, hit, depth, depthType, points: 0,
      pose: pose ? { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } } : null,
      gl, framebuffer: layer.framebuffer, viewport: vp ? { x: vp.x, y: vp.y, w: vp.width, h: vp.height } : null,
      view: view ? view.transform.inverse.matrix : null, proj: view ? view.projectionMatrix : null,
      // the camera's picture of this frame, for the twin (scan/lib/twin.js): call during this frame only
      grab: grabber && view?.camera ? () => grabber(view, layer.framebuffer) : null,
    });
    reset = false;
  };
  session.requestAnimationFrame(frame);
  return {
    engine: 'webxr', features, depth: hasDepth, get depthType() { return depthType; }, anchors: anchorsOn, stop: () => session.end().catch(() => {}),
    anchor: (position) => new Promise((resolve) => { if (!anchorsOn || !live) resolve(null); else anchorQueue.push({ position: { x: position.x, y: position.y, z: position.z }, resolve }); }),
    anchorAt: (a) => anchorPos.get(a) || null,
  };
}

/* ------------------------------------------------------------- 8th Wall */

async function start8thWall({ canvas, onFrame, onEvent, eightWallUrl }) {
  // iPhone grants the motion sensors only from a tap, and a tap's grace does not outlast a 7 MB download: ask first,
  // then load the engine (which may ask again; a second ask answers at once)
  try { if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) { const r = await DeviceMotionEvent.requestPermission(); onEvent?.({ type: 'motion', status: r }); } } catch (e) { onEvent?.({ type: 'motion', status: `refused: ${e.message}` }); }
  const XR8 = await load8thWall(eightWallUrl);
  /* RESPONSIVE SCALE, NOT ABSOLUTE (2026-11-05). Every 8th Wall walk on the S21 walked 0-1.5 m, flipped between
     INITIALIZING and NORMAL, and put its ground "a few inches from the phone". 'absolute' asks the engine to estimate
     metric scale itself, which it does only from a guided calibration (8th Wall's Coaching Overlay: "a flow to
     generate appropriate data for scale estimation"), which this page never ran; until then its positions are not
     metres and its ground is not the ground (the binary sets origin.y to 1 and the scale to 1 in that mode).
     'responsive' is the engine's own default and what its apps run: the scene's ground is y = 0 and the camera
     starts PHONE_HEIGHT_M above it, which fixes the scale; the walk's references fit any scale left over (T.s). */
  XR8.XrController.configure({ scale: 'responsive', enableWorldPoints: true });
  let gl = null, reality = null, status = { status: 'LIMITED', reason: 'INITIALIZING' }, live = true, lastT = 0;
  const mod = {
    name: 'lawnscan',
    onStart: () => { XR8.XrController.updateCameraProjectionMatrix({ origin: { x: 0, y: PHONE_HEIGHT_M, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } }); onEvent?.({ type: 'started', scale: 'responsive', phoneHeightM: PHONE_HEIGHT_M }); },
    onUpdate: ({ frameStartResult, processCpuResult }) => { gl = frameStartResult?.GLctx || gl; reality = processCpuResult?.reality || null; },
    onRender: () => {
      if (!live || !gl) return;
      const t = performance.now();
      if (t - lastT < 8) return;
      lastT = t;
      const r = reality;
      const tracking = r ? trackingOf8w(status.status, status.reason) : 'lost';
      let hit = null, view = null, proj = null, pose = null;
      if (r && tracking !== 'lost') {
        pose = { position: { x: r.position.x, y: r.position.y, z: r.position.z }, quaternion: { x: r.rotation.x, y: r.rotation.y, z: r.rotation.z, w: r.rotation.w } };
        view = invertRigid(matFromPose(pose.quaternion, pose.position));
        proj = r.intrinsics ? Float32Array.from(r.intrinsics) : null;
        /* the surfaces too, not feature points alone (the owner, 2026-11-05: "8th wall just didn't work at all... It
           couldn't even find the ground"): rankHits prefers a detected, then an estimated surface, but was only ever
           offered feature points, so no hit was ever the ground */
        /* the ESTIMATED surface is the engine's ground (y = 0 in responsive scale, PHONE_HEIGHT_M under the start);
           it was dropped while the page ran absolute scale, where it sat inches under the phone. A surface counts only
           well below the camera, so a ground that has not settled cannot be marked on. */
        try {
          const all = XR8.XrController.hitTest(CROSS.x, CROSS.y, ['DETECTED_SURFACE', 'ESTIMATED_SURFACE', 'FEATURE_POINT']) || [];
          hit = rankHits(all.filter((h) => !/SURFACE$/.test(h?.type || '') || (h.position && pose.position.y - h.position.y > 0.5)), pose.position);
        } catch { hit = null; }
      }
      onFrame({
        /* THE WORLD POINTS (2026-11-05): the engine's web build gives no depth map (its depth field is internal), but
           it does give the 3D feature points its tracking stands on, { confidence, position }. Configured on from
           the start and, until now, only counted. They are this engine's points for the twin and the match. */
        t, tracking, reset: false, hit, depth: null, points: r?.worldPoints?.length || 0, pose,
        world: tracking === 'normal' && r?.worldPoints?.length ? worldPointsOf(r.worldPoints) : null,
        gl, framebuffer: null, viewport: { x: 0, y: 0, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight }, view, proj,
      });
    },
    onException: (e) => onEvent?.({ type: 'error', message: String(e?.message || e) }),
    onCameraStatusChange: ({ status: s }) => onEvent?.({ type: 'camera', status: s }),
    // the engine hands a listener { name, detail }; older builds the detail itself
    listeners: [{ event: 'reality.trackingstatus', process: (ev) => { const d = ev?.detail || ev; status = { status: d?.status, reason: d?.reason }; onEvent?.({ type: 'tracking', ...status }); } }],
  };
  // the canvas's drawing buffer at the screen's size before the engine starts: left at the default 300 x 150 and
  // stretched by its style, the camera came out as a blurred, distorted picture (the owner, 2026-11-01)
  const size = () => { const r = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(window.innerWidth * r); canvas.height = Math.round(window.innerHeight * r); };
  size();
  window.addEventListener('resize', size);
  XR8.clearCameraPipelineModules();
  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());
  XR8.addCameraPipelineModule(mod);
  XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().MOBILE });
  return {
    engine: '8thwall', features: ['slam', 'world-points'], depth: false, anchors: false,
    anchor: async () => null, anchorAt: () => null,
    stop: () => { live = false; window.removeEventListener('resize', size); try { XR8.stop(); XR8.clearCameraPipelineModules(); } catch { /* already */ } onEvent?.({ type: 'end' }); },
  };
}
