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

/** One page's pieces of text -> words with boxes. */
export function pageWords(page) {
  const words = [];
  for (const it of page.items || []) {
    const lines = String(it.t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const h = (it.b - it.tp) / lines.length;
    lines.forEach((line, k) => {
      const y0 = it.tp + k * h;
      const len = line.length;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line))) {
        const a = m.index / len;
        const b = (m.index + m[0].length) / len;
        words.push({ text: m[0], bbox: { x0: it.l + (it.r - it.l) * a, x1: it.l + (it.r - it.l) * b, y0, y1: y0 + h } });
      }
    });
  }
  return words;
}

/** The stops in a handoff's text pages, in order, each job once. */
export function handoffStops(h) {
  const lists = (h.pages || []).map((p) => parseWords(pageWords(p), h.width));
  return mergeStops(lists);
}
