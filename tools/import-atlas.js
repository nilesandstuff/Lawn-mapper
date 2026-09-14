/**
 * Turns UrbanKit's parcel atlas into candidate endpoints for this app.
 *
 *   node tools/import-atlas.js
 *
 * Writes tools/atlas-candidates.json, which is COMMITTED. The import is a
 * deliberate act rather than a build step so that what the app is about to
 * claim coverage of arrives as a reviewable diff -- 166 counties appearing
 * silently on an npm update is exactly the kind of change nobody reads.
 *
 * WHY THIS SOURCE. Guessing hostnames has failed for every county it was
 * tried on, and the three that were solved were solved by a person handing
 * over a link. This is that, at scale: someone else's hand-verified index,
 * MIT licensed, shipped as data rather than as a service.
 *
 * It scored well on the only test available -- the counties this repo already
 * found the hard way:
 *
 *   Kent, MI     agrees on gis.kentcountymi.gov/agisprod -- the non-standard
 *                instance name that no amount of guessing found
 *   Wayne, MI    agrees on ArcGIS Online org b6rkZNtCd6Mx2gvB, which is not
 *                inferable from anything, though it names a different service
 *   Washoe, NV   a DIFFERENT host from the one shipped here
 *
 * Two independent hits on the two hardest finds in this repo. That is why the
 * list is worth importing.
 *
 * WHAT IT IS NOT is verified. Their "verified" means somebody checked the
 * endpoint answers; counties.js means a point query returned a parcel-sized
 * polygon, measured. Nothing here goes into counties.js on this file's word --
 * verify-atlas.js has to agree first, and it is deliberately a separate step
 * that needs a network the sandbox does not have.
 *
 * Also not a superset: Champaign, Vanderburgh, Ottawa, Allegan, Muskegon and
 * Newaygo are all absent from it and all present here.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/*
 * Read the package's data directory directly rather than importing its SDK.
 *
 * The SDK is a convenience wrapper over exactly these JSON files, and reading
 * them means this script does not care whether the package's exports change
 * shape. If the directory is missing, say how to get it rather than throwing a
 * module-resolution error at somebody who has never heard of this dependency.
 */
const DATA = resolve(root, 'node_modules/@urbankitstudio/atlas/data');

let files;
try {
  files = readdirSync(DATA).filter((n) => n.endsWith('.json'));
} catch {
  console.error(`No atlas data at ${DATA}`);
  console.error('Install it first:  npm install --no-save @urbankitstudio/atlas');
  process.exit(1);
}

/*
 * Endpoints this app cannot use, dropped at import rather than wasting a
 * verification request on each.
 *
 * The app builds `${service}/${layer}/query` and needs a polygon back at a
 * point. A layer that cannot be queried is useless to it, whatever else it is
 * good for, and a non-public licence is not ours to redistribute in a config
 * file.
 */
const usable = (e) =>
  e.url
  && e.supportsQuery !== false
  && (e.license === undefined || e.license === 'public')
  && /\/(Map|Feature)Server\/\d+$/i.test(e.url);

/*
 * Which field holds the parcel id, and which the street address.
 *
 * The atlas labels its fields, which is more than the raw service does, so
 * this reads the label as well as the name. Both stay null when nothing
 * matches -- a county with no address field is still worth having, and
 * parcel.js already renders one without.
 */
/*
 * Neither is required. The app measures from the POLYGON; these only label the
 * result on screen, and parcel.js already renders a parcel with no address. A
 * county whose schema nothing here recognises is still fully usable, so a miss
 * costs a line of text and not a measurement.
 *
 * Widened once already, against the real field census across all 48 states
 * rather than against imagination -- PRINT_KEY and SWIS_SBL_ID are New York's,
 * PAMS_PIN is New Jersey's, BBL is New York City's, and none of them look
 * remotely like "parcel id" to a pattern written for the Midwest.
 */
const PIN = /^(pin|ppn|parcelid|parcel_id|parcelno|parcel_no|parcelnum|parcelnumber|parcel_number|pnum|apn|pid|parid|parno|altparno|gpin|tms|strap|folio|print_key|swis_sbl_id|pams_pin|bbl|taxpin|propertyid)$/i;
const PIN_LABEL = /parcel.*(number|id)|^apn$|permanent number|tax id|print key/i;
const ADDR = /^(propertyaddress|property_address|siteaddress|site_address|siteadd|fulladdress|full_address|address|situs_address|situsaddress|prop_add|prop_addr|prop_loc|parcel_addr|property_location|physaddress|location|location_1)$/i;
const ADDR_LABEL = /property address|site address|situs|physical address|property location/i;
/* A field holding one PIECE of an address is worse than none: "PROPADDRESSCITY"
 * would put the town where a street belongs. Same rule as discover-counties. */
const FRAGMENT = /(num|number|dir|direction|city|state|zip|country|unit|apt)$/i;
/*
 * THE OWNER'S MAILING ADDRESS IS NOT THE PROPERTY'S, and it is the single most
 * common field in the whole atlas. Picking it would print a landlord's address
 * in another state under a lawn measurement -- wrong, confident, and about a
 * real person's home. Rejected by prefix before anything else is considered.
 */
const NOT_THE_PROPERTY = /^(mail|mailing|owner|co_?owner|taxpayer|tax_?bill)/i;

/*
 * FRAGMENT is an ADDRESS rule and applying it to parcel ids was wrong.
 *
 * Kent County's id field is PPN, labelled "Parcel Permanent Number" -- which
 * ends in "Number", so the shared reject threw away the one field the whole
 * pattern list exists to find. "Number" is a fragment in an address and the
 * entire point of an id, so the two picks reject different things.
 */
function pick(fields, byName, byLabel, reject) {
  const ok = (f) => !reject.some((r) => r.test(f.name) || r.test(String(f.label || '')));
  return fields.find((f) => byName.test(f.name) && ok(f))?.name
    || fields.find((f) => byLabel.test(String(f.label || '')) && ok(f))?.name
    || null;
}

const candidates = [];
let listed = 0;
let dropped = 0;

for (const file of files.sort()) {
  const state = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
  for (const county of state.counties || []) {
    listed++;
    const endpoints = (county.endpoints || []).filter(usable);
    if (!endpoints.length) { dropped++; continue; }

    // The first usable endpoint is the candidate; any others ride along as
    // fallbacks, which parcel.js already knows how to try in order.
    const [first, ...rest] = endpoints;
    const split = (e) => {
      const m = e.url.match(/^(.*\/(?:Map|Feature)Server)\/(\d+)$/i);
      return { service: m[1], layer: Number(m[2]) };
    };
    const fields = (e) => ({
      pin: pick(e.searchFields || [], PIN, PIN_LABEL, [NOT_THE_PROPERTY]),
      address: pick(e.searchFields || [], ADDR, ADDR_LABEL, [NOT_THE_PROPERTY, FRAGMENT]),
    });

    candidates.push({
      /*
       * `mi-kent` shape, from the atlas, because a key has to be unique across
       * states and county names are not: there is a Champaign in Illinois and
       * Ohio, a Wayne in a dozen states. The existing hand-written entries keep
       * their bare names; these are namespaced from the start.
       */
      key: county.id,
      name: `${county.county} County, ${county.state}`,
      fips: county.countyFips || null,
      ...split(first),
      fields: fields(first),
      fallbacks: rest.map((e) => ({ ...split(e), fields: fields(e) })),
    });
  }
}

const out = {
  /*
   * Recorded so a stale import is visible. The atlas gains counties; without
   * this there is no way to tell a file written today from one written in
   * spring beyond reading git.
   */
  importedFrom: '@urbankitstudio/atlas',
  atlasVersion: JSON.parse(
    readFileSync(resolve(root, 'node_modules/@urbankitstudio/atlas/package.json'), 'utf8')
  ).version,
  importedAt: new Date().toISOString().slice(0, 10),
  note: 'Candidates only. Nothing here is claimed as working until verify-atlas.js says so.',
  candidates,
};

const target = join(here, 'atlas-candidates.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

console.log(`atlas ${out.atlasVersion}: ${listed} counties listed`);
console.log(`  ${candidates.length} with a queryable public endpoint`);
console.log(`  ${dropped} with none this app can use`);
console.log(`  ${candidates.filter((c) => c.fallbacks.length).length} carry a second endpoint as a fallback`);
console.log(`  ${candidates.filter((c) => !c.fields.pin).length} have no parcel-id field this recognises`);
console.log(`  ${candidates.filter((c) => !c.fields.address).length} have no address field this recognises`);
console.log(`\nwrote ${target}`);
console.log('Next: run the "6. Verify atlas counties" workflow, which needs a network.');
