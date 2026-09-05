/**
 * Probes each county GIS service to confirm the layer index and field names
 * in counties.js are still correct, and runs a real point lookup.
 *
 * Run this FIRST, from a machine with network access (Cloudflare Workers'
 * dev sandbox has no outbound fetch to arbitrary hosts by default, so plain
 * Node is the right place to run this, not `wrangler dev`):
 *   node tools/probe-counties.js
 *
 * Counties republish services without notice, so re-run this whenever
 * lookups start returning null for addresses that should be covered.
 */

import { COUNTIES } from '../worker/src/counties.js';
import { lookupParcel } from '../worker/src/parcel.js';
import { measure } from '../public/lib/area.js';
import { TEST_POINTS } from './test-points.js';

async function listLayers(key) {
  const cfg = COUNTIES[key];
  if (!cfg.service) return console.log(`  ${key}: no service configured`);

  try {
    const res = await fetch(`${cfg.service}?f=json`);
    const data = await res.json();
    if (data.error) return console.log(`  ${key}: ERROR ${data.error.message}`);

    const parcelLayers = (data.layers || []).filter((l) =>
      /parcel/i.test(l.name)
    );
    console.log(`  ${key}: ${(data.layers || []).length} layers total`);
    for (const l of parcelLayers) {
      const flag = l.id === cfg.layer ? ' <-- configured' : '';
      console.log(`      [${l.id}] ${l.name}${flag}`);
    }
    if (!parcelLayers.some((l) => l.id === cfg.layer)) {
      console.log(`      WARNING: configured layer ${cfg.layer} is not a parcel layer`);
    }
  } catch (e) {
    console.log(`  ${key}: unreachable (${e.message})`);
  }
}

async function checkFields(key) {
  const cfg = COUNTIES[key];
  if (!cfg.service) return;

  try {
    const res = await fetch(`${cfg.service}/${cfg.layer}?f=json`);
    const data = await res.json();
    if (data.error) return console.log(`  ${key}: layer error`);

    const names = (data.fields || []).map((f) => f.name);
    for (const [role, field] of Object.entries(cfg.fields)) {
      const ok = names.includes(field);
      console.log(`  ${key}.${role}: ${field} ${ok ? 'OK' : 'MISSING'}`);
      if (!ok) {
        const guess = names.filter((n) =>
          new RegExp(role.replace('streetNum', 'num').slice(0, 4), 'i').test(n)
        );
        if (guess.length) console.log(`      candidates: ${guess.join(', ')}`);
      }
    }
  } catch (e) {
    console.log(`  ${key}: field check failed (${e.message})`);
  }
}

async function endToEnd(key) {
  const points = TEST_POINTS[key];
  if (!points || !COUNTIES[key]?.service) return;

  // Try each point in turn. One address landing on a road right-of-way or an
  // unplatted lot is normal and says nothing about the endpoint.
  const tried = [];
  for (const pt of points) {
    const parcel = await lookupParcel(pt.lng, pt.lat);
    if (!parcel) {
      tried.push(`${pt.label}: none`);
      continue;
    }

    const m = measure(parcel.geometry);
    console.log(
      `  ${key} (${pt.label}): ${m.acres} ac / ${m.squareFeet.toLocaleString()} sq ft` +
        `  pin=${parcel.properties.pin}  addr=${parcel.properties.address}`
    );
    if (tried.length) console.log(`      (no parcel at ${tried.join(', ')})`);

    // Sanity: a residential parcel should not be 0 or absurdly large.
    if (m.acres < 0.01 || m.acres > 500) {
      console.log('      WARNING: implausible area -- check outSR handling');
    }
    return;
  }

  console.log(`  ${key}: NO PARCEL AT ANY TEST POINT (${tried.join(', ')})`);
}

(async () => {
  console.log('\n=== 1. Layer discovery ===');
  for (const key of Object.keys(COUNTIES)) await listLayers(key);

  console.log('\n=== 2. Field verification ===');
  for (const key of Object.keys(COUNTIES)) await checkFields(key);

  console.log('\n=== 3. End-to-end lookup ===');
  for (const key of Object.keys(TEST_POINTS)) await endToEnd(key);

  console.log('\nDone.');
})();
