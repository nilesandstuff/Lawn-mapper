/**
 * The phone's ground labeller (distill_modal.py) kept in the twin bucket under models/, for the scan page to fetch.
 *   node scan/tools/model-put.mjs <file> <name>      -> models/<name>
 * Sizes only.
 */
import { readFileSync } from 'node:fs';
import { BUCKET, writeObject } from './twin-r2.mjs';

const [file, name] = process.argv.slice(2);
if (!file || !/^[a-z0-9.-]{1,80}$/.test(name || '')) { console.log('model-put: which file, and what name?'); process.exit(1); }
const b = readFileSync(file);
await writeObject(BUCKET, `models/${name}`, b, name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
console.log(`Kept: models/${name} (${(b.length / 1e6).toFixed(1)} MB).`);
