/**
 * Which photo each approved map was drawn and saved on, as {id: provider},
 * for workflow 24's split by photo (tools/compare-runs.js --photos). Runs
 * whose results predate the lot's own `photo` field need it (2026-10-08).
 *
 *   node tools/photo-sources.js photos.json
 */
import { writeFileSync } from 'node:fs';
import { query } from './corpus-db.js';
import { mapName } from '../worker/src/benchmark-ids.js';

const m = {};
for (const r of query("SELECT id, image_provider FROM corpus WHERE status = 'approved'")) m[r.id] = r.image_provider;
console.log(`${Object.values(m).filter((v) => v === 'county').length} of ${Object.keys(m).length} approved maps were drawn on a county photo`);

/*
 * MAPS WITH AN OUTLINE ON EACH PHOTO (owner, 2026-10-08: "the photos don't
 * line up perfectly", so a Mapbox outline scored on a county photo, or the
 * reverse, measures the misfit as much as the model). county_imagery.shapes
 * is an outline traced on the county photo itself; a map that also has its
 * Mapbox outline in corpus.shapes can be scored on either photo against the
 * outline drawn on it. How many there are decides whether S32 can be run.
 */
try {
  const both = query(`SELECT c.id, c.lot_no, c.image_provider, ci.outlines_at
                        FROM county_imagery ci JOIN corpus c ON c.id = ci.id
                       WHERE c.status = 'approved' AND ci.image_key IS NOT NULL
                         AND (ci.review IS NULL OR ci.review != 'off')
                         AND ((c.image_provider != 'county' AND ci.shapes IS NOT NULL)
                              OR (c.image_provider = 'county' AND ci.mapbox_shapes IS NOT NULL AND ci.mapbox_image_key IS NOT NULL))`);
  const names = both.map((r) => `${mapName(r.id, r.lot_no) || r.id.split(':')[0]} (${r.image_provider || '?'})`);
  console.log(`${both.length} approved maps have an outline traced on the county photo as well: ${names.join(', ') || 'none'}`);
} catch (e) {
  console.log(`county-traced outlines not counted: ${e.message}`);
}
writeFileSync(process.argv[2] || 'photos.json', JSON.stringify(m));
