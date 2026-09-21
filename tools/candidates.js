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
 * STATEWIDE LAYERS NEITHER CATALOGUE LISTS, found by asking ArcGIS Online.
 *
 * OpenAddresses carries nineteen statewide parcel services and the atlas
 * carries none, so thirty-one states were being covered county by county or
 * not at all -- while their state governments publish one endpoint for the
 * whole state. A statewide layer is worth more than any county in the pool
 * and there is no catalogue that collects them, so they are collected here.
 *
 * FOUND, NOT INVENTED. Each of these came back from a search of ArcGIS
 * Online for that state's parcels, was filtered down to services whose own
 * published extent spans the state, and then had its layer index and field
 * names read off the service itself. What is written below is what the
 * service said about itself -- not a guess at a URL, which is the failure
 * mode the whole verifier exists to catch.
 *
 * AND NOT YET PROVEN. Listing one here only enters it in the pool: it still
 * has to answer twenty-five spread points inside its own state before it
 * reaches the registry, exactly like everything else. Expect some of these
 * to fail -- they are in the pool because they are worth asking about, not
 * because they work.
 *
 * Here rather than in a candidates file for the same reason MOVED_HOSTS is
 * in the verifier: the importers regenerate those files from the catalogues,
 * so anything hand-added to one is gone by the next run.
 *
 * TWO THAT ARE NOT HERE, so nobody spends the search again:
 *   OK  maps.owrb.ok.gov/.../Hazard/Parcels answers with a connection
 *       timeout, twice. The service may be real; nothing here has seen it.
 *   IL  no statewide parcel service exists that a search can find. Illinois
 *       publishes by county.
 * Regrid's nationwide parcel layer covers every state and is deliberately
 * ignored: it is a cached tile service with no query, and commercial.
 */
const FOUND_STATEWIDE = [
  ['FL', 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer', 0, 'PARCEL_ID', 'PHY_ADDR1'],
  /* Layer 25, "Statewide TMKs", inside a service that is mostly zoning. */
  ['HI', 'https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer', 25, 'tmk_txt', null],
  /* 2017 vintage and labelled as such by its publisher. Parcel lines move
     slowly, but this is the oldest thing in the pool by years. */
  ['IA', 'https://services3.arcgis.com/kd9gaiUExYqUbnoq/arcgis/rest/services/Iowa_Parcels_2017/FeatureServer', 0, 'PARCELNUMB', null],
  /* Organized towns only: Maine's unorganized territory is not in it. */
  ['ME', 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/Maine_Parcels_Organized_Towns/FeatureServer', 10, 'MAP_BK_LOT', 'PROP_LOC'],
  ['MT', 'https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/Montana_Cadastral_Framework/FeatureServer', 1, 'PARCELID', 'AddressLine1'],
  /* Layer 1 is the polygons; layer 0 is the same parcels as points and would
     fail every area check in the verifier. */
  ['NC', 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer', 1, 'parno', 'siteadd'],
  ['NJ', 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer', 0, 'PAMS_PIN', 'PROP_LOC'],
  ['NV', 'https://arcgis.water.nv.gov/arcgis/rest/services/BaseLayers/County_Parcels_in_Nevada/MapServer', 0, 'APN', null],
  ['RI', 'https://risegis.ri.gov/hosting/rest/services/RIDEM/Tax_Parcels/MapServer', 0, 'PlatLot', 'E911'],
  ['TN', 'https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/Tennessee_Property_Boundaries_Public_Use/FeatureServer', 0, 'PARCELID', 'ADDRESS'],
  ['WI', 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer', 0, 'PARCELID', 'SITEADRESS'],
  ['WY', 'https://services3.arcgis.com/r0iJ85SKZ4zAzz3P/arcgis/rest/services/Wyoming_Parcels_for_2026/FeatureServer', 0, 'parcelnb', 'locationad'],
];

/** The found list in the shape the statewide pool already uses. */
const foundStatewide = () => FOUND_STATEWIDE.map(([ab, service, layer, pin, address]) => ({
  key: `${ab.toLowerCase()}-statewide`,
  name: `${stateOf(ab)?.name || ab} (found)`,
  state: ab,
  statewide: true,
  service,
  layer,
  layerName: null,
  fields: { pin, address },
  fallbacks: [],
}));

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
  /* The catalogue's statewide entries first, so one that is in both lists
     keeps the catalogue's fields and the found endpoint rides along as a
     fallback -- the same rule a county in both catalogues gets. */
  const wide = [...(oa?.statewide || []), ...foundStatewide()];
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
      foundStatewide: FOUND_STATEWIDE.length,
      joined,
      fresh,
      atlasVersion: atlas?.atlasVersion || null,
      atlasImportedAt: atlas?.importedAt || null,
      openaddressesImportedAt: oa?.importedAt || null,
    },
  };
}
