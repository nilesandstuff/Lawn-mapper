/** Checks for worker/src/model-versions.js.   node tools/model-versions.test.js */
import { MODEL_VERSIONS, stageFor, modelName, currentModel, versionHistory } from '../worker/src/model-versions.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};
check('the live model is named as the owner asked', modelName(currentModel()) === 'Turf Trace - alpha version 3 (79% accuracy)', modelName(currentModel()));
check('beta from 82%, no stage from 86%', stageFor(81) === 'alpha' && stageFor(82) === 'beta' && stageFor(85) === 'beta' && stageFor(86) === null);
check('a stageless name reads cleanly', modelName({ version: 9, accuracy: 88 }) === 'Turf Trace - version 9 (88% accuracy)');
const h = versionHistory();
check('history is newest first with only the newest marked live', h[0].version === 3 && h[0].live && !h[1].live && h.length === MODEL_VERSIONS.length);
check('versions count up by one', MODEL_VERSIONS.every((v, i) => v.version === i + 1));
check('dates and figures are present on every row', MODEL_VERSIONS.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.shipped) && v.accuracy > 0 && v.accuracy <= 100));
if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nmodel versions: ok');
