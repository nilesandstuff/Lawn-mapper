/**
 * Tests the CI config rewriting.
 *
 * This code only ever runs inside a GitHub Actions runner, where a mistake
 * shows up as a failed deploy with a confusing message and no easy way to
 * poke at it -- particularly for someone driving the whole thing from a
 * phone. So the parsing and rewriting are pure functions, and they get
 * checked here against the shapes wrangler actually emits.
 *
 *   node tools/ci-prepare.test.js
 */

import { readFileSync } from 'node:fs';
import {
  parseNamespaceList,
  pickQuota,
  parseCreatedId,
  applyConfig,
  bucketExists,
  bucketFailureHelp,
  fillSiteOrigin,
} from './ci-prepare.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/* ------------------------------------------------------ namespace listing */
{
  // Wrangler prefixes the payload with banners and, in CI, a proxy warning.
  const noisy = `
 ⛅️ wrangler 4.129.0
────────────────────
[
  { "id": "${ID}", "title": "lawn-mapper-QUOTA", "supports_url_encoding": true },
  { "id": "ffffffffffffffffffffffffffffffff", "title": "some-other-thing" }
]
`;
  const list = parseNamespaceList(noisy);
  check('parses a namespace list out of noisy output', list.length === 2, `got ${list.length}`);
  check('picks the QUOTA namespace', pickQuota(list)?.id === ID, pickQuota(list)?.title);

  check('empty output yields no namespaces', parseNamespaceList('').length === 0);
  check('malformed JSON yields no namespaces', parseNamespaceList('[not json').length === 0);
  check('no QUOTA namespace returns null',
    pickQuota([{ id: ID, title: 'unrelated' }]) === null);

  // A second worker in the same account could own a similarly named store;
  // an exact -QUOTA suffix should win over a loose substring match.
  const both = [
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'other-QUOTA-archive' },
    { id: ID, title: 'lawn-mapper-QUOTA' },
  ];
  check('prefers an exact QUOTA suffix', pickQuota(both).id === ID, pickQuota(both).title);
}

/* ------------------------------------------------------ namespace creation */
{
  const tomlStyle = `
🌀 Creating namespace with title "lawn-mapper-QUOTA"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "QUOTA"
id = "${ID}"
`;
  check('reads the id from toml-style create output', parseCreatedId(tomlStyle) === ID);

  const jsonStyle = `{ "id": "${ID}", "title": "lawn-mapper-QUOTA" }`;
  check('reads the id from json-style create output', parseCreatedId(jsonStyle) === ID);

  check('returns null when there is no id', parseCreatedId('something went wrong') === null);
}

/* --------------------------------------------------------- config rewrite */
const BASE = `name = "lawn-mapper"
main = "worker/src/index.js"

[[kv_namespaces]]
binding = "QUOTA"
id = "REPLACE_WITH_KV_NAMESPACE_ID"

# [[routes]]
# pattern = "lawnanswers.online"
# custom_domain = true
`;

{
  const out = applyConfig(BASE, { kvId: ID });
  check('substitutes the KV id', out.includes(`id = "${ID}"`));
  check('leaves no placeholder behind', !out.includes('REPLACE_WITH_KV_NAMESPACE_ID'));
  check('does not add a route when no domain is given', !/^\s*\[\[routes\]\]/m.test(out));
}

{
  const out = applyConfig(BASE, { kvId: ID, customDomain: 'lawnanswers.online' });
  check('appends a custom domain route', /^\[\[routes\]\]$/m.test(out));
  check('route names the domain', out.includes('pattern = "lawnanswers.online"'));
  check('route is marked as a custom domain', out.includes('custom_domain = true'));
  // The commented example must not be revived into a second, conflicting route.
  const realRoutes = out.split('\n').filter((l) => /^\s*\[\[routes\]\]/.test(l)).length;
  check('exactly one active route block', realRoutes === 1, `found ${realRoutes}`);
}

{
  // Guard against silently stacking a second route on a hand-configured file.
  const already = BASE + '\n[[routes]]\npattern = "example.com"\ncustom_domain = true\n';
  let threw = false;
  try {
    applyConfig(already, { kvId: ID, customDomain: 'lawnanswers.online' });
  } catch {
    threw = true;
  }
  check('refuses to add a duplicate route block', threw);
}

/* ------------------------------------------------------- the corpus bucket */
/*
 * R2 is the third resource this file conjures, and the only one where the
 * binding names the thing rather than an id -- so nothing is substituted and
 * the only question is whether the bucket exists.
 */
{
  const json = 'Listing buckets...\n'
    + '[{"name":"lawn-mapper-corpus","creation_date":"2026-09-14"},{"name":"other"}]\n';
  check('finds a bucket in JSON output, banners and all',
    bucketExists(json, 'lawn-mapper-corpus') === true);
  check('and does not invent one that is absent',
    bucketExists(json, 'nope') === false);

  /*
   * Older wrangler prints a table instead of JSON. Weaker evidence than a
   * parsed row, and still the difference between reusing a bucket and trying
   * to create one that is already there.
   */
  const table = 'name                    creation_date\nlawn-mapper-corpus      2026-09-14\n';
  check('falls back to the text when the output is a table',
    bucketExists(table, 'lawn-mapper-corpus') === true);
  check('and a near-miss name does not count as a match',
    bucketExists('lawn-mapper-corpus-old\n', 'lawn-mapper-corpus') === false);

  /*
   * THE ONE THAT MATTERS. Wrangler refuses to deploy a Worker bound to a
   * bucket that does not exist, so leaving the block in when R2 is unavailable
   * would take the whole site down over a corpus nobody set up. Same rule the
   * database follows.
   */
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const without = applyConfig(toml, { kvId: 'k', dbId: 'd', bucket: false });
  check('no bucket means the binding is removed, not left dangling',
    !/\[\[r2_buckets\]\]/.test(without),
    'a binding to a missing bucket fails the deploy');
  /*
   * BOTH SIDES of the block, which the first version of this check missed.
   * The R2 binding sits near the end of the file, so a strip that ran to EOF
   * left every earlier block intact and passed -- while quietly deleting the
   * secrets note and the routes comment that follow it, and with them the
   * custom-domain machinery appended afterwards.
   */
  check('and the rest of the config survives its removal',
    /\[assets\]/.test(without) && /\[\[kv_namespaces\]\]/.test(without)
      && /\[\[d1_databases\]\]/.test(without)
      && /Secrets are NOT set here/.test(without),
    'the blocks after it go on existing too');

  check('a bucket that exists keeps its binding',
    /\[\[r2_buckets\]\]/.test(applyConfig(toml, { kvId: 'k', dbId: 'd', bucket: true })));
  check('and the default is to keep it',
    /\[\[r2_buckets\]\]/.test(applyConfig(toml, { kvId: 'k', dbId: 'd' })),
    'only an explicit false strips the block');
}

/*
 * WHAT TO DO ABOUT A BUCKET THAT WOULD NOT BE CREATED.
 *
 * Checked against the message Cloudflare ACTUALLY sent, which is the point of
 * this group: the old wording led with "usually the API token" on reasoning
 * that sounded right, and the real blocker was an account-level switch. Anyone
 * following it would have edited a token that was already correct.
 */
{
  const enable = bucketFailureHelp(
    'A request to the Cloudflare API (/accounts/xxx/r2/buckets) failed. '
      + 'Please enable R2 through the Cloudflare Dashboard. [code: 10042]',
    'lawn-mapper-corpus'
  ).join('\n');

  check('the real 10042 message is told to enable R2 on the account',
    /account-level/.test(enable) && /R2 -> and accept the terms/.test(enable));
  check('and is NOT sent to edit the API token',
    !/Workers R2 Storage: Edit/.test(enable),
    'that was the wrong first guess, and it cost a deploy');

  const token = bucketFailureHelp(
    'Authentication error [code: 10000]', 'lawn-mapper-corpus'
  ).join('\n');
  check('an authentication failure is sent to the token instead',
    /Workers R2 Storage: Edit/.test(token));
  check('and is not told to go and enable R2',
    !/accept the terms/.test(token));

  /* The code survives rewording; the prose may not. Both are matched. */
  check('the code alone is enough, without the sentence',
    /account-level/.test(bucketFailureHelp('failed [code: 10042]', 'b').join('\n')));

  const unknown = bucketFailureHelp('something nobody predicted', 'b').join('\n');
  check('an unrecognised error offers both rather than asserting one',
    /account-level/.test(unknown) && /Workers R2 Storage: Edit/.test(unknown),
    'guessing wrong is what this group exists to stop');

  check('every case says training images are off and the site is fine',
    [enable, token, unknown].every((t) => /TRAINING IMAGES ARE OFF/.test(t)
      && /Everything else is/.test(t)));
  check('and every case names the bucket for the by-hand route',
    /"lawn-mapper-corpus"/.test(enable) && /"lawn-mapper-corpus"/.test(token));
}

/* The share and search tags get the real address, or go. */
{
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const filled = fillSiteOrigin(page, 'lawnmap.example.com');
  check('the domain fills every placeholder', !filled.includes('__SITE__')
    && filled.includes('<link rel="canonical" href="https://lawnmap.example.com/">')
    && filled.includes('content="https://lawnmap.example.com/og-image.png"'));
  const none = fillSiteOrigin(page, null);
  check('with no domain the lines go, and nothing else does',
    !none.includes('__SITE__') && !none.includes('rel="canonical"') && none.includes('og:title'));
  const ld = (s) => JSON.parse(s.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  check('the structured data is still JSON either way',
    ld(filled).url === 'https://lawnmap.example.com/' && ld(none).name === 'Lawn Mapper' && !('url' in ld(none)));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
