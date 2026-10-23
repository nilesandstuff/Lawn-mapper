/**
 * WHAT COULD BE BETTER ABOUT THE SYSTEM ITSELF (owner, 2026-10-23: "When all the head stuff is done, suggest
 * changes to the system if there's problems with coverage/pressure. Like adjusting arcs or reducing nozzle gpm.
 * But leave room for fixes that just involve running zones for longer times (which will be the main focus of the
 * final step)").
 *
 * The line between the two: a run time can give a zone as a whole more or less water, so a zone that puts down
 * less than another, or more than its soil takes in an hour, is the schedule's to answer (cycle and soak). What a
 * run time cannot change is how the water is shared out WITHIN a zone -- a head over or under its pressure, a
 * rotor and a spray on one valve, a head laying down twice its neighbours' rate, lawn no head reaches, water
 * thrown on the house -- and those are what this lists, each with the change that answers it.
 *
 * Pure. heads: [{ id, zone, kind ('spray' | 'rotary' | 'rotor' | 'impact' | 'bubbler'), at [lng, lat], gpm,
 * radiusM (its throw now), fullRadiusM (with its radius screw open), arc, dir, strip, profile, cut, throw,
 * status ('ok' | 'low' | 'high'), psi, chartLo, chartHi, regulated, adjustable, fixedArc, arcMax, label }]
 * cover: { p (lib/precip.js precipitation), W, H, cellM, at(c, r) -> [lng, lat], lawnFlag } | null
 * groundAt(at) -> 'wall' | 'paved' | 'road' | 'lawn' | ... | null
 * -> [{ kind, zone, heads: [ids], at (where to mark it), text, fix, rank }], most important first
 */

import { enu } from './heads.js';
import { rateAt } from './precip.js';

const FT_PER_M = 3.28084, SQFT_PER_M2 = 10.7639;
const HARD = new Set(['wall', 'paved', 'road']);
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null; };
const ROTATING = new Set(['rotor', 'impact']);
/** A head's own rate, in/h: its flow over the ground it throws on. */
export function ownRate(h) {
  if (!(h.gpm > 0)) return null;
  const ft2 = h.strip ? h.strip.lengthM * h.strip.widthM * SQFT_PER_M2 : Math.PI * h.radiusM * h.radiusM * ((h.arc ?? 360) / 360) * SQFT_PER_M2;
  return ft2 > 0 ? (96.25 * h.gpm) / ft2 : null;
}
/** The rate class a head belongs to: rotors and impact heads, rotary nozzles, sprays (bubblers apart). */
const rateClass = (k) => (ROTATING.has(k) ? 'rotor' : k === 'rotary' ? 'rotary' : k === 'bubbler' ? 'bubbler' : 'spray');
const CLASS_WORD = { rotor: 'rotors', rotary: 'rotary nozzles', spray: 'spray nozzles', bubbler: 'bubblers' };

export function suggestions({ heads, cover = null, groundAt = null } = {}) {
  const out = [];
  const zonesOf = [...new Set(heads.map((h) => h.zone).filter((z) => z !== null && z !== undefined))].sort((a, b) => a - b);
  const mid = (hs) => [hs.reduce((s, h) => s + h.at[0], 0) / hs.length, hs.reduce((s, h) => s + h.at[1], 0) / hs.length];

  for (const z of zonesOf) {
    const hs = heads.filter((h) => h.zone === z && h.gpm > 0);
    if (!hs.length) continue;
    const zoneGpm = hs.reduce((s, h) => s + h.gpm, 0);
    // 1. PRESSURE OVER THE CHART: misting, the wind takes it
    const high = hs.filter((h) => h.status === 'high');
    if (high.length) {
      const top = Math.round(Math.max(...high.map((h) => h.psi))), lim = Math.round(Math.min(...high.map((h) => h.chartHi)));
      const sprays = high.filter((h) => !ROTATING.has(h.kind)).length;
      out.push({
        kind: 'pressure-high', zone: z, heads: high.map((h) => h.id), at: mid(high), fix: 'pressure', rank: 80 + high.length,
        text: `Zone ${z}: ${high.length === hs.length ? 'every head gets' : `${high.length} of its ${hs.length} heads get`} more pressure than ${high.length > 1 ? 'their' : 'its'} nozzle${high.length > 1 ? "s'" : "'s"} chart goes to (up to ${top} psi, past ${lim}): the water breaks into a mist that drifts and evaporates. ${sprays ? 'Pressure-regulating spray bodies (marked PRS, PR or P30/P40 on the cap) hold the nozzle at its best pressure; they screw onto the same fitting, so it is one head at a time, with a little digging.' : 'Rotors with a built-in regulator (marked PRS or PRB) hold the nozzle at its best.'} One regulator for the zone does the same: a pressure-regulating module on its valve (Rain Bird PRS-Dial, Hunter Accu-Sync).`,
      });
    }
    // 2. PRESSURE UNDER THE CHART: short throw, dry rings between heads. Less flow on the zone raises it.
    const low = hs.filter((h) => h.status === 'low');
    if (low.length) {
      const least = Math.round(Math.min(...low.map((h) => h.psi))), need = Math.round(Math.max(...low.map((h) => h.chartLo)));
      const heavy = hs.slice().sort((a, b) => b.gpm - a.gpm).slice(0, Math.min(3, hs.length));
      const sprayZone = hs.every((h) => rateClass(h.kind) === 'spray');
      out.push({
        kind: 'pressure-low', zone: z, heads: low.map((h) => h.id), at: mid(low), fix: 'nozzle', rank: 90 + low.length,
        text: `Zone ${z}: ${low.length === hs.length ? 'every head gets' : `${low.length} of its ${hs.length} heads get`} less pressure than ${low.length > 1 ? 'their' : 'its'} nozzle${low.length > 1 ? 's need' : ' needs'} (down to ${least} psi, under ${need}): the water falls short of the next heads. The zone draws ${zoneGpm.toFixed(1)} gpm; a zone that draws less loses less on the way, so its heads get more. ${sprayZone ? `Rotary nozzles (Rain Bird R-VAN, Hunter MP Rotator, Toro Precision Rotating) screw onto the same spray bodies and use about a third to half the water of a spray nozzle; change the whole zone together, so its heads still match.` : `Smaller nozzles in the heaviest heads (${heavy.map((h) => `${h.label || 'a nozzle'} at ${h.gpm.toFixed(1)} gpm`).join(', ')}) lower the zone's draw; change matched sets, so the heads still put down alike.`} Splitting the zone onto two valves does it too.`,
      });
    }
    // 3. ROTORS AND SPRAYS ON ONE VALVE: no run time suits both
    const byClass = new Map();
    for (const h of hs) { const c = rateClass(h.kind), r = ownRate(h); if (!Number.isFinite(r)) continue; if (!byClass.has(c)) byClass.set(c, []); byClass.get(c).push(r); }
    if (byClass.size > 1) {
      const rates = [...byClass].map(([c, v]) => [c, med(v)]).sort((a, b) => b[1] - a[1]);
      const [fast, slow] = [rates[0], rates[rates.length - 1]];
      if (fast[1] > 1.6 * slow[1]) {
        out.push({
          kind: 'mixed', zone: z, heads: hs.filter((h) => rateClass(h.kind) === slow[0]).map((h) => h.id), at: mid(hs), fix: 'nozzle', rank: 85,
          text: `Zone ${z} mixes ${CLASS_WORD[fast[0]]} (about ${fast[1].toFixed(2)} in/h) with ${CLASS_WORD[slow[0]]} (about ${slow[1].toFixed(2)} in/h) on one valve. Whatever the run time, the ${CLASS_WORD[slow[0]]}' ground gets about ${Math.round((slow[1] / fast[1]) * 100)}% of the water the ${CLASS_WORD[fast[0]]}' gets. Put one kind on the zone: ${slow[0] === 'rotor' || fast[0] === 'rotor' ? 'the sprays changed to rotary nozzles comes closest to rotors\' rate' : 'the spray nozzles changed to rotary nozzles, or the other way round'}.`,
        });
      }
    }
    // 4. A HEAD LAYING DOWN FAR MORE OR LESS THAN THE ZONE'S OTHERS OF ITS KIND (unmatched precipitation)
    for (const [c] of byClass) {
      const same = hs.filter((h) => rateClass(h.kind) === c), m = med(same.map(ownRate));
      if (same.length < 3 || !(m > 0)) continue;
      const odd = same.filter((h) => { const r = ownRate(h); return r > 1.7 * m || r < m / 1.7; });
      if (!odd.length || odd.length > same.length / 3) continue;
      const hi = odd.filter((h) => ownRate(h) > m);
      out.push({
        kind: 'unmatched', zone: z, heads: odd.map((h) => h.id), at: mid(odd), fix: 'nozzle', rank: 60 + odd.length,
        text: `Zone ${z}: ${odd.length === 1 ? 'one head puts' : `${odd.length} heads put`} down ${hi.length === odd.length ? 'far more' : hi.length ? 'far more or far less' : 'far less'} than the zone's other ${CLASS_WORD[c]} (${odd.map((h) => `${ownRate(h).toFixed(2)}`).join(', ')} in/h against about ${m.toFixed(2)}). A nozzle of matched precipitation fixes it: a half-circle nozzle puts out half a full circle's water, a quarter a quarter (an adjustable nozzle does this by itself as its arc is set).${odd.some((h) => (h.throw ?? 1) < 0.8 && !ROTATING.has(h.kind)) ? ' A spray screwed well down also lays down less than its neighbours: a nozzle with a shorter throw, screw open, evens it.' : ''}`,
      });
    }
  }

  // 5. LAWN NO HEAD REACHES, OR GETS LITTLE (from the coverage, where every zone runs its own time)
  if (cover?.p && cover.lawnFlag) {
    const { p, W, H, cellM, lawnFlag } = cover, cellFt2 = cellM * cellM * SQFT_PER_M2;
    const seen = new Uint8Array(W * H);
    const clusters = [];
    for (const [lim, kind] of [[0, 'missed'], [0.5, 'dry']]) {
      for (let i = 0; i < W * H; i++) {
        if (seen[i] || !lawnFlag[i] || !(kind === 'missed' ? p.coverage[i] <= 0 : p.coverage[i] > 0 && p.coverage[i] < lim)) continue;
        const cells = [], q = [i];
        seen[i] = 1;
        while (q.length) {
          const j = q.pop(); cells.push(j);
          const r = Math.floor(j / W), c = j % W;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc, k = rr * W + cc;
            if (rr < 0 || cc < 0 || rr >= H || cc >= W || seen[k] || !lawnFlag[k]) continue;
            if (kind === 'missed' ? p.coverage[k] > 0 : !(p.coverage[k] > 0 && p.coverage[k] < lim)) continue;
            seen[k] = 1; q.push(k);
          }
        }
        if (cells.length * cellFt2 >= (kind === 'missed' ? 10 : 25)) {
          const cr = cells.reduce((s, j) => s + Math.floor(j / W), 0) / cells.length, cc = cells.reduce((s, j) => s + (j % W), 0) / cells.length;
          // the cell of the cluster nearest its middle (a ring-shaped cluster's middle can lie outside it)
          const best = cells.reduce((b, j) => { const d = (Math.floor(j / W) - cr) ** 2 + ((j % W) - cc) ** 2; return d < b.d ? { j, d } : b; }, { j: cells[0], d: Infinity }).j;
          clusters.push({ kind, ft2: cells.length * cellFt2, at: cover.at(best % W, Math.floor(best / W)) });
        }
      }
    }
    clusters.sort((a, b) => b.ft2 - a.ft2);
    for (const cl of clusters.slice(0, 6)) {
      const near = heads.filter((h) => h.gpm > 0).map((h) => {
        const [e, n] = enu(h.at, cl.at), d = Math.hypot(e, n), bearing = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
        let off = Math.abs(bearing - (h.dir ?? 0)) % 360; if (off > 180) off = 360 - off;
        const inArc = h.strip ? false : (h.arc ?? 360) >= 359 || off <= (h.arc ?? 360) / 2;
        return { h, d, inArc, off };
      }).sort((a, b) => a.d - b.d);
      const size = `about ${Math.round(cl.ft2 / 5) * 5 || Math.round(cl.ft2)} sq ft of lawn`;
      // a head whose throw, screw open, would reach it
      const reach = near.find((x) => x.d <= x.h.fullRadiusM * 0.95);
      const what = cl.kind === 'missed' ? 'gets no water' : 'gets under half of what the rest gets';
      let text, fix, ids;
      if (reach && reach.inArc && reach.d <= reach.h.radiusM * 0.9) {
        // inside a head's throw, but near its end where little falls, and no other head reaches in: spacing
        fix = 'head'; ids = [reach.h.id];
        text = `${size} ${what}. It is ${Math.round(reach.d * FT_PER_M)} ft from a zone ${reach.h.zone} head that throws ${Math.round(reach.h.radiusM * FT_PER_M)} ft, near the end of its throw where little falls, and no other head reaches in to make it up. Heads are meant to throw to each other (head to head): one more head there, or nozzles with longer throws on the heads round it, closes the gap.`;
      } else if (reach && reach.inArc && reach.d > reach.h.radiusM * 0.9) {
        const short = (reach.h.throw ?? 1) < 0.97;
        fix = short ? 'arc' : 'pressure'; ids = [reach.h.id];
        text = `${size} ${what}, just past the reach of a zone ${reach.h.zone} head (${Math.round(reach.d * FT_PER_M)} ft away, throwing ${Math.round(reach.h.radiusM * FT_PER_M)} ft). ${short ? `Its radius screw is turned in (${Math.round((reach.h.throw ?? 1) * 100)}% of its throw): opening it reaches the spot; drag its yellow square out in the arcs step.` : `It throws short for want of pressure: see zone ${reach.h.zone}'s pressure above.`}`;
      } else if (reach && !reach.inArc && !reach.h.strip) {
        const canOpen = reach.h.adjustable && (reach.h.arc ?? 360) < (reach.h.arcMax ?? 360) - 5;
        const atWidest = reach.h.adjustable && !canOpen;
        fix = atWidest ? 'nozzle' : 'arc'; ids = [reach.h.id];
        text = atWidest
          ? `${size} ${what}, behind a zone ${reach.h.zone} head (${Math.round(reach.d * FT_PER_M)} ft away) whose arc is already as wide as its nozzle goes (${Math.round(reach.h.arc)}°). A nozzle that opens wider, up to a full circle, would reach it; turning this one would only uncover lawn on its other side.`
          : `${size} ${what}, beside a zone ${reach.h.zone} head that ${canOpen ? 'could open its arc to it' : 'could turn to it'} (${Math.round(reach.d * FT_PER_M)} ft away, ${Math.round(reach.off)}° off the middle of its arc). ${canOpen ? 'Widen that edge of its arc' : 'Turn it'} in the arcs step${reach.h.fixedArc ? ', or give it an adjustable nozzle' : ''}${cl.kind === 'dry' ? '; the fit kept it off paving or another head\'s ground there, so check the map before and after' : ''}.`;
      } else {
        const n0 = near[0];
        fix = 'head'; ids = n0 ? [n0.h.id] : [];
        text = `${size} ${what}${n0 ? `, ${Math.round(n0.d * FT_PER_M)} ft from the nearest head (zone ${n0.h.zone}, throwing ${Math.round(n0.h.radiusM * FT_PER_M)} ft)` : ''}: out of every head's reach. If it is lawn you mean to water, it needs heads of its own${cl.ft2 < 400 ? ', or a nozzle with a longer throw on the nearest' : ''}; if not (lawn left to the rain, or not lawn at all), leave it.`;
      }
      out.push({ kind: cl.kind, zone: near[0]?.h.zone ?? null, heads: ids, at: cl.at, fix, rank: (cl.kind === 'missed' ? 50 : 30) + Math.min(40, cl.ft2 / 10), text });
    }
  }

  // 6. WATER THROWN ON THE HOUSE, A DRIVE OR THE STREET (a fifth of a head's water or more, after the fit)
  if (cover && groundAt) {
    const { W, H, cellM } = cover;
    for (const h of heads) {
      if (!(h.gpm > 0)) continue;
      let all = 0, hard = 0, wall = 0;
      const reach = (h.strip ? Math.max(h.strip.lengthM, h.strip.widthM) : h.radiusM * 1.3) + cellM;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const at = cover.at(c, r), [e, n] = enu(h.at, at);
        if (Math.abs(e) > reach || Math.abs(n) > reach) continue;
        const v = rateAt(h, e, n);
        if (!(v > 0)) continue;
        all += v;
        const g = groundAt(at);
        if (HARD.has(g)) { hard += v; if (g === 'wall') wall += v; }
      }
      if (all > 0 && hard / all >= 0.2) {
        out.push({
          kind: 'overspray', zone: h.zone, heads: [h.id], at: h.at, fix: 'arc', rank: 20 + Math.round((hard / all) * 40),
          text: `A zone ${h.zone} head throws about ${Math.round((hard / all) * 100)}% of its water on ${wall > hard / 2 ? 'the house' : 'paving or the street'}, even with its arc fitted. ${h.adjustable ? 'Pull its arc in, or shorten its throw, in the arcs step; the lawn at its edge may then need the next head to reach it.' : h.strip ? 'A strip nozzle of another length or width would fit the ground better.' : 'Its pattern is fixed: an adjustable nozzle, or one of a smaller arc, would keep the water on the lawn.'}`,
        });
      }
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/**
 * What the run times will answer, so it is not listed as a fault: each zone's own rate over the lawn it waters
 * (zoneMean, in/h). -> { lo, hi } zones, or null when they are close.
 */
export function betweenZones(zoneMean) {
  const v = [...zoneMean].filter(([, r]) => r > 0).sort((a, b) => a[1] - b[1]);
  if (v.length < 2 || v[v.length - 1][1] < 1.3 * v[0][1]) return null;
  return { lo: { zone: v[0][0], inH: v[0][1] }, hi: { zone: v[v.length - 1][0], inH: v[v.length - 1][1] } };
}

/** The lower-quarter uniformity over the lawn the heads reach (lawn no head reaches is its own finding, above). */
export function duReached(p, lawnFlag) {
  const v = [];
  for (let i = 0; i < p.coverage.length; i++) if (lawnFlag[i] && p.coverage[i] > 0) v.push(p.coverage[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length, q = v.slice(0, Math.max(1, Math.floor(v.length / 4)));
  return mean > 0 ? q.reduce((s, x) => s + x, 0) / q.length / mean : 0;
}
