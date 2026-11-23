/**
 * ARE THERE FUSED MODELS, AND WHEN WERE THEY MADE? (core session, 2026-11-23; docs/MAPS.md "The fused model"). The
 * fused file is written by a page on a phone (the scan page, the shade page) or the server's rebuild, and none of
 * them can tell the core session it happened. This lists the main site's bucket for the files kept beside the lidar
 * models: how many maps have a lidar model, how many a fused one, their sizes and when each was written.
 *
 *   node scan/tools/fused-check.mjs
 *
 * Prints counts, sizes and times only: an object's key holds an account id and a hash of the map's id, and neither
 * is printed.
 */
import { API, account, list, CORPUS_BUCKET } from './twin-r2.mjs';

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${CORPUS_BUCKET}`;
  const all = await list(base, token, 'models/');
  const of = (o) => { const m = /^(models\/[^/]+\/[^/]+\/[^/]+\/)([a-z]+)(-fused)?(?:\.(\d+))?\.bin$/.exec(o.key); return m ? { map: m[1], tool: m[2], fused: !!m[3], part: m[4] ? Number(m[4]) : 0, size: o.size, at: o.last_modified || o.uploaded || null } : null; };
  const files = all.map(of).filter(Boolean).filter((f) => f.tool === 'shade');
  const maps = new Map();
  for (const f of files) { const m = maps.get(f.map) || { lidar: null, fused: null, lidarParts: 0, fusedParts: 0, lidarBytes: 0, fusedBytes: 0 }; if (f.part) { m[f.fused ? 'fusedParts' : 'lidarParts']++; } else m[f.fused ? 'fused' : 'lidar'] = f.at; m[f.fused ? 'fusedBytes' : 'lidarBytes'] += f.size; maps.set(f.map, m); }
  const withFused = [...maps.values()].filter((m) => m.fused);
  console.log(`\nFUSED MODELS KEPT ON THE MAIN SITE: ${maps.size} maps have a lidar model; ${withFused.length} have a fused model beside it.`);
  const mb = (b) => `${(b / 1e6).toFixed(2)} MB`;
  let i = 0;
  for (const m of withFused.sort((a, b) => String(b.fused).localeCompare(String(a.fused)))) {
    i++;
    const stale = m.lidar && m.fused && Date.parse(m.lidar) > Date.parse(m.fused);
    console.log(`  fused model ${i}: written ${m.fused} (${mb(m.fusedBytes)} kept, gzipped${m.fusedParts ? `, ${m.fusedParts} overflow parts` : ''}); its lidar model written ${m.lidar || 'NOT THERE'} (${mb(m.lidarBytes)})${stale ? ' -- THE LIDAR MODEL IS NEWER: the fused one will be made again when a page next opens the map' : ''}.`);
  }
  if (!withFused.length) console.log('  None yet: a fused model is made when a map whose record holds a walk\'s plants is opened on the Yard AR start page or in the shade map.');
}

main().catch((e) => { console.log(`Fused check: ${e.message}`); process.exit(1); });
