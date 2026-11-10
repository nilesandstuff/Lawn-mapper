/**
 * THE STRETCHED PHOTOS KEPT FOR THE PLACEMENT MAP (core session, 2026-11-09; scan/tools/warp_study.py): warp.json and
 * warped-<photo>.png from the study's folder into the twin bucket, under refs/warp/<map>/. A photo the study kept no
 * stretch for (none beat leaving it alone) has its old stretched copy taken out, so the page never shows a stale one.
 * Prints names and sizes only.
 *
 *   node scan/tools/warp-keep.mjs warp
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeObject, deleteObject, BUCKET } from './twin-r2.mjs';

const dir = process.argv[2] || 'warp';
const info = JSON.parse(readFileSync(join(dir, 'photos.json'), 'utf8'));
if (!info.map) throw new Error('no map in photos.json');
const files = ['warp.json', ...readdirSync(dir).filter((f) => /^warped-[a-z]+\.png$/.test(f))].filter((f) => existsSync(join(dir, f)));
for (const f of files) {
  const b = readFileSync(join(dir, f));
  await writeObject(BUCKET, `refs/warp/${info.map}/${f}`, b, f.endsWith('.json') ? 'application/json' : 'image/png');
  console.log(`kept ${f} (${(b.length / 1e6).toFixed(1)} MB)`);
}
for (const src of Object.keys(info.photos || {})) {
  if (existsSync(join(dir, `warped-${src}.png`))) continue;
  if (await deleteObject(BUCKET, `refs/warp/${info.map}/warped-${src}.png`)) console.log(`no stretch kept for the ${src} photo (an older one, if any, taken out)`);
}
