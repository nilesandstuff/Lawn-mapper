/**
 * THE AIRPORT WEATHER STATIONS, for the local wind (water session, 2026-10-27; FINDINGS H48). The Iowa Environmental
 * Mesonet's list of every ASOS/AWOS station it archives (free, no key), cut to the US stations with at least ten years
 * of record, as a compact list the page reads to find the nearest: [id, network, lat, lon, firstYear, lastYear|null,
 * name]. Run by hand, or by the deploy (prepare.mjs), which keeps the committed copy when IEM does not answer.
 *   node water/tools/stations.mjs
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATIONS_URL = 'https://mesonet.agron.iastate.edu/geojson/network/AZOS.geojson';
export const STATIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'asos-stations.json');

/** The compact list from IEM's GeoJSON: US stations with ten or more years of record, still reporting or not. */
export function compactStations(geo, { now = new Date(), minYears = 10 } = {}) {
  const y0 = now.getUTCFullYear() - minYears;
  const out = [];
  for (const f of geo.features || []) {
    const p = f.properties || {}, c = f.geometry?.coordinates;
    if (p.country !== 'US' || !Array.isArray(c) || !p.archive_begin) continue;
    const first = Number(String(p.archive_begin).slice(0, 4)), last = p.archive_end ? Number(String(p.archive_end).slice(0, 4)) : null;
    if (!(first <= y0) || (last !== null && last < now.getUTCFullYear() - 1)) continue;
    out.push([f.id || p.sid, p.network, Math.round(c[1] * 1e4) / 1e4, Math.round(c[0] * 1e4) / 1e4, first, last, String(p.sname || '').slice(0, 40)]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export async function writeStations(fetchFn = fetch) {
  const r = await fetchFn(STATIONS_URL);
  if (!r.ok) throw new Error(`IEM's station list answered ${r.status}`);
  const list = compactStations(await r.json());
  if (list.length < 500) throw new Error(`only ${list.length} stations: not written`);
  writeFileSync(STATIONS_FILE, JSON.stringify({ from: STATIONS_URL, at: new Date().toISOString().slice(0, 10), fields: ['id', 'network', 'lat', 'lon', 'firstYear', 'lastYear', 'name'], stations: list }));
  return list.length;
}

if (process.argv[1] && process.argv[1].endsWith('stations.mjs')) writeStations().then((n) => console.log(`${n} stations written to ${STATIONS_FILE}`));
