/**
 * THE BUILT PAGE LOADED IN A BROWSER BEFORE IT IS DEPLOYED (core session, 2026-11-10). On 2026-11-09 a commit deleted
 * a block of scan/public/app.js; every test passed, the deploy went out, and the page stopped at "Checking what this
 * phone offers…" ("wireMap is not defined") with the owner standing in a car park. The unit tests read the libraries,
 * not the page as a browser runs it. This serves scan/build with stand-in answers, opens it with and without a map,
 * and fails on any page error, on a page still at its start line, and on a worker that will not load.
 *
 *   node scan/tools/page-check.mjs        (needs playwright and its chromium: the workflow installs them)
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const T = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
// a 2 x 2 PNG, for the map's photo
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7oQnUAAAAASUVORK5CYII=', 'base64');

let THINGS = { v: 1, things: [{ id: 't1', kind: 'gutter-out', at: [1, 1], h: 0.1, grade: 'corners3', seen: [{ at: [1, 1], h: 0.1, walk: 'w', grade: 'corners3', t: 1 }] }, { id: 't4', kind: 'gutter-out', at: [3, 1], h: 0.1, grade: 'unsure', seen: [{ at: [3, 1], h: 0.1, walk: 'w', grade: 'unsure', t: 1 }] }] }, PUTS = 0;
const TOOL = [];
const srv = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const json = (o, code = 200) => { s.statusCode = code; s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify(o)); };
  if (u.pathname === '/api/maps/one') return json({ map: { id: 'check', lng: -100, lat: 40, shapes: [], at: 1 } });
  if (u.pathname === '/api/maps/photo') { s.setHeader('X-Photo-Frame', JSON.stringify({ lng: -100, lat: 40, zoom: 19, size: 640 })); s.setHeader('X-Photo-Source', 'county'); s.setHeader('Content-Type', 'image/png'); return s.end(PNG); }
  // the map's placed things (2026-11-22): two gutter outlets, listed under the start buttons with "Take away"
  if (u.pathname === '/api/scan/things') {
    if (q.method === 'PUT') { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { THINGS = JSON.parse(b); PUTS++; json({ ok: true }); }); return; }
    return json(THINGS);
  }
  // a walk's plants kept with the map (2026-11-23): read when the map opens, put into the scan tool's part of the record
  if (u.pathname === '/api/scan/plants') return json({ v: 1, cellM: 0.3048, at: 'now', boxes: [[0, 0, 3, 12], [1, 0, 3, 40]] });
  if (u.pathname === '/api/maps/tool' && q.method === 'POST') { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { try { TOOL.push(JSON.parse(b)); } catch { /* not json */ } json({ ok: true }); }); return; }
  if (u.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  const f = join(B, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(B) || !existsSync(f)) { s.statusCode = 404; return s.end(); }
  s.setHeader('Content-Type', T[extname(f)] || 'application/octet-stream'); s.end(readFileSync(f));
});

async function main() {
  if (!existsSync(join(B, 'index.html'))) throw new Error('no build: run scan/tools/prepare.mjs first');
  const { chromium } = await import('playwright');
  await new Promise((ok) => srv.listen(0, ok));
  const at = `http://localhost:${srv.address().port}`;
  const br = await chromium.launch();
  const faults = [];
  try {
    for (const path of ['/', '/?map=check']) {
      const pg = await br.newPage();
      pg.on('pageerror', (e) => faults.push(`${path}: ${e.message}`));
      await pg.goto(at + path); await pg.waitForTimeout(2500);
      const status = await pg.evaluate(() => document.querySelector('#status')?.textContent || '');
      if (!status || /^Checking what this phone offers/.test(status)) faults.push(`${path}: the page never left its start line ("${status.slice(0, 60)}")`);
      if (path !== '/') {
        const setup = await pg.evaluate(() => !document.querySelector('#setup')?.hidden);
        if (!setup) faults.push(`${path}: the placement map did not open`);
        for (const w of ['/lidar-worker.js', '/ref-worker.js']) {
          const err = await pg.evaluate((src) => new Promise((ok) => { const k = new Worker(src, { type: 'module' }); const t = setTimeout(() => ok(null), 2500); k.onerror = (e) => { clearTimeout(t); ok(e.message || 'would not load'); }; }), w);
          if (err) faults.push(`${w}: ${err}`);
        }
        if (!TOOL.some((t) => t?.data?.plants?.boxes?.length === 2)) faults.push(`${path}: a walk's plants were not put into the map's record (${TOOL.length} writes of the scan tool's part)`);
        // the placed things: listed, and one taken away with two taps (kept as gone, not deleted) and put back
        const rows = () => pg.evaluate(() => [...document.querySelectorAll('#things-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
        const tap = (id) => pg.evaluate((i) => document.querySelector(`#things-list button[data-thing="${i}"]`)?.click(), id);
        const r0 = await rows();
        if (r0.length !== 2 || !/t4 gutter outlet/.test(r0[1])) faults.push(`${path}: the placed things are not listed (${JSON.stringify(r0)})`);
        else {
          await tap('t4'); await tap('t4'); await pg.waitForTimeout(800);
          const r1 = await rows(), gone = THINGS.things.find((t) => t.id === 't4')?.gone;
          if (!gone || THINGS.things.length !== 2 || !/taken away.*Put back/.test(r1[1] || '')) faults.push(`${path}: "Take away" did not mark the thing gone and keep it (${JSON.stringify(r1)}; ${PUTS} saves)`);
          await tap('t4'); await pg.waitForTimeout(800);
          if (THINGS.things.find((t) => t.id === 't4')?.gone || !/Take away/.test((await rows())[1] || '')) faults.push(`${path}: "Put back" did not bring the thing back`);
        }
      }
      await pg.close();
    }
  } finally { await br.close(); srv.close(); }
  if (faults.length) { console.log(`The built page does NOT run in a browser; not deploying:\n  ${faults.join('\n  ')}`); process.exit(1); }
  console.log('The built page runs in a browser: it opens with and without a map, both workers load, the plants of a walk go into the record of the map, and a placed thing can be taken away and put back.');
}
main().catch((e) => { console.log(`Page check could not run: ${e.message}`); process.exit(1); });
