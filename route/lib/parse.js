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
function splitAtBullet(words) {
  for (let i = 1; i < words.length - 1; i += 1) {
    const w = words[i];
    if (!BULLET.test(w.text.trim())) continue;
    // a real bullet stands alone between two words; a speck inside a word's box is not one
    if (w.bbox.x0 < words[i - 1].bbox.x1 - 2 || w.bbox.x1 > words[i + 1].bbox.x0 + 2) continue;
    return [words.slice(0, i), words.slice(i + 1)];
  }
  return null;
}

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
    if (w.bbox.x0 >= rightX || cx(w) > W * 0.8) {
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
      if (splitAtBullet(rows[j].words) || timeOn(rows[j])) { n = j; break; }
    }
    if (n < 0) continue;
    const address = tidy(rows.slice(i, n).map((r) => r.text).join(' '));
    const parts = splitAtBullet(rows[n].words);
    const name = parts ? tidy(parts[0].map((w) => w.text).join(' ')) : rows[n].text;
    const city = parts ? tidy(parts[1].filter((w) => isWord(w.text)).map((w) => w.text).join(' ')) : '';
    const next = rows[n + 1] && !isStart(rows[n + 1]) ? rows[n + 1].text : '';
    stops.push({ address, city, name, minutes: null, service: next, top: rows[i].y0 });
    i = n;
  }
  // each time belongs to the card it sits in: from its address down to the next card's
  for (let k = 0; k < stops.length; k += 1) {
    const top = stops[k].top - lineH * 0.5;
    const bottom = k + 1 < stops.length ? stops[k + 1].top - lineH * 0.5 : Infinity;
    const t = joined.find((x) => x.cy >= top && x.cy < bottom && x.minutes != null);
    if (t) stops[k].minutes = t.minutes;
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
