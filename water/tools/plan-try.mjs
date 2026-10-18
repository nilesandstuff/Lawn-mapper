/**
 * TRY THE WATERING PLAN ON ONE CORPUS LOT (water session): the whole chain,
 * timed, numbers only. LOT_INDEX picks a corpus map by its number (#1-#104);
 * the lawn is stood in for by the open ground within 20 m of the map's point
 * (the traced lawn lives in the database, read by tools/corpus.mjs in CI).
 */
import { readFileSync } from 'node:fs';
import { lidarAt } from '../../worker/src/shade.js';
import { pointsIn, toMerc, mercScale } from '../lib/ept.js';
import { nodeIo } from '../lib/node-io.js';
import { analyse } from '../lib/lowspots.js';
import { soilFor, sdaPost } from '../lib/soil.js';
import { typicalYears, thisWeek } from '../lib/weather.js';
import { waterPlan } from '../lib/plan.js';

const ids = JSON.parse(readFileSync(new URL('../../tools/locked-lawns.json', import.meta.url))).ids;
const k = Number(process.env.LOT_INDEX || 1);
const [lng, lat] = ids[k - 1].split(':')[0].split(',').map(Number);
const t = () => Date.now();
let t0 = t();
const cloud = (await lidarAt(lng, lat)).clouds?.[0];
const kk = mercScale(lat), [cx, cy] = toMerc([lng, lat]), half = 55 / kk;
const bbox = [cx - half, cy - half, cx + half, cy + half];
const { cols, flown } = await pointsIn(cloud.url, bbox, nodeIo());
const res = analyse(cols, bbox, lat, { epoch: cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null), nullRuns: 4 });
console.log(`#${k}: lidar and ground ${((t() - t0) / 1000).toFixed(1)} s, grid ${res.grid.W}x${res.grid.H}`);
const g = res.grid, lawn = new Uint8Array(g.W * g.H);
for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
  const i = r * g.W + c;
  if (!res.wall[i] && Math.hypot(c - g.W / 2, r - g.H / 2) * g.cell <= 20 && res.perCell.tall[i] === 0) lawn[i] = 1;
}
t0 = t();
const d = 1 / 111320, e = d / Math.cos((lat * Math.PI) / 180);
const soil = await soilFor([lng - 55 * e, lat - 55 * d, lng + 55 * e, lat + 55 * d], (q) => sdaPost(q));
console.log(`soil ${((t() - t0) / 1000).toFixed(1)} s: ${soil.units.map((u) => `${u.drainage} ${u.hydgrp} ${(u.share * 100).toFixed(0)}%`).join('; ')}`);
t0 = t();
const typical = (await typicalYears(lat, lng)).days;
const week = await thisWeek(lat, lng, { back: 60 });
console.log(`weather ${((t() - t0) / 1000).toFixed(1)} s: ${typical.length} typical days, ${week.days.length} recent and coming`);
for (const topsoil of [false, true]) {
  t0 = t();
  const plan = waterPlan(res, { lawnMask: lawn, soil, topsoil, typical, week });
  console.log(`\nplan${topsoil ? ' WITH 4 in of loamy topsoil' : ''} ${((t() - t0) / 1000).toFixed(1)} s; ${plan.zones.length} zone(s); roofs ${plan.roofs.pieces} (${plan.roofs.guessed} guessed)`);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (const z of plan.zones) {
    console.log(` zone ${z.zone + 1}: ${z.m2} m2, ${(z.depthMm / 25.4).toFixed(2)} in each time (root zone holds ${(z.tawMm / 25.4).toFixed(2)} in), slope ${(z.slope * 100).toFixed(0)}%, ${z.drainage.join('/')}, run-on (a quarter or more over its rain) on ${(z.runOnShare * 100).toFixed(0)}%`);
    console.log(`   ${z.months.filter((m) => m.waterings).map((m) => `${M[m.month]} ${m.waterings}x (${m.low}-${m.high})`).join(', ')}`);
    console.log(`   in season: wet ${(z.wetShare * 100).toFixed(0)}% of days, dry ${(z.dryShare * 100).toFixed(0)}% (rain alone: dry ${(z.rainAloneDryShare * 100).toFixed(0)}%); watering makes ${z.tooWet} m2 wet, ${z.wetAnyway} m2 wet anyway, ${z.tooDry} m2 still dry; rain alone wet ${(z.rainAloneWetShare * 100).toFixed(0)}%`);
  }
  if (process.env.DEBUG) {
    const by = new Map();
    for (let i = 0; i < plan.kinds.length; i++) if (plan.kinds[i] === 1) {
      const key = `zone ${plan.zoneOf[i]}`;
      const e = by.get(key) || { n: 0, dry: 0 }; e.n++; if (plan.dryShare[i] > 0.1) e.dry++; by.set(key, e);
    }
    console.log(' debug', JSON.stringify([...by]), 'debug soils', JSON.stringify(plan.soil.map((u) => [u.drainage, u.tawMm?.toFixed(1)])));
  }
  if (plan.thisWeek) console.log(` this week (today ${plan.thisWeek.today}, rain coming ${plan.thisWeek.rainComing.toFixed(1)} mm): ${plan.thisWeek.zones.map((z) => `zone ${z.zone + 1} next ${z.next ? `${z.next.date} ${(z.next.mm / 25.4).toFixed(2)} in` : 'not by ' + plan.thisWeek.through}`).join('; ')}`);
  console.log(' months (rain / grass use, mm):', plan.weather.map((m) => `${M[m.month]} ${m.rainMm.toFixed(0)}/${m.grassUseMm.toFixed(0)}`).join(' '));
}
