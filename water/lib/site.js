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

import { pointsIn, toMerc, mercScale } from './ept.js';
import { analyse, spotRecords } from './lowspots.js';
import { boundsOf, maskOf, maskBox } from './geo.js';
import { gridFor } from './surface.js';

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

export async function runSite(site, io, pickCloud, { progress = () => {}, nullRuns = 8 } = {}) {
  const t0 = Date.now();
  const pick = await pickCloud(site.lng, site.lat);
  const cloud = pick?.clouds?.[0];
  if (!cloud) return { error: 'no public lidar over this property', notOnAws: pick?.notOnAws || [] };
  const bbox = boxFor(site);
  const { cols, flown } = await pointsIn(cloud.url, bbox, io, { progress });
  const epoch = cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null);
  // the noise floor is judged over the property itself, not the margin
  const g = gridFor(bbox, site.lat);
  const parcelMask = site.parcel ? maskOf(g, site.parcel) : null;
  const lawnMask = site.lawn?.length ? maskOf(g, site.lawn) : null;
  const within = (parcelMask && maskBox(g, parcelMask)) || (lawnMask && maskBox(g, lawnMask)) || null;
  const res = analyse(cols, bbox, site.lat, { epoch, within, nullRuns });

  const onParcel = parcelMask ? spotsOn(res, parcelMask) : [];
  const onLawn = lawnMask ? spotsOn(res, lawnMask) : [];
  // the house: the roof with most cells inside the property line
  let wallOnLot = 0;
  if (parcelMask) for (let i = 0; i < res.wall.length; i++) if (res.wall[i] && parcelMask[i]) wallOnLot++;
  const besideLot = parcelMask ? res.beside.walls.filter((w) => parcelMask[w.i]) : res.beside.walls;
  const share = (f) => (besideLot.length ? besideLot.filter(f).length / besideLot.length : null);

  return {
    cloud: { name: cloud.name, ql: cloud.unit?.ql ?? null, flown: flown ? new Date(flown.mid).toISOString().slice(0, 10) : null, notOnAws: pick.notOnAws || [] },
    result: res, parcelMask, lawnMask,
    spots: spotRecords(res).filter((r) => !parcelMask || parcelMask[r.row * g.W + r.col] || onParcel.some((o) => o.spot.row === r.row && o.spot.col === r.col)),
    summary: {
      ...res.stats,
      lawnM2: lawnMask ? lawnMask.reduce((s, v) => s + v, 0) * g.cell * g.cell : null,
      spotsOnParcel: onParcel.length,
      spotsOnLawn: onLawn.length,
      wetLawnM2: onLawn.reduce((s, o) => s + o.insideM2, 0),
      deepestOnLawnCm: onLawn.length ? Math.max(...onLawn.map((o) => o.spot.depth)) * 100 : null,
      roofOnLotM2: wallOnLot * g.cell * g.cell,
      besideHouse: {
        outlineCells: besideLot.length,
        towardShare: share((w) => w.fallAway < -0.01),
        meetsCodeShare: share((w) => w.fallAway >= 0.05),
      },
      seconds: (Date.now() - t0) / 1000,
    },
  };
}
