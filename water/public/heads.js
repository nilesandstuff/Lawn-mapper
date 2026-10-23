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
 *   (method / measure: instead of equipment..pressure, the pressure measured at the heads, lib/measured.js)
 *   arcs     each head's arc fitted to the lawn, then adjusted by hand
 *   fixes    what a run time cannot fix: pressure, mixed or unmatched heads, lawn left dry (lib/fixes.js)
 *   schedule when to water each zone, season by season (lib/schedule.js, the plan run on the valves)
 *   done
 *
 * The page (app.js) owns the photo, the zoom and the save; this module owns the steps, the panel and what
 * it draws on the photo. Kept with the map as the water part's `irrigation` (POST /api/maps/tool).
 */

import { inletFromGauge, inletFromThrow, spreadReadings } from '/lib/measured.js';
import { catalogue, headWater, zoneWater, calibrate, placeByGps, settle, facing, arcOf, enu, unEnu, sprayBodyId, seriesOf, nozzleRiseIn, SPRAY_POP_IN, SPRAY_REG_PSI, longestEdgeInSight, snapToGrid, GRID_FT_MIN, GRID_FT_MAX, GRID_FT_DEFAULT } from '/lib/heads.js';
import { autoArc, fitArcs, isLawn, MIN_THROW, BIN_DEG } from '/lib/arcs.js';
import { precipitation, setProfiles } from '/lib/precip.js';
import { layout } from '/lib/layout.js';
import { suggestions, betweenZones, duReached } from '/lib/fixes.js';
import { zoneSchedule, valveZones, MONTH } from '/lib/schedule.js';
import { route, solveZone, headFlow, regulatedOut, deviceLoss, dwPerFt, roughnessMm, SWING, FITTINGS_SHARE, pipeById, pipeSize, PIPE_FAMILIES, sizeFor, fraction, fps, FT_PER_M, MAX_FPS } from '/lib/hydraulics.js';

const FILES = ['rainbird-sprays', 'rainbird-rotors', 'hunter-sprays', 'hunter-rotors', 'other-brands'];
const ZONE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835', '#6d4c41', '#d81b60', '#3949ab', '#7cb342', '#546e7a'];
// the arcs last (owner, 2026-10-21): fitted once everything that sets a head's throw is known, then adjusted
const STEPS = ['place', 'review', 'zones', 'models', 'details', 'method', 'equipment', 'supply', 'lines', 'water', 'pressure', 'measure', 'arcs', 'fixes', 'schedule'];
/* THE STEPS FOR THE WAY THE PRESSURE IS FOUND (owner, 2026-10-22): worked out from the pipes and the water
   supply, or measured at the heads (a gauge, or how far they throw) with nothing buried or in a valve box asked */
const MEASURED = new Set(['gauge', 'throw']);
/* AFTER THE HEADS (owner, 2026-10-23): what could be better about the system, then when to water each zone */
const stepsFor = (method) => ['place', 'review', 'zones', 'models', 'details', 'method', ...(MEASURED.has(method) ? ['measure'] : ['equipment', 'supply', 'lines', 'water', 'pressure']), 'arcs', 'fixes', 'schedule'];
const STEP_TITLE = { place: 'Place your sprinkler heads', review: 'Check where they are', zones: 'Which valve is each head on?', models: 'What heads and nozzles are they?', details: 'Your heads', equipment: 'The backflow preventer and the valves', supply: 'The water coming in', lines: 'The pipe to each zone', water: 'Your water (optional)', pressure: 'The pressure at every head', arcs: "Each head's arc, and how evenly the lawn is watered", method: 'How to find the pressure at your heads', measure: 'Measure at your heads', fixes: 'What could be better', schedule: 'When to water each zone' };
/** How a zone's heads join its pipe (lib/hydraulics.js SWING). */
const CONNECT = [['', "I don't know (swing pipe for sprays, a rigid swing joint for rotors)"], ['swing', 'Flexible 1/2 in swing pipe ("funny pipe") to each head'], ['saddle', 'Saddles: each head on a fitting clamped onto the pipe'], ['rigid', 'Rigid swing joints (three or four elbows)']];
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
  return { v: 2, done: false, none: false, heads: [], zones: [], supply: { pipe: null, psi: null }, system: emptySystem(), grid: emptyGrid() };
}

/** The placing grid (lib/heads.js snapToGrid): made when the first head goes down, through it, along the lawn's
    longest straight edge in its sight. */
export const emptyGrid = () => ({ on: false, ft: GRID_FT_DEFAULT, origin: null, bearing: null });

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
  let measureAsk = false;
  let drag = null, dragged = false, placeMode = 'tap', labelsHidden = 0, placing = null, gaugeNote = '', coverView = 'all', arcPhase = 'fitting', showCover = false, measureNote = '';
  const throwGps = { head: null, id: null };
  let nextId = 1;
  // an arc being dragged (the arcs step): the head, the handle, and where the drag started (dragArc)
  let arcDrag = null;

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
  const layCache = { key: '', lay: null };
  /** Every zone solved from the backflow preventer to the nozzles (lib/hydraulics.js), or null until the
      equipment is placed and the pressure given. Kept until something changes. */
  function solve() {
    // while an arc is dragged the pressures stay as they were (an arc moves a head's flow a little, not the
    // zone's pressure): the drag redraws at the phone's frame rate, and the zone is solved again when let go
    if (arcDrag && solved) return solved;
    if (MEASURED.has(irr.method)) return solveMeasured();
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
    /* THE PIPE, LAID AS AN INSTALLER LAYS IT (lib/layout.js), once the lawn map is in: around houses, out from
       straight runs, along the lawn's edges where that is cheapest; before it is in, the old straight-line tree. */
    let lay = null;
    // the layout reads where the heads, the valve boxes and the backflow preventer are, not the arcs: kept
    const layKey = JSON.stringify([sys.pvb.at, sys.boxes, irr.zones.map((z) => [z.n, z.box]), irr.heads.map((h) => [h.id, h.at, h.zone, !!h.nozzle]), !!ctx.layoutGround?.()]);
    if (layKey === layCache.key) lay = layCache.lay;
    else if (ctx.layoutGround?.()) {
      // the pipe's own lines: along the lawn's longest straight edge (never the placing grid's setting)
      const bearing = longestEdgeInSight(ctx.lawnRings?.() || [], ctx.lawnMiddle?.() || sys.pvb.at, { sight: false })?.bearing ?? 0;
      try {
        lay = layout({
          pvb: sys.pvb.at, boxes: sys.boxes, bearing, ground: ctx.layoutGround(),
          zones: irr.zones.map((z) => ({ n: z.n, box: z.box, heads: irr.heads.filter((h) => h.zone === z.n && h.nozzle).map((h) => ({ id: h.id, at: h.at })) })),
        });
      } catch (e) { console.warn('layout', e); lay = null; }
      layCache.key = layKey; layCache.lay = lay;
    }
    const zones = [];
    for (const z of irr.zones) {
      const hs = irr.heads.filter((h) => h.zone === z.n && h.nozzle);
      if (!hs.length) continue;
      const box = (sys.boxes.find((b) => b.id === z.box) || sys.boxes[0]).at;
      const mainRun = lay?.main.find((m) => m.box === (z.box || sys.boxes[0].id)) || lay?.main[0];
      // the supply line: as given, else its route (and 3 ft of risers), else straight plus 15%
      const lenFt = Number.isFinite(sl.lenFt) ? sl.lenFt : mainRun ? mainRun.lenM * FT_PER_M + 3 : distFt(sys.pvb.at, box) * 1.15 + 3;
      const parts = (Q) => ({
        meter: meterDev ? deviceLoss(meterDev, Q) : 0,
        service: svc ? dwPerFt(svc.idIn, svcEps, Q) * (src.serviceFt || 0) * (1 + FITTINGS_SHARE) : 0,
        pvb: pvbDev ? deviceLoss(pvbDev, Q) : 0,
        supply: dwPerFt(slPipe.idIn, slEps, Q) * lenFt * (1 + FITTINGS_SHARE),
      });
      const upstream = (Q) => Object.values(parts(Q)).reduce((t, v) => t + v, 0);
      const tree = lay?.zones.get(z.n) || route(box, hs.map((h) => ({ id: h.id, at: h.at })), { cost: ctx.routeCost });
      const family = z.family || 'pe';
      const res = solveZone({
        tree, heads: new Map(hs.map((h) => [h.id, h])), water: (h, psi) => headFlow(h, cat, psi), elev: ctx.elev,
        family, size: z.size && z.size !== 'auto' ? pipeSize(family, Number(z.size))?.id : null,
        valve: deviceOf(z.valve) || typical('valve', 1),
        // how each head joins the pipe (owner, 2026-10-22): as the person says for the zone, else sprays on
        // flexible swing pipe and rotors on a rigid 3/4 in swing joint (lib/hydraulics.js SWING)
        riseIn: (h) => nozzleRiseIn(cat.body(h.body)),
        branchFitting: () => z.connect !== 'saddle',
        swingLoss: (h, g) => z.connect === 'saddle' ? deviceLoss(SWING.saddle, g) : z.connect === 'swing' ? deviceLoss(SWING.flexible, g) : z.connect === 'rigid' ? deviceLoss(SWING.rigid, g) : deviceLoss(/rotor|impact/.test(cat.familyOfNozzle(h.nozzle)?.kind || '') ? SWING.rigid : SWING.flexible, g),
      }, { psi: P, gaugeAt: sys.pvb.at, gaugeElevM: Number.isFinite(groundPvb) ? groundPvb + 0.3 : null, upstream });
      /* GAUGE READINGS (owner, 2026-10-20: "to override estimates"): a head with a reading takes it; the
         zone's other heads move by the zone's average miss, since what a reading shows -- the pressure
         coming in, a device's loss -- is mostly the whole zone's. A pitot reads the nozzle's pressure (after
         any regulator); a gauge on the riser, the lateral's with that head shut. */
      const miss = [];
      for (const [id, hr] of res.heads) {
        hr.model = { psi: hr.psi, nozzlePsi: hr.water?.nozzlePsi ?? hr.psi, riserPsi: res.pressures.get(id), gpm: hr.gpm };
        const hd = hs.find((x) => x.id === id), g = hd?.gauge;
        if (!g || !Number.isFinite(g.psi)) continue;
        // what the reading says the pressure at this head's inlet is
        let inlet = null;
        if (g.method === 'riser') inlet = g.psi - (hr.swingLoss ?? 0); // the riser, less this head's own swing joint once it flows
        else {
          const b = cat.body(hd.body), fam = cat.familyOfNozzle(hd.nozzle), reg = b?.regulatedPsi;
          if (Number.isFinite(reg) && fam?.pressureIs !== 'inlet') {
            // a regulated nozzle at its setting says only "at least the setting plus what it needs"; under it, the inlet
            const diff = reg - regulatedOut(b, reg); // what the regulator needs above its setting (lib/hydraulics.js)
            inlet = g.psi < reg - 0.5 ? g.psi + diff : null;
          } else inlet = g.psi;
        }
        miss.push({ id, inlet, d: inlet === null ? null : inlet - hr.model.psi });
      }
      if (miss.length) {
        const told = miss.filter((m) => m.d !== null);
        const off = told.length ? told.reduce((t, m) => t + m.d, 0) / told.length : 0;
        let Q = 0;
        for (const [id, hr] of res.heads) {
          const own = miss.find((m) => m.id === id);
          hr.psi = hr.model.psi + (own && own.d !== null ? own.d : off);
          hr.measured = !!own; hr.adjusted = !own;
          const w = headFlow(hs.find((x) => x.id === id), cat, Math.max(0, hr.psi));
          hr.water = w; hr.gpm = w ? w.gpm : hr.gpm; Q += hr.gpm;
        }
        res.calibrated = { readings: miss.length, offset: off, modelGpm: res.gpm };
        res.gpm = Q;
      }
      zones.push({ n: z.n, tree, res, lenFt, parts: parts(res.gpm), main: mainRun?.cells || null });
    }
    solved = { zones, pvbDev, slPipe, at: Date.now() };
    solvedKey = key;
    return solved;
  }
  const solvedHead = (id) => { const s = solved; if (!s) return null; for (const z of s.zones) { const h = z.res.heads.get(id); if (h) return h; } return null; };
  /* MEASURING (owner, 2026-10-23: "don't display the pressure estimates for other zones without measurements
     yet... Only if the user finishes without submitting a measurement for every zone"): in the measure step a
     zone with no reading of its own shows no pressure until the person chooses to go on without one. */
  const hidesBorrowed = () => step === 'measure' && !irr.borrowOk;
  const shownHead = (id) => { const sh = solvedHead(id); return sh && !(sh.borrowed && hidesBorrowed()) ? sh : null; };
  /** Has this head a reading of its own (a gauge, or in the throw mode a throw)? */
  const measuredHere = (h) => (irr.method === 'throw' ? !!h.throwFt : !!h.gauge);
  /* A head's water: its own nozzle, arc and throw as they are now, at the pressure the solve gives it (so a
     dragged arc's fan follows the finger), kept until one of them changes. */
  const flowCache = new Map();
  const waterOf = (h) => {
    if (!cat) return null;
    const got = solve() && solvedHead(h.id);
    const psi = got && Number.isFinite(got.psi) ? Math.max(0, got.psi) : Number.isFinite(irr.system.source.psi) ? irr.system.source.psi - 15 : NaN;
    const k = `${psi}|${h.body}|${h.nozzle}|${h.arc}|${h.throw}|${h.dir}`, c = flowCache.get(h.id);
    if (c && c.k === k) return c.w;
    const w = headFlow(h, cat, psi);
    flowCache.set(h.id, { k, w });
    return w;
  };
  const STATUS_COLOR = { ok: '#43a047', low: '#fb8c00', high: '#8e24aa' };

  /* THE COVERAGE (lib/precip.js): a grid over the lawn, every head's water laid over its arc and throw by its
     kind's radial profile (lib/hydraulics/profiles.json when it loads). */
  let profilesNote = "an estimated spread (even to 70% of the throw, falling to its edge)";
  fetch('/lib/hydraulics/profiles.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j?.typical) return;
    setProfiles(j);
    profilesNote = "each kind of head's measured spread (Fresno State's Center for Irrigation Technology tests of rotors, rotary nozzles and high-efficiency sprays; Hunter's MP Rotator curves), and for conventional sprays, of which no measurement was found, an estimate with a dry ring about 2 ft round the head";
    coverKey = ''; ctx.draw(); if (step === 'arcs' && showCover) render();
  }).catch(() => {});
  /** Which measured spread a head follows (lib/precip.js profileFor). */
  const profileOf = (fam) => {
    if (!fam) return 'spray';
    if (fam.kind === 'impact') return 'impact';
    if (fam.kind === 'rotor') return /-la\b|gray-la|low/.test(fam.id) ? 'rotor-la' : 'rotor';
    if (fam.kind === 'rotary') return 'rotary';
    return /^to-psn|^rb-he-van/.test(fam.id) ? 'spray-he' : 'spray';
  };
  const COVER = { missed: '#d32f2f', dry: '#f57c00', mid: '#9e9e9e', wet: '#1565c0' };
  let coverKey = '', coverCache = null;
  function coverage() {
    if (!cat || !ctx.groundAt || !solve()) return null;
    const key = solvedKey + JSON.stringify(irr.heads.map((h) => [h.dir, h.arc, h.throw]));
    if (key === coverKey) return coverCache;
    // the grid: half-metre cells over the heads' reach
    const hs = coverHeads();
    if (!hs.length) return null;
    const ref = hs[0].at, xy = hs.map((h) => enu(ref, h.at)), reach = Math.max(...hs.map((h) => h.strip ? h.strip.lengthM : h.radiusM * 1.3));
    // the heads' reach and the whole traced lawn, so lawn no head reaches counts as missed
    const lb = ctx.lawnBox?.(), corners = lb ? [enu(ref, lb[0]), enu(ref, lb[1])] : [];
    const xs = [...xy.map((p) => p[0] - reach), ...xy.map((p) => p[0] + reach), ...corners.map((p) => p[0])];
    const ys = [...xy.map((p) => p[1] - reach), ...xy.map((p) => p[1] + reach), ...corners.map((p) => p[1])];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const cellM = 0.5, W = Math.ceil((x1 - x0) / cellM), H = Math.ceil((y1 - y0) / cellM);
    const at = (c, r) => unEnu(ref, [x0 + (c + 0.5) * cellM, y1 - (r + 0.5) * cellM]);
    const lawnFlag = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) lawnFlag[r * W + c] = isLawn(ctx.groundAt(at(c, r))) ? 1 : 0;
    const p = precipitation({ W, H, cellM, at, lawn: (i) => lawnFlag[i] === 1 }, hs);
    coverCache = { p, W, H, cellM, nw: unEnu(ref, [x0, y1]), lawnFlag, at };
    coverKey = key;
    return coverCache;
  }
  /** Every head's water as lib/precip.js lays it, with what lib/fixes.js asks of it too. */
  function coverHeads() {
    const hs = [];
    for (const h of irr.heads) {
      const w = waterOf(h), fam = cat.familyOfNozzle(h.nozzle), n = cat.nozzle(h.nozzle);
      if (!w || !(w.gpm > 0)) continue;
      const sh = solvedHead(h.id);
      // the radius screw is in the head's water already (lib/heads.js headWater: its throw, its flow)
      hs.push({
        id: h.id, zone: h.zone, at: h.at, gpm: w.gpm, radiusM: w.radiusFt / FT_PER_M, fullRadiusM: (w.fullRadiusFt ?? w.radiusFt) / FT_PER_M, cut: w.cut ?? 1, arc: w.arc ?? 360, dir: h.dir ?? 0, throw: h.throw ?? 1,
        profile: profileOf(fam), strip: w.strip ? { type: w.strip.type, lengthM: w.strip.lengthFt / FT_PER_M, widthM: w.strip.widthFt / FT_PER_M } : null,
        kind: fam?.kind || 'spray', status: w.status, psi: sh?.psi ?? w.inletPsi, chartLo: w.chartLo, chartHi: w.chartHi, regulated: w.regulated,
        adjustable: !!n && !n.strip && !Number.isFinite(n.arcFixed), fixedArc: !!n && Number.isFinite(n.arcFixed), arcMax: n?.arcMax ?? 360, label: n?.label || '',
      });
    }
    return hs;
  }
  /** The coverage as an image over the photo: the all-zones depth share, or one zone's rate. */
  function drawCoverage(g) {
    const cv = coverage();
    if (!cv) return;
    const { p, W, H, cellM, lawnFlag } = cv;
    const img = new ImageData(W, H), hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const [mr, mg, mb] = hex(COVER.missed), [dr, dg, db] = hex(COVER.dry), [nr, ng, nb] = hex(COVER.mid), [wr, wg, wb] = hex(COVER.wet);
    const zone = coverView === 'all' ? null : p.byZone.get(coverView);
    const zmax = zone ? Math.max(...zone) : 1;
    for (let i = 0; i < W * H; i++) {
      if (!lawnFlag[i] && !(zone ? zone[i] > 0 : p.coverage[i] > 0)) continue;
      let rgb, a = lawnFlag[i] ? 200 : 90;
      if (zone) { const t = zmax > 0 ? Math.min(1, zone[i] / zmax) : 0; if (t <= 0) continue; rgb = [227 - t * 214, 242 - t * 171, 253 - t * 92]; }
      else {
        const v = p.coverage[i];
        if (v <= 0) rgb = [mr, mg, mb];
        else if (v < 1) { const t = Math.max(0, Math.min(1, (v - 0.4) / 0.6)); rgb = [dr + (nr - dr) * t, dg + (ng - dg) * t, db + (nb - db) * t]; if (v >= 0.85) a = Math.round(a * 0.45); }
        else { const t = Math.max(0, Math.min(1, (v - 1) / 0.6)); rgb = [nr + (wr - nr) * t, ng + (wg - ng) * t, nb + (wb - nb) * t]; if (v <= 1.25) a = Math.round(a * 0.45); }
      }
      img.data.set([rgb[0], rgb[1], rgb[2], a], i * 4);
    }
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
    const [x, y] = ctx.toPx(cv.nw), s = cellM * ctx.pxPerM();
    g.save(); g.imageSmoothingEnabled = true; g.drawImage(tmp, x, y, W * s, H * s); g.restore();
  }

  /** A reading, with the model's own prediction (before any reading moved it) and what it rested on, to the
      water tool's ground truth (src/readings.js). -> a note for the panel */
  async function keepReading(h, psi, method, hr, zs) {
    const m = hr?.model;
    if (!m) return 'Kept with your map; the model could not be compared here.';
    const sys = irr.system, z = irr.zones.find((x) => x.n === h.zone), fam = cat.familyOfNozzle(h.nozzle);
    const ground = ctx.elev?.(h.at), pvbG = ctx.elev?.(sys.pvb.at);
    const body = {
      map_id: ctx.mapId?.() || null, head_id: h.id, zone: h.zone, method, measured_psi: psi,
      predicted_psi: method === 'riser' ? m.riserPsi : m.nozzlePsi, predicted_inlet_psi: m.psi, predicted_nozzle_psi: m.nozzlePsi,
      body: h.body, nozzle: h.nozzle, kind: fam?.kind || null, head_gpm: m.gpm, zone_gpm: zs?.res.calibrated?.modelGpm ?? zs?.res.gpm ?? null,
      source_psi: sys.source.psi, source_read: sys.source.read, source_from: sys.source.from,
      typical_pvb: !sys.pvb.device, typical_valve: !z?.valve,
      rise_ft: Number.isFinite(ground) && Number.isFinite(pvbG) ? (ground - pvbG) * FT_PER_M : null,
      detail: { worksheet: zs?.res.worksheet || null, parts: zs?.parts || null, supplyLine: sys.supplyLine, zoneLine: { family: z?.family || 'pe', size: z?.size || 'auto' }, quality: sys.quality },
    };
    try {
      const res = await fetch('/api/water/readings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.ok ? 'Saved, and kept to check the model.' : res.status === 401 ? 'Saved with your map (sign in to add it to the model check).' : `Saved with your map (the model check did not take it: ${res.status}).`;
    } catch { return 'Saved with your map (the model check could not be reached).'; }
  }

  /* ------------------------------------------------------------------ the panel */

  function render() {
    const P = ctx.panel;
    if (!step) { P.hidden = true; ctx.title.hidden = true; return; }
    P.hidden = false; ctx.title.hidden = false;
    const list = stepsFor(irr.method), k = list.indexOf(step);
    ctx.title.innerHTML = step === 'intro' ? '<strong>Step 1: your sprinklers</strong>' : `<strong>Sprinklers, ${k + 1} of ${list.length}: ${STEP_TITLE[step]}</strong>`;
    P.innerHTML = BODY[step]();
    WIRE[step]?.(P);
    ctx.draw();
  }
  // the step is kept with the map too, so a reload comes back to it (owner: every step saves progress)
  const go = (s) => {
    // the arcs are fitted again on the way forward (the pressure may have changed); not when coming back to them
    const back = step === 'fixes' || step === 'schedule';
    step = s; irr.step = s; sel.clear(); measureAsk = false; fixPicked = null; if (s !== 'place') stopGps(); if (s === 'arcs') startArcs({ refit: !back }); if (s === 'fixes') showCover = false; if (s === 'schedule') buildSchedule(); ctx.changed(); render(); };
  /* THE ARCS, LAST: nothing of them is shown until they are fitted (owner, 2026-10-21: "don't show the arcs at
     all until the automatic adjustment completes ... when the arc is automatically detected, the manual
     adjustment should come right after"). Fitting waits for the lawn map; a map reopened on this step keeps
     the arcs it saved. */
  function startArcs({ refit = false } = {}) {
    showCover = false;
    const fitted = irr.heads.filter((h) => h.nozzle).every((h) => h.arcSet === 'auto' || h.arcSet === 'user');
    if (!refit && fitted) { arcPhase = 'ready'; return; }
    if (!ctx.groundAt) { arcPhase = 'waiting'; return; }
    arcPhase = 'fitting';
    // a beat for the page to say so before the work
    setTimeout(() => { if (step !== 'arcs') return; fitAll(); arcPhase = 'ready'; changed(); render(); }, 60);
  }
  const back = () => { const list = stepsFor(irr.method); go(step === 'place' ? 'intro' : list[Math.max(0, list.indexOf(step) - 1)]); };
  const nav = (next, { ok = true, label = 'Next' } = {}) => `<div class="tools"><button type="button" class="plain" data-act="back">Back</button><button type="button" data-act="next" ${ok ? '' : 'disabled'}>${label}</button></div>`;
  const wireNav = (P, next) => {
    P.querySelector('[data-act=back]')?.addEventListener('click', back);
    P.querySelector('[data-act=next]')?.addEventListener('click', next);
  };
  const changed = () => { ctx.changed(); ctx.draw(); };

  function coverageCard() {
      const cv = coverage();
      if (!cv) return `<p>${ctx.groundAt ? 'Give every head its nozzle and the pressure first.' : 'The lawn map is still loading; the coverage follows it.'}</p>`;
      const p = cv.p, m2 = (cells) => cells * cv.cellM * cv.cellM;
      const zones = [...p.zoneMean.entries()].sort((a, b) => a[0] - b[0]);
      return `<p class="hint">${coverView === 'all' ? 'Each zone run long enough to put down its average depth, all the zones together: <span style="color:' + COVER.dry + '">orange</span> gets under 60% of it (dry), <span style="color:' + COVER.missed + '">red</span> gets none, <span style="color:' + COVER.wet + '">blue</span> over 150% (where zones overlap, or water piles up near heads).' : `Zone ${coverView}'s own rate, inches an hour, darker for more.`}</p>
        <div class="tools"><button type="button" class="${coverView === 'all' ? '' : 'plain'}" data-view="all">All zones</button>${zones.map(([z]) => `<button type="button" class="${coverView === z ? '' : 'plain'}" data-view="${z}" style="border-color:${colorOf(z)}">Zone ${z}</button>`).join('')}</div>
        <table class="months"><tr><th>Zone</th><th>Puts down, on average</th></tr>${zones.map(([z, v]) => `<tr><td><span class="chip" style="background:${colorOf(z)}"></span>Zone ${z}</td><td>${v.toFixed(2)} in/h</td></tr>`).join('')}</table>
        <p><strong>Distribution uniformity ${Math.round(duReached(p, cv.lawnFlag) * 100)}%</strong>: the driest quarter of the lawn the heads reach, against its average. The Irrigation Association rates spray zones good at 55% and very good at 65%, rotor zones good at 65% and very good at 70%; real home systems audit at about 50% (Mecham 2004, over 4,500 audits), since wind, tilted heads and worn nozzles take their share, and this map has none of them. ${p.missed ? `About <strong>${Math.round(m2(p.missed) * 10.76)} sq ft</strong> of lawn gets no water at all. ` : ''}${p.dryShare > 0.02 ? `${Math.round(p.dryShare * 100)}% of the lawn gets under 60% of the depth: those are the dry spots.` : 'No sizeable dry spots.'}${p.wetShare > 0.02 ? ` ${Math.round(p.wetShare * 100)}% gets over 150%.` : ''}</p>
        <p class="dim">From each head's flow at the pressure it gets, over its arc and throw, by ${profilesNote}. Wind, a tilted head or a clogged nozzle are not in it: a catch-cup test on the lawn measures them.</p>`;
  }


  /* WHAT COULD BE BETTER (lib/fixes.js), kept until the coverage changes */
  let fixPicked = null, fixKey = '', fixCache = [];
  function fixList() {
    const cv = coverage();
    if (!cv) return [];
    if (fixKey === coverKey) return fixCache;
    const { W, H, cellM, at } = cv;
    fixCache = suggestions({ heads: coverHeads(), cover: { p: cv.p, W, H, cellM, at, lawnFlag: cv.lawnFlag }, groundAt: ctx.groundAt });
    fixKey = coverKey;
    return fixCache;
  }

  /* WHEN TO WATER (lib/schedule.js): each valve's lawn from where its heads throw, on the plan's own grid; the plan
     run with those as its zones (in the analysis worker); then minutes, runs and days a week, season by season */
  let sched = { key: '', state: 'idle', plan: null, vz: null, error: '' };
  async function buildSchedule() {
    const G = ctx.analysisGrid?.();
    if (!G || !ctx.planReady?.() || !cat || !solve()) { sched.state = 'waiting'; if (step === 'schedule') render(); return; }
    const key = solvedKey + JSON.stringify(irr.heads.map((h) => [h.dir, h.arc, h.throw, h.zone]));
    if (key === sched.key && (sched.state === 'ready' || sched.state === 'working')) return;
    sched = { key, state: 'working', plan: null, vz: null, error: '' };
    if (step === 'schedule') render();
    await new Promise((r) => setTimeout(r, 30)); // the page says so before the work
    try {
      const p = precipitation({ W: G.W, H: G.H, cellM: G.cellM, at: G.at, lawn: G.lawn }, coverHeads());
      const vz = valveZones(p.byZone, G.W * G.H, G.lawn);
      const plan = await ctx.valvePlan(vz.zoneOf);
      if (sched.key !== key) return;
      sched.plan = plan; sched.vz = vz; sched.grid = G; sched.cellM = G.cellM; sched.state = 'ready';
    } catch (e) {
      if (sched.key !== key) return;
      sched.state = 'error'; sched.error = e.message || String(e);
    }
    if (step === 'schedule') render(); else ctx.draw();
  }
  /** Each valve zone's schedule (lib/schedule.js zoneSchedule), with what the page says about it. */
  function schedRows() {
    const { plan, vz } = sched;
    if (!plan || !vz) return [];
    const rows = [];
    for (const z of irr.zones) {
      const pz = plan.zones.find((x) => x.zone === z.n - 1), own = vz.zones.get(z.n);
      if (!pz || !own) continue;
      const s0 = zoneSchedule(pz, own, plan.multiplier);
      if (!s0) continue;
      const wk = plan.thisWeek?.zones.find((x) => x.zone === z.n - 1);
      let next = null;
      if (wk?.next) { const inches = ((wk.next.mm / plan.multiplier) * s0.sm) / 25.4; next = { date: wk.next.date, ...runsOf(inches, s0) }; }
      rows.push({ n: z.n, s: s0, pz, ft2: own.cells * sched.cellM * sched.cellM * 10.764, next });
    }
    return rows;
  }
  const runsOf = (inches, s0) => { const total = (inches / s0.rateInH) * 60, runs = s0.takesInH && s0.rateInH > s0.takesInH ? Math.min(2, Math.max(1, Math.ceil(inches / s0.takesInH - 0.05))) : 1; return { runs, minutes: Math.max(1, Math.round(total / runs)), total: Math.round(total) }; };
  /** Each valve's lawn, tinted its colour, over the photo (the schedule step). */
  function drawValveLawn(g) {
    const { vz, grid: G } = sched;
    if (!vz || !G) return;
    const img = new ImageData(G.W, G.H);
    for (let i = 0; i < G.W * G.H; i++) {
      const z = vz.zoneOf[i];
      if (z < 0) continue;
      const hex = colorOf(z + 1);
      img.data.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 120], i * 4);
    }
    const tmp = document.createElement('canvas'); tmp.width = G.W; tmp.height = G.H; tmp.getContext('2d').putImageData(img, 0, 0);
    const [x0, y0] = ctx.toPx(G.at(-0.5, -0.5)), [x1, y1] = ctx.toPx(G.at(G.W - 0.5, G.H - 0.5));
    g.save(); g.imageSmoothingEnabled = false; g.drawImage(tmp, x0, y0, x1 - x0, y1 - y0); g.restore();
  }

  const BODY = {
    intro: () => `<p>Before the watering plan: where your sprinkler heads are, which valve each is on, and what heads and nozzles they are. With them the plan can say how long to run each zone, not just how much water it needs.</p>
      <div class="tools"><button type="button" data-act="start">Map my sprinklers</button><button type="button" class="plain" data-act="none">I don't have an in-ground system</button></div>`,

    place: () => `<div class="tools"><label class="toggle"><input type="radio" name="pm" value="tap" ${placeMode === 'tap' ? 'checked' : ''}> Tap on the photo</label><label class="toggle"><input type="radio" name="pm" value="gps" ${placeMode === 'gps' ? 'checked' : ''}> Walk the lawn with GPS</label></div>
      ${placeMode === 'tap' ? '<p class="hint">Tap each sprinkler head on the photo. Zoom in for a closer look.</p>' : gpsBody()}
      ${gridControls()}
      <p class="dim">${irr.heads.length} head${irr.heads.length === 1 ? '' : 's'} placed.</p>
      <div class="tools"><button type="button" class="plain" data-act="undo" ${irr.heads.length ? '' : 'disabled'}>Undo the last</button></div>
      ${nav('review', { ok: irr.heads.length > 0, label: 'Done placing' })}`,

    review: () => `<p class="hint">Drag any head that is not where it should be. Tap one, then "Remove", to take it off.</p>
      ${gridControls()}
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
      return `<p class="hint">Each head's details are over it on the map (zoom in where they crowd). Tap a head to see it here. Where each one throws comes last, once the pressure at every head is known.</p>
        ${sel.size === 1 ? `<p>${headLine(head([...sel][0]))}</p>` : ''}
        <table class="months"><tr><th>Zone</th><th>Heads</th><th>Flow</th><th>Puts down</th></tr>${rows}</table>
        <p class="dim">${solve() ? 'At the pressure each head gets, worked out over the next steps.' : "At about the chart's working pressure until the next steps work out each head's own."} "Puts down" is the heads' rate at head-to-head spacing.</p>
        ${nav('method', { label: 'Looks right' })}`;
    },

    method: () => {
      const m = MEASURED.has(irr.method) ? irr.method : 'model';
      const card = (v, title, text) => `<label class="card" style="display:block;margin-top:8px;cursor:pointer"><input type="radio" name="method" value="${v}" ${m === v ? 'checked' : ''}> <strong>${title}</strong><br><span class="dim">${text}</span></label>`;
      return `<p>Each head's pressure sets how far it throws and how much water it puts down. Three ways to find it:</p>
        ${card('gauge', 'Measure it with a pressure gauge', 'One reading per zone, with the zone running: a pitot tube held in a head\'s spray, or a gauge screwed on in place of a nozzle (a few dollars from an irrigation supplier). Nothing about pipes, valves or your water supply is asked.')}
        ${card('throw', 'Measure how far heads throw', 'One head per zone: how far its water reaches, with a tape measure or by walking it with your phone\'s GPS. No tools, nothing buried.')}
        ${card('model', 'Work it out from your pipes and water supply', 'Place the backflow preventer and the valve box, give your water pressure and what the pipes are made of, and the pipe is laid out and every head worked out. No measuring; the most questions.')}
        ${nav(MEASURED.has(irr.method) ? 'measure' : 'equipment')}`;
    },

    measure: () => {
      const s0 = solve(), thr = irr.method === 'throw';
      const h = sel.size === 1 ? head([...sel][0]) : null;
      const rows = irr.zones.map((z) => {
        const hs = irr.heads.filter((x) => x.zone === z.n), rd = hs.filter((x) => (thr ? x.throwFt : x.gauge));
        const zs = s0?.zones.find((q) => q.n === z.n), shown = zs && !(zs.res.borrowed && hidesBorrowed());
        const ps = shown ? [...zs.res.heads.values()].map((v) => v.psi) : [];
        return `<tr><td><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n} <button type="button" class="plain" data-mzone="${z.n}" style="padding:2px 6px;font-size:13px">pick a head</button></td><td>${rd.length ? `<span style="color:var(--good)">&#10003;</span> ${rd.map((x) => (thr ? `${x.throwFt.ft} ft${x.throwFt.by === 'gps' ? ' (GPS)' : ''}` : `${x.gauge.psi} psi`)).join(', ')}` : '<span style="color:var(--bad)">none yet</span>'}</td><td>${ps.length ? `${Math.round(Math.min(...ps))}${Math.round(Math.max(...ps)) !== Math.round(Math.min(...ps)) ? `-${Math.round(Math.max(...ps))}` : ''} psi${zs.res.borrowed ? ' (estimated from the other zones)' : ''}` : ''}</td></tr>`;
      }).join('');
      const missingZones = irr.zones.filter((z) => irr.heads.some((x) => x.zone === z.n && x.nozzle) && !irr.heads.some((x) => x.zone === z.n && (thr ? x.throwFt : x.gauge)));
      const missing = missingZones.length;
      const how = thr
        ? 'Run one zone at a time. Pick a head whose throw has not been shortened (its radius screw open), and measure from the head straight out along the middle of its spray to the farthest point it wets. Measure on a still morning: wind shortens it. Then tap that head on the map and enter it.'
        : 'Run one zone at a time. With a pitot tube, hold its tip in the stream right at the nozzle; with a gauge, unscrew a nozzle and screw the gauge on in its place, then run the zone. A head midway along the zone reads closest to the zone\'s average. Then tap that head on the map and enter it.';
      const now = h ? (thr ? h.throwFt : h.gauge) : null, sh = h ? shownHead(h.id) : null;
      return `<p class="hint">${how}</p>
        ${h ? `<div class="card" style="margin-top:6px"><p style="margin:0">${headLine(h)}</p>
          <div class="tools">${thr ? `<label class="toggle">It throws <input type="number" inputmode="decimal" min="1" max="120" step="0.5" data-act="mval" value="${now ? now.ft : ''}" style="width:80px;padding:6px;font-size:16px"> ft</label>`
            : `<label class="toggle">Reading <input type="number" inputmode="decimal" min="1" max="150" step="0.5" data-act="mval" value="${now ? now.psi : ''}" style="width:80px;padding:6px;font-size:16px"> psi</label>
              <select data-act="mmethod"><option value="pitot" ${now?.method === 'pitot' ? 'selected' : ''}>pitot tube in the spray</option><option value="riser" ${now?.method === 'riser' ? 'selected' : ''}>gauge in place of the nozzle</option></select>`}
            <button type="button" data-act="msave">Use it</button>${now ? '<button type="button" class="plain" data-act="mdrop">Remove</button>' : ''}</div>
          ${thr ? `<div class="tools"><span class="dim">Or with your phone:</span><button type="button" class="plain" data-act="gpshead">1. I'm standing at the head</button><button type="button" class="plain" data-act="gpsedge" ${throwGps.head && throwGps.id === h.id ? '' : 'disabled'}>2. I'm where its water stops</button></div>` : ''}
          ${sh ? `<p class="dim" style="margin:4px 0 0">${sh.measured ? 'Measured here' : 'From the readings'}: ${Math.round(sh.psi)} psi coming in${sh.water ? `; throws ${Math.round(sh.water.radiusFt)} ft, ${sh.water.gpm.toFixed(2)} gpm` : ''}.</p>` : ''}</div>` : '<p class="dim">Tap a head on the map to measure it.</p>'}
        ${measureNote ? `<p class="hint">${esc(measureNote)}</p>` : ''}
        <table class="months"><tr><th>Zone</th><th>Measured</th><th>At its heads</th></tr>${rows}</table>
        <p class="dim">On the map each head keeps its zone's colour and number; the ring round it is its pressure: <span style="color:${STATUS_COLOR.ok}">&#9679;</span> in its chart's range, <span style="color:${STATUS_COLOR.low}">&#9679;</span> under it, <span style="color:${STATUS_COLOR.high}">&#9679;</span> over it. A check marks each head you measured.</p>
        <p class="dim">One reading a zone is enough; another at the zone's far end makes it better. The zone's other heads are given the reading's pressure, moved by the height between them (0.433 psi a foot, from the USGS lidar)${thr ? '; a throw is read back through the nozzle\'s chart to the pressure that throws that far' : ''}.${missing ? ` ${missing} zone${missing > 1 ? 's have' : ' has'} no reading yet.` : ''}</p>
        ${measureAsk && missing ? `<div class="card" style="border-color:var(--warn)"><p style="margin:0"><strong>Zone${missing > 1 ? 's' : ''} ${missingZones.map((z) => z.n).join(', ')} ${missing > 1 ? 'have' : 'has'} no reading.</strong> ${missing > 1 ? 'Their' : 'Its'} pressure can be estimated from the other zones' readings, moved by the height between them; but each zone has its own valve and pipe, so it is a rougher estimate than one reading of its own.</p>
          <div class="tools"><button type="button" data-act="measuremore">Measure ${missing > 1 ? 'them' : 'it'}</button><button type="button" class="plain" data-act="borrow" ${s0 ? '' : 'disabled'}>Go on with the estimate</button></div></div>` : ''}
        ${nav('arcs', { ok: !!s0, label: 'Next: the arcs' })}`;
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
        ${irr.zones.map((z) => `<div style="margin-top:6px"><span class="chip" style="background:${colorOf(z.n)}"></span>Zone ${z.n}'s valve: <select data-valve="${z.n}"><option value="">I don't know (a typical 1 in valve)</option>${valveOptions(valves, z.valve)}</select>
          ${sys.boxes.length > 1 ? ` in <select data-box="${z.n}">${sys.boxes.map((b, k) => `<option value="${b.id}" ${b.id === (z.box || sys.boxes[0].id) ? 'selected' : ''}>valve box ${k + 1}</option>`).join('')}</select>` : ''}</div>`).join('')}
        <p class="dim">The brand and model are on the valve's cap or body; the size is the pipe it takes (most homes: 1 in). Their makers' charts differ by up to about 5 psi at a zone's flow, which reaches every head on it, so it is worth a look in the valve box. A valve with a pressure-regulating module (Rain Bird PRS-Dial, Hunter Accu-Sync) is not in the list yet.</p>
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
          <div style="margin-top:4px">Each head joins the pipe by: <select data-connect="${z.n}">${CONNECT.map(([v, l]) => `<option value="${v}" ${v === (z.connect || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${zs ? `<div class="dim">${[...byNom].sort((x, y) => y[0] - x[0]).map(([n, L]) => `${fraction(n)} in for about ${Math.round(L)} ft`).join(', ')}.${fast.length ? ` <strong style="color:var(--bad)">${fast.length} run${fast.length > 1 ? 's' : ''} over 5 ft/s</strong>: a bigger pipe there.` : ''}</div>` : ''}</div>`;
      }).join('');
      return `<p class="hint">What the lines from the valve box to the heads are made of. "Sized by flow" gives each run the size an installer would: the smallest that keeps the water under 5 ft/s, larger near the valve, smaller toward the last heads. The routes are on the map: laid as installers lay them, straight runs with few turns, along the lawn's edges where that is where they belong, each zone fed from the middle of its heads, round the house.</p>${rows}
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

    arcs: () => {
      if (arcPhase === 'waiting') return `<p class="hint">The lawn map is still loading. Each head's arc is fitted to it as soon as it is in.</p>${nav('done', { ok: false, label: 'Done' })}`;
      if (arcPhase === 'fitting') return `<p class="hint"><strong>Fitting every head's arc to your lawn…</strong></p>${nav('done', { ok: false, label: 'Done' })}`;
      const h = sel.size === 1 ? head([...sel][0]) : null, n = h && cat?.nozzle(h.nozzle), w = h && waterOf(h);
      const changedByYou = irr.heads.filter((x) => x.arcSet === 'user').length;
      const what = n && w ? (n.strip ? 'a strip: drag the white dot to turn it' : Number.isFinite(n.arcFixed) && n.arcFixed < 360 ? `a fixed ${n.arcFixed}° pattern: drag either white dot to turn it` : Number.isFinite(n.arcFixed) ? 'a full circle' : `adjustable ${n.arcMin ?? 0}-${n.arcMax ?? 360}°: drag a white dot to move that edge`) : '';
      const views = `<div class="tools"><button type="button" class="${showCover ? 'plain' : ''}" data-show="arcs">The arcs</button><button type="button" class="${showCover ? '' : 'plain'}" data-show="cover">The coverage</button></div>`;
      if (showCover) return `${views}${coverageCard()}${nav('fixes', { label: 'Next: what could be better' })}`;
      return `${views}<p class="hint"><strong>Every arc is fitted.</strong> Each covers as much lawn as it can, reaching the next heads (head to head), with as little water as it can on the house, drives and paving; beds and woods are fine. Each throw is from the pressure that head gets. Now check them: tap a head to change it.</p>
        ${h && n && w ? `<div class="card" style="margin-top:6px"><p style="margin:0">${headLine(h)}</p>
          <p class="dim" style="margin:6px 0 0">${n.strip ? '' : `Arc ${Math.round(arcOf(h, n))}°, facing ${Math.round(h.dir ?? 0)}° from north; `}throws ${Math.round(w.radiusFt)} ft (${Math.round((h.throw ?? 1) * 100)}% of its chart${(h.throw ?? 1) < 0.999 ? `, by its radius screw: ${/rotor|impact/.test(w.kind) ? `the same flow on less ground, ${(1 / (h.throw * h.throw)).toFixed(1)}x the rate, piled up partway out` : w.kind === 'rotary' ? 'less flow, the rate it lays down unchanged' : 'less flow'}` : ''}). It is ${esc(what)}; drag the yellow square in or out to shorten or lengthen the throw.${h.arcSet === 'user' ? ' Set by you.' : ''}</p>
          <div class="tools"><button type="button" class="plain" data-act="autoone">Fit this one again</button></div></div>` : ''}
        <div class="tools"><button type="button" class="plain" data-act="autoall">Fit every head again${changedByYou ? ` (undoes your ${changedByYou} change${changedByYou > 1 ? 's' : ''})` : ''}</button></div>
        <p class="dim">The throw is the chart's radius at each head's pressure; a nozzle's radius screw (or a rotor's break-up screw) shortens it, usually by up to about 25%.</p>
        ${nav('fixes', { label: 'Next: what could be better' })}`;
    },

    fixes: () => {
      const list = fixList(), cv = coverage();
      const views = `<div class="tools"><button type="button" class="${showCover ? 'plain' : ''}" data-show="arcs">The arcs</button><button type="button" class="${showCover ? '' : 'plain'}" data-show="cover">The coverage</button></div>`;
      if (!cv) return `<p>${ctx.groundAt ? 'Give every head its nozzle and its pressure first.' : 'The lawn map is still loading.'}</p>${nav('schedule', { label: 'Next: when to water' })}`;
      const between = betweenZones(cv.p.zoneMean);
      const FIX = { arc: 'Change it in the arcs step', nozzle: 'Pick other nozzles', pressure: 'Pick other heads', head: 'Change the nearest' };
      const items = list.map((f, k) => `<li style="margin:6px 0${fixPicked === k ? ';background:rgba(255,235,59,.18)' : ''}"><strong>${k + 1}.</strong> ${f.text}
          <div class="tools" style="margin-top:4px"><button type="button" class="plain" data-fixshow="${k}" style="padding:4px 10px;font-size:14px">Show it</button>${f.heads.length ? `<button type="button" class="plain" data-fixgo="${k}" style="padding:4px 10px;font-size:14px">${FIX[f.fix] || 'Change it'}</button>` : ''}</div></li>`).join('');
      return `${views}<p class="hint">${list.length ? `${list.length} thing${list.length > 1 ? 's' : ''} that a longer or shorter run can't fix, most important first. Each is numbered on the map; "Show it" marks its heads.` : '<strong>Nothing about the heads needs changing.</strong> The pressure suits every nozzle, each zone puts its water down evenly enough, and the lawn is covered.'}</p>
        ${list.length ? `<ol style="list-style:none;padding-left:0;margin:0">${items}</ol>` : ''}
        <p class="dim">${between ? `Zone ${between.hi.zone} puts water down at about ${between.hi.inH.toFixed(2)} in/h and zone ${between.lo.zone} at ${between.lo.inH.toFixed(2)}: that is fine, and nothing to change here. The next step gives each zone its own run time, and cycle and soak where a zone waters faster than the ground takes it in.` : 'Each zone gets its own run time in the next step, and cycle and soak where it waters faster than the ground takes it in.'} How evenly the lawn the heads reach is watered: ${Math.round(duReached(cv.p, cv.lawnFlag) * 100)}% (good is 55% for sprays, 65% for rotors, by the Irrigation Association's figures).</p>
        ${nav('schedule', { label: 'Next: when to water' })}`;
    },

    schedule: () => {
      if (sched.state === 'waiting') return `<p class="hint">${ctx.planReady?.() ? 'The lawn map is still loading.' : 'Reading the soil survey and ten years of weather…'} The schedule follows as soon as they are in.</p>${nav('done', { ok: false, label: 'Done' })}`;
      if (sched.state === 'working' || sched.state === 'idle') return `<p class="hint"><strong>Working out each zone's watering over ten years of your weather…</strong></p>${nav('done', { ok: false, label: 'Done' })}`;
      if (sched.state === 'error') return `<p class="hint">The schedule could not be worked out: ${esc(sched.error)}.</p><div class="tools"><button type="button" data-act="schedagain">Try again</button></div>${nav('done', { label: 'Done' })}`;
      const rows = schedRows();
      if (!rows.length) return `<p>None of the zones waters the traced lawn, so there is nothing to schedule.</p>${nav('done', { label: 'Done' })}`;
      const runWords = (x) => (x.runs > 1 ? `${x.runs} runs of ${x.minutes} min, an hour apart` : `${x.minutes} min`);
      const seasonNames = ['Spring', 'Summer', 'Fall', 'Winter'].filter((n) => rows.some((r) => r.s.seasons.some((q) => q.name === n)));
      const often = (q) => (q.dryOnly ? 'only in a dry spell' : q.sameAll ? q.often[0].often : q.often.map((o) => `${MONTH[o.month].slice(0, 3)}: ${o.often}`).join('; '));
      const tables = seasonNames.map((name) => {
        const lines = rows.map((r) => { const q = r.s.seasons.find((x) => x.name === name); return q ? `<tr><td><span class="chip" style="background:${colorOf(r.n)}"></span>Zone ${r.n}</td><td>${often(q)}</td><td>${runWords(q)}</td></tr>` : ''; }).join('');
        const ms = [...new Set(rows.flatMap((r) => r.s.seasons.find((x) => x.name === name)?.months || []))].sort((a, b) => ((a + 10) % 12) - ((b + 10) % 12));
        return `<h3 style="margin:12px 0 0;font-size:1rem">${name} <span class="dim" style="font-weight:400">(${ms.map((m) => MONTH[m].slice(0, 3)).join(', ')})</span></h3>
          <table class="months"><tr><th>Zone</th><th>How often</th><th>Each watering day</th></tr>${lines}</table>`;
      }).join('');
      const summer = rows.map((r) => r.s.seasons.find((x) => x.name === 'Summer')).filter(Boolean);
      const dayMin = summer.reduce((s2, q) => s2 + q.total, 0);
      const notes = rows.map((r) => {
        const s0 = r.s, bits = [];
        bits.push(`puts down ${s0.rateInH.toFixed(2)} in/h on about ${Math.round(r.ft2 / 10) * 10} sq ft of lawn, ${Math.round(s0.du * 100)}% even`);
        const each = s0.seasons.length ? s0.seasons.reduce((a, q) => a + q.depthIn, 0) / s0.seasons.length : null;
        if (each) bits.push(`each watering puts down about ${each < 0.1 ? 'under 0.1' : each.toFixed(2)} in${s0.sm > 1.05 ? `, ${Math.round((s0.sm - 1) * 100)}% more than the grass uses, so the zone's driest quarter gets enough` : ''}`);
        if (s0.takesInH && s0.rateInH > s0.takesInH) bits.push(`faster than its slowest ground takes water in (${s0.takesInH.toFixed(2)} in/h), hence the runs an hour apart`);
        if (s0.skipAfterIn) bits.push(`skip a watering after about ${s0.skipAfterIn.toFixed(2)} in of rain`);
        if (s0.dry) bits.push(`in a week with no rain in ${MONTH[s0.dry.month]}: ${s0.dry.waterings} watering${s0.dry.waterings > 1 ? 's' : ''} of ${runWords(s0.dry)}`);
        const pz = r.pz, warn = [];
        if (pz.tooDry > 0) warn.push(`about ${Math.round(pz.tooDry * 10.76 / 10) * 10} sq ft of it still dries out between waterings, and running the whole zone longer would over-water the rest`);
        if (pz.tooWet > 0) warn.push(`about ${Math.round(pz.tooWet * 10.76 / 10) * 10} sq ft of it gets too wet on this schedule (it takes water from a roof, paving or uphill too)`);
        if (pz.wetAnyway > 0) warn.push(`about ${Math.round(pz.wetAnyway * 10.76 / 10) * 10} sq ft stays wet with no watering at all: drainage, not watering`);
        const next = r.next ? `Next watering: likely <strong>${new Date(`${r.next.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</strong>, ${runWords(r.next)}.` : '';
        return `<li style="margin:6px 0"><span class="chip" style="background:${colorOf(r.n)}"></span><strong>Zone ${r.n}</strong> ${bits.join('; ')}.${next ? ` ${next}` : ''}${warn.length ? ` <span style="color:var(--warn)">Within the zone, ${warn.join('; ')}.</span>` : ''}</li>`;
      }).join('');
      return `<p class="hint">Run times for your controller, zone by zone, as the seasons go. Each is from ten years of this place's weather, the soil under each zone's lawn and how fast and how evenly that zone's heads put water down.</p>
        ${tables}
        ${summer.length ? `<p class="dim">${dayMin > 180
          ? `Every zone on one day would run about ${Math.round(dayMin / 60 * 2) / 2} hours. Give the zones different days instead (each keeps its own number of days a week), and where a zone runs twice, let the other zones' runs be its hour's soak: most controllers call this "cycle and soak". Water in the early morning, finishing by about 9 am where you can: less is lost to wind and heat, and the grass dries off by evening.`
          : `A summer watering day runs about ${dayMin} minutes over all the zones: start early enough to finish by about 9 am, when less is lost to wind and heat and the grass dries off by evening.`}</p>` : ''}
        <h3 style="margin:12px 0 0;font-size:1rem">Zone by zone</h3>
        <ul style="padding-left:18px;margin:4px 0">${notes}</ul>
        <p class="dim">"How often" is a typical year, rain counted: in a dry spell water more often, and after a good rain skip a watering. A controller with a rain sensor or weather adjustment does this by itself. Months not listed need no watering in a typical year. On the map each zone's colour shows the lawn it waters.</p>
        ${nav('done', { label: 'Done' })}`;
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
        <tr><td><strong>At the head</strong></td><td><strong>${ws.atHead.toFixed(1)} psi</strong></td></tr></table>
        ${zsel.res.calibrated ? `<p class="dim">That is the model's own estimate. Your ${zsel.res.calibrated.readings} reading${zsel.res.calibrated.readings > 1 ? 's' : ''} in zone ${zsel.n} put${zsel.res.calibrated.readings > 1 ? '' : 's'} the heads ${zsel.res.calibrated.offset >= 0 ? 'higher' : 'lower'} by ${Math.abs(zsel.res.calibrated.offset).toFixed(1)} psi on average; the map and the table use your readings.</p>` : ''}` : '';
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
      return `<p class="hint">The lines are drawn as an installer most likely laid them; each head keeps its zone's colour and number, and the ring round it is its pressure: <span style="color:${STATUS_COLOR.ok}">●</span> in its chart's range, <span style="color:${STATUS_COLOR.low}">●</span> under it, <span style="color:${STATUS_COLOR.high}">●</span> over it. A check marks a head with a gauge reading. Tap a head for its numbers.</p>
        ${ph ? `<p>${headLine(pick)}<br>${ph.psi.toFixed(1)} psi at the head${ph.measured ? ' (from your reading)' : ph.adjusted ? ' (moved by your readings in this zone)' : ''}${ph.water?.regulated ? `, ${Math.round(ph.water.nozzlePsi)} at the nozzle after its regulator` : ''}; chart ${Math.round(ph.water?.chartLo)}–${Math.round(ph.water?.chartHi)} psi.</p>
          <div class="card" style="margin-top:6px"><strong>Your gauge reading</strong> at this head, with its zone running:
            <div class="tools"><input type="number" inputmode="decimal" min="0" max="200" step="0.5" data-act="gpsi" value="${pick.gauge ? pick.gauge.psi : ''}" style="width:90px;padding:8px;font-size:16px"> psi
            <select data-act="gmethod"><option value="pitot" ${pick.gauge?.method !== 'riser' ? 'selected' : ''}>pitot gauge held in the stream</option><option value="riser" ${pick.gauge?.method === 'riser' ? 'selected' : ''}>gauge on the riser, nozzle off</option></select>
            <button type="button" data-act="gsave">Save the reading</button>${pick.gauge ? '<button type="button" class="plain" data-act="gdrop">Remove it</button>' : ''}</div>
            <p class="dim">Predicted there: ${ph.model ? `${ph.model.nozzlePsi.toFixed(1)} psi at the nozzle (what a pitot reads), ${ph.model.riserPsi.toFixed(1)} in the riser with the nozzle off` : '–'}. A reading replaces the estimate for this head and moves the zone's others by the zone's average miss; it is also kept, with the prediction, to check the model.${gaugeNote ? ` <strong>${esc(gaugeNote)}</strong>` : ''}</p></div>` : '<p class="dim">Tap a head to see its numbers or enter a gauge reading for it.</p>'}
        <table class="months"><tr><th>Zone</th><th>Flow</th><th>At the heads</th><th>Spread</th><th></th></tr>${zoneRows}</table>
        ${sheet}
        ${warn.length ? `<ul>${warn.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
        <p class="dim">Devices from the makers' loss charts (a typical one of its size where you don't know yours); pipe friction by Darcy-Weisbach, which irrigation research prefers for small plastic pipe, with each tee and swing joint counted; at each zone's own flow, worked out with every head's flow at the pressure it gets${ctx.elevReady?.() ? '; heights from the USGS lidar' : ''}. The routes are a likely layout, not a dig: drag a head if a line runs where it can't.</p>
        ${nav('arcs', { label: 'Next: the arcs' })}`;
    },
  };

  /* MEASURED (lib/measured.js): each zone's readings, and every head from them by distance and height */
  function solveMeasured() {
    if (!cat) return null;
    const key = JSON.stringify([irr.method, irr.heads, ctx.elevReady?.() ?? false]);
    if (key === solvedKey) return solved;
    const readingOf = (h) => (irr.method === 'throw' ? (h.throwFt ? inletFromThrow(h, h.throwFt.ft, cat) : null) : h.gauge ? inletFromGauge(h, h.gauge, cat) : null);
    const all = [];
    for (const h of irr.heads) { const r = h.nozzle && readingOf(h); if (r) all.push({ id: h.id, at: h.at, zone: h.zone, psi: r.psi, edge: r.edge || (r.atLeast ? 'over' : null) }); }
    if (!all.length) { solved = null; solvedKey = key; return null; }
    const dist = (a, b) => Math.hypot(...enu(a, b));
    const zones = [];
    for (const z of irr.zones) {
      const hs = irr.heads.filter((h) => h.zone === z.n && h.nozzle);
      if (!hs.length) continue;
      const own = all.filter((r) => r.zone === z.n);
      // a zone with no reading of its own borrows the others' (flagged): a valve and its pipe are its own
      const used = own.length ? own : all;
      const ps = spreadReadings(hs, used, ctx.elev, dist);
      const heads = new Map();
      let gpm = 0;
      for (const h of hs) {
        const p = ps.get(h.id), w = headFlow(h, cat, Math.max(0, p.psi));
        heads.set(h.id, { psi: p.psi, gpm: w ? w.gpm : 0, radiusFt: w?.radiusFt ?? null, water: w, measured: p.measured, adjusted: !p.measured, borrowed: !own.length });
        gpm += w ? w.gpm : 0;
      }
      zones.push({ n: z.n, tree: null, res: { heads, gpm, readings: own.length, borrowed: !own.length, edge: own.some((r) => r.edge) }, main: null });
    }
    solved = { zones, measured: true, at: Date.now() };
    solvedKey = key;
    return solved;
  }

  /** One head's arc and throw, set for the lawn (lib/arcs.js): its throw at the pressure it gets. */
  function autoSet(h) {
    const n = cat?.nozzle(h.nozzle), w = waterOf(h);
    if (!n || !w || !ctx.groundAt) return;
    const a = autoArc(h.at, (w.fullRadiusFt ?? w.radiusFt) / FT_PER_M, n, ctx.groundAt);
    if (!a) return;
    h.dir = a.dir; if (!n.strip && !Number.isFinite(n.arcFixed)) h.arc = a.arc; h.throw = a.throw; h.arcSet = 'auto';
  }

  /* THE VALVE, AS IT CAN BE TOLD (owner, 2026-10-21: "do the valve models actually make a difference besides
     just size and if they're prs or not?"). They do -- at 1 in and 10 gpm the makers' charts run from about
     1 psi (Hunter PGV, angle) to 6 psi (Rain Bird PGA) -- but within a series the globe, angle, barb and jar-top
     bodies are close, so one choice per series and size: its plain body's chart. */
  const VALVE_SERIES = [[/^\d+-DV/, 'DV'], [/-HV/, 'HV'], [/-PGA/, 'PGA'], [/ASVF/, 'ASVF (anti-siphon)'], [/PGV-\d+-ASV/, 'PGV-ASV (anti-siphon)'], [/^PGV/, 'PGV'], [/^ICV/, 'ICV'],
    [/EZ-Flo.*anti-siphon/i, 'EZ-Flo Plus (anti-siphon)'], [/EZ-Flo/, 'EZ-Flo Plus'], [/^252/, '252'], [/^254/, '254/264'], [/^2[46]00/, '2400/2600'], [/^700/, '700 UltraFlow'],
    [/ProSeries 150/, 'ProSeries 150'], [/ProSeries 100/, 'ProSeries 100'], [/inline/i, 'inline valve']];
  const valveSeries = (d) => { for (const [re, name] of VALVE_SERIES) if (re.test(d.model)) return name; return d.model.replace(/\s*\(.*$/, ''); };
  const plainValve = (d) => !/angle|MB|male|jar|-FC|-A\b/i.test(d.model);
  /** The valve choices: brand, series and size, each its plain body's chart. */
  function valveOptions(valves, cur) {
    const groups = new Map();
    for (const d of valves) {
      const key = `${d.brand}|${valveSeries(d)}|${d.sizeIn}`;
      const was = groups.get(key);
      if (!was || (!plainValve(was) && plainValve(d))) groups.set(key, d);
    }
    // a saved choice of another body of the same series and size is shown as that series
    const curDev = valves.find((d) => d.id === cur);
    const curKey = curDev ? `${curDev.brand}|${valveSeries(curDev)}|${curDev.sizeIn}` : null;
    const brands = [...new Set([...groups.values()].map((d) => d.brand))].sort();
    return brands.map((b) => `<optgroup label="${esc(b)}">${[...groups.entries()].filter(([, d]) => d.brand === b).sort((x, y) => x[0].localeCompare(y[0])).map(([k, d]) => `<option value="${d.id}" ${k === curKey ? 'selected' : ''}>${esc(b)} ${esc(valveSeries(d))}, ${fraction(d.sizeIn)} in</option>`).join('')}</optgroup>`).join('');
  }

  /** A body as the person told it: a spray body by its height and regulator, a rotor by its maker and model. */
  const bodyName = (b) => (b.generic ? `spray body, ${b.model}` : `${b.brand} ${b.model}`);

  /** Every adjustable head fitted together (lib/arcs.js fitArcs): head to head, the most lawn, off the house and
      paving; a fixed pattern turned. `only`: just these heads, the rest as they are. Strips: autoSet. */
  function fitAll(only = null) {
    if (!cat || !ctx.groundAt) return;
    const list = [];
    for (const h of irr.heads) {
      const n = cat.nozzle(h.nozzle), w = n && waterOf(h);
      if (!w) continue;
      list.push({ id: h.id, at: h.at, zone: h.zone, radiusM: (w.fullRadiusFt ?? w.radiusFt) / FT_PER_M, nozzle: n, dir: h.dir, arc: arcOf(h, n), throw: h.throw ?? 1, fixed: h.arcSet === 'user' || (only && !only.has(h.id)) });
    }
    const fitted = fitArcs(list, ctx.groundAt, { only });
    for (const h of irr.heads) {
      const x = fitted.get(h.id);
      if (x) { const n = cat.nozzle(h.nozzle); h.dir = x.dir; if (!Number.isFinite(n.arcFixed)) h.arc = x.arc; h.throw = x.throw; h.arcSet = 'auto'; }
      else if (h.nozzle && h.arcSet !== 'user' && (!only || only.has(h.id))) autoSet(h);
    }
  }

  function headLine(h) {
    if (!h) return '';
    const b = cat?.body(h.body), n = cat?.nozzle(h.nozzle), w = waterOf(h);
    return `<span class="chip" style="background:${colorOf(h.zone)}"></span>${b ? esc(bodyName(b)) : 'no model'}${n ? ` · nozzle ${esc(n.label)}` : ''}${w ? ` · ${throwOf(w)} · ${w.gpm.toFixed(2)} gpm${Number.isFinite(w.inletPsi) ? ` at ${Math.round(w.inletPsi)} psi` : ''}${w.status === 'low' ? ' (under its chart: short throw)' : w.status === 'high' ? ' (over its chart: misting)' : ''}` : ''}`;
  }

  /* THE HEAD PICKER (owner, 2026-10-20: four sections; 2026-10-21: "let's simplify things. Remember that most
     homeowners only know what they can learn by looking at the actual head while it's installed"). Only what
     can be seen on a head in the ground:
       spray and rotary nozzles  what's on top; the nozzle, by the name printed on it; how high it pops up;
                                 whether the body is pressure-regulated. Nothing else about a spray body
                                 changes the water (lib/heads.js sprayBodyId).
       rotors and impact heads   the series on the cap (it decides the nozzles), a regulator if that series
                                 has one, the nozzle's number, how high it pops up.
     An adjustable arc is not asked: the arcs step fits it to the lawn. */
  const SECTIONS = [
    ['spray', 'A spray nozzle: a fan of fine spray, nothing turns'],
    ['rotary', 'A rotary nozzle on a spray head: thin streams that turn slowly (R-VAN, MP Rotator…)'],
    ['rotor', 'A gear rotor: a bigger head, one stream that turns quietly'],
    ['impact', 'An impact head: a stream and an arm that clicks as it turns'],
  ];
  /** Which section a body or a family belongs to. */
  const sectionOfFamily = (f) => (f.kind === 'rotary' && !/^rb-22sa/.test(f.id) ? 'rotary' : f.kind === 'impact' ? 'impact' : f.kind === 'rotor' || f.kind === 'rotary' ? 'rotor' : 'spray');
  const sectionOfBody = (b) => (b.kind === 'impact' ? 'impact' : b.kind === 'rotor' || b.kind === 'rotary-body' ? 'rotor' : 'spray');
  const onSprayBody = (type) => type === 'spray' || type === 'rotary';
  const form = { type: '', brand: '', series: '', nozzle: '', pop: '4', reg: '' };
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const nozzleLabel = (z) => `${z.label}${z.strip ? ` (${z.strip.widthFt} x ${z.strip.lengthFt} ft strip)` : Number.isFinite(z.arcFixed) ? ` (${z.arcFixed}°)` : Number.isFinite(z.arcMin) || Number.isFinite(z.arcMax) ? ` (adjustable ${z.arcMin ?? 0}-${z.arcMax ?? 360}°)` : ''}`;
  const popKey = (v) => (v === null || v === undefined ? 'riser' : String(v));
  const popLabel = (k) => (k === 'riser' ? "doesn't pop up (a shrub head on a riser)" : `${k} in${k === '4' ? ' (most lawns)' : ''}`);
  /** The rotors and impact heads of the chosen section, brand and series. */
  const seriesBodies = () => cat.bodies.filter((b) => !b.generic && sectionOfBody(b) === form.type && cat.charted(b) && (!form.brand || b.brand === form.brand) && (!form.series || seriesOf(b) === form.series));
  /** The body the answers point to. */
  function bodyFor() {
    if (onSprayBody(form.type)) return sprayBodyId(form.pop === 'riser' ? null : Number(form.pop), form.reg ? Number(form.reg) : null);
    const list = seriesBodies();
    if (!list.length) return '';
    const regOk = list.filter((b) => (form.reg ? Number.isFinite(b.regulatedPsi) : !Number.isFinite(b.regulatedPsi)));
    const pool = regOk.length ? regOk : list;
    const want = form.pop === 'riser' ? null : Number(form.pop);
    // the plain one of that height: no stainless stem or check valve, which change nothing here
    const plain = (b) => (/\b(SS|SAM|stainless)\b/i.test(b.model) ? 1 : 0);
    const dist = (b) => (b.popUpIn === want ? 0 : b.popUpIn === null || want === null ? 50 : Math.abs(b.popUpIn - want));
    return pool.slice().sort((a, b) => dist(a) - dist(b) || plain(a) - plain(b))[0].id;
  }
  /** The answers, read back from a head already given its model. */
  function formFrom(h) {
    const fam = cat.familyOfNozzle(h.nozzle), b = cat.body(h.body);
    form.type = fam ? sectionOfFamily(fam) : b ? sectionOfBody(b) : '';
    form.nozzle = h.nozzle || '';
    form.pop = popKey(b ? b.popUpIn : 4); form.reg = Number.isFinite(b?.regulatedPsi) ? String(b.regulatedPsi) : '';
    if (onSprayBody(form.type)) { form.brand = fam?.brand || ''; form.series = ''; }
    else { form.brand = b?.brand || ''; form.series = b ? seriesOf(b) : ''; }
  }
  function modelForm() {
    if (!cat) return '<p class="dim">Loading the list of heads…</p>';
    const first = head([...sel][0]);
    if (first && !form.type && first.nozzle) formFrom(first);
    const rows = [`<label>What's on top of the head when it runs?<select data-f="type" aria-label="Kind of head"><option value="">Choose…</option>${SECTIONS.map(([v, l]) => opt(v, l, form.type)).join('')}</select></label>`];
    if (onSprayBody(form.type)) {
      const fams = cat.families.filter((f) => sectionOfFamily(f) === form.type && f.nozzles.length && cat.body(sprayBodyId(4, null)).nozzleFamilies.includes(f.id));
      const brands = [...new Set(fams.map((f) => f.brand))].sort();
      rows.push(`<label>The nozzle's brand<select data-f="brand" aria-label="Nozzle brand"><option value="">Choose…</option>${brands.map((x) => opt(x, x, form.brand)).join('')}</select></label>`);
      if (form.brand) rows.push(`<label>The nozzle, by the name printed on its top${form.type === 'rotary' ? ' (an R-VAN24 says "R-VAN24")' : ' (a number and a letter or "VAN": 15-VAN, 12Q…)'}<select data-f="nozzle" aria-label="Nozzle"><option value="">Choose…</option>${fams.filter((f) => f.brand === form.brand).map((f) => `<optgroup label="${esc(f.name)}">${f.nozzles.map((z) => opt(z.id, nozzleLabel(z), form.nozzle)).join('')}</optgroup>`).join('')}</select></label>`);
      if (form.nozzle) {
        rows.push(`<label>How high it pops up<select data-f="pop">${SPRAY_POP_IN.map((v) => opt(popKey(v), popLabel(popKey(v)), form.pop)).join('')}</select></label>`);
        rows.push(`<label>Is the body pressure-regulated? Look on its cap or the side of the stem for "PRS", "PR", "P30", "P40" or "P45".<select data-f="reg"><option value="" ${form.reg ? '' : 'selected'}>No, or I can't tell</option>${SPRAY_REG_PSI.filter(Boolean).map((v) => opt(String(v), `Yes, ${v} psi (${v === 30 ? 'PRS, PR or P30' : v === 40 ? 'PRS40 or P40' : 'P45'})`, form.reg)).join('')}</select></label>`);
      }
    } else if (form.type) {
      const all = cat.bodies.filter((b) => !b.generic && sectionOfBody(b) === form.type && cat.charted(b));
      const brands = [...new Set(all.map((b) => b.brand))].sort();
      rows.push(`<label>Brand (on the cap)<select data-f="brand" aria-label="Brand"><option value="">Choose…</option>${brands.map((x) => opt(x, x, form.brand)).join('')}</select></label>`);
      if (form.brand) {
        const series = [...new Set(all.filter((b) => b.brand === form.brand).map(seriesOf))].sort();
        rows.push(`<label>Model (on the cap)<select data-f="series" aria-label="Model"><option value="">Choose…</option>${series.map((x) => opt(x, x, form.series)).join('')}</select></label>`);
      }
      if (form.series) {
        const list = seriesBodies(), regs = [...new Set(list.map((b) => b.regulatedPsi).filter(Number.isFinite))];
        if (regs.length) rows.push(`<label>Pressure-regulated? Look for "PRS" or "PRB" on the cap.<select data-f="reg"><option value="" ${form.reg ? '' : 'selected'}>No, or I can't tell</option>${regs.map((v) => opt(String(v), `Yes (${v} psi)`, form.reg)).join('')}</select></label>`);
        const b = cat.body(bodyFor());
        const fams = b ? cat.familiesFor(b.id) : [];
        rows.push(`<label>The nozzle, by the number on it (lift the head to read it)<select data-f="nozzle" aria-label="Nozzle"><option value="">Choose…</option>${fams.map((f) => `<optgroup label="${esc(f.name)}">${f.nozzles.map((z) => opt(z.id, nozzleLabel(z), form.nozzle)).join('')}</optgroup>`).join('')}</select></label>`);
        const pops = [...new Set(list.map((x) => popKey(x.popUpIn)))];
        if (pops.length > 1) rows.push(`<label>How high it pops up<select data-f="pop">${pops.map((k) => opt(k, popLabel(k), form.pop)).join('')}</select></label>`);
      }
    }
    const ready = form.nozzle && bodyFor() && cat.familiesFor(bodyFor()).some((f) => f.nozzles.some((z) => z.id === form.nozzle));
    return `<div class="tools picker" style="flex-direction:column;align-items:stretch">${rows.join('')}
      <button type="button" data-act="apply" ${ready ? '' : 'disabled'}>Give the ${sel.size} selected head${sel.size > 1 ? 's' : ''} this</button></div>`;
  }

  const WIRE = {
    intro: (P) => {
      P.querySelector('[data-act=start]').addEventListener('click', () => go('place'));
      P.querySelector('[data-act=none]').addEventListener('click', () => { irr.none = true; irr.done = true; changed(); finish(); });
    },
    place: (P) => {
      P.querySelectorAll('[name=pm]').forEach((r) => r.addEventListener('change', () => { placeMode = r.value; if (placeMode === 'gps') startGps(); else stopGps(); render(); }));
      P.querySelector('[data-act=undo]')?.addEventListener('click', () => { irr.heads.pop(); changed(); render(); });
      wireGps(P); wireGrid(P);
      wireNav(P, () => go('review'));
    },
    review: (P) => {
      P.querySelector('[data-act=remove]')?.addEventListener('click', () => { irr.heads = irr.heads.filter((h) => !sel.has(h.id)); sel.clear(); changed(); render(); });
      wireGrid(P);
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
        if (f === 'type') { form.brand = ''; form.series = ''; form.nozzle = ''; form.reg = ''; form.pop = '4'; }
        if (f === 'brand') { form.series = ''; form.nozzle = ''; }
        if (f === 'series') {
          form.nozzle = ''; form.reg = '';
          const pops = [...new Set(seriesBodies().map((x) => popKey(x.popUpIn)))];
          form.pop = pops.includes('4') ? '4' : pops[0] || '4';
          const fams = cat.familiesFor(bodyFor()), all = fams.flatMap((x) => x.nozzles);
          if (all.length === 1) form.nozzle = all[0].id; // a head with one built-in nozzle
        }
        // a regulated rotor can take its own charts (Rain Bird's 5000 PRS): a nozzle no longer on the list goes
        if (f === 'reg' && form.nozzle && !cat.familiesFor(bodyFor()).some((x) => x.nozzles.some((z) => z.id === form.nozzle))) form.nozzle = '';
        render();
      }));
      P.querySelector('[data-act=apply]')?.addEventListener('click', () => {
        const body = bodyFor();
        for (const id of sel) {
          const h = head(id);
          const was = h.nozzle;
          h.body = body; h.nozzle = form.nozzle;
          const n = cat.nozzle(h.nozzle);
          // an adjustable arc is fitted in the arcs step; a fixed pattern is the nozzle's
          if (was !== h.nozzle) { h.arc = null; if (h.arcSet !== 'user') h.arcSet = null; }
          h.dir = h.dir ?? facing(h.at, ctx.lawnMiddle());
          if (n && Number.isFinite(n.arcFixed) && n.arcFixed >= 360) h.dir = 0;
        }
        sel.clear(); resetForm(); changed(); render();
      });
      wireNav(P, () => go('details'));
    },
    details: (P) => wireNav(P, () => go('method')),
    method: (P) => {
      P.querySelectorAll('[name=method]').forEach((r) => r.addEventListener('change', () => { irr.method = r.value; changed(); render(); }));
      wireNav(P, () => go(MEASURED.has(irr.method) ? 'measure' : 'equipment'));
    },
    measure: (P) => {
      const h = sel.size === 1 ? head([...sel][0]) : null;
      // a head midway along the zone: the one nearest the middle of its heads
      P.querySelectorAll('[data-mzone]').forEach((b) => b.addEventListener('click', () => {
        const hs = irr.heads.filter((x) => x.zone === Number(b.dataset.mzone));
        if (!hs.length) return;
        const mid = hs.reduce((m, x) => [m[0] + x.at[0] / hs.length, m[1] + x.at[1] / hs.length], [0, 0]);
        const pick = hs.slice().sort((x, y) => Math.hypot(...enu(mid, x.at)) - Math.hypot(...enu(mid, y.at)))[0];
        sel.clear(); sel.add(pick.id); measureNote = ''; render();
      }));
      P.querySelector('[data-act=msave]')?.addEventListener('click', () => {
        const v = Number(P.querySelector('[data-act=mval]').value);
        if (!h || !Number.isFinite(v) || v <= 0) { measureNote = irr.method === 'throw' ? 'Enter how far it throws, in feet.' : 'Enter the reading in psi.'; render(); return; }
        if (irr.method === 'throw') h.throwFt = { ft: v, by: 'tape', at: Date.now() };
        else h.gauge = { psi: v, method: P.querySelector('[data-act=mmethod]').value, at: Date.now() };
        measureNote = ''; solvedKey = ''; changed(); render();
      });
      P.querySelector('[data-act=mdrop]')?.addEventListener('click', () => { if (h) { if (irr.method === 'throw') delete h.throwFt; else delete h.gauge; solvedKey = ''; changed(); render(); } });
      // GPS: the head's own spot, then where its water stops; the distance between two fixes taken minutes
      // apart (the phone's drift is mostly the same in both)
      P.querySelector('[data-act=gpshead]')?.addEventListener('click', () => { startGps(); listen(6000, (fixes) => { const p = settle(fixes); throwGps.head = p ? [p.lng, p.lat] : null; throwGps.id = h?.id; measureNote = p ? 'Now walk to where its water stops, at the far edge, and press the second button.' : 'No location came in.'; render(); }); });
      P.querySelector('[data-act=gpsedge]')?.addEventListener('click', () => { listen(6000, (fixes) => {
        const p = settle(fixes);
        if (!p || !throwGps.head || throwGps.id !== h?.id) { measureNote = 'Stand at the head first.'; render(); return; }
        const ft = Math.hypot(...enu(throwGps.head, [p.lng, p.lat])) * 3.2808;
        h.throwFt = { ft: +ft.toFixed(1), by: 'gps', at: Date.now() };
        measureNote = `GPS: ${ft.toFixed(0)} ft. A phone is good to a few feet, so a tape is better for a spray's short throw.`;
        throwGps.head = null; stopGps(); solvedKey = ''; changed(); render();
      }); });
      P.querySelector('[data-act=measuremore]')?.addEventListener('click', () => { measureAsk = false; render(); });
      P.querySelector('[data-act=borrow]')?.addEventListener('click', () => { measureAsk = false; irr.borrowOk = true; changed(); go('arcs'); });
      wireNav(P, () => {
        const thr = irr.method === 'throw';
        const missing = irr.zones.some((z) => irr.heads.some((x) => x.zone === z.n && x.nozzle) && !irr.heads.some((x) => x.zone === z.n && (thr ? x.throwFt : x.gauge)));
        if (missing && !irr.borrowOk) { measureAsk = true; render(); return; }
        go('arcs');
      });
    },
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
      P.querySelectorAll('[data-connect]').forEach((el) => el.addEventListener('change', () => { const z = irr.zones.find((x) => x.n === Number(el.dataset.connect)); z.connect = el.value; changed(); render(); }));
      wireNav(P, () => go('water'));
    },
    water: (P) => {
      const qy = irr.system.quality;
      P.querySelector('[data-act=hard]').addEventListener('change', (e) => { qy.hardness = e.target.value; changed(); render(); });
      P.querySelectorAll('[data-q]').forEach((el) => el.addEventListener('change', () => { qy[el.dataset.q] = el.checked; changed(); render(); }));
      wireNav(P, () => go('pressure'));
    },
    pressure: (P) => {
      const h = sel.size === 1 ? head([...sel][0]) : null;
      P.querySelector('[data-act=gsave]')?.addEventListener('click', async () => {
        const v = Number(P.querySelector('[data-act=gpsi]').value), method = P.querySelector('[data-act=gmethod]').value;
        if (!h || !Number.isFinite(v) || v < 0 || v > 200) { gaugeNote = 'Enter the reading in psi.'; render(); return; }
        const before = solvedHead(h.id), zs = solved?.zones.find((z) => z.res.heads.has(h.id));
        h.gauge = { psi: v, method, at: Date.now() };
        gaugeNote = 'Saving…'; changed(); render();
        gaugeNote = await keepReading(h, v, method, before, zs);
        render();
      });
      P.querySelector('[data-act=gdrop]')?.addEventListener('click', () => { if (h) { delete h.gauge; gaugeNote = ''; changed(); render(); } });
      wireNav(P, () => go('arcs'));
    },
    arcs: (P) => {
      const h = sel.size === 1 ? head([...sel][0]) : null;
      P.querySelector('[data-act=autoone]')?.addEventListener('click', () => { if (h) { h.arcSet = null; fitAll(new Set([h.id])); changed(); render(); } });
      P.querySelector('[data-act=autoall]')?.addEventListener('click', () => { for (const x of irr.heads) x.arcSet = null; fitAll(); changed(); render(); });
      P.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { showCover = b.dataset.show === 'cover'; sel.clear(); render(); }));
      P.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { coverView = b.dataset.view === 'all' ? 'all' : Number(b.dataset.view); render(); }));
      wireNav(P, () => go('fixes'));
    },
    fixes: (P) => {
      P.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { showCover = b.dataset.show === 'cover'; render(); }));
      P.querySelectorAll('[data-fixshow]').forEach((b) => b.addEventListener('click', () => {
        const f = fixList()[Number(b.dataset.fixshow)];
        sel.clear(); for (const id of f?.heads || []) sel.add(id); fixPicked = Number(b.dataset.fixshow); render();
      }));
      P.querySelectorAll('[data-fixgo]').forEach((b) => b.addEventListener('click', () => {
        const f = fixList()[Number(b.dataset.fixgo)];
        if (!f) return;
        const ids = f.heads.slice();
        if (f.fix === 'arc') { go('arcs'); sel.clear(); if (ids[0]) sel.add(ids[0]); render(); }
        else { go('models'); sel.clear(); for (const id of ids) sel.add(id); resetForm(); render(); }
      }));
      wireNav(P, () => go('schedule'));
    },
    schedule: (P) => {
      P.querySelector('[data-act=schedagain]')?.addEventListener('click', () => { sched.key = ''; buildSchedule(); });
      wireNav(P, () => { irr.done = true; irr.none = false; changed(); finish(); });
    },
  };
  const resetForm = () => { form.type = ''; form.brand = ''; form.series = ''; form.nozzle = ''; form.pop = '4'; form.reg = ''; };

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
      // kept with the map, so a reload within the hour carries on placing without standing on the spot again
      irr.gpsCal = { offset: gps.cal.offset, ref: gps.cal.ref, offsetM: gps.cal.offsetM, jitterM: gps.cal.jitterM, n: gps.cal.n, at: gps.cal.at };
      gps.phase = 'walk'; changed(); render();
    }));
    P.querySelector('[data-act=repick]')?.addEventListener('click', () => { gps.phase = 'pick'; gps.ref = null; render(); });
    P.querySelector('[data-act=recal]')?.addEventListener('click', () => { gps.phase = 'pick'; gps.ref = null; gps.cal = null; render(); });
    P.querySelector('[data-act=drop]')?.addEventListener('click', () => listen(5000, (fixes) => {
      const p = placeByGps(fixes, gps.cal);
      if (!p) { alert('No location came in.'); return; }
      add(p.at, { by: 'gps', spreadM: +p.spreadM.toFixed(2) });
    }));
  }
  const CAL_KEEP_MS = 60 * 60 * 1000; // a calibration is trusted for an hour: satellites and the phone drift
  function startGps() {
    if (gps.watch !== null || !('geolocation' in navigator)) return;
    const kept = irr.gpsCal;
    if (!gps.cal && kept?.offset && Date.now() - (kept.at || 0) < CAL_KEEP_MS) gps.cal = { ...kept };
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

  /** The snap-to-grid checkbox and spacing (taps and drags; a GPS fix is placed where it was measured). */
  function gridControls() {
    const g = irr.grid;
    const where = g.origin ? (Number.isFinite(g.bearing) ? "through the first head, along the lawn's longest straight edge in its sight" : 'through the first head (no traced lawn edge to line it up with: north-south)') : 'made when you place the first head, through it';
    return `<div class="tools"><label class="toggle"><input type="checkbox" data-act="snap" ${g.on ? 'checked' : ''}> Snap to a grid</label>
      <label class="toggle">every <input type="number" data-act="gridft" min="${GRID_FT_MIN}" max="${GRID_FT_MAX}" step="0.5" value="${g.ft}" style="width:64px;padding:6px;font-size:16px"> ft</label></div>
      ${g.on ? `<p class="dim">The grid: ${where}.</p>` : ''}`;
  }
  function wireGrid(P) {
    P.querySelector('[data-act=snap]')?.addEventListener('change', (e) => { irr.grid.on = e.target.checked; changed(); render(); });
    P.querySelector('[data-act=gridft]')?.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      irr.grid.ft = Number.isFinite(v) ? Math.max(GRID_FT_MIN, Math.min(GRID_FT_MAX, Math.round(v * 2) / 2)) : GRID_FT_DEFAULT;
      changed(); render();
    });
  }
  /** A tapped or dragged point on the grid, when it is on. */
  const snapped = (at) => (irr.grid?.on && irr.grid.origin ? snapToGrid(at, irr.grid) : at);
  /** The grid, made through the first head placed. */
  function gridFrom(at) {
    const g = irr.grid;
    if (g.origin) return;
    g.origin = at.map((v) => +v.toFixed(7));
    const edge = longestEdgeInSight(ctx.lawnRings?.() || [], at);
    g.bearing = edge ? +edge.bearing.toFixed(2) : null;
  }

  function add(at, extra = {}) {
    if (!irr.grid) irr.grid = emptyGrid();
    if (irr.grid.origin && extra.by !== 'gps') at = snapped(at);
    else if (!irr.grid.origin) gridFrom(at);
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
    if (['details', 'review', 'pressure', 'lines', 'equipment', 'supply', 'water', 'arcs', 'measure'].includes(step)) { sel.clear(); sel.add(h.id); measureNote = ''; }
    else if (sel.has(h.id)) sel.delete(h.id); else sel.add(h.id);
    if (step === 'models') { if (sel.size === 1) { resetForm(); } }
    render();
    return true;
  }
  /* THE ARC'S HANDLES (owner, 2026-10-21: "they can drag the edges of the arc to adjust it (tap the head to
     adjust the arc, so there's not overlapping drag handles)"): on the one selected head only, a white dot at
     each edge of its arc (one, for a full circle or a strip) and a yellow square at the end of its throw. */
  const deg = (r) => (r * 180) / Math.PI, mod360 = (a) => ((a % 360) + 360) % 360;
  function handles(h) {
    const n = cat?.nozzle(h?.nozzle), w = h && waterOf(h);
    if (!n || !w) return null;
    const [x, y] = ctx.toPx(h.at), full = ((w.fullRadiusFt ?? w.radiusFt) / 3.281) * ctx.pxPerM(), R = (w.radiusFt / 3.281) * ctx.pxPerM(), dir = h.dir ?? 0;
    const at = (a, r) => [x + Math.sin((a * Math.PI) / 180) * r, y - Math.cos((a * Math.PI) / 180) * r];
    const out = { centre: [x, y], full, R, t: at(dir, R) };
    if (n.strip) { out.a = at(dir, R); out.t = null; return out; }
    const arc = arcOf(h, n);
    if (Number.isFinite(n.arcFixed) && n.arcFixed >= 360) return out;
    out.a = at(dir - arc / 2, R);
    if (arc < 359) out.b = at(dir + arc / 2, R);
    if (arc >= 359) out.t = at(dir + 180 + 30, R); // clear of the edge dot
    return out;
  }
  /* DRAGGING (owner, 2026-10-23: "dragging the arc is pretty jittery/laggy ... when dragging an arc to its
     minimum or maximum, it should stop at its minimum/maximum rather than loop back around"). The handle
     follows how far the finger has turned round the head since it took hold (unwrapped, so passing north or
     the other edge never jumps the arc round), from the arc and facing it had then; the arc stops at the
     nozzle's least and greatest, and resumes when the finger comes back within them. Rounded when let go. */
  const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const fingerAngle = (ev, [x, y]) => { const [px, py] = ctx.tapPx(ev); return mod360(deg(Math.atan2(px - x, -(py - y)))); };
  function dragArc(ev) {
    const h = head(arcDrag.id), n = cat.nozzle(h.nozzle), hs = handles(h);
    if (!hs) return;
    if (arcDrag.which === 't') {
      const [px, py] = ctx.tapPx(ev), [x, y] = hs.centre;
      h.throw = Math.max(MIN_THROW, Math.min(1, Math.hypot(px - x, py - y) / hs.full));
      return;
    }
    const theta = fingerAngle(ev, hs.centre);
    arcDrag.turn += wrap180(theta - arcDrag.last); arcDrag.last = theta;
    const d0 = arcDrag.dir0, a0 = arcDrag.arc0, turn = arcDrag.turn;
    // a strip or a fixed pattern turns as a whole
    if (n.strip || Number.isFinite(n.arcFixed)) { h.dir = mod360(d0 + turn); return; }
    const lo = Math.max(BIN_DEG, n.arcMin ?? 0), hi = Math.min(360, n.arcMax ?? 360);
    const clamp = (a) => Math.max(lo, Math.min(hi, a));
    if (arcDrag.which === 'a') {
      // the left edge follows the finger (turning it clockwise closes the arc); the right edge stays
      const end = d0 + a0 / 2, a2 = clamp(a0 - turn);
      h.arc = a2; h.dir = mod360(end - a2 / 2);
    } else {
      const begin = d0 - a0 / 2, a2 = clamp(a0 + turn);
      h.arc = a2; h.dir = mod360(begin + a2 / 2);
    }
  }
  let frame = 0;
  /** One redraw a screen frame, however many moves the finger sends. */
  const drawSoon = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; ctx.draw(); }); };

  /** A finger down on a head in the review step starts dragging it (not the map); in the arcs step, on one
      of the selected head's handles, that handle. */
  function grab(ev) {
    if (step === 'arcs') {
      if (arcPhase !== 'ready' || showCover) return false;
      const h = sel.size === 1 ? head([...sel][0]) : null, hs = h && handles(h);
      if (!hs) return false;
      const [x, y] = ctx.tapPx(ev), lim = 22 * ctx.cssScale();
      let best = null, bd = lim;
      for (const k of ['a', 'b', 't']) if (hs[k]) { const d = Math.hypot(hs[k][0] - x, hs[k][1] - y); if (d < bd) { bd = d; best = k; } }
      if (!best) return false;
      arcDrag = { id: h.id, which: best, dir0: h.dir ?? 0, arc0: arcOf(h, cat.nozzle(h.nozzle)), last: fingerAngle(ev, hs.centre), turn: 0 }; dragged = false;
      return true;
    }
    if (step !== 'review') return false;
    const h = nearest(ev, 22);
    if (!h) return false;
    drag = h.id; dragged = false; sel.clear(); sel.add(h.id);
    return true;
  }
  function move(ev) {
    if (arcDrag) { dragArc(ev); dragged = true; drawSoon(); return true; }
    if (!drag) return false;
    head(drag).at = snapped(ctx.toLngLat(ctx.tapPx(ev))).map((v) => +v.toFixed(7));
    dragged = true; drawSoon();
    return true;
  }
  function drop() {
    if (arcDrag) {
      const h = head(arcDrag.id), was = arcDrag;
      arcDrag = null;
      if (dragged && h) {
        // rounded with the edge that was not dragged kept where it was (to half a degree)
        const n = cat.nozzle(h.nozzle), which = was.which;
        if (Number.isFinite(h.arc) && n && !n.strip && !Number.isFinite(n.arcFixed) && (which === 'a' || which === 'b')) {
          const keep = which === 'a' ? h.dir + h.arc / 2 : h.dir - h.arc / 2;
          h.arc = Math.round(h.arc); h.dir = Math.round(mod360(which === 'a' ? keep - h.arc / 2 : keep + h.arc / 2) * 2) / 2;
        } else if (Number.isFinite(h.dir)) h.dir = Math.round(mod360(h.dir) * 2) / 2;
        if (Number.isFinite(h.throw)) h.throw = +h.throw.toFixed(2);
        h.arcSet = 'user'; changed();
      }
      render(); return true;
    }
    if (!drag) return false;
    drag = null;
    if (dragged) changed();
    render();
    return true;
  }

  /** The grid's lines over the lawn (every line while they are 6 screen px apart or more; else every few). */
  function drawGrid(g, px) {
    const gr = irr.grid, box = ctx.lawnBox?.();
    if (!box) return;
    const s = gr.ft / 3.2808, t = ((gr.bearing || 0) * Math.PI) / 180;
    const corners = [[box[0][0], box[0][1]], [box[1][0], box[0][1]], [box[1][0], box[1][1]], [box[0][0], box[1][1]]].map((c) => enu(gr.origin, c));
    const uv = corners.map(([e, n]) => [e * Math.sin(t) + n * Math.cos(t), e * Math.cos(t) - n * Math.sin(t)]);
    const pad = 3;
    const u0 = Math.min(...uv.map((q) => q[0])) - pad, u1 = Math.max(...uv.map((q) => q[0])) + pad, v0 = Math.min(...uv.map((q) => q[1])) - pad, v1 = Math.max(...uv.map((q) => q[1])) + pad;
    const toAt = (u, v) => unEnu(gr.origin, [u * Math.sin(t) + v * Math.cos(t), u * Math.cos(t) - v * Math.sin(t)]);
    const every = Math.max(1, Math.ceil((6 * px) / (s * ctx.pxPerM())));
    g.save(); g.lineWidth = px * 0.6;
    for (const [lo, hi, other0, other1, along] of [[u0, u1, v0, v1, true], [v0, v1, u0, u1, false]]) {
      for (let k = Math.ceil(lo / s); k * s <= hi; k++) {
        if (k % every) continue;
        const c = k * s, a = along ? toAt(c, other0) : toAt(other0, c), b = along ? toAt(c, other1) : toAt(other1, c);
        g.strokeStyle = k === 0 ? 'rgba(255,235,59,.8)' : 'rgba(255,255,255,.28)';
        g.beginPath(); g.moveTo(...ctx.toPx(a)); g.lineTo(...ctx.toPx(b)); g.stroke();
      }
    }
    g.restore();
  }

  /** A green check in a white-edged disc, centred at (cx, cy). */
  function check(g, cx, cy, cr, px) {
    g.save();
    g.fillStyle = '#2e7d32'; g.strokeStyle = '#fff'; g.lineWidth = px * 1.2;
    g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.fill(); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = px * 1.8; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(cx - cr * 0.5, cy + cr * 0.02); g.lineTo(cx - cr * 0.12, cy + cr * 0.42); g.lineTo(cx + cr * 0.52, cy - cr * 0.38); g.stroke();
    g.restore();
  }
  /** A head as its zone's colour with the zone's number in it and, when its pressure is shown, a ring of the
      pressure's colour outside a black line (owner, 2026-10-23: "a colored edge around the dot with a black line
      separating it... So that you can display both the zone number and the pressure indicator"). -> the outer
      radius drawn */
  function numberedDot(g, h, x, y, px, on) {
    const sh = shownHead(h.id), R0 = 8 * px * (on ? 1.2 : 1), line = 1.3 * px, ring = 3.4 * px;
    const Ro = sh ? R0 + line + ring : R0 + line;
    g.save();
    g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, Ro + (sh ? 0.8 * px : 0), 0, 7); g.fill();
    if (sh) {
      g.fillStyle = STATUS_COLOR[sh.water?.status] || '#9e9e9e'; g.beginPath(); g.arc(x, y, Ro, 0, 7); g.fill();
      g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, R0 + line, 0, 7); g.fill();
    }
    g.fillStyle = colorOf(h.zone); g.beginPath(); g.arc(x, y, R0, 0, 7); g.fill();
    if (on) { g.strokeStyle = '#ffeb3b'; g.lineWidth = 2.4 * px; g.beginPath(); g.arc(x, y, Ro + 2.4 * px, 0, 7); g.stroke(); }
    if (h.zone) {
      g.font = `800 ${Math.round(R0 * 1.3)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 2.6 * px; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineJoin = 'round';
      g.strokeText(String(h.zone), x, y + 0.5 * px); g.fillStyle = '#fff'; g.fillText(String(h.zone), x, y + 0.5 * px);
    }
    g.restore();
    return Ro + (on ? 3.6 * px : 0);
  }

  /** What this step draws over the photo. g: the canvas; lw: the page's line width. */
  function drawOn(g, lw) {
    const showAll = !!step || irr.done;
    if (!showAll || irr.none) return;
    // sized on the screen, not the photo: the same on a phone at any zoom
    const px = ctx.cssScale(), r = 6 * px;
    lw = 2 * px;
    if ((step === 'place' || step === 'review') && irr.grid?.on && irr.grid.origin) drawGrid(g, px);
    const arcsUp = (step === 'arcs' && arcPhase === 'ready') || step === 'fixes';
    if ((arcsUp && showCover) || (!step && irr.done && ctx.showCoverage?.())) drawCoverage(g);
    // each valve's lawn, in the schedule step
    if (step === 'schedule') drawValveLawn(g);
    // the fans only once the arcs are fitted
    const fans = (arcsUp && !showCover) || (!step && irr.done && !ctx.showCoverage?.());
    if (fans && cat) for (const h of irr.heads) {
      const w = waterOf(h);
      if (!w) continue;
      const [x, y] = ctx.toPx(h.at), R = (w.radiusFt / 3.281) * ctx.pxPerM();
      const mid = ((h.dir ?? 0) - 90) * (Math.PI / 180);
      const picked = (step === 'arcs' || step === 'fixes') && sel.has(h.id), strong = step === 'arcs' || step === 'fixes';
      g.fillStyle = `${colorOf(h.zone)}${picked ? '66' : strong ? '40' : '26'}`; g.strokeStyle = picked ? '#ffeb3b' : `${colorOf(h.zone)}${strong ? 'ee' : '99'}`; g.lineWidth = picked ? lw * 1.5 : strong ? lw * 0.9 : lw * 0.5;
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
        if (!z.tree) continue; // measured at the heads: no pipe is laid out
        const box = z.tree.nodes[0].at;
        // the supply line, backflow preventer to valve box
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = px * 4; g.setLineDash([px * 6, px * 4]);
        const mainPts = z.main && z.main.length > 1 ? [sys.pvb.at, ...z.main, box] : [sys.pvb.at, box];
        g.beginPath(); mainPts.forEach((q, k) => (k ? g.lineTo(...ctx.toPx(q)) : g.moveTo(...ctx.toPx(q)))); g.stroke(); g.setLineDash([]);
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
    const s1 = step === 'measure' ? solve() : s0;
    const byPressure = (step === 'pressure' && s0) || (step === 'measure' && s1);
    let labelUp = r * 1.5;
    for (const h of irr.heads) {
      const [x, y] = ctx.toPx(h.at);
      if (byPressure) {
        // the zone's colour and number, the pressure as a ring round it (owner, 2026-10-23), a check if measured
        const Ro = numberedDot(g, h, x, y, px, sel.has(h.id));
        labelUp = Math.max(labelUp, Ro + 2 * px);
        if (measuredHere(h)) check(g, x + Ro * 0.85, y - Ro * 0.85, r * 0.95, px);
        continue;
      }
      g.fillStyle = colorOf(h.zone); g.strokeStyle = sel.has(h.id) ? '#ffeb3b' : '#000'; g.lineWidth = sel.has(h.id) ? lw * 1.2 : lw * 0.6;
      g.beginPath(); g.arc(x, y, sel.has(h.id) ? r * 1.4 : r, 0, 7); g.fill(); g.stroke();
      // choosing models: a check beside each head that has its nozzle (owner, 2026-10-21)
      if (step === 'models' && h.nozzle) check(g, x + r * 1.9, y - r * 1.5, r * 0.95, px);
    }
    // the selected head's handles, in the arcs step
    if (step === 'arcs' && arcsUp && !showCover && sel.size === 1) {
      const hs = handles(head([...sel][0]));
      if (hs) {
        for (const k of ['a', 'b']) if (hs[k]) {
          g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = lw;
          g.beginPath(); g.arc(hs[k][0], hs[k][1], r * 1.7, 0, 7); g.fill(); g.stroke();
        }
        if (hs.t) { const a = r * 1.4; g.fillStyle = '#ffeb3b'; g.strokeStyle = '#000'; g.lineWidth = lw; g.fillRect(hs.t[0] - a, hs.t[1] - a, a * 2, a * 2); g.strokeRect(hs.t[0] - a, hs.t[1] - a, a * 2, a * 2); }
      }
    }
    // the pressure over each head, where it has room
    if (byPressure) {
      const fs = 11 * px, boxes = [];
      g.font = `700 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      for (const h of irr.heads) {
        const sh = shownHead(h.id);
        if (!sh) continue;
        const t = `${Math.round(sh.psi)} psi`, [x, y] = ctx.toPx(h.at), w0 = g.measureText(t).width, bx = [x - w0 / 2, y - labelUp - fs, x + w0 / 2, y - labelUp];
        if (boxes.some((d) => bx[0] < d[2] && bx[2] > d[0] && bx[1] < d[3] && bx[3] > d[1])) continue;
        boxes.push(bx);
        g.lineWidth = fs / 4; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(t, x, y - labelUp); g.fillStyle = '#fff'; g.fillText(t, x, y - labelUp);
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
        const lines = [b ? bodyName(b) : '?', n && w ? `${n.label} · ${throwOf(w)} · ${w.gpm.toFixed(2)} gpm` : 'no nozzle'];
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
    // what could be better: each numbered where it is
    if (step === 'fixes') {
      const fs = 12 * px;
      fixList().forEach((f, k) => {
        if (!f.at) return;
        const [x, y] = ctx.toPx(f.at), on = fixPicked === k, R = (on ? 11 : 9) * px;
        const yy = f.kind === 'missed' || f.kind === 'dry' ? y : y - 16 * px; // over a head, clear of its dot
        g.save();
        g.fillStyle = on ? '#ffeb3b' : '#fff'; g.strokeStyle = f.kind === 'missed' || f.kind === 'dry' ? '#d32f2f' : '#000'; g.lineWidth = 2.4 * px;
        g.beginPath(); g.arc(x, yy, R, 0, 7); g.fill(); g.stroke();
        g.fillStyle = '#000'; g.font = `800 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(k + 1), x, yy + 0.5 * px);
        g.restore();
      });
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
      irr.grid = { ...emptyGrid(), ...(irr.grid || {}) };
      if (!irr.grid.origin && irr.heads.length) gridFrom(irr.heads[0].at);
      const old = pipeById(irr.supply?.pipe);
      if (old && !irr.system?.supplyLine?.migrated) { irr.system.supplyLine = { ...irr.system.supplyLine, family: old.family, size: old.nominal, migrated: true }; }
      for (const z of irr.zones) if (z.line && !z.family) { const p0 = pipeById(z.line); if (p0 && LINE_FAMILIES.includes(p0.family)) { z.family = p0.family; z.size = p0.nominal; } }
      let resumeAt = null;
      if (irr.v < 2 && irr.done && !irr.none) { irr.v = 2; irr.done = false; resumeAt = 'equipment'; } // the new steps still to do
      await loadDevices;
      await loadCat;
      if (irr.done && !force) { step = null; render(); return false; }
      const savedStep = !irr.done && stepsFor(irr.method).includes(irr.step) ? irr.step : null;
      // a map saved on the old last step, the coverage, comes back on the arcs
      const was = !irr.done && irr.step === 'coverage' ? 'arcs' : savedStep;
      step = resumeAt || (force && irr.heads.length ? 'review' : was || 'intro');
      if (step === 'arcs' || step === 'fixes') startArcs();
      if (step === 'schedule') buildSchedule();
      render();
      return true;
    },
    get active() { return !!step; },
    get data() { return irr; },
    tap, grab, move, drop, drawOn,
    /** The ground came in (or anything the solve reads): solve again and show it. */
    refresh() { solvedKey = ''; if ((step === 'arcs' || step === 'fixes') && arcPhase === 'waiting') startArcs({ refit: true }); if (step === 'schedule' && sched.state !== 'ready') buildSchedule(); if (step) render(); else ctx.draw(); },
    /** The watering plan came in (the soil and the weather): the schedule step can go on. */
    planIn() { if (step === 'schedule' && sched.state !== 'ready' && sched.state !== 'working') buildSchedule(); },
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
