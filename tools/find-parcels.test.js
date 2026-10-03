/**
 * The pure parts of tools/find-parcels.js: names to FIPS, field guesses,
 * ranking a county's own layer over a project's copy.
 *   node tools/find-parcels.test.js
 */
import assert from 'node:assert/strict';
import { fipsFor, keyFor, guessFields, scoreOf, rank, serviceOf, extentDegrees, stateFor } from './find-parcels.js';

assert.equal(stateFor('MI').ab, 'MI');
assert.equal(stateFor('Virginia').ab, 'VA');
assert.equal(fipsFor('Prince William County', 'VA').fips, '51153');
assert.equal(fipsFor('Ottawa County', 'Michigan').fips, '26139');
/* An independent city and the county of the same name are two places. */
assert.equal(fipsFor('Fairfax city', 'VA').fips, '51600');
assert.equal(fipsFor('Fairfax County', 'VA').fips, '51059');
assert.equal(fipsFor('Atlantis County', 'VA'), null);
assert.equal(keyFor('Prince William County, VA', 'VA'), 'va-prince-william');
assert.equal(keyFor('Manassas city, VA', 'VA'), 'va-manassas-city');

assert.deepEqual(guessFields([{ name: 'OBJECTID' }, { name: 'GPIN' }, { name: 'SITE_ADDR' }]), { pin: 'GPIN', address: 'SITE_ADDR' });
assert.deepEqual(guessFields([{ name: 'ParentPIN' }, { name: 'PropertyAddress' }]), { pin: 'ParentPIN', address: 'PropertyAddress' });
assert.deepEqual(guessFields([{ name: 'OBJECTID' }]), { pin: null, address: null });

assert.deepEqual(serviceOf('https://x.gov/arcgis/rest/services/P/MapServer/2'), { service: 'https://x.gov/arcgis/rest/services/P/MapServer', layer: 2 });
assert.equal(serviceOf('https://x.gov/arcgis/rest/services/P/MapServer').layer, null);
assert.equal(serviceOf('https://example.com/page'), null);
const merc = extentDegrees({ xmin: -8630369, ymin: 4679470, xmax: -8621287, ymax: 4690554, spatialReference: { wkid: 102100 } });
assert.ok(Math.abs(merc[0] + 77.527) < 0.01 && Math.abs(merc[1] - 38.705) < 0.01);
assert.equal(extentDegrees({ xmin: 1, ymin: 1, xmax: 2, ymax: 2, spatialReference: { wkid: 2283 } }), null);

/* Prince William, 2026-10-03: the solar-siting copy ranked first by name alone. */
const place = { name: 'Prince William County, VA' };
const own = { service: 'https://gisweb.pwcva.gov/arcgis/rest/services/GTS/Cadastral/MapServer', title: '', layerName: 'Parcel', fields: { pin: 'GPIN', address: null }, count: 159918, ext: [-77.8, 38.5, -77.2, 38.9] };
const solar = { service: 'https://services2.arcgis.com/x/arcgis/rest/services/Solar_WFL1/FeatureServer', title: '', layerName: 'Parcels', fields: { pin: 'FID', address: 'ADDR' }, count: 140, ext: [-77.6, 38.6, -77.5, 38.7] };
assert.ok(scoreOf(own, place) > scoreOf(solar, place));
assert.deepEqual([solar, own].sort((a, b) => rank(a, b, place))[0], own);

console.log('find-parcels: ok');
