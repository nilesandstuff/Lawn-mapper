/**
 * County parcel GIS registry -- West Michigan coverage area.
 *
 * Every county runs its own ArcGIS server with its own service path, layer
 * index, field names, and native spatial reference. Muskegon publishes in
 * EPSG:2253 (Michigan South State Plane, feet); Allegan in EPSG:3857. We
 * never deal with that: every query sends outSR=4326 so ArcGIS reprojects
 * server-side and we always get back WGS84 lng/lat, which is what area.js
 * requires.
 *
 * VERIFICATION STATUS: everything below marked `live` was found by
 * tools/discover-counties.js and confirmed by an actual point query that
 * returned a parcel-sized polygon. Re-run the "Find county servers" workflow
 * if lookups start failing -- counties republish these without notice, and
 * every endpoint in the first version of this file had already gone stale.
 */

const COUNTIES = {
  kent: {
    name: 'Kent County',
    fips: '26081',
    // Kent was written off as having no public endpoint. It has one -- the
    // server just runs under the instance name "agisprod" rather than the
    // conventional "arcgis" or "server", so every path the discovery tool
    // could invent 404'd. This is Grand Rapids, the largest population in the
    // coverage area, and it was never actually missing.
    service: 'https://gis.kentcountymi.gov/agisprod/rest/services/FGDBParcels/MapServer',
    layer: 0, // FGDBParcels
    fields: { pin: 'PNUM', address: 'PROPERTYADDRESS' },
    verified: 'live',
  },
  ottawa: {
    name: 'Ottawa County',
    fips: '26139',
    service: 'https://gis.miottawa.org/arcgis/rest/services/Hosted/AR_ParcelSearch_gdb/FeatureServer',
    layer: 6, // Ottawa_County_Parcels
    // `finalpin` is the parcel identifier; the discovery tool's first guess
    // was `propertyzip`, which merely happened to sort earlier.
    fields: { pin: 'finalpin', address: 'propertyaddress' },
    verified: 'live', // 3.3 ac at 3300 Van Buren St, Hudsonville
  },
  allegan: {
    name: 'Allegan County',
    fips: '26005',
    service: 'https://gis.allegancounty.org/server/rest/services/Parcel_Drafter_MIL1/MapServer',
    layer: 0, // Parcels
    // This layer has no single full-address column, so the address is composed
    // from its parts. MAPPING_ID is the parcel identifier.
    fields: {
      pin: 'MAPPING_ID',
      streetNum: 'propaddrnu',
      // propStreet came back blank on every parcel sampled; propstre_1 is the
      // street name in this BS&A-style export. Worst case the address renders
      // as the house number alone, which is what it already did.
      streetName: 'propstre_1',
    },
    verified: 'live',
  },
  muskegon: {
    name: 'Muskegon County',
    fips: '26121',
    service: 'https://maps.muskegoncountygis.com/arcgis/rest/services/PropertyViewer/MapServer',
    // Layer 20 ("Parcels") rejects point queries outright; 23 answers them.
    layer: 23, // Parcels - SS
    // Property_Address_Combined is the whole address; Property_Address_Num is
    // just the house number, which is what a naive field match picks first.
    fields: { pin: 'PIN', address: 'Property_Address_Combined' },
    verified: 'live', // 0.633 ac, PIN 61-27-118-300-0001-00, Norton Shores
  },
  newaygo: {
    name: 'Newaygo County',
    fips: '26123',
    service: null, // no public REST endpoint found -- needs a call to their GIS office
    layer: null,
    fields: {},
    verified: 'none',
  },
};

/**
 * Rough bounding boxes, used to pick which county to query from a geocoded
 * point without making five network calls. Deliberately generous: a wrong
 * guess costs one failed query and we fall through to the next candidate.
 * [minLng, minLat, maxLng, maxLat]
 */
const COUNTY_BBOX = {
  kent:     [-85.80, 42.76, -85.31, 43.29],
  // The Ottawa/Allegan line runs at roughly 42.84, through Holland. The old
  // values put Ottawa's southern edge below it and Allegan's northern edge
  // above nothing at all, so Holland addresses were attributed to the wrong
  // county. They overlap slightly on purpose: a point in the overlap simply
  // tries both, and the first county to return a parcel wins.
  ottawa:   [-86.24, 42.83, -85.78, 43.20],
  allegan:  [-86.22, 42.42, -85.54, 42.85],
  muskegon: [-86.55, 43.10, -85.77, 43.55],
  newaygo:  [-86.05, 43.29, -85.53, 43.82],
};

function candidateCounties(lng, lat) {
  return Object.entries(COUNTY_BBOX)
    .filter(([, [w, s, e, n]]) => lng >= w && lng <= e && lat >= s && lat <= n)
    .map(([key]) => key)
    .filter((key) => COUNTIES[key].service);
}

function isCovered(lng, lat) {
  return candidateCounties(lng, lat).length > 0;
}

export { COUNTIES, COUNTY_BBOX, candidateCounties, isCovered };
