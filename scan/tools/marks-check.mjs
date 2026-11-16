/**
 * THE PLACEMENT MAP'S LIDAR CORNERS ON A REAL MAP, COUNTED (core session, 2026-11-10; scan/lib/lidar-marks.js,
 * docs/SCAN-PLAN.md section 21). The owner, on the first look at their lot: the deck right, the drive missed although it
 * stands out strongly from the grass, and shapes all over the woods where there is nothing square. This runs the page's
 * own code on the map a walk was made on, over the box the page uses (the lawn and the lot, 20 m round), and says what
 * was found and why each candidate was kept or not.
 *
 *   node scan/tools/marks-check.mjs <walk>
 *
 * Prints counts, sizes and reasons only: no place (the repository and its logs are public).
 */
import { readMap, readModel } from './twin-io.mjs';
import { readObject, BUCKET } from './twin-r2.mjs';
import { gridsFromModel } from '../lib/lidar-load.js';
import { lidarMarks, returnsFrom } from '../lib/lidar-marks.js';
import { roofCorners } from '../lib/roof-corner.js';
import { ringsOf, toMerc } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';

async function main() {
  const walk = process.argv[2];
  if (!walk) throw new Error('which walk? (its map is the one looked at)');
  const meta = JSON.parse(Buffer.from(await readObject(BUCKET, `twins/${walk}/meta.json`)).toString('utf8'));
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat];
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(origin, p)));
  const pts = [...lawn.flat(), ...parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const S = await import('../../public/shade/structures.js');
  const G = gridsFromModel(model, { origin, box, lawn: [], S, toMerc });
  const P = returnsFrom({ ...G, model });
  if (!P) throw new Error('the model keeps no returns');
  // the ground's brightness, as numbers only
  const gb = [];
  for (let i = 0; i < P.n; i++) { const h = P.hag(i), e = P.e(i), n = P.nn(i); if (Math.abs(h) < 0.3 && e >= box[0] && e < box[2] && n > box[1] && n <= box[3]) gb.push(P.bright(i)); }
  gb.sort((a, b) => a - b);
  const pc = (f) => gb[Math.min(gb.length - 1, Math.floor(gb.length * f))];
  // which shade build made this model, and when (the file's own header): a print of an old model proves nothing
  console.log(`The model: shade build ${model.meta?.build ?? '?'}, made ${model.meta?.at ? new Date(model.meta.at).toISOString() : model.meta?.builtAt || '?'}; header fields ${Object.keys(model.meta || {}).join(', ')}.`);
  console.log(`Box ${(box[2] - box[0]).toFixed(0)} x ${(box[3] - box[1]).toFixed(0)} m; ${P.n.toLocaleString()} returns in the model, ${gb.length.toLocaleString()} on the ground in the box.`);
  console.log(`The ground's brightness, percentiles 5/25/50/75/95: ${[0.05, 0.25, 0.5, 0.75, 0.95].map(pc).join(' / ')}`);
  const debug = [], t0 = Date.now();
  const M = lidarMarks(box, P, { debug });
  console.log(`${M.objects.length} things, return spacing ${M.spacing} m, ${Date.now() - t0} ms:`);
  for (const kind of ['building', 'object', 'paving']) {
    const os = M.objects.filter((o) => o.kind === kind);
    const cs = M.corners.filter((c) => c.kind === 'corner' && os.some((o) => o.id === c.of));
    console.log(`  ${kind}: ${os.length} (${os.filter((o) => o.square).length} squared), ${cs.length} corners, ${cs.filter((c) => c.sure).length} sure; sizes ${os.map((o) => `${o.area} m2 at ${o.top} m`).slice(0, 12).join(', ')}`);
  }
  // where each thing is, as a distance from the traced lawn's middle only (no place; the biggest building on the
  // owner's map is the neighbour's house)
  const lp = lawn.flat(), lm = lp.length ? [lp.reduce((t, p) => t + p[0], 0) / lp.length, lp.reduce((t, p) => t + p[1], 0) / lp.length] : null;
  const far = (at) => (lm && at ? `${Math.hypot(at[0] - lm[0], at[1] - lm[1]).toFixed(0)} m from the lawn's middle` : '');
  for (const d of debug.filter((x) => x.kind === 'building' || x.kind === 'object').slice(0, 40)) console.log(`  ${d.kind} ${d.area} m2: ${far(d.middle)}, crowns round it ${d.woods}`);
  // each building's and big thing's own grid and outline, as a SHAPE (metres east and north of its own middle: not
  // a place), so the drawing can be compared with a photo without anyone opening the page
  for (const d of debug.filter((x) => (x.kind === 'building' || x.kind === 'object') && x.area >= 15)) {
    const o = M.objects.find((q) => q.kind === d.kind && Math.abs(q.area - d.area) < 0.05);
    console.log(`  shape ${d.kind} ${d.area} m2: turned ${d.turn ?? '-'} degrees, ${d.sides ?? '-'} sides${o?.ring ? `: ${o.ring.map((p) => `${(p[0] - o.middle[0]).toFixed(1)},${(p[1] - o.middle[1]).toFixed(1)}`).join(' ')}` : ''}`);
    // THE SQUARING STAGE BY STAGE on the biggest building's east side (the owner, 2026-11-16: the east is too flat):
    // the traced staircase, then each try's sides as squared and as set by the returns, and why a try was refused
    if (d.trace && d.kind === 'building' && d === debug.filter((x) => x.kind === 'building' && x.trace).sort((a, b) => b.area - a.area)[0]) {
      const [mx, my] = d.middle, f = (p) => `${(p[0] - mx).toFixed(1)},${(p[1] - my).toFixed(1)}`;
      const east = d.trace.raw.filter((p) => p[0] - mx > 2);
      console.log(`    traced ring, east of +2 m (${east.length} of ${d.trace.raw.length} corners): ${east.map(f).join(' ')}`);
      console.log(`    traced ring, whole, to the centimetre: ${d.trace.raw.map((p) => `${(p[0] - mx).toFixed(2)},${(p[1] - my).toFixed(2)}`).join(' ')}`);
      for (const g of d.trace.stages) {
        const ns = (list) => list.filter(([a, b]) => a[0] - mx > 2 && b[0] - mx > 2).map(([a, b]) => `${f(a)}>${f(b)}`).join(' ');
        console.log(`    try at ${g.jog.toFixed(2)} m: ${g.refused ? `REFUSED (${g.refused})` : 'kept'}; squared, east part: ${ns(g.squared)}`);
        if (g.set.length) console.log(`      set by the returns, east part: ${ns(g.set)}`);
      }
    }
    if (d.dropped && d.kind === 'building') { const big = d.dropped.filter((x) => x.len >= 0.5); console.log(`    steps under ${d.minJog?.toFixed(2)} m squared away: ${d.dropped.length}, of which ${big.length} are 0.5 m or deeper: ${big.map((x) => `${x.len.toFixed(2)} m at ${(x.at[0] - d.middle[0]).toFixed(1)},${(x.at[1] - d.middle[1]).toFixed(1)}`).join('; ') || 'none'}`); }
  }
  // the roof corners a walk may take as references (lib/roof-corner.js), with and without the rules
  const RC = roofCorners(M, P, lawn), RA = roofCorners(M, P, [], { maxEaveM: 99 });
  console.log(`Roof corners offered: ${RC.length} (of ${RA.length} outward corners with long sides, before the eave-height and lawn rules): ${RC.map((c) => `${c.label} of the ${M.objects.find((o) => o.id === c.of)?.area} m2 building, eave ${c.eaveM} m, ${c.lawnM} m from the lawn, sides ${c.sidesM.join(' and ')} m, ${c.sure ? 'sure' : `within ${c.within ?? '?'} m`}`).join('; ') || 'none'}`);
  console.log(`  all of them: ${RA.map((c) => `${M.objects.find((o) => o.id === c.of)?.area} m2 ${c.label} eave ${c.eaveM} m${c.sure ? ' sure' : ''}`).join('; ') || 'none'}`);
  const wd = debug.filter((d) => d.kind === 'in the woods');
  console.log(`Left out as in the woods (crowns over the ground round it): ${wd.length}; ${wd.map((d) => `${d.was} ${d.n} returns at ${d.top} m (${d.woods})`).slice(0, 20).join('; ')}`);
  const dk = debug.filter((d) => d.kind === 'deck off a house');
  { const nr = debug.filter((x) => x.kind === 'not roof, off a house'); console.log(`Parts of a house the shade map does not call roof, split off: ${nr.length}; ${nr.map((d) => `~${d.m2} m2 at ${d.top} m (${d.solid ? 'solid: drawn' : `not solid: not drawn; through ${d.through}, rough ${d.rough}`})`).join('; ')}`); }
  console.log(`Decks split off a house: ${dk.length}; ${dk.map((d) => `${d.n} returns at ${d.top} m`).join('; ')}`);
  const ns2 = debug.filter((d) => d.kind === 'not solid');
  console.log(`Left out as not solid (the laser went through, or every height): ${ns2.length}; sizes ${ns2.map((d) => `${d.n} returns (through ${d.through}, rough ${d.rough} m)`).slice(0, 15).join('; ')}`);
  // each raised thing as it was classed: a building is 3.5 m or more up at its middle return AND over 30% of its returns the shade map's roof
  const cl = debug.filter((d) => d.kind === 'classed' && d.m2 >= 15).sort((a, b) => b.m2 - a.m2).slice(0, 15);
  console.log(`Raised solid things of 15 m2 or more, as classed: ${cl.map((d) => `${d.as} ~${d.m2} m2, middle return ${d.top} m up, heights span ${d.pitch} m, ${Math.round(d.bld * 100)}% roof by the shade map`).join('; ') || 'none'}`);
  const tr = debug.filter((d) => d.kind === 'called a tree').sort((a, b) => b.m2 - a.m2);
  console.log(`Groups the shade map calls trees, 20 m2 or more: ${tr.length}; SOLID ones (a roof taken for a crown?): ${tr.filter((d) => d.solid).map((d) => `~${d.m2} m2 at ${d.top} m (through ${d.through}, rough ${d.rough})`).join('; ') || 'none'}`);
  console.log(`  the biggest of the rest: ${tr.filter((d) => !d.solid).slice(0, 6).map((d) => `~${d.m2} m2 at ${d.top} m (through ${d.through}, rough ${d.rough})`).join('; ') || 'none'}`);
  /* WHICH STEP OF THE SHADE MAP'S RULE LOST A SOLID "TREE" (asked by the features session, 2026-11-12, whose rule it is):
     over the patch's own columns, structures.js's reason for each (the model's `why`), their kinds, and what the
     returns themselves say. Counts only; where the patch is stays out of the log. */
  for (const d of tr.filter((x) => x.solid)) {
    const A = model.arrays, cols = new Set(), by = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
    let n = 0, firstOfMany = 0, last = 0, lastGround = 0, single = 0; const cls = {};
    for (let i = 0; i < P.n; i++) {
      if (!d.cells.has(`${Math.floor(P.e(i))},${Math.floor(P.nn(i))}`)) continue;
      const j = P.col(i); if (j >= 0) cols.add(j);
      n++;
      const ret = A.ptRet ? A.ptRet[i] >> 4 : 0, of = A.ptRet ? A.ptRet[i] & 15 : 0, c = A.ptCls ? A.ptCls[i] : -1;
      by(cls, c);
      if (ret === 1 && of > 1) firstOfMany++;
      if (of === 1) single++;
      if (ret === of) { last++; if (c === 2) lastGround++; }
    }
    const why = {}, kinds = {};
    for (const j of cols) { by(why, A.why ? A.why[j] : 'none'); by(kinds, A.kind ? A.kind[j] : 'none'); }
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
    console.log(`  the solid ~${d.m2} m2 patch: ${cols.size} columns; why codes ${JSON.stringify(why)}; kinds ${JSON.stringify(kinds)} (rule ${JSON.stringify(model.meta?.rule?.kinds || null)})`);
    console.log(`    its ${n} returns (all heights, in its 1 m cells): first of several ${pct(firstOfMany, n)}, single ${pct(single, n)}, last returns ${last} of which class 2 (ground) ${pct(lastGround, last)}; classes ${JSON.stringify(cls)}`);
  }
  /* A WINDOW OF THE SHADE MODEL'S OWN COLUMNS (asked by the features session, 2026-11-16: a roof corner under a crown
     that touches the roof is missing from the owner's house). WINDOW="e,n": metres east and north of the biggest
     building's own middle, the window's centre. Heights over the ground and grid offsets only: no place in it. */
  if (process.env.WINDOW && /^-?[\d.]+,-?[\d.]+$/.test(process.env.WINDOW.trim())) {
    const [we, wn] = process.env.WINDOW.trim().split(',').map(Number);
    const house = M.objects.filter((o) => o.kind === 'building' && o.ring).sort((x, y) => y.area - x.area)[0];
    const A = model.arrays, sg = model.meta.grid;
    if (house) {
      const te = house.middle[0] + we, tn = house.middle[1] + wn;
      let jc = -1, bd = Infinity;
      for (let i = 0; i < P.n; i++) { const d = (P.e(i) - te) ** 2 + (P.nn(i) - tn) ** 2; if (d < bd && P.col(i) >= 0) { bd = d; jc = P.col(i); } }
      const cc = jc % sg.w, rc = (jc / sg.w) | 0, c0 = cc - 8, r0 = rc - 6;
      const inRing = (e, n) => { let c = false; const R = house.ring; for (let i = 0, k2 = R.length - 1; i < R.length; k2 = i++) { const [xi, yi] = R[i], [xj, yj] = R[k2]; if ((yi > n) !== (yj > n) && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) c = !c; } return c; };
      // each column's returns, and where it is (its returns' middle) for the outline test
      const per = new Map();
      for (let i = 0; i < P.n; i++) {
        const j = P.col(i); if (j < 0) continue;
        const c = j % sg.w, r = (j / sg.w) | 0; if (c < c0 || c >= c0 + 16 || r < r0 || r >= r0 + 12) continue;
        if (!per.has(j)) per.set(j, { e: 0, n: 0, k: 0, lastGround: 0, rets: [] });
        const q = per.get(j), h = P.hag(i), ret = A.ptRet ? A.ptRet[i] >> 4 : 0, of = A.ptRet ? A.ptRet[i] & 15 : 0, cl = A.ptCls ? A.ptCls[i] : -1;
        q.e += P.e(i); q.n += P.nn(i); q.k++;
        if (ret === of && (cl === 2 || Math.abs(h) < 0.5)) q.lastGround++;
        if (h > 0.3) q.rets.push(`${h.toFixed(1)} ${of === 1 ? 's' : `${ret}/${of}`} c${cl} i${P.bright(i)}`);
      }
      const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
      console.log(`Shade model columns round a point ${we} m east, ${wn} m north of the ${house.area} m2 building's middle: 16 columns west to east, 12 rows north to south (column ${(sg.cell * G.k).toFixed(2)} m). Each: kind/why top roof lastGround, * inside the building's outline as drawn.`);
      for (let r = r0; r < r0 + 12; r++) {
        const row = [];
        for (let c = c0; c < c0 + 16; c++) {
          const j = r * sg.w + c, q = per.get(j), ok = c >= 0 && r >= 0 && c < sg.w && r < sg.h;
          if (!ok) { row.push('off'); continue; }
          const top = A.top ? A.top[j] : NaN, roof = A.roof ? A.roof[j] : NaN;   // as the model keeps them
          row.push(`${A.kind ? A.kind[j] : '-'}/${A.why ? A.why[j] : '-'} ${f1(top)} ${f1(roof)} ${q ? q.lastGround : 0}${q && inRing(q.e / q.k, q.n / q.k) ? '*' : ''}`);
        }
        console.log(`  row ${r - r0}: ${row.join(' | ')}`);
      }
      console.log(`Kinds: ${JSON.stringify(model.meta?.rule?.kinds || null)}. The returns over 0.3 m of the 5 x 5 columns in the middle (rows 4-8, columns 6-10), height then single or return/of, class, intensity:`);
      for (let r = rc - 2; r <= rc + 2; r++) for (let c = cc - 2; c <= cc + 2; c++) { const q = per.get(r * sg.w + c); console.log(`  row ${r - r0} col ${c - c0}: ${q && q.rets.length ? q.rets.join(', ') : 'none'}`); }
      const hb = [];
      for (let i = 0; i < P.n; i++) { if (P.kind(i) !== 1 || P.hag(i) < 2 || !A.ptRet || (A.ptRet[i] & 15) !== 1) continue; if (inRing(P.e(i), P.nn(i))) hb.push(P.bright(i)); }
      hb.sort((x, y) => x - y);
      console.log(`The building's single echoes over 2 m: ${hb.length}, intensity median ${hb.length ? hb[hb.length >> 1] : '-'}; the lot's ground median (meta.own.intensityMedian) ${model.meta?.own?.intensityMedian ?? '-'}.`);
      /* THE EAST EDGE METRE BY METRE (the owner, 2026-11-16: "the front (East) of the house is still too flat"; their
         aerial photo shows the garage furthest out, the middle about 2 m in, the north part about 3 m in). For each 1 m
         slice north to south across the building: its outline's east edge, the eastmost roof return (the shade map's
         kind 1, 2 m or more up) and its height, and the raised returns that are not roof east of that, with their
         heights and kinds. Metres from the building's own middle only. */
      {
        const R = house.ring, mx = house.middle[0], my = house.middle[1];
        const ns = R.map((p) => p[1]), n0 = Math.floor(Math.min(...ns)), n1 = Math.ceil(Math.max(...ns));
        const eastOf = (n) => { let best = -Infinity; for (let i = 0, k2 = R.length - 1; i < R.length; k2 = i++) { const [xi, yi] = R[i], [xj, yj] = R[k2]; if ((yi > n) !== (yj > n)) best = Math.max(best, xi + ((n - yi) * (xj - xi)) / (yj - yi)); } return best; };
        console.log(`East edge of the ${house.area} m2 building, 1 m slices north to south (metres east of its middle): outline | eastmost roof return (height) | raised non-roof returns east of it: east, height, kind`);
        for (let n = n1 - 1; n >= n0; n--) {
          const lo = n, hi = n + 1, oe = eastOf(n + 0.5);
          let re = -Infinity, rh = NaN; const extra = [];
          for (let i = 0; i < P.n; i++) {
            const pn = P.nn(i); if (pn < lo || pn >= hi) continue;
            const pe = P.e(i); if (pe < oe - 6 || pe > oe + 4) continue;
            if (P.kind(i) === 1 && P.hag(i) >= 2 && pe > re) { re = pe; rh = P.hag(i); }
          }
          for (let i = 0; i < P.n; i++) {
            const pn = P.nn(i); if (pn < lo || pn >= hi) continue;
            const pe = P.e(i), h = P.hag(i); if (pe <= re || pe > oe + 4 || !(h >= 0.3)) continue;
            if (P.kind(i) === 1 && h >= 2) continue;
            extra.push(`${(pe - mx).toFixed(1)} ${h.toFixed(1)} k${P.kind(i)}`);
          }
          console.log(`  n ${(lo - my).toFixed(0).padStart(3)}: ${Number.isFinite(oe) ? (oe - mx).toFixed(1) : '-'} | ${Number.isFinite(re) ? `${(re - mx).toFixed(1)} (${rh.toFixed(1)})` : '-'} | ${extra.slice(0, 8).join(', ') || 'none'}${extra.length > 8 ? ` (+${extra.length - 8})` : ''}`);
        }
      }
      // the whole grid's building singles (the brightness band edgeUnderCrown reads, asked for by the features session,
      // 2026-11-16): kind 1, not noise, return 1 of 1, 2-40 m up; and split by the column's why
      {
        const all = [], byWhy = {};
        for (let i = 0; i < P.n; i++) {
          if (P.kind(i) !== 1 || !A.ptRet || A.ptRet[i] !== 0x11) continue;
          const cl = A.ptCls ? A.ptCls[i] : -1; if (cl === 7 || cl === 18) continue;
          const h = P.hag(i); if (!(h > 2 && h < 40)) continue;
          const j = P.col(i), w = j >= 0 && A.why ? A.why[j] : -1, b = P.bright(i);
          all.push(b); (byWhy[w] = byWhy[w] || []).push(b);
        }
        const q = (v) => { v.sort((x, y) => x - y); const at = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))]; return v.length ? `${v.length} singles, intensity p10 ${at(0.1)}, p20 ${at(0.2)}, p50 ${at(0.5)}, p80 ${at(0.8)}, p90 ${at(0.9)}` : 'none'; };
        console.log(`Building singles over the whole grid (kind 1, not class 7 or 18, return 1 of 1, 2-40 m up): ${q(all)}`);
        for (const w of Object.keys(byWhy).sort((x, y) => x - y)) console.log(`  in why-${w} columns: ${q(byWhy[w])}`);
      }
    }
  }
  const pv = debug.filter((d) => d.kind === 'paving');
  console.log(`Paving candidates, each threshold's slabs over 8 m2: ${pv.length}`);
  for (const d of pv.filter((x) => x.square)) console.log(`  KEPT: ${d.n} returns, ${d.area} m2, contrast ${d.contrast}, ${far(d.middle)} (${d.why})`);
  for (const d of pv.sort((a, b) => b.n - a.n).slice(0, 15)) console.log(`  ${d.n} returns, ${d.area} m2, ${far(d.middle)}: ${d.square ? 'KEPT' : 'not kept'} (${d.why || 'not fitted'})`);
  console.log(`Paving drawn: ${M.objects.filter((o) => o.kind === 'paving').map((o) => `${o.area} m2 ${o.traced ? 'traced' : 'straight-edged'}, ${far(o.middle)}`).join('; ') || 'none'}`);
  const why = {}; for (const d of pv) { const k = d.square ? 'kept' : (d.why || '').startsWith('held') ? 'not straight-edged' : d.why; why[k] = (why[k] || 0) + 1; }
  console.log(`Paving reasons: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

main().catch((e) => { console.log(`Marks check: ${e.message}`); process.exit(1); });
