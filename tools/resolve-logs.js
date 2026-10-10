/**
 * AFTER A DEPLOY, EVERY OPEN ENTRY ON THE TWO LOGS IS CHECKED AGAIN (owner,
 * 2026-10-10: "if the nightly check fixes it, or you fix it, then it
 * switches to resolved and includes a description of what was fixed ... so
 * I can audit whether the nightly check makes mistakes when fixing").
 *
 * The parcel gaps: a place is resolved when the registry just deployed now
 * serves it -- the county's own entry, or its state's statewide one. The
 * resolution names the service, when it was verified, and the commit that
 * brought it (its author tells the nightly search from a person).
 *
 * The county photo failures: a refusal, a missing picture, a cache that
 * could not be stitched, a timeout -- the SAME request is tried again
 * against the site just deployed, and it is resolved only if the picture
 * now comes back. Gaps, a soft picture, a service passed over: resolved
 * when the lot's first-choice county service has changed, which is what a
 * re-catalogued county looks like. Nothing is resolved on a guess.
 *
 * Who fixed it: 'nightly' when the deploy was started by the nightly search
 * (the bot), 'claude' when the deployed commit carries a Claude-Session
 * trailer, else the person who deployed. Never fails the deploy.
 *
 *   SITE=https://lawnmap.example node tools/resolve-logs.js
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { query, flatSql } from './corpus-db.js';
import { ALL_COUNTIES, countyName } from '../worker/src/counties.js';

const SITE = (process.env.SITE || '').replace(/\/$/, '');
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const git = (args) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

/** The registry entry that serves a place, by county name or statewide. */
export function registryEntryFor(county, state, registry = ALL_COUNTIES) {
  const want = countyName(county);
  const st = String(state || '').trim().toUpperCase();
  let statewide = null;
  for (const [key, e] of Object.entries(registry)) {
    if (e.statewide) { if (e.state === st) statewide = { key, ...e }; continue; }
    if (want && countyName(e.name) === want && (!st || String(e.name).trim().endsWith(`, ${st}`))) return { key, ...e };
  }
  return statewide;
}

/** Who to credit, from how this deploy came about. */
export function attribution({ actor = process.env.GITHUB_ACTOR || '', headMessage = '' } = {}) {
  if (/github-actions/.test(actor)) return 'nightly';
  if (/Claude-Session:|Co-Authored-By: Claude/i.test(headMessage)) return 'claude';
  return actor || 'deploy';
}

/**
 * The commit that brought a registry entry, for the audit trail -- and WHO
 * is credited with the fix: that commit's author, not whoever happened to
 * deploy it. The nightly search's entries land through the bot's commits
 * and are its to answer for, whoever presses deploy afterwards.
 */
function registryCommit(key) {
  const raw = git(['log', '-1', '--format=%h%x1f%an%x1f%ad%x1f%s%x1f%B', '--date=short', `-S'${key}'`, '--', 'worker/src/counties-verified.js']);
  if (!raw) return null;
  const [sha, author, date, subject, body] = raw.split('\x1f');
  return { line: `${sha} ${author} ${date} ${subject}`, by: attribution({ actor: author, headMessage: body || '' }) };
}

async function fetchJson(u) {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function resolveGaps(by, sha) {
  /* The first pass (2026-10-10) credited the deployer for entries the bot's
     commits had brought. Re-credit from the text, which names the commit;
     idempotent, so it costs nothing on every later deploy. */
  query(`UPDATE parcel_gaps SET resolved_by = 'nightly'
          WHERE status = 'resolved' AND resolved_by <> 'nightly' AND resolution LIKE '%from commit % github-actions[bot] %'`);
  const open = query("SELECT county, state, COUNT(*) n FROM parcel_gaps WHERE status = 'open' GROUP BY county, state");
  let done = 0;
  for (const g of open) {
    const e = registryEntryFor(g.county, g.state);
    if (!e) continue;
    const brought = registryCommit(e.key);
    const credit = brought?.by || by;
    const text = `${e.statewide ? 'statewide' : 'the county\'s'} parcel lines: ${e.service} (layer ${e.layer}), verified ${e.checked || '?'}`
      + `${brought ? `; registry entry from commit ${brought.line}` : ''}; deployed ${sha}`;
    query(`UPDATE parcel_gaps SET status = 'resolved', resolved_at = ${lit(new Date().toISOString())}, resolved_by = ${lit(credit)},
             resolution = ${lit(text.slice(0, 600))} WHERE county = ${lit(g.county)} AND state = ${lit(g.state)} AND status = 'open'`);
    done++;
    console.log(`resolved (${credit}): ${g.county}, ${g.state} -- ${text}`);
  }
  return { done, left: open.length - done };
}

const RETRY_KINDS = new Set(['refused', 'missing', 'blank', 'no-service', 'timeout']);
const CHANGE_KINDS = new Set(['gaps', 'soft', 'passed-over']);

async function resolveFailures(by, sha) {
  const open = query("SELECT id, kind, lng, lat, zoom, frame, svc_id, svc_title FROM county_photo_failures WHERE status = 'open' ORDER BY id");
  let done = 0;
  for (const f of open) {
    if (!SITE || !Number.isFinite(Number(f.lng)) || !Number.isFinite(Number(f.lat))) continue;
    let frame = null;
    try { frame = f.frame ? JSON.parse(f.frame) : null; } catch { frame = null; }
    let text = null;
    if (RETRY_KINDS.has(f.kind) && f.svc_id != null) {
      const q = new URLSearchParams({
        lng: f.lng, lat: f.lat, zoom: frame?.zoom ?? f.zoom ?? 19, size: frame?.size || 640, height: frame?.height || frame?.size || 480,
        provider: 'county', svc: f.svc_id, cv: '2',
      });
      let res = null;
      try { res = await fetch(`${SITE}/api/imagery?${q}`, { signal: AbortSignal.timeout(90000) }); } catch { res = null; }
      if (res?.ok && /^image\//.test(res.headers.get('content-type') || '')) {
        const bytes = (await res.arrayBuffer()).byteLength;
        text = `tried the same request again after deploy ${sha}: service #${f.svc_id} now answers (HTTP 200, ${Math.round(bytes / 1024)} KB)`;
      }
    } else if (CHANGE_KINDS.has(f.kind)) {
      const j = await fetchJson(`${SITE}/api/county-imagery?lng=${f.lng}&lat=${f.lat}`);
      const first = j?.service;
      if (first && Number(first.id) !== Number(f.svc_id)) {
        text = `the lot's county photo is now service #${first.id} "${first.title}" (${first.year || '?'}) instead of #${f.svc_id}${f.svc_title ? ` "${f.svc_title}"` : ''}; deployed ${sha}`;
      }
    }
    if (!text) continue;
    query(`UPDATE county_photo_failures SET status = 'resolved', resolved_at = ${lit(new Date().toISOString())}, resolved_by = ${lit(by)},
             resolution = ${lit(text.slice(0, 600))} WHERE id = ${Number(f.id)}`);
    done++;
    console.log(`resolved #${f.id} (${f.kind}): ${text}`);
  }
  return { done, left: open.length - done };
}

async function main() {
  const sha = (process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'])).slice(0, 7);
  const by = attribution({ headMessage: git(['log', '-1', '--format=%B']) });
  let summary;
  try {
    const gaps = await resolveGaps(by, sha);
    const photos = await resolveFailures(by, sha);
    summary = `${gaps.done} parcel gap${gaps.done === 1 ? '' : 's'} and ${photos.done} county photo failure${photos.done === 1 ? '' : 's'} resolved by this deploy (credited to ${by}); `
      + `${gaps.left} gap${gaps.left === 1 ? '' : 's'} and ${photos.left} failure${photos.left === 1 ? '' : 's'} still open`;
  } catch (e) {
    summary = `could not re-check the logs: ${String(e?.message || e).slice(0, 120)}`;
  }
  console.log(summary);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `LOGS_RESOLVED=${summary}\n`);
}

if (process.argv[1] && /resolve-logs\.js$/.test(process.argv[1])) await main();
