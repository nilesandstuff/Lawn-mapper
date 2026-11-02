/**
 * A SMALL MARKDOWN READER for the white paper's shade map part (owner, 2026-11-02: "add a specific section that also
 * describes the shade map, ask the shade session to write the parts that you don't control"). The shade session owns
 * docs/SHADE-FOR-WATER-PAPER.md; water/tools/prepare.mjs puts it into water/public/paper.html between the
 * SHADE-MAP-PART markers at every deploy. Only what that file was asked to use: paragraphs, "### " subheadings,
 * "- " lists, **bold**, *italic*, [text](link), a "Technical note:" paragraph (boxed), and a "### References" list of
 * "S1. ..." lines. Everything else is text: the file's HTML is escaped, never run.
 */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One line's inline marks, after escaping. Links only to http(s) or the site's own paths. */
export function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]*)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** The file as HTML. h: the subheading tag (the paper's section is an h2). */
export function mdToHtml(text, { h = 'h3' } = {}) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  let refs = false;
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim());
    if (/^#{1,3}\s/.test(lines[0])) {
      const title = lines[0].replace(/^#{1,3}\s+/, '');
      refs = /^references$/i.test(title);
      out.push(`<${h}>${inline(title)}</${h}>`);
      if (lines.length > 1) lines.splice(0, 1); else continue;
    }
    if (refs) { out.push(`<ul class="refs srefs">${lines.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); continue; }
    // a block can switch between list lines and text lines with no blank line between: each run is its own piece
    const runs = [];
    for (const l of lines) {
      const bullet = /^[-*]\s/.test(l), last = runs[runs.length - 1];
      if (last && last.bullet === bullet) last.lines.push(l); else runs.push({ bullet, lines: [l] });
    }
    for (const r of runs) {
      if (r.bullet) { out.push(`<ul>${r.lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`); continue; }
      const para = r.lines.join(' ');
      const tech = /^technical note:\s*/i.exec(para);
      if (tech) out.push(`<div class="tech"><strong>Technical note</strong>${inline(para.slice(tech[0].length))}</div>`);
      else out.push(`<p>${inline(para)}</p>`);
    }
  }
  return out.join('\n');
}

/** The paper with the shade map's part put between its markers (unchanged when there is no part). */
export function withShadePart(paperHtml, md) {
  if (!md || !String(md).trim()) return paperHtml;
  return paperHtml.replace(/(<!--SHADE-MAP-PART-->)[\s\S]*?(<!--\/SHADE-MAP-PART-->)/, (_, a, b) => `${a}\n${mdToHtml(md)}\n${b}`);
}
