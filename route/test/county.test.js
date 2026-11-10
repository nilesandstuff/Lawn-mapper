// The county's parcels, asked when Mapbox cannot place an address or names another street type.
// Every address here is made up.
import assert from 'node:assert/strict';
import { api } from '../src/index.js';
import { countyGeocode, parseStreet, typeOf } from '../src/county.js';
import { testDb } from './d1.js';

assert.deepEqual(parseStreet('4120 Juniper ct, Fairview'), { num: '4120', name: 'JUNIPER', type: 'CT', key: 'JUNIPER' });
assert.deepEqual(parseStreet('100 N Main St SE'), { num: '100', name: 'MAIN', type: 'ST', key: 'MAIN' });
assert.deepEqual(parseStreet('1618 Oak Hollow'), { num: '1618', name: 'OAK HOLLOW', type: null, key: 'OAK' });
assert.equal(parseStreet('3581 Maple Cr').key, 'MAPLE', 'an odd abbreviation does not spoil the search');
assert.equal(typeOf('4120 Juniper Avenue Southeast, Fairview, Michigan'), 'AVE');

// a parcel square around a point, as ArcGIS returns it
const parcel = (lng, lat) => ({ rings: [[[lng - 1e-4, lat - 1e-4], [lng + 1e-4, lat - 1e-4], [lng + 1e-4, lat + 1e-4], [lng - 1e-4, lat + 1e-4], [lng - 1e-4, lat - 1e-4]]] });
const kentRows = [
  { attributes: { PROPERTYADDRESS: '4120 JUNIPER AVE SE      ', PROPADDRESSCITY: 'FAIRVIEW   ', PROPADDRESSSTATE_ZIPCODE: 'MI49999 ' }, geometry: parcel(-85.50, 42.80) },
  { attributes: { PROPERTYADDRESS: '4120 JUNIPER CT SE       ', PROPADDRESSCITY: 'FAIRVIEW   ', PROPADDRESSSTATE_ZIPCODE: 'MI49999 ' }, geometry: parcel(-85.47, 42.787) },
  { attributes: { PROPERTYADDRESS: '41200 OTHER RD', PROPADDRESSCITY: 'X', PROPADDRESSSTATE_ZIPCODE: 'MI1' }, geometry: parcel(-85.4, 42.9) },
];
const asked = [];
const counties = (rows = kentRows) => async (url) => {
  const u = new URL(url);
  asked.push(u.hostname);
  if (u.hostname === 'gis.kentcountymi.gov') {
    assert.equal(u.searchParams.get('where'), "PROPERTYADDRESS LIKE '4120 %JUNIPER%'");
    return Response.json({ features: rows });
  }
  if (u.hostname.startsWith('gis.')) return Response.json({ features: [] });
  if (u.hostname === 'api.mapbox.com') return Response.json({ features: [] });
  if (u.hostname === 'geocoding.geo.census.gov') return Response.json({ result: { addressMatches: [{ matchedAddress: '4120 JUNIPER AVE SE, FAIRVIEW, MI, 49999', coordinates: { x: -85.473, y: 42.784 } }] } });
  return new Response('no', { status: 404 });
};
const shop = [-85.7268, 42.7827];

// the Ct, not the Ave of the same name and number, at the middle of its parcel
let hit = await countyGeocode(counties(), '4120 Juniper ct, Fairview', shop);
assert.equal(hit.label, '4120 Juniper Ct SE, Fairview, MI 49999');
assert.ok(Math.abs(hit.lng + 85.47) < 1e-6 && Math.abs(hit.lat - 42.787) < 1e-6);
assert.equal(hit.accuracy, 'county');
// asked for the Ave: the Ave
hit = await countyGeocode(counties(), '4120 Juniper Ave', shop);
assert.equal(hit.label, '4120 Juniper Ave SE, Fairview, MI 49999');
// only the counties near the shop are asked
asked.length = 0;
await countyGeocode(counties(), '4120 Juniper ct', shop);
assert.deepEqual([...new Set(asked)].sort(), ['gis.allegancounty.org', 'gis.kentcountymi.gov', 'gis.miottawa.org']);
asked.length = 0;
assert.equal(await countyGeocode(counties(), '4120 Juniper ct', [-84.0, 42.3]), null, 'far from all three: none asked');
assert.equal(asked.length, 0);
assert.equal(await countyGeocode(counties([]), '4120 Juniper ct', shop), null);
assert.equal(await countyGeocode(counties(), 'Juniper Ct', shop), null, 'no house number, no search');

// through the Worker: Mapbox has nothing, the county answers before the Census is asked
const env = { MAPBOX_TOKEN: 'pk.x', USAGE: testDb() };
const url = new URL(`https://route.example.com/api/geocode?q=${encodeURIComponent('4120 Juniper ct, Fairview')}&near=${shop.join(',')}`);
asked.length = 0;
const body = await (await api(new Request(url), env, url, counties())).json();
assert.equal(body.label, '4120 Juniper Ct SE, Fairview, MI 49999');
assert.ok(!asked.includes('geocoding.geo.census.gov'), 'the Census not needed');
// Mapbox answers with the right name but another type: the county checked, and wins
const mapboxAve = async (u) => (new URL(u).hostname === 'api.mapbox.com'
  ? Response.json({ features: [{ geometry: { coordinates: [-85.48, 42.78] }, properties: { full_address: '4120 Juniper Avenue Southeast, Fairview, Michigan' } }] })
  : counties()(u));
const body2 = await (await api(new Request(url), env, url, mapboxAve)).json();
assert.equal(body2.accuracy, 'county');
console.log('route county: ok');
