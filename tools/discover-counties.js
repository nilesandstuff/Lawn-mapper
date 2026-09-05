/**
 * Finds the county parcel services, rather than assuming them.
 *
 * probe-counties.js answers "is the configured endpoint still right?". When
 * the answer is no -- as it was for all four counties -- it cannot tell you
 * what the right one is. This does that: it walks each county's ArcGIS
 * services directory, finds services and layers that look like parcels,
 * queries each candidate with a real point, and prints a config block for
 * whichever actually returns a parcel.
 *
 * Needs internet, so it runs on a GitHub Actions runner:
 *   Actions -> "3. Find county servers" -> Run workflow
 *
 * It only issues read-only GETs against public services, at a deliberately
 * gentle rate -- these are small public assets, not something to hammer.
 */

import { COUNTIES } from '../worker/src/counties.js';
import { esriToGeoJSON } from '../worker/src/parcel.js';
import { measure } from '../public/lib/area.js';

const TIMEOUT_MS = 12000;
const MAX_SERVICES_PER_ROOT = 8;
const MAX_LAYERS_PER_SERVICE = 8;

/** A known point inside each county, used to prove a layer really answers. */
const TEST_POINTS = {
  kent: { lng: -85.6681, lat: 42.9634, label: 'Grand Rapids' },
  ottawa: { lng: -86.1089, lat: 42.7875, label: 'Holland' },
  allegan: { lng: -85.8556, lat: 42.5292, label: 'Allegan' },
  muskegon: { lng: -86.2484, lat: 43.2342, label: 'Muskegon' },
  newaygo: { lng: -85.8003, lat: 43.4197, label: 'Fremont' },
};

/**
 * Where to look. The configured host comes first; the rest are the usual
 * places a county moves its GIS to (a rebrand to the county's public domain,
 * or a switch between ArcGIS Server layouts).
 */
const CANDIDATE_ROOTS = {
  kent: [
    'https://gis.kentcountymi.gov/arcgis/rest/services',
    'https://gis.kentcountymi.gov/server/rest/services',
    'https://maps.kentcountymi.gov/arcgis/rest/services',
    'https://gisapps.kentcountymi.gov/arcgis/rest/services',
    'https://services.kentcountymi.gov/arcgis/rest/services',
  ],
  ottawa: [
    'https://gis.miottawa.org/arcgis/rest/services',
    'https://gis.miottawa.org/server/rest/services',
    'https://maps.miottawa.org/arcgis/rest/services',
    'https://gis.co.ottawa.mi.us/arcgis/rest/services',
    'https://gis.co.ottawa.mi.us/gisweb/rest/services',
  ],
  allegan: [
    'https://gis.allegancounty.org/server/rest/services',
    'https://gis.allegancounty.org/arcgis/rest/services',
    'https://maps.allegancounty.org/arcgis/rest/services',
  ],
  muskegon: [
    'https://maps.muskegoncountygis.com/arcgis/rest/services',
    'https://gis.co.muskegon.mi.us/arcgis/rest/services',
  ],
  newaygo: [
    'https://gis.countyofnewaygo.com/arcgis/rest/services',
    'https://maps.countyofnewaygo.com/arcgis/rest/services',
    'https://services.arcgis.com/newaygo/arcgis/rest/services',
  ],
};

const PARCEL_NAME = /parcel|propert|cadastr|landbase|tax.?map|assessor/i;
const PIN_FIELD = /^(pin|parcel|pnum|prop|apn|pid)/i;
const ADDR_FIELD = /(site.?addr|prop.*addr|full.?addr|^address$|addr.*combined|situs)/i;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    // ArcGIS answers a bad path with an HTML error page and a 200.
    if (/^\s*</.test(text)) return { error: 'returned HTML, not JSON' };
    try {
      return JSON.parse(text);
    } catch {
      return { error: 'unparseable response' };
    }
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** ArcGIS reports failures as an object; render it as something readable. */
const describe = (err) =>
  typeof err === 'string' ? err : err?.message || JSON.stringify(err).slice(0, 160);

/** Every service under a root, following one level of folders. */
async function listServices(root) {
  const top = await getJson(`${root}?f=json`);
  if (top.error) return { error: top.error };

  const services = [...(top.services || [])];
  for (const folder of (top.folders || []).slice(0, 12)) {
    const sub = await getJson(`${root}/${folder}?f=json`);
    if (!sub.error) services.push(...(sub.services || []));
  }
  // Names already carry their folder ("Hosted/Parcels"); de-duplicate, since
  // a service listed at the root can reappear in its folder listing.
  const seen = new Set();
  return {
    services: services.filter((s) => {
      const key = `${s.name}/${s.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/**
 * Ask ArcGIS Online for a county's parcel layer.
 *
 * Counties increasingly publish to ArcGIS Online rather than running their own
 * server, in which case there is no county-hosted directory left to walk --
 * which is exactly what Kent's 404 looks like. This searches the public
 * catalogue instead.
 */
async function searchArcGISOnline(countyName) {
  const q = `${countyName} Michigan parcels`;
  const url =
    'https://www.arcgis.com/sharing/rest/search?' +
    new URLSearchParams({
      q,
      f: 'json',
      num: '20',
      sortField: 'numviews',
      sortOrder: 'desc',
    });
  const data = await getJson(url);
  if (data.error || !data.results) return [];

  return data.results
    .filter((r) => /Feature Service|Map Service/i.test(r.type) && r.url)
    .filter((r) => PARCEL_NAME.test(r.title) || PARCEL_NAME.test(r.snippet || ''))
    .slice(0, 6)
    .map((r) => ({ url: r.url.replace(/\/$/, ''), title: r.title, owner: r.owner }));
}

/** Point-in-polygon query against one layer. */
async function queryLayer(serviceUrl, layerId, point) {
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: point.lng, y: point.lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    geometryPrecision: '8',
    resultRecordCount: '1',
  });
  return getJson(`${serviceUrl}/${layerId}/query?${params}`);
}

function summarise(attrs) {
  const names = Object.keys(attrs);
  return {
    pin: names.find((n) => PIN_FIELD.test(n)) || null,
    address: names.find((n) => ADDR_FIELD.test(n)) || null,
    names,
  };
}

/** Test every plausible layer of one service. Returns true on a match. */
async function tryService(key, serviceUrl, label, point) {
  const meta = await getJson(`${serviceUrl}?f=json`);
  if (meta.error) {
    console.log(`      ✗ ${label} -- ${describe(meta.error)}`);
    return false;
  }

  // A FeatureServer with a single layer often omits the list; /0 is the layer.
  const layers = meta.layers || (meta.type === 'Feature Layer' ? [{ id: 0, name: meta.name }] : []);
  if (!layers.length) {
    console.log(`      ✗ ${label} -- no layers`);
    return false;
  }

  const named = layers.filter((l) => PARCEL_NAME.test(l.name));
  const tryThese = (named.length ? named : layers).slice(0, MAX_LAYERS_PER_SERVICE);
  console.log(`      → ${label}: ${layers.length} layers, testing ${tryThese.length}`);

  for (const layer of tryThese) {
    const result = await queryLayer(serviceUrl, layer.id, point);

    // Report why a layer did not answer -- silence here is what made the last
    // run impossible to act on.
    if (result.error) {
      console.log(`         [${layer.id}] ${layer.name}: ${describe(result.error)}`);
      continue;
    }
    if (!result.features?.length) {
      console.log(`         [${layer.id}] ${layer.name}: 0 features at the test point`);
      continue;
    }

    const feature = result.features[0];
    const geometry = esriToGeoJSON(feature.geometry);
    if (!geometry) {
      console.log(`         [${layer.id}] ${layer.name}: no usable geometry`);
      continue;
    }

    const area = measure(geometry);
    if (area.acres <= 0 || area.acres > 2000) {
      console.log(`         [${layer.id}] ${layer.name}: implausible area ${area.acres} ac -- skipped`);
      continue;
    }

    const f = summarise(feature.attributes || {});
    console.log(`\n         *** MATCH ***`);
    console.log(`         [${layer.id}] ${layer.name}`);
    console.log(`         area: ${area.acres} ac / ${area.squareFeet.toLocaleString()} sq ft`);
    console.log(`         pin field:     ${f.pin} = ${feature.attributes[f.pin]}`);
    console.log(`         address field: ${f.address} = ${feature.attributes[f.address]}`);
    console.log(`\n         Paste into worker/src/counties.js:`);
    console.log(`           ${key}: {`);
    console.log(`             name: '${COUNTIES[key]?.name || key}',`);
    console.log(`             fips: '${COUNTIES[key]?.fips || ''}',`);
    console.log(`             service: '${serviceUrl}',`);
    console.log(`             layer: ${layer.id},`);
    console.log(`             fields: { pin: '${f.pin}', address: '${f.address}' },`);
    console.log(`             verified: 'live',`);
    console.log(`           },`);
    console.log(`         all fields: ${f.names.slice(0, 30).join(', ')}\n`);
    return true;
  }
  return false;
}

async function investigate(key) {
  const point = TEST_POINTS[key];
  console.log(`\n${'='.repeat(66)}\n${COUNTIES[key]?.name || key}  (test point: ${point.label})\n${'='.repeat(66)}`);

  for (const root of CANDIDATE_ROOTS[key] || []) {
    const { services, error } = await listServices(root);
    if (error) {
      console.log(`  ✗ ${root}\n      ${describe(error)}`);
      continue;
    }

    console.log(`  ✓ ${root}\n      ${services.length} services published`);

    const candidates = services
      .filter((s) => PARCEL_NAME.test(s.name) && /MapServer|FeatureServer/.test(s.type))
      .slice(0, MAX_SERVICES_PER_ROOT);

    if (!candidates.length) {
      const sample = services.slice(0, 12).map((s) => s.name).join(', ');
      console.log(`      no parcel-ish service names. First few: ${sample}`);
      continue;
    }

    for (const svc of candidates) {
      // svc.name already carries any folder ("Hosted/Parcels"). Stripping it
      // produced a URL missing the folder, which is why every hosted service
      // failed on the previous run.
      const serviceUrl = `${root}/${svc.name}/${svc.type}`;
      if (await tryService(key, serviceUrl, `${svc.name} (${svc.type})`, point)) return true;
    }
  }

  // Nothing county-hosted answered; try the public ArcGIS Online catalogue.
  console.log(`\n  Searching ArcGIS Online for "${COUNTIES[key]?.name || key}"…`);
  const hosted = await searchArcGISOnline((COUNTIES[key]?.name || key).replace(/ County$/, ''));
  if (!hosted.length) console.log('      no candidates found');

  for (const item of hosted) {
    if (await tryService(key, item.url, `${item.title} [${item.owner}]`, point)) return true;
  }

  console.log(`  → nothing worked for ${key}.`);
  return false;
}

const only = process.argv[2];
const keys = only ? [only] : Object.keys(CANDIDATE_ROOTS);
const found = [];

for (const key of keys) {
  if (await investigate(key)) found.push(key);
}

console.log(`\n${'='.repeat(66)}`);
console.log(`Working parcel sources found for: ${found.length ? found.join(', ') : '(none)'}`);
console.log(`No source for: ${keys.filter((k) => !found.includes(k)).join(', ') || '(none)'}`);
console.log(`${'='.repeat(66)}\n`);
