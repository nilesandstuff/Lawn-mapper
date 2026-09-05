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

import {
  parseNamespaceList,
  pickQuota,
  parseCreatedId,
  applyConfig,
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
