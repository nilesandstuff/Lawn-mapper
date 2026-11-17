/**
 * WHAT IS BEHIND ONE SPOT'S PREDICTION (owner, 2026-11-17: "the readings, the specific factors/values contributing to
 * the models predictions, and what the model ultimately predicts the reading should be"; first for the administrator
 * on the measurements page, later the same view in the public map -- TODO 30). Pure: numbers in, a prediction and its
 * factors out, in groups, each value tagged with its kind so the page formats it (degrees F or C, W/m2, a share...)
 * and the public view can reuse every word. The page never works a number out itself.
 *
 *   -> { view, label, value, kind, groups: [{ title, note?, rows: [{ label, v, kind, note? }] }] }
 *   kinds: temp (C), dtemp (a difference, C), flux (W/m2), share (0-1), speed (m/s), mm, cm, m, deg, num, text
 */

const row = (label, v, kind, note) => ({ label, v: Number.isFinite(v) || typeof v === 'string' ? v : null, kind, ...(note ? { note } : {}) });
const TEXTURE = (t) => (t && Number.isFinite(t.sand) && Number.isFinite(t.clay) ? `${Math.round(t.sand)}% sand, ${Math.round(t.clay)}% clay` : 'not in the survey (a loam taken)');

/** The sky, sun and air of a moment (surfacenow.js momentOf), shared by every view of that moment. */
export function momentGroup(w, { airFrom = null, cloudFrom = null } = {}) {
  if (!w) return null;
  return { title: 'The moment', rows: [
    row('Air temperature', w.ta, 'temp', airFrom || undefined),
    row('Humidity', Number.isFinite(w.rh) ? w.rh / 100 : null, 'share'),
    row('Open wind at 2 m', w.wind, 'speed', 'the station or model, before any shelter'),
    row('Sun above the horizon', w.el, 'deg'),
    row('Sunshine on open ground', w.ghi, 'flux', w.ghi > 0 ? (w.clear > 0 ? `${Math.round((100 * w.ghi) / w.clear)}% of a clear sky` : undefined) : undefined),
    row('Of it, the direct beam', w.beam, 'flux'),
    row('Cloud', w.cloud, 'share', cloudFrom || w.cloudFrom || undefined),
    row('Longwave from the sky', w.lsky, 'flux', 'what a clear or cloudy sky sends down'),
  ] };
}

/**
 * THE GRASS SURFACE AT A MOMENT (surfacenow.js forcingAt, soiltemp.js stepColumn / skinParts).
 * a: { ts, t1, f (forcingAt's), parts (skinParts'), w, beam, ks, skyView, shelter, column: [C per layer], centres: [m],
 *      props: [{ lambda, C }], texture, rootCm, full, shadeWeeks (mean beam share over the spin-up's daylight),
 *      v1 (version 1's ts), reading (C), airFrom, cloudFrom, soilFrom }
 */
export function surfaceExplain(a) {
  const f = a.f || {}, p = a.parts || {};
  const groups = [
    momentGroup(a.w, { airFrom: a.airFrom, cloudFrom: a.cloudFrom }),
    { title: 'This spot', rows: [
      row('Direct sun reaching the grass', a.beam, 'share', 'through the trees and past the buildings, at this minute (the shade map\'s ray tracing)'),
      row('Sky the grass sees', a.skyView, 'share', 'the rest is trees, walls and fences, near the air\'s temperature'),
      row('Sunlight absorbed', f.swNet, 'flux'),
      row('Air here, after the trees\' cooling', f.ta, 'temp', Number.isFinite(f.air) && Math.abs(f.air) > 0.01 ? `the canopy cools it ${Math.abs(f.air).toFixed(1)} C` : undefined),
      row('Wind here', f.u2, 'speed', Number.isFinite(a.shelter) ? `${Math.round(a.shelter * 100)}% of the open wind (shelter)` : undefined),
      row('Water held back from evaporating (Ks)', a.ks, 'share', '1 = the grass has all it wants'),
    ] },
    { title: 'The energy at the surface', note: 'Positive in, by the grass surface; these balance.', rows: [
      row('Net radiation', p.rn, 'flux', 'sunlight absorbed plus the sky\'s longwave, less what the grass gives off'),
      row('Into the soil', p.g, 'flux', 'through the turf to the top layer'),
      row('To the air', p.h, 'flux', 'warmer grass than air heats it'),
      row('To evaporation', p.le, 'flux', 'the grass\'s water use cooling it'),
      row('Sunlight straight to the soil', p.swSoil, 'flux', 'through gaps in the turf'),
      row('Fences warming it', f.fence, 'flux'),
      row('Paving nearby', f.paving, 'flux'),
    ] },
  ];
  if (a.column) groups.push(soilGroup(a));
  return { view: 'surface', label: 'Surface temperature', value: a.ts, kind: 'temp', reading: a.reading ?? null,
    others: Number.isFinite(a.v1) ? [{ label: 'Version 1 (no heat stored in the ground)', v: a.v1, kind: 'temp' }] : [], groups: groups.filter(Boolean) };
}

/** The column under a spot, layer by layer. */
function soilGroup(a) {
  const rows = [row('Soil', TEXTURE(a.texture), 'text'), row('Roots reach', a.rootCm, 'cm'), row('Root zone water', a.full, 'share', '1 = field capacity'),
    row('Direct sun over the weeks before', a.shadeWeeks, 'share', 'its daylight average: a spot shaded for weeks has colder soil')];
  (a.column || []).forEach((t, k) => rows.push(row(`${Math.round(a.centres[k] * 100)} cm down`, t, 'temp', a.props?.[k] ? `conducts ${a.props[k].lambda.toFixed(2)} W/m/K, holds ${(a.props[k].C / 1e6).toFixed(2)} MJ/m3/K` : undefined)));
  if (Number.isFinite(a.tBottom)) rows.push(row('Held at 1.5 m', a.tBottom, 'temp', 'the year\'s soil wave for the area, damped to that depth'));
  return { title: 'The soil underneath', note: a.soilFrom || undefined, rows };
}

/** THE SOIL'S TEMPERATURE AT A DEPTH, at a moment. a: as surfaceExplain's, plus depthCm, value (C at that depth). */
export function soilExplain(a) {
  return { view: 'soil', label: `Soil temperature at ${Math.round(a.depthCm / 2.54)} in`, value: a.value, kind: 'temp', reading: a.reading ?? null, others: [{ label: 'Grass surface', v: a.ts, kind: 'temp' }],
    groups: [momentGroup(a.w, { airFrom: a.airFrom, cloudFrom: a.cloudFrom }), soilGroup(a), { title: 'At the surface above', rows: [row('Into the soil now', a.parts?.g, 'flux'), row('Direct sun reaching the grass now', a.beam, 'share')] }].filter(Boolean) };
}

/** THE WIND AT 2 M AT A SPOT. a: { w, u2, shelter, month, open (the open wind, m/s), ra, reading } */
export function windExplain(a) {
  return { view: 'wind', label: 'Wind at 2 m', value: a.u2, kind: 'speed', reading: a.reading ?? null, others: [],
    groups: [momentGroup(a.w, { airFrom: a.airFrom, cloudFrom: a.cloudFrom }), { title: 'This spot', rows: [
      row('Open wind', a.open, 'speed', 'the airport station or the weather model, at 2 m'),
      row('Share reaching this spot', a.shelter, 'share', 'from the heights of the trees, buildings and fences round it by direction, this month (lib/shelter.js)'),
      row('Wind here', a.u2, 'speed'),
      row('Air resistance over the grass', a.ra, 'num', 's/m: the stiller the air, the more the grass\'s own temperature can stray from the air\'s'),
    ] }].filter(Boolean) };
}

/**
 * THE ROOT ZONE'S WATER ON A DATE (balance.js simulate, rain alone). a: { wet (share of the roots' water, 1 full),
 *   taw, raw, rootCm, texture, Dr, grav, pond, ks, week: { rain, et0, et, drained, ranOff, rose } (mm over the days
 *   before), etFactor, light, days, reading, unit }
 */
export function moistureExplain(a) {
  const wk = a.week || {};
  return { view: 'moisture', label: 'Root zone water', value: a.wet, kind: 'share', reading: a.reading ?? null, readingUnit: a.unit || null, others: [],
    groups: [
      { title: 'This spot\'s soil', rows: [row('Soil', TEXTURE(a.texture), 'text'), row('Roots reach', a.rootCm, 'cm'), row('Water the roots can use when full', a.taw, 'mm'),
        row('Used before the grass is short', a.raw, 'mm', 'past this the grass holds back (Ks below 1)')] },
      { title: 'That day', rows: [row('Short of full by', a.Dr, 'mm'), row('Extra water draining through', a.grav, 'mm'), row('Standing on the surface', a.pond, 'mm'),
        row('Ks (how freely it uses water)', a.ks, 'share')] },
      { title: `The ${a.days || 7} days before`, rows: [row('Rain', wk.rain, 'mm', 'PRISM\'s, else the station\'s; no watering is assumed'),
        row('Reference evaporation (ET0)', wk.et0, 'mm'), row('This spot\'s water-use factor', a.etFactor, 'num', 'its sun, shade, wind and heat against an open lawn'),
        row('Used by the grass', wk.et, 'mm'), row('Drained below the roots', wk.drained, 'mm'), row('Ran off', wk.ranOff, 'mm'), row('Risen from the water table', wk.rose, 'mm'),
        row('Light this month', a.light, 'share', 'its sunlight against an open lawn')] },
    ] };
}

/** Degrees and the rest, for the page: C in, the person's units out. */
export function fmt(v, kind, { f = true } = {}) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'string') return v;
  switch (kind) {
    case 'temp': return f ? `${(v * 1.8 + 32).toFixed(1)} °F` : `${v.toFixed(1)} °C`;
    case 'dtemp': return f ? `${v * 1.8 > 0 ? '+' : ''}${(v * 1.8).toFixed(1)} °F` : `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`;
    case 'flux': return `${Math.round(v)} W/m²`;
    case 'share': return `${Math.round(v * 100)}%`;
    case 'speed': return f ? `${(v * 2.237).toFixed(1)} mph` : `${v.toFixed(1)} m/s`;
    case 'mm': return f ? `${(v / 25.4).toFixed(2)} in` : `${v.toFixed(1)} mm`;
    case 'cm': return f ? `${(v / 2.54).toFixed(0)} in` : `${Math.round(v)} cm`;
    case 'deg': return `${Math.round(v)}°`;
    default: return Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2);
  }
}
