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

const srv = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const json = (o, code = 200) => { s.statusCode = code; s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify(o)); };
  if (u.pathname === '/api/maps/one') return json({ map: { id: 'check', lng: -100, lat: 40, shapes: [], at: 1 } });
  if (u.pathname === '/api/maps/photo') { s.setHeader('X-Photo-Frame', JSON.stringify({ lng: -100, lat: 40, zoom: 19, size: 640 })); s.setHeader('X-Photo-Source', 'county'); s.setHeader('Content-Type', 'image/png'); return s.end(PNG); }
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
      }
      await pg.close();
    }
  } finally { await br.close(); srv.close(); }
  if (faults.length) { console.log(`The built page does NOT run in a browser; not deploying:\n  ${faults.join('\n  ')}`); process.exit(1); }
  console.log('The built page runs in a browser: it opens with and without a map, and both workers load.');
}
main().catch((e) => { console.log(`Page check could not run: ${e.message}`); process.exit(1); });
