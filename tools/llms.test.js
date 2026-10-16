/** /llms.txt says what the site is, on whatever domain served it. node tools/llms.test.js */
import assert from 'node:assert/strict';
import { llmsTxt } from '../worker/src/llms.js';

const t = llmsTxt('https://example.test');
assert.ok(t.startsWith('# Lawn Mapper\n'), 'an H1 with the name first, per llmstxt.org');
assert.match(t, /\n> /, 'then a one-paragraph summary as a blockquote');
for (const said of [/parcel maps/i, /property line/i, /aerial/i, /near-infrared/i, /lidar/i, /drawing tools/i, /shade/i, /grass type/i]) {
  assert.match(t, said);
}
assert.match(t, /\(https:\/\/example\.test\/\)/, 'links are on the domain that served it');
assert.match(t, /\(https:\/\/example\.test\/shade\)/, 'and the shade analyzer has its own link');
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
  // Still the app for a person, but a 404 a crawler will not index (a 200
  // here is a "soft 404": the front page again at every mistyped path).
  assert.equal(deep.status, 404);
  assert.equal(deep.headers.get('x-robots-tag'), 'noindex');
  assert.match(await deep.text(), /<title>app/);
  const llms = await at('/llms.txt');
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get('content-type'), /text\/markdown/);
  const robots = await (await at('/robots.txt')).text();
  assert.match(robots, /User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \//);
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
  assert.match(robots, /User-agent: Amazonbot\nUser-agent: \*\n/);
  for (const a of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot']) assert.match(robots, new RegExp(`User-agent: ${a}\\n`));
  assert.match(robots, /https:\/\/example\.test\/llms\.txt/);
  assert.match(robots, /Allow: \/shade\n/, 'the shade analyzer is named, beside the home page');
  const sitemap = await (await at('/sitemap.xml')).text();
  assert.ok(sitemap.includes('<loc>https://example.test/shade</loc>'), 'the sitemap lists the shade analyzer');
  assert.ok(!sitemap.includes('<loc>https://example.test/</loc>'), 'and not the front page, whose canonical is the home page');
  console.log('unknown files 404, unknown paths open the app as a noindex 404, robots says yes to search and AI answers: ok');
}
