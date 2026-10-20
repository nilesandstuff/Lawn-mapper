/**
 * YOUR SPRINKLERS: the first step on the water map (water session; owner, 2026-10-20). In order:
 *
 *   place    each head, by a tap on the photo or by GPS (a calibration on a spot the person can stand on
 *            exactly, a driveway or property-line corner, then each head averaged while standing on it)
 *   review   drag any head that is off, then confirm
 *   zones    select heads, give them the valve (irrigation zone) they are on
 *   models   select heads, give them a brand and model, and the nozzle (one for all, or one by one)
 *   details  the map of heads and zones with each head's details over it; confirm
 *   equipment  where the backflow preventer and the valve box(es) are, and their makes if known
 *   supply   the water coming in: the pressure, how it was read, the pipe to the valve box
 *   lines    each zone's pipe: its material, sized by flow unless a size is given
 *   water    (optional) hard water, rust stains, the system's age: scale in the pipes
 *   pressure the lines as an installer most likely laid them, and the pressure and flow at every head
 *            (lib/hydraulics.js), with the ground's rise and fall from the lidar
 *   done
 *
 * The page (app.js) owns the photo, the zoom and the save; this module owns the steps, the panel and what
 * it draws on the photo. Kept with the map as the water part's `irrigation` (POST /api/maps/tool).
 */

import { catalogue, headWater, zoneWater, calibrate, placeByGps, facing, arcOf, enu } from '/lib/heads.js';
import { route, solveZone, headFlow, deviceLoss, dwPerFt, roughnessMm, SWING, FITTINGS_SHARE, pipeById, pipeSize, PIPE_FAMILIES, sizeFor, fraction, fps, FT_PER_M, MAX_FPS } from '/lib/hydraulics.js';

const FILES = ['rainbird-sprays', 'rainbird-rotors', 'hunter-sprays', 'hunter-rotors', 'other-brands'];
const ZONE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835', '#6d4c41', '#d81b60', '#3949ab', '#7cb342', '#546e7a'];
const STEPS = ['place', 'review', 'zones', 'models', 'details', 'equipment', 'supply', 'lines', 'water', 'pressure'];
const STEP_TITLE = { place: 'Place your sprinkler heads', review: 'Check where they are', zones: 'Which valve is each head on?', models: 'What heads and nozzles are they?', details: 'Your heads', equipment: 'The backflow preventer and the valves', supply: 'The water coming in', lines: 'The pipe to each zone', water: 'Your water (optional)', pressure: 'The pressure at every head' };
/** The pipe families a zone's lines may be, and the supply line's. */
const LINE_FAMILIES = ['pe', 'pvc200', 'pvc40'];
const SUPPLY_FAMILIES = ['pvc40', 'pvc200', 'pe', 'cuL', 'cuK', 'pex', 'galv'];
/** A water meter between the street and the house (AWWA C700 sizes) and the service line, when the
    pressure was read with nothing running: their losses come off it once the water flows. */
const METERS = [['058', '5/8 x 3/4 in (most homes)'], ['075', '3/4 in'], ['100', '1 in'], ['none', 'no meter (a well)']];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ft = (m) => Math.round(m * 3.281);
/** A head's throw in words: its arc and radius, or a strip's rectangle. */
const throwOf = (w) => (w.strip ? `${Math.round(w.strip.widthFt)} x ${Math.round(w.strip.lengthFt)} ft strip` : `${Math.round(w.arc)}° · ${Math.round(w.radiusFt)} ft`);

export function emptyIrrigation() {
  return { v: 2, done: false, none: false, heads: [], zones: [], supply: { pipe: null, psi: null }, system: emptySystem() };
}

export function emptySystem() {
  return {
    pvb: { at: null, device: '' },
    boxes: [],
    source: { psi: null, read: 'static', from: 'city', meter: '058', serviceFamily: 'cuK', serviceSize: 0.75, serviceFt: 60 },
    supplyLine: { family: 'pvc40', size: 1, lenFt: null },
    quality: { hardness: 'unknown', crust: false, spots: false, orange: false, black: false, slime: false, headCrust: false },
  };
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
  let drag = null, dragged = false, placeMode = 'tap', labelsHidden = 0, placing = null;
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
  /* ------------------------------------------------- the devices and the solve */

  let devices = [];
  const loadDevices = fetch('/lib/hydraulics/devices.json').then((r) => (r.ok ? r.json() : null)).then((j) => { devices = j?.devices || []; }).catch(() => {});
  const deviceOf = (id) => devices.find((d) => d.id === id) || null;
  /** A typical device of a kind and size, when the person does not know theirs: the middle of the makers'
      curves, flow by flow. */
  function typical(kind, sizeIn) {
    let list = devices.filter((d) => d.kind === kind && d.sizeIn === sizeIn);
    if (!list.length) list = devices.filter((d) => d.kind === kind);
    if (!list.length) return null;
    const mid = (v) => { const x = v.slice().sort((p, q) => p - q); return x[Math.floor((x.length - 1) / 2)]; };
    return { id: `typical-${kind}`, kind, sizeIn, typical: list.length, points: [2, 4, 6, 8, 10, 12, 15, 20, 25, 30].map((g) => ({ gpm: g, psi: mid(list.map((d) => deviceLoss(d, g))) })) };
  }
  const METER_IN = { '058': 0.625, '075': 0.75, '100': 1 };
  const metal = (fam) => ['cuL', 'cuK', 'galv'].includes(fam);
  const distFt = (a, b) => Math.hypot(...enu(a, b)) * FT_PER_M;

  let solved = null, solvedKey = '';
  /** Every zone solved from the backflow preventer to the nozzles (lib/hydraulics.js), or null until the
      equipment is placed and the pressure given. Kept until something changes. */
  function solve() {
    const sys = irr.system, src = sys.source, P = src.psi;
    if (!cat || !Number.isFinite(P) || !sys.pvb.at || !sys.boxes.length) return null;
    const key = JSON.stringify([irr.heads, irr.zones, sys, ctx.elevReady?.() ?? false, devices.length]);
    if (key === solvedKey) return solved;
    const pvbDev = deviceOf(sys.pvb.device) || typical('pvb', 1);
    const sl = sys.supplyLine, slPipe = pipeSize(sl.family, sl.size) || pipeSize('pvc40', 1);
    const years = Number.isFinite(src.pipeYears) ? src.pipeYears : 50; // galvanized lines are mostly from before 1970
    const slEps = roughnessMm(sl.family, sys.quality, years);
    const fromStatic = src.read === 'static' && src.from === 'city';
    // the meter-loss table Rain Bird, Hunter and Toro all print (lib/hydraulics/devices.json meter-typical-*)
    const meterDev = fromStatic && src.meter !== 'none' ? deviceOf(`meter-typical-${src.meter}`) || typical('meter', METER_IN[src.meter] ?? 0.625) : null;
    const svc = fromStatic ? pipeSize(src.serviceFamily, src.serviceSize) : null;
    const svcEps = svc ? roughnessMm(src.serviceFamily, sys.quality, years) : 0;
    const groundPvb = ctx.elev?.(sys.pvb.at);
    const zones = [];
    for (const z of irr.zones) {
      const hs = irr.heads.filter((h) => h.zone === z.n && h.nozzle);
      if (!hs.length) continue;
      const box = (sys.boxes.find((b) => b.id === z.box) || sys.boxes[0]).at;
      const lenFt = Number.isFinite(sl.lenFt) ? sl.lenFt : distFt(sys.pvb.at, box) * 1.15 + 3;
      const parts = (Q) => ({
        meter: meterDev ? deviceLoss(meterDev, Q) : 0,
        service: svc ? dwPerFt(svc.idIn, svcEps, Q) * (src.serviceFt || 0) * (1 + FITTINGS_SHARE) : 0,
        pvb: pvbDev ? deviceLoss(pvbDev, Q) : 0,
        supply: dwPerFt(slPipe.idIn, slEps, Q) * lenFt * (1 + FITTINGS_SHARE),
      });
      const upstream = (Q) => Object.values(parts(Q)).reduce((t, v) => t + v, 0);
      const tree = route(box, hs.map((h) => ({ id: h.id, at: h.at })), { cost: ctx.routeCost });
      const family = z.family || 'pe';
      const res = solveZone({
        tree, heads: new Map(hs.map((h) => [h.id, h])), water: (h, psi) => headFlow(h, cat, psi), elev: ctx.elev,
        family, size: z.size && z.size !== 'auto' ? pipeSize(family, Number(z.size))?.id : null,
        valve: deviceOf(z.valve) || typical('valve', 1),
        // sprays on flexible swing pipe, rotors on a rigid 3/4 in swing joint (lib/hydraulics.js SWING)
        swingLoss: (h, g) => deviceLoss(/rotor|impact/.test(cat.familyOfNozzle(h.nozzle)?.kind || '') ? SWING.rigid : SWING.flexible, g),
      }, { psi: P, gaugeAt: sys.pvb.at, gaugeElevM: Number.isFinite(groundPvb) ? groundPvb + 0.3 : null, upstream });
      zones.push({ n: z.n, tree, res, lenFt, parts: parts(res.gpm) });
    }
    solved = { zones, pvbDev, slPipe, at: Date.now() };
    solvedKey = key;
    return solved;
  }
  const solvedHead = (id) => { const s = solved; if (!s) return null; for (const z of s.zones) { const h = z.res.heads.get(id); if (h) return h; } return null; };
  const waterOf = (h) => {
    if (!cat) return null;
    const got = solve() && solvedHead(h.id);
    if (got?.water) return { ...got.water, gpm: got.gpm };
    return headFlow(h, cat, Number.isFinite(irr.system.source.psi) ? irr.system.source.psi - 15 : NaN);
  };
  const STATUS_COLOR = { ok: '#43a047', low: '#fb8c00', high: '#8e24aa' };

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
        const hs = irr.heads.filter((h) => h.zone === z.n), ws = hs.map(waterOf).filter(Boolean);
        const pr = ws.map((w) => w.precipInH).filter(Number.isFinite).sort((x, y) => x - y);
        return `<tr><td><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}</td><td>${hs.length}</td><td>${ws.reduce((t, w) => t + w.gpm, 0).toFixed(1)} gpm</td><td>${pr.length ? `${pr[Math.floor((pr.length - 1) / 2)].toFixed(2)} in/h` : '?'}</td></tr>`;
      }).join('');
      return `<p class="hint">Each head's details are over it on the map (zoom in where they crowd); the shaded fans are where each throws. Tap a head to see it here.</p>
        ${sel.size === 1 ? `<p>${headLine(head([...sel][0]))}</p>` : ''}
        <table class="months"><tr><th>Zone</th><th>Heads</th><th>Flow</th><th>Puts down</th></tr>${rows}</table>
        <p class="dim">${solve() ? 'At the pressure each head gets, worked out over the next steps.' : "At about the chart's working pressure until the next steps work out each head's own."} "Puts down" is the heads' rate at head-to-head spacing. The fans point toward the middle of the lawn until you turn them (coming).</p>
        ${nav('equipment', { label: 'Looks right' })}`;
    },

    equipment: () => {
      const sys = irr.system;
      const kinds = { pvb: 'Pressure vacuum breaker (PVB)', avb: 'Atmospheric vacuum breaker', dcva: 'Double check valve', rpz: 'Reduced pressure zone (RPZ)' };
      const opts = (list, cur) => list.map((d) => `<option value="${d.id}" ${d.id === cur ? 'selected' : ''}>${esc(d.brand)} ${esc(d.model)}${d.sizeIn ? `, ${fraction(d.sizeIn)} in` : ''}</option>`).join('');
      const bf = devices.filter((d) => kinds[d.kind]), valves = devices.filter((d) => d.kind === 'valve');
      return `<p>${placing === 'pvb' ? '<span class="hint">Tap where your backflow preventer is: the brass valve assembly, usually beside the house, where the sprinkler line leaves the house\'s water.</span>' : placing === 'box' ? '<span class="hint">Tap where the valve box is: the green lid in the lawn or bed that the zone valves sit under.</span>' : ''}</p>
        <div class="tools"><button type="button" data-act="placepvb" class="${placing === 'pvb' ? 'on' : sys.pvb.at ? 'plain' : ''}">${sys.pvb.at ? 'Move the backflow preventer' : 'Place the backflow preventer'}</button>
        <button type="button" data-act="placebox" class="${placing === 'box' ? 'on' : sys.boxes.length ? 'plain' : ''}">${sys.boxes.length ? '+ Another valve box' : 'Place the valve box'}</button>
        ${sys.boxes.length > 1 ? '<button type="button" class="plain" data-act="unbox">Remove the last valve box</button>' : ''}</div>
        <p>Your backflow preventer: <select data-act="pvbdev"><option value="">I don't know (a typical 1 in one)</option>${Object.entries(kinds).map(([k, label]) => { const l = bf.filter((d) => d.kind === k); return l.length ? `<optgroup label="${label}">${opts(l, sys.pvb.device)}</optgroup>` : ''; }).join('')}</select></p>
        ${irr.zones.map((z) => `<div style="margin-top:6px"><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}'s valve: <select data-valve="${z.n}"><option value="">I don't know (a typical 1 in valve)</option>${opts(valves, z.valve)}</select>
          ${sys.boxes.length > 1 ? ` in <select data-box="${z.n}">${sys.boxes.map((b, k) => `<option value="${b.id}" ${b.id === (z.box || sys.boxes[0].id) ? 'selected' : ''}>valve box ${k + 1}</option>`).join('')}</select>` : ''}</div>`).join('')}
        <p class="dim">The brand and model are cast on the lid or body. The losses through each are from the makers' own charts.</p>
        ${nav('supply', { ok: !!sys.pvb.at && sys.boxes.length > 0 })}`;
    },

    supply: () => {
      const src = irr.system.source, sl = irr.system.supplyLine, sys = irr.system;
      const box = sys.boxes[0]?.at, autoLen = sys.pvb.at && box ? Math.round(distFt(sys.pvb.at, box) * 1.15 + 3) : null;
      return `<p>Your water pressure, in psi: <input type="number" inputmode="decimal" min="10" max="150" step="1" data-act="psi" value="${Number.isFinite(src.psi) ? src.psi : ''}" style="width:90px;padding:8px;font-size:16px"></p>
        <div class="tools"><label class="toggle"><input type="radio" name="from" value="city" ${src.from === 'city' ? 'checked' : ''}> City water</label><label class="toggle"><input type="radio" name="from" value="well" ${src.from === 'well' ? 'checked' : ''}> A well</label></div>
        ${src.from === 'well' ? '<p class="dim">For a well, give the pump\'s cut-in pressure: the lower number on its pressure switch (often 30, 40 or 50), the least it delivers while running.</p>'
          : `<div class="tools"><label class="toggle"><input type="radio" name="read" value="static" ${src.read === 'static' ? 'checked' : ''}> Read with nothing running (a gauge on an outside tap)</label><label class="toggle"><input type="radio" name="read" value="working" ${src.read === 'working' ? 'checked' : ''}> Read at the backflow preventer with a zone running</label></div>
          ${src.read === 'static' ? `<p class="dim">With nothing running the pressure is the street's; once a zone runs, some is lost in the water meter and the pipe from the street. Their sizes, if you know them:</p>
            <p>Water meter: <select data-act="meter">${METERS.map(([v, l]) => `<option value="${v}" ${v === src.meter ? 'selected' : ''}>${l}</option>`).join('')}</select></p>
            <p>Pipe from the street: <select data-act="svcfam">${[['cuK', 'copper'], ['pex', 'PEX'], ['pe', 'poly'], ['galv', 'galvanized steel (older homes)']].map(([v, l]) => `<option value="${v}" ${v === src.serviceFamily ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select data-act="svcsize">${[0.75, 1].map((n) => `<option value="${n}" ${n === src.serviceSize ? 'selected' : ''}>${fraction(n)} in</option>`).join('')}</select>, about <input type="number" min="0" max="500" data-act="svcft" value="${src.serviceFt}" style="width:70px;padding:6px"> ft long</p>` : ''}`}
        ${(src.read === 'static' && src.from === 'city' && src.serviceFamily === 'galv') || sl.family === 'galv' ? `<p>Galvanized pipe rusts and scales inside: about how old is it (often the house's age)? <input type="number" min="0" max="120" data-act="pipeyears" value="${Number.isFinite(src.pipeYears) ? src.pipeYears : ''}" placeholder="50" style="width:70px;padding:6px"> years</p>` : ''}
        <p>The pipe from the backflow preventer to the valve box: <select data-act="slfam">${SUPPLY_FAMILIES.map((f) => `<option value="${f}" ${f === sl.family ? 'selected' : ''}>${PIPE_FAMILIES[f].label}</option>`).join('')}</select>
          <select data-act="slsize">${PIPE_FAMILIES[sl.family].sizes.map((x) => `<option value="${x[1]}" ${x[1] === sl.size ? 'selected' : ''}>${fraction(x[1])} in</option>`).join('')}</select>,
          about <input type="number" min="1" max="500" data-act="sllen" value="${Number.isFinite(sl.lenFt) ? sl.lenFt : ''}" placeholder="${autoLen ?? ''}" style="width:70px;padding:6px"> ft long${autoLen ? ` (${autoLen} from the map, if left blank)` : ''}</p>
        ${nav('lines', { ok: Number.isFinite(src.psi) })}`;
    },

    lines: () => {
      const s0 = solve();
      const rows = irr.zones.map((z) => {
        const fam = z.family || 'pe', zs = s0?.zones.find((x) => x.n === z.n);
        const byNom = new Map();
        for (const r of zs?.res.runs || []) byNom.set(r.pipe.nominal, (byNom.get(r.pipe.nominal) || 0) + r.lenFt);
        const fast = (zs?.res.runs || []).filter((r) => r.fps > MAX_FPS);
        return `<div style="margin-top:8px"><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}${zs ? ` (${zs.res.gpm.toFixed(1)} gpm)` : ''}:
          <select data-fam="${z.n}">${LINE_FAMILIES.map((f) => `<option value="${f}" ${f === fam ? 'selected' : ''}>${PIPE_FAMILIES[f].label}</option>`).join('')}</select>
          <select data-size="${z.n}"><option value="auto">sized by flow (recommended)</option>${PIPE_FAMILIES[fam].sizes.map((x) => `<option value="${x[1]}" ${String(x[1]) === String(z.size) ? 'selected' : ''}>all ${fraction(x[1])} in</option>`).join('')}</select>
          ${zs ? `<div class="dim">${[...byNom].sort((x, y) => y[0] - x[0]).map(([n, L]) => `${fraction(n)} in for about ${Math.round(L)} ft`).join(', ')}.${fast.length ? ` <strong style="color:var(--bad)">${fast.length} run${fast.length > 1 ? 's' : ''} over 5 ft/s</strong>: a bigger pipe there.` : ''}</div>` : ''}</div>`;
      }).join('');
      return `<p class="hint">What the lines from the valve box to the heads are made of. "Sized by flow" gives each run the size an installer would: the smallest that keeps the water under 5 ft/s, larger near the valve, smaller toward the last heads. The routes are on the map.</p>${rows}
        ${nav('water', {})}`;
    },

    water: () => {
      const qy = irr.system.quality;
      const H = [['soft', 'Soft (under 60 mg/L, 3.5 grains)'], ['moderate', 'Moderately hard (61-120 mg/L)'], ['hard', 'Hard (121-180 mg/L)'], ['veryHard', 'Very hard (over 180 mg/L, 10.5 grains)'], ['unknown', "I don't know"]];
      const chk = (k, label) => `<label class="toggle" style="display:flex"><input type="checkbox" data-q="${k}" ${qy[k] ? 'checked' : ''}> ${label}</label>`;
      return `<p>Your water's hardness, from your utility's water report or a test (the USGS classes):</p>
        <select data-act="hard">${H.map(([v, l]) => `<option value="${v}" ${qy.hardness === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${qy.hardness === 'unknown' ? `<p class="dim">If you don't know, any of these suggest hard water:</p>${chk('crust', 'White, chalky crust on taps or shower heads')}${chk('spots', 'Spots or film on glasses after washing')}` : ''}
        <p>Where your sprinklers hit (the house, the walk, rocks, a fence), are there stains?</p>
        ${chk('orange', 'Orange or rust-coloured: iron')}${chk('black', 'Black or brownish-black: manganese')}${chk('slime', 'A slimy dark film in the valve box or an outside tap: possibly iron bacteria')}${chk('headCrust', 'White crust on the sprinkler heads or nozzles after watering')}
        <p class="dim">These do not change the pressures: no maker or study gives a number for scale in plastic pipe or for its effect on nozzles. They tell you what to look after.</p>
        ${nav('pressure', { label: qy.hardness === 'unknown' && !['crust', 'spots', 'orange', 'black', 'slime', 'headCrust'].some((k) => qy[k]) ? 'Skip' : 'Next' })}`;
    },

    pressure: () => {
      const s0 = solve();
      if (!s0) return `<p>Place the backflow preventer and the valve box and give the pressure first.</p>${nav('done', { ok: false })}`;
      const pick = sel.size === 1 ? head([...sel][0]) : null, ph = pick && solvedHead(pick.id);
      const zoneRows = s0.zones.map((z) => {
        const hs = [...z.res.heads.values()], ps = hs.map((h) => h.psi);
        const low = hs.filter((h) => h.water?.status === 'low').length, high = hs.filter((h) => h.water?.status === 'high').length;
        return `<tr><td><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}</td><td>${z.res.gpm.toFixed(1)} gpm</td><td>${Math.round(Math.min(...ps))}–${Math.round(Math.max(...ps))} psi</td><td>${Math.round(z.res.spread * 100)}%${z.res.spread > 0.2 ? ' <strong>uneven</strong>' : ''}</td><td>${low ? `${low} low` : ''}${low && high ? ', ' : ''}${high ? `${high} high` : ''}${!low && !high ? 'all in range' : ''}</td></tr>`;
      }).join('');
      const zsel = pick ? s0.zones.find((z) => z.res.heads.has(pick.id)) : s0.zones[0];
      const ws = zsel?.res.worksheet, pr = zsel?.parts;
      const sheet = ws ? `<table class="months"><tr><th colspan="2">Zone ${zsel.n}'s farthest head, from the gauge to the nozzle</th></tr>
        <tr><td>Pressure given</td><td>${ws.gauge.toFixed(1)} psi</td></tr>
        ${pr.meter ? `<tr><td>Water meter</td><td>−${pr.meter.toFixed(1)}</td></tr>` : ''}${pr.service ? `<tr><td>Pipe from the street</td><td>−${pr.service.toFixed(1)}</td></tr>` : ''}
        <tr><td>Backflow preventer${s0.pvbDev?.typical ? ' (typical)' : ''}</td><td>−${pr.pvb.toFixed(1)}</td></tr>
        <tr><td>Pipe to the valve box (${Math.round(zsel.lenFt)} ft)</td><td>−${pr.supply.toFixed(1)}</td></tr>
        <tr><td>Zone valve${irr.zones.find((z) => z.n === zsel.n)?.valve ? '' : ' (typical)'}</td><td>−${ws.valve.toFixed(1)}</td></tr>
        <tr><td>Lateral pipes and fittings</td><td>−${ws.lateral.toFixed(1)}</td></tr>
        <tr><td>Swing joint</td><td>−${ws.swing.toFixed(1)}</td></tr>
        <tr><td>${ws.flat ? 'Ground height (not yet read: taken as level)' : ws.elevation >= 0 ? 'Downhill to the head' : 'Uphill to the head'}</td><td>${ws.elevation >= 0 ? '+' : '−'}${Math.abs(ws.elevation).toFixed(1)}</td></tr>
        <tr><td><strong>At the head</strong></td><td><strong>${ws.atHead.toFixed(1)} psi</strong></td></tr></table>` : '';
      const warn = [];
      for (const z of s0.zones) {
        // the zone's spread: 20% is the FAO's and most designers' limit, the Irrigation Association asks 10%
        if (z.res.spread > 0.2) warn.push(`Zone ${z.n}'s pressure varies ${Math.round(z.res.spread * 100)}% from head to head; designers keep it under 20% (the Irrigation Association asks 10%), or the far heads throw short and the near ones flood. Feeding the zone from nearer its middle, or a bigger lateral, evens it out.`);
        else if (z.res.spread > 0.1) warn.push(`Zone ${z.n}'s pressure varies ${Math.round(z.res.spread * 100)}% from head to head: inside the usual 20%, over the Irrigation Association's 10%.`);
        // the rules for the meter and the valve (Rain Bird, IA): each under 10% of the static pressure
        const sp = irr.system.source;
        if (sp.read === 'static' && z.parts.meter > 0.1 * sp.psi) warn.push(`Zone ${z.n} loses ${z.parts.meter.toFixed(1)} psi in the water meter, over the 10% of your pressure that designers allow: the zone draws more than the meter passes easily.`);
        if (z.res.valveLoss > 0.1 * sp.psi) warn.push(`Zone ${z.n}'s valve takes ${z.res.valveLoss.toFixed(1)} psi, over 10% of your pressure (Rain Bird, IA): a larger valve, or a smaller zone.`);
        const svc = sp.read === 'static' && sp.from === 'city' ? pipeSize(sp.serviceFamily, sp.serviceSize) : null;
        if (svc && fps(svc.idIn, z.res.gpm) > 7) warn.push(`At ${z.res.gpm.toFixed(1)} gpm the water in your ${fraction(svc.nominal)} in line from the street moves ${fps(svc.idIn, z.res.gpm).toFixed(1)} ft/s, over the 7 the Irrigation Association allows.`);
        const hi = [...z.res.heads.values()].filter((h) => h.water?.status === 'high');
        if (hi.length) warn.push(`Zone ${z.n}: ${hi.length} head${hi.length > 1 ? 's get' : ' gets'} more than ${Math.round(hi[0].water.chartHi)} psi, past its chart: it mists, and the wind takes the water. Pressure-regulating bodies (PRS) or a regulator on the zone would fix it.`);
        const lo = [...z.res.heads.values()].filter((h) => h.water?.status === 'low');
        if (lo.length) warn.push(`Zone ${z.n}: ${lo.length} head${lo.length > 1 ? 's get' : ' gets'} less than ${Math.round(lo[0].water.chartLo)} psi, under its chart: short throw and dry spots between heads.`);
      }
      // water quality (lib/hydraulics/PRACTICE.md 3): what to look after, not a change to the numbers
      const qy = irr.system.quality;
      const hits = irr.heads.filter((h) => { const w = waterOf(h); return w && ctx.hardNear?.(h.at, (w.radiusFt || 0) / FT_PER_M); }).length;
      if (qy.orange || qy.black) warn.push(`${qy.orange && qy.black ? 'Iron and manganese' : qy.orange ? 'Iron' : 'Manganese'} in the water stains what it lands on${hits ? `: ${hits} head${hits > 1 ? 's' : ''} reach${hits > 1 ? '' : 'es'} the house, the drive or a walk. Turning their arcs off the hard surfaces keeps them clean` : ''}. Above about 0.2-0.3 mg/L iron or 0.05 mg/L manganese it shows (NDSU); it can also plug nozzles and screens over the years (Penn State).`);
      if (qy.slime) warn.push('A slimy film can be iron bacteria (UF/IFAS): check the nozzle screens and the valve for build-up each spring.');
      if (qy.hardness === 'veryHard' || qy.headCrust || (qy.hardness === 'unknown' && qy.crust && qy.spots)) warn.push('Hard water leaves lime on heads and nozzles: soak a crusted nozzle in vinegar and water (Rain Bird), never drill it.');
      if (ctx.elevReady?.()) {
        const pvbG = ctx.elev(irr.system.pvb.at), top = Math.max(...irr.heads.map((h) => ctx.elev(h.at)).filter(Number.isFinite));
        if (Number.isFinite(pvbG) && Number.isFinite(top) && top + 0.1 > pvbG) warn.push(`The highest head is ${((top - pvbG) * FT_PER_M).toFixed(1)} ft ${top >= pvbG ? 'above' : 'below'} the ground at the backflow preventer: plumbing codes put a pressure vacuum breaker at least 12 in above the highest head.`);
      }
      return `<p class="hint">The lines are drawn as an installer most likely laid them; each head is coloured by its pressure: <span style="color:${STATUS_COLOR.ok}">●</span> in its chart's range, <span style="color:${STATUS_COLOR.low}">●</span> under it, <span style="color:${STATUS_COLOR.high}">●</span> over it. Tap a head for its numbers.</p>
        ${ph ? `<p>${headLine(pick)}<br>${ph.psi.toFixed(1)} psi at the head${ph.water?.regulated ? `, ${Math.round(ph.water.nozzlePsi)} at the nozzle after its regulator` : ''}; chart ${Math.round(ph.water?.chartLo)}–${Math.round(ph.water?.chartHi)} psi.</p>` : ''}
        <table class="months"><tr><th>Zone</th><th>Flow</th><th>At the heads</th><th>Spread</th><th></th></tr>${zoneRows}</table>
        ${sheet}
        ${warn.length ? `<ul>${warn.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
        <p class="dim">Devices from the makers' loss charts (a typical one of its size where you don't know yours); pipe friction by Darcy-Weisbach, which irrigation research prefers for small plastic pipe, with each tee and swing joint counted; at each zone's own flow, worked out with every head's flow at the pressure it gets${ctx.elevReady?.() ? '; heights from the USGS lidar' : ''}. The routes are a likely layout, not a dig: drag a head if a line runs where it can't.</p>
        ${nav('done', { label: 'Done' })}`;
    },
  };

  function headLine(h) {
    if (!h) return '';
    const b = cat?.body(h.body), n = cat?.nozzle(h.nozzle), w = waterOf(h);
    return `<span class="chip" style="background:${colorOf(h.zone)}"></span>${b ? `${esc(b.brand)} ${esc(b.model)}` : 'no model'}${n ? ` · nozzle ${esc(n.label)}` : ''}${w ? ` · ${throwOf(w)} · ${w.gpm.toFixed(2)} gpm${Number.isFinite(w.inletPsi) ? ` at ${Math.round(w.inletPsi)} psi` : ''}${w.status === 'low' ? ' (under its chart: short throw)' : w.status === 'high' ? ' (over its chart: misting)' : ''}` : ''}`;
  }

  /* the brand -> model -> nozzle -> arc form, for the selected heads */
  const form = { brand: '', body: '', nozzle: '', arc: '' };
  function modelForm() {
    if (!cat) return '<p class="dim">Loading the list of heads…</p>';
    const first = head([...sel][0]);
    if (first && !form.body && first.body) { const b = cat.body(first.body); form.brand = b?.brand || ''; form.body = first.body; form.nozzle = first.nozzle || ''; form.arc = first.arc ? String(first.arc) : ''; }
    const bodies = cat.bodies.filter((b) => b.brand === form.brand && cat.charted(b));
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
    details: (P) => wireNav(P, () => go('equipment')),
    equipment: (P) => {
      const sys = irr.system;
      P.querySelector('[data-act=placepvb]').addEventListener('click', () => { placing = placing === 'pvb' ? null : 'pvb'; render(); });
      P.querySelector('[data-act=placebox]').addEventListener('click', () => { placing = placing === 'box' ? null : 'box'; render(); });
      P.querySelector('[data-act=unbox]')?.addEventListener('click', () => { const gone = sys.boxes.pop(); for (const z of irr.zones) if (z.box === gone?.id) z.box = null; changed(); render(); });
      P.querySelector('[data-act=pvbdev]').addEventListener('change', (e) => { sys.pvb.device = e.target.value; changed(); render(); });
      P.querySelectorAll('[data-valve]').forEach((el) => el.addEventListener('change', () => { irr.zones.find((z) => z.n === Number(el.dataset.valve)).valve = el.value; changed(); }));
      P.querySelectorAll('[data-box]').forEach((el) => el.addEventListener('change', () => { irr.zones.find((z) => z.n === Number(el.dataset.box)).box = el.value; changed(); ctx.draw(); }));
      wireNav(P, () => { placing = null; go('supply'); });
    },
    supply: (P) => {
      const src = irr.system.source, sl = irr.system.supplyLine;
      const num = (sel, f) => P.querySelector(sel)?.addEventListener('change', (e) => { const v = e.target.value === '' ? null : Number(e.target.value); f(Number.isFinite(v) ? v : null); changed(); render(); });
      num('[data-act=psi]', (v) => { src.psi = v !== null && v >= 10 && v <= 150 ? v : null; });
      num('[data-act=svcft]', (v) => { src.serviceFt = v ?? 0; });
      num('[data-act=pipeyears]', (v) => { src.pipeYears = v; });
      num('[data-act=sllen]', (v) => { sl.lenFt = v; });
      num('[data-act=svcsize]', (v) => { src.serviceSize = v; });
      num('[data-act=slsize]', (v) => { sl.size = v; });
      P.querySelectorAll('[name=from]').forEach((r) => r.addEventListener('change', () => { src.from = r.value; if (r.value === 'well') src.read = 'working'; changed(); render(); }));
      P.querySelectorAll('[name=read]').forEach((r) => r.addEventListener('change', () => { src.read = r.value; changed(); render(); }));
      P.querySelector('[data-act=meter]')?.addEventListener('change', (e) => { src.meter = e.target.value; changed(); render(); });
      P.querySelector('[data-act=svcfam]')?.addEventListener('change', (e) => { src.serviceFamily = e.target.value; changed(); render(); });
      P.querySelector('[data-act=slfam]').addEventListener('change', (e) => {
        sl.family = e.target.value;
        const sizes = PIPE_FAMILIES[sl.family].sizes.map((x) => x[1]);
        if (!sizes.includes(sl.size)) sl.size = sizes.includes(1) ? 1 : sizes[0];
        changed(); render();
      });
      wireNav(P, () => go('lines'));
    },
    lines: (P) => {
      P.querySelectorAll('[data-fam]').forEach((el) => el.addEventListener('change', () => { const z = irr.zones.find((x) => x.n === Number(el.dataset.fam)); z.family = el.value; z.size = 'auto'; changed(); render(); }));
      P.querySelectorAll('[data-size]').forEach((el) => el.addEventListener('change', () => { const z = irr.zones.find((x) => x.n === Number(el.dataset.size)); z.size = el.value; changed(); render(); }));
      wireNav(P, () => go('water'));
    },
    water: (P) => {
      const qy = irr.system.quality;
      P.querySelector('[data-act=hard]').addEventListener('change', (e) => { qy.hardness = e.target.value; changed(); render(); });
      P.querySelectorAll('[data-q]').forEach((el) => el.addEventListener('change', () => { qy[el.dataset.q] = el.checked; changed(); render(); }));
      wireNav(P, () => go('pressure'));
    },
    pressure: (P) => wireNav(P, () => { irr.done = true; irr.none = false; changed(); finish(); }),
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
    if (step === 'equipment' && placing) {
      const at = ctx.toLngLat(ctx.tapPx(ev)).map((v) => +v.toFixed(7)), sys = irr.system;
      if (placing === 'pvb') sys.pvb.at = at;
      else sys.boxes.push({ id: `b${Date.now().toString(36)}`, at });
      placing = null; changed(); render();
      return true;
    }
    const h = nearest(ev);
    if (!h) return true;
    if (step === 'details' || step === 'review' || step === 'pressure' || step === 'lines' || step === 'equipment' || step === 'supply' || step === 'water') { sel.clear(); sel.add(h.id); }
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
    // the lines as an installer most likely laid them, thicker for bigger pipe
    const showLines = ['lines', 'water', 'pressure'].includes(step) || (!step && irr.done);
    const s0 = showLines ? solve() : null;
    if (s0) {
      const sys = irr.system;
      g.lineCap = 'round';
      for (const z of s0.zones) {
        const box = z.tree.nodes[0].at;
        // the supply line, backflow preventer to valve box
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = px * 4; g.setLineDash([px * 6, px * 4]);
        g.beginPath(); g.moveTo(...ctx.toPx(sys.pvb.at)); g.lineTo(...ctx.toPx(box)); g.stroke(); g.setLineDash([]);
        const byId = new Map(z.tree.nodes.map((n) => [n.id, n]));
        for (const r of z.res.runs) {
          const a = ctx.toPx(byId.get(r.from).at), b = ctx.toPx(byId.get(r.id).at);
          g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = px * (1.5 + r.pipe.nominal * 3) + px * 1.5;
          g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
          g.strokeStyle = r.fps > MAX_FPS ? '#ff1744' : colorOf(z.n); g.lineWidth = px * (1.5 + r.pipe.nominal * 3);
          g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
        }
      }
    }
    // the backflow preventer and the valve boxes
    const sysq = irr.system;
    if (sysq && (['equipment', 'supply', 'lines', 'water', 'pressure'].includes(step) || (!step && irr.done))) {
      if (sysq.pvb.at) {
        const [x, y] = ctx.toPx(sysq.pvb.at), a = px * 9;
        g.fillStyle = '#ffd54f'; g.strokeStyle = '#000'; g.lineWidth = px * 1.5;
        g.beginPath(); g.moveTo(x, y - a); g.lineTo(x + a, y); g.lineTo(x, y + a); g.lineTo(x - a, y); g.closePath(); g.fill(); g.stroke();
        g.font = `700 ${10 * px}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000'; g.fillText('B', x, y);
      }
      sysq.boxes.forEach((b, k) => {
        const [x, y] = ctx.toPx(b.at), a = px * 9;
        g.fillStyle = '#2e7d32'; g.strokeStyle = '#000'; g.lineWidth = px * 1.5;
        g.fillRect(x - a, y - a * 0.7, a * 2, a * 1.4); g.strokeRect(x - a, y - a * 0.7, a * 2, a * 1.4);
        g.font = `700 ${10 * px}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText(`V${sysq.boxes.length > 1 ? k + 1 : ''}`, x, y);
      });
    }
    const byPressure = step === 'pressure' && s0;
    for (const h of irr.heads) {
      const [x, y] = ctx.toPx(h.at);
      g.fillStyle = byPressure ? STATUS_COLOR[solvedHead(h.id)?.water?.status] || '#9e9e9e' : colorOf(h.zone); g.strokeStyle = sel.has(h.id) ? '#ffeb3b' : '#000'; g.lineWidth = sel.has(h.id) ? lw * 1.2 : lw * 0.6;
      g.beginPath(); g.arc(x, y, sel.has(h.id) ? r * 1.4 : r, 0, 7); g.fill(); g.stroke();
    }
    // the pressure over each head, where it has room
    if (byPressure) {
      const fs = 11 * px, boxes = [];
      g.font = `700 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      for (const h of irr.heads) {
        const sh = solvedHead(h.id);
        if (!sh) continue;
        const t = `${Math.round(sh.psi)} psi`, [x, y] = ctx.toPx(h.at), w0 = g.measureText(t).width, bx = [x - w0 / 2, y - r * 1.5 - fs, x + w0 / 2, y - r * 1.5];
        if (boxes.some((d) => bx[0] < d[2] && bx[2] > d[0] && bx[1] < d[3] && bx[3] > d[1])) continue;
        boxes.push(bx);
        g.lineWidth = fs / 4; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(t, x, y - r * 1.5); g.fillStyle = '#fff'; g.fillText(t, x, y - r * 1.5);
      }
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
      // a map saved before the pressure model (v1): its pressure and pipes carried over
      const e = emptySystem();
      irr.system = { ...e, ...(irr.system || {}), pvb: { ...e.pvb, ...(irr.system?.pvb || {}) }, source: { ...e.source, ...(irr.system?.source || {}) }, supplyLine: { ...e.supplyLine, ...(irr.system?.supplyLine || {}) }, quality: { ...e.quality, ...(irr.system?.quality || {}) }, boxes: irr.system?.boxes || [] };
      if (!Number.isFinite(irr.system.source.psi) && Number.isFinite(irr.supply?.psi)) irr.system.source.psi = irr.supply.psi;
      const old = pipeById(irr.supply?.pipe);
      if (old && !irr.system?.supplyLine?.migrated) { irr.system.supplyLine = { ...irr.system.supplyLine, family: old.family, size: old.nominal, migrated: true }; }
      for (const z of irr.zones) if (z.line && !z.family) { const p0 = pipeById(z.line); if (p0 && LINE_FAMILIES.includes(p0.family)) { z.family = p0.family; z.size = p0.nominal; } }
      let resumeAt = null;
      if (irr.v < 2 && irr.done && !irr.none) { irr.v = 2; irr.done = false; resumeAt = 'equipment'; } // the new steps still to do
      await loadDevices;
      await loadCat;
      if (irr.done && !force) { step = null; render(); return false; }
      step = resumeAt || (force && irr.heads.length ? 'review' : 'intro');
      render();
      return true;
    },
    get active() { return !!step; },
    get data() { return irr; },
    tap, grab, move, drop, drawOn,
    /** The ground came in (or anything the solve reads): solve again and show it. */
    refresh() { solvedKey = ''; if (step) render(); else ctx.draw(); },
    summary() {
      if (!cat || irr.none || !irr.done) return null;
      const s0 = solve();
      return irr.zones.map((z) => {
        const hs = irr.heads.filter((h) => h.zone === z.n), ws = hs.map(waterOf).filter(Boolean), zs = s0?.zones.find((x) => x.n === z.n);
        const pr = ws.map((w) => w.precipInH).filter(Number.isFinite).sort((x, y) => x - y), ps = zs ? [...zs.res.heads.values()].map((h) => h.psi) : [];
        const kinds = new Set(ws.map((w) => (w.kind === 'rotor' || w.kind === 'impact' ? 'rotor' : w.kind === 'rotary' ? 'rotary' : 'spray')));
        return { n: z.n, color: colorOf(z.n), heads: hs.length, gpm: zs ? zs.res.gpm : ws.reduce((t, w) => t + w.gpm, 0), precipInH: pr.length ? pr[Math.floor((pr.length - 1) / 2)] : null, mixed: kinds.has('spray') && kinds.size > 1, psiLo: ps.length ? Math.min(...ps) : null, psiHi: ps.length ? Math.max(...ps) : null };
      });
    },
    arcOf: (h) => arcOf(h, cat?.nozzle(h.nozzle)),
  };
}
