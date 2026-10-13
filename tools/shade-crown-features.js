/**
 * What a leaf-off laser sees of each crown, for telling evergreens from bare
 * deciduous trees (features session, 2026-10-13: the owner's winter-density
 * rule calls southern pines deciduous -- docs/SHADE-FINDINGS.md 3). For
 * labelled trees (NEON's mapped stems with species, or the core's labelled
 * lawn crowns), the crown each falls in and its features:
 *
 *   winterT   median share of the overhead sun through the crown (the rule now)
 *   H, R, drop  height, equivalent radius, fall of the top 2.5-3.5 m out (domes)
 *   zMid      median height of the crown's returns over its top (0..1)
 *   zLow      10th percentile, the same
 *   multi     share of returns from pulses that split
 *   first     share of returns that are first returns
 *   bright    crown first returns' median intensity over the ground's
 *
 *   node tools/shade-crown-features.js trees.json > crowns.jsonl
 */

import { readFileSync } from 'node:fs';
import { shadeSite } from './shade-site.js';
import { crownsOf } from '../public/shade/crowns.js';
import { DOME_RING_M } from '../public/shade/seasonal.js';
import { cellOf } from '../public/shade/grid.js';

const med = (a) => { if (!a.length) return NaN; const b = Float64Array.from(a).sort(); return b[b.length >> 1]; };
const q = (a, f) => { if (!a.length) return NaN; const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, Math.floor(f * b.length))]; };

/** Crowns over a patch and the features of each. */
export function crownFeatures(site) {
  const { model, cols, season } = site, { w, h, nz, dz, z0, ground, mu } = model, N = w * h;
  const shift = site.shift;
  const top = new Float32Array(N).fill(NaN);
  const cellOfPt = new Int32Array(cols.n);
  for (let i = 0; i < cols.n; i++) {
    const k = cellOf(model.grid, cols.x[i], cols.y[i], shift);
    cellOfPt[i] = k;
    if (k < 0 || cols.cls[i] === 7 || cols.cls[i] === 18) continue;
    const over = cols.z[i] - ground[k];
    if (over > 2 && over < 60 && season.kind[k] !== 1 && !(top[k] >= over)) top[k] = over;
  }
  const { lab, crowns } = crownsOf(cols, model, { shift, top, dropAt: DOME_RING_M });
  const per = crowns.map(() => ({ T: [], z: [], multi: 0, first: 0, n: 0, inten: [] }));
  for (let k = 0; k < N; k++) {
    if (lab[k] < 0) continue;
    let tau = 0;
    const g = ground[k] + 0.1;
    for (let l = 0; l < nz; l++) if (z0 + (l + 0.5) * dz > g) tau += mu[k * nz + l] * dz;
    per[lab[k]].T.push(Math.exp(-tau));
  }
  const groundI = [];
  for (let i = 0; i < cols.n; i++) {
    const k = cellOfPt[i];
    if (k < 0) continue;
    const over = cols.z[i] - ground[k];
    if (cols.cls[i] === 2 && cols.ret[i] === cols.nret[i] && cols.nret[i] === 1) groundI.push(cols.intensity[i]);
    if (lab[k] < 0 || over < 2) continue;
    const c = per[lab[k]], H = crowns[lab[k]].H;
    c.n++;
    c.z.push(over / H);
    if (cols.nret[i] > 1) c.multi++;
    if (cols.ret[i] === 1) { c.first++; c.inten.push(cols.intensity[i]); }
  }
  const gI = med(groundI) || 1;
  return {
    lab,
    crowns: crowns.map((c, id) => ({
      id, H: c.H, R: c.R, drop: c.drop, cells: per[id].T.length,
      winterT: med(per[id].T), zMid: med(per[id].z), zLow: q(per[id].z, 0.1),
      multi: per[id].n ? per[id].multi / per[id].n : NaN, first: per[id].n ? per[id].first / per[id].n : NaN,
      bright: med(per[id].inten) / gI, points: per[id].n,
    })),
  };
}

/* -------------------------------------------------------------- run */

if (import.meta.url === `file://${process.argv[1]}`) {
  const trees = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const plots = new Map();
  for (const t of trees) { const k = `${t.site}|${t.plot}`; if (!plots.has(k)) plots.set(k, []); plots.get(k).push(t); }
  let done = 0;
  for (const [key, list] of plots) {
    try {
      const lat = list.reduce((a, t) => a + t.lat, 0) / list.length, lng = list.reduce((a, t) => a + t.lng, 0) / list.length;
      const site = await shadeSite(lng, lat, { halfM: 45 });
      if (!site) { process.stderr.write(`${key}: no lidar\n`); continue; }
      const { lab, crowns } = crownFeatures(site);
      const { w } = site.model;
      /* Each labelled tree to the crown at its stem (or within 1.5 m); a crown takes its tallest tree's label. */
      const byCrown = new Map();
      for (const t of list) {
        const [gx, gy] = site.cellOf(t.lng, t.lat);
        let id = -1;
        for (let r = 0; r <= 1 && id < 0; r++) for (let dy = -r; dy <= r && id < 0; dy++) for (let dx = -r; dx <= r && id < 0; dx++) {
          const x = Math.floor(gx) + dx, y = Math.floor(gy) + dy;
          if (x >= 0 && y >= 0 && x < w && y < site.model.h) id = lab[y * w + x];
        }
        if (id < 0) continue;
        if (!byCrown.has(id)) byCrown.set(id, []);
        byCrown.get(id).push(t);
      }
      for (const [id, ts] of byCrown) {
        ts.sort((a, b) => b.height - a.height);
        const lead = ts[0], agree = ts.filter((t) => t.label === lead.label).length / ts.length;
        process.stdout.write(`${JSON.stringify({ site: lead.site, plot: lead.plot, label: lead.label, taxon: lead.taxon, treeH: lead.height, trees: ts.length, purity: +agree.toFixed(2), flight: site.cloud.unit?.season, lidar: site.cloud.url.split('/').slice(-2)[0], ...crowns[id] })}\n`);
      }
      done++;
      if (done % 10 === 0) process.stderr.write(`${done}/${plots.size} plots\n`);
    } catch (e) {
      process.stderr.write(`${key}: ERROR ${e.message}\n`);
    }
  }
}
