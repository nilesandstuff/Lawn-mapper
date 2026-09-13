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
import { TEST_POINTS } from './test-points.js';

const TIMEOUT_MS = 12000;
const MAX_SERVICES_PER_ROOT = 8;
const MAX_LAYERS_PER_SERVICE = 8;

/** Archive and roll layers answer queries but are not the current parcel map. */
const ARCHIVE_NAME = /historic|archive|assessment roll|\b(19|20)\d{2}\b|previous|old/i;

/**
 * A residential or small rural parcel. The old bound of 2000 acres let an
 * 85-acre polygon from a historic layer pass as a match.
 */
const PLAUSIBLE_ACRES = { min: 0.01, max: 160 };

/**
 * Where to look. The configured host comes first; the rest are the usual
 * places a county moves its GIS to (a rebrand to the county's public domain,
 * or a switch between ArcGIS Server layouts).
 */
/**
 * Which state each county is in, for the ArcGIS Online catalogue search.
 *
 * The coverage area started as West Michigan and the search string said so.
 * Searching "washoe Michigan parcels" would find nothing and report the county
 * dead, which is a confident wrong answer -- the worst kind from a tool whose
 * whole job is telling you whether an endpoint exists.
 */
const STATES = {
  washoe: 'Nevada',
  northcarolina: 'North Carolina',
  champaign: 'Illinois',
  // Named although Michigan is the fallback, because a reader checking why
  // Wayne searched Michigan should find the answer here rather than infer it
  // from an absence.
  wayne: 'Michigan',
};

const CANDIDATE_ROOTS = {
  /*
   * North Carolina, statewide, through NC OneMap.
   *
   * This began as a hunt for Johnston County's own server and never found one
   * -- gis.johnstonnc.com and its variants all failed. What answered was the
   * state, republishing every county's parcels on one layer, and that is what
   * ships. The county roots are gone from this list because they were never
   * the thing that worked, and leaving them would send the next person looking
   * down the road that already turned out to be a dead end.
   */
  northcarolina: [
    'https://services.nconemap.gov/secure/rest/services',
    'https://services.nconemap.gov/arcgis/rest/services',
    'https://nconemap.gov/arcgis/rest/services',
  ],

  /*
   * Washoe County, Nevada -- Reno and Sparks. The first county outside
   * Michigan, so nothing here can be assumed from the others.
   *
   * Both instance names are tried on every host after Kent, whose server ran
   * under "agisprod" and was written off as non-existent for weeks because
   * only "arcgis" and "server" were guessed.
   */
  washoe: [
    'https://gis.washoecounty.gov/arcgis/rest/services',
    'https://gis.washoecounty.gov/server/rest/services',
    'https://gisweb.washoecounty.gov/arcgis/rest/services',
    'https://maps.washoecounty.gov/arcgis/rest/services',
    'https://arcgis.washoecounty.gov/arcgis/rest/services',
    'https://gis.washoecounty.us/arcgis/rest/services',
    // Reno and Sparks run their own GIS; a city server may publish the county
    // parcel layer even when the county's own directory is closed.
    'https://gis.reno.gov/arcgis/rest/services',
    'https://maps.cityofsparks.us/arcgis/rest/services',
  ],
  kent: [
    // Kent runs its ArcGIS Server under a non-standard instance name. No
    // amount of guessing finds "agisprod" -- the convention is "arcgis" or
    // "server" -- which is why every earlier search reported Kent dead. A
    // person spotted it in a browser; the lesson is that this list is a
    // shortcut, not a substitute for looking.
    'https://gis.kentcountymi.gov/agisprod/rest/services',
    'https://gis.kentcountymi.gov/agistest/rest/services',
    'https://gis.kentcountymi.gov/arcgis/rest/services',
    'https://gis.kentcountymi.gov/server/rest/services',
    'https://maps.kentcountymi.gov/arcgis/rest/services',
    'https://gisapps.kentcountymi.gov/arcgis/rest/services',
    'https://services.kentcountymi.gov/arcgis/rest/services',
    // Kent runs its public property lookup under accesskent.com, so its GIS
    // may have moved there along with everything else.
    'https://gis.accesskent.com/arcgis/rest/services',
    'https://maps.accesskent.com/arcgis/rest/services',
    'https://www.accesskent.com/arcgis/rest/services',
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
    // "hosting" -- a third non-standard instance name, after Kent's "agisprod"
    // and Washoe's move to a "gisweb" host. Three counties, three conventions,
    // none of them the documented one. Found by a person, again.
    'https://arcgisweb.countyofnewaygo.com/hosting/rest/services',
    'https://arcgisweb.countyofnewaygo.com/arcgis/rest/services',
    'https://gis.countyofnewaygo.com/arcgis/rest/services',
    'https://maps.countyofnewaygo.com/arcgis/rest/services',
    'https://services.arcgis.com/newaygo/arcgis/rest/services',
  ],

  /*
   * Wayne County, Michigan -- Detroit, Dearborn, Livonia. By far the largest
   * population this project has tried to cover: about 1.7 million people.
   *
   * EVERY URL BELOW IS A GUESS, in the same sense as every other list here:
   * the convention, tried on the hosts a county of this size plausibly uses.
   * Three of the seven counties already here turned out to use a host or an
   * instance name nobody would have guessed, so the catalogue search at the
   * end of investigate() is the likelier finder, not this list.
   *
   * Detroit is included as its own root because it runs a substantial open
   * data GIS of its own and holds a third of the county's parcels. A city
   * layer covering only Detroit would still be worth having -- it would just
   * need saying so in the entry, rather than being filed as "Wayne County".
   *
   * SEMCOG is the regional planning agency for the seven-county Detroit area
   * and republishes member data, which is the same shape as NC OneMap: one
   * layer standing in for many assessors.
   */
  wayne: [
    'https://gis.waynecounty.com/arcgis/rest/services',
    'https://gis.waynecounty.com/server/rest/services',
    'https://maps.waynecounty.com/arcgis/rest/services',
    'https://gisapps.waynecounty.com/arcgis/rest/services',
    'https://services.waynecounty.com/arcgis/rest/services',
    // Detroit's own, which is open-data-first and unusually well published.
    'https://gis.detroitmi.gov/arcgis/rest/services',
    'https://gisportal.detroitmi.gov/arcgis/rest/services',
    // The regional agency, in case the county publishes through it.
    'https://maps.semcog.org/arcgis/rest/services',
    'https://gis.semcog.org/arcgis/rest/services',
  ],

  /*
   * Champaign County, Illinois -- Champaign, Urbana, the university.
   *
   * The first Illinois county, so nothing about it can be assumed from the
   * Michigan ones. Illinois has no public statewide parcel layer to fall back
   * on the way North Carolina and Vermont do, so this has to be the county's
   * own or a member city's.
   *
   * The county's GIS is run by a consortium -- CCGISC, which the county, the
   * cities and the university fund jointly -- so its host is likelier to carry
   * the consortium's name than the county's. That is the same pattern as
   * Newaygo and Kent: the name on the server is not the name of the place.
   */
  champaign: [
    'https://gis.ccgisc.org/arcgis/rest/services',
    'https://maps.ccgisc.org/arcgis/rest/services',
    'https://ccgisc.org/arcgis/rest/services',
    'https://www.ccgisc.org/arcgis/rest/services',
    'https://gisdata.ccgisc.org/arcgis/rest/services',
    'https://services.ccgisc.org/arcgis/rest/services',
    // The non-standard instance names that turned out to be the answer for
    // Kent ("agisprod") and Newaygo ("hosting"). Cheap to try, and the only
    // reason those two were ever found.
    'https://gis.ccgisc.org/server/rest/services',
    'https://gis.ccgisc.org/hosting/rest/services',
    'https://gis.co.champaign.il.us/arcgis/rest/services',
    'https://maps.co.champaign.il.us/arcgis/rest/services',
    'https://gis.co.champaign.il.us/server/rest/services',
    'https://gis.champaigncountyil.gov/arcgis/rest/services',
    'https://maps.champaigncountyil.gov/arcgis/rest/services',
    // The two cities, which co-fund the consortium and may republish it.
    'https://gis.champaignil.gov/arcgis/rest/services',
    'https://maps.champaignil.gov/arcgis/rest/services',
    'https://gis.ci.champaign.il.us/arcgis/rest/services',
    'https://gis.urbanaillinois.us/arcgis/rest/services',
    'https://maps.urbanaillinois.us/arcgis/rest/services',
  ],
};

const PARCEL_NAME = /parcel|propert|cadastr|landbase|tax.?map|assessor/i;

/*
 * Field picking, in preference order.
 *
 * Loose matching gets this wrong in ways that look right: "propertyzip"
 * starts with "prop" and was offered as a parcel id, and
 * "Property_Address_Num" matched an address pattern while holding just the
 * house number ("787"). Exact names are tried first, then patterns, and a
 * candidate whose value does not look like the thing is rejected outright.
 */
const PIN_EXACT = /^(pin|parcelid|parcel_id|parcelno|parcel_no|parcelnum|parcelnumber|pnum|apn|pid|finalpin|mapping_?id|parno|altparno)$/i;
const PIN_LOOSE = /(parcel.*(id|no|num)|^pin$|packedpin)/i;
const ADDR_EXACT = /^(propertyaddress|property_address_combined|siteaddress|site_address|siteadd|fulladdress|full_address|address|situs_address)$/i;
const ADDR_LOOSE = /(addr.*combined|full.?addr|site.?addr|situs)/i;

/** Reject fields that are clearly a fragment rather than the whole value. */
const ADDR_FRAGMENT = /(num|number|dir|direction|city|state|zip|country|unit|apt)$/i;

const looksLikePin = (v) =>
  typeof v === 'string' && v.trim().length >= 6 && /\d/.test(v);
const looksLikeAddress = (v) =>
  typeof v === 'string' && v.trim().length >= 5 && /\d/.test(v) && /[a-z]/i.test(v);

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
/*
 * `key`, NOT the display name, and this was wrong from the day STATES was
 * added to fix it.
 *
 * STATES is keyed by the county key -- `washoe` -- and this was called with
 * the name minus " County" -- `Washoe`. So the lookup missed every time and
 * fell through to Michigan, and the search Washoe actually ran was "Washoe
 * Michigan parcels": precisely the confidently-wrong query the comment on
 * STATES says it exists to prevent. It never fired, because Washoe was found
 * by a host guess before the catalogue search was reached.
 *
 * It matters now because Champaign is in Illinois and has no obvious host, so
 * the catalogue search is the likeliest thing to find it.
 */
async function searchArcGISOnline(key) {
  const countyName = (COUNTIES[key]?.name || key).replace(/ County$/, '');
  const q = `${countyName} ${STATES[key] || 'Michigan'} parcels`;
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

/**
 * Point-in-polygon query, mirroring the fallback in worker/src/parcel.js.
 *
 * resultRecordCount is gone entirely: several of these servers answer
 * "Pagination is not supported" and return nothing at all, which is what made
 * Allegan's and Muskegon's current parcel layers look dead.
 */
async function queryLayer(serviceUrl, layerId, point) {
  const base = {
    f: 'json',
    geometry: JSON.stringify({ x: point.lng, y: point.lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
  };

  let last = null;
  for (const params of [{ ...base, geometryPrecision: '8' }, base]) {
    last = await getJson(`${serviceUrl}/${layerId}/query?${new URLSearchParams(params)}`);
    if (!last.error) return last;
  }
  return last;
}

function summarise(attrs) {
  const names = Object.keys(attrs);

  const pick = (tests, valueOk, reject) => {
    for (const test of tests) {
      // A field that matches AND holds a sensible value beats one that only
      // matches by name.
      const withValue = names.find(
        (n) => test.test(n) && !(reject && reject.test(n)) && valueOk(attrs[n])
      );
      if (withValue) return withValue;
    }
    for (const test of tests) {
      const byName = names.find((n) => test.test(n) && !(reject && reject.test(n)));
      if (byName) return byName;
    }
    return null;
  };

  return {
    pin: pick([PIN_EXACT, PIN_LOOSE], looksLikePin),
    address: pick([ADDR_EXACT, ADDR_LOOSE], looksLikeAddress, ADDR_FRAGMENT),
    names,
  };
}

/** Test every plausible layer of one service. Returns true on a match. */
async function tryService(key, serviceUrl, label, points) {
  const meta = await getJson(`${serviceUrl}?f=json`);
  if (meta.error) {
    console.log(`      x ${label} -- ${describe(meta.error)}`);
    return false;
  }

  // A FeatureServer with a single layer often omits the list; /0 is the layer.
  const layers = meta.layers || (meta.type === 'Feature Layer' ? [{ id: 0, name: meta.name }] : []);
  if (!layers.length) {
    console.log(`      x ${label} -- no layers`);
    return false;
  }

  const usable = layers.filter((l) => !ARCHIVE_NAME.test(l.name));
  const named = usable.filter((l) => PARCEL_NAME.test(l.name));
  const tryThese = (named.length ? named : usable).slice(0, MAX_LAYERS_PER_SERVICE);

  const skipped = layers.length - usable.length;
  console.log(
    `      -> ${label}: ${layers.length} layers, testing ${tryThese.length}` +
    (skipped ? ` (${skipped} archive//historic skipped)` : '')
  );

  for (const layer of tryThese) {
    /*
     * EVERY POINT, NOT THE FIRST ONE THAT ANSWERS.
     *
     * This used to return on the first hit and print a ready-to-paste block
     * claiming `verified: 'live'`. Searching Wayne County it hit a layer named
     * "Wayne_County_Parcels_Affected1" -- one private individual's flood study
     * of the River Rouge, published to their personal ArcGIS Online account --
     * matched a single point at 37 acres, found no pin or address field, and
     * printed a config block with the literal string 'null' in it.
     *
     * Four of the five points had returned nothing. The evidence for that
     * recommendation was one oversized polygon from a stranger's coursework,
     * and the tool presented it in the same words it uses for Kent.
     *
     * So: all the points are tried, the hits are counted, and the verdict says
     * how much of the county actually answered. A layer that names fields and
     * answers in several towns is a county parcel layer. One that answers in a
     * single spot with no identifiers is a subset of something, and the paste
     * block says so instead of lying.
     */
    const hits = [];
    let rejected = null;

    for (const point of points) {
      const result = await queryLayer(serviceUrl, layer.id, point);

      if (result.error) {
        console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${describe(result.error)}`);
        rejected = 'the layer refuses queries';
        break; // a rejected query will be rejected for every point
      }
      if (!result.features?.length) {
        console.log(`         [${layer.id}] ${layer.name} @${point.label}: 0 features`);
        continue;
      }

      const feature = result.features[0];
      const geometry = esriToGeoJSON(feature.geometry);
      if (!geometry) {
        console.log(`         [${layer.id}] ${layer.name} @${point.label}: no usable geometry`);
        continue;
      }

      const area = measure(geometry);
      if (area.acres < PLAUSIBLE_ACRES.min || area.acres > PLAUSIBLE_ACRES.max) {
        console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${area.acres} ac -- not parcel-sized`);
        continue;
      }

      console.log(`         [${layer.id}] ${layer.name} @${point.label}: ${area.acres} ac`);
      hits.push({ point, feature, area });
    }

    if (rejected || !hits.length) continue;

    const f = summarise(hits[0].feature.attributes || {});

    /*
     * What would make this trustworthy, stated as the two things a county
     * parcel layer has and a one-off extract does not.
     */
    const doubts = [];
    if (!f.pin && !f.address) {
      doubts.push('no parcel id or address field -- nothing to label a lot with');
    }
    if (points.length > 1 && hits.length < 2) {
      doubts.push(`only ${hits.length} of ${points.length} test points returned a parcel`);
    }
    /*
     * A residential point that comes back as tens of acres is not this lot. It
     * passes PLAUSIBLE_ACRES because that bound has to allow real rural
     * parcels, so the median is checked separately against a suburban size.
     */
    const median = [...hits].sort((a, b) => a.area.acres - b.area.acres)[Math.floor(hits.length / 2)];
    if (median.area.acres > 25) {
      doubts.push(`typical result is ${median.area.acres} ac, far too big for the residential points aimed at`);
    }

    console.log(`\n         ${doubts.length ? '--- CANDIDATE (not trusted) ---' : '*** MATCH ***'}`);
    console.log(`         [${layer.id}] ${layer.name}`);
    console.log(`         ${hits.length} of ${points.length} points answered; typical ${median.area.acres} ac`);
    console.log(`         pin field:     ${f.pin || '(none found)'}`);
    console.log(`         address field: ${f.address || '(none found)'}`);

    if (doubts.length) {
      console.log(`\n         NOT recommended, because:`);
      for (const d of doubts) console.log(`           - ${d}`);
      console.log(`         Service: ${serviceUrl} layer ${layer.id}`);
      console.log(`         all fields: ${f.names.slice(0, 30).join(', ')}\n`);
      continue;   // keep looking; something better may be further down the list
    }

    console.log(`\n         Paste into worker/src/counties.js:`);
    console.log(`           ${key}: {`);
    console.log(`             name: '${COUNTIES[key]?.name || key}',`);
    console.log(`             fips: '${COUNTIES[key]?.fips || ''}',`);
    console.log(`             service: '${serviceUrl}',`);
    console.log(`             layer: ${layer.id},`);
    const fieldBits = [f.pin ? `pin: '${f.pin}'` : null, f.address ? `address: '${f.address}'` : null]
      .filter(Boolean).join(', ');
    console.log(`             fields: { ${fieldBits} },`);
    console.log(`             verified: 'live', // ${median.area.acres} ac at ${median.point.label}`);
    console.log(`           },`);
    console.log(`         all fields: ${f.names.slice(0, 30).join(', ')}\n`);
    return true;
  }
  return false;
}

async function investigate(key) {
  const points = TEST_POINTS[key];
  const labels = points.map((p) => p.label).join(', ');
  console.log(`\n${'='.repeat(66)}\n${COUNTIES[key]?.name || key}  (test points: ${labels})\n${'='.repeat(66)}`);

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
      if (await tryService(key, serviceUrl, `${svc.name} (${svc.type})`, points)) return true;
    }
  }

  // Nothing county-hosted answered; try the public ArcGIS Online catalogue.
  console.log(`\n  Searching ArcGIS Online for "${COUNTIES[key]?.name || key}"…`);
  const hosted = await searchArcGISOnline(key);
  if (!hosted.length) console.log('      no candidates found');

  for (const item of hosted) {
    if (await tryService(key, item.url, `${item.title} [${item.owner}]`, points)) return true;
  }

  console.log(`  → nothing worked for ${key}.`);
  return false;
}

const only = process.argv[2];

/*
 * Say what is wrong, rather than throwing.
 *
 * A name this file does not know used to reach investigate() and die on
 * `TEST_POINTS[key].map` with a stack trace -- from a diagnostic tool whose
 * whole audience is someone on a phone with no way to read one. It is also the
 * only tool here that takes a free-text name, so a typo is the expected input,
 * not the exceptional one. `none` is accepted as a way to run the workflow for
 * its statewide half alone.
 */
const known = Object.keys(CANDIDATE_ROOTS);
if (only && only !== 'none' && !known.includes(only)) {
  console.error(`No county called "${only}" is configured here.`);
  console.error(`Known: ${known.join(', ')}`);
  console.error('Or "none" to skip the county search entirely.');
  process.exit(1);
}
if (only === 'none') {
  console.log('Skipping the county search (county: none).');
  process.exit(0);
}

const keys = only ? [only] : known;
const found = [];

for (const key of keys) {
  if (await investigate(key)) found.push(key);
}

console.log(`\n${'='.repeat(66)}`);
console.log(`Working parcel sources found for: ${found.length ? found.join(', ') : '(none)'}`);
console.log(`No source for: ${keys.filter((k) => !found.includes(k)).join(', ') || '(none)'}`);
console.log(`${'='.repeat(66)}\n`);
