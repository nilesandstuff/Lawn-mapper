/**
 * The low-spot map for one property, off the page's thread (water session):
 * reading a cloud and filling its surface takes a phone several seconds.
 * In: { site }. Out: progress messages, then { done } with what the page
 * draws (typed arrays, transferred), or { error }.
 */

import { workerIo } from '/lib/browser-io.js';
import { runSite } from '/lib/site.js';

self.onmessage = async ({ data }) => {
  try {
    const io = await workerIo('/lib');
    const pickCloud = async (lng, lat) => {
      const res = await fetch(`/api/shade/lidar?lng=${lng}&lat=${lat}`);
      if (!res.ok) throw new Error(`the lidar search answered ${res.status}`);
      return res.json();
    };
    const progress = (done, total) => self.postMessage({ progress: { done, total } });
    const r = await runSite(data.site, io, pickCloud, { progress });
    if (r.error) { self.postMessage({ error: r.error, notOnAws: r.notOnAws }); return; }
    const res = r.result, g = res.grid;
    const reported = new Uint8Array(g.W * g.H);
    // 2: a lawn hollow (on the traced lawn, when there is one); 1: any other reported spot
    for (const s of res.spots.spots) {
      if (!s.reported) continue;
      const onLawn = !r.lawnMask || s.cells.some((i) => r.lawnMask[i]);
      const v = s.kind === 'hollow' && onLawn ? 2 : 1;
      for (const i of s.cells) if (res.spots.depth[i] >= 0.005) reported[i] = v;
    }
    const grade = new Float32Array(g.W * g.H).fill(NaN);
    for (const w of res.beside.walls) grade[w.i] = w.fallAway;
    const out = {
      grid: { W: g.W, H: g.H, cell: g.cell, k: g.k, bbox: g.bbox, lat: g.lat },
      shift: res.shift,
      depth: res.spots.depth, reported, flow: r.weightedFlow || res.runoff.area, weighted: !!r.weightedFlow, wall: res.wall, grade,
      paved: r.impervious ? r.impervious.paved : null,
      parcelMask: r.parcelMask, lawnMask: r.lawnMask,
      spots: r.spots, hasLawn: r.hasLawn, summary: { ...r.summary, noiseRuns: undefined }, cloud: r.cloud,
    };
    const transfer = [out.depth.buffer, reported.buffer, out.flow.buffer, out.wall.buffer, grade.buffer, ...(out.paved ? [out.paved.buffer] : [])];
    self.postMessage({ done: out }, transfer);
  } catch (e) {
    self.postMessage({ error: e.message || String(e) });
  }
};
