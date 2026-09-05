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
try {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  console.log(`This is token id ${claims.a} on account "${claims.u}".`);
  console.log('Find that id at https://account.mapbox.com/access-tokens/ to see');
  console.log('which token the results below are actually describing.\n');
} catch {
  console.log('NOTE  Could not read the token id out of the token.\n');
}

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

if (geocode[workerKey] === false) {
  problems++;
  console.log('PROBLEM  The Worker cannot geocode.');
  console.log('         Server-side calls send no Referer, and this restriction');
  console.log('         rejects them. Address search and satellite imagery are');
  console.log('         both broken, even though the map itself still draws.');
  console.log('         Fix: give the Worker its own unrestricted token, kept as');
  console.log('         a Cloudflare secret and never sent to the browser, and');
  console.log('         leave the restricted one for /api/config.');
} else {
  console.log('OK       The Worker can still geocode without a Referer.');
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
