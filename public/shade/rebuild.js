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
 * A MAP NEVER OPENED IN THE SHADE MAP has no kept lidar. By default that
 * answers { ok: false, why: 'not-in-shade-map' } and the reader says to open
 * it there once. With `firstBuild: true` (the admin saves' server build,
 * owner 2026-11-11: "runs on cloudflare so I don't need to leave the page
 * open") it does what the page does first, with the page's own decisions
 * (lineup.js): the survey the lidar index puts first that covers the lot,
 * the datum, the line-up on the photo the map was traced on (Mapbox, and the
 * county photo when it was traced on one), then builds as above and keeps
 * the lidar and line-up in the map's shade part, so the shade page and the
 * AR open it as if it had been built there. `decodeImage(bytes)` -> { data
 * (RGBA), width, height } reads the photos where there is no canvas (Node,
 * a Worker: jpeg-js / pngjs); `imagery(frame, provider, svc)` -> bytes
 * overrides fetching /api/imagery.
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
import { nad83Correction } from './datum.js';
import { alignToPhoto } from './align.js';
import { lineUpAt } from './traced.js';
import { alignFrame, lotOf, lotDensity, modelBox, fitFrom, shiftFrom, MIN_DENSITY } from './lineup.js';

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
export async function rebuildModel(mapId, { onProgress = () => {}, signal = null, base = '', fetchFn = (u, i) => globalThis.fetch(u, i), lazSrc, decompress = null, io = null, surround = true, now = new Date(), firstBuild = false, decodeImage = decodeInBrowser, decodePng = undefined, imagery = null } = {}) {
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
    const hasKept = !!(kept?.url && Array.isArray(kept.box) && kept.box.length === 4 && Array.isArray(kept.shift) && kept.shift.length === 2);
    if (!hasKept && !firstBuild) {
      return { ok: false, why: NOT_IN_SHADE_MAP, words: 'this map has not been opened in the shade map yet: open it there once to choose its lidar and line it up' };
    }
    if (stopped()) return { ok: false, why: 'stopped' };
    const lat = site.lat;
    const abs = (u) => (/^https?:/.test(u) ? u : `${base}${u}`);
    const read = (c, box) => pointsIn(abs(c.url), box, R, { progress: (d, t, more) => say(more?.fetching ? `Fetching ${c.name || 'the lidar'} onto the server…` : `Reading ${c.name || 'the lidar'}: ${d} of ${t} pieces…`) });

    /* The lidar index: the cloud's catalogue entry for the flight's dates (the laser's own clock wins where the points
       keep one), and, on a first build, the surveys to choose from. */
    let found = null;
    try { found = await R.getJson(`${base}/api/shade/lidar?lng=${site.lng}&lat=${site.lat}`); } catch { /* the points' clock alone */ }
    if (stopped()) return { ok: false, why: 'stopped' };

    /* As shade.js build: the cloud and its box (kept, or chosen as the page chooses), one leaf state per lot, the
       strays flagged, then (first build only) the datum and the photo line-up. */
    const bounds = siteBounds(site);
    const { lot, lotM2 } = lotOf(bounds, lat);
    let cloud = null, got = null, box = null;
    if (hasKept) {
      cloud = (found?.clouds || []).find((c) => c.url === kept.url) || { url: kept.url, name: kept.name, epoch: kept.epoch, unit: null };
      box = kept.box;
      say(`Reading ${kept.name || 'the lidar kept with this map'}…`);
      got = await read({ url: kept.url, name: kept.name || 'the lidar kept with this map' }, box);
      if (!(got?.cols?.n > 500)) return { ok: false, why: 'the lidar kept with this map could not be read' };
    } else {
      if (!found || found.error || !found.clouds?.length) return { ok: false, why: found?.error || 'no public lidar over this point' };
      const frame0 = alignFrame(site, bounds);
      box = modelBox(lot, frame0, lat);
      for (const c of found.clouds.slice(0, 3)) {
        say(`Reading ${c.name}…`);
        try {
          const g = await read(c, box);
          if (g.cols.n > 500 && lotDensity(g.cols, lot, lotM2) >= MIN_DENSITY) { cloud = c; got = g; break; }
        } catch { /* the next survey */ }
        if (stopped()) return { ok: false, why: 'stopped' };
      }
      if (!cloud) return { ok: false, why: 'none of the lidar here covers the lot' };
    }
    if (stopped()) return { ok: false, why: 'stopped' };
    const flown = got.flown;
    const passes = onePass(got.cols, lot, mercScale(lat));
    const cols = passes.cols;
    flagStrays(cols, gridOver(box, 1, lat));
    let shift, lidarRec;
    if (hasKept) { shift = kept.shift; lidarRec = kept; } else {
      say('Lining it up on the photo…');
      const frame = alignFrame(site, bounds);
      const k = mercScale(lat);
      const datum = nad83Correction(site.lat, site.lng, cloud.epoch);
      const pre = [datum.east / k, datum.north / k];
      const t = site.tracedOn || { provider: 'mapbox' };
      const photoBytes = imagery || (async (fr, provider, svc) => {
        const q = new URLSearchParams({ lng: fr.lng, lat: fr.lat, zoom: fr.zoom, size: fr.size, height: fr.height, provider });
        if (svc != null) q.set('svc', svc);
        const res = await fetchFn(`${base}/api/imagery?${q}`);
        if (!res.ok) throw new Error(`the ${provider === 'county' ? 'county' : 'Mapbox'} photo would not load (${res.status})`);
        return res.arrayBuffer();
      });
      const match = async (provider, svc) => {
        try { const photo = await decodeImage(await photoBytes(frame, provider, svc)); return { fit: alignToPhoto(cols, frame, photo, { pre }) }; } catch (e) { return { error: String(e?.message || e) }; }
      };
      const onMapbox = await match('mapbox');
      const onCounty = t.provider === 'county' ? await match('county', t.svc) : null;
      const move = t.provider === 'county' ? lineUpAt(t, [frame.lng, frame.lat]) : { east: 0, north: 0 };
      const fit = fitFrom({ onCounty, onMapbox, move });
      shift = shiftFrom(pre, fit, lat);
      lidarRec = { url: cloud.url, name: cloud.name, epoch: cloud.epoch, box, shift, fit: fit ? { east: fit.east, north: fit.north, confident: !!fit.confident, why: fit.why } : null, at: now.toISOString() };
    }
    const unit = cloud?.unit || null;
    const lidarUrl = abs(lidarRec.url);
    const u0 = flightOf(unit, flown);
    const u = u0 && passes.season ? { ...u0, season: passes.season } : u0;

    say('Reading the summer aerial photo…');
    const green = await greenOver(gridOver(box, 1, lat), { flownMs: u?.end || u?.start || null, ...(decodePng ? { decodePng } : {}) });
    if (stopped()) return { ok: false, why: 'stopped' };

    say('Building the trees…');
    const surroundP = surround ? readSurround({ url: lidarUrl, box, lat, shift, io: R, pointsIn }).catch(() => null) : Promise.resolve(null);
    const { grid, model, season } = await treesModel(cols, box, shift, lat, { flight: u?.season ?? null, green });

    /* The person's edits, as the trees step restores them (trees-ui.js restore): only on the grid they were made on. */
    let erasedMask = null, erasedCubes = [];
    if ((part?.erased?.length || part?.cubes?.length) && partFits(part, grid, model.nz)) {
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
      model, season, cols, shift, surround: sur, fences: part?.fences || [], erasedMask, erasedCubes,
      lidar: lidarRec, flown: flown ? { start: flown.start, mid: flown.mid, end: flown.end } : null, photo: green?.frame || null, basedOn: site.map.at || null, now,
    });
    const bytes = await modelBytes(fin);
    const put = await fetchFn(`${base}/api/maps/model?id=${encodeURIComponent(mapId)}&tool=shade`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!put.ok) return { ok: false, why: `the model was not saved (${put.status})` };
    /* A first build keeps its lidar and line-up in the map's shade part, as the page does (shade.js shadePart), so
       the shade page reads the same cloud, box and shift next time and the person's edits there fit this grid. */
    let partSaved = null;
    if (!hasKept) {
      const traced = site.parcel?.properties?.traced ? site.parcel.geometry.coordinates[0].slice(0, -1) : null;
      const data = {
        v: 3, lot: traced, fences: part?.fences || [], erased: erasedMask ? (part.erased || []) : [], cubes: erasedMask || erasedCubes.length ? (part.cubes || []) : [],
        grid: { w: grid.w, h: grid.h, x0: Math.round(grid.x0 * 100) / 100, y1: Math.round(grid.y1 * 100) / 100, nz: model.nz },
        lidar: lidarRec, settings: part?.settings || null, at: now.toISOString(), builtBy: 'server',
      };
      const r = await fetchFn(`${base}/api/maps/tool?id=${encodeURIComponent(mapId)}&tool=shade`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, basedOn: site.map.at || null }) });
      partSaved = r.ok;
    }
    return { ok: true, at: fin.meta.at, build: SHADE_BUILD, bytes: bytes.byteLength, erased: fin.meta.erased, fences: fin.meta.fences.length, first: !hasKept, partSaved, lidar: { name: lidarRec.name, fit: lidarRec.fit } };
  } catch (e) {
    return { ok: false, why: String(e?.message || e) };
  }
}

/** A photo's bytes -> { data (RGBA), width, height } with the browser's own decoder (a page or a worker). */
async function decodeInBrowser(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('no image decoder here: pass decodeImage');
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  return { data: d.data, width: d.width, height: d.height };
}
