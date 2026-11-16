/**
 * THE PAGE'S PATHS IN NODE (the water builder, 2026-11-16): the analysis worker (public/analyse.js) and the shade light
 * worker import '/lib/...' as the site serves it; here they resolve to the water library on disk (LIB_ROOT, set by
 * headless.mjs), and the browser's data reader to the Node one (lib/node-io.js, the low-spot tool's).
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let root = null;
export async function initialize(data) { root = data.root; }
export async function resolve(specifier, context, next) {
  if (root && specifier === '/lib/browser-io.js') return { url: pathToFileURL(join(root, 'builder/io-shim.mjs')).href, shortCircuit: true };
  if (root && specifier.startsWith('/lib/')) return { url: pathToFileURL(join(root, 'lib', specifier.slice(5))).href, shortCircuit: true };
  return next(specifier, context);
}
