/**
 * What a URL-restricted Mapbox token actually allows.
 *
 * Restricting a public token to a domain is the right thing to do -- without
 * it, anyone who views the page can lift the token out of /api/config and
 * spend the owner's quota. But "the map still loads" is weak evidence that the
 * restriction is correct, for two reasons:
 *
 *   1. The site runs on a SUBDOMAIN (lawnmap.lawnanswers.online) while the
 *      restriction names the apex (lawnanswers.online). Whether one covers the
 *      other is Mapbox's rule to define, not something to assume.
 *
 *   2. This app calls Mapbox from TWO places. The browser fetches tiles and
 *      sends a Referer. The Worker fetches geocodes (/api/geocode) and
 *      satellite imagery (/api/imagery) server-side, where there is no Referer
 *      at all. A restriction that blocks refererless requests would leave the
 *      map working perfectly while address search and every detection failed.
 *
 * So ask Mapbox directly, from a machine that can reach it, and report what
 * comes back. Read-only: a geocode and a style read, both free.
 *
 *   MAPBOX_TOKEN=pk.... node tools/check-mapbox-restrictions.js [domain]
 */

/*
 * Two tokens do two different jobs, and the right answer for each is the
 * opposite of the other:
 *
 *   MAPBOX_TOKEN         goes to the browser, so it MUST be restricted.
 *   MAPBOX_SERVER_TOKEN  is used by the Worker, which sends no Referer, so it
 *                        must NOT be restricted or the Worker cannot use it.
 *
 * Checking only the first would pass a setup where the second is restricted
 * too and every geocode is quietly failing.
 */
const serverTokenValue = process.env.MAPBOX_SERVER_TOKEN || null;
const token = process.env.MAPBOX_TOKEN;
if (!token) {
  console.error(
    'FAIL  No MAPBOX_TOKEN available.\n' +
    '      Add it as a repository secret named MAPBOX_TOKEN.'
  );
  process.exit(1);
}

const APEX = process.argv[2] || 'lawnanswers.online';
const SUB = process.argv[3] || `lawnmap.${APEX}`;

if (!token.startsWith('pk.')) {
  console.log('NOTE  This token does not start with "pk." — URL restrictions apply to');
  console.log('      public tokens, so the results below may not mean what they seem.\n');
}

/*
 * Name the token without printing it.
 *
 * "The restriction is not in effect" is most often not a broken restriction
 * but a restriction applied to a DIFFERENT token than the one deployed -- an
 * account usually has several, and the default public token is easy to
 * restrict by mistake. A Mapbox token carries its own id in its payload, so
 * decoding that turns "check your tokens" into "check this row".
 *
 * Only the id and username are printed. The token itself never is.
 */
const tokenId = (t) => {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).a;
  } catch {
    return null;
  }
};

console.log(`MAPBOX_TOKEN        (browser) is token id ${tokenId(token) ?? '(unreadable)'}`);
console.log(`MAPBOX_SERVER_TOKEN (Worker)  is token id ` +
  (serverTokenValue ? tokenId(serverTokenValue) ?? '(unreadable)' : '(not set — the Worker shares the browser one)'));
console.log('Match those ids at https://account.mapbox.com/access-tokens/. The');
console.log('browser one is the restricted token; the Worker one has no');
console.log('restrictions. Two pk. tokens look identical at a glance, and putting');
console.log('them in the wrong slots breaks address search while the map still');
console.log('draws -- so the ids, not the appearance, are how to tell them apart.\n');

/* The two ways this app reaches Mapbox, as close to the real requests as a
 * check can get without spending anything. */
const CALLS = {
  // Exactly what handleGeocode sends.
  'geocode (Worker, server-side)':
    'https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({
      q: '3300 Van Buren St, Hudsonville, MI',
      access_token: token,
      country: 'us',
      types: 'address',
      limit: '1',
    }),
  // What Mapbox GL asks for first when the browser loads the map.
  'style (browser)':
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9?access_token=${token}`,
};

/* Who the request claims to be. "none" is the important one: it is what the
 * Worker sends, and what a curl with a stolen token sends. */
const ORIGINS = [
  ['no Referer at all (the Worker)', null],
  [`https://${APEX}/ (what you allowed)`, `https://${APEX}/`],
  [`https://${SUB}/ (where the site runs)`, `https://${SUB}/`],
  ['https://not-your-site.example/ (a thief)', 'https://not-your-site.example/'],
];

console.log(`Testing the Mapbox token against URL restrictions`);
console.log(`  allowed domain: ${APEX}`);
console.log(`  site runs on:   ${SUB}\n`);

const results = {};

for (const [callName, url] of Object.entries(CALLS)) {
  console.log(`--- ${callName} ---`);
  results[callName] = {};

  for (const [label, referer] of ORIGINS) {
    const headers = referer ? { Referer: referer, Origin: referer.replace(/\/$/, '') } : {};
    let line;
    try {
      const res = await fetch(url, { headers });
      const ok = res.ok;
      results[callName][label] = ok;
      line = `${ok ? 'ALLOWED' : 'BLOCKED'}  ${String(res.status).padEnd(4)} ${label}`;
      if (!ok) {
        const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
        line += `\n           ${body}`;
      }
    } catch (err) {
      results[callName][label] = null;
      line = `ERROR    ---  ${label}\n           ${err.message}`;
    }
    console.log(`  ${line}`);
  }
  console.log('');
}

/* ------------------------------------------------------------ the verdict */
console.log('='.repeat(66));

const workerKey = 'no Referer at all (the Worker)';
const subKey = `https://${SUB}/ (where the site runs)`;
const thiefKey = 'https://not-your-site.example/ (a thief)';

const geocode = results['geocode (Worker, server-side)'];
const style = results['style (browser)'];

let problems = 0;

/* ---------------------------------------- the token the Worker actually uses */
/*
 * Which token the Worker uses decides which one has to survive a refererless
 * request. Testing the browser token's refererless behaviour is only
 * meaningful when there is no separate server token to use instead.
 */
if (serverTokenValue) {
  const res = await fetch(
    'https://api.mapbox.com/search/geocode/v6/forward?' +
    new URLSearchParams({
      q: '3300 Van Buren St, Hudsonville, MI',
      access_token: serverTokenValue,
      country: 'us',
      types: 'address',
      limit: '1',
    })
  );
  if (res.ok) {
    console.log('OK       The Worker has its own token and it works without a Referer.');
    console.log('         MAPBOX_TOKEN can now be restricted as tightly as you like.');
  } else {
    problems++;
    console.log(`PROBLEM  MAPBOX_SERVER_TOKEN is rejected (${res.status}).`);
    console.log('         The Worker cannot geocode or fetch imagery, so address');
    console.log('         search fails while the map still draws normally.');
    if (results['style (browser)'][thiefKey] !== false) {
      console.log('         The browser token is meanwhile unrestricted, so the two');
      console.log('         are almost certainly SWAPPED: put the restricted token in');
      console.log('         MAPBOX_TOKEN and the unrestricted one in');
      console.log('         MAPBOX_SERVER_TOKEN, then deploy again.');
    } else {
      console.log('         Remove the URL restriction from this token: it is never');
      console.log('         sent to a browser, so it does not need one.');
    }
  }
} else if (geocode[workerKey] === false) {
  problems++;
  console.log('PROBLEM  The Worker cannot geocode.');
  console.log('         Server-side calls send no Referer, and this restriction');
  console.log('         rejects them. Address search and satellite imagery are');
  console.log('         both broken, even though the map itself still draws.');
  console.log('         Fix: add a MAPBOX_SERVER_TOKEN repository secret holding');
  console.log('         a second, unrestricted token, and deploy again.');
} else {
  console.log('OK       The Worker can geocode without a Referer.');
  console.log('         It is sharing MAPBOX_TOKEN, so do not restrict that token');
  console.log('         until you add a MAPBOX_SERVER_TOKEN secret.');
}

if (style[subKey] === false) {
  problems++;
  console.log('PROBLEM  The browser on the real site is blocked.');
  console.log(`         Add ${SUB} (or a wildcard covering it) to the token's`);
  console.log('         URL restrictions in the Mapbox account.');
} else {
  console.log(`OK       The browser on ${SUB} is allowed.`);
}

if (style[thiefKey] !== false && geocode[thiefKey] !== false) {
  problems++;
  console.log('PROBLEM  An unrelated site can use this token too.');
  console.log('         Either the restriction is not applied to this token, or it');
  console.log('         is broader than intended. Anyone can read the token out of');
  console.log('         /api/config and spend the quota.');
} else {
  console.log('OK       An unrelated origin is refused.');
}

console.log('='.repeat(66));
console.log(problems === 0
  ? '\nThe restriction is doing its job.\n'
  : `\n${problems} thing(s) to fix above.\n`);

// Diagnostic, not a gate: a red X here should prompt a look, not block a deploy.
process.exit(0);
