/*
 * THE WATER TOOL'S ADMIN PAGE lives on its own site, water.<home domain> (the
 * water session, 2026-10-20, at the owner's asking). The home domain is the
 * parent of Lawn Mapper's host (lawnmap.example.com -> example.com, as
 * tools/home-prepare.js derives it), so the link is made from the page's own
 * host and nothing is written into the repository. No home domain (a
 * workers.dev address, a bare domain, localhost): no link. Pure.
 */
export function waterAdminUrl(hostname) {
  const parts = String(hostname || '').trim().toLowerCase().split('.').filter(Boolean);
  if (parts.length < 3 || parts.includes('workers') || parts[parts.length - 1] === 'localhost') return null;
  return `https://water.${parts.slice(1).join('.')}/admin`;
}
