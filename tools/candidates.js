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
  const byFips = new Map();
  const byKey = new Map();

  const add = (c, from) => {
    const entry = { ...c, from, fallbacks: [...(c.fallbacks || [])] };
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

  return {
    candidates: merged,
    /*
     * Statewide layers are a different claim and a different shape -- one
     * entry, a state code, no FIPS -- so they are kept apart rather than
     * mixed into a list the rest of the pipeline treats as counties.
     */
    statewide: oa?.statewide || [],
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
