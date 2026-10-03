/** node tools/moved-service.test.js */
import assert from 'node:assert/strict';
import { GONE, renamedCandidates } from './moved-service.js';

const root = 'https://services.arcgis.com/x/ArcGIS/rest/services';
const names = [
  { name: 'Parcel_JeffersonIL2', type: 'FeatureServer' },
  { name: 'Parcel_JeffersonCADTX', type: 'FeatureServer' },
  { name: 'Road_JeffersonIL', type: 'FeatureServer' },
  { name: 'Parcel_JeffersonIL2', type: 'MapServer' },
];
assert.deepEqual(renamedCandidates(`${root}/Parcel_JeffersonIL/FeatureServer`, names),
  [`${root}/Parcel_JeffersonIL2/FeatureServer`]);
/* A version number changed, inside a folder. */
assert.deepEqual(renamedCandidates(`${root}/Cadastral/Parcels_v1/MapServer`, [{ name: 'Cadastral/Parcels_v2', type: 'MapServer' }, { name: 'Parcels_v2', type: 'MapServer' }]),
  [`${root}/Cadastral/Parcels_v2/MapServer`]);
assert.deepEqual(renamedCandidates('https://example.com/x', names), []);
assert.ok(GONE.test('layer metadata: Invalid URL') && GONE.test('Service not found') && !GONE.test('timed out'));
console.log('moved-service: ok');
