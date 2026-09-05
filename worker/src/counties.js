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
 * VERIFICATION STATUS: service roots below were confirmed to exist and
 * respond publicly. The `layer` index and `fields` for each still need a
 * live probe (see probe-counties.js) -- layer numbering shifts when a county
 * republishes a service, so these are starting values, not gospel.
 */

const COUNTIES = {
  kent: {
    name: 'Kent County',
    fips: '26081',
    service: 'https://gis.kentcountymi.gov/arcgis/rest/services/Public/ParcelsWithCondos/MapServer',
    layer: 0,
    fields: { pin: 'PARCELNO', address: 'PROPADDRESS', city: 'PROPCITY' },
    verified: 'root',
  },
  ottawa: {
    name: 'Ottawa County',
    fips: '26139',
    service: 'https://gis.co.ottawa.mi.us/gisweb/rest/services/layers/Parcel/MapServer',
    layer: 1,
    // Field names confirmed via the OpenAddresses source definition.
    fields: {
      pin: 'PARCELID',
      streetNum: 'PROPSTREETNUM',
      streetName: 'PROPSTREETNAME',
      address: 'ADDRESS',
      city: 'PROPCITY',
      zip: 'PROPZIP',
    },
    verified: 'fields',
  },
  allegan: {
    name: 'Allegan County',
    fips: '26005',
    service: 'https://gis.allegancounty.org/server/rest/services/Parcel_Viewer_Map_v1_MIL1/MapServer',
    layer: 0,
    fields: { pin: 'PARCELID', address: 'SITEADDRESS' },
    verified: 'root',
  },
  muskegon: {
    name: 'Muskegon County',
    fips: '26121',
    service: 'https://maps.muskegoncountygis.com/arcgis/rest/services/PropertyViewer/MapServer',
    // "Parcels - LS" appears at index 25 in the published layer list.
    layer: 25,
    fields: { pin: 'PARCELID', address: 'SITEADDRESS' },
    verified: 'root',
  },
  newaygo: {
    name: 'Newaygo County',
    fips: '26123',
    service: null, // no confirmed public REST endpoint yet -- needs research
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
  ottawa:   [-86.24, 42.76, -85.78, 43.20],
  allegan:  [-86.22, 42.42, -85.54, 42.78],
  muskegon: [-86.55, 43.11, -85.77, 43.55],
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
