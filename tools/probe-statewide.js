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
 * AND THEN THE SEARCH VERSION FOUND TEN STATES, MOST OF THEM COUNTIES.
 *
 * Asking at one point per state let any county service covering that state's
 * capital pass as statewide. It "found" Ohio at gis.franklincountyohio.gov --
 * Columbus is in Franklin County. Florida at leoncountyfl.gov; Tallahassee is
 * in Leon County. Arizona at gis.maricopa.gov; Phoenix is in Maricopa. Each
 * returned a house-sized parcel at the address it was asked about and would
 * have returned nothing for most of the state.
 *
 * So every candidate is now asked at TWO points a long way apart -- a capital
 * and a city at the other end of the state -- and has to answer at both. That
 * is the difference between a county service and a statewide one, and it
 * cannot be seen from a single query however carefully the result is measured.
 * Oregon's "hit" was also a Public Land Survey section grid at 625 acres,
 * which is why the acreage of both points is printed rather than summarised.
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
  utah: { name: 'Utah',
    at: [-111.86, 40.735], where: 'Salt Lake City',
    far: [-113.583, 37.105], farWhere: 'St George' },
  wisconsin: { name: 'Wisconsin',
    at: [-89.39, 43.09], where: 'Madison',
    far: [-87.91, 44.87], farWhere: 'Green Bay' },
  massachusetts: { name: 'Massachusetts',
    at: [-71.418, 42.27], where: 'Worcester',
    far: [-70.93, 42.53], farWhere: 'Salem' },
  montana: { name: 'Montana',
    at: [-111.04, 45.682], where: 'Bozeman',
    far: [-104.52, 47.1], farWhere: 'Glendive' },
  newjersey: { name: 'New Jersey',
    at: [-74.75, 40.23], where: 'Trenton',
    far: [-74.43, 39.36], farWhere: 'Atlantic City' },
  maryland: { name: 'Maryland',
    at: [-76.64, 39.34], where: 'Baltimore',
    far: [-79.41, 39.41], farWhere: 'Oakland' },
  delaware: { name: 'Delaware',
    at: [-75.55, 39.17], where: 'Wilmington',
    far: [-75.39, 38.69], farWhere: 'Georgetown' },
  connecticut: { name: 'Connecticut',
    at: [-72.69, 41.77], where: 'Hartford',
    far: [-71.98, 41.4], farWhere: 'Stonington' },
  rhodeisland: { name: 'Rhode Island',
    at: [-71.43, 41.83], where: 'Providence',
    far: [-71.52, 41.7], farWhere: 'West Warwick' },
  tennessee: { name: 'Tennessee',
    at: [-86.8, 36.15], where: 'Nashville',
    far: [-89.97, 35.13], farWhere: 'Memphis' },
  kentucky: { name: 'Kentucky',
    at: [-84.51, 38.03], where: 'Lexington',
    far: [-88.32, 36.61], farWhere: 'Murray' },
  newyork: { name: 'New York',
    at: [-73.78, 42.68], where: 'Albany',
    far: [-78.86, 42.9], farWhere: 'Buffalo' },
  virginia: { name: 'Virginia',
    at: [-77.47, 37.55], where: 'Richmond',
    far: [-81.97, 36.71], farWhere: 'Abingdon' },
  minnesota: { name: 'Minnesota',
    at: [-93.24, 44.96], where: 'Minneapolis',
    far: [-92.1, 46.78], farWhere: 'Duluth' },
  iowa: { name: 'Iowa',
    at: [-93.65, 41.59], where: 'Des Moines',
    far: [-96.4, 42.5], farWhere: 'Sioux City' },
  arkansas: { name: 'Arkansas',
    at: [-92.32, 34.75], where: 'Little Rock',
    far: [-94.21, 36.33], farWhere: 'Bentonville' },
  oregon: { name: 'Oregon',
    at: [-123.03, 44.93], where: 'Salem',
    far: [-117.83, 44.77], farWhere: 'Baker City' },
  colorado: { name: 'Colorado',
    at: [-104.97, 39.72], where: 'Denver',
    far: [-107.88, 38.47], farWhere: 'Montrose' },
  florida: { name: 'Florida',
    at: [-84.26, 30.45], where: 'Tallahassee',
    far: [-80.14, 26.12], farWhere: 'Fort Lauderdale' },
  maine: { name: 'Maine',
    at: [-70.27, 43.67], where: 'Portland',
    far: [-68.77, 44.8], farWhere: 'Bangor' },
  newhampshire: { name: 'New Hampshire',
    at: [-71.54, 43.21], where: 'Concord',
    far: [-71.17, 44.47], farWhere: 'Berlin' },
  pennsylvania: { name: 'Pennsylvania',
    at: [-76.88, 40.27], where: 'Harrisburg',
    far: [-80.0, 40.44], farWhere: 'Pittsburgh' },
  ohio: { name: 'Ohio',
    at: [-83.01, 39.98], where: 'Columbus',
    far: [-81.69, 41.48], farWhere: 'Cleveland' },
  indiana: { name: 'Indiana',
    at: [-86.15, 39.8], where: 'Indianapolis',
    far: [-87.55, 37.97], farWhere: 'Evansville' },
  michigan: { name: 'Michigan',
    at: [-84.54, 42.74], where: 'Lansing',
    far: [-84.34, 46.49], farWhere: 'Sault Ste Marie' },
  illinois: { name: 'Illinois',
    at: [-89.64, 39.79], where: 'Springfield',
    far: [-87.68, 41.88], farWhere: 'Chicago' },
  washington: { name: 'Washington',
    at: [-122.9, 47.04], where: 'Olympia',
    far: [-117.41, 47.66], farWhere: 'Spokane' },
  idaho: { name: 'Idaho',
    at: [-116.22, 43.61], where: 'Boise',
    far: [-116.78, 47.68], farWhere: 'Coeur d Alene' },
  arizona: { name: 'Arizona',
    at: [-111.92, 33.43], where: 'Phoenix',
    far: [-110.95, 32.22], farWhere: 'Tucson' },
  southcarolina: { name: 'South Carolina',
    at: [-81.02, 34.03], where: 'Columbia',
    far: [-79.94, 32.8], farWhere: 'Charleston' },
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

/** Query one layer at one point. Returns the parcel found, or null. */
async function queryPoint(base, [lng, lat]) {
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
  if (!feature?.geometry?.rings?.length) return null;
  return measure({
    type: 'Polygon',
    coordinates: feature.geometry.rings.map((r) => r.map(([x, y]) => [x, y])),
  });
}

/**
 * Ask one service for a parcel at BOTH points. Returns a finding or null.
 *
 * Both, because one is what a county service passes.
 */
async function tryService(serviceUrl, state) {
  const meta = await getJson(`${serviceUrl}?f=json`);
  if (!meta || meta.error) return null;

  const layers = [...(meta.layers || []), ...(meta.tables || [])];
  // A layerless URL may itself be a single layer endpoint.
  const ids = layers.length ? layers.slice(0, MAX_LAYERS).map((l) => l.id) : [null];

  for (const id of ids) {
    const base = id === null ? serviceUrl : `${serviceUrl}/${id}`;
    const info = await getJson(`${base}?f=json`);
    if (!info || !/Polygon/i.test(info.geometryType || '')) continue;

    const near = await queryPoint(base, state.at);
    if (!near) continue;

    /*
     * Anything enormous is a county, a township or a right-of-way, and using
     * it would measure the wrong thing entirely. Below that, size is reported
     * rather than judged: Vermont's first hit was 16 acres of university and
     * the layer was still the right one.
     */
    if (near.squareFeet > 40_000_000) continue;

    // THE STATEWIDE TEST. A county service answers at its own county seat and
    // nowhere else, and looks identical to a state one until you ask.
    const far = await queryPoint(base, state.far);
    if (!far) {
      console.log(`      · answered at ${state.where} but NOT at ${state.farWhere}` +
        ' — a county service, not a statewide one');
      continue;
    }

    /*
     * A survey grid, not parcels.
     *
     * The two-point test removed the county services and let a new impostor
     * through: Utah, Montana, Oregon and Arizona all "answered" at both ends
     * of the state with 616 to 656 acres. That is one square mile -- a Public
     * Land Survey section -- and a section grid is statewide, consistent, and
     * has nothing to do with who owns what.
     *
     * Real parcels vary wildly between two random addresses; a grid does not.
     * So near-equal areas that are both far too big for any lot is the
     * signature, and it is a shape no amount of measuring ONE polygon can see.
     */
    const ratio = Math.min(near.acres, far.acres) / Math.max(near.acres, far.acres);
    if (ratio > 0.85 && Math.min(near.acres, far.acres) > 100) {
      console.log(`      · ${near.acres} ac and ${far.acres} ac -- near-identical and huge:` +
        ' a survey section grid, not parcels');
      continue;
    }

    const fields = info.fields || [];
    return {
      service: serviceUrl,
      layer: id,
      layerName: info.name || '(single layer)',
      acres: near.acres,
      farAcres: far.acres,
      squareFeet: near.squareFeet,
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
  console.log(`${key}  —  ${state.name}: must answer at ${state.where} AND ${state.farWhere}`);

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
    const found = await tryService(c.url, state);
    if (!found) {
      console.log(`    ✗ ${c.title} (${c.owner})`);
      continue;
    }
    console.log(`    ✓ ${c.title} (${c.owner})`);
    console.log(`      ${state.where}: ${found.acres} ac` +
      `   ${state.farWhere}: ${found.farAcres} ac` +
      `   layer ${found.layer ?? '—'} "${found.layerName}"`);
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
console.log(`${usable.length} of ${findings.length} states answered at BOTH ends of the state.\n`);

for (const f of findings) {
  if (!f.best) { console.log(` no  ${f.key.padEnd(15)} ${f.state.name}`); continue; }
  /*
   * "Answered twice" is not the same as "these are houses". A layer where
   * neither point looks like a lot may still be parcels badly aimed at, as
   * Vermont was -- so it is reported as needing a look rather than either
   * claimed or discarded.
   */
  const houseLike = Math.min(f.best.acres, f.best.farAcres) < 5;
  console.log(`${houseLike ? 'YES ' : ' ?  '} ${f.key.padEnd(15)} ${f.state.name.padEnd(16)}` +
    ` ${f.best.acres} ac / ${f.best.farAcres} ac${houseLike ? '' : '   neither looks like a lot'}`);
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
    console.log(`    verified: 'probe', // ${f.best.acres} ac at ${f.state.where}, ${f.best.farAcres} ac at ${f.state.farWhere}`);
    console.log('  },');
  }
  console.log('\nEach needs a bounding box in COUNTY_BBOX and its own residential');
  console.log('test points in test-points.js before it is trusted. One parcel shows');
  console.log('the layer answers; it does not show the state is covered, and an');
  console.log('acreage far off a house means the point landed on something else.');
}
