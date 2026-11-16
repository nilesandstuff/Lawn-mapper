// The main Worker as deployed (wrangler.toml main): the site (index.js) and its private entrypoint for the water
// site (internal.js), side by side. The tests import index.js alone.
export { default } from './index.js';
export { Internal } from './internal.js';
