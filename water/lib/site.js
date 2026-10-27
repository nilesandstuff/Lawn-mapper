/**
 * ONE PROPERTY, END TO END (water session): the same steps whether the
 * property is a corpus map in a workflow or an address typed on the page.
 *
 *   site = { lng, lat, parcel (GeoJSON Feature or null), lawn ([Feature]) }
 *   io   = lib/ept.js's io (getJson, getBytes, decompress)
 *   pickCloud(lng, lat) -> the /api/shade/lidar answer (clouds best first)
 *
 * The box is the property line (or the lawn, or 25 m round the point) plus
 * PAD m on every side: a low spot is judged on its whole catchment, and
 * water from next door runs onto this lot.
 */

import { flightSeason } from './leaf.js';
import { pointsIn, toMerc, mercScale } from './ept.js';
import { analyse, spotRecords } from './lowspots.js';
import { boundsOf, maskOf, maskBox } from './geo.js';
import { gridFor } from './surface.js';
import { imperviousness, weightedFlow, runOnSources } from './impervious.js';
import { naipFor, ndvi } from './naip.js';
import { overtureFor, overtureMasks } from './overture.js';

export const PAD = 30;

export function boxFor(site, pad = PAD) {
  const b = boundsOf(site.parcel, site.lawn) || (() => {
    const d = 25 / 111320, e = d / Math.cos(site.lat * Math.PI / 180);
    return [site.lng - e, site.lat - d, site.lng + e, site.lat + d];
  })();
  const [x0, y0] = toMerc([b[0], b[1]]), [x1, y1] = toMerc([b[2], b[3]]);
  const p = pad / mercScale(site.lat);
  return [x0 - p, y0 - p, x1 + p, y1 + p];
}

/** Which reported spots touch a mask, and how much of each lies inside it. */
function spotsOn(result, mask) {
  const out = [];
  for (const s of result.spots.spots) {
    if (!s.reported) continue;
    let inside = 0;
    for (const i of s.cells) if (mask[i] && result.spots.depth[i] >= 0.01) inside++;
    if (inside) out.push({ spot: s, insideM2: inside * result.grid.cell * result.grid.cell });
  }
  return out;
}

function countKinds(list) {
  const out = {};
  for (const o of list) out[o.spot.kind || 'hollow'] = (out[o.spot.kind || 'hollow'] || 0) + 1;
  return out;
}

export async function runSite(site, io, pickCloud, { progress = () => {}, nullRuns = 8 } = {}) {
  const t0 = Date.now();
  /* A map the shade map has worked on carries the cloud, box and shift it used (docs/MAPS.md;
     tools.shade.data.lidar: { url, name, epoch, box [x0, y0, x1, y1] in 3857, shift [dx, dy] }): take
     them, so a cell here is the same cell as in the shade map's part. Otherwise pick and box as before. */
  const kept = site.lidar && site.lidar.url && Array.isArray(site.lidar.box) && site.lidar.box.length === 4 ? site.lidar : null;
  const pick = kept ? { clouds: [{ name: kept.name || 'the shade map\'s cloud', url: kept.url, epoch: kept.epoch ?? null }], notOnAws: [] } : await pickCloud(site.lng, site.lat);
  const cloud = pick?.clouds?.[0];
  if (!cloud) return { error: 'no public lidar over this property', notOnAws: pick?.notOnAws || [] };
  const bbox = kept ? kept.box : boxFor(site);
  // Overture's roads, sidewalks and buildings, and the USDA photo, fetched while the lidar is read
  // each asked up to three times: a source that drops out once must not change the map (owner 2026-10-19)
  const thrice = async (fn) => { for (let k = 0; k < 3; k++) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 1500 * (k + 1))); } return null; };
  const ovP = thrice(() => overtureFor(bbox));
  const photoP = thrice(() => naipFor(gridFor(bbox, site.lat)));
  const { cols, flown } = await pointsIn(cloud.url, bbox, io, { progress });
  const epoch = cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null);
  // the noise floor is judged over the property itself, not the margin
  const g = gridFor(bbox, site.lat);
  const parcelMask = site.parcel ? maskOf(g, site.parcel) : null;
  const lawnMask = site.lawn?.length ? maskOf(g, site.lawn) : null;
  const within = (parcelMask && maskBox(g, parcelMask)) || (lawnMask && maskBox(g, lawnMask)) || null;
  const ov = await ovP;
  const ovMasks = ov ? overtureMasks(g, ov) : null;
  const photo = await photoP;
  const res = analyse(cols, bbox, site.lat, { epoch, within, nullRuns, shift: kept && Array.isArray(kept.shift) ? kept.shift : null, overture: ovMasks, ndvi: photo ? ndvi(photo) : null });

  const onParcel = parcelMask ? spotsOn(res, parcelMask) : [];
  const onLawn = lawnMask ? spotsOn(res, lawnMask) : [];
  // the house: the roof with most cells inside the property line
  let wallOnLot = 0;
  if (parcelMask) for (let i = 0; i < res.wall.length; i++) if (res.wall[i] && parcelMask[i]) wallOnLot++;
  const besideLot = parcelMask ? res.beside.walls.filter((w) => parcelMask[w.i]) : res.beside.walls;
  const share = (f) => (besideLot.length ? besideLot.filter(f).length / besideLot.length : null);

  // how impervious the rest is, calibrated on the traced lawn (lib/impervious.js)
  // with the USDA photo when it answers (FINDINGS H17); the lidar alone when it does not
  const imp = lawnMask ? imperviousness(res, lawnMask, { photo, bands: ovMasks?.paved || null }) : null;
  const wflow = imp ? weightedFlow(res, imp.runoff) : null;
  let cover = null;
  if (imp && parcelMask) {
    cover = { lawnM2: 0, roofM2: 0, pavedM2: 0, otherM2: 0, unjudgedM2: 0 };
    for (let i = 0; i < res.wall.length; i++) {
      if (!parcelMask[i]) continue;
      if (res.wall[i]) cover.roofM2++;
      else if (lawnMask[i]) cover.lawnM2++;
      else if (Number.isNaN(imp.paved[i])) cover.unjudgedM2++;
      else { cover.pavedM2 += imp.paved[i]; cover.otherM2 += 1 - imp.paved[i]; }
    }
    for (const k of Object.keys(cover)) cover[k] = Math.round(cover[k] * g.cell * g.cell);
    // what drains onto the lawn, each square metre once, on the lot and beyond its line (lib/impervious.js)
    const src = runOnSources(res, wflow, imp, lawnMask, parcelMask);
    const m2 = (v) => Math.round(v);
    cover.runOn = { lot: Object.fromEntries(Object.entries(src.lot).map(([k, v]) => [k, m2(v)])), beyond: Object.fromEntries(Object.entries(src.beyond).map(([k, v]) => [k, m2(v)])), weightedM2: m2(src.weightedM2) };
  }

  return {
    sameGridAsShade: !!kept,
    cloud: { name: cloud.name, ql: cloud.unit?.ql ?? null, flown: flown ? new Date(flown.mid).toISOString().slice(0, 10) : null, season: flightSeason(flown), notOnAws: pick.notOnAws || [] },
    result: res, parcelMask, lawnMask, impervious: imp, weightedFlow: wflow,
    spots: spotRecords(res).filter((r) => !parcelMask || parcelMask[r.row * g.W + r.col] || onParcel.some((o) => o.spot.row === r.row && o.spot.col === r.col))
      .map((r) => {
        const on = onLawn.find((o) => o.spot.row === r.row && o.spot.col === r.col);
        return { ...r, onLawnM2: on ? on.insideM2 : 0 };
      }),
    hasLawn: !!lawnMask,
    summary: {
      ...res.stats,
      lawnM2: lawnMask ? lawnMask.reduce((s, v) => s + v, 0) * g.cell * g.cell : null,
      spotsOnParcel: onParcel.length,
      spotsOnLawn: onLawn.length,
      wetLawnM2: onLawn.reduce((s, o) => s + o.insideM2, 0),
      deepestOnLawnCm: onLawn.length ? Math.max(...onLawn.map((o) => o.spot.depth)) * 100 : null,
      // by kind (lib/kinds.js): only a hollow is a lawn problem
      kindsOnLawn: countKinds(onLawn), kindsOnParcel: countKinds(onParcel),
      hollowsOnLawn: onLawn.filter((o) => o.spot.kind === 'hollow').length,
      hollowLawnM2: onLawn.filter((o) => o.spot.kind === 'hollow').reduce((t, o) => t + o.insideM2, 0),
      deepestHollowOnLawnCm: (() => { const h = onLawn.filter((o) => o.spot.kind === 'hollow'); return h.length ? Math.max(...h.map((o) => o.spot.depth)) * 100 : null; })(),
      roofOnLotM2: wallOnLot * g.cell * g.cell,
      cover, pavingFromPhoto: !!imp?.withPhoto, overture: ov ? { roads: ov.roads.length, buildings: ov.buildings.length } : null,
      besideHouse: {
        outlineCells: besideLot.length,
        towardShare: share((w) => w.fallAway < -0.01),
        meetsCodeShare: share((w) => w.fallAway >= 0.05),
      },
      seconds: (Date.now() - t0) / 1000,
    },
  };
}
