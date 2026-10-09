/**
 * Which photo each approved map was drawn and saved on, as {id: provider},
 * for workflow 24's split by photo (tools/compare-runs.js --photos). Runs
 * whose results predate the lot's own `photo` field need it (2026-10-08).
 *
 *   node tools/photo-sources.js photos.json
 */
import { writeFileSync } from 'node:fs';
import { query } from './corpus-db.js';

const m = {};
for (const r of query("SELECT id, image_provider FROM corpus WHERE status = 'approved'")) m[r.id] = r.image_provider;
console.log(`${Object.values(m).filter((v) => v === 'county').length} of ${Object.keys(m).length} approved maps were drawn on a county photo`);

writeFileSync(process.argv[2] || 'photos.json', JSON.stringify(m));
