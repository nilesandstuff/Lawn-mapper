/**
 * WHY IS THERE NO FUSED MAP? (core session, 2026-11-24). The owner: "I opened my property in the shade map but I'm not
 * seeing the fused map at all". Neither page can tell the core session what it did (the owner's own events are not
 * recorded), so this looks from the server's side, for the map a walk was made on:
 *
 *   1. THE OWNER'S MAPS OF THAT PLACE. The owner has more than one map of one property (2026-11-09). A walk's plants
 *      go into ONE map's record: the one the walk was made on. For each map of the place: whether its record holds
 *      the scan tool's plants (how many boxes, the open air, which walk, when), whether the shade map has a part and
 *      a lidar model for it, and whether a fused model is kept beside that.
 *   2. THE FUSING ITSELF, RUN HERE on that map's lidar model and the plants its record holds (the shade page's own
 *      inputs), through the fusing's one module: what it made, or how it failed.
 *
 *   node scan/tools/fuse-check.mjs <walk>
 *
 * Prints counts, sizes and times only. A map is "map A", "map B": no ids, no places.
 */
import { createHash } from 'node:crypto';
import { BUCKET, CORPUS_BUCKET, readObject, walkOk, API, account, list } from './twin-r2.mjs';
import { loadModel, unpackModel } from '../../public/lib/lidar-model.js';
import { lidarInClear } from '../lib/clear-measure.js';

const MAIN_DB = 'lawn-mapper';
let d1 = null;
/** Rows from the main site's database, over the API (values bound, never spliced into the statement). */
async function sql(statement, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN, h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (!d1) {
    const j = await (await fetch(`${API}/accounts/${await account(token)}/d1/database?name=${MAIN_DB}`, { headers: h })).json();
    const id = (j.result || []).find((d) => d.name === MAIN_DB)?.uuid;
    if (!id) throw new Error('the main database could not be found');
    d1 = `${API}/accounts/${await account(token)}/d1/database/${id}/query`;
  }
  for (let t = 0; t < 4; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, 3000 * t));
    const r = await fetch(d1, { method: 'POST', headers: h, body: JSON.stringify({ sql: statement, params }) }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j?.success) return j.result?.[0]?.results || [];
  }
  throw new Error('the main database would not answer (asked four times)');
}
const metres = (a, b) => { const k = Math.cos((a[1] * Math.PI) / 180), R = 6378137, d = Math.PI / 180; return Math.hypot((b[0] - a[0]) * d * R * k, (b[1] - a[1]) * d * R); };
const when = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) + ' UTC' : 'never');

async function main() {
  const walk = process.argv[2];
  if (!walkOk(walk)) throw new Error('which walk?');
  const mb = await readObject(BUCKET, `twins/${walk}/meta.json`);
  const key = mb ? JSON.parse(mb.toString()).map : null;
  if (!key) throw new Error('the walk was made with no map open');
  const mine = (await sql('SELECT user_id, lng, lat FROM maps WHERE key = ? LIMIT 1', [key]))[0];
  if (!mine) { console.log('\nWHY NO FUSED MAP: the walk\'s map is not among the signed-in maps (a guest\'s, or deleted).'); return; }
  const uid = mine.user_id, at0 = [mine.lng, mine.lat];
  const maps = (await sql(`SELECT key, lng, lat, updated_at, (payload LIKE '%"adminSave":true%') AS admin_save FROM maps WHERE user_id = ?`, [uid])).filter((m) => Number.isFinite(m.lng) && Number.isFinite(m.lat) && metres(at0, [m.lng, m.lat]) <= 80);
  const tools = await sql(`SELECT map_key, tool, length(data) AS bytes, updated_at, json_array_length(json_extract(data, '$.plants.boxes')) AS boxes, json_extract(data, '$.plants.walk') AS pwalk, json_extract(data, '$.plants.at') AS pat, json_extract(data, '$.plants.seen.w') AS sw, json_extract(data, '$.plants.seenHigh.w') AS shw FROM map_tools WHERE owner_kind = 'user' AND owner_id = ? AND tool IN ('scan', 'shade')`, [uid]);
  const token = process.env.CLOUDFLARE_API_TOKEN, base = `${API}/accounts/${await account(token)}/r2/buckets/${CORPUS_BUCKET}`;
  maps.sort((a, b) => (a.key === key ? -1 : b.key === key ? 1 : String(b.updated_at).localeCompare(String(a.updated_at))));
  console.log(`\nWHY NO FUSED MAP? (walk ${walk}) THE OWNER'S MAPS OF THAT PLACE (within 260 ft of the walk's map): ${maps.length}.`);
  let i = 0, lidarKeyOfWalk = null, partsOfWalk = [], shiftOfWalk = null;
  for (const m of maps) {
    const name = `map ${String.fromCharCode(65 + i++)}${m.key === key ? ' (THE WALK\'S MAP)' : ''}`;
    const prefix = `models/user/${uid}/${createHash('sha256').update(m.key).digest('hex')}/`;
    const objs = await list(base, token, prefix).catch(() => []);
    const obj = (n) => objs.find((o) => o.key === prefix + n);
    const lidar = obj('shade.bin'), fused = obj('shade-fused.bin');
    if (m.key === key) { lidarKeyOfWalk = lidar ? prefix + 'shade.bin' : null; partsOfWalk = objs.filter((o) => /\/shade\.\d+\.bin$/.test(o.key)).map((o) => o.key); }
    const sc = tools.find((t) => t.map_key === m.key && t.tool === 'scan'), sh = tools.find((t) => t.map_key === m.key && t.tool === 'shade');
    console.log(`  ${name}: saved ${when(m.updated_at)}${m.admin_save ? ', an admin save' : ''}. Shade map's part: ${sh ? `yes (${when(sh.updated_at)})` : 'NONE'}; lidar model: ${lidar ? when(lidar.last_modified) : 'NONE'}; FUSED MODEL: ${fused ? `${when(fused.last_modified)}, ${(fused.size / 1e6).toFixed(2)} MB` : 'NONE'}.`);
    // THE LINE-UP (the features session's caveat, 2026-11-24): a walk is fitted to ITS map's lidar as that map lined it up
    // (meta.lidar.shift, EPSG:3857 metres; real metres are that times cos(latitude)); lent to another map of the lot it sits
    // off by the difference of the two line-ups. And how far apart the two maps' points are. Metres only.
    if (lidar) {
      try {
        const lm = await unpackModel(new Uint8Array(await readObject(CORPUS_BUCKET, prefix + 'shade.bin')).buffer);
        const sh = lm.meta?.lidar?.shift, k = Math.cos((m.lat * Math.PI) / 180);
        const real = Array.isArray(sh) && sh.every(Number.isFinite) ? [sh[0] * k, sh[1] * k] : null;
        if (m.key === key) shiftOfWalk = real;
        const apart = metres(at0, [m.lng, m.lat]);
        console.log(`      Its lidar's line-up: ${real ? `moved ${Math.hypot(real[0], real[1]).toFixed(2)} m` : 'no shift kept (not moved, or not confident)'}${m.key !== key ? `${real && shiftOfWalk ? `; ${Math.hypot(real[0] - shiftOfWalk[0], real[1] - shiftOfWalk[1]).toFixed(2)} m from the walk's map's line-up` : real || shiftOfWalk ? '; the walk\'s map\'s line-up is ' + (shiftOfWalk ? `${Math.hypot(shiftOfWalk[0], shiftOfWalk[1]).toFixed(2)} m, this one none` : 'none') : ''}; its point is ${apart.toFixed(1)} m from the walk's map's point` : ''}; ${lm.meta?.grid?.w} x ${lm.meta?.grid?.h} columns.`);
      } catch (e) { console.log(`      Its lidar model could not be read (${String(e?.message || e).slice(0, 80)}).`); }
    }
    console.log(`      The scan tool's part of its record: ${sc ? `${(sc.bytes / 1e3).toFixed(0)} KB, written ${when(sc.updated_at)}; PLANTS: ${sc.boxes ? `${sc.boxes} boxes, from ${String(sc.pwalk) === String(walk) ? 'this walk' : 'another walk'}, made ${when(sc.pat)}; open air from the ground ${sc.sw ? 'yes' : 'NO'}, above 8 ft ${sc.shw ? 'yes' : 'NO'}` : 'NONE'}` : 'NONE (no plants: the shade map has nothing to fuse for this map)'}.`);
  }
  // the newest plants the workflow kept for the walk's map, against what the record holds
  const kept = await readObject(BUCKET, `plants/${key}.json`).catch(() => null);
  const keptJ = kept ? JSON.parse(kept.toString()) : null;
  console.log(`  Kept by the workflow for the walk's map (what the Yard AR start page puts into the record when that map is opened): ${keptJ ? `${keptJ.boxes?.length} boxes, made ${when(keptJ.at)}, ${(kept.length / 1e3).toFixed(0)} KB${keptJ.seenHigh ? ', with the air above 8 ft' : ''}` : 'NOTHING'}.`);

  // 2. the fusing, here, on the shade page's own inputs
  const row = (await sql(`SELECT data FROM map_tools WHERE owner_kind = 'user' AND owner_id = ? AND tool = 'scan' AND map_key = ?`, [uid, key]))[0];
  let plants = null;
  try { plants = row ? JSON.parse(row.data)?.plants || null : null; } catch { plants = null; }
  const from = plants?.boxes?.length ? 'the plants its record holds' : keptJ?.boxes?.length ? 'the plants kept by the workflow (the record holds none)' : null;
  if (!plants?.boxes?.length) plants = keptJ;
  if (!lidarKeyOfWalk || !plants?.boxes?.length) { console.log(`  THE FUSING, RUN HERE: not run (${!lidarKeyOfWalk ? 'the walk\'s map has no lidar model' : 'there are no plants to fuse'}).`); return; }
  try {
    const F = await import('../../public/shade/fuse.js');
    const t0 = Date.now();
    // the lidar model and its overflow parts, read from the bucket through the format's own loader
    const fromBucket = async (u) => {
      const part = /[?&]part=(\d+)/.exec(u)?.[1];
      const bytes = await readObject(CORPUS_BUCKET, part ? lidarKeyOfWalk.replace(/\.bin$/, `.${part}.bin`) : lidarKeyOfWalk);
      return bytes ? { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : { ok: false, status: 404 };
    };
    const lidar = await loadModel(fromBucket, 'model');
    const list_ = { length: lidar.meta.joined || 0 };
    const open = plants.seen && F.openFromSeen ? await F.openFromSeen(plants.seen, at0, F.fusedGrid(lidar.meta)) : null;
    const openHigh = plants.seenHigh && F.openHighFromSeen ? await F.openHighFromSeen(plants.seenHigh, at0, F.fusedGrid(lidar.meta)) : null;
    const openBare = plants.clearHigh ? await F.openHighFromSeen(plants.clearHigh, at0, F.fusedGrid(lidar.meta)) : null;
    const fused = F.fuseModel(lidar, plants, at0, { open, openHigh, ...(openBare ? { openBare } : {}) });
    const f = fused.meta?.fused || {}, g = fused.meta?.grid || {}, lg = lidar.meta?.grid || {};
    console.log(`  THE FUSING, RUN HERE on the walk's map's lidar model (${lg.w} x ${lg.h} columns, ${list_.length} overflow parts${partsOfWalk.length !== list_.length ? `, ${partsOfWalk.length} kept` : ''}) and ${from}: MADE, in ${((Date.now() - t0) / 1000).toFixed(1)} s. Version ${f.version ?? '?'}; grid ${g.w} x ${g.h}; ${f.refined ?? '?'} cells refined, ${f.added ?? '?'} added, ${f.trimmed ?? '?'} trimmed, ${(f.moved || []).length} trees moved; the walk in leaf: ${f.walkInLeaf ?? '?'}; with open air ${open ? 'yes' : 'no'}, above 8 ft ${openHigh ? 'yes' : 'no'}.`);
    // HOW MUCH OF THE LIDAR'S CROWN SITS IN AIR THE WALK SAW EMPTY IN ANY SEASON (clear-measure.js; SCAN-PLAN 62)
    const pc = keptJ?.clearHigh ? keptJ : plants;
    if (pc?.clearHigh) {
      const cl = await F.openHighFromSeen(pc.clearHigh, Array.isArray(pc.origin) ? pc.origin : at0, F.fusedGrid(lidar.meta));
      const q = lidarInClear(lidar, cl, F.FUSE_SUB || 2), cube = 0.25 * (lidar.meta.layers.dz || 1);
      const hz = q.clumps.hist;
      console.log(`  THE LIDAR'S CROWN IN AIR THE WALK SAW EMPTY IN ANY SEASON (${pc === keptJ ? 'the plants kept by the workflow' : 'the record'}): the walk's cleared air covers ${(q.cells * 0.25 * 10.764).toFixed(0)} sq ft of the fused grid; `
        + `in it ${q.crown.toLocaleString()} half-metre crown cells of the lidar's (${(q.crown * cube).toFixed(0)} cubic metres), ${q.crownDecid.toLocaleString()} of them a deciduous crown's; by height `
        + q.byHeight.map((b) => `${b.from}-${b.to > 100 ? 'up' : b.to} ft ${b.cubes.toLocaleString()}`).join(', ') + `; and ${q.roof.toLocaleString()} of the lidar's ROOF cells (a roof in empty air: the walk or the lidar misplaced there).`);
      console.log(`    The lidar's ${q.clumps.n} tree clumps, by how much of their crown from 8 to 30 ft is in that air: none ${hz.none}, under a quarter ${hz.under25}, a quarter to half ${hz.to50}, half to 90% ${hz.to90}, 90% or more ${hz.over90}; too little crown that low to judge ${hz.notJudged}.`
        + (q.clumps.mostlyClear.length ? ` The 90%-or-more ones (each: lidar columns, crown cells 8-30 ft, crown cells above 30 ft): ${q.clumps.mostlyClear.map((g) => `${g.cols}/${g.lower}/${g.upper}`).join('; ')}.` : ''));
    } else console.log('  The lidar\'s crown in air seen empty in any season: not measured (no clearHigh in the plants yet).');
  } catch (e) { console.log(`  THE FUSING, RUN HERE: FAILED: ${String(e?.message || e).slice(0, 300)}`); }
}

main().catch((e) => { console.log(`Fuse check: ${String(e.message || e).slice(0, 300)}`); process.exit(1); });
