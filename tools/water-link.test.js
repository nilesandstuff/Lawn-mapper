// public/lib/water-link.js: the water admin link from Lawn Mapper's own host, or none.
import assert from 'node:assert/strict';
import { waterAdminUrl } from '../public/lib/water-link.js';
assert.equal(waterAdminUrl('lawnmap.example.com'), 'https://water.example.com/admin');
assert.equal(waterAdminUrl('Lawnmap.Example.Co.UK'), 'https://water.example.co.uk/admin', 'lower-cased, deeper domains kept');
assert.equal(waterAdminUrl('lawn-mapper.someone.workers.dev'), null, 'no home domain on workers.dev');
assert.equal(waterAdminUrl('example.com'), null, 'a bare domain has no sibling');
assert.equal(waterAdminUrl('app.localhost'), null);
assert.equal(waterAdminUrl(''), null);
console.log('water-link: ok');
