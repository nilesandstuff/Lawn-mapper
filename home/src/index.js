/**
 * nilesandstuff.com -- the home page (owner, 2026-09-30).
 *
 * Static files in home/public, served through this Worker so that the one
 * thing a static host cannot do gets done: www.<domain> is sent to the bare
 * domain, so there is one address to share and one to be indexed. http is
 * already sent to https by the zone ("Always Use HTTPS", tools/https-only.js).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
