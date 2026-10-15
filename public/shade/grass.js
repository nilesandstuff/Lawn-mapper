/**
 * WHICH GRASS WILL GROW HERE (owner, 2026-10-15: "the step that displays
 * which grass types a user should use based on their location and shade
 * restrictions"; and the purpose of the map: "help turf managers and
 * homeowners decide which types of grass are suitable").
 *
 * Two things decide it. THE CLIMATE says cool-season or warm-season grass
 * (or both, in the transition zone), read from the place's typical monthly
 * temperatures rather than a line on a map. THE LIGHT says which of those
 * will take the shade: each species' lowest daily light (DLI, mol/m2/day)
 * is set against the lawn's season-average light, point by point, so the
 * answer is a share of the lawn each grass would hold, not one number.
 *
 * THE LIGHT NEEDS BELOW ARE PROVISIONAL: the owner is having a summary of
 * species light requirements prepared (2026-10-15); these are placeholders
 * from the turf literature as it is commonly cited, to be replaced by that
 * summary. Each entry says where its number came from.
 */

import { dayLabel } from './climate.js';

export const ZONES = {
  cool: { label: 'Cool-season', why: 'winters too cold for warm-season grass to survive or stay green long enough' },
  warm: { label: 'Warm-season', why: 'summers too hot and long for cool-season grass to hold up without constant care' },
  transition: { label: 'Transition zone', why: 'cold enough in winter to hurt warm-season grass and hot enough in summer to stress cool-season grass; both are grown, each with a weak season' },
};

/**
 * The climate's verdict from a year of daily mean temperatures (C):
 * 'cool', 'warm' or 'transition', with the coldest and warmest 30-day
 * means that decided it. Thresholds: a coldest month under -2 C kills or
 * browns warm-season turf for too long (bermudagrass is hardy to about
 * zone 7; St. Augustine to 8); a coldest month over 7 C with a warmest
 * over 26 C is warm-season country; between is the transition zone.
 */
export function climateZone(tMean) {
  if (!tMean?.length) return null;
  const n = tMean.length;
  const run = (k) => { let s = 0; for (let i = -15; i < 15; i++) s += tMean[(k + i + n) % n]; return s / 30; };
  let cold = Infinity, warm = -Infinity;
  for (let k = 0; k < n; k++) { const v = run(k); if (v < cold) cold = v; if (v > warm) warm = v; }
  const zone = cold < -2 ? 'cool' : cold > 7 && warm > 26 ? 'warm' : warm < 23 ? 'cool' : 'transition';
  return { zone, cold, warm, ...ZONES[zone] };
}

/**
 * The species. `dli` is the lowest season-average daily light at which the
 * grass holds an acceptable turf (mol/m2/day); `full` is where it does its
 * best; `shade` says how it is usually described. `season` is which climate
 * grows it. PROVISIONAL (see the header).
 */
export const SPECIES = [
  { id: 'finefescue', name: 'Fine fescues (creeping red, chewings, hard)', season: 'cool', dli: 8, full: 15, shade: 'the most shade-tolerant cool-season grasses; thin, fine blades, low wear', source: 'placeholder: commonly cited as holding turf at low light; to be replaced by the species summary' },
  { id: 'tallfescue', name: 'Tall fescue (turf-type)', season: 'cool', dli: 12, full: 20, shade: 'takes moderate shade and heat better than bluegrass; deep roots', source: 'placeholder; to be replaced by the species summary' },
  { id: 'rye', name: 'Perennial ryegrass', season: 'cool', dli: 14, full: 20, shade: 'quick to establish; fair in light shade, poor in deep', source: 'placeholder; to be replaced by the species summary' },
  { id: 'kbg', name: 'Kentucky bluegrass', season: 'cool', dli: 18, full: 25, shade: 'wants full sun; thins and invites moss in shade', source: 'placeholder; to be replaced by the species summary' },
  { id: 'staug', name: 'St. Augustinegrass', season: 'warm', dli: 10, full: 20, shade: 'the most shade-tolerant warm-season grass (some cultivars more than others); not cold-hardy', source: 'placeholder; to be replaced by the species summary' },
  { id: 'zoysia', name: 'Zoysiagrass', season: 'warm', dli: 14, full: 22, shade: 'fair shade tolerance, better in the fine-bladed cultivars; slow to fill in', source: 'placeholder; to be replaced by the species summary' },
  { id: 'centipede', name: 'Centipedegrass', season: 'warm', dli: 16, full: 22, shade: 'light shade only; low upkeep, acid soils', source: 'placeholder; to be replaced by the species summary' },
  { id: 'bermuda', name: 'Bermudagrass', season: 'warm', dli: 22, full: 32, shade: 'full sun; thins fast in any shade (putting greens needed about 33 mol/m²/day)', source: 'placeholder; Clemson measured 32.6 for a putting-green cultivar; to be replaced by the species summary' },
  { id: 'bahia', name: 'Bahiagrass', season: 'warm', dli: 18, full: 25, shade: 'full sun to light shade; coarse, tough, low upkeep', source: 'placeholder; to be replaced by the species summary' },
];

/**
 * The share of the lawn (its points' season-average DLI, mol/m2/day) each
 * species of the zone would hold, best first. `zone` is 'cool', 'warm' or
 * 'transition' (both lists). Each row: { ...species, share (0..1 of the
 * points at or over its lowest light), fullShare (at or over its best) }.
 */
export function rankGrasses(dliPoints, zone) {
  const pts = Array.from(dliPoints || []).filter(Number.isFinite);
  const seasons = zone === 'transition' ? ['cool', 'warm'] : [zone];
  const n = pts.length || 1;
  return SPECIES.filter((s) => seasons.includes(s.season)).map((s) => {
    let ok = 0, full = 0;
    for (const v of pts) { if (v >= s.dli) ok++; if (v >= s.full) full++; }
    return { ...s, share: pts.length ? ok / n : null, fullShare: pts.length ? full / n : null };
  }).sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || a.dli - b.dli);
}

/** Words for a share of the lawn. */
export const shareWords = (f) => (f == null ? 'unknown' : f >= 0.97 ? 'all of it' : f >= 0.8 ? 'nearly all of it' : f >= 0.5 ? 'most of it' : f >= 0.2 ? 'part of it' : f > 0 ? 'little of it' : 'none of it');

/**
 * When to seed or sod, from the growing season (climate.js growingSeason)
 * of the grass's kind: cool-season grass goes in as the summer heat breaks
 * (about six weeks before the season's end lets it root before winter, and
 * the weeds are done), with spring a second choice; warm-season grass goes
 * in once the soil is warm, early in its season.
 */
export function plantingWindow(season, kind) {
  if (!season) return null;
  if (season.allYear) return kind === 'cool' ? 'Any cool, moist spell; late summer is best.' : 'Late spring to early summer, once the soil is warm.';
  if (!season.days?.length || season.start == null) return null;
  const lab = (k) => dayLabel(((k % 365) + 365) % 365);
  if (kind === 'cool') {
    /* Six to eight weeks before growth stops: rooted before winter, and the summer weeds are done; spring is the second choice. */
    return `Seed about ${lab(season.end - 56)} to ${lab(season.end - 28)}, six to eight weeks before growth stops around ${lab(season.end)}; spring, from ${lab(season.start)}, is the second choice.`;
  }
  return `Seed or sod from about ${lab(season.start + 21)} to ${lab(season.start + 70)}, early in the growing season (${lab(season.start)} to ${lab(season.end)}), so it fills in before the heat ends.`;
}
