/**
 * THE TRACED LAWN BESIDE A WALK, IN THE MAP'S METRES (core session, 2026-11-24; for scan/tools/surfaces.py): the walk's
 * map's own lawn shapes (the map record, docs/MAPS.md), east and north of the map's point (scan/lib/frames.js toLocal),
 * written to <twin>/lawn.json. Coordinates stay in the file on the runner; nothing but counts is printed.
 *
 *   node scan/tools/lawn-prep.mjs twin
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMap } from './twin-io.mjs';
import { ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';

async function main() {
  const dir = process.argv[2] || 'twin';
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  if (!meta.map) throw new Error('the walk was made with no map open');
  const m = await readMap(meta.map);
  const origin = [m.lng, m.lat];
  const rings = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p).map((v) => +v.toFixed(3))));
  writeFileSync(join(dir, 'lawn.json'), JSON.stringify({ rings }));
  console.log(`The traced lawn beside the walk: ${rings.length} ring(s), ${rings.reduce((a, r) => a + r.length, 0)} corners.`);
}
main().catch((e) => { console.log(`Lawn: ${e.message}`); process.exit(1); });
