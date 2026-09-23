/**
 * Write worker/src/us-counties.js: every county in the United States.
 *
 *   node tools/build-us-counties.js
 *
 * WHY THE APP NEEDS A LIST OF PLACES IT DOES NOT SERVE.
 *
 * "Maryland, all of it" and "31 of Georgia's 159" are the two sentences worth
 * reading on a coverage page, and neither can be written from the registry
 * alone: it knows what we have and has no idea what we are missing. Counting
 * against the real denominator is what turns a list of names into a fact.
 *
 * It is also what lets a nearly-complete state say so. Listing the five
 * counties a state is missing is a far better sentence than listing the
 * hundred and fifty it has, and you cannot subtract from a total you do not
 * know.
 *
 * THE SOURCE is the Census Bureau's county gazetteer, which is the authority
 * the FIPS codes in the registry already come from -- so the two sides join on
 * a number minted for exactly this, rather than on a name that reads "St.
 * Louis" on one side and "St Louis" on the other.
 *
 * THE GAZETTEER RATHER THAN THE 2020 CODES FILE, and it matters: Connecticut
 * replaced its eight counties with nine planning regions, and the 2020 file
 * still lists the old eight. The atlas carries the new codes (09110-09190), so
 * against that file all nine regions joined nothing and the whole state
 * vanished from the coverage page -- a state we serve completely, reported as
 * not served at all. The gazetteer is republished yearly and has them.
 *
 * REGENERATING IS RARE, and deliberately not automatic. County lines almost
 * never move, and Connecticut's is the only change in decades. The site's own
 * coverage list needs no regeneration at all -- it is computed from the
 * registry on every request, so adding a county updates it the moment that
 * county deploys.
 */

import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const YEAR = 2026;
const url = (y) =>
  `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${y}_Gazetteer/${y}_Gaz_counties_national.zip`;

/*
 * The fifty states and DC. The territories are left out because the app
 * cannot measure a lawn in one -- the imagery and the geocoder both stop at
 * the same border -- and counting American Samoa's districts as "missing
 * coverage" would make the denominator say something untrue about the work
 * left to do.
 */
const SKIP = new Set(['AS', 'GU', 'MP', 'PR', 'UM', 'VI']);

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/*
 * A ZIP OF ONE FILE, unpacked here rather than shelled out to `unzip`.
 *
 * Fifteen lines against a binary this tool would otherwise have to assume is
 * installed, and the deploy host is not the machine this was written on. The
 * container format is only a header, a name, and a deflate stream, which zlib
 * already has.
 */
function unzipOne(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a zip file');
  const method = buf.readUInt16LE(8);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const size = buf.readUInt32LE(18); // compressed
  const body = buf.subarray(start, size ? start + size : undefined);
  if (method === 0) return body.toString('utf8');
  if (method === 8) return inflateRawSync(body).toString('utf8');
  throw new Error(`Unexpected compression method ${method}`);
}

/* Last year's file if this year's is not published yet -- it appears partway
   through the year, and a tool that only works in December is not a tool. */
let res = await fetch(url(YEAR));
if (res.status === 404) res = await fetch(url(YEAR - 1));
if (!res.ok) throw new Error(`Census gazetteer: ${res.status} ${res.statusText}`);
const text = unzipOne(Buffer.from(await res.arrayBuffer()));

/*
 * THE DELIMITER IS NOT A CONSTANT. The 2024 gazetteer is tab-separated and the
 * 2026 one is pipe-separated, with the same columns either way. Taken from the
 * header rather than assumed, so next year's choice is not a rewrite.
 */
const [header, ...lines] = text.trim().split(/\r?\n/);
const SEP = header.includes('|') ? '|' : '\t';
const cols = header.split(SEP).map((c) => c.trim());
const at = (name) => {
  const i = cols.indexOf(name);
  if (i < 0) throw new Error(`The gazetteer has no "${name}" column: ${cols.join(',')}`);
  return i;
};
const [iState, iGeoid, iName] = [at('USPS'), at('GEOID'), at('NAME')];
/*
 * THE COUNTY CENTROIDS, which are here to bound the STATE.
 *
 * A layer claiming to serve a whole state has to be checked against something,
 * and the check that matters is "is this actually state-sized". OpenAddresses
 * lists an Ohio statewide source whose URL is one county's own server -- real
 * data, wrongly labelled, and if the app took it at its word it would claim
 * most of Ohio on the strength of Trumbull County.
 *
 * A box drawn through the county centroids is deliberately SMALLER than the
 * state -- it stops half a county short on every side -- which is the right
 * direction to be wrong in: it makes the test easier to pass, so a real
 * statewide layer never fails it, while a layer covering one county out of
 * eighty-eight is nowhere near.
 */
const iLat = at('INTPTLAT');
const iLng = at('INTPTLONG');

/* { '01': { ab: 'AL', name: 'Alabama', counties: { '001': 'Autauga County' } } } */
const states = {};
let counted = 0;
for (const line of lines) {
  const f = line.split(SEP).map((v) => v.trim());
  const ab = f[iState];
  if (SKIP.has(ab)) continue;
  if (!STATE_NAMES[ab]) throw new Error(`Unknown state code in the source: ${ab}`);

  const geoid = f[iGeoid];
  if (!/^\d{5}$/.test(geoid)) throw new Error(`Not a county FIPS code: ${geoid}`);
  const fp = geoid.slice(0, 2);
  states[fp] ||= { ab, name: STATE_NAMES[ab], counties: {}, box: null };
  states[fp].counties[geoid.slice(2)] = f[iName];

  const lat = Number(f[iLat]);
  const lng = Number(f[iLng]);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const b = states[fp].box;
    states[fp].box = b
      ? [Math.min(b[0], lng), Math.min(b[1], lat), Math.max(b[2], lng), Math.max(b[3], lat)]
      : [lng, lat, lng, lat];
  }
  counted++;
}

/*
 * A SINGLE-COUNTY STATE HAS A ZERO-WIDTH BOX, because one centroid is a point.
 * The District of Columbia is exactly that. Given a floor rather than left to
 * collapse: a zero span makes any percentage-of-the-state test either divide
 * by zero or pass trivially, and the second is worse.
 */
const MIN_STATE_SPAN = 0.05;
for (const s of Object.values(states)) {
  if (!s.box) continue;
  const [w, so, e, n] = s.box;
  s.box = [
    w, so,
    Math.max(e, w + MIN_STATE_SPAN),
    Math.max(n, so + MIN_STATE_SPAN),
  ].map((v) => Math.round(v * 1000) / 1000);
}

const missing = Object.keys(STATE_NAMES).filter(
  (ab) => !Object.values(states).some((s) => s.ab === ab)
);
if (missing.length) throw new Error(`No counties found for: ${missing.join(', ')}`);

/* Sorted by FIPS, so a regeneration that changes nothing produces no diff. */
const body = Object.keys(states).sort().map((fp) => {
  const s = states[fp];
  const rows = Object.keys(s.counties).sort()
    .map((c) => `    ${JSON.stringify(c)}: ${JSON.stringify(s.counties[c])},`)
    .join('\n');
  return `  ${JSON.stringify(fp)}: {\n`
    + `    ab: ${JSON.stringify(s.ab)},\n`
    + `    name: ${JSON.stringify(s.name)},\n`
    + `    box: ${JSON.stringify(s.box)},\n`
    + `    counties: {\n${rows.replace(/^ {4}/gm, '      ')}\n    },\n`
    + '  },';
}).join('\n');

const out = `/**
 * GENERATED by tools/build-us-counties.js. Do not edit by hand.
 *
 * Every county, parish, borough and independent city in the fifty states and
 * the District of Columbia, keyed by the FIPS codes the parcel registry
 * already carries. It is here to be the DENOMINATOR: it is what lets the
 * coverage page say "all of Maryland" instead of listing twenty-four names,
 * and "missing four" instead of listing a hundred and fifty-five.
 *
 * The territories are not here. The app cannot measure a lawn in one, so
 * counting their districts as absent coverage would overstate the work left.
 *
 * Each state also carries a "box", drawn through its own county CENTROIDS. It
 * is deliberately smaller than the state, which is the safe direction: it is
 * used to ask whether a layer claiming to serve a whole state is actually
 * state-sized, and being generous there would let one county's server pass as
 * Ohio.
 *
 * Source: the Census Bureau county gazetteer.
 * ${counted} counties across ${Object.keys(states).length} states, built ${new Date().toISOString().slice(0, 10)}.
 */

export const US_COUNTIES = {
${body}
};

/** How many counties the country has, which is the number nothing else knows. */
export const US_COUNTY_TOTAL = ${counted};
`;

writeFileSync(new URL('../worker/src/us-counties.js', import.meta.url), out);
console.log(`Wrote ${counted} counties across ${Object.keys(states).length} states.`);
