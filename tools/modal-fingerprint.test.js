/**
 * The live server's fingerprint covers what it runs and nothing the site
 * alone uses (tools/modal-fingerprint.js).
 *
 *   node tools/modal-fingerprint.test.js
 */
import { serverFiles, fingerprint, importsOf } from './modal-fingerprint.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const files = serverFiles();
check('the server and its Python are covered',
  files.includes('tools/modal_serve.py') && files.includes('tools/alpha_infer.py') && files.includes('tools/alpha_sources.py'));
check('serve-alpha.mjs and what it imports are covered',
  files.includes('tools/serve-alpha.mjs') && files.includes('tools/stage3.js') && files.includes('public/lib/mercator.js'));
check('a site-only file is not: the Worker entry, the app, the coverage list',
  !files.includes('worker/src/index.js') && !files.includes('public/app.js') && !files.includes('public/lib/coverage-ui.js'),
  files.filter((f) => /index\.js|app\.js|coverage-ui/.test(f)).join(', '));
check('nor the database helper, the deploy script or the county registry the nightly search rewrites',
  !files.some((f) => /corpus-db|ci-prepare|counties-verified|landing-coverage/.test(f)));
check('no tests', !files.some((f) => /\.test\.|_test\.py$/.test(f)));
check('the fingerprint is stable', fingerprint(files) === fingerprint(files) && /^[0-9a-f]{16}$/.test(fingerprint(files)));
check('a dynamic import counts as an import',
  importsOf('/r/tools/a.js', "const m = await import('./b.js'); import x from '../c.js';").join() === '/r/tools/b.js,/r/c.js');

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
