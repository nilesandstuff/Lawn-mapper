/**
 * THE SHADE MODEL REBUILT WITH NO PAGE OPEN (core session, 2026-11-09; the
 * owner: "when a user visits the AR tool, it checks to see if the most recent
 * version of the shade map has been loaded and saved for that map. If the
 * most recent version hasn't been loaded, it calls the shade maps tools and
 * updates it. It needs to retain any edits that have been to the shade map,
 * including fences and erased branches/trees").
 *
 * rebuildModel(mapId) does what opening the map in the shade map does, up to
 * saving the model file, with the same modules in the same order:
 *   the map and its shade part (GET /api/maps/one; site.js siteFromSave)
 *   the lidar KEPT with the map -- the same cloud, box and line-up the shade
 *     map chose and lined up on the photo (shade.js keeps it in the part)
 *   passes.js onePass (the lot's leaf state), structures.js flagStrays
 *   find.js flightOf (the season by the laser's own clock)
 *   naip.js greenOver (the summer photo nearest the flight)
 *   trees-model.js treesModel (canopy, seasons, kinds: the trees step's own)
 *   the person's erasures (columns and single blocks) when they fit the grid,
 *     and their fences (carried in the file's header)
 *   surround.js (the block around), model-out.js, PUT /api/maps/model
 * and answers { ok: true, at, build, bytes } or { ok: false, why }.
 *
 * A MAP NEVER OPENED IN THE SHADE MAP has no kept lidar: choosing a survey
 * and lining it up on the photo needs the page (county photo services, the
 * person checking the property line), so that answers { ok: false, why:
 * 'not-in-shade-map' } and the reader says to open it there once.
 *
 * Any page on the home domain can run it: the fetches are same-origin
 * (/api/maps/*, /api/shade/lidar, /api/lidar/tiles) plus USGS's public lidar
 * bucket and the summer photo's services (Planetary Computer; the USGS NAIP
 * mosaic as fallback). The lidar decoder is laz-perf (`lazSrc`, its .wasm
 * beside it). In a worker, pass `decompress` (laz.js lazDecoder with a
 * factory the worker can load), as document-based script loading is not there.
 */
import { SHADE_BUILD } from './build.js';
import { siteFromSave, siteBounds, partFits } from './site.js';
import { pointsIn, toMerc, mercScale } from './ept.js';
import { onePass } from './passes.js';
import { flagStrays } from './structures.js';
import { flightOf } from './find.js';
import { greenOver } from './naip.js';
import { gridOver } from './grid.js';
import { treesModel } from './trees-model.js';
import { Erased } from './erase.js';
import { readSurround } from './surround.js';
import { finishedModel, modelBytes } from './model-out.js';
import { lazDecoder, browserFactory } from './laz.js';

export const NOT_IN_SHADE_MAP = 'not-in-shade-map';

/** The readers the build needs, over `fetchFn`; `base` for a page not on the map's own origin. */
export function rebuildIo({ fetchFn = (u, i) => globalThis.fetch(u, i), lazSrc = '/shade/vendor/laz-perf.js', decompress = null } = {}) {
  const getJson = async (url) => {
    const res = await fetchFn(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
    return res.json();
  };
  const getBytes = async (url) => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
    return res.arrayBuffer();
  };
  return { getJson, getBytes, decompress: decompress || lazDecoder(() => browserFactory(lazSrc)) };
}

/**
 * Rebuild and save the model of map `mapId`. `onProgress(words)` hears each
 * step; `signal` (AbortSignal) stops it between steps; `base` prefixes the
 * same-origin API paths; `io` overrides the readers (rebuildIo's shape).
 */
export async function rebuildModel(mapId, { onProgress = () => {}, signal = null, base = '', fetchFn = (u, i) => globalThis.fetch(u, i), lazSrc, decompress = null, io = null, surround = true, now = new Date() } = {}) {
  const stopped = () => signal?.aborted;
  const say = (w) => { try { onProgress(w); } catch { /* the caller's */ } };
  try {
    if (!mapId) return { ok: false, why: 'no map id' };
    const R = io || rebuildIo({ fetchFn, lazSrc, decompress });

    say('Reading the map…');
    const res = await fetchFn(`${base}/api/maps/one?id=${encodeURIComponent(mapId)}`, { credentials: 'same-origin' });
    if (!res.ok) return { ok: false, why: res.status === 404 ? 'the map was not found' : `the map could not be read (${res.status})` };
    const rec = (await res.json())?.map;
    if (!rec) return { ok: false, why: 'the map was not found' };
    const site = siteFromSave(rec);
    const part = site.map.shade;
    const kept = part?.lidar;
    if (!(kept?.url && Array.isArray(kept.box) && kept.box.length === 4 && Array.isArray(kept.shift) && kept.shift.length === 2)) {
      return { ok: false, why: NOT_IN_SHADE_MAP, words: 'this map has not been opened in the shade map yet: open it there once to choose its lidar and line it up' };
    }
    if (stopped()) return { ok: false, why: 'stopped' };

    /* The cloud's catalogue entry, for the flight's dates (the laser's own clock wins where the points keep one). */
    let unit = null;
    try {
      const found = await R.getJson(`${base}/api/shade/lidar?lng=${site.lng}&lat=${site.lat}`);
      unit = (found?.clouds || []).find((c) => c.url === kept.url)?.unit || null;
    } catch { /* the points' clock alone */ }

    say(`Reading ${kept.name || 'the lidar kept with this map'}…`);
    const lidarUrl = /^https?:/.test(kept.url) ? kept.url : `${base}${kept.url}`;
    const got = await pointsIn(lidarUrl, kept.box, R, { progress: (d, t, more) => say(more?.fetching ? `Fetching ${kept.name || 'the lidar'} onto the server…` : `Reading ${kept.name || 'the lidar'}: ${d} of ${t} pieces…`) });
    if (!(got?.cols?.n > 500)) return { ok: false, why: 'the lidar kept with this map could not be read' };
    if (stopped()) return { ok: false, why: 'stopped' };
    const box = kept.box, shift = kept.shift, lat = site.lat;
    const flown = got.flown;

    /* As shade.js build: one leaf state per lot, the strays flagged, the season by the laser's clock. */
    const bounds = siteBounds(site);
    const [lx0, ly0] = toMerc([bounds[0], bounds[1]]), [lx1, ly1] = toMerc([bounds[2], bounds[3]]);
    const passes = onePass(got.cols, [lx0, ly0, lx1, ly1], mercScale(lat));
    const cols = passes.cols;
    flagStrays(cols, gridOver(box, 1, lat));
    const u0 = flightOf(unit, flown);
    const u = u0 && passes.season ? { ...u0, season: passes.season } : u0;

    say('Reading the summer aerial photo…');
    const green = await greenOver(gridOver(box, 1, lat), { flownMs: u?.end || u?.start || null });
    if (stopped()) return { ok: false, why: 'stopped' };

    say('Building the trees…');
    const surroundP = surround ? readSurround({ url: lidarUrl, box, lat, shift, io: R, pointsIn }).catch(() => null) : Promise.resolve(null);
    const { grid, model, season } = await treesModel(cols, box, shift, lat, { flight: u?.season ?? null, green });

    /* The person's edits, as the trees step restores them (trees-ui.js restore): only on the grid they were made on. */
    let erasedMask = null, erasedCubes = [];
    if ((part.erased?.length || part.cubes?.length) && partFits(part, grid, model.nz)) {
      const er = new Erased(grid.w * grid.h, model.nz);
      er.erase((part.erased || []).filter((k) => Number.isInteger(k) && k >= 0 && k < er.mask.length));
      er.eraseCubes((part.cubes || []).filter((i) => Number.isInteger(i)));
      er.end();
      if (er.any) { erasedMask = er.mask; erasedCubes = er.cubeList(); }
    }
    if (stopped()) return { ok: false, why: 'stopped' };

    say('Saving the model…');
    const sur = await surroundP;
    const fin = finishedModel({
      model, season, cols, shift, surround: sur, fences: part.fences || [], erasedMask, erasedCubes,
      lidar: kept, flown: flown ? { start: flown.start, mid: flown.mid, end: flown.end } : null, photo: green?.frame || null, basedOn: site.map.at || null, now,
    });
    const bytes = await modelBytes(fin);
    const put = await fetchFn(`${base}/api/maps/model?id=${encodeURIComponent(mapId)}&tool=shade`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!put.ok) return { ok: false, why: `the model was not saved (${put.status})` };
    return { ok: true, at: fin.meta.at, build: SHADE_BUILD, bytes: bytes.byteLength, erased: fin.meta.erased, fences: fin.meta.fences.length };
  } catch (e) {
    return { ok: false, why: String(e?.message || e) };
  }
}
