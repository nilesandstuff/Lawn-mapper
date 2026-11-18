/**
 * THE SCORED SQUARES OUT OF THE WATER DATABASE, FOR THE RESIDUAL ANALYSIS (2026-11-18; tools/residuals.py reads what
 * this writes). Every walk's truth_squares under the current model, named W1, W2... in the order they were walked (as
 * the readings report names them), with the property each was on as a number. No place, map id or parcel number.
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. node water/tools/residuals.mjs > residuals.json
 */
process.env.DB_NAME = 'lawn-water';
const { query } = await import('../../tools/corpus-db.js');
const { MODEL_VERSION } = await import('../lib/surfacenow.js');
const { KNOB_WHAT } = await import('../lib/residuals.js');

const walks = query('SELECT walk, map_id, parcel_pin, started, notes FROM truth_walks ORDER BY started');
let squares = [];
try { squares = query('SELECT walk, model, scoring, n, data FROM truth_squares'); } catch { /* no table yet */ }
const props = new Map(), out = [];
walks.forEach((w, k) => {
  const key = w.parcel_pin || w.map_id;
  if (!props.has(key)) props.set(key, props.size + 1);
  const sq = squares.find((s) => s.walk === w.walk && s.model === MODEL_VERSION);
  if (!sq) return;
  let d = null; try { d = JSON.parse(sq.data); } catch { return; }
  let notes = {}; try { notes = JSON.parse(w.notes || '{}') || {}; } catch { /* none */ }
  out.push({ name: `W${k + 1}`, property: props.get(key), started: w.started, sprinklers: notes.sprinklers ?? null, cols: d.cols, rows: d.rows });
});
process.stdout.write(JSON.stringify({ model: MODEL_VERSION, knobs: KNOB_WHAT, walks: out, unscored: walks.length - out.length }));
