// The sanity check of FINDINGS H58 point 1: a clear day by a 6 ft wood fence. node water/tools/fence-day.mjs (MON=0-11)
// A 6 ft (1.83 m) solid wood fence running east-west in the open, lat 43 N, a clear 15th of month ${MON + 1}.
// Per time step: the sun's beam on each face and on the grass, which spots it shades, each face's temperature.
import { sunPath, clearSky } from '../lib/shade/sun.js';
const H = 1.83, rho = 0.4, alpha = 1 - rho, u = 1.5, eps = 0.9, sig = 5.67e-8, T = 298;
const r = 4 * eps * sig * T ** 3;                // linearised longwave, W/m2/K (~5.4)
const hc = 5.7 + 3.8 * u, h = hc + r;            // per face: convection + radiation
const K = 0.12 / 0.019;                          // conduction through a 19 mm board (k 0.12 W/m/K): ~6.3 W/m2/K
const groundAlb = 0.2, grassAlb = 0.23;
const lat = 43, lng = -85.6;
const MON = Number(process.env.MON ?? 6); const path = sunPath(lat, lng, Date.UTC(2025, MON, 15, 12), 5); // 5-minute steps
const dt = 5 * 60;
const F = (d) => 0.5 * (1 - d / Math.hypot(d, H)); // view factor, ground point -> a long upright strip
const spots = [{ name: '1 m north (shaded side)', d: 1, side: 'N' }, { name: '1 m south (sunny side)', d: 1, side: 'S' }, { name: '3 m north', d: 3, side: 'N' }];
const res = spots.map(() => ({ shadeLost: 0, reflGain: 0, lwModel: 0, lwTwoFace: 0, beamDay: 0, faceMaxModel: 0, faceMaxTwo: 0 }));
let beamFlat = 0, diffFlat = 0;
for (const s of path) {
  if (s.elevation <= 0) continue;
  const { dni, dhi } = clearSky(s.elevation);
  const [sE, sN, sZ] = s.dir;
  beamFlat += dni * sZ * dt; diffFlat += dhi * dt;
  const ghi = dni * sZ + dhi;
  // sun on each face (S face normal (0,-1), N face (0,1)): beam, half the sky, half the ground's reflection
  const SA = dni * Math.max(0, -sN) + 0.5 * dhi + 0.5 * groundAlb * ghi; // south face
  const SB = dni * Math.max(0, sN) + 0.5 * dhi + 0.5 * groundAlb * ghi;  // north face
  // the model now: one temperature, both faces, all the board's heat over both
  const xModel = (alpha * (SA + SB)) / (2 * h);
  // two faces with the board's conduction between them
  const den = h * (h + 2 * K);
  const xA = (alpha * SA * (h + K) + K * alpha * SB) / den, xB = (alpha * SB * (h + K) + K * alpha * SA) / den;
  spots.forEach((sp, k) => {
    const R = res[k], f = F(sp.d);
    const faceX = sp.side === 'N' ? xB : xA;           // the grass north of the fence sees its north face
    R.lwModel += f * r * xModel * dt; R.lwTwoFace += f * r * faceX * dt;
    R.faceMaxModel = Math.max(R.faceMaxModel, xModel); R.faceMaxTwo = Math.max(R.faceMaxTwo, faceX);
    // shade: the beam toward the sun crosses the fence below its top
    const towardFence = sp.side === 'N' ? -sN : sN;     // the sun on the fence's far side
    const shaded = towardFence > 0 && (sp.d * sZ) / towardFence < H;
    if (shaded) R.shadeLost += dni * sZ * (1 - grassAlb) * dt;
    // the sun the fence's lit face throws back onto this side
    const lit = sp.side === 'N' ? Math.max(0, sN) : Math.max(0, -sN);
    R.reflGain += rho * f * dni * lit * (1 - grassAlb) * dt;
    R.beamDay += dni * sZ * dt;
  });
}
const MJ = (j) => (j / 1e6).toFixed(2);
console.log(`clear 15th of month ${MON + 1}, lat 43: beam on level ground ${MJ(beamFlat)} MJ/m2, sky ${MJ(diffFlat)}; per face h = ${h.toFixed(1)} W/m2/K (convection ${hc.toFixed(1)}, radiation ${r.toFixed(1)}), board conduction ${K.toFixed(1)}`);
console.log(`share of the board's absorbed heat carried off by the air (convection): ${(hc / h * 100).toFixed(0)}%`);
spots.forEach((sp, k) => { const R = res[k];
  console.log(`${sp.name.padEnd(26)} F ${F(sp.d).toFixed(2)} | beam lost to shade ${MJ(R.shadeLost)} MJ | reflected sun gained ${MJ(R.reflGain)} | fence warmth: model ${MJ(R.lwModel)} (face up to +${R.faceMaxModel.toFixed(1)} C), two faces ${MJ(R.lwTwoFace)} (+${R.faceMaxTwo.toFixed(1)} C)`); });
// the sky it hides: a clear July day's open-lawn net longwave loss (FAO-56 eq. 39 at 29/16 C, 1.6 kPa, clear): ~4.4 MJ/m2
const rnl = 4.4;
spots.forEach((sp) => console.log(`${sp.name.padEnd(26)} sky hidden: ${(F(sp.d) * rnl).toFixed(2)} MJ less lost to the sky over 24 h`));
