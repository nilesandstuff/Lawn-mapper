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

import { mergeStops, parseWords } from './parse.js';

/** One page's pieces of text -> words with boxes. width: the screen's, to know a bar across it. */
export function pageWords(page, width = null) {
  const words = [];
  const items = page.items || [];
  const heights = items.map((it) => (it.b - it.tp) / Math.max(1, String(it.t || '').split(/\r?\n/).length)).filter((x) => x > 0).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 40;
  for (const it of items) {
    // a bar or button floating over the list ("Finish Day", across the foot of the screen, taller than
    // a line of text): not part of any job (found 2026-11-19: its "Day" read into an address)
    const oneLine = !String(it.t || '').includes('\n');
    if (width && it.r - it.l > width * 0.9) continue;
    if (oneLine && it.b - it.tp > lineH * 2.4) continue;
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

/** The stops in a handoff's text pages, in order, each job once. */
export function handoffStops(h) {
  const lists = (h.pages || []).map((p) => parseWords(pageWords(p, h.width), h.width));
  return mergeStops(lists);
}
