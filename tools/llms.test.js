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

/* Lighthouse, 2026-10-04: a file that is not here is a 404, not the app; a
   path with no extension is still a deep link into the app. */
{
  const { default: worker } = await import('../worker/src/index.js');
  const env = { ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html' } }) } };
  const at = (p) => worker.fetch(new Request(`https://example.test${p}`), env, { waitUntil() {} });
  assert.equal((await at('/.well-known/ai-catalog.json')).status, 404);
  assert.equal((await at('/missing.json')).status, 404);
  const deep = await at('/some/deep/link');
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /<title>app/);
  const llms = await at('/llms.txt');
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get('content-type'), /text\/markdown/);
  console.log('unknown files 404, deep links still open the app: ok');
}
