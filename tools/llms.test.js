/** /llms.txt says what the site is, on whatever domain served it. node tools/llms.test.js */
import assert from 'node:assert/strict';
import { llmsTxt } from '../worker/src/llms.js';

const t = llmsTxt('https://example.test');
assert.ok(t.startsWith('# Lawn Mapper\n'), 'an H1 with the name first, per llmstxt.org');
assert.match(t, /\n> /, 'then a one-paragraph summary as a blockquote');
for (const said of [/parcel maps/i, /property line/i, /aerial/i, /near-infrared/i, /lidar/i, /drawing tools/i]) {
  assert.match(t, said);
}
assert.match(t, /\(https:\/\/example\.test\/\)/, 'links are on the domain that served it');
console.log('llms.txt: ok');
