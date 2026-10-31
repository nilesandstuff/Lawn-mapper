/**
 * THE NATIONAL STREAM MAP, CACHED (FINDINGS H63): GET /api/water/streams?lng=&lat=&r= -> USGS NHDPlus HR's flowlines
 * within r metres (at most 2000), as the service answers them (gnis_name, fcode, totdasqkm, paths in 4326). The
 * service is slow and drops requests (504s, a 60 s timeout seen at Grand Rapids, a 30 s one at Rockford), so the water
 * site asks it here, up to three times, and keeps each answer at the edge for 30 days: streams move slowly.
 */
const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer/3/query';
const KEEP_S = 30 * 86400;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

export async function handleStreams(request, url, ctx, { fetchImpl = fetch, cache = globalThis.caches?.default } = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
  const r = Math.min(2000, Math.max(50, Number(url.searchParams.get('r')) || 1000));
  if (!url.searchParams.get('lng') || !url.searchParams.get('lat') || !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return json({ error: 'lng and lat, please' }, 400);
  // the point to about 10 m, so neighbours share the answer
  const key = new Request(`https://water-streams.cache/?lng=${lng.toFixed(4)}&lat=${lat.toFixed(4)}&r=${Math.round(r)}`);
  if (cache) { try { const hit = await cache.match(key); if (hit) return hit; } catch { /* asked afresh */ } }
  const q = new URLSearchParams({ f: 'json', geometry: `${lng.toFixed(4)},${lat.toFixed(4)}`, geometryType: 'esriGeometryPoint', inSR: '4326', distance: String(Math.round(r)), units: 'esriSRUnit_Meter', outSR: '4326', outFields: 'gnis_name,fcode,totdasqkm', returnGeometry: 'true' });
  let last = '';
  for (let k = 0; k < 3; k++) {
    try {
      const res = await fetchImpl(`${NHD}?${q}`, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) { last = `the stream map answered ${res.status}`; continue; }
      const body = await res.json();
      if (body.error) { last = body.error.message || 'the stream map answered an error'; continue; }
      const out = json({ features: body.features || [] }, 200, { 'Cache-Control': `public, max-age=${KEEP_S}` });
      if (cache) { try { const put = cache.put(key, out.clone()); if (ctx?.waitUntil) ctx.waitUntil(put); } catch { /* kept next time */ } }
      return out;
    } catch (e) { last = e.message || 'the stream map did not answer'; }
  }
  return json({ error: last || 'the stream map did not answer' }, 502);
}
