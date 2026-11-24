/**
 * THE READINGS AGAINST THE MODEL (water session, 2026-11-02; the thermal walks added 2026-11-15, when the owner asked
 * for "a more stable way to evaluate the readings rather than a token and scratch space... Like a GitHub workflow? I'd
 * save Claude usage that way too"): what the water database holds, read straight from it here, in CI -- the readings
 * page's visits (soil moisture and surface temperature), the water map's checks of the model against them, and the
 * thermal walks with every model version's score. The checks themselves are worked out in the admin's browser when
 * the map is opened (the same code as the page shows); this gathers them. The repository and its workflow logs are
 * public, so this prints numbers only: visits are #1, #2... in the order they were taken, walks W1, W2..., with no
 * place, parcel number or map id. Run by the workflow's "readings" task (also "moisture"); the end of the log is the
 * summary.
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. node water/tools/moisture.mjs
 */
process.env.DB_NAME = 'lawn-water';
const { query } = await import('../../tools/corpus-db.js');

const visits = query('SELECT id, at, parcel_pin, unit, depth_in, meter, weather, map_id FROM moisture_visits ORDER BY at');
const rows = query('SELECT visit_id, spot, value FROM moisture_readings');
const props = new Map(), spotsSeen = new Map();
// which walk's map a visit is on (W1, W2... as numbered below), so a visit and a walk at the same lot read as one
let walkMaps = [];
try { walkMaps = query('SELECT map_id FROM truth_walks ORDER BY started').map((w) => w.map_id); } catch { /* no table yet */ }
const onWalks = (id) => { const ws = walkMaps.map((m, k) => (id && m === id ? `W${k + 1}` : null)).filter(Boolean); return ws.length ? `  the map of ${ws.join(', ')}` : ''; };
console.log(`${visits.length} visit${visits.length === 1 ? '' : 's'}, ${rows.length} reading${rows.length === 1 ? '' : 's'}.`);
console.log('=====');
visits.forEach((v, k) => {
  if (!props.has(v.parcel_pin || v.id)) props.set(v.parcel_pin || v.id, props.size + 1);
  const r = rows.filter((x) => x.visit_id === v.id), vals = r.map((x) => x.value).sort((a, b) => a - b);
  const again = r.filter((x) => spotsSeen.has(x.spot)).length;
  for (const x of r) spotsSeen.set(x.spot, true);
  const u = { vwc: '%', scale: ' (scale)', surface_f: ' F surface', soil_f: ' F soil', airtemp_f: ' F air', wind_mph: ' mph wind' }[v.unit] || '';
  const w = (() => { try { return JSON.parse(v.weather || 'null')?.lastTwoDays || '-'; } catch { return '-'; } })();
  console.log(`#${k + 1}  ${new Date(v.at).toISOString().slice(0, 10)}  property ${props.get(v.parcel_pin || v.id)}  ${r.length} readings  ${vals.length ? `${vals[0]}-${vals[vals.length - 1]}${u}, median ${vals[vals.length >> 1]}` : ''}  depth ${v.depth_in ?? '?'} in  re-read ${again}  last 2 days: ${w}${v.map_id ? '  (a saved map)' : ''}${onWalks(v.map_id)}`);
});
console.log(`${props.size} propert${props.size === 1 ? 'y' : 'ies'}; ${spotsSeen.size} spots.`);

// the water map's checks (public/app.js moistureCard): numbers only, worked out in the admin's browser
let checks = [];
try { checks = query('SELECT visit_id, checked, rho, n, detail FROM moisture_checks'); } catch { /* no table yet */ }
console.log('=====');
console.log(checks.length ? 'THE MODEL AGAINST THE READINGS (rank correlation over lawn spots; wet = root-zone water / field capacity, rain alone)' : 'No check yet: open the map these readings were taken on, as the admin, on the water site.');
const f = (x, d = 2) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
for (const c of checks) {
  const k = visits.findIndex((v) => v.id === c.visit_id);
  let det = {}; try { det = JSON.parse(c.detail || '{}'); } catch { /* none */ }
  const st = det.settings || {}, spots = det.spots || [];
  if (visits[k]?.unit === 'soil_f' || det.kind === 'soil') {
    // a field visit's soil thermometer against the model's soil at that depth and time (the water builder, 2026-11-17)
    const F1 = (c) => (c === null || c === undefined ? '-' : (c * 1.8 > 0 ? '+' : '') + (c * 1.8).toFixed(1));
    const toF = (c) => (c === null || c === undefined ? '-' : (c * 1.8 + 32).toFixed(1));
    console.log(`#${k + 1}  SOIL TEMPERATURE at ${det.depth_in ?? '?'} in  checked ${new Date(c.checked).toISOString().slice(0, 16)}  ${det.model || ''}  n ${c.n}  measured - model ${F1(det.bias)} F  RMS ${det.rmse === null || det.rmse === undefined ? '-' : (det.rmse * 1.8).toFixed(1)} F  rho ${f(c.rho)}  the model's air ${toF(det.air)} F`);
    console.log('   n  reading_F  model_F  to_lawn_m  on_grid  off_box_m  cell_kind');
    for (const s of spots) console.log(`  ${String(s.n).padStart(2)}  ${toF(s.value).padStart(8)}  ${toF(s.model).padStart(7)}  ${String(s.lawnM ?? '-').padStart(9)}  ${String(s.inGrid ?? '-').padStart(7)}  ${String(s.boxM ?? '-').padStart(9)}  ${String(s.kind ?? '-').padStart(9)}`);
    continue;
  }
  if (visits[k]?.unit === 'surface_f') {
    // a surface-temperature visit: each spot's surface minus the air, measured and modelled (F)
    console.log(`#${k + 1}  SURFACE  checked ${new Date(c.checked).toISOString().slice(0, 16)}  ${st.season || ''}  rho ${f(c.rho)} over ${c.n} lawn spots`);
    console.log('   n  reading_F  model_vs_air_F  lawn');
    for (const s of spots) console.log(`  ${String(s.n).padStart(2)}  ${String(s.value).padStart(8)}  ${f(s.wet, 1).padStart(13)}  ${String(s.lawn ?? '-').padStart(4)}`);
    continue;
  }
  console.log(`#${k + 1}  checked ${new Date(c.checked).toISOString().slice(0, 16)}  model date ${st.date || '?'}  rho ${f(c.rho)} over ${c.n} lawn spots  root zone ${st.rootMm ?? '?'} mm  probe ${st.depth_in ?? '?'} in`);
  console.log('   n  reading  wet   lawn off_m cells zone peak_month_need_mm');
  for (const s of spots) console.log(`  ${String(s.n).padStart(2)}  ${String(s.value).padStart(6)}  ${f(s.wet).padStart(5)}  ${String(s.lawn ?? s.kind ?? '-').padStart(4)}  ${f(s.off, 1).padStart(4)}  ${String(s.cells ?? '-').padStart(4)}  ${String(s.zone ?? '-').padStart(3)}  ${s.need === null || s.need === undefined ? '-' : Math.round(s.need)}`);
}

// THE THERMAL WALKS (src/truth.js): each walk tied to its property, every model version's score kept
let walks = [], results = [], weather = [];
try {
  walks = query('SELECT walk, map_id, parcel_pin, started, ended, kinds, notes FROM truth_walks ORDER BY started');
  results = query('SELECT walk, model, kind, checked, n, bias, rmse, rho, detail FROM truth_results ORDER BY checked');
  weather = query('SELECT walk, sources, series FROM truth_weather');
} catch { /* no tables yet */ }
const F = (c) => (c === null || c === undefined ? '-' : (c * 1.8 > 0 ? '+' : '') + (c * 1.8).toFixed(1));
console.log('=====');
console.log(walks.length ? 'THE THERMAL WALKS AGAINST THE MODEL (measured minus modelled, F; each half-meter square at its own minute)' : 'No thermal walk yet.');
const wprops = new Map();
walks.forEach((w, k) => {
  const key = w.parcel_pin || w.map_id;
  if (!wprops.has(key)) wprops.set(key, wprops.size + 1);
  let notes = {}; try { notes = JSON.parse(w.notes || '{}') || {}; } catch { /* none */ }
  const src = (() => { try { return JSON.parse(weather.find((x) => x.walk === w.walk)?.sources || '[]').map((x) => x.name.split(' (')[0] + (Number.isFinite(x.km) ? ` ${x.km} km` : '')).join(', '); } catch { return ''; } })();
  const mins = w.ended ? Math.round((w.ended - w.started) / 6e4) : '?';
  console.log(`W${k + 1}  ${new Date(w.started).toISOString().slice(0, 16)}Z  property ${wprops.get(key)}  ${mins} min  ${w.kinds || '-'}  sprinklers ${notes.sprinklers ?? '-'}  wet ${notes.wet ?? '-'}  sky cloud ${notes.sky?.cloud_fraction ?? '-'}  weather: ${src || 'not fetched yet'}`);
  /* THE AIR (owner, 2026-11-17: "my observed air temp was cooler than the weather station"): the walker's thermometer
     against the airport station and Open-Meteo's model at the walk's middle, and which one the score used */
  {
    let series = []; try { series = JSON.parse(weather.find((x) => x.walk === w.walk)?.series || '[]') || []; } catch { /* none */ }
    const mid = w.ended ? (w.started + w.ended) / 2 : w.started;
    const near = (src) => series.filter((r) => r.src === src && Number.isFinite(r.ta)).sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid))[0] || null;
    const st = near('asos'), om = near('hrrr');
    const airs = (notes.air || []).map((a) => (Number.isFinite(a?.T) ? (a.unit === 'F' ? a.T : a.T * 1.8 + 32) : null)).filter(Number.isFinite);
    const fF = (c) => (c === null ? '-' : `${(c * 1.8 + 32).toFixed(1)} F`);
    const used = (() => { try { return JSON.parse(results.filter((x) => x.walk === w.walk).at(-1)?.detail || '{}')?.used?.air || '-'; } catch { return '-'; } })();
    console.log(`    air: walker ${airs.length ? airs.map((x) => `${x.toFixed(1)} F`).join(' / ') : 'not read'}  | station ${st ? fF(st.ta) : '-'}${st ? ` (${Math.round(Math.abs(st.t - mid) / 6e4)} min off)` : ''}  | Open-Meteo ${om ? fF(om.ta) : '-'}  | the score used: ${used}`);
  }
  for (const r of results.filter((x) => x.walk === w.walk)) {
    let d = {}; try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* none */ }
    // which 3D model the shade stood on (2026-11-24): the fused model where the map has one, and the same walk on the lidar alone beside it
    if (d.shape) {
      const la = d.lidarAlone, sp = (x) => (x && Number.isFinite(x.rmse) ? `mean ${F(x.bias)} RMS ${(x.rmse * 1.8).toFixed(1)} rho ${Number.isFinite(x.rho) ? x.rho.toFixed(2) : '-'}` : '-');
      console.log(`      the shade stood on: ${d.shape.model === 'fused' ? `THE FUSED MODEL (the lidar and a yard walk; fusing version ${d.shape.from?.version ?? '-'})` : `the lidar${d.shape.why ? ` (${d.shape.why})` : d.fusedAt ? ' (a fused model exists but was not used)' : ''}`}${d.shape.model === 'fused' ? (la ? `  | fused: ${sp(r)}  | the lidar alone: ${sp(la)}  (${la.n} squares; sun ${F(la.sun?.bias)}, shade ${F(la.shade?.bias)})` : '  | the lidar alone: not scored yet') : ''}`);
    }
    if (d.align) console.log(`      the map: lidar ${d.align.shade ? (d.align.confident === true ? 'fitted to the photo' : d.align.confident === false ? `on the datum alone (fit not confident${d.align.why ? `: ${d.align.why}` : ''})` : 'shift kept, no fit recorded') : 'no shade part'}, moved ${d.align.shiftM ?? '-'} m; photo ${d.align.provider || '-'}${d.align.lineup ? ' with a line-up' : ''}; lawn ${d.align.trace || '-'}`);
    const sh = d.sunShade || {}, b = d.bands || {};
    console.log(`    ${r.model}  ${r.kind}: n ${r.n}  mean ${F(r.bias)}  RMS ${r.rmse === null ? '-' : (r.rmse * 1.8).toFixed(1)}  rho ${f(r.rho)}  | sun ${F(sh.sun?.bias)} (${sh.sun?.n ?? 0})  shade ${F(sh.shade?.bias)} (${sh.shade?.n ?? 0})  | 60-70 ${F(b['60-70']?.bias)} (${b['60-70']?.n ?? 0})  70-80 ${F(b['70-80']?.bias)} (${b['70-80']?.n ?? 0})`);
    // the same walk on the station's air (scoring 2, 2026-11-17): what the live map, which has only the station's, can do
    const st = d.station;
    // by distance from paving (2026-11-17): the grass beside a driveway against the model's edge term (S8)
    if (d.edge) console.log(`      from paving: ${Object.entries(d.edge).map(([b, x]) => `${b} ${F(x.bias)} (${x.n || 0}${x.sun?.n ? `, sun ${F(x.sun.bias)}` : ''})`).join('  ')}  | live map: ${Object.entries(d.edge).map(([b, x]) => `${b} ${F(x.live?.bias)}`).join('  ')}`);
    if (st && Number.isFinite(st.bias)) console.log(`      the live map's own (station air, satellite cloud): mean ${F(st.bias)}  RMS ${(st.rmse * 1.8).toFixed(1)}  rho ${f(st.rho)}  | sun ${F(st.sun?.bias)}  shade ${F(st.shade?.bias)}  | the air at mid-walk: walker ${Number.isFinite(st.airWalker) ? (st.airWalker * 1.8 + 32).toFixed(1) : '-'} F, station ${Number.isFinite(st.airMid) ? (st.airMid * 1.8 + 32).toFixed(1) : '-'} F`);
  }
});
// pooled by model version: the line to read first when the model changes
const versions = [...new Set(results.filter((r) => r.kind === 'surface').map((r) => r.model))];
if (versions.length) {
  console.log('=====');
  console.log('EVERY WALK POOLED, BY MODEL VERSION (surface; mean and RMS in F, weighted by squares)');
  for (const v of versions) {
    const rs = results.filter((r) => r.model === v && r.kind === 'surface' && r.n > 0);
    const n = rs.reduce((a, r) => a + r.n, 0);
    if (!n) continue;
    const bias = rs.reduce((a, r) => a + r.bias * r.n, 0) / n, rms = Math.sqrt(rs.reduce((a, r) => a + r.rmse ** 2 * r.n, 0) / n);
    const rhos = rs.map((r) => r.rho).filter(Number.isFinite).sort((a, b) => a - b);
    console.log(`  ${v}: ${rs.length} walks, ${n} squares, mean ${F(bias)}, RMS ${(rms * 1.8).toFixed(1)}, median rho ${rhos.length ? rhos[rhos.length >> 1].toFixed(2) : '-'}  (the walker's air)`);
    const sts = rs.map((r) => { try { return JSON.parse(r.detail || '{}')?.station; } catch { return null; } }).filter((x) => x && x.n > 0 && Number.isFinite(x.bias));
    const ns = sts.reduce((a, x) => a + x.n, 0);
    if (ns) console.log(`  ${' '.repeat(v.length)}  ${sts.length} walks, ${ns} squares, mean ${F(sts.reduce((a, x) => a + x.bias * x.n, 0) / ns)}, RMS ${(Math.sqrt(sts.reduce((a, x) => a + x.rmse ** 2 * x.n, 0) / ns) * 1.8).toFixed(1)}  (the live map's own prediction)`);
  }
}

// WHAT THE PAGES READ BACK (2026-11-18: the measurements page listed two scored walks as still to score): every stored
// JSON field the GET /api/water/truth route parses, checked here; one that does not parse fails the whole route
{
  const bad = [];
  const tryParse = (v) => { if (v === null || v === undefined || v === '') return true; try { JSON.parse(v); return true; } catch { return false; } };
  for (const w of walks) if (!tryParse(w.notes)) bad.push(`walk W${walks.indexOf(w) + 1} notes (${String(w.notes).length} chars)`);
  for (const x of weather) if (!tryParse(x.sources)) bad.push(`weather sources of W${walks.findIndex((w) => w.walk === x.walk) + 1}`);
  for (const r of results) if (!tryParse(r.detail)) bad.push(`result of W${walks.findIndex((w) => w.walk === r.walk) + 1}, ${r.kind}, ${r.model} (${String(r.detail).length} chars)`);
  console.log('=====');
  console.log(`STORED RECORDS THE PAGES READ: ${results.length} results, ${walks.length} walks; ${bad.length ? `${bad.length} that do not parse: ${bad.join('; ')}` : 'all parse'}`);
}

// WHICH MAP EACH WALK AND VISIT IS FILED UNDER (2026-11-18: the measurements page showed two cards for "a map no
// longer in your list" and offered scored walks again): each map id as a short hash and its length (an id holds an
// address, so never the id), and whether it is one of the test maps the hourly sweep scores (kit_jobs' model rows)
{
  const { createHash } = await import('node:crypto');
  const h = (id) => (id ? createHash('sha256').update(String(id)).digest('hex').slice(0, 8) : '-');
  let saveIds = new Set();
  try { saveIds = new Set(query("SELECT map_id FROM kit_jobs WHERE kind = 'model'").map((r) => r.map_id)); } catch { /* none */ }
  const pre = (id) => [...saveIds].some((sid) => id && sid !== id && sid.startsWith(id));
  console.log('=====');
  console.log(`MAP IDS (hash, length, a test map the sweep knows; "cut" = the start of a longer test map id): ${saveIds.size} test maps known`);
  walks.forEach((w, k) => console.log(`  W${k + 1}  ${h(w.map_id)}  ${String(w.map_id || '').length}  ${saveIds.has(w.map_id) ? 'test map' : pre(w.map_id) ? 'CUT' : 'not a test map'}`));
  visits.forEach((v, k) => console.log(`  #${k + 1}  ${h(v.map_id)}  ${String(v.map_id || '').length}  ${!v.map_id ? 'no map' : saveIds.has(v.map_id) ? 'test map' : pre(v.map_id) ? 'CUT' : 'not a test map'}`));
}

// THE NO-PAGE SCORING'S QUEUE (src/jobs.js, src/autoscore.js): what the main site pushed and what became of it
let jobs = [];
try { jobs = query('SELECT kind, state, tries, detail, queued FROM kit_jobs ORDER BY queued'); } catch { /* no table yet */ }
console.log('=====');
if (!jobs.length) console.log('No job from the main site yet (the no-page scoring).');
else {
  const count = (k, st) => jobs.filter((j) => j.kind === k && j.state === st).length;
  console.log(`THE NO-PAGE SCORING: maps ${count('model', 'done')} done, ${count('model', 'queued')} queued, ${count('model', 'failed')} failed; walks ${count('walk', 'done')} scored, ${count('walk', 'queued')} queued, ${count('walk', 'failed')} failed`);
  for (const j of jobs.filter((x) => x.state !== 'done' || x.kind === 'walk').slice(-12)) console.log(`  ${j.kind} ${j.state}, ${j.tries} tr${j.tries === 1 ? 'y' : 'ies'}, queued ${new Date(j.queued).toISOString().slice(0, 16)}Z${j.detail ? `: ${String(j.detail).replace(/-?\d{1,3}\.\d{4,}/g, '?')}` : ''}`);
}
let klog = [];
try { klog = query('SELECT at, what FROM kit_log ORDER BY at DESC LIMIT 12'); } catch { /* no table yet */ }
if (klog.length) { console.log('THE TIMER\'S LAST RUNS (newest first):'); for (const l of klog) console.log(`  ${new Date(l.at).toISOString().slice(0, 16)}Z  ${String(l.what).replace(/-?\d{1,3}\.\d{4,}/g, '?')}`); }
