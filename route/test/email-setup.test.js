// The deploy's Email Routing step: switched on and routed when it may, a plain note when it may not.
import assert from 'node:assert/strict';
import { setUpEmail } from '../tools/email.mjs';

function cloudflare({ address = 'route-x@example.com', canRoute = true, enabled = false, rules = [] } = {}) {
  const calls = [];
  const state = { enabled, rules: [...rules] };
  const ok = (result) => Response.json({ success: true, result });
  const no = () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const m = init.method || 'GET';
    calls.push(`${m} ${u.pathname}`);
    if (u.pathname.endsWith('/values/inbox-address')) return address ? new Response(address) : new Response('', { status: 404 });
    if (u.pathname === '/client/v4/zones') return ok([{ id: 'z1', name: 'example.com' }]);
    if (u.pathname === '/client/v4/zones/z1/email/routing') return canRoute ? ok({ enabled: state.enabled }) : no();
    if (u.pathname === '/client/v4/zones/z1/email/routing/dns' && m === 'POST') { state.enabled = true; return ok({}); }
    if (u.pathname === '/client/v4/zones/z1/email/routing/rules' && m === 'GET') return ok(state.rules);
    if (u.pathname === '/client/v4/zones/z1/email/routing/rules' && m === 'POST') { state.rules.push({ id: 'r1', ...JSON.parse(init.body) }); return ok({ id: 'r1' }); }
    return Response.json({ success: false, errors: [{ message: `unexpected ${m} ${u.pathname}` }] });
  };
  return { fetcher, calls, state };
}

// first time: switched on, rule made, pointing the address at the Worker
let cf = cloudflare();
let r = await setUpEmail(cf.fetcher, { token: 't', account: 'a', kvId: 'k' });
assert.deepEqual(r, { ok: true, note: 'email inbox routed to the planner' });
assert.ok(cf.state.enabled);
assert.deepEqual(cf.state.rules[0].matchers, [{ type: 'literal', field: 'to', value: 'route-x@example.com' }]);
assert.deepEqual(cf.state.rules[0].actions, [{ type: 'worker', value: ['route-planner'] }]);

// every later deploy: nothing to do
cf = cloudflare({ enabled: true, rules: [{ id: 'r1', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'route-x@example.com' }], actions: [{ type: 'worker', value: ['route-planner'] }] }] });
r = await setUpEmail(cf.fetcher, { token: 't', account: 'a', kvId: 'k' });
assert.equal(r.note, 'email inbox already routed to the planner');
assert.ok(!cf.calls.some((c) => c.startsWith('POST')));

// a token without Email Routing permission: a note, and the dashboard by hand
cf = cloudflare({ canRoute: false });
r = await setUpEmail(cf.fetcher, { token: 't', account: 'a', kvId: 'k' });
assert.equal(r.ok, false);
assert.equal(r.manual, true);
assert.match(r.note, /cannot manage Email Routing/);

// no address yet, or no storage
assert.match((await setUpEmail(cloudflare({ address: '' }).fetcher, { token: 't', account: 'a', kvId: 'k' })).note, /no inbox address/);
assert.match((await setUpEmail(cloudflare().fetcher, { token: 't', account: 'a' })).note, /no storage/);
console.log('route email setup: ok');
