/**
 * STEP 1 OVER THE CORPUS: the low-spot map on the locked training maps
 * (water session; owner, 2026-10-16: "we do have the training corpus, which
 * is a set of 104 maps with property lines and lawn boundary lines").
 *
 * Reads the maps the way workflow 17 does (tools/corpus-db.js, one
 * read-only query; tools/lawn-set.js for the locked list -- both the core
 * session's, imported, not changed). For each: the newest public lidar
 * (the live shade map's /api/shade/lidar), the property line plus 30 m, and
 * lib/site.js. NOTHING IS WRITTEN anywhere but the runner's scratch folder.
 *
 * THE REPOSITORY IS PUBLIC, and these are people's homes: the log names a
 * map only by its place in the list (#1-#104), never its id, address or
 * position, and no picture leaves the runner.
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. [LIMIT=n] node water/tools/corpus.mjs
 */

import { query } from '../../tools/corpus-db.js';
import { lawnSetClause, lawnSetDescription } from '../../tools/lawn-set.js';
import { nodeIo, fetchRetry } from '../lib/node-io.js';
import { runSite } from '../lib/site.js';

const LIDAR_API = process.env.LIDAR_API || 'https://lawnmap.nilesandstuff.com/api/shade/lidar';
const LIMIT = Number(process.env.LIMIT || 0);

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const med = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };
const q = (a, f) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(f * v.length))] : NaN; };

async function main() {
  const env = { ...process.env, LAWN_SET: process.env.LAWN_SET || 'locked' };
  console.log(`Maps: ${lawnSetDescription(env)}`);
  const rows = query(`SELECT id, lng, lat, parcel, shapes FROM corpus WHERE status = 'approved' AND lng IS NOT NULL${lawnSetClause(env)} ORDER BY id`);
  const maps = rows.map((r) => ({
    lng: Number(r.lng), lat: Number(r.lat),
    parcel: asFeature(parse(r.parcel)),
    lawn: (parse(r.shapes) || []).map(asFeature).filter(Boolean),
  })).filter((m) => Number.isFinite(m.lng));
  const todo = LIMIT ? maps.slice(0, LIMIT) : maps;
  console.log(`${maps.length} maps read; running ${todo.length}.\n`);

  const io = nodeIo();
  const pickCloud = (lng, lat) => fetchRetry(`${LIDAR_API}?lng=${lng}&lat=${lat}`, 'json');
  const done = [];
  for (let k = 0; k < todo.length; k++) {
    const tag = `#${k + 1}`;
    try {
      const r = await runSite(todo[k], io, pickCloud);
      if (r.error) { console.log(`${tag}: ${r.error}`); done.push({ error: r.error }); continue; }
      const s = r.summary;
      done.push({ ...s, cloud: r.cloud, hasParcel: !!todo[k].parcel });
      console.log(`${tag}: ${r.cloud.name.replace(/^USGS_LPC_/, '')} flown ${r.cloud.flown}; ground ${s.groundPointsPerM2.toFixed(1)}/m^2, scatter ${(s.scatter * 100).toFixed(1)} cm, floor ${(s.noiseFloor * 100).toFixed(1)} cm;`
        + ` lawn ${Math.round(s.lawnM2 || 0)} m^2, ${s.spotsOnLawn} low spot(s) on it (${Math.round(s.wetLawnM2)} m^2${s.deepestOnLawnCm ? `, deepest ${s.deepestOnLawnCm.toFixed(1)} cm` : ''}), ${s.spotsOnParcel} on the lot;`
        + ` beside the house ${s.besideHouse.towardShare === null ? '-' : pct(s.besideHouse.towardShare * 1000, 1000)} toward, ${s.besideHouse.meetsCodeShare === null ? '-' : pct(s.besideHouse.meetsCodeShare * 1000, 1000)} meets 5%; ${s.seconds.toFixed(0)} s`);
    } catch (e) {
      console.log(`${tag}: failed -- ${String(e.message).replace(/-?\d+\.\d{3,}/g, '…')}`);
      done.push({ error: e.message });
    }
  }

  const ok = done.filter((d) => !d.error);
  const flights = {};
  for (const d of ok) flights[d.cloud.name] = (flights[d.cloud.name] || 0) + 1;
  const withSpot = ok.filter((d) => d.spotsOnLawn > 0);
  const house = ok.filter((d) => d.besideHouse.towardShare !== null);
  console.log('\n==============================================================');
  console.log(`THE LOW-SPOT MAP OVER ${lawnSetDescription(env)}`);
  console.log(`  ran: ${ok.length} of ${todo.length} (${done.length - ok.length} without lidar or failed)`);
  console.log(`  flights: ${Object.entries(flights).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n.replace(/^USGS_LPC_/, '')} ${c}`).join(', ')}`);
  console.log(`  ground pts/m^2 over open ground: median ${med(ok.map((d) => d.groundPointsPerM2)).toFixed(1)} (10th-90th pct ${q(ok.map((d) => d.groundPointsPerM2), 0.1).toFixed(1)}-${q(ok.map((d) => d.groundPointsPerM2), 0.9).toFixed(1)})`);
  console.log(`  scatter: median ${(med(ok.map((d) => d.scatter)) * 100).toFixed(1)} cm; noise floor: median ${(med(ok.map((d) => d.noiseFloor)) * 100).toFixed(1)} cm (10th-90th ${(q(ok.map((d) => d.noiseFloor), 0.1) * 100).toFixed(1)}-${(q(ok.map((d) => d.noiseFloor), 0.9) * 100).toFixed(1)})`);
  console.log(`  lawns with a reported low spot: ${withSpot.length} of ${ok.length} (${pct(withSpot.length, ok.length)}); spots on lawns ${ok.reduce((s, d) => s + d.spotsOnLawn, 0)}, on lots ${ok.reduce((s, d) => s + d.spotsOnParcel, 0)}`);
  console.log(`  wet share of lawn where spots were found: median ${pct(med(withSpot.map((d) => d.wetLawnM2 / d.lawnM2)) * 1000, 1000)}`);
  console.log(`  beside the house (${house.length} lots with a roof on the lot): ground falls toward it on a median ${pct(med(house.map((d) => d.besideHouse.towardShare)) * 1000, 1000)} of the outline;`
    + ` ${house.filter((d) => d.besideHouse.towardShare >= 0.25).length} lots have a quarter or more of it falling toward the house; a median ${pct(med(house.map((d) => d.besideHouse.meetsCodeShare)) * 1000, 1000)} meets the code's 5%`);
  console.log(`  time: median ${med(ok.map((d) => d.seconds)).toFixed(1)} s a lot`);
  console.log('  These say what the map REPORTS, not whether it is right: that is the field check (water/FINDINGS.md, THE BAR).');
}

main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
