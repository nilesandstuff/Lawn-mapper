// worker/src/hardened.js: every Worker-built answer carries the static pages' headers.
import assert from 'node:assert/strict';
import { hardened } from '../worker/src/hardened.js';

const req = (p) => new Request(`https://lawnmap.example${p}`);
{
  const r = hardened(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://a.example' } }), req('/api/quota'));
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(r.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('Vary'), 'Origin', 'an answer that names an origin varies by it');
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store', 'an API answer with no caching rule is private and uncached');
}
{
  const r = hardened(new Response('ok', { headers: { 'Cache-Control': 'public, max-age=86400', 'Referrer-Policy': 'no-referrer' } }), req('/robots.txt'));
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=86400', 'a caching rule of its own is kept');
  assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer', 'a header already set is kept');
  assert.equal(r.headers.get('Vary'), null, 'no origin named, nothing to vary by');
}
{
  const r = hardened(Response.redirect('https://shade.example/', 301), req('/shade'));
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://shade.example/');
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000', 'a redirect, whose own headers are immutable, gets them on a copy');
}
console.log('hardened: ok');
