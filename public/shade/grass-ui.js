/**
 * STEP 4, WHICH GRASS: the grass.js verdicts written out for the lawn --
 * the climate's kind of grass, each species' share of the lawn by the
 * season-average light the shade map worked out (light-worker.js season),
 * and when to plant.
 */

import { climateZone, rankGrasses, plantingWindow, shareWords } from './grass.js';
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
export function renderGrass(el, { season, climate, hasLawn }) {
  if (!climate?.tMean) { el.innerHTML = '<p class="warn">The weather here could not be read, so the grass cannot be matched to the climate. The shade map above still stands.</p>'; return; }
  const zone = climateZone(climate.tMean);
  const what = hasLawn ? 'the lawn' : 'the lot';
  const z = `<p><b>${esc(zone.label)}</b> country: the coldest 30 days here average ${zone.cold.toFixed(0)} °C (${Math.round(zone.cold * 1.8 + 32)} °F) and the warmest ${zone.warm.toFixed(0)} °C (${Math.round(zone.warm * 1.8 + 32)} °F), ${esc(zone.why)}.</p>`;
  if (!season) { el.innerHTML = `${z}<p class="dim">Working out the growing season's light over ${what}…</p>`; return; }
  const pts = lawnLight(season);
  if (!pts.length) { el.innerHTML = `${z}<p class="warn">No lawn light to judge: nothing of ${what} is in the model (a building, or under crowns nothing gets through).</p>`; return; }
  const ranked = rankGrasses(pts, zone.zone);
  const L = season.stats?.lawn;
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const pct = (f) => (f == null ? '—' : `${Math.round(100 * f)}%`);
  const area = (f) => (f == null ? '' : `${Math.round(f * pts.length * SQFT).toLocaleString()} sq ft`);
  const rows = ranked.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="dim">${esc(s.shade)}</span></td><td>${s.dli}</td><td><b>${pct(s.share)}</b><br><span class="dim">${area(s.share)}</span></td><td class="dim">${pct(s.fullShare)}</td></tr>`).join('');
  const best = ranked[0];
  const verdict = best.share >= 0.97 ? `<b>${esc(best.name)}</b> would hold all of ${what}; ${ranked.filter((s) => s.share >= 0.97).length > 1 ? `so would ${ranked.filter((s) => s.share >= 0.97).slice(1).map((s) => esc(s.name)).join(', ')}` : 'nothing else would hold all of it'}.`
    : best.share > 0 ? `No grass holds all of ${what}: <b>${esc(best.name)}</b> comes closest, holding ${shareWords(best.share)} (${pct(best.share)}). The rest is too dark for turf through the season; a shade-loving ground cover, mulch, or thinning the trees are the answers there.`
      : `Too dark for turf: no grass of this climate holds any of ${what} at its season-average light.`;
  const kinds = zone.zone === 'transition' ? ['cool', 'warm'] : [zone.zone];
  const planting = kinds.map((k) => { const gs = growingSeason(climate.tMean, k); const w = plantingWindow(gs, k); return w ? `<li><b>${k === 'cool' ? 'Cool-season' : 'Warm-season'} grass:</b> ${esc(w)}</li>` : ''; }).join('');
  el.innerHTML = `${z}
    <p><b>Light on ${what}</b> through the growing season: ${mean.toFixed(1)} mol/m²/day on average${L ? `, lowest ${L.min.toFixed(1)} around ${dayLabel(L.minDay)}` : ''}, against ${season.stats?.open ? season.stats.open.mean.toFixed(1) : '—'} on open ground here.</p>
    <p>${verdict}</p>
    <table class="grass">
      <tr><th>Grass</th><th>Needs<br><span class="dim">mol/m²/day</span></th><th>Holds<br><span class="dim">of ${what}</span></th><th>At its best<br><span class="dim">of ${what}</span></th></tr>
      ${rows}
    </table>
    <p class="dim">"Holds" is the share of ${what} whose season-average light is at or over the grass's lowest need; "at its best" the share at or over the light it does best in. Light needs are provisional figures from the turf literature as commonly cited, to be replaced by a species summary; cultivars, mowing height and wear move them.</p>
    <h3>When to plant</h3>
    <ul>${planting}</ul>`;
}
