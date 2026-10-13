/**
 * HOW DENSE ARE BARE TREES? (features session, 2026-10-13). The leaf-off
 * photos of the corpus lots (county flights, Mapbox) showed bare trees
 * shading more lawn than the leaf-off model (tools/shade-check-imagery.js).
 * This rescores those same photos -- same sun, same offset, found on
 * buildings -- with the bare deciduous crowns' density multiplied by k, to
 * see which k matches the photos.
 *
 *   node tools/shade-check-bare.js imagery-results.jsonl > bare.jsonl
 */

import { readFileSync } from 'node:fs';
import { shadeSite } from './shade-site.js';
import { scorePhoto } from './shade-photo-score.js';
import { photoCells } from './shade-check-imagery.js';

const SITE = process.env.SITE || 'https://lawnmap.nilesandstuff.com';
const KS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** The leaf-off model with deciduous crowns (kind 3) k times as dense. */
export function bareTimes(site, k) {
  const { model, season } = site, { nz } = model, mu = Float32Array.from(season.muOff);
  for (let c = 0; c < season.kind.length; c++) if (season.kind[c] === 3) for (let l = 0; l < nz; l++) mu[c * nz + l] *= k;
  return mu;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.trees && r.leaf === 'off');
  for (const r of rows) {
    try {
      const site = await shadeSite(r.lng, r.lat, { halfM: 110 });
      let svc = null;
      if (r.source !== 'mapbox') {
        const c = await (await fetch(`${SITE}/api/county-imagery?lng=${r.lng}&lat=${r.lat}`)).json();
        svc = (c.services || []).find((s) => `county ${s.title}` === r.source)?.id;
        if (svc == null) { process.stderr.write(`${r.source}: service gone\n`); continue; }
      }
      const cells = await photoCells(site, r.lng, r.lat, r.source === 'mapbox' ? 'mapbox' : 'county', svc);
      const R = Math.PI / 180, az = r.fit.sunAz, el = r.fit.sunEl;
      const fixedFit = { r: r.fit.r, n: r.fit.n, dx: r.fit.shift[0], dy: r.fit.shift[1], sun: { azimuth: az, elevation: el, dir: [Math.sin(az * R) * Math.cos(el * R), Math.cos(az * R) * Math.cos(el * R), Math.sin(el * R)] } };
      const ground = new Uint8Array(cells.bright.length).fill(1);
      const out = { lng: r.lng, lat: r.lat, source: r.source, byK: {} };
      for (const k of KS) {
        const s = scorePhoto(site, { bright: cells.bright, ground, seen: cells.seen }, { leaf: 'off', fixedFit, muTrees: bareTimes(site, k) });
        if (s.skip) { out.byK[k] = { skip: s.skip }; continue; }
        out.byK[k] = { beam: s.meanBeamTrees, trees: s.trees, inner: s.treesInner };
      }
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.stderr.write(`${r.lng},${r.lat} ${r.source}: ${KS.map((k) => `${k}:${out.byK[k].beam ? (out.byK[k].beam.model - out.byK[k].beam.photo).toFixed(3) : '-'}`).join(' ')}\n`);
    } catch (e) {
      process.stderr.write(`${r.lng},${r.lat} ${r.source}: ERROR ${e.message}\n`);
    }
  }
}
