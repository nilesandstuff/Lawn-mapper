#!/usr/bin/env node
/**
 * THE TRAINING MAPS' LAYERS, BANKED IN R2 (owner, 2026-10-29: "cache bank
 * everything for the training maps, we don't need to be redownloading layers
 * (including imagery that the map was made on) for training maps, especially
 * since they could change").
 *
 * The photograph each map was drawn on is in R2 already (corpus.image_key,
 * read by tools/train-detector.js). What every run of workflow 14 still
 * downloaded afresh was the lidar (USGS's octrees and tiles, an hour or more;
 * 4.5 hours when rockyweb stalls) and NAIP (USGS's ImageServer). Both are
 * kept here per lot, the way they were first read:
 *
 *   bank/<layer>/<file>        one file a lot (lidar-points/<id>.npz, the
 *                              frame's raw points keyed by flight and box;
 *                              naip-raw/<id>.png + .json, USGS's answer and
 *                              the box it answered)
 *   bank/<layer>/index.json    { files: { <file>: { sha256, bytes, at } } }
 *
 * R2 has no listing through wrangler, so the index is the list. Two runs
 * saving at once can drop each other's new entries from it; those files are
 * banked again by the next run, never lost from a run's own folder.
 *
 *   node tools/bank.js restore <layer> <dir> [frames/scale.json]
 *   node tools/bank.js save <layer> <dir>
 *
 * restore fetches the banked files the folder lacks (or holds differently),
 * only for the lots in scale.json when it is given; save puts the files the
 * bank lacks or holds differently. The readers decide whether a file fits
 * (lidar_sources.read_points checks its key, naip_bands its box), so a stale
 * file costs a re-read, never a wrong answer.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const PREFIX = 'bank';
export const LAYERS = ['lidar-points', 'naip-raw'];
const AT_ONCE = 6;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const indexKey = (layer) => `${PREFIX}/${layer}/index.json`;
export const fileKey = (layer, file) => `${PREFIX}/${layer}/${file}`;

/** The lot a banked file belongs to: its name up to the extension. */
export const lotOf = (file) => file.replace(/\.(npz|png|json)$/, '');

/** Which banked files to fetch: those of the wanted lots the folder lacks or holds differently. */
export function toRestore(index, local, wanted = null) {
  return Object.entries(index?.files || {})
    .filter(([f]) => !wanted || wanted.has(lotOf(f)))
    .filter(([f, e]) => local[f] !== e.sha256)
    .map(([f]) => f)
    .sort();
}

/** Which local files to put: those the bank lacks or holds differently. */
export function toSave(index, local) {
  return Object.entries(local).filter(([f, h]) => index?.files?.[f]?.sha256 !== h).map(([f]) => f).sort();
}

/** The folder's files and their hashes (no sub-folders, no partial writes). */
export function localHashes(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || f.name.endsWith('.part') || f.name === 'index.json') continue;
    out[f.name] = sha256(readFileSync(join(dir, f.name)));
  }
  return out;
}

async function wrangler(args) {
  return run('npx', ['wrangler', 'r2', 'object', ...args, '--remote'], { maxBuffer: 1 << 26 });
}

async function getObject(bucket, key, file) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await wrangler(['get', `${bucket}/${key}`, '--file', file]);
      return true;
    } catch {
      if (attempt === 3) return false;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

async function putObject(bucket, key, file, type = 'application/octet-stream') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await wrangler(['put', `${bucket}/${key}`, '--file', file, '--content-type', type]);
      return true;
    } catch {
      if (attempt === 3) return false;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

async function readIndex(bucket, layer) {
  const tmp = join(tmpdir(), `bank-index-${process.pid}-${Date.now()}.json`);
  try {
    if (!(await getObject(bucket, indexKey(layer), tmp))) return { files: {} };
    return JSON.parse(readFileSync(tmp, 'utf8'));
  } catch {
    return { files: {} };
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function inBatches(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += AT_ONCE) results.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(fn))));
  return results;
}

async function restore(bucket, layer, dir, scaleFile) {
  const t0 = Date.now();
  const index = await readIndex(bucket, layer);
  let wanted = null;
  if (scaleFile && existsSync(scaleFile)) wanted = new Set(Object.keys(JSON.parse(readFileSync(scaleFile, 'utf8')).boxes || {}));
  mkdirSync(dir, { recursive: true });
  const want = toRestore(index, localHashes(dir), wanted);
  const ok = await inBatches(want, (f) => getObject(bucket, fileKey(layer, f), join(dir, f)));
  const got = ok.filter(Boolean).length;
  const lots = wanted ? wanted.size : new Set(Object.keys(index.files || {}).map(lotOf)).size;
  const banked = new Set(Object.keys(index.files || {}).map(lotOf).filter((l) => !wanted || wanted.has(l))).size;
  console.log(`BANK ${layer}: ${banked} of ${lots} lots banked; ${got} file(s) restored${got < want.length ? `, ${want.length - got} could not be read` : ''} in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

async function save(bucket, layer, dir) {
  const t0 = Date.now();
  const local = localHashes(dir);
  const index = await readIndex(bucket, layer);
  const put = toSave(index, local);
  const ok = await inBatches(put, (f) => putObject(bucket, fileKey(layer, f), join(dir, f),
    f.endsWith('.json') ? 'application/json' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream'));
  // The index read again just before it is written, so a run saving alongside loses as little as possible.
  const fresh = await readIndex(bucket, layer);
  const files = { ...(fresh.files || {}) };
  const at = new Date().toISOString();
  put.forEach((f, i) => { if (ok[i]) files[f] = { sha256: local[f], bytes: readFileSync(join(dir, f)).length, at }; });
  const tmp = join(tmpdir(), `bank-index-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify({ files }, null, 0));
  const wrote = await putObject(bucket, indexKey(layer), tmp, 'application/json');
  rmSync(tmp, { force: true });
  const good = ok.filter(Boolean).length;
  console.log(`BANK ${layer}: ${good} new or changed file(s) banked${good < put.length ? `, ${put.length - good} failed` : ''}; ${Object.keys(files).length} in the bank${wrote ? '' : ' (THE INDEX WAS NOT WRITTEN: the next run sees the old list)'} in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, layer, dir, scale] = process.argv.slice(2);
  const bucket = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
  if (!['restore', 'save'].includes(cmd) || !LAYERS.includes(layer) || !dir) {
    console.error(`usage: node tools/bank.js restore|save <${LAYERS.join('|')}> <dir> [frames/scale.json]`);
    process.exit(2);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.log(`BANK ${layer}: no CLOUDFLARE_API_TOKEN, so nothing ${cmd === 'restore' ? 'restored' : 'banked'}.`);
    process.exit(0);
  }
  (cmd === 'restore' ? restore(bucket, layer, dir, scale) : save(bucket, layer, dir))
    .catch((e) => { console.log(`BANK ${layer}: ${cmd} failed (${String(e?.message || e).slice(0, 200)}); the run reads from USGS as before.`); });
}
