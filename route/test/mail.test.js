// Taking emails apart: route sheets as attachments, inline HTML, forwards, encodings.
import assert from 'node:assert/strict';
import { decodeWords, parseMail } from '../lib/mail.js';

const b64 = (s) => Buffer.from(s).toString('base64').replace(/(.{76})/g, '$1\r\n');

// 1. Service Autopilot-style: HTML body and a PDF attachment, nested multipart
const pdf = '%PDF-1.4 fake bytes ÿ\u0000';
let raw = [
  'From: "Dispatch" <noreply@example.com>',
  'To: route-abc@example.com',
  'Subject: =?UTF-8?B?' + Buffer.from('Route Sheet – Tuesday').toString('base64') + '?=',
  'Date: Tue, 27 Oct 2026 07:02:00 -0400',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative;',
  '  boundary="INNER"',
  '',
  '--INNER',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Today=E2=80=99s route: 3581 Maple Ct SW =',
  'Fairview',
  '--INNER',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<table><tr><td>3581 Maple Ct SW</td><td>20 min</td></tr></table>'),
  '--INNER--',
  '',
  '--OUTER',
  'Content-Type: application/pdf; name="Route Sheet.pdf"',
  'Content-Disposition: attachment; filename="Route Sheet.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(pdf, 'latin1').toString('base64'),
  '--OUTER--',
  '',
].join('\r\n');
let m = parseMail(new Uint8Array(Buffer.from(raw, 'latin1')));
assert.equal(m.subject, 'Route Sheet – Tuesday');
assert.equal(m.from, '"Dispatch" <noreply@example.com>');
assert.equal(m.text, 'Today’s route: 3581 Maple Ct SW Fairview');
assert.equal(m.html, '<table><tr><td>3581 Maple Ct SW</td><td>20 min</td></tr></table>');
assert.equal(m.attachments.length, 1);
assert.equal(m.attachments[0].name, 'Route Sheet.pdf');
assert.equal(m.attachments[0].type, 'application/pdf');
assert.deepEqual([...m.attachments[0].bytes], [...Buffer.from(pdf, 'latin1')], 'attachment bytes exact');

// 2. forwarded as an attachment (message/rfc822), with an RFC 2231 filename inside, LF line ends
const inner = ['Subject: Original', 'Content-Type: multipart/mixed; boundary=b2', '', '--b2', 'Content-Type: text/plain', '', 'inner text', '--b2',
  'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', "Content-Disposition: attachment; filename*=UTF-8''Dispatch%20Board%20%E2%80%93%20Oct.xlsx",
  'Content-Transfer-Encoding: base64', '', b64('PK fake xlsx'), '--b2--'].join('\n');
raw = ['From: me@example.com', 'Subject: Fwd: Original', 'Content-Type: multipart/mixed; boundary=b1', '', '--b1', 'Content-Type: text/plain', '', 'see attached', '--b1',
  'Content-Type: message/rfc822', '', inner, '--b1--'].join('\n');
m = parseMail(raw);
assert.equal(m.subject, 'Fwd: Original');
assert.equal(m.text, 'see attached');
assert.equal(m.attachments.length, 1);
assert.equal(m.attachments[0].name, 'Dispatch Board – Oct.xlsx');
assert.equal(Buffer.from(m.attachments[0].bytes).toString(), 'PK fake xlsx');

// 3. a plain one-part message; split filename parameters
m = parseMail('Subject: hi\r\n\r\nline one\r\nline two\r\n');
assert.equal(m.text, 'line one\r\nline two\r\n');
m = parseMail(['Content-Type: multipart/mixed; boundary=x', '', '--x', 'Content-Type: text/csv', 'Content-Disposition: attachment; filename*0="route-"; filename*1="sheet.csv"', '', 'a,b', '--x--'].join('\r\n'));
assert.equal(m.attachments[0].name, 'route-sheet.csv');
assert.equal(Buffer.from(m.attachments[0].bytes).toString(), 'a,b');

assert.equal(decodeWords('=?iso-8859-1?Q?Caf=E9_route?='), 'Café route');
assert.equal(decodeWords('=?UTF-8?B?Um91dGU=?= =?UTF-8?B?IFNoZWV0?='), 'Route Sheet');
console.log('route mail: ok');
