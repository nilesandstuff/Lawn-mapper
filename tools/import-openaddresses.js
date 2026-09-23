/**
 * Turns OpenAddresses' US sources into candidate parcel endpoints.
 *
 *   node tools/import-openaddresses.js
 *
 * Writes tools/openaddresses-candidates.json, which is COMMITTED, for the same
 * reason the atlas import is: eight hundred counties appearing in the app's
 * coverage claim should arrive as a reviewable diff and not as a side effect of
 * a build.
 *
 * WHY THIS SOURCE, on top of the one already here.
 *
 * OpenAddresses is a decade-old catalogue of open address, parcel and building
 * data, maintained by people who run the endpoints weekly and notice when they
 * break. Its US directory holds 1,024 counties with an ESRI parcel service.
 * Against this app's 152 hand- and atlas-verified counties:
 *
 *   80    already here, from the atlas
 *   802   not here at all
 *   72    here and NOT in OpenAddresses
 *
 * So it is not a replacement for the atlas and the atlas is not a replacement
 * for it. Both are indexes somebody else maintains; between them they cover
 * about five times what either does alone, and the 72 are the reason neither
 * gets dropped.
 *
 * WHAT ITS RECORDS LOOK LIKE, which is very nearly the shape this app wants:
 *
 *   "parcels": [{
 *     "protocol": "ESRI",
 *     "data": ".../Property_and_Tax/FeatureServer/0",
 *     "conform": { "pid": "pin" }
 *   }]
 *
 * 1,022 of the 1,024 URLs already end in the service-plus-layer form this
 * registry stores, every one names its parcel-id field, and the FIPS code sits
 * in `coverage["US Census"].geoid` -- so the join to everything else here is on
 * a number rather than on a name that reads "St. Louis" on one side and "St
 * Louis" on the other.
 *
 * WHAT IT DOES NOT CARRY IS AN ADDRESS FIELD. A parcels conform holds `pid` and
 * nothing else, because OpenAddresses gets addresses from the addresses layer
 * instead. That costs the line of text under a measurement and nothing else --
 * parcel.js already renders a parcel with no address, and 26 atlas counties
 * ship that way today. The verifier sniffs for one on the record that comes
 * back, which is a better source than a catalogue anyway.
 *
 * LICENCE. The OpenAddresses repository is BSD-3-Clause and its source files
 * are references to public government data, not the data itself. What gets
 * copied into this app is a URL, a layer index and a field name per county --
 * facts about where a county publishes its own records. The attribution is
 * kept here and in the generated registry's header.
 *
 * AND IT IS NOT VERIFIED. "Listed by OpenAddresses" means somebody added a URL
 * and a weekly job downloads from it. This app means a point query returned a
 * parcel-sized polygon, measured. Nothing here reaches counties.js until
 * verify-counties.js agrees.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const REPO = 'https://github.com/openaddresses/openaddresses';

/*
 * A SPARSE CLONE, not a download of the whole repository.
 *
 * The sources directory is a few megabytes of small JSON files; the repository
 * with its history is orders of magnitude more, and this runs on a CI runner
 * with a disk allowance. `--filter=blob:none --sparse` fetches the tree and
 * then only the files asked for: about 11 MB and a few seconds.
 *
 * Not an npm dependency, because it is not a package -- it is a repository of
 * data files, with no version to pin and no release to install. Cloning it is
 * the honest way to read it, and OA_DIR is there for anybody who already has a
 * checkout and does not want a second one.
 */
function sourcesDir() {
  const given = (process.env.OA_DIR || '').trim();
  if (given) {
    const dir = resolve(given, 'sources/us');
    if (!existsSync(dir)) {
      console.error(`OA_DIR is set to ${given} but ${dir} does not exist.`);
      process.exit(1);
    }
    return dir;
  }

  const cache = resolve(root, 'node_modules/.cache/openaddresses');
  if (existsSync(join(cache, 'sources/us'))) {
    /* Already here from an earlier run. Bring it up to date rather than
       re-cloning: the sources change weekly and the clone is the slow part. */
    try {
      execFileSync('git', ['-C', cache, 'pull', '--depth', '1', '--ff-only'],
        { stdio: 'inherit' });
      return join(cache, 'sources/us');
    } catch {
      console.error('Could not update the existing checkout; using it as it is.');
      return join(cache, 'sources/us');
    }
  }

  console.log(`Cloning ${REPO} (sources only)…`);
  mkdirSync(dirname(cache), { recursive: true });
  execFileSync('git', [
    'clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO, cache,
  ], { stdio: 'inherit', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
  execFileSync('git', ['-C', cache, 'sparse-checkout', 'set', 'sources/us'],
    { stdio: 'inherit' });
  return join(cache, 'sources/us');
}

/** `Prince George's` in `md` -> `md-prince-georges`, matching the atlas keys. */
const slug = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/*
 * The county's name WITHOUT its type word, so `md-prince-georges` comes out the
 * same here as it does from the atlas and the two catalogues can be joined on
 * more than the FIPS code. Louisiana has parishes and Alaska has boroughs and
 * census areas; all of them are "County" in a key.
 */
const bareName = (name) => String(name)
  .replace(/\s+(County|Parish|Borough|Municipality|Census Area|City and Borough|Planning Region|city)$/i, '')
  .trim();

/*
 * The app builds `${service}/${layer}/query`, so an endpoint that does not
 * split into those two is no use to it. Two of the 1,024 do not -- they point
 * at a service root with no layer index, which could be any layer in it, and
 * guessing our way through somebody's public server is exactly the traffic
 * that gets a tool blocked.
 */
const SPLIT = /^(.*\/(?:Map|Feature)Server)\/(\d+)\/?$/i;

const dir = sourcesDir();
const stateDirs = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[a-z]{2}$/.test(d.name))
  .map((d) => d.name)
  .sort();

/*
 * The territories, left out for the same reason the county roster leaves them
 * out: the app cannot measure a lawn in one, because the imagery and the
 * geocoder both stop at the same border.
 */
const SKIP_STATES = new Set(['pr', 'vi', 'gu', 'as', 'mp']);

/*
 * STATE ABBREVIATION TO POSTCODE, which is the same string -- but the registry
 * matches a statewide layer against what the geocoder reports, in upper case,
 * and that comparison is the only thing keeping North Carolina's rectangle
 * from claiming addresses in Georgia. Spelled out here rather than assumed.
 */
const STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc',
  'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma',
  'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd',
  'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa',
  'wv', 'wi', 'wy']);

const candidates = [];
const statewide = [];
const takenBy = new Map();
let listed = 0;
let noParcels = 0;
let notEsri = 0;
let unusableUrl = 0;
let noFips = 0;
let skipped = 0;

for (const state of stateDirs) {
  if (SKIP_STATES.has(state)) continue;
  const files = readdirSync(join(dir, state)).filter((n) => n.endsWith('.json')).sort();

  for (const file of files) {
    let source;
    try {
      source = JSON.parse(readFileSync(join(dir, state, file), 'utf8'));
    } catch {
      continue; // A source file this cannot read is not a county to report on.
    }
    listed++;

    const layers = source?.layers?.parcels;
    if (!Array.isArray(layers) || !layers.length) { noParcels++; continue; }

    /*
     * `skip` is OpenAddresses' own mark for a source it knows is not working.
     * Honouring it costs nothing and saves a verification request on a county
     * whose maintainers have already said not to bother.
     */
    const usable = layers.filter((e) => !e.skip && e.protocol === 'ESRI' && SPLIT.test(e.data || ''));
    if (!usable.length) {
      if (layers.some((e) => e.skip)) skipped++;
      else if (!layers.some((e) => e.protocol === 'ESRI')) notEsri++;
      else unusableUrl++;
      continue;
    }

    const census = source?.coverage?.['US Census'] || {};
    const fips = String(census.geoid || '');

    const split = (e) => {
      const m = e.data.match(SPLIT);
      return { service: m[1], layer: Number(m[2]) };
    };
    /*
     * `pid` is the parcel id and there is never anything else. `address` stays
     * null deliberately rather than being guessed at from the addresses layer:
     * that layer is a different service with a different schema, and a street
     * address taken from one dataset and printed under a polygon from another
     * is a mistake waiting to be believed.
     */
    const fieldsOf = (e) => ({ pin: (e.conform || {}).pid || null, address: null });
    const [first, ...rest] = usable;

    /*
     * A WHOLE STATE FROM ONE ENDPOINT, which is worth far more than any single
     * county and arrives in the same directory.
     *
     * Nineteen states publish one parcel layer for everything -- Texas, New
     * York, Virginia, Washington, Utah among them. This app already serves
     * five states that way, every one of them found by hand, one at a time,
     * after a tool that guessed at hostnames failed on all twelve of its
     * guesses. They were sitting in this catalogue the whole time.
     *
     * IDENTIFIED BY THE FILENAME, not by the shape of the geoid. A two-digit
     * geoid would also match a source that simply forgot its county code, and
     * "statewide.json" is the catalogue saying plainly what the file is.
     *
     * It goes out as a mosaic, never as a promise of the whole state: these
     * are states republishing what each county sends them, and a county that
     * has sent nothing looks exactly like a working service from here. That is
     * what `complete` is for and nothing imported gets it.
     */
    if (/^statewide\.json$/i.test(file) && STATES.has(state)) {
      statewide.push({
        key: `${state}-statewide`,
        name: `${census.name || state.toUpperCase()} (OpenAddresses)`,
        state: state.toUpperCase(),
        statewide: true,
        ...split(first),
        layerName: null,
        fields: fieldsOf(first),
        fallbacks: rest.map((e) => ({ ...split(e), fields: fieldsOf(e) })),
      });
      continue;
    }

    /*
     * EVERYTHING ELSE MUST BE A COUNTY. A city's parcel layer is real data and
     * the wrong shape for this registry: the lookup picks a county by which
     * bounding box an address falls in, and a box around Portland inside a box
     * around Multnomah County is two candidates for one address where one of
     * them covers a tenth of it. 135 sources drop out here and they are cities
     * and towns, not counties -- their geoid is a place code, not a county one.
     */
    if (!/^\d{5}$/.test(fips)) { noFips++; continue; }

    /*
     * THE CENSUS NAME, not the county name plus the word "County".
     *
     * The atlas importer builds `${county} County, ${state}` and that is wrong
     * for every parish in Louisiana and every borough and census area in
     * Alaska. This record carries the real name -- "East Baton Rouge Parish",
     * "Matanuska-Susitna Borough" -- and it is the string the app quotes under
     * a measurement as the source of the number.
     */
    const name = census.name || source?.coverage?.county || file.replace(/\.json$/, '');
    const key = `${state}-${slug(bareName(name))}`;

    candidates.push({
      key,
      name: `${name}, ${state.toUpperCase()}`,
      fips,
      ...split(first),
      /* OpenAddresses does not name its layers, so the verifier's
         table-detection has nothing to read here and falls through to the
         ordinary path -- which is what null has always meant to it. */
      layerName: null,
      fields: fieldsOf(first),
      fallbacks: rest.map((e) => ({ ...split(e), fields: fieldsOf(e) })),
    });
  }
}

/*
 * A COLLISION IS SILENT AND LOSSY, exactly as in the atlas importer: the
 * generated registry is an object literal, so two entries under one key is not
 * an error, it is the second one winning. That is how New York lost four
 * boroughs once. Here it would most likely be two source files for one county
 * -- "bibb.json" and "bibb2.json" both exist in Georgia -- so the second is
 * folded in as a FALLBACK rather than dropped or allowed to overwrite. Two
 * endpoints for one county is a good thing; parcel.js tries them in order.
 */
const merged = [];
for (const c of candidates) {
  const already = takenBy.get(c.key);
  if (!already) {
    takenBy.set(c.key, c);
    merged.push(c);
    continue;
  }
  if (already.fips !== c.fips) {
    console.error(`\nFAIL  two different counties want the key "${c.key}":`);
    console.error(`        ${already.name} (${already.fips})`);
    console.error(`        ${c.name} (${c.fips})`);
    process.exit(1);
  }
  already.fallbacks.push({ service: c.service, layer: c.layer, fields: c.fields },
    ...c.fallbacks);
}

const out = {
  importedFrom: 'openaddresses/openaddresses',
  importedAt: new Date().toISOString().slice(0, 10),
  note: 'Candidates only. Nothing here is claimed as working until verify-counties.js says so.',
  /*
   * THE FUNNEL, WRITTEN DOWN, so "889 of 1,971" does not need the console
   * output of whoever last ran this to make sense.
   */
  listed,
  noParcels,
  notEsri,
  unusableUrl,
  noFips,
  skipped,
  candidates: merged,
  statewide,
};

const target = join(here, 'openaddresses-candidates.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

console.log(`openaddresses: ${listed} US source files`);
console.log(`  ${statewide.length} STATES with one parcel layer for the lot: `
  + `${statewide.map((s) => s.state).join(' ')}`);
console.log(`  ${merged.length} counties with a queryable ESRI parcel layer`);
console.log(`  ${noParcels} have no parcels layer at all (addresses only)`);
console.log(`  ${notEsri} publish parcels over something this cannot query`);
console.log(`  ${unusableUrl} name a service with no layer index`);
console.log(`  ${noFips} carry no Census FIPS code to join on`);
console.log(`  ${skipped} are marked skip by OpenAddresses itself`);
console.log(`  ${merged.filter((c) => c.fallbacks.length).length} carry a second endpoint as a fallback`);
console.log(`\nwrote ${target}`);
console.log('Next: run the "10. Verify county parcel servers" workflow, which needs a network.');
