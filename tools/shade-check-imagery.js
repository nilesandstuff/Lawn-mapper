/**
 * THE SHADE MAP AGAINST THE SITE'S OWN PHOTOS: the county photos and Mapbox,
 * as the editor shows them (owner, 2026-10-12: "Mapbox is hit or miss on
 * leaf-on vs leaf-off, but usually sharper than NAIP"). Neither says when
 * it was flown, so the sun's DIRECTION itself is fitted on buildings'
 * shadows (tools/shade-photo-score.js), and whether the trees are in leaf
 * is read off the photo (green crowns or not). A leaf-off photo -- most
 * county flights are early spring -- scores the bare-tree model, which
 * NEON's ground sensors found too bright in winter.
 *
 *   node tools/shade-check-imagery.js [lots.csv] > results.jsonl
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { shadeSite } from './shade-site.js';
import { scorePhoto, sunGrid } from './shade-photo-score.js';
import { gridForFrame } from '../public/shade/grid.js';
import { frameBbox3857, imagePixels, imageHeightPixels, PROVIDERS } from '../worker/src/imagery.js';

const SITE = process.env.SITE || 'https://lawnmap.nilesandstuff.com';
const ZOOM = 18, SIZE = 640; // ~140 m across at 43 degrees

/*
 * DIRECT_PHOTOS=1 (workflow 35 on GitHub's runners, which the live site
 * refuses with a 403): the photos straight from their sources, framed the
 * way /api/imagery frames them -- Mapbox with the repository's token (sent
 * with the site as its referrer, for a token locked to it), and the county's
 * own ImageServer flights. The county list is Ottawa's (the owner's area;
 * the core session's catalogue, 2026-10-14), not looked up per point.
 */
const DIRECT = /^(1|yes|true)$/i.test(process.env.DIRECT_PHOTOS || '');
const OTTAWA = [2024, 2021, 2018].map((year) => ({ year, title: `ImageService/Aerial${year}`, url: `https://gis.miottawa.org/image/rest/services/ImageService/Aerial${year}/ImageServer` }));
function directUrl(src, frame) {
  if (src.provider === 'mapbox') return PROVIDERS.mapbox.url(frame, process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN || '');
  const params = new URLSearchParams({ bbox: frameBbox3857(frame).join(','), bboxSR: '3857', imageSR: '3857', size: `${imagePixels(frame)},${imageHeightPixels(frame)}`, format: 'png', f: 'image' });
  return `${src.url}/exportImage?${params}`;
}

async function getRetry(u, as = 'json', tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, { headers: { Referer: `${SITE}/` } });
      if (!r.ok) throw new Error(`${r.status}`);
      return as === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${e.message} ${u.slice(0, 140)}`);
      await new Promise((ok) => setTimeout(ok, 3000 * 2 ** i));
    }
  }
}

function decode(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; }
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, data: j.data };
}

/** A photo onto the model's 1 m cells: { bright, exg, seen }. */
function ontoCells(site, frame, img) {
  const { model, box } = site, { w, h } = model, N = w * h;
  const g = gridForFrame(frame, img.width, img.height);
  const sum = new Float32Array(N * 4);
  const cell = model.grid.cell;
  for (let py = 0; py < img.height; py++) for (let px = 0; px < img.width; px++) {
    const X = g.x0 + (px + 0.5) * g.cell, Y = g.y1 - (py + 0.5) * (g.cellY || g.cell);
    const cx = Math.floor((X - box[0]) / cell), cy = Math.floor((box[3] - Y) / cell);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const o = (py * img.width + px) * 4, k = cy * w + cx;
    if (img.data[o + 3] === 0) continue;
    sum[4 * k] += img.data[o]; sum[4 * k + 1] += img.data[o + 1]; sum[4 * k + 2] += img.data[o + 2]; sum[4 * k + 3]++;
  }
  const bright = new Float32Array(N), exg = new Float32Array(N), seen = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const n = sum[4 * k + 3];
    if (!n) continue;
    const r = sum[4 * k] / n, gg = sum[4 * k + 1] / n, b = sum[4 * k + 2] / n;
    bright[k] = 0.3 * r + 0.59 * gg + 0.11 * b;
    exg[k] = (2 * gg - r - b) / Math.max(1, r + gg + b);
    seen[k] = 1;
  }
  return { bright, exg, seen };
}

/**
 * Leaf-on or leaf-off, from the photo: the lidar's tree crowns against the
 * open grass. Leafy crowns are about as green as a lawn; bare ones show
 * brown branches with only some green grass through them (checked by eye on
 * 2026-10-13: a county 2020 flight whose bare crowns still read faintly
 * green on their own).
 */
function leafState(site, cells) {
  const crown = [], grass = [];
  for (let k = 0; k < cells.exg.length; k++) {
    if (!cells.seen[k]) continue;
    const kind = site.season.kind[k];
    if (kind === 2 || kind === 3) crown.push(cells.exg[k]);
    else if (kind === 0 && cells.exg[k] > 0.02) grass.push(cells.exg[k]);
  }
  const md = (v) => { v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };
  const c = md(crown), g = md(grass), ratio = g > 0 ? c / g : 0;
  return { leaf: ratio > 0.9 ? 'on' : ratio < 0.7 ? 'off' : 'mixed', crownGreen: +c.toFixed(3), grassGreen: +g.toFixed(3), greenRatio: +ratio.toFixed(2) };
}

/** One photo of a lot onto the model's cells (for rescoring, tools/shade-check-bare.js). */
export async function photoCells(site, lng, lat, provider, svc = null) {
  const frame = { lng, lat, zoom: ZOOM, size: SIZE, height: SIZE };
  const q = `${SITE}/api/imagery?provider=${provider}${svc != null ? `&svc=${svc}` : ''}&lng=${lng}&lat=${lat}&zoom=${ZOOM}&size=${SIZE}&height=${SIZE}`;
  return ontoCells(site, frame, decode(await getRetry(q, 'bytes')));
}

/**
 * One lot's photos scored. `everyYear`: every county flight year once (the
 * catalogue lists some twice, as a cached copy), not just the first three;
 * `mixed`: score a photo whose crowns are neither clearly green nor bare
 * too, against the leafy canopy (its bare one comes back as the other
 * season) -- the field check, tools/shade-field-photos.js.
 */
export async function checkLot(lng, lat, { everyYear = false, mixed = false } = {}) {
  const site = await shadeSite(lng, lat, { halfM: 110 });
  if (!site) return [{ lng, lat, skip: 'no lidar' }];
  const county = DIRECT ? { services: OTTAWA.map((o) => ({ ...o, id: o.title })) } : await getRetry(`${SITE}/api/county-imagery?lng=${lng}&lat=${lat}`).catch(() => null);
  const sources = [{ provider: 'mapbox', label: 'mapbox' }];
  const services = county?.services || [];
  const picked = everyYear ? services.filter((s, i) => services.findIndex((o) => o.year === s.year) === i) : services.slice(0, 3);
  for (const s of picked) sources.push({ provider: 'county', svc: s.id, label: `county ${s.title}`, year: s.year, url: s.url });
  const frame = { lng, lat, zoom: ZOOM, size: SIZE, height: SIZE };
  const out = [];
  for (const src of sources) {
    try {
      const q = DIRECT ? directUrl(src, frame) : `${SITE}/api/imagery?provider=${src.provider}${src.svc ? `&svc=${src.svc}` : ''}&lng=${lng}&lat=${lat}&zoom=${ZOOM}&size=${SIZE}&height=${SIZE}`;
      const img = decode(await getRetry(q, 'bytes'));
      const cells = ontoCells(site, frame, img);
      const ls = leafState(site, cells);
      if (ls.leaf === 'mixed' && !mixed) { out.push({ lng, lat, source: src.label, year: src.year, ...ls, skip: 'crowns neither clearly green nor bare' }); continue; }
      const leaf = ls.leaf === 'mixed' ? 'on' : ls.leaf;
      const ground = Uint8Array.from(cells.exg, (v) => (leaf === 'on' ? (v > 0.02 ? 1 : 0) : 1));
      const r = scorePhoto(site, { bright: cells.bright, ground, seen: cells.seen }, { suns: sunGrid, leaf });
      out.push({ lng, lat, source: src.label, year: src.year, px: img.width, ...ls, lidar: site.cloud.url.split('/').slice(-2)[0], flight: site.flight?.season, ...r, leafRead: ls.leaf });
    } catch (e) {
      out.push({ lng, lat, source: src.label, year: src.year, error: e.message });
    }
  }
  return out;
}

/* -------------------------------------------------------------- run */

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || new URL('../data/labelled-crowns.csv', import.meta.url);
  const rows = readFileSync(file, 'utf8').trim().split('\n');
  const head = rows[0].split(',');
  const lots = new Map();
  for (const line of rows.slice(1)) {
    const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const o = Object.fromEntries(head.map((k, i) => [k, cells[i]]));
    const id = (o.corpus_id || `${o.lng},${o.lat}`).split(':')[0];
    if (!lots.has(id)) lots.set(id, id.split(',').map(Number));
  }
  const list = [...lots.values()].slice(0, Number(process.env.LIMIT) || undefined);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const [lng, lat] = list[next++];
      try {
        for (const r of await checkLot(lng, lat)) {
          process.stdout.write(`${JSON.stringify(r)}\n`);
          const t = r.trees;
          process.stderr.write(`${lng},${lat} ${r.source || ''}: ${r.skip || r.error || `${r.leaf} sun ${r.fit.sunEl}°/${r.fit.sunAz}° fit ${r.fit.r} trees photo ${(100 * t.photo / t.n).toFixed(0)}% model ${(100 * t.model / t.n).toFixed(0)}%`}\n`);
        }
      } catch (e) {
        process.stderr.write(`${lng},${lat}: ERROR ${e.message}\n`);
      }
    }
  };
  await Promise.all([worker(), worker()]);
}
