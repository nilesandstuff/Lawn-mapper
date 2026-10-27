// Reading jobs out of documents. No real sample yet (2026-10-26): these are the layouts guessed at,
// every name and address made up. Replace with the real layout once the first document is in.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { docText, headerKind, htmlBlocks, isAddress, kindOf, parseDocument, pdfBlocks, readDocument, readDuration, readSqft, splitAddress, xmlBlocks } from '../lib/doc.js';

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

// 10. Excel (.xlsx): the Dispatch Board's export. Shared strings, an inline string, numbers,
// a time kept as a fraction of a day, a blank cell skipped by reference
const xlsx = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Dispatch" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Customer</t></si><si><t>Address</t></si><si><t>City</t></si><si><t>Est. Time</t></si><si><t>Turf Sq Ft</t></si><si><t>Pat Doe</t></si><si><r><t>3581 Maple </t></r><r><t>Ct SW</t></r></si><si><t>Fairview</t></si><si><t>Sam &amp; Lee Roe</t></si></sst>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
    <row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="s"><v>7</v></c><c r="D2" s="3"><v>1.3888888888888889E-2</v></c><c r="E2"><v>8500</v></c></row>
    <row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="inlineStr"><is><t>4644 Oak Hollow Dr SW</t></is></c><c r="D3"><v>25</v></c><c r="E3"><v>11200</v></c></row>
  </sheetData></worksheet>`,
});
assert.equal(kindOf('Dispatch Board.xlsx', xlsx), 'xlsx');
assert.equal(kindOf('noname', xlsx), 'zip');
r = await read('Dispatch Board.xlsx', xlsx);
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 20, 8500],
  ['Sam & Lee Roe', '4644 Oak Hollow Dr SW', '', 25, 11200],
]);
assert.equal((await read('noname', xlsx)).stops.length, 2, 'known by its insides');
await assert.rejects(readDocument('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), /save it as \.xlsx/);

// 11. an emailed route sheet's HTML body: a table with a header, entities, nested formatting
r = parseDocument(htmlBlocks(`<html><head><style>td{color:red}</style></head><body>
  <p>Route Sheet&nbsp;&ndash; Tuesday</p>
  <table border="1"><thead><tr><th>Stop</th><th>Client</th><th>Service Address</th><th>Est. Time</th><th>Sq. Ft.</th></tr></thead>
  <tbody><tr><td>1</td><td><b>Pat Doe</b></td><td>3581 Maple Ct SW<br>Fairview, MI 49315</td><td>20 min</td><td>8,500</td></tr>
  <tr><td>2</td><td>Sam Roe</td><td>4644 Oak Hollow Dr SW<br/>Fairview, MI 49315</td><td>0:25</td><td>11,200</td></tr></tbody></table>
  <p>Notes: gate code 1234</p></body></html>`));
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 20, 8500],
  ['Sam Roe', '4644 Oak Hollow Dr SW', 'Fairview', 25, 11200],
]);
// and as a list of stops, one block each
r = parseDocument(htmlBlocks('<div>3581 Maple Ct SW, Fairview</div><div>Pat Doe &bull; 20 min &bull; 8,500 sq ft</div><div>2531 Willow, Fairview</div><div>Kim Low &bull; 30 min</div>'));
assert.deepEqual(r.stops.map((s) => [s.address, s.name, s.minutes, s.sqft]), [['3581 Maple Ct SW', 'Pat Doe', 20, 8500], ['2531 Willow', 'Kim Low', 30, null]]);

// 12. a PDF's words, as pdf.js gives them (y up): a table with a header, an address wrapped onto a
// second line, the header repeated on page 2; then a page with no header, read line by line
const word = (text, x, y, size = 10) => ({ text, x, y, w: text.length * size * 0.5, h: size });
const rowAt = (y, cells) => cells.flatMap(([x, t]) => t.split(' ').reduce((a, w) => { a.out.push(word(w, a.x, y)); a.x += (w.length + 1) * 5; return a; }, { x, out: [] }).out);
const head = (y) => rowAt(y, [[40, 'Client'], [160, 'Address'], [360, 'Est. Time'], [440, 'Sq Ft'], [500, 'Phone']]);
const page1 = [
  word('Route Sheet - Crew 2', 40, 760, 14),
  ...head(720),
  ...rowAt(700, [[40, 'Pat Doe'], [160, '3581 Maple Ct SW'], [360, '20 min'], [440, '8,500'], [500, '616-555-0101']]),
  ...rowAt(688, [[160, 'Fairview, MI 49315']]),
  ...rowAt(670, [[40, 'Sam Roe'], [160, '4644 Oak Hollow Dr SW'], [360, '22 min'], [440, '11,200'], [500, '616-555-0102']]),
];
const page2 = [...head(720), ...rowAt(700, [[40, 'Kim Low'], [160, '2531 Willow Dr'], [360, '30 min'], [440, '7,000'], [500, '']])];
const page3 = [...rowAt(700, [[40, '1.'], [60, '2433 Cedar Ridge Dr SW, Fairview']]), ...rowAt(688, [[60, 'Riley Ives'], [300, '15 min'], [380, '6,000 sq ft']])];
const blocks = pdfBlocks([page1, page2, page3]);
assert.equal(blocks.filter((b) => b.type === 'table').length, 1, 'one table across the page break');
r = parseDocument(blocks);
assert.deepEqual(r.stops.map((s) => [s.name, s.address, s.city, s.minutes, s.sqft]), [
  ['Pat Doe', '3581 Maple Ct SW', 'Fairview', 20, 8500],
  ['Sam Roe', '4644 Oak Hollow Dr SW', '', 22, 11200],
  ['Kim Low', '2531 Willow Dr', '', 30, 7000],
  ['Riley Ives', '2433 Cedar Ridge Dr SW', 'Fairview', 15, 6000],
]);
// readDocument passes a PDF to the page's reader
r = parseDocument(await readDocument('Route Sheet.pdf', new TextEncoder().encode('%PDF-1.4'), { pdfText: async () => [page1] }));
assert.equal(r.stops.length, 2);
await assert.rejects(readDocument('x.pdf', new TextEncoder().encode('%PDF-1.4')), /PDF reader/);
assert.equal(kindOf('mystery', new TextEncoder().encode('%PDF-1.7')), 'pdf');

// the pieces
assert.equal(readDuration('20 min'), 20);
assert.equal(readDuration('1 hr 15 min'), 75);
assert.equal(readDuration('1.5 hrs'), 90);
assert.equal(readDuration('0:20'), 20);
assert.equal(readDuration('8:30 AM'), null);
assert.equal(readDuration('20'), null);
assert.equal(readDuration('20', 'minutes'), 20);
assert.equal(readDuration('0.5', 'hours'), 30);
assert.equal(readDuration('0.25', 'hours'), 15, 'hours stay hours');
assert.equal(readDuration('0.0208333', 'minutes'), 30, 'a day fraction in a time column');
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
assert.equal(headerKind('15 min'), null);
assert.equal(headerKind('6,000 sq ft'), null);
assert.equal(headerKind('Address 2'), 'address');
assert.deepEqual(xmlBlocks('<w:p><w:r><w:t>A &amp; B</w:t></w:r><w:r><w:br/><w:t>C</w:t></w:r></w:p>'), [{ type: 'p', text: 'A & B\nC' }]);
await assert.rejects(readDocument('x.docx', new Uint8Array([1, 2, 3])), /zip/);

console.log('route documents: ok (12 guessed layouts: Word, Excel, PDF, email HTML...)');
