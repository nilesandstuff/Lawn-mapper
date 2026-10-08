/**
 * Which approved maps' inferred areas the owner does not trust
 * (corpus.inferred_doubt = 1), as {ids: [...]} for tools/train_decoder.py,
 * which grades those lots on seen ground only (owner, 2026-10-08).
 *
 *   node tools/inferred-doubt.js inferred-doubt.json      (workflow 14)
 */
import { writeFileSync } from 'node:fs';
import { query } from './corpus-db.js';

const ids = query("SELECT id FROM corpus WHERE status = 'approved' AND inferred_doubt = 1").map((r) => r.id);
writeFileSync(process.argv[2] || 'inferred-doubt.json', JSON.stringify({ ids }));
console.log(`${ids.length} approved map${ids.length === 1 ? '' : 's'} with inferred ground the owner does not trust.`);
