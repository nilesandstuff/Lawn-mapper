/**
 * The saved picture's file name (public/lib/file-name.js).
 *   node tools/file-name.test.js
 */
import { fileNameFor } from '../public/lib/file-name.js';

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

check('the house number and street, without the city', fileNameFor('1234 Example St, Anytown, MI 00000'), '1234 Example St.png');
check('a lone street address is kept whole', fileNameFor('77 Elm Ave'), '77 Elm Ave.png');
check('characters a file name cannot hold are dropped', fileNameFor('12/14 Oak "Rd": Unit*3, Town'), '12 14 Oak Rd Unit 3.png');
check('extra spaces are closed up', fileNameFor('  9   Pine   Ct  , X'), '9 Pine Ct.png');
check('a point with no address keeps the old name', fileNameFor('42.83547, -85.70712'), 'lawn-measurement.png');
check('nothing keeps the old name', fileNameFor(''), 'lawn-measurement.png');
check('null keeps the old name', fileNameFor(null), 'lawn-measurement.png');
check('a very long first part is cut short', fileNameFor('1 ' + 'a'.repeat(200)).length <= 84, true);

console.log(failures ? `\n${failures} check(s) failed` : '\nall file-name checks passed');
process.exit(failures ? 1 : 0);
