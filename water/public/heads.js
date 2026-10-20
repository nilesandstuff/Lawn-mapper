/**
 * YOUR SPRINKLERS: the first step on the water map (water session; owner, 2026-10-20). In order:
 *
 *   place    each head, by a tap on the photo or by GPS (a calibration on a spot the person can stand on
 *            exactly, a driveway or property-line corner, then each head averaged while standing on it)
 *   review   drag any head that is off, then confirm
 *   zones    select heads, give them the valve (irrigation zone) they are on
 *   models   select heads, give them a brand and model, and the nozzle (one for all, or one by one)
 *   details  the map of heads and zones with each head's details over it; confirm
 *   supply   the pipe from the backflow preventer to the valve box, and the pressure
 *   lines    the line from the valve box to each zone, from standard sizes
 *   done
 *
 * The page (app.js) owns the photo, the zoom and the save; this module owns the steps, the panel and what
 * it draws on the photo. Kept with the map as the water part's `irrigation` (POST /api/maps/tool).
 */

import { catalogue, headWater, zoneWater, PIPES, pipe, lineCheck, gpmAt, psiPer100ft, calibrate, placeByGps, facing, arcOf } from '/lib/heads.js';

const FILES = ['rainbird-sprays', 'rainbird-rotors', 'hunter-sprays', 'hunter-rotors', 'other-brands'];
const ZONE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835', '#6d4c41', '#d81b60', '#3949ab', '#7cb342', '#546e7a'];
const STEPS = ['place', 'review', 'zones', 'models', 'details', 'supply', 'lines'];
const STEP_TITLE = { place: 'Place your sprinkler heads', review: 'Check where they are', zones: 'Which valve is each head on?', models: 'What heads and nozzles are they?', details: 'Your system', supply: 'The water coming in', lines: 'The lines to each zone' };
// what a backflow preventer and a zone valve take, together, at a home system's flows (makers' loss
// charts run about 3-8 psi for a 1 in PVB at 8-12 gpm and 2-4 psi for a 1 in valve): an estimate
const FITTINGS_PSI = 8, ASSUMED_RUN_FT = 50;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ft = (m) => Math.round(m * 3.281);
/** A head's throw in words: its arc and radius, or a strip's rectangle. */
const throwOf = (w) => (w.strip ? `${Math.round(w.strip.widthFt)} x ${Math.round(w.strip.lengthFt)} ft strip` : `${Math.round(w.arc)}° · ${Math.round(w.radiusFt)} ft`);

export function emptyIrrigation() {
  return { v: 1, done: false, none: false, heads: [], zones: [], supply: { pipe: null, psi: null } };
}

/**
 * ctx: { panel, title, draw(), tapPx(ev) -> [x, y] canvas px, toLngLat([x, y]) -> [lng, lat],
 *        toPx([lng, lat]) -> [x, y], pxPerM(), cssScale() canvas px per CSS px, lawnMiddle() -> [lng, lat],
 *        changed(), finish() }
 */
export function sprinklers(ctx) {
  let irr = emptyIrrigation();
  let step = null, cat = null, catNote = '';
  const sel = new Set();
  const gps = { on: false, watch: null, fixes: [], cal: null, phase: null, ref: null, live: null, busy: false };
  let drag = null, dragged = false, placeMode = 'tap', labelsHidden = 0;
  let nextId = 1;

  const loadCat = (async () => {
    const files = await Promise.all(FILES.map((f) => fetch(`/lib/heads/${f}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    cat = catalogue(files);
    const missing = FILES.filter((f, k) => !files[k]);
    catNote = missing.length ? `Not yet in the list: ${missing.map((m) => m.replace('-', ' ')).join(', ')}.` : '';
  })();

  const zoneN = () => irr.zones.map((z) => z.n);
  const colorOf = (n) => (n ? ZONE_COLORS[(n - 1) % ZONE_COLORS.length] : '#ffffff');
  const head = (id) => irr.heads.find((h) => h.id === id);
  const zonePsi = (z) => {
    // the pressure at a zone's heads: what comes in, less the backflow preventer and valve, and friction in
    // an assumed 50 ft of supply line and 50 ft of zone line at the zone's flow (an estimate: about)
    const psi = irr.supply.psi;
    if (!Number.isFinite(psi)) return null;
    let p = psi - FITTINGS_PSI, gpm = 0;
    for (let k = 0; k < 2; k++) {
      gpm = zoneWater(irr.heads.filter((h) => h.zone === z.n), cat, p).gpm;
      const sup = pipe(irr.supply.pipe), line = pipe(z.line);
      p = psi - FITTINGS_PSI - (sup && gpm ? (psiPer100ft(sup, gpm) * ASSUMED_RUN_FT) / 100 : 0) - (line && gpm ? (psiPer100ft(line, gpm) * ASSUMED_RUN_FT) / 100 : 0);
    }
    return Math.max(10, p);
  };
  const waterOf = (h) => {
    if (!cat) return null;
    const z = irr.zones.find((x) => x.n === h.zone);
    return headWater(h, cat, z ? zonePsi(z) : irr.supply.psi ?? null);
  };

  /* ------------------------------------------------------------------ the panel */

  function render() {
    const P = ctx.panel;
    if (!step) { P.hidden = true; ctx.title.hidden = true; return; }
    P.hidden = false; ctx.title.hidden = false;
    const k = STEPS.indexOf(step);
    ctx.title.innerHTML = step === 'intro' ? '<strong>Step 1: your sprinklers</strong>' : `<strong>Sprinklers, ${k + 1} of ${STEPS.length}: ${STEP_TITLE[step]}</strong>`;
    P.innerHTML = BODY[step]();
    WIRE[step]?.(P);
    ctx.draw();
  }
  const go = (s) => { step = s; sel.clear(); if (s !== 'place') stopGps(); render(); };
  const back = () => go(step === 'place' ? 'intro' : STEPS[Math.max(0, STEPS.indexOf(step) - 1)]);
  const nav = (next, { ok = true, label = 'Next' } = {}) => `<div class="tools"><button type="button" class="plain" data-act="back">Back</button><button type="button" data-act="next" ${ok ? '' : 'disabled'}>${label}</button></div>`;
  const wireNav = (P, next) => {
    P.querySelector('[data-act=back]')?.addEventListener('click', back);
    P.querySelector('[data-act=next]')?.addEventListener('click', next);
  };
  const changed = () => { ctx.changed(); ctx.draw(); };

  const BODY = {
    intro: () => `<p>Before the watering plan: where your sprinkler heads are, which valve each is on, and what heads and nozzles they are. With them the plan can say how long to run each zone, not just how much water it needs.</p>
      <div class="tools"><button type="button" data-act="start">Map my sprinklers</button><button type="button" class="plain" data-act="none">I don't have an in-ground system</button></div>`,

    place: () => `<div class="tools"><label class="toggle"><input type="radio" name="pm" value="tap" ${placeMode === 'tap' ? 'checked' : ''}> Tap on the photo</label><label class="toggle"><input type="radio" name="pm" value="gps" ${placeMode === 'gps' ? 'checked' : ''}> Walk the lawn with GPS</label></div>
      ${placeMode === 'tap' ? '<p class="hint">Tap each sprinkler head on the photo. Zoom in for a closer look.</p>' : gpsBody()}
      <p class="dim">${irr.heads.length} head${irr.heads.length === 1 ? '' : 's'} placed.</p>
      <div class="tools"><button type="button" class="plain" data-act="undo" ${irr.heads.length ? '' : 'disabled'}>Undo the last</button></div>
      ${nav('review', { ok: irr.heads.length > 0, label: 'Done placing' })}`,

    review: () => `<p class="hint">Drag any head that is not where it should be. Tap one, then "Remove", to take it off.</p>
      <div class="tools"><button type="button" class="plain" data-act="remove" ${sel.size ? '' : 'disabled'}>Remove the selected</button></div>
      ${nav('zones', { label: 'They are right' })}`,

    zones: () => {
      const unassigned = irr.heads.filter((h) => !h.zone).length;
      return `<p class="hint">Tap heads to select them, then tap the valve they are on (or "+ A new zone"). A zone is everything one valve turns on.</p>
        <div class="tools"><button type="button" class="plain" data-act="all">Select all not yet on a valve</button><button type="button" class="plain" data-act="clearsel">Clear the selection</button></div>
        <div class="tools">${zoneN().map((n) => `<button type="button" data-zone="${n}" style="background:${colorOf(n)};border-color:${colorOf(n)}" ${sel.size ? '' : 'disabled'}>Zone ${n}</button>`).join('')}<button type="button" class="plain" data-act="newzone" ${sel.size ? '' : 'disabled'}>+ A new zone</button></div>
        <p class="dim">${sel.size} selected; ${unassigned ? `${unassigned} not on a valve yet` : 'every head is on a valve'}.</p>
        ${nav('models', { ok: !unassigned && irr.heads.length })}`;
    },

    models: () => {
      const missing = irr.heads.filter((h) => !h.nozzle).length;
      return `<p class="hint">Tap heads to select them (or a whole zone), then choose what they are. Heads that differ can be done one at a time.</p>
        <div class="tools">${zoneN().map((n) => `<button type="button" class="plain" data-pick="${n}" style="border-color:${colorOf(n)}">All of zone ${n}</button>`).join('')}<button type="button" class="plain" data-act="clearsel">Clear</button></div>
        ${sel.size ? modelForm() : '<p class="dim">Select heads to choose their model.</p>'}
        <p class="dim">${missing ? `${missing} head${missing > 1 ? 's' : ''} still without a nozzle.` : 'Every head has its nozzle.'} ${esc(catNote)}</p>
        ${nav('details', { ok: !missing })}`;
    },

    details: () => {
      const rows = irr.zones.map((z) => {
        const hs = irr.heads.filter((h) => h.zone === z.n), w = cat ? zoneWater(hs, cat, zonePsi(z)) : null;
        return `<tr><td><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}</td><td>${hs.length}</td><td>${w ? w.gpm.toFixed(1) : '?'} gpm</td><td>${w?.precipInH ? `${w.precipInH.toFixed(2)} in/h` : '?'}${w?.mixed ? ' <strong>(sprays and rotors mixed)</strong>' : ''}</td></tr>`;
      }).join('');
      return `<p class="hint">Each head's details are over it on the map (zoom in where they crowd); the shaded fans are where each throws. Tap a head to see it here.</p>
        ${sel.size === 1 ? `<p>${headLine(head([...sel][0]))}</p>` : ''}
        <table class="months"><tr><th>Zone</th><th>Heads</th><th>Flow</th><th>Puts down</th></tr>${rows}</table>
        <p class="dim">Flows are at ${Number.isFinite(irr.supply.psi) ? 'the pressure you give next, less what the fittings and lines take' : 'the chart\'s middle pressure until you give yours next'}. "Puts down" is the heads' rate at head-to-head spacing. The fans point toward the middle of the lawn until you turn them (coming).</p>
        ${nav('supply', { label: 'Looks right' })}`;
    },

    supply: () => `<p>The pipe from your backflow preventer (the valve assembly where the system leaves the house, often a PVB) to the valve box:</p>
      <select data-act="supplypipe" aria-label="Supply pipe">${pipeOptions(irr.supply.pipe)}</select>
      <p>The water pressure, in psi (a gauge on an outside tap with nothing else running; homes are often 40-80):</p>
      <input type="number" inputmode="decimal" min="10" max="150" step="1" data-act="psi" value="${Number.isFinite(irr.supply.psi) ? irr.supply.psi : ''}" style="width:120px;padding:8px;font-size:16px">
      ${nav('lines', { ok: !!irr.supply.pipe && Number.isFinite(irr.supply.psi) })}`,

    lines: () => {
      const rows = irr.zones.map((z) => {
        const hs = irr.heads.filter((h) => h.zone === z.n), w = cat ? zoneWater(hs, cat, zonePsi(z)) : null;
        const chk = z.line && w ? lineCheck(z.line, w.gpm) : null;
        return `<div style="margin-top:8px"><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n} (${w ? w.gpm.toFixed(1) : '?'} gpm): <select data-line="${z.n}" aria-label="Zone ${z.n} line">${pipeOptions(z.line)}</select>
          ${chk ? `<div class="dim">${chk.over ? `<strong style="color:var(--bad)">Too small:</strong> the water moves ${chk.fps.toFixed(1)} ft/s; lines are kept under 5 ft/s, about ${chk.capacityGpm.toFixed(1)} gpm in this one.` : `Water moves ${chk.fps.toFixed(1)} ft/s (under 5: fine); it loses about ${chk.lossPer100.toFixed(1)} psi per 100 ft.`}</div>` : ''}</div>`;
      }).join('');
      const sup = pipe(irr.supply.pipe), biggest = Math.max(0, ...irr.zones.map((z) => (cat ? zoneWater(irr.heads.filter((h) => h.zone === z.n), cat, zonePsi(z)).gpm : 0)));
      return `<p class="hint">The line from the valve box out to each zone's heads.</p>${rows}
        ${sup && biggest > gpmAt(sup) ? `<p class="hint">The supply line (${esc(sup.label)}) carries about ${gpmAt(sup).toFixed(1)} gpm under 5 ft/s; your biggest zone draws ${biggest.toFixed(1)}.</p>` : ''}
        ${nav('done', { ok: irr.zones.every((z) => z.line), label: 'Done' })}`;
    },
  };

  function pipeOptions(cur) {
    return `<option value="">Choose…</option>${PIPES.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}`;
  }

  function headLine(h) {
    if (!h) return '';
    const b = cat?.body(h.body), n = cat?.nozzle(h.nozzle), w = waterOf(h);
    return `<span class="chip" style="background:${colorOf(h.zone)}"></span>${b ? `${esc(b.brand)} ${esc(b.model)}` : 'no model'}${n ? ` · nozzle ${esc(n.label)}` : ''}${w ? ` · ${throwOf(w)} · ${w.gpm.toFixed(2)} gpm at ${Math.round(w.psi)} psi${w.outside ? ' (outside the chart: its nearest row)' : ''}` : ''}`;
  }

  /* the brand -> model -> nozzle -> arc form, for the selected heads */
  const form = { brand: '', body: '', nozzle: '', arc: '' };
  function modelForm() {
    if (!cat) return '<p class="dim">Loading the list of heads…</p>';
    const first = head([...sel][0]);
    if (first && !form.body && first.body) { const b = cat.body(first.body); form.brand = b?.brand || ''; form.body = first.body; form.nozzle = first.nozzle || ''; form.arc = first.arc ? String(first.arc) : ''; }
    const bodies = cat.bodies.filter((b) => b.brand === form.brand);
    const fams = form.body ? cat.familiesFor(form.body) : [];
    const n = form.nozzle ? cat.nozzle(form.nozzle) : null;
    const adjustable = n && !n.strip && !Number.isFinite(n.arcFixed);
    return `<div class="tools" style="flex-direction:column;align-items:stretch">
      <select data-f="brand" aria-label="Brand"><option value="">Brand…</option>${cat.brands.map((b) => `<option ${b === form.brand ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      ${form.brand ? `<select data-f="body" aria-label="Model"><option value="">Model…</option>${bodies.map((b) => `<option value="${b.id}" ${b.id === form.body ? 'selected' : ''}>${esc(b.model)}${b.kind ? ` (${esc(b.kind)})` : ''}</option>`).join('')}</select>` : ''}
      ${form.body ? `<select data-f="nozzle" aria-label="Nozzle"><option value="">Nozzle…</option>${fams.map((f) => `<optgroup label="${esc(f.name)}">${f.nozzles.map((z) => `<option value="${z.id}" ${z.id === form.nozzle ? 'selected' : ''}>${esc(z.label)}${z.strip ? ` (${z.strip.widthFt} x ${z.strip.lengthFt} ft strip)` : Number.isFinite(z.arcFixed) ? ` (${z.arcFixed}°)` : ''}</option>`).join('')}</optgroup>`).join('')}</select>` : ''}
      ${adjustable ? `<label class="toggle">Arc it waters: <select data-f="arc">${[45, 90, 120, 180, 210, 240, 270, 300, 360].filter((a) => a >= (n.arcMin ?? 0) && a <= (n.arcMax ?? 360)).map((a) => `<option ${String(a) === form.arc ? 'selected' : ''}>${a}</option>`).join('')}</select> degrees</label>` : ''}
      <button type="button" data-act="apply" ${form.nozzle ? '' : 'disabled'}>Give the ${sel.size} selected head${sel.size > 1 ? 's' : ''} this</button></div>`;
  }

  const WIRE = {
    intro: (P) => {
      P.querySelector('[data-act=start]').addEventListener('click', () => go('place'));
      P.querySelector('[data-act=none]').addEventListener('click', () => { irr.none = true; irr.done = true; changed(); finish(); });
    },
    place: (P) => {
      P.querySelectorAll('[name=pm]').forEach((r) => r.addEventListener('change', () => { placeMode = r.value; if (placeMode === 'gps') startGps(); else stopGps(); render(); }));
      P.querySelector('[data-act=undo]')?.addEventListener('click', () => { irr.heads.pop(); changed(); render(); });
      wireGps(P);
      wireNav(P, () => go('review'));
    },
    review: (P) => {
      P.querySelector('[data-act=remove]')?.addEventListener('click', () => { irr.heads = irr.heads.filter((h) => !sel.has(h.id)); sel.clear(); changed(); render(); });
      wireNav(P, () => go('zones'));
    },
    zones: (P) => {
      P.querySelector('[data-act=all]').addEventListener('click', () => { for (const h of irr.heads) if (!h.zone) sel.add(h.id); render(); });
      P.querySelector('[data-act=clearsel]').addEventListener('click', () => { sel.clear(); render(); });
      const give = (n) => { for (const id of sel) head(id).zone = n; sel.clear(); irr.zones = irr.zones.filter((z) => irr.heads.some((h) => h.zone === z.n)); changed(); render(); };
      P.querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => give(Number(b.dataset.zone))));
      P.querySelector('[data-act=newzone]').addEventListener('click', () => {
        const n = Math.max(0, ...zoneN()) + 1;
        irr.zones.push({ n, line: null });
        give(n);
      });
      wireNav(P, () => go('models'));
    },
    models: (P) => {
      P.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { sel.clear(); for (const h of irr.heads) if (h.zone === Number(b.dataset.pick)) sel.add(h.id); resetForm(); render(); }));
      P.querySelector('[data-act=clearsel]').addEventListener('click', () => { sel.clear(); resetForm(); render(); });
      P.querySelectorAll('[data-f]').forEach((s) => s.addEventListener('change', () => {
        const f = s.dataset.f;
        form[f] = s.value;
        if (f === 'brand') { form.body = ''; form.nozzle = ''; form.arc = ''; }
        if (f === 'body') {
          form.nozzle = ''; form.arc = '';
          const fams = cat.familiesFor(form.body), all = fams.flatMap((x) => x.nozzles);
          if (all.length === 1) form.nozzle = all[0].id; // a body with one built-in nozzle
        }
        if (f === 'nozzle') { const n = cat.nozzle(form.nozzle); form.arc = n && !n.strip && !Number.isFinite(n.arcFixed) ? String(Math.min(n.arcMax ?? 360, 180)) : ''; }
        render();
      }));
      P.querySelector('[data-act=apply]')?.addEventListener('click', () => {
        for (const id of sel) {
          const h = head(id);
          h.body = form.body; h.nozzle = form.nozzle; h.arc = form.arc ? Number(form.arc) : null;
          const n = cat.nozzle(h.nozzle);
          h.dir = h.dir ?? facing(h.at, ctx.lawnMiddle());
          if (n && Number.isFinite(n.arcFixed) && n.arcFixed >= 360) h.dir = 0;
        }
        sel.clear(); resetForm(); changed(); render();
      });
      wireNav(P, () => go('details'));
    },
    details: (P) => wireNav(P, () => go('supply')),
    supply: (P) => {
      P.querySelector('[data-act=supplypipe]').addEventListener('change', (e) => { irr.supply.pipe = e.target.value || null; changed(); render(); });
      P.querySelector('[data-act=psi]').addEventListener('change', (e) => { const v = Number(e.target.value); irr.supply.psi = v >= 10 && v <= 150 ? v : null; changed(); render(); });
      wireNav(P, () => go('lines'));
    },
    lines: (P) => {
      P.querySelectorAll('[data-line]').forEach((s) => s.addEventListener('change', () => { const z = irr.zones.find((x) => x.n === Number(s.dataset.line)); z.line = s.value || null; changed(); render(); }));
      wireNav(P, () => { irr.done = true; irr.none = false; changed(); finish(); });
    },
  };
  const resetForm = () => { form.brand = ''; form.body = ''; form.nozzle = ''; form.arc = ''; };

  /* -------------------------------------------------------------------- GPS */

  function gpsBody() {
    if (!('geolocation' in navigator)) return '<p class="hint">This phone or browser does not share its location. Tap the heads on the photo instead.</p>';
    const c = gps.cal;
    if (gps.phase === 'pick') return '<p class="hint">First, a calibration. Tap a spot on the photo you can stand on exactly: a driveway corner, a sidewalk corner, a property-line pin.</p>';
    if (gps.phase === 'stand') return `<p class="hint">Stand on that spot, holding the phone at waist height, and press Start. Keep still for about 20 seconds.</p><div class="tools"><button type="button" data-act="calgo" ${gps.busy ? 'disabled' : ''}>${gps.busy ? 'Listening…' : 'Start'}</button><button type="button" class="plain" data-act="repick">Choose another spot</button></div>`;
    return `<p class="dim">${c ? `Calibrated: your phone read ${ft(c.offsetM)} ft off, and wandered about ${ft(c.jitterM)} ft while you stood still. Expect each head within a few feet; you can drag them in the next step.` : ''}</p>
      <p class="hint">Stand right over a head and press "Drop a head here". Keep still for about 5 seconds.</p>
      <div class="tools"><button type="button" data-act="drop" ${gps.busy ? 'disabled' : ''}>${gps.busy ? 'Listening…' : 'Drop a head here'}</button><button type="button" class="plain" data-act="recal">Calibrate again</button></div>
      ${gps.live ? `<p class="dim">The blue dot is where the phone thinks you are now (±${ft(gps.live.acc)} ft by its own estimate).</p>` : ''}`;
  }
  function wireGps(P) {
    P.querySelector('[data-act=calgo]')?.addEventListener('click', () => listen(20000, (fixes) => {
      gps.cal = calibrate(gps.ref, fixes);
      if (!gps.cal) { alert('No location came in. Check that the page may use your location, then try again.'); return; }
      irr.gpsCal = { offsetM: gps.cal.offsetM, jitterM: gps.cal.jitterM, at: gps.cal.at };
      gps.phase = 'walk'; render();
    }));
    P.querySelector('[data-act=repick]')?.addEventListener('click', () => { gps.phase = 'pick'; gps.ref = null; render(); });
    P.querySelector('[data-act=recal]')?.addEventListener('click', () => { gps.phase = 'pick'; gps.ref = null; gps.cal = null; render(); });
    P.querySelector('[data-act=drop]')?.addEventListener('click', () => listen(5000, (fixes) => {
      const p = placeByGps(fixes, gps.cal);
      if (!p) { alert('No location came in.'); return; }
      add(p.at, { by: 'gps', spreadM: +p.spreadM.toFixed(2) });
    }));
  }
  function startGps() {
    if (gps.watch !== null || !('geolocation' in navigator)) return;
    gps.phase = gps.cal ? 'walk' : 'pick';
    gps.watch = navigator.geolocation.watchPosition((pos) => {
      const f = { lng: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, t: Date.now() };
      gps.fixes.push(f); if (gps.fixes.length > 600) gps.fixes.shift();
      gps.live = f; ctx.draw();
    }, (err) => { gps.live = null; if (err.code === 1) { alert('Location was not shared, so GPS placing is off. Tap the heads on the photo instead.'); placeMode = 'tap'; stopGps(); render(); } },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (gps.watch !== null) navigator.geolocation.clearWatch(gps.watch);
    gps.watch = null; gps.live = null; gps.busy = false;
  }
  function listen(ms, done) {
    gps.busy = true; render();
    const t0 = Date.now();
    setTimeout(() => {
      gps.busy = false;
      // a phone standing still may send no new fix: then the latest, if it is recent
      let fixes = gps.fixes.filter((f) => f.t >= t0 - 1000);
      if (!fixes.length && gps.live && Date.now() - gps.live.t < 15000) fixes = [gps.live];
      done(fixes); render();
    }, ms);
  }

  /* ------------------------------------------------------------ on the photo */

  function add(at, extra = {}) {
    irr.heads.push({ id: `h${Date.now().toString(36)}${nextId++}`, at: at.map((v) => +v.toFixed(7)), zone: null, body: null, nozzle: null, arc: null, dir: null, by: 'tap', ...extra });
    changed(); render();
  }
  function nearest(ev, maxCss = 16) {
    const [x, y] = ctx.tapPx(ev), lim = maxCss * ctx.cssScale();
    let best = null, bd = lim;
    for (const h of irr.heads) { const [hx, hy] = ctx.toPx(h.at); const d = Math.hypot(hx - x, hy - y); if (d < bd) { bd = d; best = h; } }
    return best;
  }

  /** A tap on the photo, while a step is open: true when it was used here. */
  function tap(ev) {
    if (!step || step === 'intro') return !!step;
    if (dragged) { dragged = false; return true; }
    if (step === 'place') {
      if (placeMode === 'gps') {
        if (gps.phase === 'pick') { gps.ref = ctx.toLngLat(ctx.tapPx(ev)); gps.phase = 'stand'; render(); }
        return true;
      }
      add(ctx.toLngLat(ctx.tapPx(ev)));
      return true;
    }
    const h = nearest(ev);
    if (!h) return true;
    if (step === 'details' || step === 'review') { sel.clear(); sel.add(h.id); }
    else if (sel.has(h.id)) sel.delete(h.id); else sel.add(h.id);
    if (step === 'models') { if (sel.size === 1) { resetForm(); } }
    render();
    return true;
  }
  /** A finger down on a head in the review step starts dragging it (not the map). */
  function grab(ev) {
    if (step !== 'review') return false;
    const h = nearest(ev, 22);
    if (!h) return false;
    drag = h.id; dragged = false; sel.clear(); sel.add(h.id);
    return true;
  }
  function move(ev) {
    if (!drag) return false;
    head(drag).at = ctx.toLngLat(ctx.tapPx(ev)).map((v) => +v.toFixed(7));
    dragged = true; ctx.draw();
    return true;
  }
  function drop() {
    if (!drag) return false;
    drag = null;
    if (dragged) changed();
    render();
    return true;
  }

  /** What this step draws over the photo. g: the canvas; lw: the page's line width. */
  function drawOn(g, lw) {
    const showAll = !!step || irr.done;
    if (!showAll || irr.none) return;
    // sized on the screen, not the photo: the same on a phone at any zoom
    const px = ctx.cssScale(), r = 6 * px;
    lw = 2 * px;
    const fans = step === 'details' || step === 'models' || step === 'lines' || step === 'supply' || (!step && irr.done);
    if (fans && cat) for (const h of irr.heads) {
      const w = waterOf(h);
      if (!w) continue;
      const [x, y] = ctx.toPx(h.at), R = (w.radiusFt / 3.281) * ctx.pxPerM();
      const mid = ((h.dir ?? 0) - 90) * (Math.PI / 180);
      g.fillStyle = `${colorOf(h.zone)}26`; g.strokeStyle = `${colorOf(h.zone)}99`; g.lineWidth = lw * 0.5;
      if (w.strip) {
        // a strip: its rectangle, along the head's direction (an end strip from the head, a centre strip
        // either side of it, a side strip out from its long side)
        const L = R, Wd = (w.strip.widthFt / 3.281) * ctx.pxPerM();
        g.save(); g.translate(x, y); g.rotate(mid);
        if (w.strip.type === 'center') g.fillRect(-L / 2, -Wd / 2, L, Wd), g.strokeRect(-L / 2, -Wd / 2, L, Wd);
        else if (w.strip.type === 'side') g.fillRect(0, -L / 2, Wd, L), g.strokeRect(0, -L / 2, Wd, L);
        else g.fillRect(0, -Wd / 2, L, Wd), g.strokeRect(0, -Wd / 2, L, Wd);
        g.restore();
        continue;
      }
      const half = (w.arc / 2) * (Math.PI / 180);
      g.beginPath(); g.moveTo(x, y);
      if (w.arc >= 359) g.arc(x, y, R, 0, Math.PI * 2); else g.arc(x, y, R, mid - half, mid + half);
      g.closePath(); g.fill(); g.stroke();
    }
    for (const h of irr.heads) {
      const [x, y] = ctx.toPx(h.at);
      g.fillStyle = colorOf(h.zone); g.strokeStyle = sel.has(h.id) ? '#ffeb3b' : '#000'; g.lineWidth = sel.has(h.id) ? lw * 1.2 : lw * 0.6;
      g.beginPath(); g.arc(x, y, sel.has(h.id) ? r * 1.4 : r, 0, 7); g.fill(); g.stroke();
    }
    // the details over each head (owner: "the full details of that head")
    if ((step === 'details' || (!step && irr.done && ctx.labels?.())) && cat) {
      const fs = 12 * px;
      g.font = `600 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      const drawn = [];
      let hidden = 0;
      for (const h of irr.heads) {
        const b = cat.body(h.body), n = cat.nozzle(h.nozzle), w = waterOf(h);
        const lines = [b ? `${b.brand} ${b.model}` : '?', n && w ? `${n.label} · ${throwOf(w)} · ${w.gpm.toFixed(2)} gpm` : 'no nozzle'];
        const [x, y] = ctx.toPx(h.at);
        // only where it has room: the rest show when zoomed in (the text keeps its size on the screen)
        const wBox = Math.max(...lines.map((t) => g.measureText(t).width)), box = [x - wBox / 2, y - r * 1.6 - fs * 2.3, x + wBox / 2, y - r * 1.6];
        if (drawn.some((d) => box[0] < d[2] && box[2] > d[0] && box[1] < d[3] && box[3] > d[1])) { hidden++; continue; }
        drawn.push(box);
        lines.reverse().forEach((t, k) => {
          const yy = y - r * 1.6 - k * fs * 1.15;
          g.lineWidth = fs / 4; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(t, x, yy);
          g.fillStyle = '#fff'; g.fillText(t, x, yy);
        });
      }
      labelsHidden = hidden;
    }
    if (step === 'place' && placeMode === 'gps') {
      if (gps.ref) { const [x, y] = ctx.toPx(gps.ref); g.strokeStyle = '#ffeb3b'; g.lineWidth = lw; g.beginPath(); g.moveTo(x - r * 2, y); g.lineTo(x + r * 2, y); g.moveTo(x, y - r * 2); g.lineTo(x, y + r * 2); g.stroke(); }
      if (gps.live) {
        const at = gps.cal ? placeByGps([gps.live], gps.cal).at : [gps.live.lng, gps.live.lat];
        const [x, y] = ctx.toPx(at);
        g.fillStyle = 'rgba(33,150,243,.25)'; g.beginPath(); g.arc(x, y, Math.max(r, ((gps.cal ? gps.cal.jitterM : gps.live.acc) || 3) * ctx.pxPerM()), 0, 7); g.fill();
        g.fillStyle = '#2196f3'; g.strokeStyle = '#fff'; g.lineWidth = lw * 0.6; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
      }
    }
  }

  function finish() { step = null; sel.clear(); stopGps(); render(); ctx.finish(); }

  return {
    /** Open the steps for this map's irrigation (kept), at the start unless they were finished. */
    async open(kept, { force = false } = {}) {
      irr = kept && typeof kept === 'object' ? { ...emptyIrrigation(), ...kept, supply: { ...emptyIrrigation().supply, ...(kept.supply || {}) } } : emptyIrrigation();
      await loadCat;
      if (irr.done && !force) { step = null; render(); return false; }
      step = force && irr.heads.length ? 'review' : 'intro';
      render();
      return true;
    },
    get active() { return !!step; },
    get data() { return irr; },
    tap, grab, move, drop, drawOn,
    summary() {
      if (!cat || irr.none || !irr.done) return null;
      return irr.zones.map((z) => ({ n: z.n, color: colorOf(z.n), ...zoneWater(irr.heads.filter((h) => h.zone === z.n), cat, zonePsi(z)), psi: zonePsi(z) }));
    },
    arcOf: (h) => arcOf(h, cat?.nozzle(h.nozzle)),
  };
}
