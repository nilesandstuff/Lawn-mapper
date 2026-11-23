/**
 * EVERY POINT OF A WALK, IN 3D, TO BE LOOKED AT, INSPECTED AND ERASED BY HAND (core session, 2026-11-19).
 *
 * The owner, after a day of studies whose pictures did not settle what was real: "build a full 3D render of every
 * single point, not filtered, and I could view it in a 3d viewer and an inspect button that allows me to see the
 * picture associated with that spot, then I can erase the bad ones point by point. Then you'll get the absolute best
 * possible idea of what's real and what's not so we can settle it once and for all. Important: the view should have
 * a fairly shallow depth of field so I can erase things without accidentally deleted things in the foreground and
 * background."
 *
 * EVERY record of the twin is drawn: the cloud's (cloud-NNNN.bin) and then the weak ones (weak-NNNN.bin), Google's
 * street shapes and spikes too; nothing is filtered. THE ORDER OF RECORDS is that order, parts by name, and it is what
 * an index in erased.bin means (scan/tools/view_prep.py says the same).
 *
 * IN FOCUS: a band of the scene at the distance of the view's centre from the eye, as deep as the slider says. Only
 * points in it are solid, and only they can be inspected or erased. Tapping a point makes it the centre.
 *
 * ERASED is a list kept beside the walk (twin part erased.bin, Uint32 indexes); nothing of the walk is deleted.
 * Admin only: every route this reads answers nobody else.
 */
import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { LABELS } from '/lib/twin.js';

const $ = (s) => document.querySelector(s);
const walk = new URLSearchParams(location.search).get('walk');
const FT = 3.281;
// A PART THAT IS MADE AGAIN (the view's files, the erasing) is never taken from the browser's own store: the site
// let a part be kept an hour, so a walk prepared again was shown from its first, wrong file (2026-11-21).
const FRESH = /^(view|erased|seg|study|judged|trunks|plants|built|owner-)/;
const part = (name, init) => fetch(`/api/scan/twin?walk=${encodeURIComponent(walk)}&part=${encodeURIComponent(name)}`, { credentials: 'same-origin', ...(FRESH.test(name) ? { cache: 'no-store' } : {}), ...init });
const LABEL_COL = { terrain: [120, 190, 90], road: [110, 110, 125], sidewalk: [185, 185, 195], building: [215, 90, 70], structure: [235, 160, 70], tree: [40, 150, 70],
  object: [170, 110, 210], vehicle: [80, 140, 235], water: [70, 200, 230], sky: [255, 0, 255], person: [255, 255, 255], unlabeled: [150, 150, 150] };
const SOURCE = [['measured by the camera', [150, 175, 200]], ['seen again from another place', [90, 210, 120]], ['weak depth', [245, 160, 50]], ["Google's street shapes", [175, 110, 235]], ['a spike', [255, 70, 70]]];

const D = { n: 0, pos: null, t: null, ground: null, label: null, lconf: null, dconf: null, flags: null, rgb: null, state: null, keys: [], track: [], c2w: [], view: null };
const U = { mode: 'look', undo: [], dirty: false, saveTimer: 0, inspect: null, pointers: new Map(), stroke: null };
let renderer, scene, camera, controls, points, material;

async function main() {
  if (!walk) { $('#status').textContent = 'Which walk? Open this from a walk\'s twin page.'; return; }
  $('#twin-link').href = `/twin.html?walk=${encodeURIComponent(walk)}`;
  const j = await (await fetch(`/api/scan/twin?walk=${encodeURIComponent(walk)}`, { credentials: 'same-origin' })).json();
  const names = (j.parts || []).map((p) => p.name).sort();
  if (!names.length) { $('#status').textContent = 'No twin was kept for this walk.'; return; }
  const buf = async (n) => (await part(n)).arrayBuffer();
  const clouds = [], labs = [];
  const got = { cloud: 0, weak: 0, labels: 0, failed: 0 };
  /* THE PHOTOS' OWN DEPTH, JOINED (scan/tools/dense_prep.py, 2026-11-20; ?dense=1): every depth cell of every photo
     put into space with its photo's colour and its pixel's kind, merged in 3 in cubes. Not the walk's own records,
     so nothing here can be erased. A point: Float32 x, y, z, t; Uint8 r, g, b, kind, photos that saw it, source
     (1 the phone's smoothed depth), 0, 0. */
  let DENSE = null;
  const wantDense = new URLSearchParams(location.search).get('dense');
  // ?dense=1 the joined cloud; ?dense=2 the same MENDED (the walk's drift taken out of itself, mend_study.py)
  const denseFile = wantDense === '2' ? 'view-mended.bin' : 'view-dense.bin';
  { const dl = $('#dense-link'); if (dl) {
    const next = !wantDense ? ['1', "The photos' own depth, joined"] : wantDense === '1' && names.includes('view-mended.bin') ? ['2', 'The same, mended for drift'] : ['', "The walk's own points"];
    dl.href = `/cloud.html?walk=${encodeURIComponent(walk)}${next[0] ? `&dense=${next[0]}` : ''}`; dl.textContent = next[1]; dl.hidden = !names.includes('view-dense.bin'); } }
  if (wantDense && names.includes(denseFile)) {
    $('#status').textContent = 'Reading the photos\' depth…';
    const b = await buf(denseFile), n = Math.floor(b.byteLength / 24), dv = new DataView(b);
    const f = new Float32Array(n * 6), L = new Uint8Array(n * 4), rgb = new Uint8Array(n * 4), kind = new Uint8Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 24) {
      f[i * 6] = dv.getFloat32(o + 12, true); f[i * 6 + 2] = dv.getFloat32(o, true); f[i * 6 + 3] = dv.getFloat32(o + 4, true); f[i * 6 + 4] = dv.getFloat32(o + 8, true); f[i * 6 + 5] = NaN;
      rgb[i * 4] = dv.getUint8(o + 16); rgb[i * 4 + 1] = dv.getUint8(o + 17); rgb[i * 4 + 2] = dv.getUint8(o + 18); rgb[i * 4 + 3] = 1; kind[i] = dv.getUint8(o + 19);
      L[i * 4 + 3] = (dv.getUint8(o + 21) ? 4 : 0) | (dv.getUint8(o + 20) > 1 ? 8 : 0);
    }
    clouds.push(f); labs.push(L); DENSE = { rgb, kind };
  }
  if (!DENSE) for (const [pre, lab] of [['cloud-', 'labels-'], ['weak-', 'weaklabels-']]) {
    for (const n of names.filter((x) => new RegExp(`^${pre}\\d+\\.bin$`).test(x))) {
      $('#status').textContent = `Reading ${n}…`;
      let ab = null;
      for (let t = 0; t < 3 && !ab; t++) { const r = await part(n).catch(() => null); if (r?.ok) { const x = await r.arrayBuffer().catch(() => null); if (x && x.byteLength % 24 === 0) ab = x; } }
      if (!ab) { got.failed++; continue; }
      got[pre === 'cloud-' ? 'cloud' : 'weak']++;
      const f = new Float32Array(ab), recs = Math.floor(f.length / 6), ln = n.replace(pre, lab);
      let u = names.includes(ln) ? new Uint8Array(await buf(ln)) : null;
      if (u && u.length !== recs * 4) u = null;
      clouds.push(f.subarray(0, recs * 6)); labs.push(u || new Uint8Array(recs * 4));
      if (pre === 'weak-' && !u) labs[labs.length - 1].fill(0);
      if (pre === 'weak-') { const L = labs[labs.length - 1]; for (let i = 0; i < recs; i++) L[i * 4 + 3] |= 4; }
    }
  }
  U.read = DENSE ? (wantDense === '2' ? 'the joined cloud MENDED, one file' : 'the joined cloud, one file') : `${got.cloud} cloud parts, ${got.weak} weak parts${got.failed ? `, ${got.failed} PARTS COULD NOT BE READ` : ''}`;
  const N = D.n = clouds.reduce((a, f) => a + f.length / 6, 0);
  D.pos = new Float32Array(N * 3); D.t = new Float32Array(N); D.ground = new Float32Array(N);
  D.label = new Uint8Array(N); D.lconf = new Uint8Array(N); D.dconf = new Uint8Array(N); D.flags = new Uint8Array(N); D.state = new Float32Array(N);
  let k = 0;
  clouds.forEach((f, ci) => {
    const L = labs[ci];
    for (let i = 0; i < f.length / 6; i++, k++) {
      D.t[k] = f[i * 6]; D.pos[k * 3] = f[i * 6 + 2]; D.pos[k * 3 + 1] = f[i * 6 + 3]; D.pos[k * 3 + 2] = f[i * 6 + 4]; D.ground[k] = f[i * 6 + 5];
      D.label[k] = L[i * 4]; D.lconf[k] = L[i * 4 + 1]; D.dconf[k] = L[i * 4 + 2]; D.flags[k] = L[i * 4 + 3];
    }
  });
  for (const n of names.filter((x) => /^keys-\d+\.json$/.test(x))) D.keys.push(...(await (await part(n)).json()));
  D.keys = D.keys.filter((q) => names.includes(q.name)).sort((a, b) => a.t - b.t);
  for (const n of names.filter((x) => /^track-\d+\.bin$/.test(x))) { const f = new Float32Array(await buf(n)); for (let i = 0; i + 10 <= f.length; i += 10) D.track.push([f[i], f[i + 2], f[i + 3], f[i + 4]]); }
  D.track.sort((a, b) => a[0] - b[0]);
  if (names.includes('view.json')) D.view = await (await part('view.json')).json().catch(() => null);
  // the tree trunks found in the joined cloud (scan/tools/trunks.py): the walk's own frame, drawn as brown posts
  // THE OWNER'S OWN TRUNKS (owner-trunks.json): where the owner tapped "a tree trunk is here", the truth the trunk
  // finder is tuned against (scan/tools/trunks.py scores itself on them). The walk's own frame, like the points.
  D.marks = [];
  if (names.includes('owner-trunks.json')) { const oj = await (await part('owner-trunks.json')).json().catch(() => null); if (Array.isArray(oj?.trunks)) D.marks = oj.trunks.filter((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)); }
  // THE PLANTS AT FACE VALUE (scan/tools/plants.py): every 1 ft cell where plant was seen over 3 ft, how low and how high
  if (names.includes('plants.json')) { const pj = await (await part('plants.json')).json().catch(() => null); D.plants = Array.isArray(pj?.shapes) ? pj.shapes : null; D.plantCell = pj?.cellM || 0.3048; }
  // the same from the phone's own labels alone (plants.py): can the phone draw them by itself, with no server?
  if (names.includes('plants-phone.json')) { const pj = await (await part('plants-phone.json')).json().catch(() => null); D.plantsPhone = Array.isArray(pj?.shapes) ? pj.shapes : null; }
  // the built things the walk saw, the same way (plants.py BUILT): walls where they stand, a porch, pillars
  if (names.includes('built.json')) { const bj = await (await part('built.json')).json().catch(() => null); D.built = Array.isArray(bj?.shapes) ? bj.shapes : null; }
  if (names.includes('trunks.json')) { const tj = await (await part('trunks.json')).json().catch(() => null); D.trunks = tj?.trunks || []; D.trunkSlice = tj?.sliceM || 0.25; }
  if (DENSE) { D.rgb = DENSE.rgb; D.kind = DENSE.kind; U.readonly = true; }
  if (!DENSE && names.includes('view-rgb.bin')) { const u = new Uint8Array(await buf('view-rgb.bin')); if (u.length === N * 4) D.rgb = u; }
  if (!DENSE && names.includes('view-kind.bin')) { const u = new Uint8Array(await buf('view-kind.bin')); if (u.length === N) D.kind = u; }
  if (!DENSE && names.includes('erased.bin')) { const e = new Uint32Array(await buf('erased.bin')); for (const i of e) if (i < N) D.state[i] = 1; }
  poses();
  build();
  const g = count(2), w = count(4), sp = count(1);
  $('#status').textContent = `${N.toLocaleString()} points: every one the walk kept (${g.toLocaleString()} are Google's street shapes, ${w.toLocaleString()} weak depth, ${sp} spikes), ${D.keys.length} photos.${D.rgb ? '' : ' Not yet coloured from the photos: that is made by a run (task view).'}`;
  note();
}
const count = (bit) => { let c = 0; for (let i = 0; i < D.n; i++) if (D.flags[i] & bit) c++; return c; };

/** Each photo's camera-to-session matrix. The web page's walks kept it; the app keeps ARCore's view matrix, its
 *  inverse (docs/SCAN-PLAN.md 30): whichever puts the cameras where the track says they were is the one. */
function poses() {
  const at = (t) => { let lo = 0, hi = D.track.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (D.track[m][0] < t) lo = m + 1; else hi = m; } return D.track[lo]; };
  const Ms = D.keys.map((q) => new THREE.Matrix4().fromArray(q.view));
  let asIs = 0, turned = 0, n = 0;
  if (D.track.length > 1) for (let i = 0; i < Ms.length; i += Math.max(1, Math.floor(Ms.length / 40))) {
    const tr = at(D.keys[i].t), a = new THREE.Vector3().setFromMatrixPosition(Ms[i]), b = new THREE.Vector3().setFromMatrixPosition(Ms[i].clone().invert());
    const w = new THREE.Vector3(tr[1], tr[2], tr[3]); asIs += a.distanceTo(w); turned += b.distanceTo(w); n++;
  }
  const inv = n ? turned < asIs : D.view?.pose === 'session to camera';
  D.c2w = Ms.map((M) => (inv ? M.clone().invert() : M));
}

function build() {
  const stage = $('#stage');
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  stage.prepend(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x05080f);
  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  // the walk's own middle: the median of the points the camera measured
  const mid = (o) => { const a = []; for (let i = 0; i < D.n; i += 7) if (!(D.flags[i] & 2)) a.push(D.pos[i * 3 + o]); a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
  const c = new THREE.Vector3(mid(0), mid(1), mid(2));
  camera.position.copy(c).add(new THREE.Vector3(0, 7, 11));
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(c); controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true; controls.maxDistance = 400; controls.minDistance = 0.3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(D.pos, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(D.n * 3), 3));
  geo.setAttribute('state', new THREE.BufferAttribute(D.state, 1));
  geo.setAttribute('tsec', new THREE.BufferAttribute(D.t, 1));
  // 1: Google's street shapes. 2: DEPTH THE PHONE WAS NOT SURE OF -- a weak record with depth confidence under 0.05
  // (2026-11-21: on the first walk that kept them they were 208,184 of 423,182 records, reaching 60 ft from the camera
  // and 53 ft above it, and the owner saw "a bubble... dozens of meters tall"), or in the joined cloud a point only
  // the smoothed depth saw. Hidden until asked for.
  geo.setAttribute('kind', new THREE.BufferAttribute(Float32Array.from(D.flags, (f, i) => (f & 2 ? 1 : (f & 4) && D.dconf[i] < 13 ? 2 : 0)), 1));
  material = new THREE.ShaderMaterial({
    uniforms: { size: { value: 6 }, focus: { value: 10 }, band: { value: 1 }, outside: { value: 1 }, showErased: { value: 0 }, google: { value: 1 }, unsure: { value: 0 }, sharp: { value: 0 }, tmin: { value: -1 }, px: { value: 1 } },
    vertexShader: `
      attribute vec3 tint; attribute float state; attribute float kind; attribute float tsec;
      uniform float size, focus, band, outside, showErased, google, unsure, sharp, tmin, px;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        // THE FOCUS BAND IS FOR ERASING AND INSPECTING, NOT FOR LOOKING (2026-11-21). Out of focus a point is drawn
        // small and at a quarter of its colour; a lawn's own greens at a quarter are the background's black, so on
        // a real walk everything outside the band vanished and the owner saw "only a very small slice of the walk".
        // In Look every point is drawn whole (sharp 0).
        bool inFocus = sharp < 0.5 || abs(d - focus) <= band;
        bool gone = tsec < tmin || (state > 0.5 && showErased < 0.5) || (kind > 0.5 && kind < 1.5 && google < 0.5) || (kind > 1.5 && unsure < 0.5) || (!inFocus && outside < 0.5) || d < 0.05;
        vC = state > 0.5 ? vec3(1.0, 0.15, 0.15) : (inFocus ? tint : mix(vec3(0.10, 0.11, 0.14), tint * 0.6 + 0.06, 0.6));
        gl_Position = gone ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
        gl_PointSize = inFocus ? clamp(size * px * 3.0 / max(d, 0.4), 2.0 * px, 16.0 * px) : 1.5 * px;
      }`,
    fragmentShader: 'varying vec3 vC; void main() { gl_FragColor = vec4(vC, 1.0); }',
  });
  points = new THREE.Points(geo, material); points.frustumCulled = false; scene.add(points);
  /* TREE TRUNKS (trunks.py; the goal: later walks "automatically place... trees (atleast the trunks...)"): each a
     brown post from the ground to as high as tree was seen over it, as thick as the trunk read. For the owner's eyes:
     is there a real tree at each, and is any real tree without one? */
  for (const t of D.trunks || []) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x8b5a2b, transparent: true, opacity: 0.8 });
    if (Array.isArray(t.slices) && t.slices.length) {
      // AS SEEN (trunks.json v2): a slice every 10 in of height, each with its own middle and width, so a lean, a
      // taper and a fork's first split show (the owner, 2026-11-22: "rasterize the shapes of the actual observed trunks")
      const sh = D.trunkSlice || 0.25;
      for (const [h, x, z, r] of t.slices) { const m = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.03, r), Math.max(0.03, r), sh, 10), mat); m.position.set(x, t.y + h + sh / 2, z); scene.add(m); }
    } else {
      const h = Math.max(1, t.top || t.seenTo || 2), r = Math.max(0.08, (t.across || 0.3) / 2);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat); m.position.set(t.x, t.y + h / 2, t.z); scene.add(m);
    }
  }
  /* THE PLANTS AT FACE VALUE (plants.py; the owner, 2026-11-23: "just mark trees in general and take their shapes at
     face value (but clean up the noise)"): a see-through green box in every 1 ft cell where the walk saw plant over
     3 ft, from the lowest it was seen there to the highest. One mesh for all of them. "Plant shapes" hides them. */
  if (D.plants?.length || D.plantsPhone?.length || D.built?.length) {
    const meshOf = (shapes, color) => {
      if (!shapes?.length) return null;
      const cells = shapes.flatMap((s) => s.cells.map((c) => [c[0], s.y + (c[2] + c[3]) / 2, c[1], Math.max(0.05, c[3] - c[2])]));
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false }), cells.length);
      const M = new THREE.Matrix4(), cw = (D.plantCell || 0.3048) * 0.96;
      cells.forEach(([x, y, z, h], i) => { M.makeScale(cw, h, cw); M.setPosition(x, y, z); im.setMatrixAt(i, M); });
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; scene.add(im);
      return im;
    };
    /* TWO WAYS TO THE SAME SHAPES, one button going round them: by the kinds voted from the pictures on a server
       (green), by the PHONE'S OWN LABELS ALONE (blue-green: what the phone could draw by itself at a walk's end; the
       roadmap, 2026-11-22: "as much processing... on the user's device as possible"), and off. */
    const ways = [['plants, by the pictures\' vote', meshOf(D.plants, 0x2faa4a)], ['plants, by the phone\'s labels alone', meshOf(D.plantsPhone, 0x1f9aa8)], ['built things (walls, porch, pillars)', meshOf(D.built, 0xb8a27a)]].filter((w) => w[1]);
    plantMesh = ways[0]?.[1] || null;
    let at = 0;
    const show = () => { ways.forEach((w, i) => { w[1].visible = i === at; }); const b = $('#plants-toggle'); if (b) { b.classList.toggle('on', at < ways.length); b.textContent = at < ways.length ? `Shapes: ${ways[at][0]}` : 'Shapes: off'; } };
    const b = $('#plants-toggle'); if (b) { b.hidden = false; b.addEventListener('click', () => { at = (at + 1) % (ways.length + 1); show(); }); }
    show();
  }
  markGroup = new THREE.Group(); scene.add(markGroup); drawMarks();
  // where the phone went: a thin line, so the walk can be found in the cloud
  if (D.track.length > 1) {
    const tp = new Float32Array(D.track.length * 3); D.track.forEach((r, i) => { tp[i * 3] = r[1]; tp[i * 3 + 1] = r[2]; tp[i * 3 + 2] = r[3]; });
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    scene.add(new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0x22d3ee })));
  }
  colour(); wire(); resize(); window.addEventListener('resize', resize);
  renderer.setAnimationLoop(() => {
    controls.update();
    material.uniforms.focus.value = camera.position.distanceTo(controls.target);
    renderer.render(scene, camera);
  });
}
function resize() {
  const s = $('#stage'), w = s.clientWidth, h = s.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  material.uniforms.px.value = renderer.getPixelRatio();
}

/* KINDS (scan/tools/studies.py VOTE_KINDS, in its order; view-kind.bin): what each kept point is by the vote of the
   photos that saw it and the phone's own label -- no shape matched to another (docs/SCAN-PLAN.md 36). */
const KIND_COL = [['none', [70, 70, 70]], ['built', [200, 80, 60]], ['fence', [150, 90, 190]], ['grass', [120, 190, 90]], ['bare ground', [150, 120, 80]], ['paved', [150, 150, 165]],
  ['plant (shrubs, beds)', [150, 215, 60]], ['movable', [60, 120, 220]], ['water', [60, 190, 220]], ['sky', [255, 0, 255]], ['tree', [20, 110, 50]]];
function colour() {
  const how = $('#colour').value, c = points.geometry.attributes.tint.array;
  for (let i = 0; i < D.n; i++) {
    let r = 150, g = 150, b = 150;
    const f = D.flags[i];
    if (how === 'picture') { if (D.rgb && D.rgb[i * 4 + 3]) { r = D.rgb[i * 4]; g = D.rgb[i * 4 + 1]; b = D.rgb[i * 4 + 2]; } else if (f & 2) { r = 120; g = 80; b = 170; } else { r = g = b = 110; } }
    else if (how === 'label') { [r, g, b] = D.label[i] ? LABEL_COL[LABELS[D.label[i] - 1]] || [150, 150, 150] : [95, 95, 95]; }
    else if (how === 'kind') { [r, g, b] = D.kind ? (KIND_COL[D.kind[i]] || KIND_COL[0])[1] : [95, 95, 95]; }
    else if (how === 'height') { const h = D.pos[i * 3 + 1] - D.ground[i]; if (Number.isFinite(h)) { const x = Math.max(0, Math.min(1, h / 3)); r = 40 + 215 * x; g = 200 - 120 * Math.abs(x - 0.5) * 2; b = 255 - 215 * x; } }
    else { [r, g, b] = SOURCE[f & 1 ? 4 : f & 2 ? 3 : f & 4 ? 2 : f & 8 ? 1 : 0][1]; }
    c[i * 3] = r / 255; c[i * 3 + 1] = g / 255; c[i * 3 + 2] = b / 255;
  }
  points.geometry.attributes.tint.needsUpdate = true;
  const sw = (col, name) => `<span style="display:inline-block;width:.8em;height:.8em;background:rgb(${col.join(',')});border-radius:2px;margin:0 .25em 0 .7em"></span>${name}`;
  $('#legend').innerHTML = how === 'label' ? Object.entries(LABEL_COL).map(([n, col]) => sw(col, n)).join('') + sw([95, 95, 95], 'none')
    : how === 'kind' ? (D.kind ? [...KIND_COL.slice(1, 9), KIND_COL[10]].map(([n, col]) => sw(col, n)).join('') + sw(KIND_COL[0][1], 'not kept, or nothing named it') : 'kinds are not made for this walk yet')
    : how === 'source' ? SOURCE.map(([n, col]) => sw(col, n)).join('')
    : how === 'height' ? 'blue at the ground the phone took, through green, to red 10 ft over it'
    : 'each point in the colour of the photo taken when it was seen; grey where no photo saw it; purple: Google\'s street shapes';
}

/** The points under a place on the screen (x, y in CSS pixels of the stage), within r pixels, IN FOCUS only (and of
 *  the kind asked: erased ones for bringing back, the rest otherwise). fn(index, distance on screen squared). */
const M = new THREE.Matrix4(), MV = new THREE.Matrix4();
function under(x, y, r, wantErased, fn) {
  const s = $('#stage'), w = s.clientWidth, h = s.clientHeight;
  MV.copy(camera.matrixWorldInverse); M.multiplyMatrices(camera.projectionMatrix, MV);
  const e = M.elements, v = MV.elements, focus = material.uniforms.focus.value, half = material.uniforms.band.value, g = material.uniforms.google.value > 0.5, uns = material.uniforms.unsure.value > 0.5, tm = material.uniforms.tmin.value, r2 = r * r, P = D.pos;
  for (let i = 0; i < D.n; i++) {
    if ((D.state[i] > 0.5) !== wantErased) continue;
    if (D.t[i] < tm) continue;
    if (!g && (D.flags[i] & 2)) continue;
    if (!uns && (D.flags[i] & 4) && D.dconf[i] < 13 && !(D.flags[i] & 2)) continue;
    const X = P[i * 3], Y = P[i * 3 + 1], Z = P[i * 3 + 2];
    const d = -(v[2] * X + v[6] * Y + v[10] * Z + v[14]);
    if (Math.abs(d - focus) > half) continue;
    const cw = e[3] * X + e[7] * Y + e[11] * Z + e[15]; if (cw <= 0) continue;
    const sx = ((e[0] * X + e[4] * Y + e[8] * Z + e[12]) / cw * 0.5 + 0.5) * w, sy = (0.5 - (e[1] * X + e[5] * Y + e[9] * Z + e[13]) / cw * 0.5) * h;
    const q = (sx - x) * (sx - x) + (sy - y) * (sy - y);
    if (q <= r2) fn(i, q);
  }
}
/** The nearest point to a tap, in focus or (for Look's "make this the centre") anywhere in front of the eye. */
function pick(x, y, anywhere = false) {
  let best = -1, bq = Infinity;
  if (!anywhere) { under(x, y, 26, false, (i, q) => { if (q < bq) { bq = q; best = i; } }); return best; }
  const half = material.uniforms.band.value; material.uniforms.band.value = 1e9;
  let bd = Infinity;
  under(x, y, 18, false, (i) => { const d = camera.position.distanceToSquared(new THREE.Vector3(D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2])); if (d < bd) { bd = d; best = i; } });
  material.uniforms.band.value = half;
  return best;
}

function setState(idx, v) { for (const i of idx) D.state[i] = v; points.geometry.attributes.state.needsUpdate = true; U.dirty = true; note(); clearTimeout(U.saveTimer); U.saveTimer = setTimeout(save, 4000); }
/** WHAT IS DRAWN, COUNTED BY THE SHADER'S OWN RULES (2026-11-21: the owner saw one small slice of a walk whose points
 *  span the yard; the page itself now says what it holds and what it hides, and how wide each lies). */
function tally() {
  if (!material || !$('#tally')) return;
  const g = material.uniforms.google.value > 0.5, u = material.uniforms.unsure.value > 0.5, se = material.uniforms.showErased.value > 0.5;
  let shown = 0, hg = 0, hu = 0, he = 0, bad = 0, ht = 0;
  const tm0 = material.uniforms.tmin.value;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < D.n; i++) {
    const f = D.flags[i], x = D.pos[i * 3], y = D.pos[i * 3 + 1], z = D.pos[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { bad++; continue; }
    if (D.t[i] < tm0) { ht++; continue; }
    if (D.state[i] > 0.5 && !se) { he++; continue; }
    if (f & 2) { if (!g) { hg++; continue; } } else if ((f & 4) && D.dconf[i] < 13 && !u) { hu++; continue; }
    shown++;
    if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x; if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y; if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
  }
  const ft = (j) => (shown ? Math.round((hi[j] - lo[j]) * FT) : 0);
  let tl = [Infinity, Infinity], th = [-Infinity, -Infinity];
  for (const q of D.track) { if (q[1] < tl[0]) tl[0] = q[1]; if (q[1] > th[0]) th[0] = q[1]; if (q[3] < tl[1]) tl[1] = q[3]; if (q[3] > th[1]) th[1] = q[3]; }
  $('#tally').textContent = `${D.plants?.length ? `Plant shapes: ${D.plants.length} (green boxes: where the walk saw plant over 3 ft, as low and as high as it saw it). ` : ''}${D.trunks ? `Tree trunks found: ${D.trunks.length} (brown, drawn as seen)${(D.marks || []).length ? `; you marked ${D.marks.length} (green)` : ''}. ` : ''}Drawn now: ${shown.toLocaleString()} of ${D.n.toLocaleString()} points, lying ${ft(0)} x ${ft(2)} ft and ${ft(1)} ft high. Hidden: ${hu.toLocaleString()} unsure depth, ${hg.toLocaleString()} Google's, ${he.toLocaleString()} erased${ht ? `, ${ht.toLocaleString()} seen before the minute chosen` : ''}${bad ? `, ${bad.toLocaleString()} with no place` : ''}. `
    + `This walk: ${/^\d{13}$/.test(walk) ? new Date(Number(walk)).toLocaleString() : walk}, ${D.keys.length} photos. The path: ${D.track.length.toLocaleString()} poses, ${D.track.length ? Math.round((th[0] - tl[0]) * FT) : 0} x ${D.track.length ? Math.round((th[1] - tl[1]) * FT) : 0} ft. Read: ${U.read || ''}. Page of 21 Nov, c.`;
}
/* MARK TRUNKS (the owner, 2026-11-22: "I can tap trunks if you need me to"). In this mode a tap on a point puts a green
   ball there: "a tree trunk stands here". A tap within 20 in of a ball takes it away. Kept by itself beside the walk
   (owner-trunks.json), in either view (the walk's own points and the joined cloud share a frame). */
let markGroup = null, plantMesh = null;   // plantMesh: kept so a later mode can hide or show the shapes
function drawMarks() {
  if (!markGroup) return;
  while (markGroup.children.length) markGroup.remove(markGroup.children[0]);
  const mat = new THREE.MeshBasicMaterial({ color: 0x22ff66 });
  for (const [x, y, z] of D.marks || []) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), mat); m.position.set(x, y, z); markGroup.add(m); }
}
function toggleMark(i) {
  const p = [D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2]];
  const near = (D.marks || []).findIndex((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.5);
  if (near >= 0) D.marks.splice(near, 1); else D.marks.push(p.map((v) => +v.toFixed(3)));
  drawMarks(); note();
  clearTimeout(U.markTimer); U.markTimer = setTimeout(saveMarks, 900);
}
async function saveMarks() {
  $('#saved').textContent = 'saving your trunks…';
  try {
    const r = await part('owner-trunks.json', { method: 'PUT', body: JSON.stringify({ v: 1, frame: "the walk's own, metres", at: new Date().toISOString(), trunks: D.marks }) });
    if (!r.ok) throw new Error(String(r.status));
    $('#saved').textContent = `your ${D.marks.length} trunk${D.marks.length === 1 ? '' : 's'} saved`;
  } catch (err) { $('#saved').textContent = `your trunks NOT saved (${err.message}); trying again`; U.markTimer = setTimeout(saveMarks, 8000); }
}

function note() {
  tally();
  let e = 0; for (let i = 0; i < D.n; i++) if (D.state[i] > 0.5) e++;
  const say = { look: 'Look: turn with one finger, move and zoom with two; tap a point to make it the centre.', inspect: 'Inspect: tap a point in focus to see its photo.', erase: 'Erase: drag over points in focus.', restore: 'Bring back: drag over red points in focus.', trunk: 'Mark trunks: tap a tree trunk, low on the trunk, to put a green ball on it; tap a ball to take it away. Two fingers still move the view.' }[U.mode];
  $('#say').textContent = U.mode === 'trunk' ? `${say} ${(D.marks || []).length} marked.` : `${say} ${e.toLocaleString()} erased.`;
}
async function save() {
  if (!U.dirty || U.readonly) return;
  const idx = []; for (let i = 0; i < D.n; i++) if (D.state[i] > 0.5) idx.push(i);
  $('#saved').textContent = 'saving…';
  try {
    const r = await part('erased.bin', { method: 'PUT', body: Uint32Array.from(idx).buffer });
    if (!r.ok) throw new Error(String(r.status));
    U.dirty = false; $('#saved').textContent = `saved (${idx.length.toLocaleString()} erased)`;
  } catch (err) { $('#saved').textContent = `NOT saved (${err.message}); it will be tried again`; U.saveTimer = setTimeout(save, 8000); }
}

function mode(m) {
  U.mode = m;
  if (material) material.uniforms.sharp.value = m === 'look' ? 0 : 1;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const look = m === 'look';
  controls.touches.ONE = look ? THREE.TOUCH.ROTATE : null;        // two fingers still move and zoom in every mode
  controls.mouseButtons.LEFT = look ? THREE.MOUSE.ROTATE : null;
  if (m === 'restore' && !$('#erased').checked) { $('#erased').checked = true; material.uniforms.showErased.value = 1; }
  $('#ring').style.display = 'none';
  note();
}

function wire() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => mode(b.dataset.mode)));
  const dof = () => { const ft = Number($('#dof').value); material.uniforms.band.value = ft / FT / 2; $('#dof-say').textContent = `${ft} ft deep`; };
  $('#dof').addEventListener('input', dof); dof();
  $('#size').addEventListener('input', () => { material.uniforms.size.value = Number($('#size').value); });
  $('#colour').addEventListener('change', colour);
  $('#outside').addEventListener('change', (e) => { material.uniforms.outside.value = e.target.checked ? 1 : 0; });
  $('#google').addEventListener('change', (e) => { material.uniforms.google.value = e.target.checked ? 1 : 0; tally(); });
  /* HIDE THE WALK'S START (2026-11-21; the owner: the garage was first seen "between checking r2 and r3"; "MAYBE we
     should discard the points that have been collected before all references have been marked?"). A slider hides
     what was seen before a minute of the walk, so that can be tried by eye; the page says when each roof corner was
     marked. In the joined cloud a point's time is when it was LAST seen, so only what the start alone saw goes. */
  { const el = $('#from'), say = $('#from-say');
    if (el && say) {
      const end = D.track.length ? D.track[D.track.length - 1][0] : 0;
      el.max = String(Math.max(1, Math.ceil(end / 6)));           // tenths of a minute
      let marksSay = '';
      part('live.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
        const ms = (j?.marks || []).filter((m) => Number.isFinite(m.odo));
        if (!ms.length || D.track.length < 2) return;
        let odo = 0; const at = [[0, D.track[0][0]]];
        for (let i = 1; i < D.track.length; i++) { odo += Math.hypot(D.track[i][1] - D.track[i - 1][1], D.track[i][2] - D.track[i - 1][2], D.track[i][3] - D.track[i - 1][3]); at.push([odo, D.track[i][0]]); }
        const when = (o) => { let k = 0; while (k < at.length - 1 && at[k][0] < o) k++; return at[k][1]; };
        marksSay = ' Roof corners marked at ' + ms.map((m) => `${(when(m.odo) / 60).toFixed(1)} min (${m.id})`).join(', ') + '.';
        upd();
      }).catch(() => {});
      const upd = () => { const min = Number(el.value) / 10; material.uniforms.tmin.value = min > 0 ? min * 60 : -1; say.textContent = (min > 0 ? `hiding what was seen before ${min.toFixed(1)} min` : 'the whole walk') + ` of ${(end / 60).toFixed(1)} min.` + marksSay; tally(); };
      // by default the walk's start is hidden, to when every roof corner had been marked once (view.json startCutS;
      // segment_study.start_cut): the owner's remedy of 2026-11-21, tried by eye on the walk of 2026-11-20
      const cutS = Number(D.view?.startCutS) || 0;
      if (cutS > 0) { el.value = String(Math.ceil(cutS / 6)); marksSay += ' The start is hidden by default: slide to nought for the whole walk.'; }
      el.addEventListener('input', upd); upd();
    } }
  $('#unsure')?.addEventListener('change', (e) => { material.uniforms.unsure.value = e.target.checked ? 1 : 0; tally(); });
  $('#erased').addEventListener('change', (e) => { material.uniforms.showErased.value = e.target.checked ? 1 : 0; });
  $('#undo').addEventListener('click', () => { const s = U.undo.pop(); if (s) setState(s.idx, s.was); });
  $('#save').addEventListener('click', () => { U.dirty = true; save(); });
  window.addEventListener('beforeunload', (e) => { if (U.dirty) { e.preventDefault(); e.returnValue = ''; } });

  const el = renderer.domElement, ring = $('#ring');
  const at = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const brush = (x, y) => {
    const r = Number($('#brush').value), want = U.mode === 'restore', got = [];
    under(x, y, r, want, (i) => got.push(i));
    if (got.length) { U.stroke.idx.push(...got); setState(got, want ? 0 : 1); }
    ring.style.display = 'block'; ring.style.width = ring.style.height = `${2 * r}px`; ring.style.left = `${x - r}px`; ring.style.top = `${y - r}px`;
  };
  el.addEventListener('pointerdown', (e) => {
    U.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });
    if (U.pointers.size > 1) { if (U.stroke) endStroke(); return; }             // a second finger: moving the view, not erasing
    if (U.mode === 'erase' || U.mode === 'restore') { U.stroke = { idx: [], was: U.mode === 'restore' ? 1 : 0 }; brush(...at(e)); }
  });
  el.addEventListener('pointermove', (e) => {
    const p = U.pointers.get(e.pointerId); if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) p.moved = true;
    if (U.stroke && U.pointers.size === 1) brush(...at(e));
  });
  const endStroke = () => { if (U.stroke?.idx.length) U.undo.push(U.stroke); U.stroke = null; ring.style.display = 'none'; };
  const up = (e) => {
    const p = U.pointers.get(e.pointerId); U.pointers.delete(e.pointerId);
    if (U.stroke) { endStroke(); return; }
    if (!p || p.moved || performance.now() - p.t > 450 || U.pointers.size) return;   // a tap, with one finger
    const [x, y] = at(e);
    if (U.mode === 'look') { const i = pick(x, y, true); if (i >= 0) controls.target.set(D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2]); }
    else if (U.mode === 'inspect') { const i = pick(x, y); if (i >= 0) inspect(i); }
    else if (U.mode === 'trunk') { const i = pick(x, y, true); if (i >= 0) toggleMark(i); }
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', (e) => { U.pointers.delete(e.pointerId); endStroke(); });

  $('#p-close').addEventListener('click', () => { $('#panel').hidden = true; U.inspect = null; });
  $('#p-prev').addEventListener('click', () => U.inspect && showPhoto(U.inspect.i, U.inspect.k - 1));
  $('#p-next').addEventListener('click', () => U.inspect && showPhoto(U.inspect.i, U.inspect.k + 1));
  $('#p-erase').addEventListener('click', () => { if (!U.inspect) return; U.undo.push({ idx: [U.inspect.i], was: 0 }); setState([U.inspect.i], 1); $('#panel').hidden = true; });
}

/** Is point i inside photo k's frame, in front of its camera? */
function inPhoto(i, k) {
  const v = new THREE.Vector4(D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2], 1).applyMatrix4(D.c2w[k].clone().invert());
  if (v.z > -0.1) return false;
  const c = v.applyMatrix4(new THREE.Matrix4().fromArray(D.keys[k].proj));
  return Math.abs(c.x / c.w) <= 0.98 && Math.abs(c.y / c.w) <= 0.98;
}

/** One point: what the walk knows of it, and the photo taken when it was seen, the point marked on it. */
function inspect(i) {
  // the photo nearest in time in which the point can be seen (inside the frame, in front of the camera); failing
  // any within 20 s, the nearest in time
  let k = 0, bd = Infinity, kin = -1, bin = Infinity;
  D.keys.forEach((q, j) => {
    const d = Math.abs(q.t - D.t[i]);
    if (d < bd) { bd = d; k = j; }
    if (d < bin && d <= 20 && inPhoto(i, j)) { bin = d; kin = j; }
  });
  if (kin >= 0) k = kin;
  const f = D.flags[i], h = D.pos[i * 3 + 1] - D.ground[i];
  const tr = D.track.length ? D.track.reduce((a, r) => (Math.abs(r[0] - D.t[i]) < Math.abs(a[0] - D.t[i]) ? r : a)) : null;
  const far = tr ? Math.hypot(D.pos[i * 3] - tr[1], D.pos[i * 3 + 1] - tr[2], D.pos[i * 3 + 2] - tr[3]) : null;
  const mm = Math.floor(D.t[i] / 60), ss = Math.floor(D.t[i] % 60);
  $('#p-title').textContent = `Point ${i.toLocaleString()}`;
  $('#p-info').textContent = [
    `seen ${mm}:${String(ss).padStart(2, '0')} into the walk`,
    far != null ? `${(far * FT).toFixed(0)} ft from the phone then` : null,
    Number.isFinite(h) ? `${(h * FT).toFixed(1)} ft over the ground the phone took` : null,
    D.label[i] ? `the phone called it ${LABELS[D.label[i] - 1]} (${Math.round(D.lconf[i] / 2.55)}% sure)` : 'no label from the phone',
    D.dconf[i] ? `depth ${Math.round(D.dconf[i] / 2.55)}% sure` : null,
    f & 2 ? "Google's street shape, not measured by the camera" : f & 4 ? 'weak depth' : null, f & 8 ? 'seen again from another place' : null, f & 1 ? 'flagged a spike' : null,
  ].filter(Boolean).join('; ') + '.';
  $('#panel').hidden = false;
  showPhoto(i, k);
  $('#panel').scrollIntoView({ block: 'nearest' });
}
async function showPhoto(i, k) {
  if (!D.keys.length) { $('#p-info').textContent += ' This walk kept no photos.'; return; }
  k = Math.max(0, Math.min(D.keys.length - 1, k));
  U.inspect = { i, k };
  const q = D.keys[k], cv = $('#p-pic'), g = cv.getContext('2d');
  try {
    const bmp = await createImageBitmap(await (await part(q.name)).blob());
    if (U.inspect.i !== i || U.inspect.k !== k) return;
    cv.width = bmp.width; cv.height = bmp.height; g.drawImage(bmp, 0, 0);
    // the point in this photo: as the tools project it (the photo is read "as kept", SCAN-H7)
    const v = new THREE.Vector4(D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2], 1).applyMatrix4(D.c2w[k].clone().invert());
    const dt = q.t - D.t[i];
    let where = 'behind the camera in this photo';
    if (v.z < -0.1) {
      const c = v.clone().applyMatrix4(new THREE.Matrix4().fromArray(q.proj)), nx = c.x / c.w, ny = c.y / c.w;
      if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) {
        const px = (nx + 1) / 2 * bmp.width, py = (1 - ny) / 2 * bmp.height;
        g.lineWidth = Math.max(2, bmp.width / 160);
        for (const [col, r] of [['#000', bmp.width / 22 + 2], ['#ff2bd6', bmp.width / 22]]) { g.strokeStyle = col; g.beginPath(); g.arc(px, py, r, 0, 7); g.stroke(); }
        g.fillStyle = '#ff2bd6'; g.beginPath(); g.arc(px, py, Math.max(2, bmp.width / 200), 0, 7); g.fill();
        where = `${(-v.z * FT).toFixed(0)} ft from this photo's camera`;
      } else where = 'outside this photo';
    }
    $('#p-title').textContent = `Point ${i.toLocaleString()} — photo ${k + 1} of ${D.keys.length}, taken ${Math.abs(dt) < 0.5 ? 'as it was seen' : `${Math.abs(dt).toFixed(0)} s ${dt < 0 ? 'before' : 'after'} it was seen`}; the point is ${where}`;
  } catch { $('#p-title').textContent = `Point ${i.toLocaleString()}: that photo could not be read`; }
}

main().catch((e) => { $('#status').textContent = `Could not read the walk: ${e.message}`; });
