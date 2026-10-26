// Reading jobs out of documents. No real sample yet (2026-10-26): these are the layouts guessed at,
// every name and address made up. Replace with the real layout once the first document is in.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { docText, headerKind, isAddress, kindOf, parseDocument, readDocument, readDuration, readSqft, splitAddress, xmlBlocks } from '../lib/doc.js';

/** A zip, as Word writes one (deflated) or stored. */
function zip(files, deflate = true) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const wp = (text) => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${text.split('\t').map((t, i) => `${i ? '<w:r><w:tab/></w:r>' : ''}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join('')}</w:p>`;
const wtable = (rows) => `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${c.split('\n').map(wp).join('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const docx = (body, deflate = true) => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x"><w:body>${body}<w:sectPr/></w:body></w:document>`,
}, deflate);
const read = async (name, bytes) => parseDocument(await readDocument(name, bytes));

// 1. a route sheet as a table with a header, extra columns and all
let r = await read('route.docx', docx(wp('Route Sheet - Tuesday') + wtable([
  ['Customer', 'Service Address', 'City', 'Program', 'Est. Time', 'Lawn Sq Ft', 'Phone', 'Balance'],
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 'Fert 6 Winterizer', '20 min', '8,500', '616-555-0101', '$0.00'],
  ['Sam & Lee Roe', '4644 Oak Hollow Dr SW', 'Fairview', 'Fert 6 Winterizer', '0:25', '12,000', '616-555-0102', '$45.00'],
  ['Total', '', '', '', '45 min', '20,500', '', ''],
])));
assert.equal(r.stops.length, 2);
assert.deepEqual(r.stops[0], { address: '3581 Maple Ct SW', city: 'Fairview', name: 'Pat Doe', minutes: 20, service: 'Fert 6 Winterizer', sqft: 8500, extra: ['Phone: 616-555-0101', 'Balance: $0.00'] });
assert.equal(r.stops[1].minutes, 25);
assert.equal(r.stops[1].name, 'Sam & Lee Roe');
assert.match(r.layout, /^table, header: Customer \| Service Address/);

// 2. other words for the same columns: full address in one cell, hours, thousands of square feet
r = await read('r.docx', docx(wtable([
  ['Name', 'Address', 'Duration (hrs)', 'Lawn Size', 'Arrival Window'],
  ['Pat Doe', '3581 Maple Ct SW, Fairview, MI 49315', '0.5', '8.5k', '8:00 AM'],
  ['Kim Low', '2531 Willow\nFairview, MI 49315', '1.25', '9,000 sq ft', '9:00 AM'],
]), false));
assert.deepEqual(r.stops.map((s) => [s.address, s.city, s.minutes, s.sqft]), [
  ['3581 Maple Ct SW', 'Fairview', 30, 8500],
  ['2531 Willow', 'Fairview', 75, 9000],
]);

// 3. a list, address first, then the name, then a line of details
r = await read('list.docx', docx([
  'Tuesday route', '',
  '3581 Maple Ct SW, Fairview, MI 49315', 'Pat Doe', 'Fert 6 Winterizer - 20 min - 8,500 sq ft',
  '4644 Oak Hollow Dr SW, Fairview, MI 49315', 'Sam Roe', 'Fert 6 Winterizer\t22 min\t11,200 sq ft',
].map(wp).join('')));
assert.deepEqual(r.stops.map((s) => [s.address, s.city, s.name, s.minutes, s.sqft]), [
  ['3581 Maple Ct SW', 'Fairview', 'Pat Doe', 20, 8500],
  ['4644 Oak Hollow Dr SW', 'Fairview', 'Sam Roe', 22, 11200],
]);

// 4. a list, the name BEFORE the address, labelled fields
r = await read('list2.docx', docx([
  'Pat Doe', '3581 Maple Ct SW', 'Fairview, MI 49315', 'Time: 25 min', 'Sq Ft: 9,000',
  'Sam Roe', '4644 Oak Hollow Dr SW', 'Fairview, MI 49315', 'Time: 1 hr 5 min', 'Sq Ft: 14,000',
  'Kim Low', '2531 Willow', 'Fairview, MI 49315', 'Time: 30 min', 'Sq Ft: 7,000',
].map(wp).join('')));
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 25, 9000],
  ['Sam Roe', '4644 Oak Hollow Dr SW', 'Fairview', 65, 14000],
  ['Kim Low', '2531 Willow', 'Fairview', 30, 7000],
]);

// 5. one job a line, tab-separated, no header
r = await read('tabs.docx', docx([
  'Pat Doe\t3581 Maple Ct SW\tFairview\t20 min\t8,500 sq ft\t616-555-0101',
  'Sam Roe\t4644 Oak Hollow Dr SW\tFairview\t22 min\t11,200 sq ft\t616-555-0102',
].map(wp).join('')));
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 20, 8500],
  ['Sam Roe', '4644 Oak Hollow Dr SW', 'Fairview', 22, 11200],
]);

// 6. the screenshot's own shape, typed out: address, "name • city", time
r = await read('app.docx', docx(['3581 Maple Cr SW', 'Pat Doe • Fairview', '20m', '4644 Oak Hollow Dr SW', 'Sam Roe • Fairview', '22m'].map(wp).join('')));
assert.deepEqual(r.stops.map((s) => [s.address, s.name, s.city, s.minutes]), [['3581 Maple Cr SW', 'Pat Doe', 'Fairview', 20], ['4644 Oak Hollow Dr SW', 'Sam Roe', 'Fairview', 22]]);

// 7. OpenDocument (.odt), a table
const odt = zip({ 'mimetype': 'application/vnd.oasis.opendocument.text', 'content.xml': `<office:document-content><office:body><office:text>
  <text:p>Route</text:p><table:table><table:table-row><table:table-cell><text:p>Address</text:p></table:table-cell><table:table-cell><text:p>Customer</text:p></table:table-cell><table:table-cell><text:p>Minutes</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell><text:p>3581 Maple<text:s/>Ct SW</text:p></table:table-cell><table:table-cell><text:p><text:span>Pat</text:span> Doe</text:p></table:table-cell><table:table-cell><text:p>20</text:p></table:table-cell></table:table-row>
  </table:table></office:text></office:body></office:document-content>` });
r = await read('r.odt', odt);
assert.deepEqual(r.stops.map((s) => [s.address, s.name, s.minutes]), [['3581 Maple Ct SW', 'Pat Doe', 20]]);

// 8. CSV, plain text
r = await read('r.csv', new TextEncoder().encode('Name,Address,City,Time,Sq Ft\n"Doe, Pat",3581 Maple Ct SW,Fairview,20 min,"8,500"\n'));
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [['Doe, Pat', '3581 Maple Ct SW', 'Fairview', 20, 8500]]);
r = await read('r.txt', new TextEncoder().encode('3581 Maple Ct SW, Fairview\nPat Doe\n20 min\n'));
assert.equal(r.stops[0].minutes, 20);

// 9. old binary .doc: text as UTF-16 runs among binary, cells ending in 0x07
const words = 'Name\x07Address\x07Time\x07\x07Pat Doe\x073581 Maple Ct SW\x0720 min\x07\x07\r';
const bin = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3, 0, 0]), Buffer.from(words, 'utf16le'), Buffer.from([0, 0, 1, 255, 3])]);
assert.equal(kindOf('x.doc', bin), 'doc');
assert.match(docText(bin), /Pat Doe\t3581 Maple Ct SW\t20 min/);
r = await read('old.doc', new Uint8Array(bin));
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.minutes]), [['Pat Doe', '3581 Maple Ct SW', 20]]);

// the pieces
assert.equal(readDuration('20 min'), 20);
assert.equal(readDuration('1 hr 15 min'), 75);
assert.equal(readDuration('1.5 hrs'), 90);
assert.equal(readDuration('0:20'), 20);
assert.equal(readDuration('8:30 AM'), null);
assert.equal(readDuration('20'), null);
assert.equal(readDuration('20', 'minutes'), 20);
assert.equal(readDuration('0.5', 'hours'), 30);
assert.equal(readDuration('20 mi'), null);
assert.equal(readSqft('8,500 sq ft'), 8500);
assert.equal(readSqft('8.5k sqft'), 8500);
assert.equal(readSqft('12000 SF'), 12000);
assert.equal(readSqft('8,500'), null);
assert.equal(readSqft('8,500', true), 8500);
assert.ok(isAddress('3581 Maple Ct SW'));
assert.ok(!isAddress('20 min'));
assert.ok(!isAddress('8,500 sq ft'));
assert.ok(!isAddress('8500 sq ft'));
assert.deepEqual(splitAddress('3581 Maple Ct SW, Fairview, MI 49315'), { address: '3581 Maple Ct SW', city: 'Fairview' });
assert.deepEqual(splitAddress('3581 Maple Ct SW, Fairview MI 49315'), { address: '3581 Maple Ct SW', city: 'Fairview' });
assert.equal(headerKind('Est. Time'), 'minutes');
assert.equal(headerKind('Time Window'), null);
assert.equal(headerKind('Lawn Size'), 'sqft');
assert.equal(headerKind('Service Address'), 'address');
assert.equal(headerKind('Customer Name'), 'name');
assert.deepEqual(xmlBlocks('<w:p><w:r><w:t>A &amp; B</w:t></w:r><w:r><w:br/><w:t>C</w:t></w:r></w:p>'), [{ type: 'p', text: 'A & B\nC' }]);
await assert.rejects(readDocument('x.docx', new Uint8Array([1, 2, 3])), /zip/);

console.log('route documents: ok (9 guessed layouts)');
