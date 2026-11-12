/**
 * THE WALK'S OWN STOPWATCH (owner, 2026-11-12: "should we set up some sort of in-house analytics so we can
 * measure the lag/jitter/load times/etc." -- "yes build it but I want you to be able to read the data").
 *
 * The first walk with roof corners was "pretty slow to open the first time", "laggy and jittery", shapes "would
 * sway, sometimes take awhile to render", and its upload did not finish before dark. None of that was measured, so
 * every fix would have been a guess. This counts, on the phone, and the numbers ride in the walk's summary
 * (scan/src/walks.js; task `walks` prints them): times, sizes and counts only -- no positions, no addresses, no
 * URLs (a request is counted under a group's name, never its own).
 *
 *   OPENING   stage(name): seconds since the page began, for the map, the lidar, the earlier walk, the AR
 *             session and its first frame; resources(entries): what was downloaded, by group.
 *   FRAMES    frame(start, end): the gap between frames (what the eye sees as lag) and how long the page's own
 *             work on a frame took (whether the lag is ours).
 *   JITTER    pose(position, seconds): how far the camera's place moves from frame to frame WHILE THE PHONE IS
 *             HELD STILL (a still phone whose place moves is a shape that sways), and the jumps (ARCore
 *             correcting itself in one frame).
 *   WAITS     time(name, ms): one-off waits worth a line (building the lidar's shapes, a fix's answer).
 *   UPLOAD    part(ms, bytes, outcome): each part's own send; uploadOpen()/uploadDone(): first part kept to the
 *             last one gone.
 *
 * Pure: the clock is handed in. summary() is plain numbers.
 */

const STILL_MPS = 0.05;      // slower than this for STILL_FOR_S: held still
const STILL_FOR_S = 0.7;
const JUMP_M = 0.05;         // further than this in one frame (under JUMP_DT_S apart): a jump
const JUMP_DT_S = 0.12;
const LONG_MS = 50;          // a frame gap past this is one the eye catches (under 20 a second)
const STALL_MS = 250;        // and past this the picture stood still

/** A histogram of whole units up to `top`; percentiles without keeping every sample. */
export function hist(top) {
  const b = new Uint32Array(top + 1);
  let n = 0, max = 0, sum = 0;
  return {
    add(v) { if (!Number.isFinite(v) || v < 0) return; b[Math.min(top, Math.round(v))]++; n++; sum += v; if (v > max) max = v; },
    n: () => n,
    max: () => max,
    mean: () => (n ? sum / n : null),
    q(p) { if (!n) return null; let want = Math.max(1, Math.ceil(p * n)), i = 0; for (; i <= top; i++) { want -= b[i]; if (want <= 0) break; } return Math.min(i, top); },
  };
}

const r1 = (v) => (v == null ? null : +Number(v).toFixed(1));

/** A request's group: a name, never the URL. */
export function groupOf(name) {
  let path = '';
  try { path = new URL(name, 'https://x').pathname; } catch { return 'other'; }
  if (path.startsWith('/vendor/')) return 'engine';
  if (path.startsWith('/api/maps/model')) return 'lidar model';
  if (path.startsWith('/api/shade/lidar') || path.startsWith('/api/lidar')) return 'lidar';
  if (path.startsWith('/api/imagery')) return 'photo';
  if (path.startsWith('/api/scan/reference')) return 'earlier walk';
  if (path.startsWith('/api/scan/twin')) return 'upload';
  if (path.startsWith('/api/')) return 'api';
  if (/\.(js|mjs|html|css|wasm)$/.test(path) || path === '/') return 'page';
  return 'other';
}

/** PerformanceResourceTiming entries by group: how many, bytes over the air, how many came from the cache, the time. */
export function resources(entries) {
  const out = {};
  for (const e of entries || []) {
    const g = groupOf(e.name);
    if (g === 'upload') continue; // counted by part()
    const o = out[g] || (out[g] = { n: 0, kb: 0, cached: 0, ms: 0, slowestMs: 0 });
    o.n++;
    const bytes = Number(e.transferSize) || 0;
    o.kb += bytes / 1000;
    if (!bytes && (Number(e.decodedBodySize) || 0) > 0) o.cached++;
    const d = Number(e.duration) || 0;
    o.ms += d;
    if (d > o.slowestMs) o.slowestMs = d;
  }
  for (const o of Object.values(out)) { o.kb = Math.round(o.kb); o.ms = Math.round(o.ms); o.slowestMs = Math.round(o.slowestMs); }
  return out;
}

export function newPerf({ now = () => performance.now() } = {}) {
  const t0 = now();
  const stages = {};
  const gap = hist(1000), work = hist(500), still = hist(200), partMs = hist(60000);
  const times = {};
  let lastStart = null, frames = 0, long = 0, stalls = 0, firstFrameAt = null, lastFrameAt = null;
  let lastPos = null, lastT = null, stillFor = 0, jumps = 0, jumpMax = 0, stillS = 0;
  const up = { parts: 0, ok: 0, retry: 0, dropped: 0, bytes: 0, ms: 0, openedAt: null, doneAt: null };
  return {
    /** Seconds since the page began, kept under `name` the first time it is said. */
    stage(name) { if (stages[name] == null) stages[name] = r1((now() - t0) / 1000); },
    /** One frame: when the page began work on it and when it finished. */
    frame(start, end) {
      frames++;
      if (firstFrameAt == null) firstFrameAt = start;
      if (lastStart != null) { const g = start - lastStart; gap.add(g); if (g > LONG_MS) long++; if (g > STALL_MS) stalls++; }
      lastStart = start; lastFrameAt = end;
      work.add(end - start);
    },
    /** The camera's place this frame ([x, y, z] metres, seconds). */
    pose(pos, t) {
      if (!pos || !Number.isFinite(t)) return;
      const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
      if (lastPos && t > lastT) {
        const dt = t - lastT, d = Math.hypot(p[0] - lastPos[0], p[1] - lastPos[1], p[2] - lastPos[2]);
        if (dt < JUMP_DT_S && d > JUMP_M) { jumps++; if (d > jumpMax) jumpMax = d; stillFor = 0; }
        else if (dt < 0.5 && d / dt < STILL_MPS) { stillFor += dt; if (stillFor >= STILL_FOR_S) { still.add(d * 1000); stillS += dt; } }
        else stillFor = 0;
      }
      lastPos = p; lastT = t;
    },
    /** A one-off wait: the count, the total and the longest under `name`. */
    time(name, ms) { if (!Number.isFinite(ms)) return; const o = times[name] || (times[name] = { n: 0, ms: 0, longestMs: 0 }); o.n++; o.ms += ms; if (ms > o.longestMs) o.longestMs = ms; },
    uploadOpen() { if (up.openedAt == null) up.openedAt = now(); up.doneAt = null; },
    uploadDone() { if (up.openedAt != null && up.doneAt == null) up.doneAt = now(); },
    /** One part's own send. */
    part(ms, bytes, outcome) {
      up.parts++; up.ms += ms; partMs.add(ms);
      if (outcome === 'ok') { up.ok++; up.bytes += bytes || 0; } else if (outcome === 'drop') up.dropped++; else up.retry++;
    },
    summary(extra = {}) {
      const walkS = firstFrameAt != null && lastFrameAt != null ? (lastFrameAt - firstFrameAt) / 1000 : 0;
      const wall = up.openedAt != null ? ((up.doneAt ?? now()) - up.openedAt) / 1000 : null;
      return {
        stagesS: { ...stages },
        frames: frames ? {
          n: frames, perS: walkS > 0 ? r1(frames / walkS) : null,
          gapMs: { median: gap.q(0.5), p95: gap.q(0.95), p99: gap.q(0.99), worst: Math.round(gap.max()) },
          longShare: gap.n() ? +(long / gap.n()).toFixed(3) : null, stalls,
          workMs: { median: work.q(0.5), p95: work.q(0.95), worst: Math.round(work.max()) },
          workShare: walkS > 0 && work.n() ? +((work.mean() * work.n()) / (walkS * 1000)).toFixed(2) : null,
        } : null,
        jitter: lastPos ? {
          stillS: Math.round(stillS), stillMmPerFrame: still.n() ? { median: still.q(0.5), p95: still.q(0.95), worst: Math.round(still.max()) } : null,
          jumps, jumpWorstCm: jumps ? Math.round(jumpMax * 100) : null,
        } : null,
        waits: Object.fromEntries(Object.entries(times).map(([k, o]) => [k, { n: o.n, ms: Math.round(o.ms), longestMs: Math.round(o.longestMs) }])),
        upload: up.parts ? {
          sends: up.parts, ok: up.ok, retried: up.retry, refused: up.dropped, kb: Math.round(up.bytes / 1000),
          sendMs: { median: partMs.q(0.5), p95: partMs.q(0.95), worst: Math.round(partMs.max()) },
          inSendsS: Math.round(up.ms / 1000), wallS: wall == null ? null : Math.round(wall), finished: up.doneAt != null,
          kbPerS: up.ms > 0 ? r1(up.bytes / up.ms) : null,
        } : null,
        ...extra,
      };
    },
  };
}

/** The numbers in a few lines, for the walk's card and the workflow's log. */
export function perfLines(p) {
  if (!p) return ['speed: not measured (a walk from before 2026-11-12)'];
  const s = p.stagesS || {}, f = p.frames, j = p.jitter, u = p.upload, d = p.device || {};
  const res = Object.entries(p.resources || {}).map(([k, o]) => `${k} ${o.n} files ${o.kb} KB${o.cached ? ` (${o.cached} from the phone's cache)` : ''} ${(o.ms / 1000).toFixed(1)} s, slowest ${(o.slowestMs / 1000).toFixed(1)} s`).join('; ');
  // the frame's parts (keys "frame: ..."): each one's share of the page's work, its usual cost and its worst
  const parts = Object.entries(p.waits || {}).filter(([k]) => k.startsWith('frame: ')).sort((a, b) => b[1].ms - a[1].ms);
  const partsMs = parts.reduce((t, [, o]) => t + o.ms, 0);
  const where = parts.map(([k, o]) => `${k.slice(7)} ${partsMs ? Math.round((100 * o.ms) / partsMs) : 0}% (${(o.ms / Math.max(1, o.n)).toFixed(1)} ms a time x${o.n}, worst ${o.longestMs} ms)`).join('; ');
  const waits = Object.entries(p.waits || {}).filter(([k]) => !k.startsWith('frame: ')).map(([k, o]) => `${k} x${o.n} ${(o.ms / 1000).toFixed(1)} s (longest ${(o.longestMs / 1000).toFixed(1)} s)`).join('; ');
  return [
    `speed, opening (seconds after the page began): ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing marked'}`,
    `speed, downloads: ${res || 'none seen'}`,
    `speed, frames: ${f ? `${f.n} at ${f.perS ?? '?'} a second; gap between frames median ${f.gapMs.median} ms, 95% under ${f.gapMs.p95}, 99% under ${f.gapMs.p99}, worst ${f.gapMs.worst}; ${Math.round((f.longShare || 0) * 100)}% of gaps over ${LONG_MS} ms, ${f.stalls} stalls over ${STALL_MS} ms; the page's own work a frame median ${f.workMs.median} ms, 95% under ${f.workMs.p95}, worst ${f.workMs.worst} (${Math.round((f.workShare || 0) * 100)}% of the walk's time)` : 'no frames'}`,
    `speed, jitter: ${j ? `${j.stillMmPerFrame ? `held still ${j.stillS} s, its place moved median ${j.stillMmPerFrame.median} mm a frame, 95% under ${j.stillMmPerFrame.p95}, worst ${j.stillMmPerFrame.worst}` : 'never held still long enough to say'}; ${j.jumps} jumps over ${JUMP_M * 100} cm in one frame${j.jumps ? ` (worst ${j.jumpWorstCm} cm)` : ''}` : 'no poses'}`,
    `speed, where a frame's time goes: ${where || 'not timed'}`,
    `speed, waits: ${waits || 'none timed'}`,
    `speed, upload: ${u ? `${u.sends} sends (${u.ok} taken, ${u.retried} to try again, ${u.refused} refused), ${u.kb} KB; a send median ${u.sendMs.median} ms, 95% under ${u.sendMs.p95}, worst ${u.sendMs.worst}; ${u.inSendsS} s inside sends${u.wallS != null ? `, ${u.wallS} s from the first part kept to ${u.finished ? 'the last gone' : 'now (NOT finished)'}` : ''}; ${u.kbPerS ?? '?'} KB a second while sending` : 'nothing sent'}`,
    `speed, phone: ${d.cores ?? '?'} cores, ${d.memoryGb ?? '?'} GB, connection ${d.net ?? '?'}${d.downMbps != null ? ` ${d.downMbps} Mbps` : ''}${d.heapMb != null ? `, page memory ${d.heapMb} MB` : ''}`,
  ];
}
