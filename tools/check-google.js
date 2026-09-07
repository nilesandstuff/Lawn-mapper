/**
 * Asks Google for one satellite image and prints exactly what it says back.
 *
 * A newly created key fails for several different reasons that all look
 * identical from inside the app -- the picture simply does not appear. Google,
 * however, is specific: it answers 403 with a plain sentence naming the
 * setting that is missing. This puts that sentence on screen, because reading
 * it takes a second and guessing at the Cloud console takes an evening.
 *
 * Free: a rejected request is not billed, and one accepted static map costs a
 * fraction of a cent.
 *
 *   GOOGLE_MAPS_KEY=AIza... node tools/check-google.js
 */

import { PROVIDERS } from '../worker/src/imagery.js';

const key = process.env.GOOGLE_MAPS_KEY;

/*
 * No key is a perfectly good state, not a failure. Google is optional -- the
 * app hides the source entirely without it -- so this exits clean and says so,
 * rather than painting a red cross on a deploy that has nothing wrong with it.
 */
if (!key) {
  console.log('SKIP  No GOOGLE_MAPS_KEY configured, so Google satellite is not offered.');
  console.log('      That is a supported set-up. To add it, see DEPLOY.md step 8.');
  process.exit(0);
}

/*
 * Report the key's shape, never the key.
 *
 * Google keys start AIza and run about 39 characters. Pasting a whole console
 * page, or a key with a stray newline, is a real and invisible mistake -- and
 * the length and prefix identify it without printing a live credential into a
 * public build log.
 */
console.log(`key:     ${key.slice(0, 4)}…${key.slice(-4)}  (${key.length} characters)`);
if (!key.startsWith('AIza')) {
  console.log('         WARNING: Google API keys normally start with "AIza".');
}
if (key !== key.trim()) {
  console.log('         WARNING: there is whitespace around the key. Re-paste it.');
}

/* The exact URL the Worker builds, so this tests what production sends. */
const frame = { lng: -85.8637, lat: 42.8703, zoom: 19, size: 640 };
const url = PROVIDERS.google.url(frame, null, { GOOGLE_MAPS_KEY: key });

console.log(`asking:  ${url.replace(/key=[^&]+/, 'key=REDACTED')}\n`);

const res = await fetch(url);
const type = res.headers.get('Content-Type') || '(none)';
console.log(`status:  HTTP ${res.status}   content-type: ${type}`);

if (res.ok && /^image\//.test(type)) {
  const bytes = (await res.arrayBuffer()).byteLength;
  console.log(`image:   ${bytes.toLocaleString()} bytes\n`);
  if (bytes < 5000) {
    console.log('PASS-ish  Google answered with an image, but a suspiciously small');
    console.log('          one. That is usually the "no imagery here" grey tile.');
    process.exit(0);
  }
  console.log('PASS  Google returned a real satellite image. The key works.');
  console.log('      If the app still does not show it, the secret has not reached');
  console.log('      the Worker: re-run "2. Deploy" after adding GOOGLE_MAPS_KEY.');
  process.exit(0);
}

const body = (await res.text()).slice(0, 600).replace(/\s+/g, ' ').trim();
console.log(`\nGoogle says:\n  ${body}\n`);

/*
 * Translate the message into the click that fixes it. These are Google's own
 * phrasings; anything unrecognised is passed through rather than guessed at,
 * because a confident wrong instruction is worse than the raw sentence.
 */
const fixes = [
  [/not authorized to use this API|API_NOT_ACTIVATED|has not been used in project|is disabled/i,
    'The Maps Static API is not ENABLED on the project this key belongs to.\n' +
    '  Creating a key does not enable anything. Go to:\n' +
    '  APIs & Services -> Library -> search "Maps Static API" -> Enable.\n' +
    '  Make sure the project selector at the top is the SAME project as the key.'],
  [/billing/i,
    'Billing is not linked to THIS project.\n' +
    '  Adding $20 creates a billing account; it does not attach a project to it.\n' +
    '  Go to: Billing -> Link a billing account -> pick the project.'],
  [/API key not valid|InvalidKey|provided API key is invalid/i,
    'The key itself was rejected. Re-copy it from APIs & Services -> Credentials;\n' +
    '  a truncated paste or a stray space is the usual cause.'],
  [/referer|referrer|not authorized.*referer/i,
    'The key has a WEBSITE (HTTP referrer) restriction on it.\n' +
    '  The Worker sends no Referer header, so it can never satisfy one.\n' +
    '  Set Application restrictions to None (see DEPLOY.md step 8a).'],
  [/IP address|not authorized.*ip/i,
    'The key has an IP restriction on it. Cloudflare Workers have no fixed\n' +
    '  egress IP to allow, so set Application restrictions to None.'],
  [/OVER_QUERY_LIMIT|quota/i,
    'The daily quota is spent, or set to zero. Check:\n' +
    '  APIs & Services -> Maps Static API -> Quotas.'],
];

const fix = fixes.find(([pattern]) => pattern.test(body));
if (fix) {
  console.log(`FAIL  ${fix[1]}`);
} else {
  console.log('FAIL  Unrecognised message — the sentence above is Google\'s own and');
  console.log('      names the setting. Nothing here is guessing at it for you.');
}
process.exit(1);
