/**
 * THE STUDIES, AT THE BOTTOM OF THE START PAGE (core session, 2026-11-18). The owner: "Could you make a new section on
 * the ar page, at the very bottom, that links to these studies. I'm not sure which walks specifically you studied...
 * The page only displays time stamps, not location." So each studied walk is listed with its time AND the name of the
 * map it was walked on, and links to its twin page at the study. Admin only (the routes answer nobody else); the
 * map's name is read from the site and shown here, never kept anywhere else.
 *
 * A study is found by what it left beside the walk's twin: today the segment trial's sheets (segments-*.jpg,
 * docs/SCAN-PLAN.md section 30), counted by /api/scan/twins.
 */
import { mapLabel } from '/lib/maps-pick.js';

const get = async (u) => { const r = await fetch(u, { credentials: 'same-origin' }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function studies() {
  const { twins } = await get('/api/scan/twins');
  const studied = (twins || []).filter((t) => t.segments > 0 || t.studies > 0);
  if (!studied.length) return;
  const walks = await get('/api/scan/walks').catch(() => ({ walks: [] }));
  const when = new Map((walks.walks || []).map((w) => [w.id, w]));
  const rows = await Promise.all(studied.map(async (t) => {
    let place = 'no map';
    try {
      const meta = await get(`/api/scan/twin?walk=${encodeURIComponent(t.walk)}&part=meta.json`);
      if (meta.map) { const j = await get(`/api/maps/one?id=${encodeURIComponent(meta.map)}`); place = mapLabel(j?.map || j); }
    } catch { place = 'its map could not be read'; }
    const at = when.get(t.walk)?.at ?? (/^\d{12,14}$/.test(t.walk) ? Number(t.walk) : null);
    return { t, place, at };
  }));
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  document.getElementById('studies-list').innerHTML = rows.map(({ t, place, at }) =>
    `<li style="margin:.35rem 0"><a href="/twin.html?walk=${encodeURIComponent(t.walk)}#${t.studies ? 'studies' : 'segments'}">${t.studies ? `${t.studies} stud${t.studies === 1 ? 'y' : 'ies'}` : 'Cut into things'}</a> &middot; <a href="/cloud.html?walk=${encodeURIComponent(t.walk)}">every point in 3D</a> <span class="dim">: ${esc(place)}, walked ${at ? esc(new Date(at).toLocaleString()) : esc(t.walk)}</span></li>`).join('');
  document.getElementById('studies').hidden = false;
}
studies().catch(() => {});
