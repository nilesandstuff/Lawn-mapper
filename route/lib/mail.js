/**
 * An email, taken apart (route session, 2026-10-27).
 *
 * Route sheets reach the planner by email (src/inbox.js): Service Autopilot
 * emails them from the Dispatch Board, or someone forwards one. This reads the
 * raw message (RFC 822 / MIME) into what the page needs:
 *
 *   { from, to, subject, date, text, html, attachments: [{ name, type, bytes }] }
 *
 * Multipart at any depth; base64 and quoted-printable; encoded headers
 * (=?UTF-8?B?...?=) and filenames (filename*=UTF-8''...); a message forwarded
 * as an attachment (message/rfc822) is opened too, its parts joining this
 * one's. The first text/plain and text/html that are not attachments are the
 * body. Written here rather than taken from a package so the route planner
 * adds nothing to the repository's dependencies.
 */

const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return s; };
const toBytes = (bin) => { const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) b[i] = bin.charCodeAt(i) & 0xff; return b; };

function charsetDecode(bytes, charset = 'utf-8') {
  try { return new TextDecoder(String(charset || 'utf-8').toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8')).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

function base64Bytes(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
  try { return toBytes(atob(clean.replace(/=+$/, '').padEnd(Math.ceil(clean.replace(/=+$/, '').length / 4) * 4, '='))); } catch { return new Uint8Array(0); }
}

function qpBytes(s) {
  return toBytes(String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
}

/** "=?UTF-8?B?...?=" and "=?iso-8859-1?Q?...?=" in a header, decoded. */
export function decodeWords(v) {
  return String(v || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    const bytes = enc.toUpperCase() === 'B' ? base64Bytes(txt) : qpBytes(txt.replace(/_/g, ' '));
    return charsetDecode(bytes, cs);
  });
}

/** Headers as { lowercased name: value }, folded lines unfolded. */
function headers(block) {
  const out = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!(k in out)) out[k] = line.slice(i + 1).trim();
    }
  }
  return out;
}

/** "text/html; charset=utf-8; name=x" -> { value, params } (RFC 2231 continuations and charset too). */
function params(v) {
  const parts = String(v || '').match(/(?:[^;"]|"[^"]*")+/g) || [''];
  const out = { value: parts[0].trim().toLowerCase(), params: {} };
  const star = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim().replace(/^"|"$/g, '');
    const m = k.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (m) {
      (star[m[1]] ||= []).push({ n: Number(m[2] || 0), val, enc: Boolean(m[3]) || (!m[2] && k.endsWith('*')) });
      continue;
    }
    out.params[k] = decodeWords(val);
  }
  for (const [k, pieces] of Object.entries(star)) {
    pieces.sort((a, b) => a.n - b.n);
    let joined = pieces.map((x) => x.val).join('');
    // filename*=UTF-8''Route%20Sheet.pdf: charset, language, then percent-encoded
    const ext = pieces[0].enc && joined.match(/^([^']*)'[^']*'(.*)$/);
    if (ext) { try { joined = decodeURIComponent(ext[2]); } catch { joined = ext[2]; } }
    out.params[k] = joined;
  }
  return out;
}

function walk(bin, out, depth = 0) {
  const sep = bin.search(/\r?\n\r?\n/);
  const head = headers(sep < 0 ? bin : bin.slice(0, sep));
  let body = sep < 0 ? '' : bin.slice(sep).replace(/^\r?\n\r?\n/, '');
  const ct = params(head['content-type'] || 'text/plain');
  const cd = params(head['content-disposition'] || '');
  const enc = String(head['content-transfer-encoding'] || '').toLowerCase().trim();
  if (depth === 0) {
    out.from = decodeWords(head.from || '');
    out.to = decodeWords(head.to || '');
    out.subject = decodeWords(head.subject || '');
    out.date = head.date || '';
  }
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 8) {
    const b = `--${ct.params.boundary}`;
    const pieces = body.split(new RegExp(`\\r?\\n?${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const piece of pieces.slice(1)) if (piece.trim()) walk(piece, out, depth + 1);
    return;
  }
  const bytes = enc === 'base64' ? base64Bytes(body) : enc === 'quoted-printable' ? qpBytes(body) : toBytes(body);
  if (ct.value === 'message/rfc822' && depth < 8) {
    walk(latin1(bytes), out, depth + 1);
    return;
  }
  const name = cd.params.filename || ct.params.name || '';
  const attached = cd.value === 'attachment' || Boolean(name);
  if (!attached && ct.value === 'text/plain' && !out.text) out.text = charsetDecode(bytes, ct.params.charset);
  else if (!attached && ct.value === 'text/html' && !out.html) out.html = charsetDecode(bytes, ct.params.charset);
  else if (attached || !ct.value.startsWith('text/')) {
    out.attachments.push({ name: name || `attachment-${out.attachments.length + 1}`, type: ct.value, bytes });
  }
}

/** The raw message (bytes or a string) taken apart. */
export function parseMail(raw) {
  const bin = typeof raw === 'string' ? raw : latin1(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const out = { from: '', to: '', subject: '', date: '', text: '', html: '', attachments: [] };
  walk(bin, out);
  return out;
}
