// The Census as a second opinion, when Mapbox cannot place an address near the shop.
import assert from 'node:assert/strict';
import { api } from '../src/index.js';
import { tidyLabel } from '../src/census.js';
import { testDb } from './d1.js';

assert.equal(tidyLabel('4120 JUNIPER AVE SE, FAIRVIEW, MI, 49999'), '4120 Juniper Ave SE, Fairview, MI 49999');
assert.equal(tidyLabel('100 N MAIN ST, BYRON CENTER, MI, 49315'), '100 N Main St, Byron Center, MI 49315');

const calls = [];
function world({ mapbox, census }) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.hostname);
    if (u.hostname === 'api.mapbox.com') return Response.json({ features: mapbox ? [{ geometry: { coordinates: mapbox.at }, properties: { full_address: mapbox.label } }] : [] });
    if (u.hostname === 'geocoding.geo.census.gov') return Response.json({ result: { addressMatches: census ? [{ matchedAddress: census.label, coordinates: { x: census.at[0], y: census.at[1] } }] : [] } });
    return new Response('no', { status: 404 });
  };
}
const env = { MAPBOX_TOKEN: 'pk.x', USAGE: testDb() };
const ask = async (q, w) => {
  calls.length = 0;
  const url = new URL(`https://route.example.com/api/geocode?q=${encodeURIComponent(q)}&near=-85.7268,42.7827`);
  const res = await api(new Request(url), env, url, w);
  return { status: res.status, body: await res.json(), asked: [...calls] };
};
const CENSUS = { label: '4120 JUNIPER AVE SE, FAIRVIEW, MI, 49999', at: [-85.61, 42.79] };

// Mapbox has nothing: the Census's answer, marked as such
let r = await ask('4120 Juniper ct, Fairview, MI', world({ mapbox: null, census: CENSUS }));
assert.equal(r.status, 200);
assert.deepEqual(r.body, { lng: -85.61, lat: 42.79, label: '4120 Juniper Ave SE, Fairview, MI 49999', accuracy: 'census' });
// Mapbox answers in another state: too far from the shop, the Census instead
r = await ask('4120 Juniper ct, Fairview', world({ mapbox: { label: '4120 Juniper Circle, Somewhere, Florida', at: [-80.1, 26.4] }, census: CENSUS }));
assert.equal(r.body.accuracy, 'census');
// Mapbox right: the Census is not asked
r = await ask('3581 Maple Ct SW, Fairview', world({ mapbox: { label: '3581 Maple Court Southwest, Fairview, Michigan', at: [-85.7, 42.8] }, census: CENSUS }));
assert.deepEqual(r.asked, ['api.mapbox.com']);
assert.notEqual(r.body.accuracy, 'census');
// Mapbox near but another street, the Census no better: Mapbox's answer stands (the page shows it as a guess)
r = await ask('12 Nowhere Ln, Fairview', world({ mapbox: { label: '12 Elsewhere Rd, Fairview, Michigan', at: [-85.5, 42.8] }, census: null }));
assert.equal(r.body.label, '12 Elsewhere Rd, Fairview, Michigan');
// neither: not found
r = await ask('1 Nothing St, Fairview', world({ mapbox: null, census: null }));
assert.equal(r.status, 404);
console.log('route census: ok');
