/**
 * STEP 4, WHICH GRASS: the grass.js verdicts written out for the lawn --
 * the climate's kind of grass, each species' share of the lawn by the
 * season-average light the shade map worked out (light-worker.js season),
 * and when to plant.
 */

import { climateZone, grassBands, plantingWindow } from './grass.js';
import { growingSeason, dayLabel } from './climate.js';

const SQFT = 10.7639;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The lawn's points' season-average light, mol/m2/day, from the worker's season message. */
export function lawnLight(se) {
  if (!se?.mean) return [];
  const out = [];
  for (let p = 0; p < se.mean.length; p++) if (!se.inMask || se.inMask[p]) out.push(se.mean[p]);
  return out;
}

/**
 * Write the step into `el`. `season` is the worker's season message (null
 * while it is being worked out), `climate` the /api/shade/climate answer,
 * `hasLawn` whether a lawn was traced (else the lot stands in for it).
 */
export function renderGrass(el, { season, climate, hasLawn, grassKind = null }) {
  if (!climate?.tMean) { el.innerHTML = '<p class="warn">The weather here could not be read, so the grass cannot be matched to the climate. The shade map above still stands.</p>'; return; }
  const zone = climateZone(climate.tMean);
  const what = hasLawn ? 'the lawn' : 'the lot';
  /* In the transition zone the kind chosen on the shade step narrows the list; otherwise both are shown. */
  const kindZone = zone.zone === 'transition' && (grassKind === 'cool' || grassKind === 'warm') ? grassKind : zone.zone;
  const z = `<p><b>${esc(zone.label)}</b> country: the coldest 30 days here average ${zone.cold.toFixed(0)} °C (${Math.round(zone.cold * 1.8 + 32)} °F) and the warmest ${zone.warm.toFixed(0)} °C (${Math.round(zone.warm * 1.8 + 32)} °F), ${esc(zone.why)}.${zone.zone === 'transition' ? (kindZone === zone.zone ? ' Both kinds are listed; choose one on the shade step to narrow it.' : ` ${kindZone === 'cool' ? 'Cool' : 'Warm'}-season grass, as chosen on the shade step.`) : ''}</p>`;
  if (!season) { el.innerHTML = `${z}<p class="dim">Working out the growing season's light over ${what}…</p>`; return; }
  const pts = lawnLight(season);
  if (!pts.length) { el.innerHTML = `${z}<p class="warn">No lawn light to judge: nothing of ${what} is in the model (a building, or under crowns nothing gets through).</p>`; return; }
  const bands = grassBands(pts, kindZone);
  const L = season.stats?.lawn;
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const sqft = (n) => `${Math.round(n * SQFT).toLocaleString()} sq ft`;
  const pct = (f) => `${Math.round(100 * f)}%`;
  /* Each band of the lawn, brightest first: its light, its area, and the
     grasses for it with the least shade-tolerant first (owner, 2026-10-17:
     "find what the least shade tolerant grass you can use is ... favor
     variety"). */
  const bandHtml = bands.map((b, i) => {
    const light = b.hi === Infinity ? `${b.lo} mol/m²/day or more` : b.lo === 0 ? `under ${b.hi} mol/m²/day` : `${b.lo} to ${b.hi} mol/m²/day`;
    const title = b.hi === Infinity ? 'Sunny' : b.lo === 0 ? 'Too dark for turf' : i === 1 && bands[0]?.hi === Infinity ? 'Light shade' : 'Shade';
    const list = b.grasses.map((s, j) => `<li><b>${esc(s.name)}</b> <span class="dim">needs ${s.dli}${s.derived ? '*' : ''}, does best from ${s.full}</span>${j === 0 && b.hi !== Infinity ? ' <span class="ok">— the least shade-tolerant that still takes this</span>' : ''}<br><span class="dim">${esc(s.shade)}</span><details><summary class="dim">source</summary><span class="dim">${esc(s.source)}</span></details></li>`).join('');
    const lead = b.hi === Infinity
      ? `Any of these grows here; they are ranked by how much light they like, so the first is the happiest in full sun. Mixing two or three gives a lawn that copes with more than one would alone.`
      : b.lo === 0 ? `No grass of this climate holds an acceptable lawn at this little light through the season. A shade-loving ground cover, mulch, or thinning the trees are the answers here.`
        : b.grasses.length > 1 ? `These take the shade here, the least shade-tolerant first: start with the first for a lawn like the sunny part, or blend two of them.`
          : `Only one grass takes the shade here.`;
    return `<h3>${title} <span class="dim">${light} · ${sqft(b.n)} · ${pct(b.share)} of ${what}</span></h3><p>${lead}</p>${list ? `<ul class="grasses">${list}</ul>` : ''}`;
  }).join('');
  const kinds = kindZone === 'transition' ? ['cool', 'warm'] : [kindZone];
  const planting = kinds.map((k) => { const gs = growingSeason(climate.tMean, k, undefined, climate.tSoil || null); const w = plantingWindow(gs, k); return w ? `<li><b>${k === 'cool' ? 'Cool-season' : 'Warm-season'} grass:</b> ${esc(w)}</li>` : ''; }).join('');
  el.innerHTML = `${z}
    <p><b>Light on ${what}</b> through the growing season: ${mean.toFixed(1)} mol/m²/day on average${L ? `, lowest ${L.min.toFixed(1)} around ${dayLabel(L.minDay)}` : ''}, against ${season.stats?.open ? season.stats.open.mean.toFixed(1) : '—'} on open ground here. The parts of ${what} below are cut at the grasses' lowest lights; the "Light (DLI)" view over the growing season on the shade step shows where each part is.</p>
    ${bandHtml}
    <p class="dim">"Needs" is the published minimum daily light for an acceptable lawn (mol/m²/day), measured under shade cloth in summer; * marks one read from the nearest measured bracket, with no published minimum (sources: tap "source"). Tree shade is harsher than cloth, so treat a bare pass as marginal; the season average here runs below midsummer's light, which leans the other way. Cultivars, mowing height and wear move the figures by a few mol.</p>
    <h3>When to plant</h3>
    <ul>${planting}</ul>`;
}
