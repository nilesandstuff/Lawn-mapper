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
  const robots = await (await at('/robots.txt')).text();
  assert.match(robots, /User-agent: \*\nContent-Signal: search=yes, ai-input=yes\nAllow: \//);
  assert.match(robots, /Disallow: \/api\//);
  // Google runs app.js when it renders the page; a forbidden /api/config
  // showed it "The map didn't load" over the landing (2026-10-08).
  assert.match(robots, /Allow: \/api\/config\n/);
  assert.match(robots, /Allow: \/api\/coverage\n/);
  // Named crawlers share the wildcard's rules: one group, so none of them
  // escapes Disallow: /api/ by having a group of its own.
  for (const a of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot']) {
    assert.match(robots, new RegExp(`User-agent: ${a}\\n`));
  }
  assert.equal((robots.match(/Disallow:/g) || []).length, 1, 'one group, one set of rules');
  assert.match(robots, /User-agent: MistralAI-User\nUser-agent: \*\n/);
  assert.match(robots, /https:\/\/example\.test\/llms\.txt/);
  console.log('unknown files 404, deep links still open the app, robots says yes to search and AI answers: ok');
}
