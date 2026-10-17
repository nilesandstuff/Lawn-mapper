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
 * The light needs come from the published minimum-DLI studies, as
 * summarized for the owner on 2026-10-15 (docs/GRASS-LIGHT.md); each entry
 * names its study. ALL SUBJECT TO CHANGE: the owner is having more research
 * done and will do his own (2026-10-15).
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
 * The species. `dli` is the lowest daily light (mol/m2/day) at which the
 * grass holds an acceptable lawn, from the published minimum-DLI studies
 * as summarized for the owner (2026-10-15; docs/GRASS-LIGHT.md keeps the
 * sources): field or greenhouse trials under shade cloth, mostly at
 * 30-40 N in the US, summer, lawn or fairway height, no growth regulator,
 * no traffic. `full` is about where the grass does its best (full sun or
 * the trials' upper range). Where no minimum has been published (fine
 * fescues, buffalograss) the figure is the nearest measured bracket, and
 * `derived` says so. Tree shade cuts red light and adds root competition
 * that cloth does not, so real needs under crowns run somewhat higher;
 * the lawn's season-average light that these are set against runs below
 * midsummer's, which leans the other way.
 */
export const SPECIES = [
  { id: 'finefescue', name: 'Fine fescues (Chewings, creeping red, hard)', season: 'cool', dli: 7, full: 15, derived: true,
    shade: 'the most shade-tolerant lawn grasses; fine blades, low wear, little feeding; Chewings and creeping red take shade best, hard fescue least',
    source: 'No published minimum. Chewings SR5100 and creeping red Dawson could not acclimate at 4 but did at 8-10 mol (Valentino & Lang 2007); 40 cultivars persisted at 6.5-10.7 under a shade tent (Petrella & Watkins 2020). Working floor 7-8.' },
  { id: 'roughblue', name: 'Rough bluegrass (Poa trivialis)', season: 'cool', dli: 7.5, full: 14, fallback: true,
    shade: 'holds very low light in cool, moist shade but fades in summer heat; a shade-mix component for where nothing else takes the shade',
    source: 'Sabrena stayed acceptable at about 7 mol through a winter under 60% cloth; wear threshold about 7.5 (Abelard & Galbrun 2022).' },
  { id: 'supina', name: 'Supina bluegrass (Poa supina)', season: 'cool', dli: 5.5, full: 12, fallback: true, derived: true,
    shade: 'the lowest-light turf there is, spreading and wear-tolerant; dear seed, light green, for shade nothing else holds',
    source: 'Needs over 5 mol to carry traffic beyond five weeks; acceptable at 10-15% of full sun for months without traffic; neither it nor Kentucky bluegrass prospered at 1-2 (Stier & Rogers 2001; Stier 1997). No quality minimum published.' },
  { id: 'tallfescue', name: 'Tall fescue (turf-type)', season: 'cool', dli: 9, full: 20,
    shade: 'takes moderate shade and heat better than bluegrass; deep roots; the usual shade choice where fine fescue is too thin',
    source: 'Rebel Exeda 8.8 (Meeks 2015, Texas, quality 5); species 9.3 in a winter stadium trial (Abelard & Galbrun 2022). Short-term trials only.' },
  { id: 'rye', name: 'Perennial ryegrass', season: 'cool', dli: 20, full: 25,
    shade: 'quick to establish; fair in light shade, poor in deep shade; often blended with the fescues',
    source: 'Set at 20 by the owner (2026-10-15) pending better research: the one peer-reviewed value, 8.4, is a lenient winter criterion (Abelard & Galbrun 2022), and the 23 quoted by grow-light vendors has no primary source.' },
  { id: 'kbg', name: 'Kentucky bluegrass', season: 'cool', dli: 23, full: 28,
    shade: 'the full-sun cool-season lawn grass; thins and invites moss in shade',
    source: 'Conventional cultivars 22-26 (Kenblue 24.1, Meeks 2015; a four-cultivar blend 26.2 and 22.5, Reed et al. 2024, quality 7).' },
  { id: 'staug', name: 'St. Augustinegrass', season: 'warm', dli: 13, full: 20,
    shade: 'the most shade-tolerant warm-season lawn grass (Captiva, Palmetto and Seville more than Floratam); not cold-hardy; sod only',
    source: 'Captiva 10.9 and Floratam 11.8 in an 8-week Florida screen (Unruh 2015); Palmetto 15.5 at rough height in Texas. Lawn value about 13.' },
  { id: 'zoysia', name: 'Zoysiagrass', season: 'warm', dli: 14, full: 22,
    shade: 'fair shade tolerance, the fine-bladed cultivars (Zorro, Zeon, Cavalier, Lazer) best; slow to fill in; Meyer the least tolerant',
    source: 'Shade-tolerant cultivars 10-11 in an 8-week Florida screen, 19-24 after 27 months of year-round shade in Texas at fairway height, 12-16 at lawn height (USGA); Cavalier 15.0 vs Meyer 21.1 (Richardson 2019). Set at 14 by the owner (2026-10-15) pending better research.' },
  { id: 'centipede', name: 'Centipedegrass', season: 'warm', dli: 14, full: 20,
    shade: 'light shade only; low upkeep, acid soils; the Southeast\'s low-care lawn',
    source: 'TifBlair 13.4 (Unruh 2015, Florida, 8-week screen).' },
  { id: 'bahia', name: 'Bahiagrass', season: 'warm', dli: 16, full: 22,
    shade: 'full sun to light shade; coarse, tough, drought-hardy, low upkeep',
    source: 'Argentine 15.3 (Unruh 2014, Florida).' },
  { id: 'paspalum', name: 'Seashore paspalum', season: 'warm', dli: 14, full: 22,
    shade: 'coastal lawns and salty water; light shade only',
    source: 'SeaDwarf 13.2 (Unruh 2015, Florida).' },
  { id: 'bermuda', name: 'Bermudagrass', season: 'warm', dli: 24, full: 30,
    shade: 'full sun; thins fast in any shade (Celebration, TifGrand and Latitude 36 hold on at the low end; putting greens need over 30)',
    source: 'Lawn and fairway cultivars 19-26: Tifway 21.0-25.95, common 25.9, Celebration 19.6-24.65, TifGrand 19.9-25.0 (Florida, Texas, Arkansas); USGA practical threshold 24-26.' },
  { id: 'buffalo', name: 'Buffalograss', season: 'warm', dli: 16, full: 25, derived: true,
    shade: 'a prairie grass for full sun and little water; Prestige held up best under heavy shade',
    source: 'No published minimum. Prestige and two Nebraska lines were acceptable under 60% cloth, about 15-17 mol in summer by the Clemson and Texas cloth readings (Amundsen 2017); derived.' },
];

/**
 * The share of the lawn (its points' season-average DLI, mol/m2/day) each
 * species of the zone would hold, best first. `zone` is 'cool', 'warm' or
 * 'transition' (both lists). Each row: { ...species, share (0..1 of the
 * points at or over its lowest light), fullShare (at or over its best) }.
 */
export const FALLBACK_WHEN_FEWER_THAN = 2; // regular grasses holding most of the lawn
export function rankGrasses(dliPoints, zone) {
  const pts = Array.from(dliPoints || []).filter(Number.isFinite);
  const seasons = zone === 'transition' ? ['cool', 'warm'] : [zone];
  const n = pts.length || 1;
  const all = SPECIES.filter((s) => seasons.includes(s.season)).map((s) => {
    let ok = 0, full = 0;
    for (const v of pts) { if (v >= s.dli) ok++; if (v >= s.full) full++; }
    return { ...s, share: pts.length ? ok / n : null, fullShare: pts.length ? full / n : null };
  }).sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || a.dli - b.dli);
  /* The fallbacks (rough and supina bluegrass; owner, 2026-10-15: "only
     get chosen when there are few options that tolerate those light
     levels") are listed only when fewer than two regular grasses hold
     most of the lawn. */
  const regularHolding = all.filter((s) => !s.fallback && s.share >= 0.5).length;
  return pts.length && regularHolding < FALLBACK_WHEN_FEWER_THAN ? all : all.filter((s) => !s.fallback);
}

/**
 * THE LAWN BY ITS LIGHT, AND THE GRASSES FOR EACH PART (owner, 2026-10-17:
 * "the grass finder should try to find what the least shade tolerant grass
 * you can use is ... it should say 'you can plant any of these grasses in
 * the sunny areas, and these are the options for shady areas'. And it should
 * favor variety ... in a full sun area you can plant any of the types and it
 * ranks them by which ones are most happy with having plenty of excess
 * light").
 *
 * The lawn's points (season-average DLI) fall into bands cut at the
 * species' lowest lights, brightest first. Each band lists every grass of
 * the zone whose lowest light the band meets, THE LEAST SHADE-TOLERANT
 * FIRST (highest need, then highest best-light): in the sun that puts the
 * sun-lovers at the top; in the shade, the grass that only just takes it.
 * Rough and supina bluegrass appear in a band only when fewer than two
 * regular grasses hold it, after them. Returns [{ lo, hi, n, share, grasses }], bands
 * with no points left out; `hi` is Infinity for the brightest.
 */
export function grassBands(dliPoints, zone) {
  const pts = Array.from(dliPoints || []).filter(Number.isFinite);
  const seasons = zone === 'transition' ? ['cool', 'warm'] : [zone];
  const species = SPECIES.filter((s) => seasons.includes(s.season));
  const cuts = [...new Set(species.map((s) => s.dli))].sort((a, b) => b - a);
  const edges = [Infinity, ...cuts, 0];
  const bands = [];
  for (let i = 1; i < edges.length; i++) {
    const hi = edges[i - 1], lo = edges[i];
    const n = pts.filter((v) => v >= lo && v < hi).length;
    if (!n) continue;
    const holding = species.filter((s) => s.dli <= lo).sort((a, b) => (a.fallback ? 1 : 0) - (b.fallback ? 1 : 0) || b.dli - a.dli || b.full - a.full || a.name.localeCompare(b.name));
    const regular = holding.filter((s) => !s.fallback);
    bands.push({ lo, hi, n, share: n / pts.length, grasses: regular.length >= FALLBACK_WHEN_FEWER_THAN ? regular : holding });
  }
  return bands;
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
