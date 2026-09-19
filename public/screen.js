/**
 * Screening the queue, one lawn at a time.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator, so this
 * whole page is one `if (it loaded)`.
 *
 * And the same rule about text: everything goes in with textContent. A county
 * name arrives from a public records office by way of the Census, and one
 * innerHTML on this page runs a stranger's string while signed in as the owner.
 */

const $ = (s) => document.querySelector(s);
const n = (v) => Number(v || 0).toLocaleString();

/**
 * The frame each candidate is shown in.
 *
 * Zoom 19 over a 640px square is about sixty metres across at these latitudes
 * — a house and its garden with enough of the neighbours in shot to tell a
 * lawn from a shared green. The question is "is there grass here", not "how
 * much", so this never has to match the frame a measurement would use.
 */
const SHOT = { zoom: 19, size: 640 };

const shotFor = (job) => '/api/imagery?' + new URLSearchParams({
  lng: job.lng, lat: job.lat, zoom: SHOT.zoom, size: SHOT.size, provider: 'mapbox',
});

let queue = [];
let at = 0;
let done = 0;
const counts = {};

/*
 * THE NEXT FEW PICTURES, FETCHED BEFORE THEY ARE ASKED FOR.
 *
 * Each of these is a quarter of a megabyte from Mapbox by way of the Worker,
 * and a page that stops to load between every decision is a page that gets
 * abandoned around number forty. Three ahead is enough to stay in front of
 * somebody working quickly and few enough not to waste a fetch on lawns that
 * a change of mind will never reach.
 */
const warmed = new Set();
function warm(from) {
  for (let i = from; i < Math.min(from + 3, queue.length); i++) {
    const url = shotFor(queue[i]);
    if (warmed.has(url)) continue;
    warmed.add(url);
    const img = new Image();
    img.src = url;
  }
}

function show() {
  if (at >= queue.length) { load(); return; }
  const job = queue[at];

  $('#shot').src = shotFor(job);
  $('#where').textContent = [
    job.county || 'somewhere with parcels',
    job.parcelSqFt ? `${n(job.parcelSqFt)} sq ft of plot` : null,
  ].filter(Boolean).join(' · ');

  const left = queue.length - at;
  $('#tally').textContent = done
    ? `${n(done)} screened this session · ${n(left)} loaded, `
      + `${n(counts.candidate || 0)} in the queue`
    : `${n(left)} loaded · ${n(counts.candidate || 0)} waiting`;

  warm(at + 1);
}

async function verdict(kind) {
  const job = queue[at];
  if (!job) return;

  $('#yes').disabled = true;
  $('#no').disabled = true;

  /*
   * MOVED ON BEFORE THE SERVER ANSWERS. The decision is already made and the
   * next picture is already loaded; waiting for a round trip would put a pause
   * between every pair of taps for no gain. A failure is reported rather than
   * silently swallowed -- but it does not stop the screening, because one lost
   * verdict costs one lawn out of a county with thousands and the sampler
   * simply offers it again.
   */
  at++;
  done++;
  if (counts.candidate) counts.candidate--;
  show();
  $('#yes').disabled = false;
  $('#no').disabled = false;

  try {
    const res = await fetch('/api/admin/screen-lawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, verdict: kind }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    $('#tally').textContent = 'That last verdict did not save — it will come '
      + 'round again. Everything before it did.';
  }
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/admin/lawn-jobs?limit=24');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#locked').hidden = false;
    return;
  }

  Object.assign(counts, data.counts || {});
  queue = data.jobs || [];
  at = 0;

  if (!queue.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    const parts = Object.entries(counts)
      .map(([state, many]) => `${n(many)} ${state}`)
      .join(' · ');
    $('#none-counts').textContent = parts ? `So far: ${parts}.` : '';
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  show();
}

$('#yes').addEventListener('click', () => verdict('approved'));
$('#no').addEventListener('click', () => verdict('rejected'));
/*
 * A keyboard, for the one screening session that happens at a desk. Y and N
 * where they are expected; the arrow keys because a thumb on a phone and a
 * hand on a laptop want different things and both are cheap to serve.
 */
document.addEventListener('keydown', (e) => {
  if ($('#page').hidden) return;
  if (e.key === 'y' || e.key === 'Y' || e.key === 'ArrowRight') verdict('approved');
  if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowLeft') verdict('rejected');
});

load();
