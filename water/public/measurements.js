/**
 * THE MEASUREMENTS PAGE (water session; owner, 2026-11-16: "make an admin page for this so i can see the overview of the
 * measurements", "make it so I don't want to have to open each map every time a thermal walk comes in", and the
 * measurements "tied to those admin saves... retroactively reassigning my 27 soil moisture measurements").
 *
 * The administrator only (src/index.js serves it to no one else). It shows, map by map -- the test maps (admin saves,
 * GET /api/maps?admin=1) first -- the readings page's visits with the water map's checks, and the thermal walks: the
 * core's list (GET /api/maps/thermal: converted, waiting or failed) beside the water map's scores (src/truth.js).
 * Readings kept on an ordinary map within 80 m of a test map are offered a move to it (POST /api/water/moisture/move).
 * Then it BRINGS THE TEST MAPS UP TO DATE: each one with a converted walk the current model has not scored, or a visit
 * not yet checked, is opened in a hidden frame with ?auto=1 (public/app.js autoDone), one after another, exactly as
 * opening it would. The addresses are shown here only, in the administrator's browser; nothing is sent anywhere new.
 */
import { MODEL_VERSION } from '/lib/surfacenow.js';
import { isAdminSave, lawnDone, isMoistureUnit, UNIT_WORDS } from '/lib/maps.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HOME = document.documentElement.dataset.home || '';
$('#saves').href = HOME ? `${HOME.replace('://', '://lawnmap.')}/admin-saves.html` : '#';
const getJson = async (u, ms = 10000) => { const r = await fetch(u, { credentials: 'same-origin', signal: AbortSignal.timeout(ms) }); return r.ok ? r.json() : null; };
const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const F = (c) => (Number.isFinite(c) ? `${c * 1.8 > 0 ? '+' : ''}${(c * 1.8).toFixed(1)}` : '-');

const state = { tests: [], plain: [], visits: [], walks: [], core: new Map(), work: new Map() };

async function load() {
  const [tests, plain, mo, tr] = await Promise.all([
    getJson('/api/maps?admin=1'), getJson('/api/maps'), getJson('/api/water/moisture?checks=1', 15000), getJson('/api/water/truth?all=1'),
  ]);
  if (!mo && !tr) { $('#work-say').textContent = 'Nothing could be read: sign in to Lawn Mapper as the administrator and reload.'; return false; }
  state.tests = (tests?.maps || []).filter((m) => m?.id);
  state.plain = (plain?.maps || []).filter((m) => m?.id && !isAdminSave(m));
  state.visits = mo?.visits || [];
  state.walks = tr?.walks || [];
  state.walksRead = !!tr; // the scores could not be read: no walk is offered as still to score (2026-11-18)
  // the core's thermal walks, map by map (the test maps; the ordinary maps only when a walk is already known there)
  const ids = new Set([...state.tests.map((m) => m.id), ...state.walks.map((w) => w.map_id)]);
  await Promise.all([...ids].map(async (id) => {
    const j = await getJson(`/api/maps/thermal?id=${encodeURIComponent(id)}`).catch(() => null);
    state.core.set(id, j?.walks || []);
  }));
  return true;
}

const mapOf = (id) => state.tests.find((m) => m.id === id) || state.plain.find((m) => m.id === id) || null;
const nameOf = (id) => { const m = mapOf(id); return m ? `${isAdminSave(m) ? 'Test map: ' : ''}${m.address || 'a map'}` : 'a map no longer in your list'; };

/** What a map still needs from the water map: walks converted but not scored by the current model; visits unchecked. */
function needs(id) {
  const scored = new Set(state.walks.filter((w) => w.map_id === id && w.results?.some((r) => r.model === MODEL_VERSION && r.kind === 'surface')).map((w) => w.walk));
  const walks = state.walksRead ? (state.core.get(id) || []).filter((w) => w.ok === true && !scored.has(w.walk)).length : 0;
  // the visits a map's own check covers (soil moisture, surface temperature); the rest are the explorer's, with no check to wait for
  const visits = state.visits.filter((v) => v.map_id === id && v.readings?.length && !v.check && (isMoistureUnit(v.unit) || v.unit === 'surface_f')).length;
  return { walks, visits };
}

function render() {
  /* READINGS WAITING FOR A TEST MAP (owner, 2026-11-17: "Line the readings up by the location... Do this
     automatically", and readings taken where no test map is yet are "pinned to an address, and then cued up to have an
     admin map made for them later"). The hourly sweep puts every visit on the test map of the lot it was taken on
     (lib/lineup.js); what is left here has no test map of its lot yet, grouped by parcel (else by day and place). The
     address is looked up on this screen to show and to open Lawn Mapper on; it is never kept. */
  const groups = new Map();
  for (const v of state.visits) {
    if (!v.readings?.length && !v.marks?.length) continue;
    if (v.map_id && isAdminSave(mapOf(v.map_id) || { id: v.map_id })) continue;
    const key = v.parcel_pin ? `pin:${v.parcel_pin}` : `none:${new Date(v.at).toLocaleDateString('en-CA')}:${Number(v.lng).toFixed(3)},${Number(v.lat).toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { pin: v.parcel_pin || null, visits: [] });
    groups.get(key).visits.push(v);
  }
  const KIND = (u) => UNIT_WORDS[u] || 'meter';
  const waits = [...groups.values()].map((g) => {
    const pts = g.visits.flatMap((v) => (v.readings || []).filter((r) => Number.isFinite(r.lng) && Number.isFinite(r.lat)).map((r) => [r.lng, r.lat]));
    const at = pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : [g.visits[0].lng, g.visits[0].lat];
    return { ...g, at, readings: g.visits.reduce((a, v) => a + (v.readings?.length || 0), 0), kinds: [...new Set(g.visits.map((v) => KIND(v.unit)))] };
  });
  const LAWNMAP = HOME ? HOME.replace('://', '://lawnmap.') : '';
  $('#move').innerHTML = waits.length ? `<div class="card"><h2>Readings waiting for a test map</h2>
    <p class="dim">Readings go onto the test map of the lot they were taken on by themselves, within the hour, and a lot with none gets one made (the whole property as lawn). These are still waiting: the hour has not come round, or the county had no property line there. The link makes one by hand.</p>
    ${waits.map((x, k) => `<p>${x.visits.length} set${x.visits.length === 1 ? '' : 's'} of readings (${x.readings}: ${esc(x.kinds.join(', '))}) from ${day(Math.min(...x.visits.map((v) => v.at)))}${x.pin ? '' : ', with no county property line found'} · <span id="wait-at-${k}" class="dim">finding the address…</span></p>`).join('')}</div>` : '';
  waits.forEach(async (x, k) => {
    const el = $(`#wait-at-${k}`);
    if (!x.at.every(Number.isFinite)) { el.textContent = 'no place kept'; return; }
    const j = await getJson(`/api/parcel?lng=${x.at[0]}&lat=${x.at[1]}`).catch(() => null);
    const address = j?.parcel?.properties?.address || null;
    el.innerHTML = address ? `${esc(address)} · <a href="${LAWNMAP}/?address=${encodeURIComponent(address)}" target="_blank" rel="noopener">make its test map</a>` : 'no address found here';
  });

  // map by map: the test maps first, then any ordinary map with something on it
  const ids = [...state.tests.map((m) => m.id), ...[...new Set([...state.visits.map((v) => v.map_id), ...state.walks.map((w) => w.map_id)])].filter((id) => id && !state.tests.some((m) => m.id === id))];
  const cards = ids.map((id) => {
    const vs = state.visits.filter((v) => v.map_id === id && (v.readings?.length || v.marks?.length));
    const core = state.core.get(id) || [], known = state.walks.filter((w) => w.map_id === id);
    const walkIds = [...new Set([...core.map((w) => w.walk), ...known.map((w) => w.walk)])];
    if (!vs.length && !walkIds.length && !isAdminSave(mapOf(id) || { id })) return '';
    const m = mapOf(id), w = state.work.get(id);
    const visitRows = vs.map((v) => {
      const vals = (v.readings || []).map((r) => r.value).sort((a, b) => a - b);
      const unit = UNIT_WORDS[v.unit] || 'meter';
      const chk = v.check ? `rank ${Number.isFinite(v.check.rho) ? v.check.rho.toFixed(2) : '-'} over ${v.check.n} lawn spots` : '<span class="dim">not checked yet</span>';
      return `<tr><td>${day(v.at)}</td><td>${esc(unit)}</td><td>${v.readings?.length || 0}${v.marks?.length ? ` (+${v.marks.length} marks)` : ''}</td><td>${vals.length ? `${vals[0]}–${vals[vals.length - 1]}` : '-'}</td><td>${chk}</td></tr>`;
    }).join('');
    const walkRows = walkIds.map((wid) => {
      const c = core.find((x) => x.walk === wid), t = known.find((x) => x.walk === wid);
      const r = t?.results?.find((x) => x.model === MODEL_VERSION && x.kind === 'surface');
      const status = !c ? (t ? 'kept here' : '-') : c.ok === true ? `<span class="ok">converted</span>${Number.isFinite(c.records) ? `, ${c.records} records` : ''}` : c.ok === false ? `<span class="bad">could not be converted</span>: ${esc(c.error || '')}` : 'waiting to be turned into temperatures (every 2 hours)';
      const st = r?.detail?.station;
      const score = r ? `${r.n} squares, off by ${F(r.bias)} °F on average (RMS ${Number.isFinite(r.rmse) ? (r.rmse * 1.8).toFixed(1) : '-'}), rank ${Number.isFinite(r.rho) ? r.rho.toFixed(2) : '-'}${st && Number.isFinite(st.bias) && !/same as the score/.test(st.air || '') ? `<br><span class="dim">the live map's own prediction (station air, satellite cloud): off by ${F(st.bias)} °F, RMS ${(st.rmse * 1.8).toFixed(1)}</span>` : ''}` : c?.ok === true ? '<span class="dim">not scored yet</span>' : '-';
      const started = t?.started ?? c?.started;
      return `<tr><td>${Number.isFinite(started) ? when(started) : esc(wid)}</td><td>${status}</td><td>${score}</td></tr>`;
    }).join('');
    const versions = [...new Set(known.flatMap((x) => (x.results || []).map((r) => r.model)))];
    const pooled = versions.map((ver) => {
      const rs = known.map((x) => x.results?.find((r) => r.model === ver && r.kind === 'surface')).filter((r) => r && r.n > 0);
      const n = rs.reduce((a, r) => a + r.n, 0);
      if (!n) return '';
      const bias = rs.reduce((a, r) => a + r.bias * r.n, 0) / n, rms = Math.sqrt(rs.reduce((a, r) => a + r.rmse ** 2 * r.n, 0) / n);
      return `<li>${esc(ver)}${ver === MODEL_VERSION ? ' (now)' : ''}: ${rs.length} walk${rs.length === 1 ? '' : 's'}, ${n} squares, off by ${F(bias)} °F on average, RMS ${(rms * 1.8).toFixed(1)} °F</li>`;
    }).join('');
    const state1 = w ? `<p class="dim">${esc(w)}</p>` : '';
    return `<div class="card"><h2>${esc(nameOf(id))}</h2>${m && !lawnDone(m) ? '<p class="dim">Its lawn is not traced yet.</p>' : ''}${state1}
      <p><a class="open" href="/explore?map=${encodeURIComponent(id)}"><b>Open the readings and the model</b></a> <span class="dim">· <a href="/?map=${encodeURIComponent(id)}">its water map</a></span></p>
      ${vs.length ? `<h3>Readings</h3><div class="scroll"><table><tr><th>visit</th><th>what</th><th>spots</th><th>range</th><th>the model against them</th></tr>${visitRows}</table></div>` : ''}
      ${walkRows ? `<h3>Thermal walks</h3><div class="scroll"><table><tr><th>walk</th><th>conversion</th><th>the model against it (now: ${esc(MODEL_VERSION)})</th></tr>${walkRows}</table></div>` : ''}
      ${pooled ? `<h3>Every walk pooled, by model version</h3><ul class="dim">${pooled}</ul>` : ''}
      ${!vs.length && !walkRows ? '<p class="dim">No readings or walks on this map yet.</p>' : ''}</div>`;
  }).join('');
  $('#maps').innerHTML = cards || '<div class="card dim">No measurements yet.</div>';
}

/* one test map in the hidden frame, as opening it would: resolves with the frame's word, or a timeout */
function runOne(id) {
  return new Promise((resolve) => {
    const frame = $('#runner');
    const done = (info) => { window.removeEventListener('message', hear); clearTimeout(timer); frame.src = 'about:blank'; resolve(info); };
    const hear = (e) => { if (e.origin === location.origin && e.data?.type === 'water-auto' && e.data.map === id) done(e.data); };
    const timer = setTimeout(() => done({ ok: false, why: 'took longer than 8 minutes' }), 8 * 60000);
    window.addEventListener('message', hear);
    frame.src = `/?map=${encodeURIComponent(id)}&auto=1`;
  });
}

let working = false, again = false;
async function work() {
  if (working) { again = true; return; } // a move while working: one more round when this one ends
  working = true; again = false;
  const todo = state.tests.filter((m) => lawnDone(m)).map((m) => ({ m, n: needs(m.id) })).filter((x) => x.n.walks || x.n.visits);
  const list = $('#work-list');
  const unread = state.walksRead ? '' : ' The walks\' scores could not be read just now, so none is offered here; the hourly scoring keeps them up to date.';
  if (!todo.length) { $('#work-say').textContent = `Every test map is up to date.${unread}`; list.innerHTML = ''; working = false; return; }
  $('#work-say').textContent = `${todo.length} test map${todo.length === 1 ? '' : 's'} to bring up to date. Keep this page open; each takes a minute or two.`;
  list.innerHTML = todo.map((x) => `<li id="w-${esc(x.m.id).replace(/[^\w-]/g, '_')}">${esc(nameOf(x.m.id))}: ${[x.n.walks ? `${x.n.walks} walk${x.n.walks === 1 ? '' : 's'} to score` : '', x.n.visits ? `${x.n.visits} visit${x.n.visits === 1 ? '' : 's'} to check` : ''].filter(Boolean).join(', ')}</li>`).join('');
  for (const x of todo) {
    const li = document.getElementById(`w-${x.m.id.replace(/[^\w-]/g, '_')}`);
    if (li) li.insertAdjacentHTML('beforeend', ' · <b>working…</b>');
    const r = await runOne(x.m.id);
    const said = r.ok ? `done${r.scored ? `: ${r.scored} walk${r.scored === 1 ? '' : 's'} scored` : ''}${r.waiting ? `, ${r.waiting} waiting to be converted` : ''}` : `not done (${r.why || 'no reason'})`;
    state.work.set(x.m.id, `Last brought up to date ${when(Date.now())}: ${said}.`);
    if (li) li.innerHTML = `${esc(nameOf(x.m.id))}: ${esc(said)}`;
  }
  $('#work-say').textContent = 'Finished. The numbers below are the latest.';
  await load(); render();
  working = false;
  if (again) work();
}

(async () => {
  if (await load()) { render(); work(); }
})();
