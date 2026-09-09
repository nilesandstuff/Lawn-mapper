/**
 * Find states that publish every county's parcels from one endpoint.
 *
 * North Carolina turned out to work this way by accident: the hunt was for
 * Johnston County's own server, and what answered was NC OneMap -- the STATE
 * republishing all hundred counties on one layer with one schema. Adding the
 * rest of North Carolina was a bounding box and nothing else. That beats the
 * counties-and-servers arrangement the rest of the registry is built on, where
 * each one has its own host, path, layer index, field names and projection,
 * and each one goes stale separately.
 *
 * THE FIRST VERSION OF THIS TOOL GUESSED, AND SCORED 1 IN 12.
 *
 * It carried a hard-coded URL per state, written from recollection of state
 * GIS programmes. Vermont's was right. The other eleven were invalid, moved,
 * renamed, or answered "Token Required" -- and the failures said nothing about
 * whether those states HAVE such a service, only that I did not know its
 * address. Utah, Wisconsin and Massachusetts all run statewide parcel
 * programmes; I simply had the wrong URLs.
 *
 * So this asks instead of remembering. ArcGIS Online indexes public services,
 * including nearly every state GIS programme's, and its search API is open. We
 * search it per state, take what it returns, and put each candidate through
 * the same test: ask for a house at a real address and measure what comes
 * back. Recollection is now only used for the SEARCH TERMS, where being wrong
 * costs a ranking rather than a false negative.
 *
 * That is the same lesson discover-counties.js already carries: a candidate
 * list is a shortcut, not a substitute for looking. Kent County was written
 * off as having no public endpoint because its server runs under an
 * unguessable instance name, and it was there the whole time.
 *
 * Free: catalogue searches and point queries. No imagery, no AI.
 *
 *   node tools/probe-statewide.js
 *   STATES=utah,wisconsin node tools/probe-statewide.js
 */

import { measure } from '../public/lib/area.js';

/*
 * A residential point per state, and the words to search for it.
 *
 * The point matters as much as the search: a layer can be perfectly alive and
 * simply have nothing where you asked, and "no parcel here" is indistinguishable
 * from "this is not a parcel layer" if you only ask once. These are ordinary
 * streets in mid-sized towns, aimed from memory -- so some will land on a
 * campus or a road, exactly as two of Vermont's did. The tool says which.
 */
const STATES = {
  utah:          { name: 'Utah',           at: [-111.8600, 40.7350], where: 'Salt Lake City' },
  wisconsin:     { name: 'Wisconsin',      at: [-89.3900, 43.0900],  where: 'Madison' },
  massachusetts: { name: 'Massachusetts',  at: [-71.4180, 42.2700],  where: 'Worcester' },
  montana:       { name: 'Montana',        at: [-111.0400, 45.6820], where: 'Bozeman' },
  newjersey:     { name: 'New Jersey',     at: [-74.7500, 40.2300],  where: 'Trenton' },
  maryland:      { name: 'Maryland',       at: [-76.6400, 39.3400],  where: 'Baltimore' },
  delaware:      { name: 'Delaware',       at: [-75.5500, 39.1700],  where: 'Wilmington' },
  connecticut:   { name: 'Connecticut',    at: [-72.6900, 41.7700],  where: 'Hartford' },
  rhodeisland:   { name: 'Rhode Island',   at: [-71.4300, 41.8300],  where: 'Providence' },
  tennessee:     { name: 'Tennessee',      at: [-86.8000, 36.1500],  where: 'Nashville' },
  kentucky:      { name: 'Kentucky',       at: [-84.5100, 38.0300],  where: 'Lexington' },
  newyork:       { name: 'New York',       at: [-73.7800, 42.6800],  where: 'Albany' },
  virginia:      { name: 'Virginia',       at: [-77.4700, 37.5500],  where: 'Richmond' },
  minnesota:     { name: 'Minnesota',      at: [-93.2400, 44.9600],  where: 'Minneapolis' },
  iowa:          { name: 'Iowa',           at: [-93.6500, 41.5900],  where: 'Des Moines' },
  arkansas:      { name: 'Arkansas',       at: [-92.3200, 34.7500],  where: 'Little Rock' },
  oregon:        { name: 'Oregon',         at: [-123.0300, 44.9300], where: 'Salem' },
  colorado:      { name: 'Colorado',       at: [-104.9700, 39.7200], where: 'Denver' },
  florida:       { name: 'Florida',        at: [-84.2600, 30.4500],  where: 'Tallahassee' },
  maine:         { name: 'Maine',          at: [-70.2700, 43.6700],  where: 'Portland' },
  newhampshire:  { name: 'New Hampshire',  at: [-71.5400, 43.2100],  where: 'Concord' },
  pennsylvania:  { name: 'Pennsylvania',   at: [-76.8800, 40.2700],  where: 'Harrisburg' },
  ohio:          { name: 'Ohio',           at: [-83.0100, 39.9800],  where: 'Columbus' },
  indiana:       { name: 'Indiana',        at: [-86.1500, 39.8000],  where: 'Indianapolis' },
  michigan:      { name: 'Michigan',       at: [-84.5400, 42.7400],  where: 'Lansing' },
  illinois:      { name: 'Illinois',       at: [-89.6400, 39.7900],  where: 'Springfield' },
  washington:    { name: 'Washington',     at: [-122.9000, 47.0400], where: 'Olympia' },
  idaho:         { name: 'Idaho',          at: [-116.2200, 43.6100], where: 'Boise' },
  arizona:       { name: 'Arizona',        at: [-111.9200, 33.4300], where: 'Phoenix' },
  southcarolina: { name: 'South Carolina', at: [-81.0200, 34.0300],  where: 'Columbia' },
};

const WANT = (process.env.STATES || Object.keys(STATES).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const unknown = WANT.filter((s) => !STATES[s]);
if (unknown.length) {
  console.error(`FAIL  Unknown state(s): ${unknown.join(', ')}`);
  console.error(`      Known: ${Object.keys(STATES).join(', ')}`);
  process.exit(1);
}

const TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 6;   // services to try per state before giving up
const MAX_LAYERS = 10;      // layers to try within one service

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Ask ArcGIS Online what exists, rather than asserting what does.
 *
 * Two query shapes, because state parcel layers are named inconsistently but
 * are almost always owned by an official account and tagged with the state.
 * Ranked by popularity: a statewide authoritative layer is, by a wide margin,
 * the most-viewed thing matching "<state> parcels".
 */
async function searchCatalogue(state) {
  const queries = [
    `${state.name} statewide parcels`,
    `${state.name} parcels boundaries`,
    `"${state.name}" parcels`,
  ];

  const seen = new Map();
  for (const q of queries) {
    const url = 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
      f: 'json',
      q: `${q} AND (type:"Feature Service" OR type:"Map Service")`,
      num: '15',
      sortField: 'numViews',
      sortOrder: 'desc',
    });
    const body = await getJson(url);
    for (const item of body?.results || []) {
      if (!item.url || seen.has(item.url)) continue;
      // Parcel-ish only: the search will happily return zoning and addresses.
      if (!/parcel|cadastr|taxlot|property/i.test(`${item.title} ${item.snippet || ''}`)) continue;
      seen.set(item.url, { url: item.url, title: item.title, owner: item.owner, views: item.numViews });
    }
    if (seen.size >= MAX_CANDIDATES * 2) break;
  }
  return [...seen.values()].sort((a, b) => (b.views || 0) - (a.views || 0));
}

const PIN_PATTERNS = [
  /^(parno|pin|apn|parcel_?id|pid|gpin|parcelnum|map_?id|mapid|taxid|prop_?id)$/i,
  /parcel.*(id|no|num)/i, /^(account|acct).*(no|num|id)$/i,
];
const ADDR_PATTERNS = [
  /^(siteadd|address|situs|propertyaddress|site_?addr|physaddr|full_?addr|addrgl1|prop_?addr)$/i,
  /situs.*add/i, /add(r|ress)/i,
];

const pick = (fields, patterns) => {
  for (const p of patterns) {
    const hit = fields.find((f) => p.test(f.name));
    if (hit) return hit.name;
  }
  return null;
};

/** Ask one service for a parcel at the point. Returns a finding or null. */
async function tryService(serviceUrl, [lng, lat]) {
  const meta = await getJson(`${serviceUrl}?f=json`);
  if (!meta || meta.error) return null;

  const layers = [...(meta.layers || []), ...(meta.tables || [])];
  // A layerless URL may itself be a single layer endpoint.
  const ids = layers.length ? layers.slice(0, MAX_LAYERS).map((l) => l.id) : [null];

  for (const id of ids) {
    const base = id === null ? serviceUrl : `${serviceUrl}/${id}`;
    const info = await getJson(`${base}?f=json`);
    if (!info || !/Polygon/i.test(info.geometryType || '')) continue;

    const q = `${base}/query?` + new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*', returnGeometry: 'true',
      resultRecordCount: '1', f: 'json',
    });
    const hit = await getJson(q);
    const feature = hit?.features?.[0];
    if (!feature?.geometry?.rings?.length) continue;

    const area = measure({
      type: 'Polygon',
      coordinates: feature.geometry.rings.map((r) => r.map(([x, y]) => [x, y])),
    });

    /*
     * Anything enormous is a county, a township or a right-of-way, and using
     * it would measure the wrong thing entirely. Below that, size is reported
     * rather than judged: Vermont's first hit was 16 acres of university and
     * the layer was still the right one.
     */
    if (area.squareFeet > 40_000_000) continue;

    const fields = info.fields || [];
    return {
      service: serviceUrl,
      layer: id,
      layerName: info.name || '(single layer)',
      acres: area.acres,
      squareFeet: area.squareFeet,
      pin: pick(fields, PIN_PATTERNS),
      address: pick(fields, ADDR_PATTERNS),
      sample: fields.slice(0, 6).map((f) => f.name).join(', '),
    };
  }
  return null;
}

console.log(`\nSearching ArcGIS Online for statewide parcel layers in ${WANT.length} state(s).`);
console.log('Discovered, not recalled: the previous version guessed URLs and scored 1 in 12.\n');

const findings = [];

for (const key of WANT) {
  const state = STATES[key];
  console.log('='.repeat(72));
  console.log(`${key}  —  ${state.name}, testing at ${state.where}`);

  const candidates = await searchCatalogue(state);
  if (!candidates.length) {
    console.log('  the catalogue returned nothing parcel-shaped.\n');
    findings.push({ key, state, best: null, tried: 0 });
    continue;
  }
  console.log(`  ${candidates.length} candidate(s) from the catalogue; trying up to ${MAX_CANDIDATES}.`);

  let best = null;
  let tried = 0;
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    tried++;
    const found = await tryService(c.url, state.at);
    if (!found) {
      console.log(`    ✗ ${c.title} (${c.owner})`);
      continue;
    }
    console.log(`    ✓ ${c.title} (${c.owner})`);
    console.log(`      ${found.acres} ac / ${found.squareFeet.toLocaleString()} sq ft` +
      `  layer ${found.layer ?? '—'} "${found.layerName}"`);
    console.log(`      pin: ${found.pin || '(no match)'}   address: ${found.address || '(no match)'}`);
    if (!found.pin || !found.address) console.log(`      fields: ${found.sample}`);
    best = { ...found, title: c.title, owner: c.owner };
    break;
  }

  if (!best) console.log('  nothing usable.');
  findings.push({ key, state, best, tried });
  console.log('');
}

/* ------------------------------------------------------------- the verdict */
console.log('='.repeat(72));
const usable = findings.filter((f) => f.best);
console.log(`${usable.length} of ${findings.length} states returned a parcel at a real address.\n`);

for (const f of findings) {
  const size = f.best ? `${f.best.acres} ac` : '';
  console.log(`${f.best ? 'YES ' : ' no '} ${f.key.padEnd(15)} ${f.state.name.padEnd(16)} ${size}`);
}

if (usable.length) {
  console.log('\nRegistry entries, for the ones that answered:\n');
  for (const f of usable) {
    console.log(`  ${f.key}: {`);
    console.log(`    name: '${f.state.name}',`);
    console.log('    statewide: true,');
    console.log(`    service: '${f.best.service}',`);
    if (f.best.layer !== null) console.log(`    layer: ${f.best.layer}, // ${f.best.layerName}`);
    console.log(`    fields: { pin: '${f.best.pin || 'SET_ME'}', address: '${f.best.address || 'SET_ME'}' },`);
    console.log(`    verified: 'probe', // ${f.best.acres} ac at ${f.state.where}`);
    console.log('  },');
  }
  console.log('\nEach needs a bounding box in COUNTY_BBOX and its own residential');
  console.log('test points in test-points.js before it is trusted. One parcel shows');
  console.log('the layer answers; it does not show the state is covered, and an');
  console.log('acreage far off a house means the point landed on something else.');
}
