/**
 * Look for states that publish every county's parcels from one endpoint.
 *
 * North Carolina turned out to work this way by accident: the entry here was
 * chased as "Johnston County", and the service found was NC OneMap, which is
 * the STATE republishing all hundred counties on one layer with one schema.
 * Adding the rest of North Carolina was a bounding box and nothing else. That
 * is a far better deal than the seven-counties-seven-servers arrangement the
 * rest of this registry is built on, where each one has its own host, path,
 * layer index, field names and projection, and each one goes stale separately.
 *
 * So: which other states do the same?
 *
 * EVERY ENDPOINT BELOW IS A GUESS. They are written from recollection of state
 * GIS programmes, not from a directory, and several will be wrong -- moved,
 * renamed, retired, or never having existed in that form. That is the whole
 * reason this file exists rather than a list of entries added to counties.js:
 * a plausible-looking URL that answers 404 is easy to spot, and a
 * plausible-looking URL that answers with the WRONG THING is not. So each one
 * is asked what it is, and then asked for a real parcel at a real address.
 *
 * A candidate only earns a place in the registry if it:
 *   - answers as an ArcGIS service at all
 *   - has a layer whose geometry is polygons
 *   - returns ONE parcel-sized polygon for a point at a known house
 *   - and names the fields we need to show a PIN and an address
 *
 * Anything less is reported as what it actually did, not rounded up.
 *
 * Free: metadata reads and a handful of point queries, no imagery, no AI.
 *
 *   node tools/probe-statewide.js
 *   STATES=utah,montana node tools/probe-statewide.js
 */

import { measure } from '../public/lib/area.js';

/*
 * Candidate statewide parcel services, and a point that should land on a
 * house in that state.
 *
 * The test point matters as much as the URL: a service can be perfectly alive
 * and simply have no parcel where you asked, and "no parcel at this spot" and
 * "this service is not what I thought" look identical from one failed query.
 * Points are in ordinary residential streets, chosen well inside a town.
 */
const CANDIDATES = {
  montana: {
    label: 'Montana — MSL Cadastral',
    services: [
      'https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer',
      'https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/MontanaCadastral_Parcels/FeatureServer',
    ],
    at: { lng: -111.0329, lat: 45.6770, where: 'Bozeman' },
  },
  utah: {
    label: 'Utah — UGRC statewide parcels',
    services: [
      'https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer',
      'https://gis.utah.gov/arcgis/rest/services/Parcels/MapServer',
    ],
    at: { lng: -111.8910, lat: 40.7100, where: 'Salt Lake City' },
  },
  wisconsin: {
    label: 'Wisconsin — Statewide Parcel Map Initiative',
    services: [
      'https://services5.arcgis.com/8W7CTqLZBUyMxkxD/arcgis/rest/services/Parcels_Statewide/FeatureServer',
      'https://mapservices.legis.wisconsin.gov/arcgis/rest/services/Parcels/MapServer',
    ],
    at: { lng: -89.4012, lat: 43.0731, where: 'Madison' },
  },
  massachusetts: {
    label: 'Massachusetts — MassGIS standardised parcels',
    services: [
      'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/L3Parcels/MapServer',
      'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/L3_TAXPAR_POLY_ASSESS/FeatureServer',
    ],
    at: { lng: -71.4128, lat: 42.2626, where: 'Worcester' },
  },
  newjersey: {
    label: 'New Jersey — NJGIN parcels',
    services: [
      'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_of_NJ/FeatureServer',
      'https://mapsdep.nj.gov/arcgis/rest/services/Framework/Parcels_Composite/MapServer',
    ],
    at: { lng: -74.7429, lat: 40.2206, where: 'Trenton' },
  },
  vermont: {
    label: 'Vermont — VCGI statewide parcels',
    services: [
      'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer',
      'https://maps.vcgi.vermont.gov/arcgis/rest/services/EGC_services/OPENDATA_VCGI_CADASTRAL_SP_NOCACHE_v1/MapServer',
    ],
    at: { lng: -73.2121, lat: 44.4759, where: 'Burlington' },
  },
  maryland: {
    label: 'Maryland — MD iMAP parcels',
    services: [
      'https://geodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer',
      'https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/MD_Parcels/FeatureServer',
    ],
    at: { lng: -76.6122, lat: 39.2904, where: 'Baltimore' },
  },
  delaware: {
    label: 'Delaware — FirstMap',
    services: [
      'https://firstmap.delaware.gov/arcgis/rest/services/Society/DE_Parcels/MapServer',
      'https://enterprise.firstmap.delaware.gov/arcgis/rest/services/Society/DE_Parcels/MapServer',
    ],
    at: { lng: -75.5244, lat: 39.1582, where: 'Wilmington' },
  },
  connecticut: {
    label: 'Connecticut — CT parcels',
    services: [
      'https://services1.arcgis.com/FCaUeJ5SOVtImake/arcgis/rest/services/CT_Parcels/FeatureServer',
      'https://gis.ct.gov/arcgis/rest/services/Parcels/MapServer',
    ],
    at: { lng: -72.6851, lat: 41.7658, where: 'Hartford' },
  },
  rhodeisland: {
    label: 'Rhode Island — RIGIS',
    services: [
      'https://services2.arcgis.com/S8zZg9pg23JUEexQ/arcgis/rest/services/Parcels_2022/FeatureServer',
      'https://services1.arcgis.com/dUFHqfyBWTVMcnHz/arcgis/rest/services/Parcels/FeatureServer',
    ],
    at: { lng: -71.4128, lat: 41.8240, where: 'Providence' },
  },
  tennessee: {
    label: 'Tennessee — TN parcels',
    services: [
      'https://tnmap.tn.gov/arcgis/rest/services/BASEMAPS/Parcels/MapServer',
      'https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Parcels/FeatureServer',
    ],
    at: { lng: -86.7816, lat: 36.1627, where: 'Nashville' },
  },
  kentucky: {
    label: 'Kentucky — KyFromAbove parcels',
    services: [
      'https://services1.arcgis.com/79kfd2K6fskCAkyg/arcgis/rest/services/Kentucky_Parcels/FeatureServer',
      'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Parcels_WGS84WM/MapServer',
    ],
    at: { lng: -84.5037, lat: 38.0406, where: 'Lexington' },
  },
};

const WANT = (process.env.STATES || Object.keys(CANDIDATES).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const unknown = WANT.filter((s) => !CANDIDATES[s]);
if (unknown.length) {
  console.error(`FAIL  Unknown state(s): ${unknown.join(', ')}`);
  console.error(`      Known: ${Object.keys(CANDIDATES).join(', ')}`);
  process.exit(1);
}

const TIMEOUT_MS = 20000;

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, body: null, text: text.slice(0, 120) }; }
  } catch (e) {
    return { ok: false, status: 0, body: null, text: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* The field names this app needs, in the shapes states actually use. */
const PIN_PATTERNS = [/^(parno|pin|apn|parcel_?id|pid|gpin|parcelnum|map_?id)$/i, /parcel.*(id|no|num)/i];
const ADDR_PATTERNS = [/^(siteadd|address|situs|propertyaddress|site_?addr|physaddr|full_?addr)$/i, /add(r|ress)/i];

const pick = (fields, patterns) => {
  for (const p of patterns) {
    const hit = fields.find((f) => p.test(f.name));
    if (hit) return hit.name;
  }
  return null;
};

console.log(`\nProbing ${WANT.length} candidate statewide parcel service(s).`);
console.log('Every URL here is a guess from recollection; this is what settles it.\n');

const findings = [];

for (const key of WANT) {
  const c = CANDIDATES[key];
  console.log('='.repeat(72));
  console.log(`${key}  —  ${c.label}`);
  console.log(`  test point: ${c.at.where} (${c.at.lat}, ${c.at.lng})`);

  let best = null;

  for (const service of c.services) {
    const host = new URL(service).host;
    const meta = await getJson(`${service}?f=json`);
    if (!meta.body) {
      console.log(`  ✗ ${host} — ${meta.status ? `HTTP ${meta.status}` : meta.text}`);
      continue;
    }
    if (meta.body.error) {
      console.log(`  ✗ ${host} — ${meta.body.error.message || 'error'}`);
      continue;
    }

    const layers = [...(meta.body.layers || []), ...(meta.body.tables || [])];
    console.log(`  · ${host} — answers, ${layers.length} layer(s)`);

    /* Try each polygon-ish layer until one returns a parcel at the point. */
    for (const layer of layers.slice(0, 12)) {
      const info = await getJson(`${service}/${layer.id}?f=json`);
      const geom = info.body?.geometryType || '';
      if (!/Polygon/i.test(geom)) continue;

      const q = `${service}/${layer.id}/query?` + new URLSearchParams({
        geometry: `${c.at.lng},${c.at.lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        outSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'true',
        resultRecordCount: '1',
        f: 'json',
      });

      const hit = await getJson(q);
      const feature = hit.body?.features?.[0];
      if (!feature?.geometry?.rings?.length) continue;

      // Same area maths the app measures with, so the number here is the
      // number a user would see rather than a different approximation.
      const geojson = {
        type: 'Polygon',
        coordinates: feature.geometry.rings.map((r) => r.map(([x, y]) => [x, y])),
      };
      const a = measure(geojson);
      const fields = info.body.fields || [];
      const pin = pick(fields, PIN_PATTERNS);
      const address = pick(fields, ADDR_PATTERNS);

      console.log(`    ✓ layer ${layer.id} "${layer.name}" — ${a.squareFeet.toLocaleString()} sq ft ` +
        `(${a.acres} ac)`);
      console.log(`      pin field: ${pin || '(none matched)'}   address field: ${address || '(none matched)'}`);

      /*
       * Sanity, not just success. A statewide layer can answer with a whole
       * municipality or a census block and it looks exactly like a parcel from
       * here -- one polygon, plenty of fields.
       */
      const sane = a.squareFeet > 400 && a.squareFeet < 4_000_000;
      if (!sane) {
        console.log(`      REJECT — ${a.acres} ac is not a residential parcel; wrong layer.`);
        continue;
      }

      best = { service, layer: layer.id, layerName: layer.name, pin, address, acres: a.acres };
      break;
    }

    if (best) break;
  }

  if (best) {
    console.log(`  USABLE: ${best.service}`);
    console.log(`           layer ${best.layer} (${best.layerName}), ${best.acres} ac at ${c.at.where}`);
    if (!best.pin || !best.address) {
      console.log('           NOTE: a field name did not match — set it by hand in counties.js.');
    }
  } else {
    console.log('  nothing usable at either URL.');
  }
  findings.push({ key, label: c.label, best });
  console.log('');
}

/* ------------------------------------------------------------- the verdict */
console.log('='.repeat(72));
const usable = findings.filter((f) => f.best);
console.log(`${usable.length} of ${findings.length} candidates returned a real parcel.\n`);

for (const f of findings) {
  console.log(`${f.best ? 'YES ' : ' no '} ${f.key.padEnd(15)} ${f.label}`);
}

if (usable.length) {
  console.log('\nRegistry entries for the ones that worked:\n');
  for (const f of usable) {
    console.log(`  ${f.key}: {`);
    console.log(`    name: '${f.label.split('—')[0].trim()}',`);
    console.log('    statewide: true,');
    console.log(`    service: '${f.best.service}',`);
    console.log(`    layer: ${f.best.layer}, // ${f.best.layerName}`);
    console.log(`    fields: { pin: '${f.best.pin || 'SET_ME'}', address: '${f.best.address || 'SET_ME'}' },`);
    console.log(`    verified: 'live', // ${f.best.acres} ac`);
    console.log('  },');
  }
  console.log('\nEach still needs a bounding box in COUNTY_BBOX, and a second');
  console.log('test point somewhere else in the state before it is trusted:');
  console.log('one parcel proves the service answers, not that it covers.');
}
