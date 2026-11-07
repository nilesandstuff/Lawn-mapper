/**
 * A WALK RECORDED WITHOUT ITS MAP, GIVEN ONE AFTERWARDS (core session, 2026-11-07; the owner's first outdoor walk in
 * the app, which could not be handed the map: "I placed 2 pins on locations where 2 checkpoints were placed for that
 * map, but I can't remember which 2"). Copies into the fetched twin (dir) what another walk on the same map kept:
 * meta.json's map, and live.json's points (the references and check points with their map places) when this walk
 * has none. With no GPS trail (the page keeps one only with a map open) it makes one from the walk's Geospatial
 * trail, in the map's local metres, so the placement's search has its gate.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/twin-map.mjs twin <other walk id>
 *
 * Prints counts only (map ids and places stay in the files; the repository is public).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readObject, BUCKET, walkOk } from './twin-r2.mjs';
import { readMap } from './twin-io.mjs';
import { toLocal } from '../lib/frames.js';

async function main() {
  const [dir = 'twin', from] = process.argv.slice(2);
  if (!walkOk(from)) throw new Error('which walk has the map? (its id)');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const livePath = join(dir, 'live.json');
  const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : {};
  const otherMeta = JSON.parse((await readObject(BUCKET, `twins/${from}/meta.json`))?.toString() || '{}');
  const otherLive = JSON.parse((await readObject(BUCKET, `twins/${from}/live.json`))?.toString() || '{}');
  const said = [];
  // what the walk's own live.json holds, counts only (2026-11-07: the walk's last copy had been lost by the outbox)
  said.push(`its live.json ${live.ended ? 'is the walk\'s last' : 'is NOT the walk\'s last (ended not set)'}, ${(live.pins || []).length} pins, ${(live.geoTrail || []).length} Street View readings, ${(live.gpsTrail || []).length} GPS readings, walked ${Math.round(live.odo ?? 0)} m`);
  if (!meta.map) {
    if (!otherMeta.map) throw new Error('that walk names no map either');
    meta.map = otherMeta.map; said.push("the map from the other walk");
  } else said.push('its own map kept');
  if (!(live.points || []).length && (otherLive.points || []).length) { live.points = otherLive.points; said.push(`${live.points.length} references and check points`); }
  if (!(live.gpsTrail || []).length && (live.geoTrail || []).length) {
    const m = await readMap(meta.map);
    const origin = [m.lng, m.lat];
    // degrees first (absolute, against this map's origin); the map metres a reading carried when degrees are missing
    live.gpsTrail = live.geoTrail.filter((g) => (Number.isFinite(g.lat) || Array.isArray(g.at)) && Number.isFinite(g.hacc)).map((g) => ({ at: (Number.isFinite(g.lat) ? toLocal(origin, [g.lng, g.lat]) : g.at).map((v) => +v.toFixed(2)), phone: g.phone, acc: Math.max(1, +g.hacc), odo: g.odo, src: 'geospatial' }));
    const acc = live.gpsTrail.map((g) => g.acc).sort((a, b) => a - b);
    said.push(`a trail from ${live.gpsTrail.length} Geospatial readings (median accuracy ${acc.length ? acc[acc.length >> 1].toFixed(1) : '-'} m)`);
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(livePath, JSON.stringify(live));
  console.log(`Map given to the walk: ${said.join('; ')}.`);
}

main().catch((e) => { console.log(`Map for the walk: ${e.message}`); process.exit(1); });
