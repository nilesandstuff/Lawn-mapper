// Route Reader's pages: the job list's text as Android reports it, read like a screenshot. Made-up stops.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handoffStops, pageWords } from '../lib/handoff.js';
import { api } from '../src/index.js';

// one card as Android's accessibility tree gives it: a piece per text view, boxes in screen pixels
const W = 1080;
function card(top, { n, address, who, time, wrapCity = null }) {
  const items = [
    { t: String(n), l: 150, tp: top + 20, r: 200, b: top + 70 },
    { t: address, l: 290, tp: top, r: 290 + address.length * 22, b: top + 40 },
    { t: 'NOT STARTED', l: 808, tp: top + 2, r: 1019, b: top + 36 },
    { t: who, l: 290, tp: top + 56, r: 290 + who.length * 17, b: top + 90 },
    { t: 'Fert 6 Winterizer Application', l: 290, tp: top + (wrapCity ? 160 : 150), r: 711, b: top + (wrapCity ? 190 : 180) },
  ];
  if (time) items.push({ t: time, l: 978, tp: top + 58, r: 1041, b: top + 84 });
  if (wrapCity) items.push({ t: wrapCity, l: 290, tp: top + 100, r: 446, b: top + 130 });
  return items;
}
const cards = [
  { n: 1, address: '3581 Maple Ct SW', who: 'Pat Doe • Fairview', time: '20m' },
  { n: 2, address: '4644 Oak Hollow Dr SW', who: 'Sam & Lee Roe • Fairview', time: '22m' },
  { n: 3, address: '2531 Willow Dr', who: 'JTB VP 14 - 2531 Willow •', time: '1h 5m', wrapCity: 'Fairview' },
  { n: 4, address: '2839 Elm Bend Dr', who: 'Kim Low • Fairview', time: '30m' },
  { n: 5, address: '2433 Cedar Ridge Dr SW', who: 'Riley Ives • Alto', time: null },
];
const header = [{ t: 'My Schedule', l: 220, tp: 520, r: 384, b: 554 }, { t: 'Completed', l: 712, tp: 520, r: 906, b: 554 }];
// page 1: cards 1-3 and the top of 4 (its name line cut off); page 2, after a swipe: cards 3-5
const page1 = { items: [...header, ...card(660, cards[0]), ...card(900, cards[1]), ...card(1140, cards[2]), ...card(1420, cards[3]).slice(0, 3)] };
const page2 = { items: [...card(300, cards[2]), ...card(580, cards[3]), ...card(820, cards[4])] };

// pieces to words: each word its share of the box, lines split
const w = pageWords({ items: [{ t: 'Pat Doe • Fairview', l: 100, tp: 0, r: 280, b: 30 }, { t: 'a\nb', l: 0, tp: 100, r: 10, b: 140 }] });
assert.deepEqual(w.map((x) => x.text), ['Pat', 'Doe', '•', 'Fairview', 'a', 'b']);
assert.equal(w[0].bbox.x0, 100);
assert.ok(w[2].bbox.x0 > w[1].bbox.x1 - 1 && w[2].bbox.x1 < w[3].bbox.x0 + 1, 'the bullet between its neighbours');
assert.deepEqual([w[4].bbox.y0, w[5].bbox.y0], [100, 120], 'two lines, one above the other');

const stops = handoffStops({ width: W, pages: [page1, page2] });
assert.deepEqual(stops.map((s) => [s.address, s.name, s.city, s.minutes]), [
  ['3581 Maple Ct SW', 'Pat Doe', 'Fairview', 20],
  ['4644 Oak Hollow Dr SW', 'Sam & Lee Roe', 'Fairview', 22],
  ['2531 Willow Dr', 'JTB VP 14 2531 Willow', 'Fairview', 65],
  ['2839 Elm Bend Dr', 'Kim Low', 'Fairview', 30],
  ['2433 Cedar Ridge Dr SW', 'Riley Ives', 'Alto', null],
]);

// as a real phone sent it (2026-11-19, names made up): each text view's box the whole row, the badge
// FINISHED, and the Finish Day bar floating over the foot of the list
{
  const row = (top, address, who, time) => [
    { t: '7', l: 194, tp: top + 31, r: 215, b: top + 83 },
    { t: address, l: 288, tp: top, r: 826, b: top + 58 },
    { t: who, l: 288, tp: top + 58, r: 952, b: top + 107 },
    { t: 'FINISHED', l: 850, tp: top - 1, r: 1044, b: top + 59 },
    { t: time, l: 976, tp: top + 58, r: 1044, b: top + 104 },
    { t: 'Fert 6 Winterizer Application', l: 288, tp: top + 155, r: 867, b: top + 201 },
  ];
  const real = { width: 1080, pages: [{ items: [
    { t: 'Completed', l: 710, tp: 548, r: 909, b: 683 },
    ...row(731, '3581 Maple Dr', 'Avery Hartley-Longname • Fairview', '22m'),
    ...row(1087, '9018 E Cedar Drive', 'Sam & Dana Roe-Whitfield • Fairview', '27m'),
    ...row(2155, '8355 10th Ave', 'Kim Low • Fairview', '22m'),
    { t: 'Finish Day', l: 24, tp: 2100, r: 1056, b: 2244 },
  ] }] };
  const got = handoffStops(real);
  assert.deepEqual(got.map((x) => [x.address, x.name, x.city, x.minutes]), [
    ['3581 Maple Dr', 'Avery Hartley-Longname', 'Fairview', 22],
    ['9018 E Cedar Drive', 'Sam & Dana Roe-Whitfield', 'Fairview', 27],
    ['8355 10th Ave', 'Kim Low', 'Fairview', 22],
  ], 'the city kept though the box runs under the badge; the Finish Day bar not read into an address');
}

// the Worker keeps it a day under an id; the recent ones for the route key only
const data = new Map();
const kv = {
  get: async (k) => data.get(k)?.value ?? null,
  put: async (k, value, opts = {}) => { data.set(k, { value, metadata: opts.metadata, ttl: opts.expirationTtl }); },
  delete: async (k) => { data.delete(k); },
  list: async ({ prefix }) => ({ keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })) }),
};
const KEY = 'route-key';
const env = { ROUTE: kv, ROUTE_KEY_SHA256: createHash('sha256').update(KEY).digest('hex') };
const call = (path, init = {}) => { const url = new URL(`https://route.example.com${path}`); return api(new Request(url, init), env, url, async () => new Response('no')); };
const sent = { source: 'android', app: 'com.example.jobs', width: W, height: 2400, pages: [page1, page2], images: [], version: '1.3' };
let res = await call('/api/handoff', { method: 'POST', body: JSON.stringify(sent) });
assert.equal(res.status, 201);
const { id } = await res.json();
assert.equal([...data.values()][0].ttl, 86400);
assert.deepEqual(await (await call(`/api/handoff/${id}`)).json(), sent);
assert.equal((await call('/api/handoff')).status, 403);
const list = await (await call('/api/handoff', { headers: { 'X-Route-Key': KEY } })).json();
assert.deepEqual([list[0].id, list[0].app, list[0].pages], [id, 'com.example.jobs', 2]);
assert.equal((await call('/api/handoff', { method: 'POST', body: '{"pages":[]}' })).status, 400);
assert.equal((await call('/api/handoff/nosuchid123')).status, 404);
console.log('route handoff: ok');
