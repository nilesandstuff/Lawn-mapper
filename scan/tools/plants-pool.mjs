/**
 * THE PLANTS OF EVERY WALK ON A MAP, AS ONE (core session, 2026-11-26). The owner, 2026-11-25: "Each walk should be an
 * update to both the reference (when it's a good walk) and the fused map", and the reference is "the accumulation of
 * every walk without the uncertain parts". Until now the newest walk's plants REPLACED the last walk's
 * (plants-keep.mjs). Here several walks' plants-map.json (scan/tools/plants.py: each on the map's own square feet, by
 * its own agreeing corners) become one of the same shape, so the page, the map's record and the fusing read it as
 * they read one walk's:
 *
 *   boxes     a square foot's plant is KEPT when two walks or more saw plant there (the lowest low, the highest high),
 *             or one walk did and no other walk saw open air right through it; a box only one walk saw, where another
 *             saw the air open from the ground to over its top, is the uncertain part and is left out.
 *   seen      the open air from the ground up, per 2 ft square: the most any walk saw, but never claimed higher than
 *             the lowest plant kept in that square.
 *   seenHigh, clearHigh   NOT joined yet: the newest walk's that has them, as before.
 *
 *   node scan/tools/plants-pool.mjs <out dir> <walk dir> <walk dir>...   (newest walk first)
 *
 * Counts only: no places.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const grid = (s) => (s?.clearTo ? { ...s, a: new Uint8Array(inflateSync(Buffer.from(s.clearTo, 'base64'))) } : null);

/** docs: plants-map.json objects, newest first. -> { doc, stats } */
export function poolPlants(docs) {
  const use = docs.filter((d) => d && Array.isArray(d.boxes));
  if (!use.length) return { doc: null, stats: { walks: 0 } };
  const cellM = use[0].cellM, per = use.map((d) => { const m = new Map(); for (const [i, j, lo, hi] of d.boxes) { const k = `${i},${j}`, o = m.get(k); if (o) { o[0] = Math.min(o[0], lo); o[1] = Math.max(o[1], hi); } else m.set(k, [lo, hi]); } return m; });
  const seens = use.map((d) => grid(d.seen));
  // how high walk w saw the air open over the square foot (i, j), in decimetres; null when it never looked there
  const openAt = (w, i, j) => {
    const s = seens[w]; if (!s) return null;
    const r = Math.round(s.cellM / cellM), c = Math.floor(i / r) - s.i0, q = Math.floor(j / r) - s.j0;
    if (c < 0 || q < 0 || c >= s.w || q >= s.h) return null;
    const v = s.a[q * s.w + c];
    return v === (s.notSeen ?? 255) ? null : v;
  };
  const keys = new Set(); for (const m of per) for (const k of m.keys()) keys.add(k);
  const boxes = []; let two = 0, one = 0, dropped = 0;
  for (const k of keys) {
    const [i, j] = k.split(',').map(Number);
    let n = 0, lo = Infinity, hi = -Infinity;
    per.forEach((m) => { const o = m.get(k); if (o) { n++; lo = Math.min(lo, o[0]); hi = Math.max(hi, o[1]); } });
    if (n >= 2) two++;
    else {
      // one walk's word: does another walk say the air there is open to over its top?
      const against = per.some((m, w) => !m.has(k) && (() => { const v = openAt(w, i, j); return v != null && v >= hi; })());
      if (against) { dropped++; continue; }
      one++;
    }
    boxes.push([i, j, lo, hi]);
  }
  boxes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const doc = { ...use[0], boxes, walks: use.length, pooled: { walks: use.length, twoOrMore: two, oneWalk: one, leftOut: dropped } };
  // the open air: the union of the walks' squares, the most any saw, under the lowest plant kept
  const S = seens.filter(Boolean);
  if (S.length) {
    const c = S[0].cellM, i0 = Math.min(...S.map((s) => s.i0)), j0 = Math.min(...S.map((s) => s.j0));
    const w = Math.max(...S.map((s) => s.i0 + s.w)) - i0, h = Math.max(...S.map((s) => s.j0 + s.h)) - j0, NS = S[0].notSeen ?? 255;
    const a = new Uint8Array(w * h).fill(NS);
    for (const s of S) for (let q = 0; q < s.h; q++) for (let x = 0; x < s.w; x++) {
      const v = s.a[q * s.w + x]; if (v === NS) continue;
      const t = (q + s.j0 - j0) * w + (x + s.i0 - i0);
      a[t] = a[t] === NS ? v : Math.max(a[t], v);
    }
    const r = Math.round(c / cellM);
    for (const [i, j, lo] of boxes) {
      const x = Math.floor(i / r) - i0, q = Math.floor(j / r) - j0;
      if (x < 0 || q < 0 || x >= w || q >= h) continue;
      const t = q * w + x; if (a[t] !== NS && a[t] > lo) a[t] = Math.max(0, lo);
    }
    doc.seen = { ...use.find((d) => d.seen).seen, i0, j0, w, h, clearTo: deflateSync(Buffer.from(a), { level: 9 }).toString('base64') };
  } else delete doc.seen;
  for (const f of ['seenHigh', 'clearHigh']) { const d = use.find((x) => x[f]); if (d) doc[f] = d[f]; else delete doc[f]; }
  return { doc, stats: { walks: use.length, boxes: boxes.length, two, one, dropped, each: use.map((d) => d.boxes.length) } };
}

if (process.argv[1] && process.argv[1].endsWith('plants-pool.mjs')) {
  const [out, ...dirs] = process.argv.slice(2);
  const docs = dirs.map((d) => { const f = join(d, 'plants-map.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; });
  const { doc, stats } = poolPlants(docs);
  if (!doc) { console.log(`The walks' plants as one: none of the ${dirs.length} walks has plants on the map (no fit by agreeing corners).`); process.exit(0); }
  writeFileSync(join(out, 'plants-map.json'), JSON.stringify(doc));
  console.log(`THE WALKS' PLANTS AS ONE: ${stats.walks} of ${dirs.length} walks have plants on the map (${stats.each.map((n) => n.toLocaleString()).join(', ')} squares each). Kept ${stats.boxes.toLocaleString()} squares: ${stats.two.toLocaleString()} seen by two walks or more, ${stats.one.toLocaleString()} by one and not gainsaid; LEFT OUT ${stats.dropped.toLocaleString()} that one walk saw where another saw the air open to over their top. The air seen open from the ground: joined; above 8 ft and "empty in any season": the newest walk's only.`);
}
