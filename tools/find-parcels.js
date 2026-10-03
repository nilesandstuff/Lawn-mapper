/**
 * FIND PARCEL LINES FOR THE COUNTIES PEOPLE ASKED FOR (owner, 2026-10-03:
 * "work through the list of counties people asked for and did not get ...
 * and some automated way to search whenever a county doesn't hit").
 *
 * The console's "Counties people asked for and did not get" is parcel_gaps:
 * every address that came back with no property line, by county. This reads
 * it, and for each county with no entry in the registry and at least
 * MIN_PEOPLE people behind it, searches ArcGIS Online by the county's name
 * for a parcel layer, then writes what it found to tools/found-candidates.json.
 *
 * NOTHING HERE IS COVERAGE. tools/candidates.js adds these to the pool and
 * tools/verify-counties.js proves them exactly as it proves the catalogues'
 * candidates -- real parcels asked for, a point inside one queried back
 * through the app's own lookup, a parcel-sized polygon or nothing. A county
 * found here and failed there stays uncovered, and says why in the log.
 *
 * Runs in workflow 10 (input asked_by), which then verifies, commits and deploys.
 *
 *   MIN_PEOPLE=2 node tools/find-parcels.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { US_COUNTIES } from '../worker/src/us-counties.js';
import { ALL_COUNTIES } from '../worker/src/counties.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, 'found-candidates.json');
/* Every county this run looked at and what happened, for
   tools/record-county-search.js (not committed; the workflow keeps it). */
const REPORT = resolve(here, 'find-report.json');
const MIN_PEOPLE = Math.max(1, Number(process.env.MIN_PEOPLE || 2));
const TIMEOUT_MS = 15000;
const PAUSE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- matching */

/** The name without its type word: "Deuel County" and "Deuel" are one place. */
export const bare = (s) => String(s || '').toLowerCase()
  .replace(/\s*,.*$/, '')
  .replace(/\s+(county|parish|borough|municipality|census area|city and borough|planning region|city)$/i, '')
  .replace(/[^a-z0-9]+/g, '');

/** A state from what the geocoder gave: "MI", "Michigan", "US-MI". */
export function stateFor(text) {
  const t = String(text || '').trim().replace(/^US-/i, '');
  for (const [fp, s] of Object.entries(US_COUNTIES)) {
    if (s.ab.toLowerCase() === t.toLowerCase() || s.name.toLowerCase() === t.toLowerCase()) return { fp, ...s };
  }
  return null;
}

/**
 * The FIPS code of a county the geocoder named. An independent city and the
 * county of the same name are told apart by the word "city" ("Fairfax city"
 * against "Fairfax County"), when the geocoder says which.
 */
export function fipsFor(county, state) {
  const st = stateFor(state);
  if (!st) return null;
  const want = bare(county);
  const isCity = /\bcity\b/i.test(String(county));
  const hits = Object.entries(st.counties).filter(([, n]) => bare(n) === want);
  if (!hits.length) return null;
  const pick = hits.length === 1 ? hits[0]
    : hits.find(([, n]) => /\bcity$/i.test(n) === isCity) || hits[0];
  return { fips: st.fp + pick[0], name: `${pick[1]}, ${st.ab}`, ab: st.ab, box: st.box };
}

/** The registry's key style: "va-prince-william", "va-manassas-city". */
export const keyFor = (name, ab) => `${ab.toLowerCase()}-${String(name).split(',')[0]
  .replace(/\s+County$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** Is this county already in the registry? By FIPS, which is what the registry carries. */
export const registered = (fips) => Object.values(ALL_COUNTIES).some((e) => String(e.fips || '') === String(fips));

/* -------------------------------------------------------------- fields */

const PIN = /^(pin|parcel_?id|parcelid|parcel_?no|parcelno|parcel_?num(ber)?|parcelnumb|parcel|apn|pid|parno|tmk|map_?par(cel)?|pin_?num|prop_?id|acct|account)$/i;
const PIN_LOOSE = /parcel|pin\b|apn|tax_?id/i;
const ADDRESS = /^(site_?addr(ess)?|situs(_?addr(ess)?)?|prop_?addr(ess)?|property_?address|full_?addr(ess)?|location|loc_?addr|siteadd|siteadress|address|addr|physical_?address|prop_?loc)$/i;
const ADDRESS_LOOSE = /situs|site.?add|prop.*addr|addr/i;

/** The parcel-number and site-address fields, from a layer's field list. */
export function guessFields(fields) {
  const names = (fields || []).map((f) => f.name).filter(Boolean);
  const first = (re) => names.find((n) => re.test(n)) || null;
  return {
    pin: first(PIN) || first(PIN_LOOSE),
    address: first(ADDRESS) || first(ADDRESS_LOOSE),
  };
}

export const PARCEL_LAYER = /parcel|cadastr|tax.?(lot|map)|ownership|property.?lines?/i;
const NOT_PARCEL = /annotation|anno\b|label|dimension|lot.?line|parcel.?line|historic|retired|centroid|point/i;

/* ------------------------------------------------------------- network */

async function getJson(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`http-${res.status}`);
      const j = await res.json();
      if (j?.error) throw new Error(`arcgis ${j.error.code || ''} ${j.error.message || ''}`.trim());
      return j;
    } catch (e) { last = e; await sleep(600 * (i + 1)); }
  }
  throw last;
}

/** ArcGIS Online items naming the county and parcels, inside the state. */
export function searchUrl(countyName, box, start = 1) {
  const words = String(countyName).split(',')[0].trim();
  const pad = 0.5;
  return 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
    q: `"${words}" AND (parcel OR parcels OR cadastral OR "tax parcels" OR "tax map") `
      + 'AND (type:"Feature Service" OR type:"Map Service")',
    bbox: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad].join(','),
    f: 'json', num: '50', start: String(start),
  });
}

/** A service URL without any layer on the end, and its kind. */
export function serviceOf(url) {
  const m = String(url || '').match(/^(https?:\/\/.+\/(?:FeatureServer|MapServer))(?:\/(\d+))?\/?$/i);
  return m ? { service: m[1], layer: m[2] === undefined ? null : Number(m[2]) } : null;
}

/** Web Mercator or WGS84 extent to [w, s, e, n] in degrees; null otherwise. */
export function extentDegrees(ext) {
  if (!ext || !Number.isFinite(ext.xmin)) return null;
  const wkid = ext.spatialReference?.latestWkid || ext.spatialReference?.wkid;
  if (wkid === 4326) return [ext.xmin, ext.ymin, ext.xmax, ext.ymax];
  if (wkid === 3857 || wkid === 102100 || wkid === 102113) {
    const R = 6378137;
    const lng = (x) => (x / R) * 180 / Math.PI;
    const lat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    return [lng(ext.xmin), lat(ext.ymin), lng(ext.xmax), lat(ext.ymax)];
  }
  return null;
}

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * The parcel layers of one service: polygon layers named like parcels, with
 * fields guessed. A layer the URL named comes first.
 */
async function parcelLayersOf(svc, stateBox) {
  let meta;
  try { meta = await getJson(`${svc.service}?f=json`); } catch { return []; }
  const layers = (meta.layers || []).filter((l) => (svc.layer === null || l.id === svc.layer || PARCEL_LAYER.test(l.name || ''))
    && PARCEL_LAYER.test(`${l.name} ${svc.layer === l.id ? 'parcel' : ''}`) && !NOT_PARCEL.test(l.name || ''));
  const out = [];
  for (const l of layers.slice(0, 4)) {
    let info;
    try { info = await getJson(`${svc.service}/${l.id}?f=json`); } catch { continue; }
    if (info.geometryType !== 'esriGeometryPolygon') continue;
    /* Where the parcels are, in degrees. A layer in a state plane projection
       is asked for its extent in WGS84; one that cannot say is skipped, so a
       layer from another state with a county of the same name -- Knox
       County, Texas for Knox County, Tennessee -- cannot slip through. */
    let ext = extentDegrees(info.extent);
    if (!ext) {
      try {
        const q = await getJson(`${svc.service}/${l.id}/query?where=1%3D1&returnExtentOnly=true&outSR=4326&f=json`);
        ext = extentDegrees(q.extent);
      } catch { /* none */ }
    }
    if (!ext || (stateBox && !overlaps(ext, [stateBox[0] - 1, stateBox[1] - 1, stateBox[2] + 1, stateBox[3] + 1]))) continue;
    const fields = guessFields(info.fields);
    /* How many parcels: a county's whole layer holds thousands; a project's
       copy (solar sites, county-owned land, a plan review) a handful. */
    let count = null;
    try {
      count = (await getJson(`${svc.service}/${l.id}/query?where=1%3D1&returnCountOnly=true&f=json`)).count ?? null;
    } catch { /* unknown */ }
    out.push({ service: svc.service, layer: l.id, layerName: l.name, title: meta.documentInfo?.Title || '', fields, ext, count });
    await sleep(PAUSE_MS);
  }
  return out;
}

/* A copy made for one project, not the county's parcel layer. */
const PROJECT = /solar|flood|buffer|within|owned|review|innovation|zoning|plan|study|project|propos|sale|vacant|district|wfl1|_wfl|survey|farm|easement|story|dashboard|test|copy|sample|demo|historic|old|archive/i;

/**
 * Best first: the county's own layer over a project's copy of it. Points for
 * a whole county's worth of parcels (by count), for a service or host that
 * names this county, for a layer called just "Parcels", for a PIN and an
 * address field; against a project's name, and against a service naming a
 * different place than the one asked for.
 */
export function scoreOf(c, place) {
  const words = bare(place?.name || '');
  const where = `${c.service} ${c.title} ${c.layerName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  let s = 0;
  if (c.count >= 5000) s += 6; else if (c.count >= 1000) s += 3; else if (c.count !== null && c.count < 200) s -= 4;
  if (words && where.includes(words)) s += 3;
  if (/\/\/(gis|maps|arcgis|gisweb|webgis)\.[^/]*\.(gov|us|org)\//i.test(c.service)) s += 2;
  if (/^(tax\s*)?parcels?$/i.test(c.layerName)) s += 2;
  if (PROJECT.test(`${c.service.split('/services/')[1] || ''} ${c.layerName}`)) s -= 5;
  if (c.fields.pin) s += 1;
  if (c.fields.address) s += 1;
  return s;
}

export function rank(a, b, place) {
  const size = (c) => (c.ext ? (c.ext[2] - c.ext[0]) * (c.ext[3] - c.ext[1]) : 99);
  return scoreOf(b, place) - scoreOf(a, place) || size(a) - size(b);
}

/** Candidates for one county, best first. */
export async function findFor(place) {
  const seen = new Set();
  const found = [];
  for (let start = 1, page = 0; start > 0 && page < 2; page++) {
    let j;
    try { j = await getJson(searchUrl(place.name, place.box, start)); } catch { break; }
    for (const r of j.results || []) {
      const svc = serviceOf(r.url);
      if (!svc || seen.has(svc.service.toLowerCase())) continue;
      seen.add(svc.service.toLowerCase());
      found.push(...await parcelLayersOf(svc, place.box));
      await sleep(PAUSE_MS);
    }
    start = j.nextStart > 0 ? j.nextStart : 0;
  }
  /* A project's copy is never the county's layer unless it holds a county's
     worth of parcels: Knox County TN's only find was "Parcels With
     Categorical Changes", a zoning layer (2026-10-03). */
  return found.filter((c) => !PROJECT.test(`${c.service.split('/services/')[1] || ''} ${c.layerName}`) || c.count >= 5000)
    .sort((a, b) => rank(a, b, place));
}

/* ---------------------------------------------------------------- main */

async function main() {
  const { query } = await import('./corpus-db.js');
  const rows = query(`SELECT county, state, SUM(hits) hits, COUNT(*) people, MAX(covered) configured
                        FROM parcel_gaps GROUP BY county, state
                       HAVING COUNT(*) >= ${MIN_PEOPLE} ORDER BY people DESC, hits DESC`);
  console.log(`${rows.length} counties asked for by ${MIN_PEOPLE}+ people with no property line returned.\n`);

  const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { candidates: [] };
  const kept = new Map((before.candidates || []).map((c) => [c.fips, c]));
  const report = [];
  const foundFips = [];
  const results = [];
  const result = (r, place, status, detail) => results.push({
    county: r.county, state: r.state, people: Number(r.people), hits: Number(r.hits),
    fips: place?.fips || null, name: place?.name || `${r.county}, ${r.state}`, status, detail,
  });

  for (const r of rows) {
    const place = fipsFor(r.county, r.state);
    const label = `${r.county}, ${r.state} (${r.people} people, ${r.hits} asks)`;
    if (!place) {
      report.push(`??  ${label}: not a county the gazetteer knows`);
      result(r, null, 'unknown', 'not a US county the Census gazetteer knows');
      continue;
    }
    if (registered(place.fips)) {
      /* One this search added earlier is proved again, first, by the verifier
         -- with the rules as they are now, which is how a bad find leaves. */
      if (kept.has(place.fips)) {
        foundFips.push(place.fips);
        report.push(`ok  ${label}: found earlier; proved again this run`);
        result(r, place, 'found', `${kept.get(place.fips).service}/${kept.get(place.fips).layer}`);
      } else {
        report.push(`ok  ${label}: in the registry already -- its server answered nothing for these addresses`);
        result(r, place, 'registered', 'in the registry from a catalogue; its server returned no parcel at the addresses people tried');
      }
      continue;
    }
    const found = await findFor(place);
    if (!found.length) {
      report.push(`--  ${label}: no parcel layer found on ArcGIS Online`);
      result(r, place, kept.has(place.fips) ? 'found' : 'none',
        kept.has(place.fips) ? 'nothing new found; the earlier find is proved again' : 'no parcel layer found on ArcGIS Online by name');
      /* An earlier find for this county stays in the pool and is proved again
         first, so one that has stopped passing -- or never should have --
         leaves the registry rather than lingering behind this search. */
      if (kept.has(place.fips)) foundFips.push(place.fips);
      continue;
    }
    const [best, ...rest] = found;
    kept.set(place.fips, {
      key: keyFor(place.name, place.ab),
      name: place.name,
      fips: place.fips,
      service: best.service,
      layer: best.layer,
      layerName: best.layerName,
      fields: best.fields,
      fallbacks: rest.slice(0, 3).map((c) => ({ service: c.service, layer: c.layer, fields: c.fields })),
    });
    foundFips.push(place.fips);
    result(r, place, 'found', `${best.layerName} at ${best.service}/${best.layer}`);
    report.push(`+   ${label}: ${best.layerName} at ${best.service}/${best.layer}`
      + `${rest.length ? ` (+${rest.length} more)` : ''}`);
  }

  writeFileSync(OUT, `${JSON.stringify({
    foundBy: 'tools/find-parcels.js',
    foundAt: new Date().toISOString().slice(0, 10),
    note: 'Candidates only, from parcel_gaps. Nothing here is coverage until verify-counties.js says so.',
    candidates: [...kept.values()].sort((a, b) => a.key.localeCompare(b.key)),
  }, null, 2)}\n`);

  writeFileSync(REPORT, `${JSON.stringify({ at: new Date().toISOString(), minPeople: MIN_PEOPLE, results }, null, 2)}\n`);
  console.log(report.join('\n'));
  const added = report.filter((l) => l.startsWith('+')).length;
  console.log(`\n${added} found and added to the candidate pool for the verifier; `
    + `${kept.size} in tools/found-candidates.json in all.`);
  /* What this run found, for the workflow's verify step (FIRST_FIPS). */
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `found=${added}\nfips=${foundFips.join(',')}\n`, { flag: 'a' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
