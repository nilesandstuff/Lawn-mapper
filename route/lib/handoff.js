/**
 * What Route Reader (the Android helper, route/android) read, turned into
 * what the planner already reads (route session, 2026-11-19).
 *
 * The app sends pages of on-screen text, each piece with its box in screen
 * pixels, as Android's accessibility tree gives it: often a whole line or
 * a few lines in one piece ("Pat Doe • Byron Center"). The screenshot reader
 * (parse.js parseWords) wants words with boxes, so each piece is cut into
 * its lines and words, each word given its share of the box by its letters.
 * Then each page is read as a screenshot would be, and the pages merged with
 * repeats dropped (mergeStops).
 *
 * An app that shows no text sends screenshots instead; the page reads those
 * as it reads any screenshot.
 */

import { mergeStops, parseWords, readTime, stopKey } from './parse.js';

/** A job's status badge, whatever it says: ignored (owner, 2026-11-19: "just ignore the statuses"). */
const STATUS = /^(not started|started|finished|working|paused|skipped|complete|completed|in progress|on hold|en route|on site|arrived|dispatched|scheduled|done|cancell?ed|incomplete|pending)$/i;

/** One page's pieces of text -> words with boxes. width: the screen's, to know a bar across it. */
export function pageWords(page, width = null) {
  const words = [];
  const items = page.items || [];
  const heights = items.map((it) => (it.b - it.tp) / Math.max(1, String(it.t || '').split(/\r?\n/).length)).filter((x) => x > 0).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 40;
  // a bar across the lower half of the screen starts what is pinned at its foot (the job being worked,
  // Start Day, Finish Day): nothing at or below it is part of the list (it scrolls into view higher up)
  const bottom = Math.max(0, ...items.map((it) => it.b));
  const bars = items.filter((it) => width && it.r - it.l > width * 0.9 && it.tp > bottom * 0.5).map((it) => it.tp);
  const foot = bars.length ? Math.min(...bars) : Infinity;
  for (const it of items) {
    if (it.tp >= foot - 2 || it.b > foot + lineH * 0.5) continue;
    // a card cut to a sliver at an edge: read whole on the next page
    if (it.b - it.tp < lineH * 0.5) continue;
    // a bar or button floating over the list ("Finish Day", across the foot of the screen, taller than
    // a line of text): not part of any job (found 2026-11-19: its "Day" read into an address)
    const oneLine = !String(it.t || '').includes('\n');
    // a bar or button across the screen, whatever it says or its colour (Start Day, Finish Day,
    // Complete Work, Visit 3 of 4), and anything much taller than a line
    if (width && it.r - it.l > width * 0.9) continue;
    if (oneLine && it.b - it.tp > lineH * 2.4) continue;
    if (STATUS.test(String(it.t || '').trim())) continue;
    // a label of its own at the right that is not a time ("Invisible", "Toggle calendar")
    if (width && it.l > width * 0.7 && readTime(String(it.t || '').replace(/\s+/g, '')) == null) continue;
    const lines = String(it.t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const h = (it.b - it.tp) / lines.length;
    lines.forEach((line, k) => {
      const y0 = it.tp + k * h;
      const len = line.length;
      // A text view's box is often the whole row, not its words (found 2026-11-19: "Pat Doe • Town" in
      // a box to the badge's edge put the city under the badge). Letters are about 0.38 of the line's
      // height wide; the text is taken as starting at the left, as list text does.
      const span = Math.min(it.r - it.l, Math.max(len * h * 0.38, 1));
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line))) {
        const a = m.index / len;
        const b = (m.index + m[0].length) / len;
        words.push({ text: m[0], bbox: { x0: it.l + span * a, x1: it.l + span * b, y0, y1: y0 + h } });
      }
    });
  }
  return words;
}

/**
 * The stops in a handoff's text pages, in order, each job once. On a page, a
 * card shown twice -- the job being worked, pinned at the foot with no time
 * -- counts once.
 */
export function handoffStops(h) {
  const lists = (h.pages || []).map((p) => {
    const stops = parseWords(pageWords(p, h.width), h.width, { exact: true });
    return stops.filter((s, i) => !(s.minutes == null && stops.some((o, j) => j !== i && stopKey(o) === stopKey(s) && (o.minutes != null || j < i))));
  });
  return mergeStops(lists);
}
