/**
 * Stops out of a word processing document (route session, 2026-10-26).
 *
 * No sample has been seen yet: this is a guess, written to be tuned against
 * the first real one (the page keeps a private copy of the first document,
 * src/index.js /api/catalog). The guess: a list of jobs, each with an
 * address, a name and a time, maybe with extra columns we do not need --
 * and maybe square footage, which we keep.
 *
 *   readDocument(name, bytes)  -> blocks: [{ type: 'p', text } | { type: 'table', rows: [[cell]] }]
 *   parseDocument(blocks)      -> { stops, layout }
 *
 * Read here, in the browser, with nothing but DecompressionStream:
 *   .docx  a zip; word/document.xml
 *   .odt   a zip; content.xml
 *   .txt / .csv  lines (CSV split into cells)
 *   .doc   the old binary format: its text pulled out as runs of
 *          characters (cell marks become tabs). Crude, but often enough.
 *
 * A stop is { address, city, name, minutes, service, sqft, extra }, the
 * screenshot's shape plus sqft and the fields we did not place (extra,
 * kept for tuning).
 */

/* ------------------------------------------------------------ zip */

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The named entries of a zip archive, as bytes. */
export async function unzip(bytes, names) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i -= 1) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = new Map();
  for (let k = 0; k < count && u32(b, p) === 0x02014b50; k += 1) {
    const method = u16(b, p + 10);
    const size = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const local = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
    if (!names.includes(name)) continue;
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const data = b.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflate(data));
    else throw new Error(`Unsupported zip compression (${method})`);
  }
  return out;
}

/* ------------------------------------------------------------ XML to blocks */

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});

const DOCX = {
  table: 'w:tbl', row: 'w:tr', cell: 'w:tc', para: ['w:p'], text: 'w:t',
  tab: ['w:tab', 'w:ptab'], br: ['w:br', 'w:cr'], space: null,
};
const ODT = {
  table: 'table:table', row: 'table:table-row', cell: 'table:table-cell', para: ['text:p', 'text:h'], text: null,
  tab: ['text:tab'], br: ['text:line-break'], space: 'text:s', covered: 'table:covered-table-cell',
};

/** Paragraphs and tables, in order, from a document's XML. Nested tables are folded into their cell's text. */
export function xmlBlocks(xml, t = DOCX) {
  const blocks = [];
  const tables = [];
  let para = null;
  let inText = false;
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  const endPara = () => {
    if (para == null) return;
    const text = para.replace(/[  ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    const tb = tables.at(-1);
    if (tb?.cell) tb.cell.push(text);
    else if (text) blocks.push({ type: 'p', text });
    para = null;
  };
  while ((m = re.exec(xml))) {
    const [, close, tag, attrs, self, text] = m;
    if (text != null) {
      if (para != null && (t.text ? inText : true)) para += decode(text);
      continue;
    }
    const tb = tables.at(-1);
    if (tag === t.table) {
      if (!close && !self) tables.push({ rows: [], row: null, cell: null });
      else if (close) {
        const done = tables.pop();
        const outer = tables.at(-1);
        if (outer?.cell) outer.cell.push(done.rows.map((r) => r.join('\t')).join('\n'));
        else if (done.rows.length) blocks.push({ type: 'table', rows: done.rows });
      }
    } else if (tag === t.row && tb) {
      if (!close && !self) tb.row = [];
      else if (close && tb.row) { if (tb.row.some((c) => c)) tb.rows.push(tb.row); tb.row = null; }
    } else if ((tag === t.cell || tag === t.covered) && tb) {
      if (self) tb.row?.push('');
      else if (!close) tb.cell = [];
      else if (tb.cell) { tb.row?.push(tb.cell.filter(Boolean).join('\n')); tb.cell = null; }
    } else if (t.para.includes(tag)) {
      if (self) { para = ''; endPara(); } else if (!close) { endPara(); para = ''; } else endPara();
    } else if (tag === t.text) {
      inText = !close && !self;
    } else if (t.tab.includes(tag) && !close && para != null) {
      para += '\t';
    } else if (t.br.includes(tag) && !close && para != null) {
      para += '\n';
    } else if (tag === t.space && !close && para != null) {
      para += ' '.repeat(Number(attrs.match(/text:c="(\d+)"/)?.[1] || 1));
    }
  }
  endPara();
  return blocks;
}

/* ------------------------------------------------------------ files to blocks */

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const linesToBlocks = (text) => text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean).map((s) => ({ type: 'p', text: s }));

/** The text of an old binary .doc: the longest readable runs, as UTF-16 or as 8-bit, whichever reads better. */
export function docText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const runs = (s) => (s.match(/[\x20-\x7e -ÿ\t\r\x07‘-”•]{4,}/g) || []);
  const score = (rs) => rs.reduce((a, r) => a + (r.match(/[A-Za-z]{3,}/g) || []).length, 0);
  const wide = runs(new TextDecoder('utf-16le').decode(b.subarray(0, b.length - (b.length % 2))));
  const narrow = runs(new TextDecoder('latin1').decode(b));
  const best = score(wide) >= score(narrow) ? wide : narrow;
  return best.filter((r) => /[A-Za-z]{2,}/.test(r)).join('\r').replace(/\x07\x07/g, '\x07\r').replace(/\x07/g, '\t');
}

/** What kind of document this is, by name, then by its first bytes. */
export function kindOf(name, bytes) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (['docx', 'docm', 'dotx', 'odt', 'txt', 'csv', 'tsv', 'doc', 'rtf'].includes(ext)) return ext === 'docm' || ext === 'dotx' ? 'docx' : ext;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'docx';
  if (b[0] === 0xd0 && b[1] === 0xcf) return 'doc';
  if (b[0] === 0x7b && b[1] === 0x5c) return 'rtf';
  return 'txt';
}

/** Blocks from a document's bytes. */
export async function readDocument(name, bytes) {
  const kind = kindOf(name, bytes);
  if (kind === 'docx' || kind === 'odt') {
    const files = await unzip(bytes, ['word/document.xml', 'content.xml']);
    if (files.has('word/document.xml')) return xmlBlocks(new TextDecoder().decode(files.get('word/document.xml')), DOCX);
    if (files.has('content.xml')) return xmlBlocks(new TextDecoder().decode(files.get('content.xml')), ODT);
    throw new Error('That zip is not a Word or OpenDocument file');
  }
  if (kind === 'doc') return linesToBlocks(docText(bytes));
  const text = new TextDecoder().decode(bytes);
  if (kind === 'rtf') {
    // the words of an RTF, roughly: groups and control words out, \par and \cell as breaks
    const plain = text.replace(/\\(par|line|row)\b ?/g, '\n').replace(/\\cell\b ?/g, '\t')
      .replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
    return linesToBlocks(plain);
  }
  if (kind === 'csv' || kind === 'tsv') {
    const rows = kind === 'tsv' ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t').map((c) => c.trim())) : csvRows(text);
    return [{ type: 'table', rows }];
  }
  return linesToBlocks(text);
}

/* ------------------------------------------------------------ what each field is */

/** Minutes in a duration: "20 min", "20m", "1 hr 15", "1.5 hrs", "0:20". A bare number only with a unit from its column. */
export function readDuration(text, unit = null) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/\b(am|pm|a\.m\.|p\.m\.)\b/i.test(t)) return null;
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\.?\s*(?:(\d{1,2})\s*(?:m|min|mins|minutes?)?\b)?/i);
  if (m) return Math.round(Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0)) || null;
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\b\.?/i);
  if (m) return Math.round(Number(m[1])) || null;
  m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m && (unit || Number(m[1]) < 4)) return Number(m[1]) * 60 + Number(m[2]) || null;
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m && unit === 'hours' && Number(m[1]) <= 12) return Math.round(Number(m[1]) * 60) || null;
  if (m && unit === 'minutes' && Number(m[1]) < 600) return Math.round(Number(m[1])) || null;
  return null;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const SQFT_UNIT = String.raw`(?:sq\.?\s*f(?:ee|oo)?t\.?|sq\.?\s*ft\.?|sqft|s\.?f\.?|ft2|ft²|square\s*f(?:ee|oo)?t)`;

/** Square feet in "8,500 sq ft", "8.5k sqft", "Lawn: 12000 SF"; a bare number only from a square-footage column. */
export function readSqft(text, column = false) {
  const t = String(text ?? '').trim();
  let m = t.match(new RegExp(`${NUM}\\s*(k|m)?\\s*${SQFT_UNIT}(?![a-z])`, 'i'));
  if (!m && column) m = t.match(new RegExp(`^${NUM}\\s*(k|m)?$`, 'i'));
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return v > 0 ? Math.round(v) : null;
}

const STATE = /^(?:[A-Z]{2}|Michigan|Ohio|Indiana|Illinois|Wisconsin)\.?(?:\s+\d{5}(?:-\d{4})?)?$/;
const ZIP = /^\d{5}(?:-\d{4})?$/;

/** A street address: a house number, then a word that is not a unit. */
export const isAddress = (t) => /^\d{1,6}[A-Za-z]?(?:-\d+)?\s+(?!(?:sq|sf|ft|min|mins|minutes?|m|h|hrs?|hours?|k|am|pm)\b)[A-Za-z0-9]/i.test(String(t).trim())
  && /[A-Za-z]{2,}/.test(t) && !readSqft(t) && readDuration(t) == null;

/** "6621 Runway Ct SW, Byron Center, MI 49315" -> street and city; state and ZIP dropped. */
export function splitAddress(text) {
  const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  let city = '';
  for (const p of parts.slice(1)) {
    if (STATE.test(p) || ZIP.test(p)) continue;
    const c = p.replace(/\s+(?:[A-Z]{2}|Michigan)\.?(?:\s+\d{5}(?:-\d{4})?)?$/, '').trim();
    if (!city && c) city = c;
  }
  return { address: parts[0] || '', city };
}

const PHONE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
const OTHER = (t) => PHONE.test(t) || /@/.test(t) || /^\$/.test(t) || ZIP.test(t)
  || /^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/.test(t) || /^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(t) || /^#?\d+$/.test(t);
const SERVICE = /\b(fert|fertili[sz]|winteri[sz]|aerat|overseed|seed|mow|weed|grub|lime|application|treatment|round|step|program|spray|insect|clean ?up|lawn|service|tree|shrub|mosquito)\w*/i;
/** Two to five words, letters only, as a person's or a city's name looks. */
const nameLike = (t) => /^[A-Za-z][A-Za-z'.&-]*(?:\s+(?:&|and|[A-Za-z][A-Za-z'.-]*)){0,5}$/.test(t) && !SERVICE.test(t);

/* ------------------------------------------------------------ columns */

const HEAD = [
  ['sqft', /\b(sq\.?\s*f(ee)?t|sqft|square|sf|area|size|turf|footage)\b/i],
  ['minutes', /\b(time|duration|mins?|minutes|est\.?|estimated|hrs?|hours|labou?r)\b/i],
  ['address', /\b(address|street|location|property|site)\b/i],
  ['city', /\b(city|town)\b/i],
  ['zip', /\b(zip|postal|post code)\b/i],
  ['state', /^\s*(state|st\.?)\s*$/i],
  ['name', /\b(name|customer|client|owner|account|contact)\b/i],
  ['service', /\b(service|program|application|job|task|treatment|product|round|description)\b/i],
];
const NOT_DURATION = /\b(arrival|window|start|end|scheduled|appointment|date|day|last|next|phone|completed)\b/i;

/** What a column header names, or null. */
export function headerKind(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40 || isAddress(t)) return null;
  for (const [k, re] of HEAD) {
    if (!re.test(t)) continue;
    if (k === 'minutes' && NOT_DURATION.test(t)) continue;
    return k;
  }
  return null;
}

const unitOf = (header) => (/\b(hrs?|hours?)\b/i.test(header) ? 'hours' : 'minutes');

/* ------------------------------------------------------------ records */

const blank = () => ({ address: '', city: '', name: '', minutes: null, service: '', sqft: null, extra: [] });

/** Put one field into a stop, by what it looks like. */
function place(rec, field) {
  const f = String(field || '').trim();
  if (!f) return;
  // "Label: value" is a column of its own
  const lv = f.match(/^([A-Za-z][A-Za-z .#/()]{1,24}):\s*(.+)$/);
  if (lv && headerKind(lv[1])) { putColumn(rec, headerKind(lv[1]), lv[1], lv[2]); return; }
  if (!rec.address && isAddress(f)) { Object.assign(rec, keepCity(rec, splitAddress(f))); return; }
  // square feet and a time with its unit, wherever they sit in the field; what is left is placed as usual
  let rest = f;
  const sqm = rest.match(new RegExp(`${NUM}\\s*(k|m)?\\s*${SQFT_UNIT}(?![a-z])`, 'i'));
  if (sqm && rec.sqft == null) { rec.sqft = readSqft(sqm[0]); rest = rest.replace(sqm[0], ' '); }
  const dm = rest.match(/(\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)\b\.?(?:\s*\d{1,2}\s*(?:m|min|mins|minutes?)?\b)?|\d+(?:\.\d+)?\s*(?:m|min|mins|minutes?)\b\.?|^\d{1,2}:\d{2}$)/i);
  if (dm && rec.minutes == null && readDuration(dm[0]) != null) { rec.minutes = readDuration(dm[0]); rest = rest.replace(dm[0], ' '); }
  if (rest !== f) {
    rest = rest.replace(/\s*[-–—,;:]\s*$|^\s*[-–—,;:]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
    if (rest && !/^[-–—,;:\s]*$/.test(rest)) place(rec, rest);
    return;
  }
  const csz = f.match(/^([A-Za-z][A-Za-z .'-]+?),?\s+(?:[A-Z]{2}|Michigan)\.?(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (csz && !rec.city) { rec.city = csz[1].trim(); return; }
  if (OTHER(f)) { rec.extra.push(f); return; }
  if (nameLike(f)) {
    if (!rec.name) rec.name = f;
    else if (!rec.city && f.split(/\s+/).length <= 3) rec.city = f;
    else rec.extra.push(f);
    return;
  }
  if (!rec.service && SERVICE.test(f)) { rec.service = f; return; }
  rec.extra.push(f);
}

const keepCity = (rec, a) => ({ address: a.address, city: rec.city || a.city });

function putColumn(rec, kind, header, value) {
  const v = String(value || '').trim();
  if (!v) return;
  if (kind === 'address') {
    if (rec.address) { rec.extra.push(`${header}: ${v}`); return; }
    const a = splitAddress(v.replace(/\n+/g, ', '));
    rec.address = a.address;
    if (!rec.city) rec.city = a.city;
  } else if (kind === 'city') rec.city = rec.city || v.replace(/,?\s+(?:[A-Z]{2})\.?(?:\s+\d{5})?$/, '');
  else if (kind === 'minutes') {
    const m = readDuration(v, unitOf(header));
    if (m != null && rec.minutes == null) rec.minutes = m; else rec.extra.push(`${header}: ${v}`);
  } else if (kind === 'sqft') {
    const s = readSqft(v, true);
    if (s != null && rec.sqft == null) rec.sqft = s; else rec.extra.push(`${header}: ${v}`);
  } else if (kind === 'name') rec.name = rec.name || v.replace(/\s*\n\s*/g, ' ');
  else if (kind === 'service') rec.service = rec.service || v.replace(/\s*\n\s*/g, ' ');
  else rec.extra.push(`${header}: ${v}`);
}

const SPLIT = /\t+| {2,}| [•·|–—-] /;
const fieldsOf = (text) => String(text).split(/\n/).flatMap((l) => l.split(SPLIT)).map((s) => s.trim()).filter(Boolean);

/** One table: by its header row if it has one, else every row field by field. */
function tableStops(rows) {
  const hi = rows.slice(0, 5).findIndex((r) => r.filter((c) => headerKind(c)).length >= 2 && !r.some((c) => isAddress(c)));
  const stops = [];
  if (hi >= 0) {
    const header = rows[hi];
    const kinds = [];
    const seen = new Set();
    header.forEach((h, i) => { const k = headerKind(h); kinds[i] = k && !seen.has(k) ? k : null; if (k) seen.add(k); });
    for (const row of rows.slice(hi + 1)) {
      const rec = blank();
      row.forEach((cell, i) => {
        if (kinds[i]) putColumn(rec, kinds[i], header[i], cell);
        else if (String(cell).trim()) rec.extra.push(`${header[i] || `col ${i + 1}`}: ${String(cell).trim()}`);
      });
      if (!rec.address) {
        // the address in a column we did not name: look for it field by field
        const again = blank();
        Object.assign(again, { ...rec, extra: [] });
        for (const e of rec.extra) place(again, e.replace(/^[^:]+:\s*/, ''));
        if (again.address) Object.assign(rec, again);
      }
      if (rec.address) stops.push(rec);
    }
    return { stops, layout: `table, header: ${header.filter(Boolean).join(' | ')}` };
  }
  for (const row of rows) {
    const rec = blank();
    for (const cell of row) for (const f of fieldsOf(cell)) place(rec, f);
    if (rec.address) stops.push(rec);
  }
  if (!stops.length) {
    // a table used as a page layout: one job per cell, not per row
    const cells = rows.flat().filter(Boolean);
    return { stops: listStops(cells.flatMap((c) => c.split('\n'))), layout: 'table, one job per cell' };
  }
  return { stops, layout: 'table, no header' };
}

/**
 * Lines of text: a job starts at a line with an address on it. If the
 * names come BEFORE their addresses (the line before each address is a name,
 * and the last job's last line is not), each job takes the line before it.
 */
function listStops(lines) {
  const L = lines.map((l) => l.trim()).filter(Boolean);
  const starts = L.map((l, i) => (fieldsOf(l).some(isAddress) ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) return [];
  const group = (from) => starts.map((s, k) => L.slice(from(s, k), k + 1 < starts.length ? from(starts[k + 1], k + 1) : L.length));
  const plain = group((s) => s);
  const lastLine = (g) => fieldsOf(g.at(-1)).at(-1) || '';
  const endsInName = plain.slice(0, -1).filter((g) => g.length > 1 && fieldsOf(g.at(-1)).length === 1 && nameLike(lastLine(g))).length;
  const nameFirst = starts.length > 1 && starts[0] > 0 && nameLike(L[starts[0] - 1])
    && endsInName >= 0.6 * (starts.length - 1) && !nameLike(lastLine(plain.at(-1)));
  const groups = nameFirst ? group((s, k) => (s > 0 && (k === 0 || s - 1 > starts[k - 1]) && nameLike(L[s - 1]) ? s - 1 : s)) : plain;
  return groups.map((g) => {
    const rec = blank();
    // the address first, so a name before it is not taken for the city
    const fields = g.flatMap(fieldsOf);
    const ai = fields.findIndex(isAddress);
    place(rec, fields[ai]);
    fields.forEach((f, i) => { if (i !== ai) place(rec, f); });
    return rec;
  }).filter((r) => r.address);
}

/** Every job in the document, in order, and a line on how it was read. */
export function parseDocument(blocks) {
  const stops = [];
  const layout = [];
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    const s = listStops(lines);
    if (s.length) { stops.push(...s); layout.push(`list of ${s.length}`); }
    lines = [];
  };
  for (const b of blocks) {
    if (b.type === 'table') {
      flush();
      const t = tableStops(b.rows);
      if (t.stops.length) { stops.push(...t.stops); layout.push(`${t.layout} (${t.stops.length})`); }
    } else lines.push(...b.text.split('\n'));
  }
  flush();
  return { stops, layout: layout.join('; ') || 'no addresses found' };
}
