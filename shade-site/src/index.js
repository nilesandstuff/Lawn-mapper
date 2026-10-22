/**
 * shade.<home domain> -- the shade map at an address of its own (owner,
 * 2026-10-18: "Move the urls over to their own subdomain,
 * shade.nilesandstuff.com. Redirect the old /shade page to the new shade
 * subdomain").
 *
 * The same pages as Lawn Mapper's public/ (copied at deploy time by
 * tools/shade-prepare.js), served through this Worker so that:
 *
 *   - the shade map is at /, the trees page at /trees, the readings at /log
 *     and the admin report at /admin; the old names (/shade, /shade.html,
 *     /shade-trees, ...) are sent there, query and all, so every link and
 *     every saved map's address still lands;
 *   - every /api/ call is handed to Lawn Mapper's Worker over a service
 *     binding (LAWNMAP), addressed to its own host, as the home page's
 *     dashboard does: same-origin from here, the sign-in and guest cookies
 *     (set for the whole home domain) travel with it, and nothing
 *     cross-origin is ever allowed;
 *   - Lawn Mapper's own pages are not a second copy here: any other page is
 *     sent to Lawn Mapper's host.
 */

/** This host's pages: path -> the asset that holds it (the asset server's clean name). */
export const PAGES = { '/': '/shade', '/trees': '/shade-trees', '/log': '/shade-log', '/admin': '/shade-admin' };
/** The old names, on this host or Lawn Mapper's, -> the page here. */
export const OLD = {
  '/shade': '/', '/shade.html': '/', '/shade/': '/',
  '/shade-trees': '/trees', '/shade-trees.html': '/trees',
  '/shade-log': '/log', '/shade-log.html': '/log',
  '/shade-admin': '/admin', '/shade-admin.html': '/admin',
};

/* The site's own manifest (a manifest must come from the page's own host, and Lawn Mapper's names Lawn Mapper). */
const manifest = () => JSON.stringify({
  name: 'Shade Analyzer', short_name: 'Shade map', description: 'A lidar shade map for your lawn.',
  start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#2f7d32',
  icons: [
    { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
}, null, 2);
const robots = (host) => `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /log\nDisallow: /admin\nDisallow: /trees\nSitemap: https://${host}/sitemap.xml\n`;
const sitemap = (host) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + `  <url><loc>https://${host}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>\n`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lawnmap = env.LAWNMAP_HOST || `lawnmap.${url.hostname.split('.').slice(1).join('.')}`;
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      if (!env.LAWNMAP) return new Response(JSON.stringify({ error: 'no-lawnmap' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const to = new URL(p + url.search, `https://${lawnmap}`);
      return env.LAWNMAP.fetch(new Request(to, request));
    }
    if (OLD[p]) return Response.redirect(`https://${url.host}${OLD[p]}${url.search}`, 301);
    if (PAGES[p]) {
      const page = await env.ASSETS.fetch(new Request(new URL(PAGES[p], url), request));
      return new Response(page.body, page);
    }
    if (p === '/robots.txt') return new Response(robots(url.host), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    if (p === '/manifest.webmanifest') return new Response(manifest(), { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    if (p === '/sitemap.xml') return new Response(sitemap(url.host), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    /* Lawn Mapper's own pages live on its host, not here. */
    if (p.endsWith('.html') || !/\.[a-z0-9]{1,8}$/i.test(p)) return Response.redirect(`https://${lawnmap}${p}${url.search}`, 301);
    return env.ASSETS.fetch(request);
  },
};
