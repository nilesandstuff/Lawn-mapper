/**
 * Stops out of a screenshot of a job list (route session, 2026-10-22).
 *
 * The input is what OCR gives back for one long screenshot: words with boxes.
 * The list it was built for is a scheduling app's "My Schedule" tab, one card
 * per job:
 *
 *     [ ] (6)  6621 Example Ct SW              NOT STARTED
 *              Pat Doe • Byron Center                  20m
 *              Fert 6 Winterizer Application
 *
 * so the page is read in three columns by position, not by OCR's own lines
 * (OCR glues the badge onto the address and the time onto the name, and
 * sometimes reads the pin's number into the street):
 *
 *   left    the checkbox and the numbered pin: dropped
 *   middle  address (one or two lines), "name • city", the service
 *   right   the status badge (dropped) and the job's minutes
 *
 * A card starts at a middle line that begins with a house number. Its name
 * line is the first line after that with the bullet or with the minutes
 * beside it; every line between is more of the address ("SW", "Drive SW").
 */

const BADGE = /^(NOT|STARTED|COMPLETED?|IN|PROGRESS|SKIPPED|CANCELL?ED|SCHEDULED|PAUSED|DONE|EN|ROUTE|ON|SITE)$/i;
/** How OCR reads the "•" between the name and the city. Never "." or "-": those are street abbreviations. */
const BULLET = /^[•·«»+*●◦°¢]+$/;
/**
 * How else OCR reads the bullet, on a line already known to be the name line:
 * a lone lowercase letter ("e", "o"), other specks, or the bullet stuck to a
 * word ("Doe«" "«Town"). Only there: on an address line these would cut it.
 */
const LOOSE = /^([•·«»+*●◦°¢©®~=|:;^\-–—]+|[a-z])$/;
const INLINE = /[•·«»●◦°¢©]/;

/**
 * Cities stops are in around here, for a name line whose bullet OCR lost:
 * "Pat Doe Byron Center" ends in a city, so that is where it splits. The
 * cities of the other stops on the same screenshot are tried too.
 */
export const KNOWN_CITIES = [
  'Ada', 'Allegan', 'Allendale', 'Alto', 'Belding', 'Belmont', 'Byron Center', 'Caledonia', 'Cascade', 'Cedar Springs',
  'Clarksville', 'Comstock Park', 'Conklin', 'Coopersville', 'Cutlerville', 'Delton', 'Dorr', 'Douglas', 'East Grand Rapids',
  'Fennville', 'Ferrysburg', 'Freeport', 'Gaines', 'Grand Haven', 'Grand Rapids', 'Grandville', 'Greenville', 'Hamilton',
  'Hastings', 'Holland', 'Hopkins', 'Hudsonville', 'Ionia', 'Jenison', 'Kalamazoo', 'Kent City', 'Kentwood', 'Lake Odessa',
  'Lowell', 'Marne', 'Martin', 'Middleville', 'Moline', 'Muskegon', 'Nashville', 'Norton Shores', 'Otsego', 'Plainwell',
  'Portage', 'Ravenna', 'Rockford', 'Saranac', 'Saugatuck', 'Shelbyville', 'Sparta', 'Spring Lake', 'Walker', 'Wayland',
  'West Olive', 'Whitehall', 'Wyoming', 'Zeeland',
];

/** Letters apart: how many edits turn a into b (small words; OCR slips). */
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * A name line with no bullet, split where it ends in a city: "Pat Doe Byron
 * Centre" -> { name: 'Pat Doe', city: 'Byron Center' }, or null. A slip of
 * one letter in six is forgiven; a stray speck before the city is dropped.
 */
export function cityAtEnd(text, cities = KNOWN_CITIES) {
  const words = String(text || '').trim().split(/\s+/);
  let best = null;
  for (const city of cities) {
    const n = city.split(' ').length;
    if (words.length <= n) continue;
    const tail = words.slice(-n).join(' ').toLowerCase().replace(/[^a-z ]/g, '');
    const want = city.toLowerCase();
    if (edits(tail, want) > Math.floor(want.length / 6)) continue;
    if (!best || n > best.n) best = { n, city };
  }
  if (!best) return null;
  const name = words.slice(0, -best.n).join(' ').replace(/\s+\S$/, (m) => (/^\s+[A-Z]$/.test(m) ? m : '')).replace(/[^A-Za-z0-9.')]+$/, '').trim();
  return name ? { name, city: best.city } : null;
}

const cx = (w) => (w.bbox.x0 + w.bbox.x1) / 2;
const cy = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Minutes in a duration as the list writes it: "20m", "1h", "1h5m", "1h 05m". OCR's "2om", "20rn" too. Null if not one. */
export function readTime(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '').replace(/rn/g, 'm')
    .replace(/mins?$/, 'm').replace(/hrs?/, 'h');
  const fix = (d) => d.replace(/[o]/g, '0').replace(/[il|]/g, '1');
  let m = t.match(/^([\doil|]{1,3})m$/);
  if (m) {
    const v = Number(fix(m[1]));
    return Number.isFinite(v) && v > 0 && v < 600 ? v : null;
  }
  m = t.match(/^([\doil|]{1,2})h(?:([\doil|]{1,2})m?)?$/);
  if (m) {
    const v = Number(fix(m[1])) * 60 + (m[2] ? Number(fix(m[2])) : 0);
    return Number.isFinite(v) && v > 0 && v < 1440 ? v : null;
  }
  return null;
}

/** Words into rows: a word joins the row whose middle is within ~half a line of its own. */
export function toRows(words) {
  const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).filter((h) => h > 4);
  const lineH = median(hs) || 20;
  const rows = [];
  for (const w of [...words].sort((a, b) => cy(a) - cy(b))) {
    const row = rows.find((r) => Math.abs(r.cy - cy(w)) < lineH * 0.55);
    if (row) {
      row.words.push(w);
      row.cy = row.words.reduce((s, x) => s + cy(x), 0) / row.words.length;
    } else rows.push({ cy: cy(w), words: [w] });
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    r.y0 = Math.min(...r.words.map((w) => w.bbox.y0));
    r.y1 = Math.max(...r.words.map((w) => w.bbox.y1));
  }
  return rows.sort((a, b) => a.cy - b.cy);
}

const tidy = (s) => s.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, '').trim();
const isWord = (t) => /[A-Za-z0-9&]/.test(t);

/** One row's middle words split at the bullet, or null when it has none. */
function splitAtBullet(words, loose = false) {
  for (let i = 1; i < words.length - 1; i += 1) {
    const w = words[i];
    if (!(loose ? LOOSE : BULLET).test(w.text.trim())) continue;
    // a real bullet stands alone between two words; a speck inside a word's box is not one
    if (w.bbox.x0 < words[i - 1].bbox.x1 - 2 || w.bbox.x1 > words[i + 1].bbox.x0 + 2) continue;
    return [words.slice(0, i), words.slice(i + 1)];
  }
  if (loose) {
    // stuck to a word: "Doe«" or "«Town" or "Doe«Town"
    for (let i = 0; i < words.length; i += 1) {
      const t = words[i].text;
      const k = t.search(INLINE);
      if (k < 0) continue;
      const left = t.slice(0, k);
      const right = t.slice(k + 1);
      const before = [...words.slice(0, i), ...(left ? [{ ...words[i], text: left }] : [])];
      const after = [...(right ? [{ ...words[i], text: right }] : []), ...words.slice(i + 1)];
      if (before.length && after.length) return [before, after];
    }
  }
  return null;
}

const INLINE_END = /[•·«»+*●◦°¢©]+$/;
/** A line whose last mark is the bullet: the name, with the city wrapped onto the next line. */
function endsInBullet(words) {
  const last = words[words.length - 1];
  if (!last || words.length < 2) return false;
  return BULLET.test(last.text.trim()) || (INLINE_END.test(last.text) && /[A-Za-z0-9]/.test(last.text));
}
/** A city on a line of its own: a few words, letters only. */
const looksLikeCity = (t) => /^[A-Za-z][A-Za-z .'-]{1,30}$/.test(String(t).trim()) && String(t).trim().split(/\s+/).length <= 3;

/**
 * The stops on one screenshot, top to bottom:
 *   [{ address, city, name, minutes, service }]
 * minutes is null where no time was read.
 *
 *   words  [{ text, bbox: { x0, y0, x1, y1 } }] in image pixels
 *   width  the image's width in the same pixels
 */
export function parseWords(words, width) {
  const W = width || Math.max(...words.map((w) => w.bbox.x1));
  const clean = words.filter((w) => w.text && w.text.trim());
  // the badge column starts where "NOT" / "COMPLETED" do; without any, about three quarters across
  const badgeX = median(clean.filter((w) => BADGE.test(w.text.trim()) && cx(w) > W * 0.5).map((w) => w.bbox.x0));
  const rightX = badgeX != null ? badgeX - W * 0.01 : W * 0.72;
  const leftX = W * 0.24;

  const middle = [];
  const times = [];
  for (const w of clean) {
    // the right column: words starting in it, or a time far right. A long city that only reaches
    // over (found 2026-11-10: "Caledonia" ending under the badge) stays in the middle
    // (the bullet too: a long name pushes it under the badge, and it is never part of the right column)
    if ((w.bbox.x0 >= rightX && !(BULLET.test(w.text.trim()) && cx(w) < W * 0.8)) || (cx(w) > W * 0.8 && readTime(w.text) != null)) {
      const t = readTime(w.text);
      // a bare "1h" may have its minutes in the next word
      if (/^\d{1,2}h$/i.test(w.text.trim())) times.push({ minutes: null, cy: cy(w), w, hours: t / 60 });
      else if (t != null) times.push({ minutes: t, cy: cy(w), w });
    } else if (cx(w) >= leftX && !(BADGE.test(w.text.trim()) && w.bbox.x0 > W * 0.5)) {
      middle.push(w);
    }
  }
  // "1h" and "5m" read as two words on one line make one time
  const joined = [];
  for (const t of times.sort((a, b) => a.cy - b.cy || a.w.bbox.x0 - b.w.bbox.x0)) {
    const prev = joined[joined.length - 1];
    if (prev && prev.hours != null && prev.minutes == null && Math.abs(prev.cy - t.cy) < 15 && t.minutes != null && t.minutes < 60) {
      prev.minutes = prev.hours * 60 + t.minutes;
    } else joined.push(t);
  }
  for (const t of joined) if (t.minutes == null && t.hours) t.minutes = t.hours * 60;

  const rows = toRows(middle).map((r) => {
    const kept = r.words.filter((w) => isWord(w.text) || BULLET.test(w.text.trim()));
    const text = tidy(kept.filter((w) => isWord(w.text)).map((w) => w.text).join(' '));
    return { ...r, words: kept, text };
  }).filter((r) => r.text);

  const lineH = median(rows.map((r) => r.y1 - r.y0)) || 20;
  const timeOn = (r) => joined.some((t) => t.cy >= r.y0 - lineH * 0.3 && t.cy <= r.y1 + lineH * 0.3);
  const isStart = (r) => /^\d{1,6}[A-Za-z]?\s+[A-Za-z0-9]/.test(r.text) && !splitAtBullet(r.words);

  const stops = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (!isStart(rows[i])) continue;
    // the name line: within the next three lines, with the bullet or the minutes beside it
    let n = -1;
    for (let j = i + 1; j < Math.min(rows.length, i + 4); j += 1) {
      if (j > i + 1 && isStart(rows[j])) break;
      if (splitAtBullet(rows[j].words) || timeOn(rows[j]) || endsInBullet(rows[j].words)) { n = j; break; }
    }
    if (n < 0) continue;
    const address = tidy(rows.slice(i, n).map((r) => r.text).join(' '));
    const parts = splitAtBullet(rows[n].words) || splitAtBullet(rows[n].words, true);
    let name = parts ? tidy(parts[0].map((w) => w.text).join(' ')) : rows[n].text;
    let city = parts ? tidy(parts[1].filter((w) => isWord(w.text)).map((w) => w.text).join(' ')) : '';
    let after = n + 1;
    // a long name wraps: "JTB DP 29 - 7931 Elm Ct •" then the city on a line of its own
    if (!city && endsInBullet(rows[n].words) && rows[after] && !isStart(rows[after]) && looksLikeCity(rows[after].text)) {
      name = tidy(rows[n].words.filter((w) => isWord(w.text)).map((w) => w.text.replace(INLINE_END, '')).join(' '));
      city = rows[after].text;
      after += 1;
    }
    const next = rows[after] && !isStart(rows[after]) ? rows[after].text : '';
    stops.push({ address, city, name, minutes: null, service: next, top: rows[i].y0 });
    i = after - 1;
  }
  // each time belongs to the card it sits in: from its address down to the next card's
  for (let k = 0; k < stops.length; k += 1) {
    const top = stops[k].top - lineH * 0.5;
    const bottom = k + 1 < stops.length ? stops[k + 1].top - lineH * 0.5 : Infinity;
    const t = joined.find((x) => x.cy >= top && x.cy < bottom && x.minutes != null);
    if (t) stops[k].minutes = t.minutes;
  }
  // name lines whose bullet OCR lost: split where they end in a city, this screenshot's cities first
  const seen = [...new Set(stops.map((s) => s.city).filter(Boolean))];
  for (const s of stops) {
    if (s.city) continue;
    const hit = cityAtEnd(s.name, seen) || cityAtEnd(s.name);
    if (hit) { s.name = hit.name; s.city = hit.city; }
  }
  return stops.map(({ top, ...s }) => s);
}

/** A key that ignores case, punctuation and "Dr"/"Drive": two screenshots of the same job agree on it. */
export function stopKey(s) {
  const words = String(s.address || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ');
}

/**
 * Stops from several screenshots (or documents), in order. Screenshots of one
 * long list overlap, so a job seen in an earlier one is dropped -- but only
 * when its time agrees too (owner, 2026-10-26: "remove duplicates ... unless
 * they show different times"): the same address with a different time is a
 * second job there. A time OCR missed (null) agrees with any, and is filled
 * in from the other copy.
 *
 * Only copies from DIFFERENT lists are matched, each earlier stop at most
 * once per list: two cards with the same address on one screenshot are two
 * jobs.
 */
export function mergeStops(lists) {
  const out = [];
  for (const list of lists) {
    const earlier = out.slice();
    const used = new Set();
    for (const s of list) {
      const k = stopKey(s);
      const free = (e) => !used.has(e) && stopKey(e) === k;
      const twin = k && (earlier.find((e) => free(e) && e.minutes === s.minutes)
        || earlier.find((e) => free(e) && (e.minutes == null || s.minutes == null)));
      if (twin) {
        used.add(twin);
        if (twin.minutes == null && s.minutes != null) twin.minutes = s.minutes;
        continue;
      }
      out.push({ ...s });
    }
  }
  return out;
}

/** Of a long image: the slices to read, each with the band of rows it alone answers for. */
export function slices(height, slice = 2400, overlap = 240) {
  const out = [];
  for (let top = 0; ; top += slice - overlap) {
    const h = Math.min(slice, height - top);
    const last = top + h >= height;
    out.push({ top, height: h, ownTop: top === 0 ? -Infinity : top + overlap / 2, ownBottom: last ? Infinity : top + h - overlap / 2 });
    if (last) return out;
  }
}

/** "6h 40m", "45m", "0m". */
export function formatMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/**
 * Does the map's answer name the street that was asked for? Same house number, and the street's first
 * word (its first four letters: "Point" finds "Pointe"). The geocoder's own confidence is no guide: it
 * says "low" for exact matches here.
 */
export function sameStreet(label, address) {
  const words = String(address || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const l = String(label || '').toLowerCase();
  if (!words.length || !/^\d/.test(words[0])) return true;
  const street = words.slice(1).find((w) => /[a-z]{2,}/.test(w));
  return l.startsWith(`${words[0]} `) && (!street || l.includes(street.slice(0, 4)));
}

/** An address with no street type ("6471 Estate") confuses the geocoder; these are tried after it, in order. */
export function addressVariants(address) {
  const a = String(address || '').trim();
  const typed = /\b(st|street|dr|drive|ave|avenue|rd|road|ct|court|ln|lane|way|blvd|cir|circle|pl|place|trl|trail|pkwy|hwy|ter|terrace|cr)\.?(\s+(n|s|e|w|ne|nw|se|sw))?$/i.test(a);
  return typed ? [a] : [a, `${a} Dr`, `${a} St`, `${a} Ct`];
}
