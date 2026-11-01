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
 *     reset, hit: { position, type, distance } | null, points, gl, framebuffer, viewport, view, proj }
 *
 * The pure helpers (rankHits, trackingOf8w, engineChoice) are exported for
 * Node's tests; nothing touches the DOM until start() is called.
 */
import { dist3, matFromPose, invertRigid } from './frames.js';

export const CROSS = { x: 0.5, y: 0.5 };
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

async function startWebXR({ overlay, onFrame, onEvent }) {
  let session;
  const base = { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'anchors'], domOverlay: { root: overlay } };
  try {
    // the extra sensors the water session found Chrome grants (H68): asked for, not required
    session = await navigator.xr.requestSession('immersive-ar', { ...base, optionalFeatures: [...base.optionalFeatures, 'depth-sensing', 'camera-access', 'plane-detection'],
      depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] } });
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
  let reset = false, live = true;
  ref.addEventListener?.('reset', () => { reset = true; });
  session.addEventListener('end', () => { live = false; onEvent?.({ type: 'end' }); });
  overlay?.addEventListener('beforexrselect', (ev) => ev.preventDefault());
  const features = session.enabledFeatures ? [...session.enabledFeatures] : null;
  const frame = (t, xrFrame) => {
    if (!live) return;
    session.requestAnimationFrame(frame);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pose = xrFrame.getViewerPose(ref);
    const tracking = !pose ? 'lost' : pose.emulatedPosition ? 'limited' : 'normal';
    let hit = null;
    if (pose) {
      const rs = xrFrame.getHitTestResults(hits);
      if (rs.length) {
        const hp = rs[0].getPose(ref);
        if (hp) {
          const p = hp.transform.position, c = pose.transform.position;
          const d = dist3(p, c);
          if (d >= HIT_NEAR && d <= HIT_FAR) hit = { position: { x: p.x, y: p.y, z: p.z }, type: 'SURFACE', distance: d };
        }
      }
    }
    const view = pose?.views[0] || null;
    const vp = view ? layer.getViewport(view) : null;
    const p = pose?.transform.position, q = pose?.transform.orientation;
    onFrame({
      t, tracking, reset, hit, points: 0,
      pose: pose ? { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } } : null,
      gl, framebuffer: layer.framebuffer, viewport: vp ? { x: vp.x, y: vp.y, w: vp.width, h: vp.height } : null,
      view: view ? view.transform.inverse.matrix : null, proj: view ? view.projectionMatrix : null,
    });
    reset = false;
  };
  session.requestAnimationFrame(frame);
  return { engine: 'webxr', features, stop: () => session.end().catch(() => {}) };
}

/* ------------------------------------------------------------- 8th Wall */

async function start8thWall({ canvas, onFrame, onEvent, eightWallUrl }) {
  const XR8 = await load8thWall(eightWallUrl);
  // iPhone asks for the motion sensors from a tap; the engine may ask again, which is fine
  try { if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission(); } catch { /* the engine will say */ }
  XR8.XrController.configure({ scale: 'absolute', enableWorldPoints: true });
  let gl = null, reality = null, status = { status: 'LIMITED', reason: 'INITIALIZING' }, live = true, lastT = 0;
  const mod = {
    name: 'lawnscan',
    onStart: () => { XR8.XrController.updateCameraProjectionMatrix({ origin: { x: 0, y: 1.5, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } }); onEvent?.({ type: 'started' }); },
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
        try { hit = rankHits(XR8.XrController.hitTest(CROSS.x, CROSS.y, ['FEATURE_POINT']), pose.position); } catch { hit = null; }
      }
      onFrame({
        t, tracking, reset: false, hit, points: r?.worldPoints?.length || 0, pose,
        gl, framebuffer: null, viewport: { x: 0, y: 0, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight }, view, proj,
      });
    },
    onException: (e) => onEvent?.({ type: 'error', message: String(e?.message || e) }),
    onCameraStatusChange: ({ status: s }) => onEvent?.({ type: 'camera', status: s }),
    listeners: [{ event: 'reality.trackingstatus', process: (d) => { status = { status: d?.status, reason: d?.reason }; onEvent?.({ type: 'tracking', ...status }); } }],
  };
  XR8.clearCameraPipelineModules();
  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());
  XR8.addCameraPipelineModule(mod);
  XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().MOBILE });
  return {
    engine: '8thwall', features: ['slam', 'world-points'],
    stop: () => { live = false; try { XR8.stop(); XR8.clearCameraPipelineModules(); } catch { /* already */ } onEvent?.({ type: 'end' }); },
  };
}
