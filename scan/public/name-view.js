/**
 * THE OWNER NAMES THE THINGS IN A WALK (core session, 2026-11-19).
 *
 * The owner, after the namers' names had baffled: "you let me name all of the segments. I'll name them in the terms
 * that actually put things into categories that are useful to us and you can see how everything matches and how to
 * rectify the lift from different distances."
 *
 * What is shown: each photo with the shapes it was cut into (scan/tools/name_prep.py: seg-NNNN.png, the shape id at
 * each pixel; seg.json, each shape's THING, the tools' match of it across photos). A name is given to the thing, so
 * it shows on that thing in every photo. Where the match was wrong, a name given to ONE shape in ONE photo overrides
 * it there: the list of those is the list of the lift's mistakes.
 *
 * Kept beside the walk as seg-names.json: { names: { thing: name }, shapes: { "photo index:shape id": name | "" },
 * words: [the owner's names, in the order first used], at }. Admin only.
 */
const $ = (s) => document.querySelector(s);
const walk = new URLSearchParams(location.search).get('walk');
const part = (name, init) => fetch(`/api/scan/twin?walk=${encodeURIComponent(walk)}&part=${encodeURIComponent(name)}`, { credentials: 'same-origin', ...init });
const S = { seg: null, names: {}, shapes: {}, words: [], p: 0, ids: null, w: 0, h: 0, photo: null, pick: null, whole: true, plain: false, dirty: false, timer: 0, token: 0 };

async function main() {
  if (!walk) { $('#status').textContent = 'Which walk? Open this from a walk\'s twin page.'; return; }
  $('#twin-link').href = `/twin.html?walk=${encodeURIComponent(walk)}`; $('#cloud-link').href = `/cloud.html?walk=${encodeURIComponent(walk)}`;
  const r = await part('seg.json');
  if (!r.ok) { $('#status').textContent = 'This walk\'s shapes have not been made ready to name yet (a run does it: task name).'; return; }
  S.seg = await r.json();
  try { const n = await part('seg-names.json'); if (n.ok) { const j = await n.json(); S.names = j.names || {}; S.shapes = j.shapes || {}; S.words = j.words || []; } } catch { /* none yet */ }
  $('#at').max = String(S.seg.pictures.length - 1);
  wire();
  await show(0);
}

/** A shape's name: its own if it was given one in this photo ("" = said to have none), else its thing's. */
const nameOf = (p, id) => { const own = S.shapes[`${p}:${id}`]; return own != null ? own : S.names[S.seg.pictures[p].shapes[id]?.[0]] || ''; };
const PLACED = 8;   // depth cells under a shape for it to have a place in 3D (name_prep.py CELLS_MIN)
const colourOf = (thing) => { let x = (Number(thing) * 2654435761) >>> 0; return [80 + (x & 127), 80 + ((x >> 8) & 127), 80 + ((x >> 16) & 127)]; };

async function show(p) {
  S.p = p = Math.max(0, Math.min(S.seg.pictures.length - 1, p));
  const mine = ++S.token, pic = S.seg.pictures[p];
  $('#at').value = String(p);
  $('#which').textContent = `photo ${p + 1} of ${S.seg.pictures.length}`;
  const [photo, ids] = await Promise.all([part(pic.photo).then((r) => r.blob()).then(createImageBitmap), part(`seg-${String(p).padStart(4, '0')}.png`).then((r) => r.blob()).then(createImageBitmap)]);
  if (mine !== S.token) return;
  const c = document.createElement('canvas'); c.width = ids.width; c.height = ids.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(ids, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  S.w = c.width; S.h = c.height; S.ids = new Uint16Array(S.w * S.h);
  for (let i = 0; i < S.ids.length; i++) S.ids[i] = d[i * 4] * 256 + d[i * 4 + 1];
  S.photo = photo;
  draw(); tally();
}

function draw() {
  const cv = $('#pic'), W = S.photo.width, H = S.photo.height, g = cv.getContext('2d');
  cv.width = W; cv.height = H; g.drawImage(S.photo, 0, 0);
  if (S.plain) return;
  const img = g.getImageData(0, 0, W, H), o = img.data, pic = S.seg.pictures[S.p], sx = S.w / W, sy = S.h / H;
  const at = (x, y) => S.ids[Math.min(S.h - 1, Math.floor(y * sy)) * S.w + Math.min(S.w - 1, Math.floor(x * sx))];
  const seen = new Map();   // shape id -> { n, best, bx, by }: where its name is written (deep inside it)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = at(x, y), k = (y * W + x) * 4;
    if (!id) { o[k] *= 0.5; o[k + 1] *= 0.5; o[k + 2] *= 0.5; continue; }
    const edge = (x + 1 < W && at(x + 1, y) !== id) || (y + 1 < H && at(x, y + 1) !== id) || (x > 0 && at(x - 1, y) !== id) || (y > 0 && at(x, y - 1) !== id);
    const named = !!nameOf(S.p, id), picked = S.pick === id, placed = (pic.shapes[id]?.[2] || 0) >= PLACED;
    // a shape with no depth under it cannot be put into 3D, whatever it is called: drawn quietly, naming it optional
    if (edge) { const e = picked ? [255, 60, 220] : named ? [255, 255, 255] : placed ? [250, 204, 21] : [120, 130, 150]; o[k] = e[0]; o[k + 1] = e[1]; o[k + 2] = e[2]; }
    else { const c = colourOf(pic.shapes[id]?.[0] ?? id), a = picked ? 0.55 : placed ? 0.3 : 0.08; o[k] = o[k] * (1 - a) + c[0] * a; o[k + 1] = o[k + 1] * (1 - a) + c[1] * a; o[k + 2] = o[k + 2] * (1 - a) + c[2] * a; }
    if ((x & 7) === 0 && (y & 7) === 0) {
      // how far inside its shape this pixel is, roughly: the shortest of four walks to its edge
      let r = 0; while (r < 60 && x + r + 4 < W && x - r - 4 >= 0 && y + r + 4 < H && y - r - 4 >= 0 && at(x + r + 4, y) === id && at(x - r - 4, y) === id && at(x, y + r + 4) === id && at(x, y - r - 4) === id) r += 4;
      const s = seen.get(id) || { best: -1, bx: x, by: y }; if (r > s.best) { s.best = r; s.bx = x; s.by = y; } seen.set(id, s);
    }
  }
  g.putImageData(img, 0, 0);
  g.font = `600 ${Math.max(13, Math.round(W / 34))}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 4; g.strokeStyle = '#000';
  for (const [id, s] of seen) { const n = nameOf(S.p, id); if (!n || s.best < 4) continue; g.strokeText(n, s.bx, s.by); g.fillStyle = S.shapes[`${S.p}:${id}`] != null ? '#fda4af' : '#fff'; g.fillText(n, s.bx, s.by); }
}

function tally() {
  const T = S.seg.things, all = Object.keys(T).filter((t) => T[t].points >= PLACED), named = all.filter((t) => S.names[t]);
  $('#status').textContent = `${named.length} of ${all.length} things named. (${(Object.keys(T).length - all.length).toLocaleString()} more shapes, outlined in grey, have no depth under them: they cannot be placed in 3D, so naming them is up to you.) ${Object.keys(S.shapes).length} set right in one photo.`;
}

function sheet(id) {
  S.pick = id; S.whole = true;
  const pic = S.seg.pictures[S.p], [thing, px, pts] = pic.shapes[id] || [null, 0, 0], T = S.seg.things[thing] || { photos: 1, points: 0 };
  $('#s-title').textContent = nameOf(S.p, id) ? `Named: ${nameOf(S.p, id)}` : 'Not named yet';
  $('#s-info').textContent = `This shape is ${Math.round((100 * px) / (S.w * S.h))}% of the photo of the photo. ${pts >= PLACED ? `The tools matched it as one thing across ${T.photos} photo${T.photos === 1 ? '' : 's'}.` : 'It has no depth under it, so it has no place in 3D yet.'}`;
  const box = $('#s-names'); box.innerHTML = '';
  for (const w of S.words) { const b = document.createElement('button'); b.type = 'button'; b.className = 'name'; b.textContent = w; b.addEventListener('click', () => give(w)); box.append(b); }
  $('#s-all').classList.add('on'); $('#s-one').classList.remove('on');
  $('#sheet').hidden = false; $('#s-new').value = '';
  draw(); $('#sheet').scrollIntoView({ block: 'nearest' });
}

function give(name) {
  if (S.pick == null) return;
  name = String(name || '').trim().slice(0, 40);
  const thing = S.seg.pictures[S.p].shapes[S.pick]?.[0], k = `${S.p}:${S.pick}`;
  if (S.whole) { if (name) S.names[thing] = name; else delete S.names[thing]; delete S.shapes[k]; }
  else S.shapes[k] = name;                      // "" here says: this shape is NOT what its thing was named
  if (name && !S.words.includes(name)) S.words.push(name);
  S.dirty = true; clearTimeout(S.timer); S.timer = setTimeout(save, 3000);
  $('#sheet').hidden = true; S.pick = null; draw(); tally();
}
async function save() {
  if (!S.dirty) return;
  $('#saved').textContent = 'saving…';
  try {
    const r = await part('seg-names.json', { method: 'PUT', body: JSON.stringify({ names: S.names, shapes: S.shapes, words: S.words, at: new Date().toISOString() }) });
    if (!r.ok) throw new Error(String(r.status));
    S.dirty = false; $('#saved').textContent = 'saved';
  } catch (e) { $('#saved').textContent = `NOT saved (${e.message}); it will be tried again`; S.timer = setTimeout(save, 8000); }
}

function wire() {
  $('#prev').addEventListener('click', () => show(S.p - 1)); $('#next').addEventListener('click', () => show(S.p + 1));
  $('#at').addEventListener('change', (e) => show(Number(e.target.value)));
  $('#plain').addEventListener('click', () => { S.plain = !S.plain; $('#plain').textContent = S.plain ? 'Show the shapes' : 'Hide the shapes'; draw(); });
  $('#pic').addEventListener('click', (e) => {
    if (!S.ids) return;
    const r = e.target.getBoundingClientRect(), x = Math.floor(((e.clientX - r.left) / r.width) * S.w), y = Math.floor(((e.clientY - r.top) / r.height) * S.h);
    const id = S.ids[Math.max(0, Math.min(S.h - 1, y)) * S.w + Math.max(0, Math.min(S.w - 1, x))];
    if (id) sheet(id); else { $('#sheet').hidden = true; S.pick = null; draw(); }
  });
  $('#s-add').addEventListener('click', () => give($('#s-new').value));
  $('#s-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') give($('#s-new').value); });
  $('#s-clear').addEventListener('click', () => give(''));
  $('#s-close').addEventListener('click', () => { $('#sheet').hidden = true; S.pick = null; draw(); });
  $('#s-all').addEventListener('click', () => { S.whole = true; $('#s-all').classList.add('on'); $('#s-one').classList.remove('on'); });
  $('#s-one').addEventListener('click', () => { S.whole = false; $('#s-one').classList.add('on'); $('#s-all').classList.remove('on'); });
  // the biggest thing with no name yet, at the photo where it is largest (from here on, then from the start)
  $('#unnamed').addEventListener('click', () => {
    const P = S.seg.pictures; let best = null;
    for (let q = 0; q < P.length; q++) for (const [id, [thing, px]] of Object.entries(P[q].shapes)) {
      if (S.names[thing] || S.shapes[`${q}:${id}`] != null || (S.seg.things[thing]?.points || 0) < PLACED) continue;
      const score = (S.seg.things[thing]?.points || 0) * 1e6 + px;
      if (!best || score > best.score) best = { q, id: Number(id), score };
    }
    if (!best) { $('#saved').textContent = 'Every thing that has a place in 3D has a name.'; return; }
    show(best.q).then(() => sheet(best.id));
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

main().catch((e) => { $('#status').textContent = `Could not read the walk: ${e.message}`; });
