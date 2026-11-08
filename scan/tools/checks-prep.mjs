/**
 * THE CHECK MARKS' PHOTO, FOR THE CHECK-AGAINST-LIDAR TEST (core session, 2026-11-08; scan/tools/checks_lidar.py
 * reads it). The owner: the check marks are placed on the aerial photo, on things it shows (driveway corners, a well
 * head, a shrub stem), "so in a visual sense they align nearly perfectly, within inches. BUT I'm wondering if the
 * aerial imagery is connecting correctly with the reality". Every error the studies report is measured against those
 * marks, so a photo off the lidar where a mark sits is an error in the yardstick itself.
 *
 * Writes beside the twin (after skyline-prep.mjs, which writes the lidar's points and the marks):
 *   checks-photo.png    the Mapbox photo the scan page shows, for the same frame (the one the marks were put on)
 *   checks-photo.json   how a map metre lands on it (an affine, exact enough over a lot), and what the shade map did
 *                       when it put the lidar on a photo: which photo, the move, how sure
 *
 * Prints no coordinate and no key.
 *
 *   CLOUDFLARE_API_TOKEN=... MAPBOX_TOKEN=... node scan/tools/checks-prep.mjs twin
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameFor, bboxOf, toPx, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { readMap, readModel } from './twin-io.mjs';

async function main() {
  const dir = process.argv[2] || 'twin';
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  if (!meta.map) throw new Error('the twin names no map');
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;   // the server one: the browser one is restricted to the site (worker/src/index.js serverToken)
  if (!token) throw new Error('no Mapbox token');
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat];
  // the scan page's own frame (scan/public/app.js openMap): the lawn and the parcel, 12 m round
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(origin, p)));
  const frame = frameFor(bboxOf(origin, [...lawn.flat(), ...parcel.flat()], 12), m.lat);
  // the main site's Mapbox request (worker/src/imagery.js PROVIDERS.mapbox), at @2x as the page gets it
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frame.height}@2x?access_token=${token}&attribution=false&logo=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the photo could not be fetched (${r.status})`);
  writeFileSync(join(dir, 'checks-photo.png'), Buffer.from(await r.arrayBuffer()));
  const w = frame.size * 2, h = frame.height * 2;
  // map metres -> photo pixels, as an affine from three points 50 m apart (Web Mercator is straight over a lot)
  const p0 = toPx(frame, origin, [0, 0], w, h), pe = toPx(frame, origin, [50, 0], w, h), pn = toPx(frame, origin, [0, 50], w, h);
  const A = [(pe[0] - p0[0]) / 50, (pn[0] - p0[0]) / 50, p0[0], (pe[1] - p0[1]) / 50, (pn[1] - p0[1]) / 50, p0[1]];
  const lid = model.meta.lidar || {};
  const fit = lid.fit || null;
  writeFileSync(join(dir, 'checks-photo.json'), JSON.stringify({
    w, h, affine: A,
    tracedOn: m.tracedOn?.provider || 'mapbox',
    lidarFit: fit ? { confident: !!fit.confident, east: fit.east ?? null, north: fit.north ?? null, why: fit.why || null, quarters: fit.quarters || null, spreadM: fit.spreadM ?? null, errorM: fit.errorM ?? null } : null,
  }));
  const mpp = 1 / Math.hypot(A[0], A[3]);
  const q = (fit?.quarters || []).filter((x) => x && Number.isFinite(x.east));
  const spread = q.length >= 2 && Number.isFinite(fit.east) ? Math.max(...q.map((x) => Math.hypot(x.east - fit.east, x.north - fit.north))) : null;
  console.log(`Check marks' photo: Mapbox, ${w} x ${h} px at ${(mpp * 100).toFixed(1)} cm a pixel. The map was traced on ${m.tracedOn?.provider || 'mapbox'}. ` +
    `The shade map put the lidar on that photo: ${fit ? (fit.confident ? `moved ${(Math.hypot(fit.east, fit.north) * 3.281).toFixed(1)} ft past the datum move, sure` : `not sure (${fit.why || 'no reason given'}), so the datum move alone`) : 'no record of a fit'}` +
    `${spread != null ? `; its four quarters disagreed by up to ${(spread * 3.281).toFixed(1)} ft` : ''}.`);
}

main().catch((e) => { console.error(`Check marks' photo: ${e.message}`); process.exit(1); });
