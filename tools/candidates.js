/**
 * The candidate pool: two catalogues, joined.
 *
 * WHY TWO. Neither is a superset of the other, which is the whole argument for
 * carrying both. Counted on the day OpenAddresses was added:
 *
 *   80    in both
 *   802   only in OpenAddresses
 *   72    only in the UrbanKit atlas
 *
 * Dropping either would cost real counties, and the 72 include every one this
 * repo found by hand. So they are merged rather than chosen between.
 *
 * THE JOIN IS ON THE FIPS CODE, not on the key or the name. Both catalogues
 * carry it, it was minted to identify exactly this, and the alternative is
 * matching "St. Louis County" against "St Louis County" and "Prince George's"
 * against "Prince Georges" -- which is the class of bug that hid Gwinnett
 * County for a month.
 *
 * WHERE THEY AGREE, THE ATLAS LEADS AND OPENADDRESSES FOLLOWS. Not because it
 * is better -- nothing here knows that until the verifier runs -- but because
 * the atlas carries labelled fields and OpenAddresses carries only a parcel
 * id, so its entry is the one that can name an address field. The other
 * endpoint is kept as a FALLBACK, which parcel.js already tries in order when
 * the first goes quiet. Two services for one county is the failure this
 * registry has seen more than any other, and a second one costs nothing until
 * the day it saves the county.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { US_COUNTIES } from '../worker/src/us-counties.js';

const here = dirname(fileURLToPath(import.meta.url));

const read = (name) => {
  const path = resolve(here, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
};

/** Every endpoint in a candidate, primary first, for merging into fallbacks. */
const endpointsOf = (c) => [
  { service: c.service, layer: c.layer, fields: c.fields },
  ...(c.fallbacks || []),
];

/*
 * A CATALOGUE CAN BE WRONG ABOUT WHERE A COUNTY IS, and three of them were.
 *
 * The check that found these is the one that exists because Connecticut went
 * missing: every candidate must join a real county by its FIPS code, or it is
 * coverage nothing can account for. Run over both catalogues it turned up
 *
 *   sd-deuel      46139   Deuel County, SD is 46039. A digit.
 *   wa-stevens    52065   Washington is state 53. There is no state 52.
 *   ct-fairfield  09001   Abolished in 2022, when Connecticut replaced its
 *                         counties with nine planning regions.
 *   ma-statewide  null    Not a county at all -- Massachusetts' statewide
 *                         parcel layer, filed under "Statewide County, MA".
 *
 * Three different problems needing three different answers, which is why this
 * is not one rule. A typo is repairable from the name; an abolished county is
 * not, and its ground is already covered by the regions that replaced it; and
 * a whole state mislabelled as a county is the most valuable thing in either
 * catalogue and must not be quietly dropped for having no county code.
 */

/*
 * The state's roster, by postcode -- CARRYING ITS OWN FIPS PREFIX, which the
 * roster keeps as the object key rather than as a field. Reading `s.fp` off
 * the value gave undefined, and the repaired codes came out as
 * "undefined039": a string that joins nothing, from the code whose whole job
 * is making things join.
 */
const stateOf = (ab) => {
  const hit = Object.entries(US_COUNTIES).find(([, s]) => s.ab === ab);
  return hit ? { fp: hit[0], ...hit[1] } : null;
};

const joins = (fips) => {
  const f = String(fips || '');
  if (!/^\d{5}$/.test(f)) return false;
  return Boolean(US_COUNTIES[f.slice(0, 2)]?.counties[f.slice(2)]);
};

/** The name without its type word: "Deuel County" and "Deuel" are one place. */
const bare = (s) => String(s).toLowerCase()
  .replace(/\s*,.*$/, '')
  .replace(/\s+(county|parish|borough|municipality|census area|city and borough|planning region|city)$/i, '')
  .replace(/[^a-z0-9]+/g, '');

/**
 * The right FIPS code for a candidate whose own one names nothing.
 *
 * Repaired from the NAME, and only when that name matches exactly one county
 * in the state the key already says it is in. A near-miss is left alone: the
 * whole point of joining on a number is not having to trust a string, and
 * guessing here would put a county in the wrong place with more confidence
 * than the wrong digit did.
 */
function repairFips(c) {
  const ab = String(c.key || '').slice(0, 2).toUpperCase();
  const state = stateOf(ab);
  if (!state) return null;
  const want = bare(c.name);
  if (!want) return null;
  const hits = Object.entries(state.counties).filter(([, n]) => bare(n) === want);
  return hits.length === 1 ? state.fp + hits[0][0] : null;
}

/** The same service and layer, however the two catalogues spell the URL. */
const sameEndpoint = (a, b) =>
  a.layer === b.layer
  && String(a.service).replace(/\/+$/, '').toLowerCase()
    === String(b.service).replace(/\/+$/, '').toLowerCase();

/**
 * The merged pool.
 *
 * Returns { candidates, statewide, sources }, where `sources` says what each
 * catalogue contributed so a log line can report the funnel rather than a
 * single number nobody can take apart.
 */
export function candidatePool() {
  const atlas = read('atlas-candidates.json');
  const oa = read('openaddresses-candidates.json');
  if (!atlas && !oa) {
    throw new Error('No candidates. Run the importers first.');
  }

  const merged = [];
  const wide = [...(oa?.statewide || [])];
  const byFips = new Map();
  const byKey = new Map();
  const repaired = [];
  const promoted = [];
  const unplaceable = [];

  /*
   * Every candidate has to be placeable before it is a candidate. See the
   * block above: a state mislabelled as a county is promoted, a typo is
   * repaired from the name, and anything left is reported rather than
   * shipped as coverage nothing can account for.
   */
  const place = (c, from) => {
    const ab = String(c.key || '').slice(0, 2).toUpperCase();
    if (/-statewide$/.test(String(c.key)) && stateOf(ab)) {
      promoted.push(`${c.key} (${from})`);
      wide.push({
        ...c,
        name: `${stateOf(ab).name} (${from})`,
        state: ab,
        statewide: true,
        fips: undefined,
      });
      return null;
    }
    if (joins(c.fips)) return c;
    const fixed = repairFips(c);
    if (fixed) {
      repaired.push(`${c.key} ${c.fips || 'none'} -> ${fixed}`);
      return { ...c, fips: fixed };
    }
    unplaceable.push(`${c.key} (${c.fips || 'no fips'}, ${from})`);
    return null;
  };

  const add = (c, from) => {
    const placed = place(c, from);
    if (!placed) return null;
    const entry = { ...placed, from, fallbacks: [...(placed.fallbacks || [])] };
    merged.push(entry);
    if (entry.fips) byFips.set(String(entry.fips), entry);
    byKey.set(entry.key, entry);
    return entry;
  };

  for (const c of atlas?.candidates || []) add(c, 'atlas');

  let joined = 0;
  let fresh = 0;
  for (const c of oa?.candidates || []) {
    /*
     * The key is the second chance, not the first. A county missing its FIPS
     * code in one catalogue and carrying it in the other would otherwise be
     * added twice under two keys, and two entries for one county means two
     * bounding boxes nominating the same address.
     */
    const held = (c.fips && byFips.get(String(c.fips))) || byKey.get(c.key);
    if (!held) { add(c, 'openaddresses'); fresh++; continue; }

    joined++;
    for (const e of endpointsOf(c)) {
      if (endpointsOf(held).some((h) => sameEndpoint(h, e))) continue;
      held.fallbacks.push(e);
    }
    /*
     * An address field from wherever one exists. OpenAddresses never has one,
     * so in practice this only ever fills in from the atlas -- but writing it
     * the other way round would silently prefer null the day that changes.
     */
    if (!held.fields?.address && c.fields?.address) {
      held.fields = { ...held.fields, address: c.fields.address };
    }
  }

  /* A state listed by both catalogues keeps the first, and the second rides
     along as a fallback -- same rule as a county. */
  const statewide = [];
  for (const s of wide) {
    const held = statewide.find((x) => x.state === s.state);
    if (!held) { statewide.push({ ...s, fallbacks: [...(s.fallbacks || [])] }); continue; }
    for (const e of endpointsOf(s)) {
      if (endpointsOf(held).some((h) => sameEndpoint(h, e))) continue;
      held.fallbacks.push(e);
    }
  }

  return {
    candidates: merged,
    /*
     * Statewide layers are a different claim and a different shape -- one
     * entry, a state code, no FIPS -- so they are kept apart rather than
     * mixed into a list the rest of the pipeline treats as counties.
     */
    statewide,
    /* What had to be corrected on the way through, so a catalogue quietly
       going wrong shows up in a run's log rather than in a count. */
    repaired,
    promoted,
    unplaceable,
    sources: {
      atlas: atlas?.candidates?.length || 0,
      openaddresses: oa?.candidates?.length || 0,
      joined,
      fresh,
      atlasVersion: atlas?.atlasVersion || null,
      atlasImportedAt: atlas?.importedAt || null,
      openaddressesImportedAt: oa?.importedAt || null,
    },
  };
}
