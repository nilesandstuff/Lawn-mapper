/**
 * The name a saved picture of the lawn is downloaded under (owner,
 * 2026-10-27: "title the downloaded file as the house number and street").
 * The address's first part, before the city: "1234 Example St, Anytown,
 * MI" gives "1234 Example St.png". A point with no address (two coordinates),
 * or nothing at all, keeps the old name.
 *
 * The name exists only in the visitor's own browser; it is never sent
 * anywhere or kept.
 */
export const FALLBACK_NAME = 'lawn-measurement';

export function fileNameFor(label, ext = 'png') {
  const first = String(label || '').split(',')[0];
  const clean = first
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  const bare = /^-?\d+(\.\d+)?$/.test(clean); // "42.83547" from a "lat, lng" label
  return `${clean && !bare ? clean : FALLBACK_NAME}.${ext}`;
}
